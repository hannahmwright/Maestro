import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { logger } from '../utils/logger';
import { getDemoArtifactService } from '../artifacts';
import { writeDemoTurnContextFile } from '../artifacts/maestroDemoRuntime';
import { buildChildProcessEnv } from './utils/envBuilder';
import { extractDemoEventOutput } from '../../shared/demo-artifacts';
import type { CodexAppServerState, ManagedProcess, ProcessConfig, SpawnResult } from './types';
import type {
	UserInputRequest,
	UserInputRequestId,
	UserInputResponse,
} from '../../shared/user-input-requests';
import type { AgentError } from '../../shared/types';
import type { ConversationEvent, ConversationInputItem } from '../../shared/conversation';

const LOG_CONTEXT = 'CodexAppServerBridge';
const LISTENING_URL_RE = /listening on:\s*(ws:\/\/[^\s]+)/i;
const STARTUP_TIMEOUT_MS = 15000;
const MAX_CHAT_QUESTION_CORRECTIONS = 2;
const PLAN_MODE_DEVELOPER_INSTRUCTIONS =
	'If you need user input before proceeding, use the request_user_input tool with concise multiple-choice questions instead of asking plain-text blocking questions in the response.';
const CHAT_QUESTION_CORRECTION_PROMPT =
	'You asked the user blocking questions in chat. Do not ask questions in chat. If you still need user input, immediately use the request_user_input tool with concise multiple-choice questions. If you no longer need user input, continue without asking a question.';

type JsonRpcMessage = Record<string, unknown>;

type ThreadResponse = {
	thread?: {
		id?: string;
	};
	model?: string;
	reasoningEffort?: string | null;
};

type TokenUsageMessage = {
	info?: {
		last_token_usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cached_input_tokens?: number;
			reasoning_output_tokens?: number;
		};
		model_context_window?: number;
	};
};

type ThreadTokenUsageMessage = {
	tokenUsage?: {
		last?: {
			inputTokens?: number;
			outputTokens?: number;
			cachedInputTokens?: number;
			reasoningOutputTokens?: number;
		};
		modelContextWindow?: number;
	};
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRequestId(value: unknown): UserInputRequestId | undefined {
	if (typeof value === 'string' && value.trim()) return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	return undefined;
}

function looksLikeBlockingChatQuestion(text: string): boolean {
	const normalized = text.trim();
	if (!normalized) return false;

	const lower = normalized.toLowerCase();
	if (lower.includes('questions before i proceed')) return true;
	if (lower.includes('before i proceed') && normalized.includes('?')) return true;
	if (lower.includes('to proceed') && normalized.includes('?')) return true;

	const questionLineCount = normalized
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.endsWith('?')).length;

	if (questionLineCount >= 2) return true;
	if (questionLineCount === 1 && normalized.length <= 500) return true;

	return false;
}

function createAgentError(sessionId: string, message: string, raw?: unknown): AgentError {
	return {
		type: 'agent_crashed',
		message,
		recoverable: false,
		agentId: 'codex',
		sessionId,
		timestamp: Date.now(),
		raw: raw ? { stderr: JSON.stringify(raw) } : undefined,
	};
}

export class CodexAppServerBridge {
	constructor(
		private processes: Map<string, ManagedProcess>,
		private emitter: EventEmitter
	) {}

	spawn(config: ProcessConfig): SpawnResult {
		return this.sendTurn({
			...config,
			conversationRuntime: config.conversationRuntime || 'batch',
		});
	}

	sendTurn(config: ProcessConfig): SpawnResult {
		const existingProcess = this.processes.get(config.sessionId);
		if (existingProcess?.codexAppServerState?.ws && existingProcess.codexAppServerState.threadId) {
			this.startTurn(
				existingProcess,
				config,
				existingProcess.codexAppServerState.threadId,
				this.buildUserInput(config),
				existingProcess.currentModel || config.resolvedModel || 'gpt-5.4',
				config.sessionReasoningEffort && config.sessionReasoningEffort !== 'default'
					? config.sessionReasoningEffort
					: null
			);
			existingProcess.startTime = Date.now();
			existingProcess.querySource = config.querySource;
			existingProcess.tabId = config.tabId;
			existingProcess.projectPath = config.projectPath;
			existingProcess.contextWindow = config.contextWindow;
			existingProcess.conversationRuntime = config.conversationRuntime || 'batch';
			return {
				pid: existingProcess.pid,
				success: true,
			};
		}

		logger.info('[CodexAppServerBridge] Starting app-server bridge spawn', LOG_CONTEXT, {
			sessionId: config.sessionId,
			cwd: config.cwd,
			hasAgentSessionId: !!config.agentSessionId,
			hasPrompt: !!config.prompt,
		});
		const env = buildChildProcessEnv(
			config.customEnvVars,
			!!config.agentSessionId,
			config.shellEnvVars
		);
		const childProcess = spawn(config.command, ['app-server', '--listen', 'ws://127.0.0.1:0'], {
			cwd: config.cwd,
			env,
			shell: config.runInShell ? config.shell || true : false,
		});

		const codexAppServerState: CodexAppServerState = {
			nextClientRequestId: 1,
			agentMessagePhases: new Map(),
			toolItemNames: new Map(),
			currentTurnCorrectionCount: 0,
			pendingRequests: new Map(),
		};
		const managedProcess: ManagedProcess = {
			sessionId: config.sessionId,
			toolType: config.toolType,
			childProcess,
			cwd: config.cwd,
			pid: childProcess.pid ?? -1,
			isTerminal: false,
			isBatchMode: true,
			startTime: Date.now(),
			contextWindow: config.contextWindow,
			querySource: config.querySource,
			tabId: config.tabId,
			projectPath: config.projectPath,
			currentModel: config.resolvedModel,
			command: config.command,
			args: ['app-server', '--listen', 'ws://127.0.0.1:0'],
			codexAppServerState,
			conversationRuntime: config.conversationRuntime || 'batch',
			demoCaptureEnabled: config.demoCapture?.enabled === true,
			demoCaptureFinalized: false,
			demoCaptureArtifactSeen: false,
			demoCaptureFailed: false,
			demoCaptureContext: config.demoCaptureContext,
		};

		this.processes.set(config.sessionId, managedProcess);

		if (config.resolvedModel) {
			this.emitter.emit('model', config.sessionId, config.resolvedModel);
		}

		codexAppServerState.startupTimeout = setTimeout(() => {
			this.emitAgentError(
				config.sessionId,
				'Codex app-server did not finish starting within 15 seconds.'
			);
			this.killProcess(managedProcess);
		}, STARTUP_TIMEOUT_MS);

		let stderrBuffer = '';
		childProcess.stderr?.on('data', (chunk: Buffer | string) => {
			stderrBuffer += chunk.toString();
			const lines = stderrBuffer.split(/\r?\n/);
			stderrBuffer = lines.pop() || '';
			for (const line of lines) {
				this.handleStderrLine(managedProcess, config, line);
			}
		});

		childProcess.on('exit', (code) => {
			if (codexAppServerState.startupTimeout) {
				clearTimeout(codexAppServerState.startupTimeout);
			}
			codexAppServerState.ws?.removeAllListeners();
			codexAppServerState.ws?.close();
			this.finishProcess(managedProcess, code ?? (codexAppServerState.turnCompleted ? 0 : 1));
		});

		childProcess.on('error', (error) => {
			this.emitAgentError(
				config.sessionId,
				`Failed to launch Codex app-server: ${error.message}`,
				error
			);
		});

		return {
			pid: managedProcess.pid,
			success: true,
		};
	}

	steerTurn(sessionId: string, input: { text?: string; images?: string[] }): boolean {
		const managedProcess = this.processes.get(sessionId);
		const state = managedProcess?.codexAppServerState;
		const ws = state?.ws;
		if (
			!managedProcess ||
			!state?.threadId ||
			!state.turnId ||
			!ws ||
			ws.readyState !== WebSocket.OPEN
		) {
			return false;
		}

		const items = this.buildConversationInput(input.text, input.images);
		if (items.length === 0) {
			return false;
		}

		const requestId = `steer-${state.nextClientRequestId++}`;
		state.pendingRequests?.set(requestId, { type: 'steer' });
		this.sendJson(ws, {
			id: requestId,
			method: 'turn/steer',
			params: {
				threadId: state.threadId,
				expectedTurnId: state.turnId,
				input: items,
			},
		});
		return true;
	}

	interruptTurn(sessionId: string): boolean {
		const managedProcess = this.processes.get(sessionId);
		const state = managedProcess?.codexAppServerState;
		const ws = state?.ws;
		if (
			!managedProcess ||
			!state?.threadId ||
			!state.turnId ||
			!ws ||
			ws.readyState !== WebSocket.OPEN
		) {
			return false;
		}

		const requestId = `interrupt-${state.nextClientRequestId++}`;
		state.pendingRequests?.set(requestId, { type: 'interrupt' });
		this.sendJson(ws, {
			id: requestId,
			method: 'turn/interrupt',
			params: {
				threadId: state.threadId,
				turnId: state.turnId,
			},
		});
		return true;
	}

	async respondToUserInput(
		sessionId: string,
		requestId: UserInputRequestId,
		response: UserInputResponse
	): Promise<boolean> {
		const managedProcess = this.processes.get(sessionId);
		const ws = managedProcess?.codexAppServerState?.ws;
		if (!managedProcess || !ws || ws.readyState !== WebSocket.OPEN) {
			return false;
		}

		managedProcess.codexAppServerState!.pendingUserInputRequest = undefined;
		managedProcess.codexAppServerState!.pendingUserInputResponse = response;
		logger.info('[CodexAppServerBridge] Sending user input response', LOG_CONTEXT, {
			sessionId,
			requestId,
			questionIds: Object.keys(response.answers),
		});

		ws.send(
			JSON.stringify({
				id: requestId,
				result: response,
			})
		);
		return true;
	}

	private handleStderrLine(
		managedProcess: ManagedProcess,
		config: ProcessConfig,
		line: string
	): void {
		if (!line.trim()) return;
		const listeningMatch = line.match(LISTENING_URL_RE);
		if (listeningMatch && !managedProcess.codexAppServerState?.ws) {
			this.connectWebSocket(managedProcess, config, listeningMatch[1]);
			return;
		}

		logger.debug('[CodexAppServerBridge] stderr', LOG_CONTEXT, {
			sessionId: managedProcess.sessionId,
			line,
		});
	}

	private connectWebSocket(
		managedProcess: ManagedProcess,
		config: ProcessConfig,
		wsUrl: string
	): void {
		const state = managedProcess.codexAppServerState;
		if (!state) return;

		state.wsUrl = wsUrl;
		logger.info('[CodexAppServerBridge] Connecting websocket', LOG_CONTEXT, {
			sessionId: managedProcess.sessionId,
			wsUrl,
		});
		const ws = new WebSocket(wsUrl);
		state.ws = ws;

		ws.on('open', () => {
			logger.info('[CodexAppServerBridge] Websocket open', LOG_CONTEXT, {
				sessionId: managedProcess.sessionId,
			});
			this.sendJson(ws, {
				id: 'initialize',
				method: 'initialize',
				params: {
					clientInfo: {
						name: 'Maestro',
						version: '0.15.1',
					},
					capabilities: {
						experimentalApi: true,
					},
				},
			});
		});

		ws.on('message', (data) => {
			this.handleWebSocketMessage(managedProcess, config, data.toString());
		});

		ws.on('close', (code, reasonBuffer) => {
			const reason =
				typeof reasonBuffer === 'string' ? reasonBuffer : reasonBuffer?.toString('utf8') || '';
			logger.warn('[CodexAppServerBridge] Websocket closed', LOG_CONTEXT, {
				sessionId: managedProcess.sessionId,
				code,
				reason: reason || undefined,
				turnId: state.turnId,
				threadId: state.threadId,
			});
			state.ws = undefined;
			if (!state.turnCompleted) {
				this.emitAgentError(
					managedProcess.sessionId,
					'Codex app-server websocket closed before the turn completed.'
				);
				this.emitConversationEvent(managedProcess, {
					type: 'turn_failed',
					sessionId: managedProcess.sessionId,
					runtimeKind: managedProcess.conversationRuntime || 'batch',
					timestamp: Date.now(),
					threadId: state.threadId,
					turnId: state.turnId || null,
					message: 'Codex app-server websocket closed before the turn completed.',
				});
			}
			this.killProcess(managedProcess);
			this.finishProcess(managedProcess, state.turnCompleted ? 0 : 1);
		});

		ws.on('error', (error) => {
			this.emitAgentError(
				managedProcess.sessionId,
				`Codex app-server connection failed: ${error.message}`,
				error
			);
		});
	}

	private handleWebSocketMessage(
		managedProcess: ManagedProcess,
		config: ProcessConfig,
		messageText: string
	): void {
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(messageText) as JsonRpcMessage;
		} catch {
			logger.debug('[CodexAppServerBridge] Ignoring non-JSON message', LOG_CONTEXT, {
				sessionId: managedProcess.sessionId,
				messageText,
			});
			return;
		}

		const messageId =
			typeof message.id === 'string' || typeof message.id === 'number'
				? String(message.id)
				: undefined;
		if (messageId && managedProcess.codexAppServerState?.pendingRequests?.has(messageId)) {
			this.handlePendingRequestResponse(managedProcess, messageId, message);
			return;
		}

		if (message.id === 'initialize') {
			this.handleInitializeResponse(managedProcess, config);
			return;
		}

		if (message.id === 'thread') {
			this.handleThreadResponse(managedProcess, config, message.result);
			return;
		}

		if (message.id === 'turn') {
			const result = asRecord(message.result);
			this.handleTurnStarted(managedProcess, result?.turn);
			return;
		}

		const method = asString(message.method);
		if (!method) {
			return;
		}

		switch (method) {
			case 'turn/started':
				this.handleTurnStarted(managedProcess, asRecord(message.params)?.turn);
				return;
			case 'item/tool/requestUserInput':
				this.handleUserInputRequest(managedProcess, message);
				return;
			case 'item/started':
				this.handleItemStarted(managedProcess, message.params);
				return;
			case 'item/agentMessage/delta':
				this.handleAgentMessageDelta(managedProcess, message.params);
				return;
			case 'item/reasoning/textDelta':
			case 'item/reasoning/summaryTextDelta':
			case 'item/plan/delta':
				this.handleThinkingDelta(managedProcess, message.params);
				return;
			case 'item/commandExecution/outputDelta':
				this.handleCommandExecutionOutputDelta(managedProcess, message.params);
				return;
			case 'item/commandExecution/terminalInteraction':
				this.handleCommandExecutionTerminalInteraction(managedProcess, message.params);
				return;
			case 'item/fileChange/outputDelta':
				this.handleFileChangeOutputDelta(managedProcess, message.params);
				return;
			case 'item/mcpToolCall/progress':
				this.handleMcpToolCallProgress(managedProcess, message.params);
				return;
			case 'item/completed':
				this.handleItemCompleted(managedProcess, message.params);
				return;
			case 'codex/event/token_count':
				this.handleTokenCount(managedProcess, message.params);
				return;
			case 'thread/tokenUsage/updated':
				this.handleThreadTokenUsageUpdated(managedProcess, message.params);
				return;
			case 'turn/completed':
				logger.info('[CodexAppServerBridge] Turn completed notification', LOG_CONTEXT, {
					sessionId: managedProcess.sessionId,
					hasPendingCorrection: !!managedProcess.codexAppServerState?.pendingCorrectionPrompt,
					hadUserInputRequest:
						managedProcess.codexAppServerState?.currentTurnHadUserInputRequest === true,
				});
				if (managedProcess.codexAppServerState) {
					const completedParams = asRecord(message.params);
					const completedTurn = asRecord(completedParams?.turn);
					const turnStatus = asString(completedTurn?.status);
					managedProcess.codexAppServerState.turnCompleted = true;
					const pendingCorrectionPrompt =
						managedProcess.codexAppServerState.pendingCorrectionPrompt;
					const threadId = managedProcess.codexAppServerState.threadId;
					if (pendingCorrectionPrompt && threadId) {
						managedProcess.codexAppServerState.currentTurnCorrectionCount =
							(managedProcess.codexAppServerState.currentTurnCorrectionCount || 0) + 1;
						this.startTurn(
							managedProcess,
							config,
							threadId,
							[
								{
									type: 'text',
									text: pendingCorrectionPrompt,
									text_elements: [],
								},
							],
							managedProcess.currentModel || config.resolvedModel || 'gpt-5.4',
							config.sessionReasoningEffort && config.sessionReasoningEffort !== 'default'
								? config.sessionReasoningEffort
								: null
						);
						return;
					}
					const completedTurnId = managedProcess.codexAppServerState.turnId || null;
					managedProcess.codexAppServerState.turnId = undefined;
					let completionStatus:
						| 'interrupted'
						| 'failed'
						| 'completed' =
						turnStatus === 'interrupted'
							? 'interrupted'
							: turnStatus === 'failed'
								? 'failed'
								: 'completed';
					if (
						completionStatus === 'completed' &&
						managedProcess.demoCaptureEnabled === true &&
						managedProcess.demoCaptureContext
					) {
						const outcome = getDemoArtifactService().getTurnRequirementOutcome({
							sessionId: managedProcess.demoCaptureContext.sessionId,
							tabId: managedProcess.demoCaptureContext.tabId,
							turnId: managedProcess.demoCaptureContext.turnId,
							captureRunId: managedProcess.demoCaptureContext.captureRunId,
						});
						if (!outcome.satisfied) {
							completionStatus = 'failed';
							this.emitAgentError(
								managedProcess.sessionId,
								outcome.message || 'Demo capture failed for this turn.'
							);
							this.emitConversationEvent(managedProcess, {
								type: 'turn_failed',
								sessionId: managedProcess.sessionId,
								runtimeKind: managedProcess.conversationRuntime || 'batch',
								timestamp: Date.now(),
								threadId: managedProcess.codexAppServerState.threadId,
								turnId: completedTurnId,
								message: outcome.message || 'Demo capture failed for this turn.',
							});
						}
					}
					this.emitConversationEvent(managedProcess, {
						type: 'turn_completed',
						sessionId: managedProcess.sessionId,
						runtimeKind: managedProcess.conversationRuntime || 'batch',
						timestamp: Date.now(),
						threadId: managedProcess.codexAppServerState.threadId,
						turnId: completedTurnId,
						status: completionStatus,
					});
					if (managedProcess.conversationRuntime === 'live') {
						this.emitter.emit('query-complete', managedProcess.sessionId, {
							sessionId: managedProcess.sessionId,
							agentType: managedProcess.toolType,
							source: managedProcess.querySource || 'user',
							startTime: managedProcess.startTime,
							duration: Date.now() - managedProcess.startTime,
							projectPath: managedProcess.projectPath,
							tabId: managedProcess.tabId,
						});
					}
				}
				if (managedProcess.conversationRuntime !== 'live') {
					this.killProcess(managedProcess);
				}
				return;
			case 'error':
				this.emitAgentError(
					managedProcess.sessionId,
					'Codex app-server returned an error notification.',
					message.params
				);
				this.emitConversationEvent(managedProcess, {
					type: 'turn_failed',
					sessionId: managedProcess.sessionId,
					runtimeKind: managedProcess.conversationRuntime || 'batch',
					timestamp: Date.now(),
					threadId: managedProcess.codexAppServerState?.threadId,
					turnId: managedProcess.codexAppServerState?.turnId || null,
					message: 'Codex app-server returned an error notification.',
				});
				return;
			default:
				return;
		}
	}

	private handleInitializeResponse(managedProcess: ManagedProcess, config: ProcessConfig): void {
		const state = managedProcess.codexAppServerState;
		const ws = state?.ws;
		if (!state || !ws || ws.readyState !== WebSocket.OPEN) return;
		const isReadOnly = config.readOnlyMode === true;
		const approvalPolicy = isReadOnly ? 'never' : 'untrusted';
		const sandbox =
			managedProcess.conversationRuntime === 'live'
				? isReadOnly
					? 'read-only'
					: 'workspace-write'
				: 'read-only';

		logger.info('[CodexAppServerBridge] Initialize complete', LOG_CONTEXT, {
			sessionId: managedProcess.sessionId,
			resumingThread: !!config.agentSessionId,
		});
		this.sendJson(ws, { method: 'initialized' });
		if (config.agentSessionId) {
			this.sendJson(ws, {
				id: 'thread',
				method: 'thread/resume',
				params: {
					threadId: config.agentSessionId,
					model: config.resolvedModel ?? null,
					cwd: config.cwd,
					approvalPolicy,
					sandbox,
					persistExtendedHistory: false,
				},
			});
			return;
		}

		this.sendJson(ws, {
			id: 'thread',
			method: 'thread/start',
			params: {
				model: config.resolvedModel ?? null,
				cwd: config.cwd,
				approvalPolicy,
				sandbox,
				experimentalRawEvents: false,
				persistExtendedHistory: false,
			},
		});
	}

	private handleThreadResponse(
		managedProcess: ManagedProcess,
		config: ProcessConfig,
		rawResult: unknown
	): void {
		const state = managedProcess.codexAppServerState;
		const ws = state?.ws;
		if (!state || !ws || ws.readyState !== WebSocket.OPEN) return;

		const result = asRecord(rawResult) as ThreadResponse | null;
		const threadId = result?.thread?.id;
		if (!threadId) {
			this.emitAgentError(managedProcess.sessionId, 'Codex app-server did not return a thread id.');
			this.killProcess(managedProcess);
			return;
		}

		if (state.startupTimeout) {
			clearTimeout(state.startupTimeout);
			state.startupTimeout = undefined;
		}

		state.threadId = threadId;
		logger.info('[CodexAppServerBridge] Thread ready', LOG_CONTEXT, {
			sessionId: managedProcess.sessionId,
			threadId,
			resumed: !!config.agentSessionId,
		});
		if (result?.model) {
			managedProcess.currentModel = result.model;
			this.emitter.emit('model', managedProcess.sessionId, result.model);
		}
		this.emitter.emit('session-id', managedProcess.sessionId, threadId);
		if (managedProcess.conversationRuntime === 'live') {
			this.emitConversationEvent(managedProcess, {
				type: 'runtime_ready',
				sessionId: managedProcess.sessionId,
				runtimeKind: 'live',
				timestamp: Date.now(),
				threadId,
			});
		}

		this.startTurn(
			managedProcess,
			config,
			threadId,
			this.buildUserInput(config),
			result?.model || config.resolvedModel || 'gpt-5.4',
			config.sessionReasoningEffort && config.sessionReasoningEffort !== 'default'
				? config.sessionReasoningEffort
				: result?.reasoningEffort || null
		);
	}

	private buildUserInput(config: ProcessConfig): Array<Record<string, unknown>> {
		return this.buildConversationInput(config.prompt, config.images);
	}

	private handleTurnStarted(managedProcess: ManagedProcess, rawTurn: unknown): void {
		const turn = asRecord(rawTurn);
		const turnId = asString(turn?.id);
		const state = managedProcess.codexAppServerState;
		if (!turnId || !state) return;
		if (state.turnId === turnId) return;

		state.turnId = turnId;
		this.emitConversationEvent(managedProcess, {
			type: 'turn_started',
			sessionId: managedProcess.sessionId,
			runtimeKind: managedProcess.conversationRuntime || 'batch',
			timestamp: Date.now(),
			threadId: state.threadId || '',
			turnId,
		});
	}

	private buildConversationInput(
		text?: string,
		images?: string[]
	): Array<ConversationInputItem & Record<string, unknown>> {
		const inputs: Array<ConversationInputItem & Record<string, unknown>> = [];
		if (text) {
			inputs.push({
				type: 'text',
				text,
				text_elements: [],
			});
		}
		for (const image of images || []) {
			inputs.push({
				type: 'image',
				url: image,
			});
		}
		return inputs;
	}

	private handleUserInputRequest(managedProcess: ManagedProcess, message: JsonRpcMessage): void {
		const params = asRecord(message.params);
		const requestId = asRequestId(message.id);
		const threadId = asString(params?.threadId);
		const turnId = asString(params?.turnId);
		const itemId = asString(params?.itemId);
		const rawQuestions = Array.isArray(params?.questions) ? params.questions : [];
		if (!requestId || !threadId || !turnId || !itemId || rawQuestions.length === 0) {
			return;
		}

		const request: UserInputRequest = {
			requestId,
			threadId,
			turnId,
			itemId,
			questions: rawQuestions
				.map((question): UserInputRequest['questions'][number] | null => {
					const record = asRecord(question);
					const id = asString(record?.id);
					const header = asString(record?.header);
					const prompt = asString(record?.question);
					if (!id || !header || !prompt) return null;
					return {
						id,
						header,
						question: prompt,
						isOther: record?.isOther === true,
						isSecret: record?.isSecret === true,
						options: Array.isArray(record?.options)
							? record.options
									.map((option) => {
										const optionRecord = asRecord(option);
										const label = asString(optionRecord?.label);
										const description = asString(optionRecord?.description);
										if (!label || !description) return null;
										return { label, description };
									})
									.filter((option): option is NonNullable<typeof option> => !!option)
							: null,
					};
				})
				.filter((question): question is NonNullable<typeof question> => !!question),
		};

		if (request.questions.length === 0) {
			return;
		}

		if (managedProcess.codexAppServerState) {
			managedProcess.codexAppServerState.pendingUserInputRequest = request;
			managedProcess.codexAppServerState.currentTurnHadUserInputRequest = true;
		}
		logger.info('[CodexAppServerBridge] Received user input request', LOG_CONTEXT, {
			sessionId: managedProcess.sessionId,
			requestId,
			questionIds: request.questions.map((question) => question.id),
		});
		this.emitter.emit('user-input-request', managedProcess.sessionId, request);
	}

	private handleItemStarted(managedProcess: ManagedProcess, rawParams: unknown): void {
		const params = asRecord(rawParams);
		const item = asRecord(params?.item);
		if (!item) return;
		const itemType = asString(item.type);

		if (itemType === 'agentMessage') {
			const itemId = asString(item.id);
			const phase = asString(item.phase);
			if (!itemId || !phase || !managedProcess.codexAppServerState) return;
			managedProcess.codexAppServerState.agentMessagePhases.set(itemId, phase);
			return;
		}

		this.emitToolEventForItem(managedProcess, item, 'running');
	}

	private handleAgentMessageDelta(managedProcess: ManagedProcess, rawParams: unknown): void {
		const params = asRecord(rawParams);
		const itemId = asString(params?.itemId);
		const delta = asString(params?.delta);
		const phase =
			itemId && managedProcess.codexAppServerState
				? managedProcess.codexAppServerState.agentMessagePhases.get(itemId)
				: undefined;
		if (!delta) return;
		if (phase === 'commentary') {
			this.emitter.emit('thinking-chunk', managedProcess.sessionId, delta);
			return;
		}
		if (phase === 'final_answer') {
			this.emitter.emit('assistant-stream', managedProcess.sessionId, {
				mode: 'append',
				text: delta,
			});
		}
	}

	private handleItemCompleted(managedProcess: ManagedProcess, rawParams: unknown): void {
		const params = asRecord(rawParams);
		const item = asRecord(params?.item);
		if (!item) return;
		const itemType = asString(item.type);

		if (itemType && itemType !== 'agentMessage') {
			this.emitToolEventForItem(managedProcess, item, this.getItemCompletionStatus(item));
			return;
		}

		if (itemType !== 'agentMessage') return;
		const phase = asString(item.phase);
		const text = asString(item.text);
		const itemId = asString(item.id);
		logger.info('[CodexAppServerBridge] Item completed', LOG_CONTEXT, {
			sessionId: managedProcess.sessionId,
			phase: phase || 'unknown',
			hasText: !!text,
			textPreview: text ? text.slice(0, 200) : undefined,
		});
		if (phase === 'final_answer' && text) {
			const state = managedProcess.codexAppServerState;
			const shouldCorrect =
				!!state &&
				!state.currentTurnHadUserInputRequest &&
				(state.currentTurnCorrectionCount || 0) < MAX_CHAT_QUESTION_CORRECTIONS &&
				looksLikeBlockingChatQuestion(text);

			if (shouldCorrect) {
				this.emitter.emit('assistant-stream', managedProcess.sessionId, { mode: 'discard' });
				state.pendingCorrectionPrompt = `${CHAT_QUESTION_CORRECTION_PROMPT}\n\nPrevious assistant response:\n\n${text}`;
				state.suppressedFinalAnswerText = text;
				logger.warn(
					'[CodexAppServerBridge] Suppressing chat question final answer and retrying turn',
					LOG_CONTEXT,
					{
						sessionId: managedProcess.sessionId,
						correctionCount: state.currentTurnCorrectionCount || 0,
					}
				);
			} else {
				this.emitter.emit('assistant-stream', managedProcess.sessionId, {
					mode: 'replace',
					text,
				});
				this.emitter.emit('assistant-stream', managedProcess.sessionId, { mode: 'commit' });
			}
		}
		if (itemId && managedProcess.codexAppServerState) {
			managedProcess.codexAppServerState.agentMessagePhases.delete(itemId);
		}
	}

	private handleTokenCount(managedProcess: ManagedProcess, rawParams: unknown): void {
		const params = asRecord(rawParams);
		const msg = asRecord(params?.msg) as TokenUsageMessage | null;
		const usage = msg?.info?.last_token_usage;
		if (!usage) return;
		this.emitUsage(managedProcess, {
			inputTokens: usage.input_tokens || 0,
			outputTokens: usage.output_tokens || 0,
			cacheReadInputTokens: usage.cached_input_tokens || 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0,
			contextWindow: msg?.info?.model_context_window || managedProcess.contextWindow || 400000,
			reasoningTokens: usage.reasoning_output_tokens || 0,
		});
	}

	private handleThreadTokenUsageUpdated(managedProcess: ManagedProcess, rawParams: unknown): void {
		const params = asRecord(rawParams) as ThreadTokenUsageMessage | null;
		const usage = params?.tokenUsage?.last;
		if (!usage) return;
		this.emitUsage(managedProcess, {
			inputTokens: usage.inputTokens || 0,
			outputTokens: usage.outputTokens || 0,
			cacheReadInputTokens: usage.cachedInputTokens || 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0,
			contextWindow:
				params?.tokenUsage?.modelContextWindow || managedProcess.contextWindow || 400000,
			reasoningTokens: usage.reasoningOutputTokens || 0,
		});
	}

	private emitUsage(
		managedProcess: ManagedProcess,
		usage: {
			inputTokens: number;
			outputTokens: number;
			cacheReadInputTokens: number;
			cacheCreationInputTokens: number;
			totalCostUsd: number;
			contextWindow: number;
			reasoningTokens: number;
		}
	): void {
		this.emitter.emit('usage', managedProcess.sessionId, {
			...usage,
		});
	}

	private handleThinkingDelta(managedProcess: ManagedProcess, rawParams: unknown): void {
		const delta = asString(asRecord(rawParams)?.delta);
		if (!delta) return;
		this.emitter.emit('thinking-chunk', managedProcess.sessionId, delta);
	}

	private handleCommandExecutionOutputDelta(
		managedProcess: ManagedProcess,
		rawParams: unknown
	): void {
		const params = asRecord(rawParams);
		const itemId = asString(params?.itemId);
		const delta = asString(params?.delta);
		if (!itemId || !delta) return;

		this.emitter.emit('tool-execution', managedProcess.sessionId, {
			toolName: 'shell_command',
			state: {
				id: itemId,
				status: 'running',
				output: delta,
			},
			timestamp: Date.now(),
		});
	}

	private handleFileChangeOutputDelta(managedProcess: ManagedProcess, rawParams: unknown): void {
		const params = asRecord(rawParams);
		const itemId = asString(params?.itemId);
		const delta = asString(params?.delta);
		if (!itemId || !delta) return;

		this.emitToolExecution(managedProcess, 'apply_patch', {
			id: itemId,
			status: 'running',
			output: delta,
		});
	}

	private handleMcpToolCallProgress(managedProcess: ManagedProcess, rawParams: unknown): void {
		const params = asRecord(rawParams);
		const itemId = asString(params?.itemId);
		const message = asString(params?.message);
		if (!itemId || !message) return;

		this.emitToolExecution(managedProcess, this.getToolNameForItem(managedProcess, itemId, 'mcp_tool'), {
			id: itemId,
			status: 'running',
			output: message,
		});
	}

	private handleCommandExecutionTerminalInteraction(
		managedProcess: ManagedProcess,
		rawParams: unknown
	): void {
		const params = asRecord(rawParams);
		const itemId = asString(params?.itemId);
		const processId = asString(params?.processId);
		const stdin = asString(params?.stdin);
		if (!itemId || !stdin) return;

		this.emitter.emit('tool-execution', managedProcess.sessionId, {
			toolName: 'shell_command',
			state: {
				id: itemId,
				processId,
				status: 'running',
				stdin,
			},
			timestamp: Date.now(),
		});
	}

	private emitToolEventForItem(
		managedProcess: ManagedProcess,
		item: Record<string, unknown>,
		status: 'running' | 'completed' | 'error'
	): void {
		const itemType = asString(item.type);
		switch (itemType) {
			case 'commandExecution':
				this.emitCommandExecutionToolEvent(managedProcess, item, status);
				return;
			case 'fileChange':
				this.emitGenericToolItemEvent(managedProcess, item, status, 'apply_patch', {
					input: {
						changes: Array.isArray(item.changes) ? item.changes : undefined,
					},
				});
				return;
			case 'mcpToolCall': {
				const toolName = asString(item.tool) || 'mcp_tool';
				this.emitGenericToolItemEvent(managedProcess, item, status, toolName, {
					input: {
						server: asString(item.server),
						arguments: item.arguments,
					},
					output: item.result ?? item.error ?? undefined,
					durationMs: asNumber(item.durationMs),
				});
				return;
			}
			case 'dynamicToolCall': {
				const toolName = asString(item.tool) || 'dynamic_tool';
				this.emitGenericToolItemEvent(managedProcess, item, status, toolName, {
					input: {
						arguments: item.arguments,
					},
					output: item.contentItems ?? undefined,
					durationMs: asNumber(item.durationMs),
				});
				return;
			}
			case 'collabAgentToolCall': {
				const toolName = asString(item.tool) || 'collab_agent_tool';
				this.emitGenericToolItemEvent(managedProcess, item, status, toolName, {
					input: {
						prompt: asString(item.prompt),
						model: asString(item.model),
						reasoningEffort: asString(item.reasoningEffort),
						receiverThreadIds: Array.isArray(item.receiverThreadIds)
							? item.receiverThreadIds
							: undefined,
					},
					output: item.agentsStates ?? undefined,
				});
				return;
			}
			case 'webSearch':
				this.emitGenericToolItemEvent(managedProcess, item, status, 'web_search', {
					input: {
						query: asString(item.query),
						action: item.action,
					},
				});
				return;
			case 'imageView':
				this.emitGenericToolItemEvent(managedProcess, item, status, 'view_image', {
					input: {
						path: asString(item.path),
					},
				});
				return;
			case 'imageGeneration':
				this.emitGenericToolItemEvent(managedProcess, item, status, 'image_generation', {
					input: {
						revisedPrompt: asString(item.revisedPrompt),
					},
					output: asString(item.result) || undefined,
				});
				return;
			default:
				return;
		}
	}

	private emitCommandExecutionToolEvent(
		managedProcess: ManagedProcess,
		item: Record<string, unknown>,
		status: 'running' | 'completed' | 'error'
	): void {
		const itemId = asString(item.id);
		const command = asString(item.command);
		if (!itemId || !command) return;
		const aggregatedOutput = asString(item.aggregatedOutput);
		this.emitDemoCaptureOutput(managedProcess, aggregatedOutput);

		this.emitToolExecution(managedProcess, 'shell_command', {
			id: itemId,
			status,
			input: {
				command,
				cwd: asString(item.cwd),
				commandActions: Array.isArray(item.commandActions) ? item.commandActions : undefined,
			},
			output: aggregatedOutput || undefined,
			processId: asString(item.processId),
			exitCode: asNumber(item.exitCode),
			durationMs: asNumber(item.durationMs),
		});
	}

	private emitGenericToolItemEvent(
		managedProcess: ManagedProcess,
		item: Record<string, unknown>,
		status: 'running' | 'completed' | 'error',
		toolName: string,
		overrides: Record<string, unknown> = {}
	): void {
		const itemId = asString(item.id);
		if (!itemId) return;

		this.emitToolExecution(managedProcess, toolName, {
			id: itemId,
			status,
			...overrides,
		});
	}

	private emitToolExecution(
		managedProcess: ManagedProcess,
		toolName: string,
		state: Record<string, unknown>
	): void {
		const itemId = asString(state.id);
		if (itemId && managedProcess.codexAppServerState?.toolItemNames) {
			managedProcess.codexAppServerState.toolItemNames.set(itemId, toolName);
			if (state.status === 'completed' || state.status === 'error') {
				managedProcess.codexAppServerState.toolItemNames.delete(itemId);
			}
		}

		this.emitter.emit('tool-execution', managedProcess.sessionId, {
			toolName,
			state,
			timestamp: Date.now(),
		});
	}

	private emitDemoCaptureOutput(
		managedProcess: ManagedProcess,
		output: string | null | undefined
	): void {
		const demoEventOutput = extractDemoEventOutput(output);
		if (!demoEventOutput) {
			return;
		}
		this.emitter.emit('data', managedProcess.sessionId, `${demoEventOutput}\n`);
	}

	private getToolNameForItem(
		managedProcess: ManagedProcess,
		itemId: string,
		fallback: string
	): string {
		return managedProcess.codexAppServerState?.toolItemNames.get(itemId) || fallback;
	}

	private getItemCompletionStatus(
		item: Record<string, unknown>
	): 'running' | 'completed' | 'error' {
		const rawStatus = asString(item.status)?.toLowerCase();
		if (!rawStatus) return 'completed';
		if (rawStatus.includes('fail') || rawStatus.includes('error') || rawStatus.includes('reject')) {
			return 'error';
		}
		if (
			rawStatus.includes('complete') ||
			rawStatus.includes('success') ||
			rawStatus.includes('done') ||
			rawStatus.includes('approved') ||
			rawStatus.includes('applied')
		) {
			return 'completed';
		}
		return 'running';
	}

	private handlePendingRequestResponse(
		managedProcess: ManagedProcess,
		messageId: string,
		message: JsonRpcMessage
	): void {
		const pendingRequest = managedProcess.codexAppServerState?.pendingRequests?.get(messageId);
		managedProcess.codexAppServerState?.pendingRequests?.delete(messageId);
		if (!pendingRequest) {
			return;
		}

		const error = asRecord(message.error);
		if (error) {
			const messageText =
				asString(error.message) || 'Codex app-server rejected the conversation request.';
			if (pendingRequest.type === 'steer') {
				this.emitConversationEvent(managedProcess, {
					type: 'steer_rejected',
					sessionId: managedProcess.sessionId,
					runtimeKind: managedProcess.conversationRuntime || 'batch',
					timestamp: Date.now(),
					threadId: managedProcess.codexAppServerState?.threadId,
					turnId: managedProcess.codexAppServerState?.turnId || null,
					message: messageText,
				});
			}
			return;
		}

		if (pendingRequest.type === 'steer' && managedProcess.codexAppServerState?.threadId) {
			this.emitConversationEvent(managedProcess, {
				type: 'steer_accepted',
				sessionId: managedProcess.sessionId,
				runtimeKind: managedProcess.conversationRuntime || 'batch',
				timestamp: Date.now(),
				threadId: managedProcess.codexAppServerState.threadId,
				turnId: managedProcess.codexAppServerState.turnId || '',
			});
		}
	}

	private emitConversationEvent(managedProcess: ManagedProcess, event: ConversationEvent): void {
		this.emitter.emit('conversation-event', managedProcess.sessionId, event);
	}

	private sendJson(ws: WebSocket, payload: JsonRpcMessage): void {
		ws.send(JSON.stringify(payload));
	}

	private startTurn(
		managedProcess: ManagedProcess,
		config: ProcessConfig,
		threadId: string,
		input: Array<Record<string, unknown>>,
		model: string,
		reasoningEffort: string | null | undefined
	): void {
		const state = managedProcess.codexAppServerState;
		const ws = state?.ws;
		if (!state || !ws || ws.readyState !== WebSocket.OPEN) return;

		this.prepareDemoCaptureForTurn(
			managedProcess,
			config.demoCapture?.enabled === true,
			config.demoCaptureContext
		);
		state.turnCompleted = false;
		state.turnId = undefined;
		state.currentTurnHadUserInputRequest = false;
		state.pendingCorrectionPrompt = undefined;
		state.suppressedFinalAnswerText = undefined;

		logger.info('[CodexAppServerBridge] Starting turn', LOG_CONTEXT, {
			sessionId: managedProcess.sessionId,
			threadId,
			inputCount: input.length,
			correctionCount: state.currentTurnCorrectionCount || 0,
		});
		const isReadOnly = config.readOnlyMode === true;
		const sandboxPolicy =
			managedProcess.conversationRuntime === 'live'
				? isReadOnly
					? {
							type: 'readOnly',
							networkAccess: false,
						}
					: {
							type: 'workspaceWrite',
							writableRoots: [config.cwd],
							networkAccess: true,
						}
				: {
						type: 'readOnly',
						networkAccess: false,
					};
		const approvalPolicy =
			managedProcess.conversationRuntime === 'live'
				? isReadOnly
					? 'never'
					: 'untrusted'
				: 'never';
		this.sendJson(ws, {
			id: 'turn',
			method: 'turn/start',
			params: {
				threadId,
				input,
				cwd: config.cwd,
				approvalPolicy,
				sandboxPolicy,
				model,
				effort: reasoningEffort || undefined,
				...(config.readOnlyMode === true && {
					collaborationMode: {
						mode: 'plan',
						settings: {
							model,
							reasoning_effort: reasoningEffort || null,
							developer_instructions: PLAN_MODE_DEVELOPER_INSTRUCTIONS,
						},
					},
				}),
			},
		});
	}

	private emitAgentError(sessionId: string, message: string, raw?: unknown): void {
		this.emitter.emit('agent-error', sessionId, createAgentError(sessionId, message, raw));
	}

	private prepareDemoCaptureForTurn(
		managedProcess: ManagedProcess,
		demoCaptureEnabled: boolean,
		demoCaptureContext?: ManagedProcess['demoCaptureContext']
	): void {
		managedProcess.demoCaptureEnabled = demoCaptureEnabled;
		managedProcess.demoCaptureFinalized = false;
		managedProcess.demoCaptureArtifactSeen = false;
		managedProcess.demoCaptureFailed = false;
		if (demoCaptureContext) {
			managedProcess.demoCaptureContext = demoCaptureContext;
			void writeDemoTurnContextFile(demoCaptureContext).catch((error) => {
				logger.warn('[CodexAppServerBridge] Failed to write demo turn context file', LOG_CONTEXT, {
					sessionId: managedProcess.sessionId,
					error: String(error),
				});
			});
		}
	}

	private killProcess(managedProcess: ManagedProcess): void {
		const child = managedProcess.childProcess;
		if (!child || child.killed) return;
		try {
			child.kill('SIGTERM');
		} catch (error) {
			logger.warn('[CodexAppServerBridge] Failed to kill app-server child', LOG_CONTEXT, {
				sessionId: managedProcess.sessionId,
				error: String(error),
			});
		}
	}

	private finishProcess(managedProcess: ManagedProcess, code: number): void {
		const existing = this.processes.get(managedProcess.sessionId);
		if (!existing) return;

		this.processes.delete(managedProcess.sessionId);
		this.emitter.emit('query-complete', managedProcess.sessionId, {
			sessionId: managedProcess.sessionId,
			agentType: managedProcess.toolType,
			source: managedProcess.querySource || 'user',
			startTime: managedProcess.startTime,
			duration: Date.now() - managedProcess.startTime,
			projectPath: managedProcess.projectPath,
			tabId: managedProcess.tabId,
		});
		this.emitter.emit('exit', managedProcess.sessionId, code);
	}
}
