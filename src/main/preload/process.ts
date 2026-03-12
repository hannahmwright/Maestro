/**
 * Preload API for process management
 *
 * Provides the window.maestro.process namespace for:
 * - Spawning and managing agent/terminal processes
 * - Writing to processes
 * - Handling process events (data, exit, errors)
 * - Remote command execution from web interface
 * - SSH remote execution support
 */

import { ipcRenderer } from 'electron';
import type {
	PlannedFilePatch,
	ProposedFileEdit,
	TaskContract,
	TaskContractInput,
	CompletionDecision,
	ReviewFinding,
	TriageResult,
	EditPlan,
	TaskDiagnosticsSummary,
	DebugFixLoopResult,
} from '../core-upgrades/types';
import type {
	UserInputRequest,
	UserInputRequestId,
	UserInputResponse,
} from '../../shared/user-input-requests';
import type { DemoCard, DemoCaptureRequest } from '../../shared/demo-artifacts';

/**
 * Helper to log via the main process logger.
 * Uses 'debug' level for preload operations.
 */
const log = (message: string, data?: unknown) => {
	ipcRenderer.invoke('logger:log', 'debug', message, 'Preload', data);
};

/**
 * Configuration for spawning a process
 */
export interface ProcessConfig {
	sessionId: string;
	toolType: string;
	cwd: string;
	command: string;
	args: string[];
	prompt?: string;
	shell?: string;
	images?: string[]; // Base64 data URLs for images
	taskContractInput?: Partial<TaskContractInput>;
	// Agent-specific spawn options (used to build args via agent config)
	agentSessionId?: string; // For session resume (uses agent's resumeArgs builder)
	readOnlyMode?: boolean; // For read-only/plan mode (uses agent's readOnlyArgs)
	modelId?: string; // For model selection (uses agent's modelArgs builder)
	yoloMode?: boolean; // For YOLO/full-access mode (uses agent's yoloModeArgs)
	sessionReasoningEffort?: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
	demoCapture?: DemoCaptureRequest;
	// Stats tracking options
	querySource?: 'user' | 'auto'; // Whether this query is user-initiated or from Auto Run
	tabId?: string; // Tab ID for multi-tab tracking
}

/**
 * Response from spawning a process
 */
export interface ProcessSpawnResponse {
	pid: number;
	success: boolean;
	sshRemote?: { id: string; name: string; host: string };
}

/**
 * Configuration for running a single command
 */
export interface RunCommandConfig {
	sessionId: string;
	command: string;
	cwd: string;
	shell?: string;
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	// Optional strict task loop context. When present and core upgrades are enabled,
	// main process runs triage/review/gate lifecycle around this command.
	taskContractInput?: Partial<TaskContractInput>;
	proposedEdits?: ProposedFileEdit[];
	plannedPatches?: PlannedFilePatch[];
	relatedFiles?: string[];
	changedFiles?: string[];
	diffText?: string;
	fullSuiteCommand?: string;
}

export interface RunCommandResult {
	exitCode: number;
	stdout?: string;
	stderr?: string;
	durationMs?: number;
	taskResult?: DebugFixLoopResult;
	taskDiagnostics?: TaskDiagnosticsSummary;
	contextPack?: unknown;
}

/**
 * Active process information
 */
export interface ActiveProcess {
	sessionId: string;
	toolType: string;
	pid: number;
	cwd: string;
	isTerminal: boolean;
	isBatchMode: boolean;
	startTime: number;
	command?: string;
	args?: string[];
}

/**
 * Usage statistics from AI responses
 */
export interface UsageStats {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	totalCostUsd: number;
	contextWindow: number;
	reasoningTokens?: number; // Separate reasoning tokens (Codex o3/o4-mini)
}

/**
 * Agent error information
 */
export interface AgentError {
	type: string;
	message: string;
	recoverable: boolean;
	agentId: string;
	sessionId?: string;
	timestamp: number;
	raw?: {
		exitCode?: number;
		stderr?: string;
		stdout?: string;
		errorLine?: string;
	};
}

/**
 * Tool execution event
 */
export interface ToolExecutionEvent {
	toolName: string;
	state?: unknown;
	timestamp: number;
}

export interface AssistantStreamEvent {
	mode: 'append' | 'replace' | 'commit' | 'discard';
	text?: string;
}

/**
 * SSH remote info
 */
export interface SshRemoteInfo {
	id: string;
	name: string;
	host: string;
}

/**
 * Creates the process API object for preload exposure
 */
export function createProcessApi() {
	return {
		/**
		 * Spawn a new process (agent or terminal)
		 */
		spawn: (config: ProcessConfig): Promise<ProcessSpawnResponse> =>
			ipcRenderer.invoke('process:spawn', config),

		/**
		 * Write data to a process stdin
		 */
		write: (sessionId: string, data: string): Promise<boolean> =>
			ipcRenderer.invoke('process:write', sessionId, data),

		respondToUserInput: (
			sessionId: string,
			requestId: UserInputRequestId,
			response: UserInputResponse
		): Promise<boolean> =>
			ipcRenderer.invoke('process:respond-user-input', sessionId, requestId, response),

		/**
		 * Send interrupt signal (Ctrl+C) to a process
		 */
		interrupt: (sessionId: string): Promise<boolean> =>
			ipcRenderer.invoke('process:interrupt', sessionId),

		/**
		 * Kill a process
		 */
		kill: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('process:kill', sessionId),

		/**
		 * Resize process terminal
		 */
		resize: (sessionId: string, cols: number, rows: number): Promise<boolean> =>
			ipcRenderer.invoke('process:resize', sessionId, cols, rows),

		/**
		 * Run a single command and capture only stdout/stderr (no PTY echo/prompts)
		 * Supports SSH remote execution when sessionSshRemoteConfig is provided
		 */
		runCommand: (config: RunCommandConfig): Promise<RunCommandResult> =>
			ipcRenderer.invoke('process:runCommand', config),

		/**
		 * Create a validated task contract in the main process.
		 */
		createTaskContract: (input: TaskContractInput) =>
			ipcRenderer.invoke('process:createTaskContract', input),

		/**
		 * Get the task contract attached to a spawned process/session.
		 */
		getTaskContract: (sessionId: string): Promise<TaskContract | null> =>
			ipcRenderer.invoke('process:getTaskContract', sessionId),

		/**
		 * Get all active processes from ProcessManager
		 */
		getActiveProcesses: (): Promise<ActiveProcess[]> =>
			ipcRenderer.invoke('process:getActiveProcesses'),

		// Event listeners

		/**
		 * Subscribe to process data output
		 */
		onData: (callback: (sessionId: string, data: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, data: string) => callback(sessionId, data);
			ipcRenderer.on('process:data', handler);
			return () => ipcRenderer.removeListener('process:data', handler);
		},

		/**
		 * Subscribe to process exit events
		 */
		onExit: (callback: (sessionId: string, code: number) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, code: number) => callback(sessionId, code);
			ipcRenderer.on('process:exit', handler);
			return () => ipcRenderer.removeListener('process:exit', handler);
		},

		/**
		 * Subscribe to agent session ID events
		 */
		onSessionId: (callback: (sessionId: string, agentSessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, agentSessionId: string) =>
				callback(sessionId, agentSessionId);
			ipcRenderer.on('process:session-id', handler);
			return () => ipcRenderer.removeListener('process:session-id', handler);
		},

		onModel: (callback: (sessionId: string, model: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, model: string) => callback(sessionId, model);
			ipcRenderer.on('process:model', handler);
			return () => ipcRenderer.removeListener('process:model', handler);
		},

		/**
		 * Subscribe to slash commands discovered from agent
		 */
		onSlashCommands: (
			callback: (sessionId: string, slashCommands: string[]) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, slashCommands: string[]) =>
				callback(sessionId, slashCommands);
			ipcRenderer.on('process:slash-commands', handler);
			return () => ipcRenderer.removeListener('process:slash-commands', handler);
		},

		/**
		 * Subscribe to thinking/streaming content chunks from AI agents
		 * Emitted when agents produce partial text events (isPartial: true)
		 * Renderer decides whether to display based on tab's showThinking setting
		 */
		onThinkingChunk: (callback: (sessionId: string, content: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, content: string) =>
				callback(sessionId, content);
			ipcRenderer.on('process:thinking-chunk', handler);
			return () => ipcRenderer.removeListener('process:thinking-chunk', handler);
		},

		onAssistantStream: (
			callback: (sessionId: string, event: AssistantStreamEvent) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, event: AssistantStreamEvent) =>
				callback(sessionId, event);
			ipcRenderer.on('process:assistant-stream', handler);
			return () => ipcRenderer.removeListener('process:assistant-stream', handler);
		},

		/**
		 * Subscribe to tool execution events
		 */
		onToolExecution: (
			callback: (sessionId: string, toolEvent: ToolExecutionEvent) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, toolEvent: ToolExecutionEvent) =>
				callback(sessionId, toolEvent);
			ipcRenderer.on('process:tool-execution', handler);
			return () => ipcRenderer.removeListener('process:tool-execution', handler);
		},

		onUserInputRequest: (
			callback: (sessionId: string, request: UserInputRequest) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, request: UserInputRequest) =>
				callback(sessionId, request);
			ipcRenderer.on('process:user-input-request', handler);
			return () => ipcRenderer.removeListener('process:user-input-request', handler);
		},

		/**
		 * Subscribe to SSH remote execution status
		 * Emitted when a process starts executing via SSH on a remote host
		 */
		onSshRemote: (
			callback: (sessionId: string, sshRemote: SshRemoteInfo | null) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, sshRemote: SshRemoteInfo | null) =>
				callback(sessionId, sshRemote);
			ipcRenderer.on('process:ssh-remote', handler);
			return () => ipcRenderer.removeListener('process:ssh-remote', handler);
		},

		/**
		 * Subscribe to remote command execution from web interface
		 * This allows web commands to go through the same code path as desktop commands
		 * inputMode is optional - if provided, renderer should use it instead of session state
		 */
		onRemoteCommand: (
			callback: (
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				commandAction?: 'default' | 'queue',
				images?: string[],
				textAttachments?: Array<{
					id?: string;
					name: string;
					content: string;
					mimeType?: string;
					size?: number;
				}>,
				attachments?: Array<{
					id?: string;
					kind: 'image' | 'file';
					name: string;
					mimeType?: string;
					size?: number;
				}>,
				demoCapture?: DemoCaptureRequest
			) => void
		): (() => void) => {
			log('Registering onRemoteCommand listener');
			const handler = (
				_: unknown,
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				commandAction?: 'default' | 'queue',
				images?: string[],
				textAttachments?: Array<{
					id?: string;
					name: string;
					content: string;
					mimeType?: string;
					size?: number;
				}>,
				attachments?: Array<{
					id?: string;
					kind: 'image' | 'file';
					name: string;
					mimeType?: string;
					size?: number;
				}>,
				demoCapture?: DemoCaptureRequest
			) => {
				log('Received remote:executeCommand IPC', {
					sessionId,
					commandPreview: command?.substring(0, 50),
					inputMode,
					commandAction,
					imageCount: images?.length ?? 0,
					textAttachmentCount: textAttachments?.length ?? 0,
					demoCaptureEnabled: demoCapture?.enabled ?? false,
				});
				try {
					callback(
						sessionId,
						command,
						inputMode,
						commandAction,
						images,
						textAttachments,
						attachments,
						demoCapture
					);
				} catch (error) {
					ipcRenderer.invoke(
						'logger:log',
						'error',
						'Error invoking remote command callback',
						'Preload',
						{ error: String(error) }
					);
				}
			};
			ipcRenderer.on('remote:executeCommand', handler);
			return () => ipcRenderer.removeListener('remote:executeCommand', handler);
		},

		onDemoGenerated: (
			callback: (sessionId: string, tabId: string | null, demoCard: DemoCard) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, tabId: string | null, demoCard: DemoCard) =>
				callback(sessionId, tabId, demoCard);
			ipcRenderer.on('process:demo-generated', handler);
			return () => ipcRenderer.removeListener('process:demo-generated', handler);
		},

		/**
		 * Subscribe to remote mode switch from web interface
		 * Forwards to desktop's toggleInputMode logic
		 */
		onRemoteSwitchMode: (
			callback: (sessionId: string, mode: 'ai' | 'terminal') => void
		): (() => void) => {
			log('Registering onRemoteSwitchMode listener');
			const handler = (_: unknown, sessionId: string, mode: 'ai' | 'terminal') => {
				log('Received remote:switchMode IPC', { sessionId, mode });
				callback(sessionId, mode);
			};
			ipcRenderer.on('remote:switchMode', handler);
			return () => ipcRenderer.removeListener('remote:switchMode', handler);
		},

		/**
		 * Subscribe to remote interrupt from web interface
		 * Forwards to desktop's handleInterrupt logic
		 */
		onRemoteInterrupt: (callback: (sessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string) => callback(sessionId);
			ipcRenderer.on('remote:interrupt', handler);
			return () => ipcRenderer.removeListener('remote:interrupt', handler);
		},

		/**
		 * Subscribe to remote session selection from web interface
		 * Forwards to desktop's setActiveSessionId logic
		 * Optional tabId to also switch to a specific tab within the session
		 */
		onRemoteSelectSession: (
			callback: (sessionId: string, tabId?: string) => void
		): (() => void) => {
			log('Registering onRemoteSelectSession listener');
			const handler = (_: unknown, sessionId: string, tabId?: string) => {
				log('Received remote:selectSession IPC', { sessionId, tabId });
				callback(sessionId, tabId);
			};
			ipcRenderer.on('remote:selectSession', handler);
			return () => ipcRenderer.removeListener('remote:selectSession', handler);
		},

		/**
		 * Subscribe to remote tab selection from web interface
		 */
		onRemoteSelectTab: (callback: (sessionId: string, tabId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, tabId: string) => callback(sessionId, tabId);
			ipcRenderer.on('remote:selectTab', handler);
			return () => ipcRenderer.removeListener('remote:selectTab', handler);
		},

		onRemoteSetSessionModel: (
			callback: (sessionId: string, model: string | null) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, model: string | null) =>
				callback(sessionId, model);
			ipcRenderer.on('remote:setSessionModel', handler);
			return () => ipcRenderer.removeListener('remote:setSessionModel', handler);
		},

		/**
		 * Subscribe to remote new tab from web interface
		 */
		onRemoteNewTab: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) =>
				callback(sessionId, responseChannel);
			ipcRenderer.on('remote:newTab', handler);
			return () => ipcRenderer.removeListener('remote:newTab', handler);
		},

		/**
		 * Send response for remote new tab
		 */
		sendRemoteNewTabResponse: (responseChannel: string, result: { tabId: string } | null): void => {
			ipcRenderer.send(responseChannel, result);
		},

		onRemoteNewThread: (
			callback: (
				sessionId: string,
				options: { toolType?: string; model?: string | null },
				responseChannel: string
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				options: { toolType?: string; model?: string | null } | string,
				responseChannel?: string
			) => {
				if (typeof options === 'string') {
					callback(sessionId, {}, options);
					return;
				}
				callback(sessionId, options || {}, responseChannel || '');
			};
			ipcRenderer.on('remote:newThread', handler);
			return () => ipcRenderer.removeListener('remote:newThread', handler);
		},

		sendRemoteNewThreadResponse: (
			responseChannel: string,
			result: { success: boolean; sessionId?: string | null } | boolean
		): void => {
			ipcRenderer.send(responseChannel, result);
		},

		onRemoteDeleteSession: (
			callback: (sessionId: string, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, responseChannel: string) =>
				callback(sessionId, responseChannel);
			ipcRenderer.on('remote:deleteSession', handler);
			return () => ipcRenderer.removeListener('remote:deleteSession', handler);
		},

		sendRemoteDeleteSessionResponse: (responseChannel: string, success: boolean): void => {
			ipcRenderer.send(responseChannel, success);
		},

		/**
		 * Subscribe to remote close tab from web interface
		 */
		onRemoteCloseTab: (callback: (sessionId: string, tabId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, tabId: string) => callback(sessionId, tabId);
			ipcRenderer.on('remote:closeTab', handler);
			return () => ipcRenderer.removeListener('remote:closeTab', handler);
		},

		/**
		 * Subscribe to remote rename tab from web interface
		 */
		onRemoteRenameTab: (
			callback: (sessionId: string, tabId: string, newName: string) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, tabId: string, newName: string) =>
				callback(sessionId, tabId, newName);
			ipcRenderer.on('remote:renameTab', handler);
			return () => ipcRenderer.removeListener('remote:renameTab', handler);
		},

		/**
		 * Subscribe to remote star tab from web interface
		 */
		onRemoteStarTab: (
			callback: (sessionId: string, tabId: string, starred: boolean) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, tabId: string, starred: boolean) =>
				callback(sessionId, tabId, starred);
			ipcRenderer.on('remote:starTab', handler);
			return () => ipcRenderer.removeListener('remote:starTab', handler);
		},

		/**
		 * Subscribe to remote reorder tab from web interface
		 */
		onRemoteReorderTab: (
			callback: (sessionId: string, fromIndex: number, toIndex: number) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, fromIndex: number, toIndex: number) =>
				callback(sessionId, fromIndex, toIndex);
			ipcRenderer.on('remote:reorderTab', handler);
			return () => ipcRenderer.removeListener('remote:reorderTab', handler);
		},

		/**
		 * Subscribe to remote bookmark toggle from web interface
		 */
		onRemoteToggleBookmark: (callback: (sessionId: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string) => callback(sessionId);
			ipcRenderer.on('remote:toggleBookmark', handler);
			return () => ipcRenderer.removeListener('remote:toggleBookmark', handler);
		},

		/**
		 * Subscribe to stderr from runCommand (separate stream)
		 */
		onStderr: (callback: (sessionId: string, data: string) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, data: string) => callback(sessionId, data);
			ipcRenderer.on('process:stderr', handler);
			return () => ipcRenderer.removeListener('process:stderr', handler);
		},

		/**
		 * Subscribe to command exit from runCommand (separate from PTY exit)
		 */
		onCommandExit: (callback: (sessionId: string, code: number) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, code: number) => callback(sessionId, code);
			ipcRenderer.on('process:command-exit', handler);
			return () => ipcRenderer.removeListener('process:command-exit', handler);
		},

		onTaskTriageStarted: (
			callback: (
				sessionId: string,
				event: { type: 'triage-started'; attempt: number; signal_excerpt: string }
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				event: { type: 'triage-started'; attempt: number; signal_excerpt: string }
			) => callback(sessionId, event);
			ipcRenderer.on('task:triage-started', handler);
			return () => ipcRenderer.removeListener('task:triage-started', handler);
		},

		onTaskHypothesisGenerated: (
			callback: (
				sessionId: string,
				event: { type: 'hypothesis-generated'; attempt: number; triage: TriageResult }
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				event: { type: 'hypothesis-generated'; attempt: number; triage: TriageResult }
			) => callback(sessionId, event);
			ipcRenderer.on('task:hypothesis-generated', handler);
			return () => ipcRenderer.removeListener('task:hypothesis-generated', handler);
		},

		onTaskEditPlanApplied: (
			callback: (
				sessionId: string,
				event: { type: 'edit-plan-applied'; attempt: number; edit_plan: EditPlan }
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				event: { type: 'edit-plan-applied'; attempt: number; edit_plan: EditPlan }
			) => callback(sessionId, event);
			ipcRenderer.on('task:edit-plan-applied', handler);
			return () => ipcRenderer.removeListener('task:edit-plan-applied', handler);
		},

		onTaskReviewFindings: (
			callback: (
				sessionId: string,
				event: { type: 'review-findings'; attempt: number; findings: ReviewFinding[] }
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				event: { type: 'review-findings'; attempt: number; findings: ReviewFinding[] }
			) => callback(sessionId, event);
			ipcRenderer.on('task:review-findings', handler);
			return () => ipcRenderer.removeListener('task:review-findings', handler);
		},

		onTaskGateResult: (
			callback: (
				sessionId: string,
				event: { type: 'gate-result'; attempt: number; decision: CompletionDecision }
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				sessionId: string,
				event: { type: 'gate-result'; attempt: number; decision: CompletionDecision }
			) => callback(sessionId, event);
			ipcRenderer.on('task:gate-result', handler);
			return () => ipcRenderer.removeListener('task:gate-result', handler);
		},

		onTaskStatus: (
			callback: (sessionId: string, status: TaskDiagnosticsSummary) => void
		): (() => void) => {
			const handler = (_: unknown, sessionId: string, status: TaskDiagnosticsSummary) =>
				callback(sessionId, status);
			ipcRenderer.on('task:status', handler);
			return () => ipcRenderer.removeListener('task:status', handler);
		},

		/**
		 * Subscribe to usage statistics from AI responses
		 */
		onUsage: (callback: (sessionId: string, usageStats: UsageStats) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, usageStats: UsageStats) =>
				callback(sessionId, usageStats);
			ipcRenderer.on('process:usage', handler);
			return () => ipcRenderer.removeListener('process:usage', handler);
		},

		/**
		 * Subscribe to agent error events (auth expired, token exhaustion, rate limits, etc.)
		 */
		onAgentError: (callback: (sessionId: string, error: AgentError) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, error: AgentError) =>
				callback(sessionId, error);
			ipcRenderer.on('agent:error', handler);
			return () => ipcRenderer.removeListener('agent:error', handler);
		},
	};
}

/**
 * TypeScript type for the process API
 */
export type ProcessApi = ReturnType<typeof createProcessApi>;
