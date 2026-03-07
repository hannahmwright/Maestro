import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../../../web/utils/config', () => ({
	buildApiUrl: vi.fn((endpoint: string) => `https://maestro.test/app/api${endpoint}`),
	getMaestroConfig: vi.fn(() => ({
		basePath: '/app',
		sessionId: null,
		tabId: null,
		apiBase: '/app/api',
		wsUrl: '/app/ws',
		authMode: 'cloudflare-access',
		clientInstanceId: 'test-client',
		webPush: {
			enabled: true,
			publicKey: 'AQID',
		},
	})),
}));

vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import { getMaestroConfig } from '../../../web/utils/config';
import { usePushSubscription } from '../../../web/hooks/usePushSubscription';

function createArrayBuffer(bytes: number[]): ArrayBuffer {
	return new Uint8Array(bytes).buffer;
}

function createMockSubscription(options?: { includeJsonKeys?: boolean }): PushSubscription {
	const includeJsonKeys = options?.includeJsonKeys ?? true;

	return {
		endpoint: 'https://push.example/subscription',
		toJSON: vi.fn().mockReturnValue({
			endpoint: 'https://push.example/subscription',
			expirationTime: null,
			keys: includeJsonKeys
				? {
						p256dh: 'AQID',
						auth: 'BAUG',
					}
				: undefined,
		}),
		getKey: vi.fn((keyName: PushEncryptionKeyName) => {
			if (keyName === 'p256dh') {
				return createArrayBuffer([1, 2, 3]);
			}

			if (keyName === 'auth') {
				return createArrayBuffer([4, 5, 6]);
			}

			return null;
		}),
		unsubscribe: vi.fn().mockResolvedValue(true),
	} as unknown as PushSubscription;
}

describe('usePushSubscription', () => {
	const originalMatchMedia = window.matchMedia;
	const originalNotification = (window as typeof window & { Notification?: typeof Notification })
		.Notification;
	const originalStandalone = (navigator as Navigator & { standalone?: boolean }).standalone;
	const originalUserAgent = navigator.userAgent;
	const originalPlatform = navigator.platform;
	const originalMaxTouchPoints = navigator.maxTouchPoints;

	let fetchMock: ReturnType<typeof vi.fn>;
	let mockRegistration: {
		active: object | null;
		pushManager: {
			getSubscription: ReturnType<typeof vi.fn>;
			subscribe: ReturnType<typeof vi.fn>;
		};
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();

		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		Object.defineProperty(window, 'PushManager', {
			writable: true,
			value: function PushManager() {},
		});

		const MockNotification = function Notification() {} as unknown as typeof Notification;
		Object.defineProperty(MockNotification, 'permission', {
			configurable: true,
			value: 'default',
			writable: true,
		});
		Object.defineProperty(MockNotification, 'requestPermission', {
			configurable: true,
			value: vi.fn().mockResolvedValue('granted'),
			writable: true,
		});
		Object.defineProperty(window, 'Notification', {
			configurable: true,
			writable: true,
			value: MockNotification,
		});

		Object.defineProperty(window, 'matchMedia', {
			writable: true,
			value: vi.fn().mockImplementation(() => ({
				matches: true,
				media: '(display-mode: standalone)',
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			})),
		});

		mockRegistration = {
			active: {},
			pushManager: {
				getSubscription: vi.fn().mockResolvedValue(null),
				subscribe: vi.fn(),
			},
		};

		Object.defineProperty(navigator, 'serviceWorker', {
			writable: true,
			value: {
				ready: Promise.resolve(mockRegistration),
				getRegistration: vi.fn().mockResolvedValue(mockRegistration),
			},
		});

		Object.defineProperty(navigator, 'userAgent', {
			configurable: true,
			value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
		});
		Object.defineProperty(navigator, 'platform', {
			configurable: true,
			value: 'MacIntel',
		});
		Object.defineProperty(navigator, 'maxTouchPoints', {
			configurable: true,
			value: 0,
		});
		Object.defineProperty(navigator, 'standalone', {
			configurable: true,
			value: false,
		});

		vi.mocked(getMaestroConfig).mockReturnValue({
			basePath: '/app',
			sessionId: null,
			tabId: null,
			apiBase: '/app/api',
			wsUrl: '/app/ws',
			authMode: 'cloudflare-access',
			clientInstanceId: 'test-client',
			webPush: {
				enabled: true,
				publicKey: 'AQID',
			},
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		Object.defineProperty(window, 'matchMedia', {
			writable: true,
			value: originalMatchMedia,
		});
		if (originalNotification) {
			Object.defineProperty(window, 'Notification', {
				configurable: true,
				writable: true,
				value: originalNotification,
			});
		} else {
			Object.defineProperty(window, 'Notification', {
				configurable: true,
				writable: true,
				value: undefined,
			});
		}
		Object.defineProperty(navigator, 'userAgent', {
			configurable: true,
			value: originalUserAgent,
		});
		Object.defineProperty(navigator, 'platform', {
			configurable: true,
			value: originalPlatform,
		});
		Object.defineProperty(navigator, 'maxTouchPoints', {
			configurable: true,
			value: originalMaxTouchPoints,
		});
		Object.defineProperty(navigator, 'standalone', {
			configurable: true,
			value: originalStandalone,
		});
	});

	it('re-registers an existing local subscription when the backend status says unsubscribed', async () => {
		const subscription = createMockSubscription();
		mockRegistration.pushManager.getSubscription.mockResolvedValue(subscription);

		fetchMock
			.mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					subscribed: false,
				}),
			} as any)
			.mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({
					success: true,
				}),
			} as any);

		const { result } = renderHook(() =>
			usePushSubscription({
				notificationPermission: 'granted',
				requestNotificationPermission: vi.fn().mockResolvedValue('granted'),
			})
		);

		await waitFor(() => {
			expect(result.current.isSubscribed).toBe(true);
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[0][0])).toContain('/push/status?endpoint=');
		expect(String(fetchMock.mock.calls[1][0])).toContain('/push/subscribe');
	});

	it('falls back to getKey() when PushSubscription.toJSON() omits subscription keys', async () => {
		const subscription = createMockSubscription({ includeJsonKeys: false });
		mockRegistration.pushManager.getSubscription
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);
		mockRegistration.pushManager.subscribe.mockResolvedValue(subscription);
		fetchMock.mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				success: true,
			}),
		} as any);

		const { result } = renderHook(() =>
			usePushSubscription({
				notificationPermission: 'granted',
				requestNotificationPermission: vi.fn().mockResolvedValue('granted'),
			})
		);

		let subscribed = false;
		await act(async () => {
			subscribed = await result.current.subscribe();
		});

		expect(subscribed).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const request = fetchMock.mock.calls[0][1] as RequestInit;
		const body = JSON.parse(String(request.body));
		expect(body.subscription.keys).toEqual({
			p256dh: 'AQID',
			auth: 'BAUG',
		});
	});

	it('fails fast when the service worker never becomes ready', async () => {
		vi.useFakeTimers();
		Object.defineProperty(navigator, 'serviceWorker', {
			writable: true,
			value: {
				ready: new Promise(() => {}),
				getRegistration: vi.fn().mockResolvedValue(undefined),
			},
		});

		const { result } = renderHook(() =>
			usePushSubscription({
				notificationPermission: 'granted',
				requestNotificationPermission: vi.fn().mockResolvedValue('granted'),
			})
		);

		let subscribed = true;
		await act(async () => {
			const promise = result.current.subscribe();
			await vi.advanceTimersByTimeAsync(8000);
			subscribed = await promise;
		});

		expect(subscribed).toBe(false);
		expect(result.current.error).toBe(
			'Service worker is still starting. Reload the app and try again.'
		);
	});

	it('requires the installed PWA flow before enabling push on iPhone or iPad', async () => {
		Object.defineProperty(window, 'matchMedia', {
			writable: true,
			value: vi.fn().mockImplementation(() => ({
				matches: false,
				media: '(display-mode: standalone)',
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			})),
		});
		Object.defineProperty(navigator, 'userAgent', {
			configurable: true,
			value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X)',
		});
		Object.defineProperty(navigator, 'platform', {
			configurable: true,
			value: 'iPhone',
		});
		Object.defineProperty(navigator, 'maxTouchPoints', {
			configurable: true,
			value: 5,
		});

		const requestNotificationPermission = vi.fn().mockResolvedValue('granted');
		const { result } = renderHook(() =>
			usePushSubscription({
				notificationPermission: 'granted',
				requestNotificationPermission,
			})
		);

		let subscribed = true;
		await act(async () => {
			subscribed = await result.current.subscribe();
		});

		expect(subscribed).toBe(false);
		expect(requestNotificationPermission).not.toHaveBeenCalled();
		expect(result.current.error).toBe(
			'Install Maestro to your home screen before enabling push on iPhone or iPad.'
		);
	});
});
