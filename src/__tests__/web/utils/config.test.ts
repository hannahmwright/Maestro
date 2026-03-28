import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	getMaestroConfig,
	isDashboardMode,
	isSessionMode,
	getCurrentSessionId,
	getCurrentTabId,
	buildApiUrl,
	buildWebSocketUrl,
	getDashboardUrl,
	getSessionUrl,
	type MaestroConfig,
} from '../../../web/utils/config';
import { webLogger } from '../../../web/utils/logger';

vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

describe('config.ts', () => {
	let originalLocation: Location;
	let originalMaestroConfig: MaestroConfig | undefined;

	beforeEach(() => {
		originalLocation = window.location;
		originalMaestroConfig = window.__MAESTRO_CONFIG__;
		vi.clearAllMocks();

		Object.defineProperty(window, 'location', {
			writable: true,
			value: {
				protocol: 'http:',
				host: 'localhost:3000',
				origin: 'http://localhost:3000',
				pathname: '/app',
				search: '',
				href: 'http://localhost:3000/app',
			},
		});

		delete window.__MAESTRO_CONFIG__;
	});

	afterEach(() => {
		Object.defineProperty(window, 'location', {
			writable: true,
			value: originalLocation,
		});
		if (originalMaestroConfig) {
			window.__MAESTRO_CONFIG__ = originalMaestroConfig;
		} else {
			delete window.__MAESTRO_CONFIG__;
		}
	});

	it('returns the injected config unchanged', () => {
		const injectedConfig: MaestroConfig = {
			basePath: '/app',
			sessionId: 'session-456',
			tabId: 'tab-789',
			apiBase: '/app/api',
			wsUrl: '/app/ws',
			authMode: 'cloudflare-access',
			clientInstanceId: 'client-123',
			webPush: {
				enabled: true,
				publicKey: 'public-key',
			},
		};

		window.__MAESTRO_CONFIG__ = injectedConfig;

		expect(getMaestroConfig()).toBe(injectedConfig);
		expect(webLogger.warn).not.toHaveBeenCalled();
	});

	it('builds the development fallback for the stable app scope', () => {
		expect(getMaestroConfig()).toEqual({
			basePath: '/app',
			sessionId: null,
			tabId: null,
			apiBase: '/app/api',
			wsUrl: '/app/ws',
			authMode: 'cloudflare-access',
			clientInstanceId: 'dev-client',
			webPush: {
				enabled: false,
			},
		});
	});

	it('extracts session and tab context from the stable route shape', () => {
		Object.defineProperty(window, 'location', {
			writable: true,
			value: {
				protocol: 'http:',
				host: 'localhost:3000',
				origin: 'http://localhost:3000',
				pathname: '/app/session/sess-456',
				search: '?tabId=tab-123',
				href: 'http://localhost:3000/app/session/sess-456?tabId=tab-123',
			},
		});

		const result = getMaestroConfig();

		expect(result.sessionId).toBe('sess-456');
		expect(result.tabId).toBe('tab-123');
	});

	it('reports dashboard and session state from config', () => {
		window.__MAESTRO_CONFIG__ = {
			basePath: '/app',
			sessionId: 'session-123',
			tabId: null,
			apiBase: '/app/api',
			wsUrl: '/app/ws',
			authMode: 'cloudflare-access',
			clientInstanceId: 'client-456',
			webPush: {
				enabled: false,
			},
		};

		expect(isDashboardMode()).toBe(false);
		expect(isSessionMode()).toBe(true);
		expect(getCurrentSessionId()).toBe('session-123');
		expect(getCurrentTabId()).toBeNull();
	});

	it('builds API and session URLs from the stable base path', () => {
		window.__MAESTRO_CONFIG__ = {
			basePath: '/app',
			sessionId: null,
			tabId: null,
			apiBase: '/app/api',
			wsUrl: '/app/ws',
			authMode: 'cloudflare-access',
			clientInstanceId: 'client-789',
			webPush: {
				enabled: false,
			},
		};

		expect(buildApiUrl('/sessions')).toBe('http://localhost:3000/app/api/sessions');
		expect(getDashboardUrl()).toBe('http://localhost:3000/app');
		expect(getSessionUrl('session-999', 'tab with spaces')).toBe(
			'http://localhost:3000/app/session/session-999?tabId=tab%20with%20spaces'
		);
	});

	it('normalizes malformed absolute API paths back into the stable app scope', () => {
		window.__MAESTRO_CONFIG__ = {
			basePath: '/app',
			sessionId: null,
			tabId: null,
			apiBase: '/app/api',
			wsUrl: '/app/ws',
			authMode: 'cloudflare-access',
			clientInstanceId: 'client-789',
			webPush: {
				enabled: false,
			},
		};

		expect(buildApiUrl('/http://192.168.1.103:47123/app/api/history?sessionId=session-123')).toBe(
			'http://localhost:3000/app/api/history?sessionId=session-123'
		);
		expect(buildApiUrl('https://192.168.1.103:47123/app/api/history')).toBe(
			'http://localhost:3000/app/api/history'
		);
		expect(buildApiUrl('/app/api/history')).toBe('http://localhost:3000/app/api/history');
	});

	it('builds websocket URLs with the stable app scope', () => {
		window.__MAESTRO_CONFIG__ = {
			basePath: '/app',
			sessionId: null,
			tabId: null,
			apiBase: '/app/api',
			wsUrl: '/app/ws',
			authMode: 'cloudflare-access',
			clientInstanceId: 'client-321',
			webPush: {
				enabled: false,
			},
		};

		expect(buildWebSocketUrl()).toBe('ws://localhost:3000/app/ws');
		expect(buildWebSocketUrl('session with spaces')).toBe(
			'ws://localhost:3000/app/ws?sessionId=session%20with%20spaces'
		);
	});
});
