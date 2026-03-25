import { EventEmitter } from 'events';
import type { AgentDetector } from '../agents';
import type { ProcessManager } from '../process-manager';
import type { SpawnDispatchRequest } from '../process-manager/dispatchSpawn';
import type {
	ConversationCapabilities,
	ConversationDispatchResult,
	ConversationEvent,
	ConversationSteerRequest,
	ConversationTurnRequest,
} from '../../shared/conversation';
import type { UserInputRequestId, UserInputResponse } from '../../shared/user-input-requests';

const CLAUDE_AUTH_FAILURE_TTL_MS = 60_000;

interface ConversationManagerDependencies {
	processManager: ProcessManager;
	agentDetector: AgentDetector;
	dispatchSpawn: (
		request: SpawnDispatchRequest,
		options?: {
			spawnConfigOverrides?: { conversationRuntime?: 'batch' | 'live' };
			spawnStrategy?: (context: {
				processManager: ProcessManager;
				spawnConfig: any;
				sshRemoteUsed: any;
			}) => { pid: number; success: boolean };
		}
	) => Promise<{ pid: number; success: boolean }>;
}

let claudeSdkImportPromise: Promise<boolean> | null = null;

function canLoadClaudeAgentSdk(): Promise<boolean> {
	if (!claudeSdkImportPromise) {
		claudeSdkImportPromise = import('@anthropic-ai/claude-agent-sdk')
			.then(() => true)
			.catch(() => false);
	}
	return claudeSdkImportPromise;
}

export class ConversationManager extends EventEmitter {
	private claudeAuthFailure:
		| {
				message: string;
				expiresAt: number;
		  }
		| null = null;

	constructor(private deps: ConversationManagerDependencies) {
		super();

		this.deps.processManager.on('conversation-event', (sessionId: string, event: ConversationEvent) => {
			const process = this.deps.processManager.get(sessionId);
			if (
				process?.toolType === 'claude-code' &&
				process.conversationRuntime === 'live' &&
				event.type === 'runtime_ready'
			) {
				this.claudeAuthFailure = null;
			}
			this.emit('conversation-event', sessionId, event);
		});
		this.deps.processManager.on('agent-error', (sessionId: string, error) => {
			const process = this.deps.processManager.get(sessionId);
			if (
				process?.toolType === 'claude-code' &&
				process.conversationRuntime === 'live' &&
				error.type === 'auth_expired'
			) {
				this.claudeAuthFailure = {
					message:
						error.message ||
						'Claude live runtime is unavailable until Claude Code is re-authenticated.',
					expiresAt: Date.now() + CLAUDE_AUTH_FAILURE_TTL_MS,
				};
			}
		});
	}

	private async getClaudeLiveCapabilities(): Promise<ConversationCapabilities> {
		if (this.claudeAuthFailure) {
			if (Date.now() < this.claudeAuthFailure.expiresAt) {
				return {
					supportsLiveRuntime: false,
					supportsTrueSteer: false,
					supportsQueueWhileBusy: true,
					supportsLiveRuntimeOverSsh: false,
					defaultRuntimeKind: 'batch',
					steerMode: 'interrupt-fallback',
					fallbackReason: this.claudeAuthFailure.message,
				};
			}
			this.claudeAuthFailure = null;
		}

		const agent = await this.deps.agentDetector.getAgent('claude-code');
		if (!agent?.available) {
			return {
				supportsLiveRuntime: false,
				supportsTrueSteer: false,
				supportsQueueWhileBusy: true,
				supportsLiveRuntimeOverSsh: false,
				defaultRuntimeKind: 'batch',
				steerMode: 'interrupt-fallback',
				fallbackReason: 'Claude live runtime is unavailable because the Claude Code CLI was not detected locally.',
			};
		}

		const sdkAvailable = await canLoadClaudeAgentSdk();
		if (!sdkAvailable) {
			return {
				supportsLiveRuntime: false,
				supportsTrueSteer: false,
				supportsQueueWhileBusy: true,
				supportsLiveRuntimeOverSsh: false,
				defaultRuntimeKind: 'batch',
				steerMode: 'interrupt-fallback',
				fallbackReason:
					'Claude live runtime is unavailable because the Anthropic Agent SDK could not be loaded.',
			};
		}

		return {
			supportsLiveRuntime: true,
			supportsTrueSteer: true,
			supportsQueueWhileBusy: true,
			supportsLiveRuntimeOverSsh: false,
			defaultRuntimeKind: 'live',
			steerMode: 'true-steer',
			fallbackReason: null,
		};
	}

	async getCapabilities(request: {
		toolType: string;
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
		};
		querySource?: 'user' | 'auto';
		preferLiveRuntime?: boolean;
	}): Promise<ConversationCapabilities> {
		if (!request || !request.toolType) {
			return {
				supportsLiveRuntime: false,
				supportsTrueSteer: false,
				supportsQueueWhileBusy: false,
				supportsLiveRuntimeOverSsh: false,
				defaultRuntimeKind: 'batch',
				steerMode: 'none',
				fallbackReason: 'Conversation request was missing required provider metadata.',
			};
		}

		const isSsh = request.sessionSshRemoteConfig?.enabled === true;
		const isInteractiveUserTurn = request.querySource !== 'auto';
		const prefersLiveRuntime = request.preferLiveRuntime === true;

		if (request.toolType === 'codex' && !isSsh && (isInteractiveUserTurn || prefersLiveRuntime)) {
			return {
				supportsLiveRuntime: true,
				supportsTrueSteer: true,
				supportsQueueWhileBusy: true,
				supportsLiveRuntimeOverSsh: false,
				defaultRuntimeKind: 'live',
				steerMode: 'true-steer',
				fallbackReason: null,
			};
		}

		if (request.toolType === 'claude-code' && !isSsh && (isInteractiveUserTurn || prefersLiveRuntime)) {
			return this.getClaudeLiveCapabilities();
		}

		const supportsQueueWhileBusy = request.toolType !== 'terminal';
		return {
			supportsLiveRuntime: false,
			supportsTrueSteer: false,
			supportsQueueWhileBusy,
			supportsLiveRuntimeOverSsh: false,
			defaultRuntimeKind: 'batch',
			steerMode: request.toolType === 'terminal' ? 'none' : 'interrupt-fallback',
			fallbackReason: isSsh ? 'Live runtime is disabled for SSH sessions.' : null,
		};
	}

	async sendTurn(request: ConversationTurnRequest): Promise<ConversationDispatchResult> {
		if (!request || !request.sessionId || !request.toolType || !request.cwd) {
			const missingFields = [
				!request ? 'request' : null,
				request && !request.sessionId ? 'sessionId' : null,
				request && !request.toolType ? 'toolType' : null,
				request && !request.cwd ? 'cwd' : null,
			].filter(Boolean);
			throw new Error(
				`Conversation turn request is missing required session metadata (${missingFields.join(', ')}).`
			);
		}

		const capabilities = await this.getCapabilities(request);
		const runtimeKind = capabilities.defaultRuntimeKind;
		const result = await this.deps.dispatchSpawn(request, {
			spawnConfigOverrides: {
				conversationRuntime: runtimeKind,
			},
			...(runtimeKind === 'live' && request.toolType === 'codex'
				? {
						spawnStrategy: ({ processManager, spawnConfig }) =>
							processManager.sendCodexLiveTurn(spawnConfig),
					}
				: {}),
			...(runtimeKind === 'live' && request.toolType === 'claude-code'
				? {
						spawnStrategy: ({ processManager, spawnConfig }) =>
							processManager.sendClaudeLiveTurn(spawnConfig),
					}
				: {}),
		});

		return {
			success: result.success,
			pid: result.pid,
			runtimeKind,
			steerMode: capabilities.steerMode,
			reason: capabilities.fallbackReason ?? null,
		};
	}

	async steerTurn(request: ConversationSteerRequest): Promise<ConversationDispatchResult> {
		if (!request || !request.sessionId || !request.toolType) {
			return {
				success: false,
				runtimeKind: 'batch',
				steerMode: 'none',
				reason: 'Conversation steer request is missing required session metadata.',
			};
		}

		const capabilities = await this.getCapabilities({
			toolType: request.toolType,
			querySource: 'user',
		});

		if (capabilities.supportsTrueSteer && request.toolType === 'codex') {
			const success = this.deps.processManager.steerCodexLiveTurn(request.sessionId, {
				text: request.text,
				images: request.images,
			});
			return {
				success,
				runtimeKind: 'live',
				steerMode: 'true-steer',
				reason: success ? null : 'No active live turn is available to steer.',
			};
		}

		if (capabilities.supportsTrueSteer && request.toolType === 'claude-code') {
			const success = this.deps.processManager.steerClaudeLiveTurn(request.sessionId, {
				text: request.text,
				images: request.images,
			});
			return {
				success,
				runtimeKind: 'live',
				steerMode: 'true-steer',
				reason: success ? null : 'No active live turn is available to steer.',
			};
		}

		return {
			success: false,
			runtimeKind: 'batch',
			steerMode: capabilities.steerMode,
			fallbackApplied: true,
			reason: capabilities.fallbackReason ?? 'True steer is unavailable for this provider.',
		};
	}

	interruptTurn(sessionId: string, toolType: string): boolean {
		if (toolType === 'codex') {
			return (
				this.deps.processManager.interruptCodexLiveTurn(sessionId) ||
				this.deps.processManager.interrupt(sessionId)
			);
		}
		if (toolType === 'claude-code') {
			return (
				this.deps.processManager.interruptClaudeLiveTurn(sessionId) ||
				this.deps.processManager.interrupt(sessionId)
			);
		}
		return this.deps.processManager.interrupt(sessionId);
	}

	respondToUserInput(
		sessionId: string,
		requestId: UserInputRequestId,
		response: UserInputResponse
	): Promise<boolean> {
		return Promise.resolve(
			this.deps.processManager.respondToUserInput(sessionId, requestId, response)
		);
	}
}
