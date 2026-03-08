import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { logger } from '../utils/logger';
import { buildChildProcessEnv } from './utils/envBuilder';
import type {
	CodexAppServerState,
	ManagedProcess,
	ProcessConfig,
	SpawnResult,
} from './types';
import type {
	UserInputRequest,
	UserInputRequestId,
	UserInputResponse,
} from '../../shared/user-input-requests';
import type { AgentError } from '../../shared/types';

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

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
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
			shell: config.runInShell ? (config.shell || true) : false,
		});

		const codexAppServerState: CodexAppServerState = {
			nextClientRequestId: 1,
			agentMessagePhases: new Map(),
			currentTurnCorrectionCount: 0,
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

	private connectWebSocket(managedProcess: ManagedProcess, config: ProcessConfig, wsUrl: string): void {
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
			const turn = asRecord(result?.turn);
			const turnId = asString(turn?.id);
			if (turnId && managedProcess.codexAppServerState) {
				managedProcess.codexAppServerState.turnId = turnId;
			}
			return;
		}

		const method = asString(message.method);
		if (!method) {
			return;
		}

		switch (method) {
			case 'item/tool/requestUserInput':
				this.handleUserInputRequest(managedProcess, message);
				return;
			case 'item/started':
				this.handleItemStarted(managedProcess, message.params);
				return;
			case 'item/agentMessage/delta':
				this.handleAgentMessageDelta(managedProcess, message.params);
				return;
			case 'item/completed':
				this.handleItemCompleted(managedProcess, message.params);
				return;
			case 'codex/event/token_count':
				this.handleTokenCount(managedProcess, message.params);
				return;
			case 'turn/completed':
				logger.info('[CodexAppServerBridge] Turn completed notification', LOG_CONTEXT, {
					sessionId: managedProcess.sessionId,
					hasPendingCorrection:
						!!managedProcess.codexAppServerState?.pendingCorrectionPrompt,
					hadUserInputRequest:
						managedProcess.codexAppServerState?.currentTurnHadUserInputRequest === true,
				});
				if (managedProcess.codexAppServerState) {
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
				}
				this.killProcess(managedProcess);
				return;
			case 'error':
				this.emitAgentError(
					managedProcess.sessionId,
					'Codex app-server returned an error notification.',
					message.params
				);
				return;
			default:
				return;
		}
	}

	private handleInitializeResponse(managedProcess: ManagedProcess, config: ProcessConfig): void {
		const state = managedProcess.codexAppServerState;
		const ws = state?.ws;
		if (!state || !ws || ws.readyState !== WebSocket.OPEN) return;

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
					approvalPolicy: 'never',
					sandbox: 'read-only',
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
				approvalPolicy: 'never',
				sandbox: 'read-only',
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
		const inputs: Array<Record<string, unknown>> = [];
		if (config.prompt) {
			inputs.push({
				type: 'text',
				text: config.prompt,
				text_elements: [],
			});
		}
		for (const image of config.images || []) {
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
		if (!item || asString(item.type) !== 'agentMessage') return;
		const itemId = asString(item.id);
		const phase = asString(item.phase);
		if (!itemId || !phase || !managedProcess.codexAppServerState) return;
		managedProcess.codexAppServerState.agentMessagePhases.set(itemId, phase);
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
		if (!item || asString(item.type) !== 'agentMessage') return;
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
		this.emitter.emit('usage', managedProcess.sessionId, {
			inputTokens: usage.input_tokens || 0,
			outputTokens: usage.output_tokens || 0,
			cacheReadInputTokens: usage.cached_input_tokens || 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0,
			contextWindow: msg?.info?.model_context_window || managedProcess.contextWindow || 400000,
			reasoningTokens: usage.reasoning_output_tokens || 0,
		});
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
		this.sendJson(ws, {
			id: 'turn',
			method: 'turn/start',
			params: {
				threadId,
				input,
				cwd: config.cwd,
				approvalPolicy: 'never',
				sandboxPolicy: {
					type: 'readOnly',
					access: {
						type: 'fullAccess',
					},
					networkAccess: false,
				},
				collaborationMode: {
					mode: 'plan',
					settings: {
						model,
						reasoning_effort: reasoningEffort || null,
						developer_instructions: PLAN_MODE_DEVELOPER_INSTRUCTIONS,
					},
				},
			},
		});
	}

	private emitAgentError(sessionId: string, message: string, raw?: unknown): void {
		this.emitter.emit('agent-error', sessionId, createAgentError(sessionId, message, raw));
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
