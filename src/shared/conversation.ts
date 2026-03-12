export type ConversationRuntimeKind = 'batch' | 'live';

export type ConversationSteerMode = 'true-steer' | 'interrupt-fallback' | 'none';

export type ConversationInteractionKind = 'turn' | 'steer' | 'queued';

export type ConversationDeliveryState = 'pending' | 'delivered' | 'fallback_interrupt' | 'canceled';

export type ConversationSteerStatus = 'idle' | ConversationDeliveryState;

export interface PendingSteerState {
	logEntryId: string;
	text: string;
	images?: string[];
	submittedAt: number;
	deliveryState: ConversationDeliveryState;
}

export interface ConversationRuntimeState {
	runtimeKind: ConversationRuntimeKind;
	steerMode: ConversationSteerMode;
	activeTurnId?: string | null;
	pendingSteer?: PendingSteerState | null;
	steerStatus?: ConversationSteerStatus;
	lastCheckpointAt?: number | null;
}

export interface ConversationCapabilities {
	supportsLiveRuntime: boolean;
	supportsTrueSteer: boolean;
	supportsQueueWhileBusy: boolean;
	supportsLiveRuntimeOverSsh: boolean;
	defaultRuntimeKind: ConversationRuntimeKind;
	steerMode: ConversationSteerMode;
	fallbackReason?: string | null;
}

export interface ConversationInputItem {
	type: 'text' | 'image';
	text?: string;
	url?: string;
}

export interface ConversationTurnRequest {
	sessionId: string;
	toolType: string;
	cwd: string;
	command: string;
	args: string[];
	prompt?: string;
	images?: string[];
	agentSessionId?: string;
	readOnlyMode?: boolean;
	modelId?: string;
	yoloMode?: boolean;
	sessionCustomPath?: string;
	sessionCustomArgs?: string;
	sessionCustomEnvVars?: Record<string, string>;
	sessionCustomModel?: string;
	sessionCustomContextWindow?: number;
	sessionReasoningEffort?: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
	querySource?: 'user' | 'auto';
	tabId?: string;
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	demoCapture?: {
		enabled: boolean;
	};
}

export interface ConversationSteerRequest {
	sessionId: string;
	toolType: string;
	text?: string;
	images?: string[];
}

export interface ConversationDispatchResult {
	success: boolean;
	pid?: number;
	runtimeKind: ConversationRuntimeKind;
	steerMode: ConversationSteerMode;
	fallbackApplied?: boolean;
	reason?: string | null;
}

export interface ConversationEventBase {
	sessionId: string;
	timestamp: number;
	runtimeKind: ConversationRuntimeKind;
}

export interface ConversationRuntimeReadyEvent extends ConversationEventBase {
	type: 'runtime_ready';
	threadId: string;
}

export interface ConversationTurnStartedEvent extends ConversationEventBase {
	type: 'turn_started';
	threadId: string;
	turnId: string;
}

export interface ConversationTurnCompletedEvent extends ConversationEventBase {
	type: 'turn_completed';
	threadId?: string;
	turnId?: string | null;
	status: 'completed' | 'interrupted' | 'failed';
}

export interface ConversationTurnFailedEvent extends ConversationEventBase {
	type: 'turn_failed';
	threadId?: string;
	turnId?: string | null;
	message: string;
}

export interface ConversationSteerAcceptedEvent extends ConversationEventBase {
	type: 'steer_accepted';
	threadId: string;
	turnId: string;
}

export interface ConversationSteerRejectedEvent extends ConversationEventBase {
	type: 'steer_rejected';
	threadId?: string;
	turnId?: string | null;
	message: string;
}

export type ConversationEvent =
	| ConversationRuntimeReadyEvent
	| ConversationTurnStartedEvent
	| ConversationTurnCompletedEvent
	| ConversationTurnFailedEvent
	| ConversationSteerAcceptedEvent
	| ConversationSteerRejectedEvent;
