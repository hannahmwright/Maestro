/**
 * Maestro Web Config
 *
 * Configuration injected by the server into window.__MAESTRO_CONFIG__
 * This tells the React app about the stable route base and current context.
 */
import { webLogger } from './logger';
import {
	WEB_APP_API_BASE_PATH,
	WEB_APP_BASE_PATH,
	WEB_APP_WS_PATH,
	type MaestroWebConfig,
} from '../../shared/remote-web';

/**
 * Configuration injected by the server
 */
export type MaestroConfig = MaestroWebConfig;

// Extend Window interface
declare global {
	interface Window {
		__MAESTRO_CONFIG__?: MaestroConfig;
	}
}

/**
 * Get the Maestro config from window
 * Returns default values if not injected (for development)
 */
export function getMaestroConfig(): MaestroConfig {
	if (window.__MAESTRO_CONFIG__) {
		return window.__MAESTRO_CONFIG__;
	}

	// Development fallback - infer stable /app-style routes from the current URL.
	webLogger.warn('No __MAESTRO_CONFIG__ found, using development defaults', 'Config');

	const pathParts = window.location.pathname.split('/').filter(Boolean);
	const basePath = pathParts[0] === WEB_APP_BASE_PATH.replace('/', '') ? WEB_APP_BASE_PATH : '';
	const sessionId = pathParts[1] === 'session' ? pathParts[2] || null : null;

	// Extract tabId from query parameter (e.g., ?tabId=abc123)
	const urlParams = new URLSearchParams(window.location.search);
	const tabId = urlParams.get('tabId');

	return {
		basePath: basePath || WEB_APP_BASE_PATH,
		sessionId,
		tabId,
		apiBase: WEB_APP_API_BASE_PATH,
		wsUrl: WEB_APP_WS_PATH,
		authMode: 'cloudflare-access',
		clientInstanceId: 'dev-client',
		webPush: {
			enabled: false,
		},
	};
}

/**
 * Check if we're in dashboard mode (viewing all sessions)
 */
export function isDashboardMode(): boolean {
	const config = getMaestroConfig();
	return config.sessionId === null;
}

/**
 * Check if we're in session mode (viewing a specific session)
 */
export function isSessionMode(): boolean {
	const config = getMaestroConfig();
	return config.sessionId !== null;
}

/**
 * Get the current session ID (if in session mode)
 */
export function getCurrentSessionId(): string | null {
	return getMaestroConfig().sessionId;
}

/**
 * Build the full API URL for a given endpoint
 */
export function buildApiUrl(endpoint: string): string {
	const config = getMaestroConfig();
	const base = config.apiBase.endsWith('/') ? config.apiBase.slice(0, -1) : config.apiBase;
	const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
	return `${window.location.origin}${base}${path}`;
}

/**
 * Build the full WebSocket URL
 */
export function buildWebSocketUrl(sessionId?: string): string {
	const config = getMaestroConfig();
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	const host = window.location.host;
	let url = `${protocol}//${host}${config.wsUrl}`;

	// Add sessionId as query param if provided (for session-specific subscription)
	if (sessionId) {
		url += `?sessionId=${encodeURIComponent(sessionId)}`;
	}

	return url;
}

/**
 * Get the dashboard URL
 */
export function getDashboardUrl(): string {
	const config = getMaestroConfig();
	return `${window.location.origin}${config.basePath}`;
}

/**
 * Get the URL for a specific session
 */
export function getSessionUrl(sessionId: string, tabId?: string | null): string {
	const config = getMaestroConfig();
	const baseUrl = `${window.location.origin}${config.basePath}/session/${sessionId}`;
	if (tabId) {
		return `${baseUrl}?tabId=${encodeURIComponent(tabId)}`;
	}
	return baseUrl;
}

/**
 * Get the current tab ID from URL (if specified)
 */
export function getCurrentTabId(): string | null {
	return getMaestroConfig().tabId;
}

/**
 * Update the URL to reflect current session and tab without page reload
 * Uses history.replaceState to update the URL bar without navigation
 */
export function updateUrlForSessionTab(sessionId: string, tabId?: string | null): void {
	const newUrl = getSessionUrl(sessionId, tabId);
	// Only update if URL actually changed
	if (window.location.href !== newUrl) {
		window.history.replaceState({ sessionId, tabId }, '', newUrl);
	}
}

/**
 * Build an absolute asset URL within the web app scope.
 */
export function buildScopedAssetUrl(assetPath: string): string {
	const config = getMaestroConfig();
	const normalizedPath = assetPath.startsWith('/') ? assetPath : `/${assetPath}`;
	return `${window.location.origin}${config.basePath}${normalizedPath}`;
}
