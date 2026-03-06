export const WEB_APP_BASE_PATH = '/app';
export const WEB_APP_API_BASE_PATH = `${WEB_APP_BASE_PATH}/api`;
export const WEB_APP_WS_PATH = `${WEB_APP_BASE_PATH}/ws`;
export const WEB_APP_MANIFEST_PATH = `${WEB_APP_BASE_PATH}/manifest.json`;
export const WEB_APP_SERVICE_WORKER_PATH = `${WEB_APP_BASE_PATH}/sw.js`;
export const WEB_APP_ICONS_PATH = `${WEB_APP_BASE_PATH}/icons`;
export const WEB_APP_ASSETS_PATH = `${WEB_APP_BASE_PATH}/assets`;

export type WebAuthMode = 'cloudflare-access' | 'app-auth' | 'none';

export interface MaestroWebPushConfig {
	enabled: boolean;
	publicKey?: string;
}

export interface MaestroWebConfig {
	basePath: string;
	sessionId: string | null;
	tabId: string | null;
	apiBase: string;
	wsUrl: string;
	authMode: WebAuthMode;
	clientInstanceId: string;
	webPush: MaestroWebPushConfig;
}

export interface ResponseCompletedEvent {
	eventId: string;
	sessionId: string;
	tabId: string | null;
	sessionName: string;
	toolType: string;
	completedAt: number;
	title: string;
	body: string;
	deepLinkUrl: string;
}

export interface WebRemoteToolState {
	id?: string;
	status?: 'running' | 'completed' | 'error' | 'success' | 'failed' | string;
	input?: unknown;
	output?: unknown;
	[key: string]: unknown;
}

export interface WebRemoteLogEntry {
	id?: string;
	timestamp: number;
	text?: string;
	content?: string;
	source?: 'stdout' | 'stderr' | 'system' | 'user' | 'ai' | 'error' | 'thinking' | 'tool';
	type?: string;
	metadata?: {
		toolState?: WebRemoteToolState;
	};
}

export interface WebSessionLogEntryEvent {
	sessionId: string;
	tabId: string | null;
	inputMode: 'ai' | 'terminal';
	logEntry: WebRemoteLogEntry;
}

export interface WebPushSubscriptionInput {
	endpoint: string;
	expirationTime?: number | null;
	keys: {
		p256dh: string;
		auth: string;
	};
}

export interface PushSubscriptionRecord {
	id: string;
	endpoint: string;
	keys: {
		p256dh: string;
		auth: string;
	};
	userAgent?: string;
	deviceLabel?: string;
	createdAt: number;
	lastSeenAt: number;
	enabled: boolean;
}

export interface PushStatusResponse {
	enabled: boolean;
	subscribed: boolean;
	publicKey?: string;
}

export interface WebPushTestRequest {
	endpoint?: string;
}

export interface WebVoiceTranscriptionRequest {
	audioBase64: string;
	mimeType: string;
	language?: string | null;
}

export interface WebVoiceTranscriptionResponse {
	text: string;
	language?: string | null;
	backend: 'local-faster-whisper';
	durationMs: number;
}

export interface WebVoiceTranscriptionStatusResponse {
	available: boolean;
	ready: boolean;
	warming: boolean;
	backend: 'local-faster-whisper';
	error?: string | null;
}
