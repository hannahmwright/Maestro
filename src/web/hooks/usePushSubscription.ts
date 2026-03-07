import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildApiUrl, getMaestroConfig } from '../utils/config';
import { webLogger } from '../utils/logger';
import type { PushStatusResponse, WebPushSubscriptionInput } from '../../shared/remote-web';

const SERVICE_WORKER_READY_TIMEOUT_MS = 8000;

function isPushSupported(): boolean {
	return (
		typeof window !== 'undefined' &&
		'serviceWorker' in navigator &&
		'PushManager' in window &&
		'Notification' in window
	);
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
	const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const rawData = window.atob(base64);
	return new Uint8Array([...rawData].map((char) => char.charCodeAt(0)));
}

function uint8ArrayToBase64Url(value: Uint8Array): string {
	let binary = '';
	value.forEach((byte) => {
		binary += String.fromCharCode(byte);
	});
	return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function getSubscriptionKey(subscription: PushSubscription, keyName: 'p256dh' | 'auth'): string {
	const keyValue = subscription.getKey(keyName);
	return keyValue ? uint8ArrayToBase64Url(new Uint8Array(keyValue)) : '';
}

function serializeSubscription(subscription: PushSubscription): WebPushSubscriptionInput {
	const json = subscription.toJSON();
	if (!json.endpoint) {
		throw new Error('Push subscription endpoint is missing');
	}

	const p256dh = json.keys?.p256dh || getSubscriptionKey(subscription, 'p256dh');
	const auth = json.keys?.auth || getSubscriptionKey(subscription, 'auth');
	if (!p256dh || !auth) {
		throw new Error('Push subscription keys are missing');
	}

	return {
		endpoint: json.endpoint,
		expirationTime: json.expirationTime,
		keys: {
			p256dh,
			auth,
		},
	};
}

function isStandaloneDisplayMode(): boolean {
	if (typeof window === 'undefined') {
		return false;
	}

	return (
		window.matchMedia('(display-mode: standalone)').matches ||
		(window.navigator as Navigator & { standalone?: boolean }).standalone === true
	);
}

function isAppleMobileDevice(): boolean {
	if (typeof navigator === 'undefined') {
		return false;
	}

	const userAgent = navigator.userAgent || '';
	const platform = navigator.platform || '';
	return (
		/iPhone|iPad|iPod/i.test(userAgent) || (/Mac/i.test(platform) && navigator.maxTouchPoints > 1)
	);
}

function requiresInstalledPwaForPush(): boolean {
	return isAppleMobileDevice() && !isStandaloneDisplayMode();
}

export interface UsePushSubscriptionOptions {
	notificationPermission: NotificationPermission;
	requestNotificationPermission: () => Promise<NotificationPermission>;
}

export interface UsePushSubscriptionReturn {
	isSupported: boolean;
	isConfigured: boolean;
	isSubscribed: boolean;
	isLoading: boolean;
	error: string | null;
	subscribe: () => Promise<boolean>;
	unsubscribe: () => Promise<boolean>;
	refresh: () => Promise<void>;
	sendTestNotification: () => Promise<boolean>;
}

export function usePushSubscription(
	options: UsePushSubscriptionOptions
): UsePushSubscriptionReturn {
	const { notificationPermission, requestNotificationPermission } = options;
	const config = useMemo(() => getMaestroConfig(), []);
	const supported = isPushSupported();
	const publicKey = config.webPush?.publicKey ?? null;
	const [isSubscribed, setIsSubscribed] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const waitForServiceWorkerRegistration =
		useCallback(async (): Promise<ServiceWorkerRegistration> => {
			const existingRegistration = await navigator.serviceWorker.getRegistration?.();
			if (existingRegistration?.active) {
				return existingRegistration;
			}

			return await new Promise<ServiceWorkerRegistration>((resolve, reject) => {
				const timeoutId = window.setTimeout(() => {
					reject(new Error('Service worker is still starting. Reload the app and try again.'));
				}, SERVICE_WORKER_READY_TIMEOUT_MS);

				navigator.serviceWorker.ready.then(
					(registration) => {
						window.clearTimeout(timeoutId);
						resolve(registration);
					},
					(waitError) => {
						window.clearTimeout(timeoutId);
						reject(waitError);
					}
				);
			});
		}, []);

	const persistSubscription = useCallback(async (subscription: PushSubscription): Promise<void> => {
		const response = await fetch(buildApiUrl('/push/subscribe'), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				subscription: serializeSubscription(subscription),
				deviceLabel: 'PWA',
			}),
		});

		if (!response.ok) {
			throw new Error(`Push subscribe failed with status ${response.status}`);
		}
	}, []);

	const refresh = useCallback(async () => {
		if (!supported) {
			setIsSubscribed(false);
			return;
		}

		try {
			const registration = await waitForServiceWorkerRegistration();
			const subscription = await registration.pushManager.getSubscription();
			if (!subscription) {
				setIsSubscribed(false);
				return;
			}

			setIsSubscribed(true);
			const statusUrl = `${buildApiUrl('/push/status')}?endpoint=${encodeURIComponent(subscription.endpoint)}`;
			const response = await fetch(statusUrl);
			if (!response.ok) {
				await persistSubscription(subscription);
				return;
			}

			const status = (await response.json()) as PushStatusResponse & { timestamp?: number };
			if (!status.subscribed) {
				await persistSubscription(subscription);
			}

			setIsSubscribed(true);
			setError(null);
		} catch (refreshError) {
			webLogger.error(
				'Failed to refresh push subscription state',
				'PushSubscription',
				refreshError
			);
			setIsSubscribed(false);
		}
	}, [persistSubscription, supported, waitForServiceWorkerRegistration]);

	useEffect(() => {
		refresh().catch((refreshError) => {
			webLogger.error('Initial push subscription refresh failed', 'PushSubscription', refreshError);
		});
	}, [refresh]);

	const subscribe = useCallback(async (): Promise<boolean> => {
		if (!supported || !publicKey) {
			setError('Push notifications are not available in this browser.');
			return false;
		}

		if (requiresInstalledPwaForPush()) {
			setError('Install Maestro to your home screen before enabling push on iPhone or iPad.');
			return false;
		}

		setIsLoading(true);
		setError(null);

		try {
			const permission =
				notificationPermission === 'granted'
					? notificationPermission
					: await requestNotificationPermission();
			if (permission !== 'granted') {
				setError('Notification permission is required to enable push.');
				return false;
			}

			const registration = await waitForServiceWorkerRegistration();
			let subscription = await registration.pushManager.getSubscription();
			if (!subscription) {
				subscription = await registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
				});
			}

			await persistSubscription(subscription);
			setIsSubscribed(true);
			return true;
		} catch (subscribeError) {
			const message =
				subscribeError instanceof Error ? subscribeError.message : 'Failed to enable push';
			setError(message);
			webLogger.error(
				'Failed to subscribe to push notifications',
				'PushSubscription',
				subscribeError
			);
			return false;
		} finally {
			setIsLoading(false);
		}
	}, [notificationPermission, publicKey, requestNotificationPermission, supported]);

	const unsubscribe = useCallback(async (): Promise<boolean> => {
		if (!supported) {
			return false;
		}

		setIsLoading(true);
		setError(null);

		try {
			const registration = await waitForServiceWorkerRegistration();
			const subscription = await registration.pushManager.getSubscription();
			if (!subscription) {
				setIsSubscribed(false);
				return true;
			}

			const endpoint = subscription.endpoint;
			const unsubscribed = await subscription.unsubscribe();
			await fetch(buildApiUrl('/push/unsubscribe'), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ endpoint }),
			});

			setIsSubscribed(false);
			return unsubscribed;
		} catch (unsubscribeError) {
			const message =
				unsubscribeError instanceof Error ? unsubscribeError.message : 'Failed to disable push';
			setError(message);
			webLogger.error(
				'Failed to unsubscribe from push notifications',
				'PushSubscription',
				unsubscribeError
			);
			return false;
		} finally {
			setIsLoading(false);
		}
	}, [supported, waitForServiceWorkerRegistration]);

	const sendTestNotification = useCallback(async (): Promise<boolean> => {
		if (!supported) {
			return false;
		}

		setIsLoading(true);
		setError(null);

		try {
			const registration = await waitForServiceWorkerRegistration();
			const subscription = await registration.pushManager.getSubscription();
			if (!subscription) {
				setError('Enable push notifications first.');
				return false;
			}

			const response = await fetch(buildApiUrl('/push/test'), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ endpoint: subscription?.endpoint }),
			});

			if (!response.ok) {
				throw new Error(`Push test failed with status ${response.status}`);
			}

			const result = (await response.json()) as { success?: boolean };
			return Boolean(result.success);
		} catch (testError) {
			const message =
				testError instanceof Error ? testError.message : 'Failed to send test notification';
			setError(message);
			webLogger.error('Failed to send test push notification', 'PushSubscription', testError);
			return false;
		} finally {
			setIsLoading(false);
		}
	}, [supported, waitForServiceWorkerRegistration]);

	return {
		isSupported: supported,
		isConfigured: Boolean(config.webPush?.enabled && publicKey),
		isSubscribed,
		isLoading,
		error,
		subscribe,
		unsubscribe,
		refresh,
		sendTestNotification,
	};
}

export default usePushSubscription;
