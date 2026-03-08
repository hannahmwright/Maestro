export type ArtifactKind = 'image' | 'video' | 'other';

export type ArtifactStorageBackend = 'local';

export type DemoStatus = 'capturing' | 'completed' | 'failed';

export const MAESTRO_DEMO_EVENT_PREFIX = '__MAESTRO_DEMO_EVENT__';

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
	title: string;
	summary?: string | null;
	status: DemoStatus;
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
}

export interface DemoCaptureEvent {
	type: 'capture_started' | 'artifact_created' | 'step_created' | 'capture_completed' | 'capture_failed';
	runId?: string;
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
}
