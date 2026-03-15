import type {
	ArtifactKind,
	ArtifactStorageBackend,
	DemoCaptureSource,
	DemoCaptureEvent,
	DemoFailureReason,
	DemoRequestedTarget,
	DemoStatus,
	DemoVerificationStatus,
} from '../../shared/demo-artifacts';

export interface CaptureRunRecord {
	id: string;
	sessionId: string;
	tabId: string | null;
	externalRunId: string | null;
	turnId: string | null;
	turnToken: string | null;
	status: DemoStatus;
	verificationStatus: DemoVerificationStatus;
	failureReason: DemoFailureReason | null;
	blockedReason: string | null;
	captureSource: DemoCaptureSource;
	provider: string | null;
	model: string | null;
	requestedTarget: DemoRequestedTarget | null;
	observedUrl: string | null;
	observedTitle: string | null;
	isSimulated: boolean;
	authTargetReached: boolean | null;
	requirementSatisfied: boolean;
	title: string | null;
	summary: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ArtifactRecord {
	id: string;
	sessionId: string;
	tabId: string | null;
	captureRunId: string;
	kind: ArtifactKind;
	mimeType: string;
	byteSize: number;
	sha256: string;
	filename: string;
	storageBackend: ArtifactStorageBackend;
	createdAt: number;
	updatedAt: number;
	width: number | null;
	height: number | null;
	durationMs: number | null;
	originalPath: string | null;
	storedPath: string;
	derivedFromArtifactId: string | null;
}

export interface DemoRecord {
	id: string;
	sessionId: string;
	tabId: string | null;
	captureRunId: string;
	status: DemoStatus;
	title: string;
	summary: string | null;
	posterArtifactId: string | null;
	videoArtifactId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface DemoStepRecord {
	id: string;
	demoId: string;
	orderIndex: number;
	title: string;
	description: string | null;
	timestampMs: number | null;
	screenshotArtifactId: string | null;
	actionType: string | null;
	toolContext: string | null;
	createdAt: number;
}

export interface DemoCaptureContext {
	sessionId: string;
	tabId?: string | null;
	sshRemoteId?: string | null;
	sshRemoteHost?: string | null;
}

export interface DemoCaptureResult {
	demoId: string;
}

export interface DemoCaptureEventInput {
	context: DemoCaptureContext;
	event: DemoCaptureEvent;
}

export interface DemoTurnContextRecord {
	sessionId: string;
	tabId: string | null;
	captureRunId: string;
	externalRunId: string;
	turnId: string;
	turnToken: string;
	provider: string | null;
	model: string | null;
	requestedTarget: DemoRequestedTarget | null;
	contextFilePath: string;
	stateFilePath: string;
	outputDir: string;
}
