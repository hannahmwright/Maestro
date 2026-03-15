import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { getDemoArtifactService } from '../artifacts';
import { writeDemoTurnContextFile } from '../artifacts/maestroDemoRuntime';
import { buildChildProcessEnv } from './utils/envBuilder';
import { parseDataUrl } from './utils/imageUtils';
import { aggregateModelUsage } from '../parsers/usage-aggregator';
import { extractDemoEventOutput } from '../../shared/demo-artifacts';
import type {
	ConversationEvent,
} from '../../shared/conversation';
import type { AgentError } from '../../shared/types';
import type {
	UserInputRequest,
	UserInputRequestId,
	UserInputResponse,
} from '../../shared/user-input-requests';
import type { ManagedProcess, ProcessConfig, SpawnResult } from './types';
import type {
	ElicitationRequest,
	ElicitationResult,
	Query as ClaudeQuery,
	SDKMessage,
	SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

const LOG_CONTEXT = 'ClaudeSdkBridge';

type ClaudeSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

type ClaudeState = NonNullable<ManagedProcess['claudeSdkState']>;

class LiveMessageQueue<T> implements AsyncIterable<T> {
	private items: T[] = [];
	private waitingResolvers: Array<(result: IteratorResult<T>) => void> = [];
	private closed = false;

	push(item: T): boolean {
		if (this.closed) {
			return false;
		}
		const resolver = this.waitingResolvers.shift();
		if (resolver) {
			resolver({ value: item, done: false });
			return true;
		}
		this.items.push(item);
		return true;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		while (this.waitingResolvers.length > 0) {
			const resolver = this.waitingResolvers.shift();
			resolver?.({ value: undefined as T, done: true });
		}
	}

	private next(): Promise<IteratorResult<T>> {
		if (this.items.length > 0) {
			return Promise.resolve({ value: this.items.shift()!, done: false });
		}
		if (this.closed) {
			return Promise.resolve({ value: undefined as T, done: true });
		}
		return new Promise((resolve) => {
			this.waitingResolvers.push(resolve);
		});
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => this.next(),
		};
	}
}

let claudeSdkModulePromise: Promise<ClaudeSdkModule> | null = null;

function loadClaudeSdk(): Promise<ClaudeSdkModule> {
	if (!claudeSdkModulePromise) {
		claudeSdkModulePromise = import('@anthropic-ai/claude-agent-sdk');
	}
	return claudeSdkModulePromise;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function createAgentError(
	sessionId: string,
	type: AgentError['type'],
	message: string,
	raw?: unknown
): AgentError {
	return {
		type,
		message,
		recoverable: type !== 'agent_crashed',
		agentId: 'claude-code',
		sessionId,
		timestamp: Date.now(),
		raw: raw ? { stderr: JSON.stringify(raw) } : undefined,
	};
}

function mapReasoningEffort(
	effort: ProcessConfig['sessionReasoningEffort']
): {
	effort?: 'low' | 'medium' | 'high' | 'max';
	thinking?: { type: 'disabled' };
} {
	switch (effort) {
		case 'none':
			return { thinking: { type: 'disabled' } };
		case 'minimal':
		case 'low':
			return { effort: 'low' };
		case 'medium':
			return { effort: 'medium' };
		case 'high':
			return { effort: 'high' };
		case 'xhigh':
			return { effort: 'max' };
		default:
			return {};
	}
}

function buildUserMessage(
	sessionId: string,
	text?: string,
	images?: string[],
	priority?: SDKUserMessage['priority']
): SDKUserMessage | null {
	const contentBlocks: Array<Record<string, unknown>> = [];
	for (const image of images || []) {
		const parsed = parseDataUrl(image);
		if (!parsed) continue;
		contentBlocks.push({
			type: 'image',
			source: {
				type: 'base64',
				media_type: parsed.mediaType,
				data: parsed.base64,
			},
		});
	}
	if (text?.trim()) {
		contentBlocks.push({
			type: 'text',
			text: text.trim(),
		});
	}

	if (contentBlocks.length === 0) {
		return null;
	}

	return {
		type: 'user',
		message: {
			role: 'user',
			content: contentBlocks,
		},
		parent_tool_use_id: null,
		priority,
		uuid: randomUUID(),
		session_id: sessionId,
	};
}

function extractAssistantText(message: unknown): string {
	const record = asRecord(message);
	const content = Array.isArray(record?.content) ? record.content : [];
	return content
		.map((item) => {
			const block = asRecord(item);
			if (!block || block.type !== 'text') return '';
			return asString(block.text) || '';
		})
		.filter(Boolean)
		.join('');
}

function extractToolResultOutput(message: Extract<SDKMessage, { type: 'user' }>): string {
	const outputs: string[] = [];
	const toolUseResult = asRecord(message.tool_use_result);
	const stdout = asString(toolUseResult?.stdout);
	const stderr = asString(toolUseResult?.stderr);
	if (stdout) {
		outputs.push(stdout);
	}
	if (stderr) {
		outputs.push(stderr);
	}

	const record = asRecord(message.message);
	const content = Array.isArray(record?.content) ? record.content : [];
	for (const item of content) {
		const block = asRecord(item);
		if (!block || block.type !== 'tool_result') continue;
		const blockContent = asString(block.content);
		if (blockContent) {
			outputs.push(blockContent);
		}
	}

	return outputs.join('\n');
}

function emitToolBlocks(
	emitter: EventEmitter,
	sessionId: string,
	message: unknown
): void {
	const record = asRecord(message);
	const content = Array.isArray(record?.content) ? record.content : [];
	for (const item of content) {
		const block = asRecord(item);
		if (!block || block.type !== 'tool_use') continue;
		const toolName = asString(block.name);
		if (!toolName) continue;
		emitter.emit('tool-execution', sessionId, {
			toolName,
			state: { status: 'running', input: block.input },
			timestamp: Date.now(),
		});
	}
}

function buildFormRequest(
	request: ElicitationRequest,
	threadId: string,
	turnId: string
): UserInputRequest {
	const schema = asRecord(request.requestedSchema);
	const properties = asRecord(schema?.properties) || {};
	const requiredFields = new Set(
		Array.isArray(schema?.required)
			? schema.required.filter((value): value is string => typeof value === 'string')
			: []
	);

	const questions = Object.entries(properties).map(([propertyName, definition]) => {
		const property = asRecord(definition);
		const propertyType = asString(property?.type);
		const title = asString(property?.title) || propertyName;
		const description = asString(property?.description);
		const enumValues = Array.isArray(property?.enum)
			? property.enum
					.map((value) =>
						typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
							? String(value)
							: null
					)
					.filter((value): value is string => !!value)
			: [];
		const isBoolean = propertyType === 'boolean';
		const options =
			enumValues.length > 0
				? enumValues.map((value) => ({ label: value, description: '' }))
				: isBoolean
					? [
							{ label: 'Yes', description: '' },
							{ label: 'No', description: '' },
						]
					: undefined;

		return {
			id: propertyName,
			header: title,
			question:
				description ||
				`${title}${requiredFields.has(propertyName) ? ' (required)' : ''}`,
			options,
			isOther: !options || options.length === 0,
			isSecret: property?.writeOnly === true || property?.format === 'password',
		};
	});

	if (questions.length === 0) {
		questions.push({
			id: 'response',
			header: request.serverName,
			question: request.message,
			options: undefined,
			isOther: true,
			isSecret: false,
		});
	}

	return {
		requestId: randomUUID(),
		threadId,
		turnId,
		itemId: randomUUID(),
		questions,
	};
}

function buildUrlRequest(
	request: ElicitationRequest,
	threadId: string,
	turnId: string
): UserInputRequest {
	const prompt = request.url
		? `${request.message}\n\nOpen this URL in your browser:\n${request.url}`
		: request.message;

	return {
		requestId: randomUUID(),
		threadId,
		turnId,
		itemId: randomUUID(),
		questions: [
			{
				id: 'url-action',
				header: request.serverName,
				question: `${prompt}\n\nChoose Continue once you finish, or Cancel to stop.`,
				options: [
					{ label: 'Continue', description: 'I completed the requested step.' },
					{ label: 'Cancel', description: 'Stop and tell Claude the request was not completed.' },
				],
				isOther: false,
			},
		],
	};
}

function buildElicitationResultFromResponse(
	pendingRequest: NonNullable<ClaudeState['pendingUserInput']>,
	response: UserInputResponse
): ElicitationResult {
	if (pendingRequest.mode === 'url') {
		return {
			action: response.answers['url-action']?.answers?.[0] === 'Cancel' ? 'cancel' : 'accept',
		};
	}

	const schema = asRecord(pendingRequest.requestedSchema);
	const properties = asRecord(schema?.properties) || {};
	const content: Record<string, unknown> = {};

	for (const [questionId, answer] of Object.entries(response.answers)) {
		const firstAnswer = answer.answers.find((value) => value.trim());
		if (!firstAnswer) continue;

		const property = asRecord(properties[questionId]);
		const propertyType = asString(property?.type);

		if (propertyType === 'boolean') {
			content[questionId] = firstAnswer.toLowerCase() === 'yes';
			continue;
		}

		if (propertyType === 'number' || propertyType === 'integer') {
			const numericValue = Number(firstAnswer);
			content[questionId] = Number.isFinite(numericValue) ? numericValue : firstAnswer;
			continue;
		}

		content[questionId] = firstAnswer;
	}

	return {
		action: 'accept',
		content,
	};
}

export class ClaudeSdkBridge {
	constructor(
		private processes: Map<string, ManagedProcess>,
		private emitter: EventEmitter
	) {}

	sendTurn(config: ProcessConfig): SpawnResult {
		const existingProcess = this.processes.get(config.sessionId);
		if (existingProcess?.claudeSdkState) {
			if (existingProcess.claudeSdkState.activeTurnId) {
				return { pid: existingProcess.pid, success: false };
			}

			const userMessage = buildUserMessage(
				existingProcess.claudeSdkState.sdkSessionId || config.agentSessionId || config.sessionId,
				config.prompt,
				config.images
			);
			if (!userMessage) {
				return { pid: existingProcess.pid, success: false };
			}

			existingProcess.startTime = Date.now();
			existingProcess.querySource = config.querySource;
			existingProcess.tabId = config.tabId;
			existingProcess.projectPath = config.projectPath;
			existingProcess.contextWindow = config.contextWindow;
			existingProcess.conversationRuntime = config.conversationRuntime || 'live';
			this.prepareDemoCaptureForTurn(
				existingProcess,
				config.demoCapture?.enabled === true,
				config.demoCaptureContext
			);
			this.startTurn(existingProcess, 'turn');
			existingProcess.claudeSdkState.inputQueue?.push(userMessage);
			return { pid: existingProcess.pid, success: true };
		}

		const state: ClaudeState = {
			inputQueue: new LiveMessageQueue<SDKUserMessage>(),
			nextTurnSequence: 1,
			sdkSessionId: config.agentSessionId,
		};
		const initialMessage = buildUserMessage(
			config.agentSessionId || config.sessionId,
			config.prompt,
			config.images
		);
		if (!initialMessage) {
			return { pid: -1, success: false };
		}
		state.inputQueue!.push(initialMessage);

		const managedProcess: ManagedProcess = {
			sessionId: config.sessionId,
			toolType: config.toolType,
			cwd: config.cwd,
			pid: -1,
			isTerminal: false,
			isBatchMode: true,
			startTime: Date.now(),
			contextWindow: config.contextWindow,
			querySource: config.querySource,
			tabId: config.tabId,
			projectPath: config.projectPath,
			currentModel: config.resolvedModel,
			command: config.command,
			args: config.args,
			conversationRuntime: config.conversationRuntime || 'live',
			claudeSdkState: state,
			demoCaptureEnabled: config.demoCapture?.enabled === true,
			demoCaptureFinalized: false,
			demoCaptureArtifactSeen: false,
			demoCaptureFailed: false,
			demoCaptureContext: config.demoCaptureContext,
		};
		this.processes.set(config.sessionId, managedProcess);
		this.startTurn(managedProcess, 'turn');
		void this.runQuery(managedProcess, config);
		return { pid: managedProcess.pid, success: true };
	}

	steerTurn(sessionId: string, input: { text?: string; images?: string[] }): boolean {
		const managedProcess = this.processes.get(sessionId);
		const state = managedProcess?.claudeSdkState;
		if (!managedProcess || !state?.activeTurnId || !state.inputQueue) {
			return false;
		}

		const userMessage = buildUserMessage(
			state.sdkSessionId || managedProcess.sessionId,
			input.text,
			input.images,
			'now'
		);
		if (!userMessage) {
			return false;
		}

		const pushed = state.inputQueue.push(userMessage);
		if (!pushed) {
			return false;
		}

		if (state.sdkSessionId) {
			this.emitConversationEvent(managedProcess, {
				type: 'steer_accepted',
				sessionId,
				runtimeKind: managedProcess.conversationRuntime || 'live',
				timestamp: Date.now(),
				threadId: state.sdkSessionId,
				turnId: state.activeTurnId,
			});
		}

		return true;
	}

	interruptTurn(sessionId: string): boolean {
		const managedProcess = this.processes.get(sessionId);
		const state = managedProcess?.claudeSdkState;
		const query = state?.query as ClaudeQuery | undefined;
		if (!managedProcess || !state || !query) {
			return false;
		}

		state.pendingInterrupt = true;
		void query.interrupt().catch((error) => {
			logger.warn('[ClaudeSdkBridge] Failed to interrupt live query', LOG_CONTEXT, {
				sessionId,
				error: String(error),
			});
		});
		return true;
	}

	closeSession(sessionId: string): boolean {
		const managedProcess = this.processes.get(sessionId);
		const state = managedProcess?.claudeSdkState;
		if (!managedProcess || !state) {
			return false;
		}

		state.inputQueue?.close();
		const query = state.query as ClaudeQuery | undefined;
		query?.close();

		if (managedProcess.childProcess && !managedProcess.childProcess.killed) {
			try {
				managedProcess.childProcess.kill('SIGTERM');
			} catch {
				// Ignore child shutdown failures during forced close.
			}
		}

		this.finishProcess(managedProcess, 0);
		return true;
	}

	async respondToUserInput(
		sessionId: string,
		requestId: UserInputRequestId,
		response: UserInputResponse
	): Promise<boolean> {
		const managedProcess = this.processes.get(sessionId);
		const state = managedProcess?.claudeSdkState;
		const pendingRequest = state?.pendingUserInput;
		if (!managedProcess || !state || !pendingRequest || pendingRequest.requestId !== requestId) {
			return false;
		}

		pendingRequest.cleanup();
		state.pendingUserInput = undefined;
		pendingRequest.resolve(buildElicitationResultFromResponse(pendingRequest, response));
		return true;
	}

	private async runQuery(managedProcess: ManagedProcess, config: ProcessConfig): Promise<void> {
		const state = managedProcess.claudeSdkState;
		if (!state?.inputQueue) return;

		try {
			const sdk = await loadClaudeSdk();
			let spawnedChild: ChildProcess | undefined;
			const resolvedCommand = config.command;
			const env = buildChildProcessEnv(
				config.customEnvVars,
				!!config.agentSessionId,
				config.shellEnvVars
			);
			const reasoning = mapReasoningEffort(config.sessionReasoningEffort);
			const query = sdk.query({
				prompt: state.inputQueue as unknown as AsyncIterable<SDKUserMessage>,
				options: {
					cwd: config.cwd,
					pathToClaudeCodeExecutable: resolvedCommand,
					env,
					model: config.resolvedModel,
					includePartialMessages: true,
					persistSession: true,
					settingSources: ['user', 'project', 'local'],
					permissionMode: config.readOnlyMode ? 'plan' : 'bypassPermissions',
					allowDangerouslySkipPermissions: config.readOnlyMode ? undefined : true,
					resume: config.agentSessionId,
					stderr: (data: string) => {
						this.emitter.emit('stderr', managedProcess.sessionId, data);
					},
					onElicitation: (request, options) =>
						this.handleElicitation(managedProcess, request, options.signal),
					...(reasoning.effort ? { effort: reasoning.effort } : {}),
					...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
					spawnClaudeCodeProcess: ({ command, args, cwd, env: spawnEnv, signal }) => {
						const child = spawn(resolvedCommand || command, args, {
							cwd: cwd || config.cwd,
							env: spawnEnv,
							signal,
						});
						spawnedChild = child;
						return child;
					},
				},
			});
			state.query = query;

			if (spawnedChild) {
				managedProcess.childProcess = spawnedChild;
				managedProcess.pid = spawnedChild.pid ?? -1;
			}

			for await (const message of query) {
				this.handleMessage(managedProcess, message);
			}
		} catch (error) {
			this.emitter.emit(
				'agent-error',
				managedProcess.sessionId,
				createAgentError(
					managedProcess.sessionId,
					'agent_crashed',
					error instanceof Error ? error.message : String(error),
					error
				)
			);
			this.emitConversationEvent(managedProcess, {
				type: 'turn_failed',
				sessionId: managedProcess.sessionId,
				runtimeKind: managedProcess.conversationRuntime || 'live',
				timestamp: Date.now(),
				threadId: managedProcess.claudeSdkState?.sdkSessionId,
				turnId: managedProcess.claudeSdkState?.activeTurnId || null,
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			if (this.processes.has(managedProcess.sessionId) && !managedProcess.claudeSdkState?.queryClosed) {
				this.finishProcess(managedProcess, 0);
			}
		}
	}

	private handleMessage(managedProcess: ManagedProcess, message: SDKMessage): void {
		switch (message.type) {
			case 'system':
				this.handleSystemMessage(managedProcess, message);
				return;
			case 'stream_event':
				this.handleStreamEvent(managedProcess, message);
				return;
			case 'assistant':
				this.handleAssistantMessage(managedProcess, message);
				return;
			case 'user':
				this.handleUserMessage(managedProcess, message);
				return;
			case 'result':
				this.handleResultMessage(managedProcess, message);
				return;
			case 'tool_progress':
				this.emitter.emit('tool-execution', managedProcess.sessionId, {
					toolName: message.tool_name,
					state: {
						status: 'running',
						toolUseId: message.tool_use_id,
						elapsedTimeSeconds: message.elapsed_time_seconds,
						taskId: message.task_id,
					},
					timestamp: Date.now(),
				});
				return;
			case 'auth_status':
				if (message.error) {
					this.emitter.emit(
						'agent-error',
						managedProcess.sessionId,
						createAgentError(managedProcess.sessionId, 'auth_expired', message.error, message)
					);
				}
				return;
			default:
				return;
		}
	}

	private handleElicitation(
		managedProcess: ManagedProcess,
		request: ElicitationRequest,
		signal: AbortSignal
	): Promise<ElicitationResult> {
		const state = managedProcess.claudeSdkState;
		if (!state) {
			return Promise.resolve({ action: 'decline' });
		}
		if (state.pendingUserInput) {
			logger.warn('[ClaudeSdkBridge] Received overlapping elicitation request', LOG_CONTEXT, {
				sessionId: managedProcess.sessionId,
				serverName: request.serverName,
			});
			return Promise.resolve({ action: 'decline' });
		}

		const threadId = state.sdkSessionId || managedProcess.sessionId;
		const turnId = state.activeTurnId || `claude-turn-${state.nextTurnSequence}`;
		const userInputRequest =
			request.mode === 'url'
				? buildUrlRequest(request, threadId, turnId)
				: buildFormRequest(request, threadId, turnId);

		return new Promise<ElicitationResult>((resolve) => {
			const handleAbort = () => {
				cleanup();
				state.pendingUserInput = undefined;
				resolve({ action: 'cancel' });
			};
			const cleanup = () => {
				signal.removeEventListener('abort', handleAbort);
			};

			state.pendingUserInput = {
				requestId: userInputRequest.requestId,
				resolve,
				cleanup,
				mode: request.mode === 'url' ? 'url' : 'form',
				requestedSchema: request.requestedSchema,
			};
			signal.addEventListener('abort', handleAbort, { once: true });
			this.emitter.emit('user-input-request', managedProcess.sessionId, userInputRequest);
		});
	}

	private handleSystemMessage(
		managedProcess: ManagedProcess,
		message: Extract<SDKMessage, { type: 'system' }>
	): void {
		const state = managedProcess.claudeSdkState;
		if (!state) return;

		if (message.subtype === 'init') {
			state.sdkSessionId = message.session_id;
			if (!managedProcess.sessionIdEmitted) {
				managedProcess.sessionIdEmitted = true;
				this.emitter.emit('session-id', managedProcess.sessionId, message.session_id);
			}
			if (message.model && managedProcess.currentModel !== message.model) {
				managedProcess.currentModel = message.model;
				this.emitter.emit('model', managedProcess.sessionId, message.model);
			}
			if (message.slash_commands?.length) {
				this.emitter.emit('slash-commands', managedProcess.sessionId, message.slash_commands);
			}
			if (!state.runtimeReady) {
				state.runtimeReady = true;
				this.emitConversationEvent(managedProcess, {
					type: 'runtime_ready',
					sessionId: managedProcess.sessionId,
					runtimeKind: managedProcess.conversationRuntime || 'live',
					timestamp: Date.now(),
					threadId: message.session_id,
				});
			}
			if (state.activeTurnId && !state.turnStartedEmitted) {
				this.emitTurnStarted(managedProcess);
			}
		}
	}

	private handleStreamEvent(
		managedProcess: ManagedProcess,
		message: Extract<SDKMessage, { type: 'stream_event' }>
	): void {
		const event = asRecord(message.event);
		const eventType = asString(event?.type);
		if (!eventType) return;

		if (eventType === 'content_block_start') {
			const contentBlock = asRecord(event?.content_block);
			if (contentBlock?.type === 'tool_use') {
				const toolName = asString(contentBlock.name);
				if (toolName) {
					this.emitter.emit('tool-execution', managedProcess.sessionId, {
						toolName,
						state: { status: 'running', input: contentBlock.input },
						timestamp: Date.now(),
					});
				}
			}
			return;
		}

		if (eventType === 'content_block_delta') {
			const delta = asRecord(event?.delta);
			if (!delta) return;
			if (delta.type === 'text_delta') {
				const text = asString(delta.text);
				if (text) {
					this.emitter.emit('assistant-stream', managedProcess.sessionId, {
						mode: 'append',
						text,
					});
				}
				return;
			}
			if (delta.type === 'thinking_delta') {
				const thinking = asString(delta.thinking);
				if (thinking) {
					this.emitter.emit('thinking-chunk', managedProcess.sessionId, thinking);
				}
			}
		}
	}

	private handleAssistantMessage(
		managedProcess: ManagedProcess,
		message: Extract<SDKMessage, { type: 'assistant' }>
	): void {
		const text = extractAssistantText(message.message);
		emitToolBlocks(this.emitter, managedProcess.sessionId, message.message);
		if (text) {
			this.emitter.emit('assistant-stream', managedProcess.sessionId, {
				mode: 'replace',
				text,
			});
			this.emitter.emit('assistant-stream', managedProcess.sessionId, { mode: 'commit' });
		}

		if (message.error) {
			const errorType =
				message.error === 'authentication_failed'
					? 'auth_expired'
					: message.error === 'rate_limit'
						? 'rate_limited'
						: message.error === 'max_output_tokens'
							? 'token_exhaustion'
							: 'agent_crashed';
			this.emitter.emit(
				'agent-error',
				managedProcess.sessionId,
				createAgentError(managedProcess.sessionId, errorType, message.error, message)
			);
		}
	}

	private handleUserMessage(
		managedProcess: ManagedProcess,
		message: Extract<SDKMessage, { type: 'user' }>
	): void {
		const demoEventOutput = extractDemoEventOutput(extractToolResultOutput(message));
		if (demoEventOutput) {
			this.emitter.emit('data', managedProcess.sessionId, `${demoEventOutput}\n`);
		}
	}

	private handleResultMessage(
		managedProcess: ManagedProcess,
		message: Extract<SDKMessage, { type: 'result' }>
	): void {
		const state = managedProcess.claudeSdkState;
		if (!state) return;

		const usageStats = aggregateModelUsage(
			message.modelUsage as Record<string, any>,
			message.usage as Record<string, unknown>,
			message.total_cost_usd || 0
		);
		this.emitter.emit('usage', managedProcess.sessionId, usageStats);

		const turnId = state.activeTurnId || null;
		const threadId = state.sdkSessionId;
		const startTime = state.currentTurnStartedAt || managedProcess.startTime;
		let status: 'completed' | 'failed' | 'interrupted' =
			state.pendingInterrupt === true
				? 'interrupted'
				: message.subtype === 'success'
					? 'completed'
					: 'failed';

		if (message.subtype !== 'success') {
			const errorMessage = message.errors.join('\n') || 'Claude live turn failed.';
			this.emitter.emit(
				'agent-error',
				managedProcess.sessionId,
				createAgentError(managedProcess.sessionId, 'agent_crashed', errorMessage, message)
			);
			this.emitConversationEvent(managedProcess, {
				type: 'turn_failed',
				sessionId: managedProcess.sessionId,
				runtimeKind: managedProcess.conversationRuntime || 'live',
				timestamp: Date.now(),
				threadId,
				turnId,
				message: errorMessage,
			});
		}

		if (
			message.subtype === 'success' &&
			status === 'completed' &&
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
				status = 'failed';
				this.emitter.emit(
					'agent-error',
					managedProcess.sessionId,
					createAgentError(
						managedProcess.sessionId,
						'agent_crashed',
						outcome.message || 'Demo capture failed for this turn.'
					)
				);
				this.emitConversationEvent(managedProcess, {
					type: 'turn_failed',
					sessionId: managedProcess.sessionId,
					runtimeKind: managedProcess.conversationRuntime || 'live',
					timestamp: Date.now(),
					threadId,
					turnId,
					message: outcome.message || 'Demo capture failed for this turn.',
				});
			}
		}

		this.emitConversationEvent(managedProcess, {
			type: 'turn_completed',
			sessionId: managedProcess.sessionId,
			runtimeKind: managedProcess.conversationRuntime || 'live',
			timestamp: Date.now(),
			threadId,
			turnId,
			status,
		});

		this.emitter.emit('query-complete', managedProcess.sessionId, {
			sessionId: managedProcess.sessionId,
			agentType: managedProcess.toolType,
			source: managedProcess.querySource || 'user',
			startTime,
			duration: Date.now() - startTime,
			projectPath: managedProcess.projectPath,
			tabId: managedProcess.tabId,
		});

		state.activeTurnId = undefined;
		state.turnStartedEmitted = false;
		state.pendingInterrupt = false;
		state.currentTurnStartedAt = undefined;
	}

	private startTurn(managedProcess: ManagedProcess, inputMode: 'turn' | 'steer'): void {
		const state = managedProcess.claudeSdkState;
		if (!state) return;

		if (inputMode === 'turn') {
			this.prepareDemoCaptureForTurn(
				managedProcess,
				managedProcess.demoCaptureEnabled === true,
				managedProcess.demoCaptureContext
			);
			state.activeTurnId = `claude-turn-${state.nextTurnSequence++}`;
			state.turnStartedEmitted = false;
			state.currentTurnStartedAt = Date.now();
		}

		if (state.sdkSessionId && !state.turnStartedEmitted && state.activeTurnId) {
			this.emitTurnStarted(managedProcess);
		}
	}

	private emitTurnStarted(managedProcess: ManagedProcess): void {
		const state = managedProcess.claudeSdkState;
		if (!state?.sdkSessionId || !state.activeTurnId) return;

		state.turnStartedEmitted = true;
		this.emitConversationEvent(managedProcess, {
			type: 'turn_started',
			sessionId: managedProcess.sessionId,
			runtimeKind: managedProcess.conversationRuntime || 'live',
			timestamp: Date.now(),
			threadId: state.sdkSessionId,
			turnId: state.activeTurnId,
		});
	}

	private emitConversationEvent(managedProcess: ManagedProcess, event: ConversationEvent): void {
		this.emitter.emit('conversation-event', managedProcess.sessionId, event);
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
				logger.warn('[ClaudeSdkBridge] Failed to write demo turn context file', LOG_CONTEXT, {
					sessionId: managedProcess.sessionId,
					error: String(error),
				});
			});
		}
	}

	private finishProcess(managedProcess: ManagedProcess, code: number): void {
		const existing = this.processes.get(managedProcess.sessionId);
		if (!existing) return;

		if (managedProcess.claudeSdkState) {
			const pendingUserInput = managedProcess.claudeSdkState.pendingUserInput;
			if (pendingUserInput) {
				pendingUserInput.cleanup();
				pendingUserInput.resolve({ action: 'cancel' });
				managedProcess.claudeSdkState.pendingUserInput = undefined;
			}
			managedProcess.claudeSdkState.queryClosed = true;
			managedProcess.claudeSdkState.inputQueue?.close();
		}

		this.processes.delete(managedProcess.sessionId);
		this.emitter.emit('exit', managedProcess.sessionId, code);
	}
}
