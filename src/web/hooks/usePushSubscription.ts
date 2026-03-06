import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildApiUrl, getMaestroConfig } from '../utils/config';
import { webLogger } from '../utils/logger';
import type { PushStatusResponse, WebPushSubscriptionInput } from '../../shared/remote-web';

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

function serializeSubscription(subscription: PushSubscription): WebPushSubscriptionInput {
	const json = subscription.toJSON();
	if (!json.endpoint) {
		throw new Error('Push subscription endpoint is missing');
	}
	return {
		endpoint: json.endpoint,
		expirationTime: json.expirationTime,
		keys: {
			p256dh: json.keys?.p256dh || '',
			auth: json.keys?.auth || '',
		},
	};
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
	const publicKey = config.webPush.publicKey;
	const [isSubscribed, setIsSubscribed] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		if (!supported) {
			setIsSubscribed(false);
			return;
		}

		try {
			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.getSubscription();
			if (!subscription) {
				setIsSubscribed(false);
				return;
			}

			const statusUrl = `${buildApiUrl('/push/status')}?endpoint=${encodeURIComponent(subscription.endpoint)}`;
			const response = await fetch(statusUrl);
			if (!response.ok) {
				setIsSubscribed(false);
				return;
			}

			const status = (await response.json()) as PushStatusResponse & { timestamp?: number };
			setIsSubscribed(Boolean(status.subscribed));
		} catch (refreshError) {
			webLogger.error(
				'Failed to refresh push subscription state',
				'PushSubscription',
				refreshError
			);
			setIsSubscribed(false);
		}
	}, [supported]);

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

			const registration = await navigator.serviceWorker.ready;
			let subscription = await registration.pushManager.getSubscription();
			if (!subscription) {
				subscription = await registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
				});
			}

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
			const registration = await navigator.serviceWorker.ready;
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
	}, [supported]);

	const sendTestNotification = useCallback(async (): Promise<boolean> => {
		if (!supported) {
			return false;
		}

		setIsLoading(true);
		setError(null);

		try {
			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.getSubscription();
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
	}, [supported]);

	return {
		isSupported: supported,
		isConfigured: Boolean(config.webPush.enabled && publicKey),
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
