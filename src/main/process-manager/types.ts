import type { ChildProcess } from 'child_process';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import type { AgentOutputParser } from '../parsers';
import type { AgentError } from '../../shared/types';
import type {
	UserInputRequest,
	UserInputRequestId,
	UserInputResponse,
} from '../../shared/user-input-requests';
import type { DemoCaptureRequest } from '../../shared/demo-artifacts';
import type { ConversationEvent, ConversationRuntimeKind } from '../../shared/conversation';
import type {
	TaskContract,
	TaskContractInput,
	TaskLifecycleEvent,
	TaskDiagnosticsSummary,
} from '../core-upgrades/types';

/**
 * Configuration for spawning a new process
 */
export interface ProcessConfig {
	sessionId: string;
	toolType: string;
	cwd: string;
	command: string;
	args: string[];
	agentSessionId?: string;
	requiresPty?: boolean;
	prompt?: string;
	shell?: string;
	shellArgs?: string;
	shellEnvVars?: Record<string, string>;
	images?: string[];
	imageArgs?: (imagePath: string) => string[];
	promptArgs?: (prompt: string) => string[];
	contextWindow?: number;
	readOnlyMode?: boolean;
	customEnvVars?: Record<string, string>;
	noPromptSeparator?: boolean;
	sshRemoteId?: string;
	sshRemoteHost?: string;
	querySource?: 'user' | 'auto';
	tabId?: string;
	projectPath?: string;
	/** If true, always spawn in a shell (for PATH resolution on Windows) */
	runInShell?: boolean;
	/** If true, send the prompt via stdin as JSON instead of command line */
	sendPromptViaStdin?: boolean;
	/** If true, send the prompt via stdin as raw text instead of command line */
	sendPromptViaStdinRaw?: boolean;
	/** Script to send via stdin for SSH execution (bypasses shell escaping) */
	sshStdinScript?: string;
	/** Optional Task Contract seed passed at session start (renderer/main orchestration). */
	taskContractInput?: Partial<TaskContractInput>;
	/** Fully-resolved Task Contract attached to this session/process. */
	taskContract?: TaskContract;
	/** Resolved model seed for runtime UI state. */
	resolvedModel?: string;
	sessionReasoningEffort?: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
	demoCapture?: DemoCaptureRequest;
	conversationRuntime?: ConversationRuntimeKind;
}

export interface CodexAppServerState {
	wsUrl?: string;
	ws?: WebSocket;
	nextClientRequestId: number;
	threadId?: string;
	turnId?: string;
	currentTurnStartedAt?: number;
	lastActivityAt?: number;
	pendingUserInputRequest?: UserInputRequest;
	pendingUserInputResponse?: UserInputResponse;
	agentMessagePhases: Map<string, string>;
	currentTurnHadUserInputRequest?: boolean;
	currentTurnCorrectionCount?: number;
	pendingCorrectionPrompt?: string;
	suppressedFinalAnswerText?: string;
	startupTimeout?: NodeJS.Timeout;
	turnActivityTimeout?: NodeJS.Timeout;
	turnCompleted?: boolean;
	pendingRequests?: Map<string, { type: 'steer' | 'interrupt' }>;
}

export interface ClaudeSdkState {
	query?: unknown;
	inputQueue?: {
		push: (message: any) => boolean;
		close: () => void;
	};
	sdkSessionId?: string;
	activeTurnId?: string;
	nextTurnSequence: number;
	pendingInterrupt?: boolean;
	currentTurnStartedAt?: number;
	runtimeReady?: boolean;
	turnStartedEmitted?: boolean;
	queryClosed?: boolean;
	pendingUserInput?:
		| {
				requestId: UserInputRequestId;
				resolve: (result: unknown) => void;
				cleanup: () => void;
				mode: 'form' | 'url';
				requestedSchema?: Record<string, unknown>;
		  }
		| undefined;
}

/**
 * Internal representation of a managed process
 */
export interface ManagedProcess {
	sessionId: string;
	toolType: string;
	ptyProcess?: IPty;
	childProcess?: ChildProcess;
	cwd: string;
	pid: number;
	isTerminal: boolean;
	isBatchMode?: boolean;
	isStreamJsonMode?: boolean;
	jsonBuffer?: string;
	lastCommand?: string;
	sessionIdEmitted?: boolean;
	resultEmitted?: boolean;
	errorEmitted?: boolean;
	startTime: number;
	outputParser?: AgentOutputParser;
	stderrBuffer?: string;
	stdoutBuffer?: string;
	streamedText?: string;
	contextWindow?: number;
	tempImageFiles?: string[];
	command?: string;
	args?: string[];
	lastUsageTotals?: UsageTotals;
	usageIsCumulative?: boolean;
	querySource?: 'user' | 'auto';
	tabId?: string;
	projectPath?: string;
	sshRemoteId?: string;
	sshRemoteHost?: string;
	currentModel?: string;
	dataBuffer?: string;
	dataBufferTimeout?: NodeJS.Timeout;
	taskContract?: TaskContract;
	codexAppServerState?: CodexAppServerState;
	claudeSdkState?: ClaudeSdkState;
	conversationRuntime?: ConversationRuntimeKind;
	demoCaptureEnabled?: boolean;
	demoCaptureFinalized?: boolean;
	demoCaptureArtifactSeen?: boolean;
	demoCaptureFailed?: boolean;
}

export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	reasoningTokens: number;
}

export interface UsageStats {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	totalCostUsd: number;
	contextWindow: number;
	reasoningTokens?: number;
}

export interface SpawnResult {
	pid: number;
	success: boolean;
}

export interface CommandResult {
	exitCode: number;
	stdout?: string;
	stderr?: string;
	durationMs?: number;
}

/**
 * Events emitted by ProcessManager
 */
export interface ProcessManagerEvents {
	data: (sessionId: string, data: string) => void;
	stderr: (sessionId: string, data: string) => void;
	exit: (sessionId: string, code: number) => void;
	'command-exit': (sessionId: string, code: number) => void;
	usage: (sessionId: string, stats: UsageStats) => void;
	'session-id': (sessionId: string, agentSessionId: string) => void;
	model: (sessionId: string, model: string) => void;
	'agent-error': (sessionId: string, error: AgentError) => void;
	'thinking-chunk': (sessionId: string, text: string) => void;
	'assistant-stream': (sessionId: string, event: AssistantStreamEvent) => void;
	'tool-execution': (sessionId: string, tool: ToolExecution) => void;
	'slash-commands': (sessionId: string, commands: unknown[]) => void;
	'query-complete': (sessionId: string, data: QueryCompleteData) => void;
	'task-lifecycle': (sessionId: string, event: TaskLifecycleEvent) => void;
	'task-status': (sessionId: string, status: TaskDiagnosticsSummary) => void;
	'user-input-request': (sessionId: string, request: UserInputRequest) => void;
	'conversation-event': (sessionId: string, event: ConversationEvent) => void;
}

export interface ToolExecution {
	toolName: string;
	state: unknown;
	timestamp: number;
}

export interface AssistantStreamEvent {
	mode: 'append' | 'replace' | 'commit' | 'discard';
	text?: string;
}

export interface QueryCompleteData {
	sessionId: string;
	agentType: string;
	source: 'user' | 'auto';
	startTime: number;
	duration: number;
	projectPath?: string;
	tabId?: string;
}

// Re-export for backwards compatibility
export type { ParsedEvent, AgentOutputParser } from '../parsers';
export type { AgentError, AgentErrorType, SshRemoteConfig } from '../../shared/types';
