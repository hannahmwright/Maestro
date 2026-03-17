export type ArtifactKind = 'image' | 'video' | 'other';

export type ArtifactStorageBackend = 'local';

export type DemoStatus =
	| 'requested'
	| 'started'
	| 'artifact_added'
	| 'verifying'
	| 'completed'
	| 'failed'
	| 'blocked'
	| 'legacy_unverified';

export type DemoVerificationStatus =
	| 'pending'
	| 'verified'
	| 'failed'
	| 'blocked'
	| 'legacy_unverified';

export type DemoFailureReason =
	| 'missing_artifacts'
	| 'invalid_turn'
	| 'invalid_token'
	| 'legacy_protocol_rejected'
	| 'wrong_target'
	| 'simulated_capture'
	| 'auth_blocked'
	| 'agent_exited'
	| 'provider_claim_without_demo'
	| 'blocked'
	| 'legacy_unverified'
	| 'unknown';

export type DemoCaptureSource = 'maestro_demo_cli' | 'legacy_stdout' | 'log_harvest';

export type DemoBrowserMode = 'standard' | 'chrome';

export const MAESTRO_DEMO_EVENT_PREFIX = '__MAESTRO_DEMO_EVENT__';

export function extractDemoEventOutput(text: string | null | undefined): string {
	if (!text) {
		return '';
	}

	return text
		.replace(/\r\n/g, '\n')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith(MAESTRO_DEMO_EVENT_PREFIX))
		.join('\n');
}

export interface DemoRequestedTarget {
	url?: string | null;
	domain?: string | null;
	description?: string | null;
}

export interface ArtifactRef {
	id: string;
	kind: ArtifactKind;
	mimeType: string;
	byteSize: number;
	createdAt: number;
	filename: string;
	width?: number | null;
	height?: number | null;
	durationMs?: number | null;
	derivedFromArtifactId?: string | null;
}

export interface DemoStep {
	id: string;
	demoId: string;
	orderIndex: number;
	title: string;
	description?: string | null;
	timestampMs?: number | null;
	actionType?: string | null;
	toolContext?: string | null;
	screenshotArtifact?: ArtifactRef | null;
}

export interface DemoCard {
	demoId: string;
	captureRunId: string;
	turnId?: string | null;
	provider?: string | null;
	model?: string | null;
	title: string;
	summary?: string | null;
	status: DemoStatus;
	verificationStatus: DemoVerificationStatus;
	failureReason?: DemoFailureReason | null;
	blockedReason?: string | null;
	captureSource: DemoCaptureSource;
	requestedTarget?: DemoRequestedTarget | null;
	observedUrl?: string | null;
	observedTitle?: string | null;
	isSimulated: boolean;
	authTargetReached?: boolean | null;
	requirementSatisfied: boolean;
	createdAt: number;
	updatedAt: number;
	stepCount: number;
	durationMs?: number | null;
	posterArtifact?: ArtifactRef | null;
	videoArtifact?: ArtifactRef | null;
}

export interface DemoDetail extends DemoCard {
	sessionId: string;
	tabId?: string | null;
	steps: DemoStep[];
}

export interface DemoCaptureRequest {
	enabled: boolean;
	browserMode?: DemoBrowserMode;
}

export interface DemoArtifactHarvestRequest {
	sessionId: string;
	tabId?: string | null;
	text: string;
	sourceLogId: string;
	projectRoots?: string[];
	demoCaptureRequested?: boolean;
	sshRemoteId?: string | null;
	sshRemoteHost?: string | null;
}

export interface DemoCaptureEvent {
	type:
		| 'capture_started'
		| 'artifact_created'
		| 'step_created'
		| 'capture_blocked'
		| 'capture_completed'
		| 'capture_failed';
	runId?: string;
	turnId?: string;
	turnToken?: string;
	provider?: string;
	model?: string;
	title?: string;
	summary?: string;
	description?: string;
	path?: string;
	artifactPath?: string;
	kind?: ArtifactKind;
	mimeType?: string;
	role?: 'poster' | 'video' | 'screenshot' | 'supporting';
	durationMs?: number;
	width?: number;
	height?: number;
	filename?: string;
	timestampMs?: number;
	orderIndex?: number;
	actionType?: string;
	toolContext?: string;
	captureSource?: DemoCaptureSource;
	verificationStatus?: DemoVerificationStatus;
	failureReason?: DemoFailureReason;
	requestedTarget?: DemoRequestedTarget | null;
	observedUrl?: string;
	observedTitle?: string;
	isSimulated?: boolean;
	authTargetReached?: boolean;
	blockedReason?: string;
}

export function demoCardHasArtifacts(
	demoCard: Pick<DemoCard, 'posterArtifact' | 'videoArtifact' | 'stepCount'>
): boolean {
	return Boolean(demoCard.posterArtifact || demoCard.videoArtifact || demoCard.stepCount > 0);
}

export function isCompletedDemoCapture(
	demoCard: Pick<
		DemoCard,
		'status' | 'posterArtifact' | 'videoArtifact' | 'stepCount' | 'requirementSatisfied'
	>
): boolean {
	return (
		demoCard.status === 'completed' &&
		demoCard.requirementSatisfied === true &&
		demoCardHasArtifacts(demoCard)
	);
}
