import Store from 'electron-store';
import * as webpush from 'web-push';
import { logger } from './utils/logger';
import type {
	PushStatusResponse,
	PushSubscriptionRecord,
	ResponseCompletedEvent,
	WebPushSubscriptionInput,
} from '../shared/remote-web';

const LOG_CONTEXT = 'WebPushManager';
const STORE_NAME = 'maestro-web-push';

interface VapidKeys {
	publicKey: string;
	privateKey: string;
}

interface StoredWebPushSubscription extends PushSubscriptionRecord {
	expirationTime?: number | null;
}

interface WebPushStoreData {
	vapidKeys?: VapidKeys;
	subscriptions: StoredWebPushSubscription[];
}

export class WebPushManager {
	private store = new Store<WebPushStoreData>({
		name: STORE_NAME,
		defaults: {
			subscriptions: [],
		},
	});

	private vapidKeys: VapidKeys;

	constructor() {
		this.vapidKeys = this.ensureVapidKeys();
		webpush.setVapidDetails(
			'mailto:notifications@runmaestro.ai',
			this.vapidKeys.publicKey,
			this.vapidKeys.privateKey
		);
	}

	private ensureVapidKeys(): VapidKeys {
		const existing = this.store.get('vapidKeys');
		if (existing?.publicKey && existing?.privateKey) {
			return existing;
		}

		const created = webpush.generateVAPIDKeys();
		this.store.set('vapidKeys', created);
		return created;
	}

	private getSubscriptions(): StoredWebPushSubscription[] {
		return this.store.get('subscriptions', []);
	}

	private setSubscriptions(subscriptions: StoredWebPushSubscription[]): void {
		this.store.set('subscriptions', subscriptions);
	}

	getPublicKey(): string {
		return this.vapidKeys.publicKey;
	}

	getStatus(endpoint?: string): PushStatusResponse {
		const subscriptions = this.getSubscriptions();
		return {
			enabled: true,
			subscribed: endpoint
				? subscriptions.some(
						(subscription) => subscription.enabled && subscription.endpoint === endpoint
					)
				: false,
			publicKey: this.getPublicKey(),
		};
	}

	subscribe(
		subscription: WebPushSubscriptionInput,
		metadata?: {
			userAgent?: string;
			deviceLabel?: string;
		}
	): PushSubscriptionRecord {
		const now = Date.now();
		const subscriptions = this.getSubscriptions();
		const existing = subscriptions.find((entry) => entry.endpoint === subscription.endpoint);
		const next: StoredWebPushSubscription = {
			id: existing?.id || `${now}-${Math.random().toString(36).slice(2, 10)}`,
			endpoint: subscription.endpoint,
			expirationTime: subscription.expirationTime ?? null,
			keys: {
				p256dh: subscription.keys.p256dh,
				auth: subscription.keys.auth,
			},
			userAgent: metadata?.userAgent,
			deviceLabel: metadata?.deviceLabel,
			createdAt: existing?.createdAt || now,
			lastSeenAt: now,
			enabled: true,
		};

		const filtered = subscriptions.filter((entry) => entry.endpoint !== subscription.endpoint);
		filtered.push(next);
		this.setSubscriptions(filtered);

		logger.info(`Subscribed web push endpoint ${next.id}`, LOG_CONTEXT);
		return next;
	}

	unsubscribe(endpoint: string): boolean {
		const subscriptions = this.getSubscriptions();
		const changed = subscriptions.map((entry) =>
			entry.endpoint === endpoint ? { ...entry, enabled: false, lastSeenAt: Date.now() } : entry
		);
		const hasMatch = changed.some((entry, index) => {
			const previous = subscriptions[index];
			return previous.endpoint === endpoint && previous.enabled !== entry.enabled;
		});
		if (hasMatch) {
			this.setSubscriptions(changed);
		}
		return hasMatch;
	}

	private async sendNotificationToSubscription(
		subscription: StoredWebPushSubscription,
		payload: Record<string, unknown>
	): Promise<boolean> {
		try {
			await webpush.sendNotification(
				{
					endpoint: subscription.endpoint,
					expirationTime: subscription.expirationTime ?? null,
					keys: subscription.keys,
				},
				JSON.stringify(payload)
			);
			return true;
		} catch (error) {
			const statusCode =
				error && typeof error === 'object' && 'statusCode' in error
					? Number((error as { statusCode?: number }).statusCode)
					: null;
			logger.warn(
				`Failed to send push notification to ${subscription.id}${statusCode ? ` (${statusCode})` : ''}`,
				LOG_CONTEXT,
				error
			);

			if (statusCode === 404 || statusCode === 410) {
				this.unsubscribe(subscription.endpoint);
			}
			return false;
		}
	}

	async sendResponseCompleted(event: ResponseCompletedEvent): Promise<number> {
		const subscriptions = this.getSubscriptions().filter((subscription) => subscription.enabled);
		if (subscriptions.length === 0) {
			return 0;
		}

		const payload = {
			type: 'response_completed',
			event,
		};

		const results = await Promise.all(
			subscriptions.map((subscription) =>
				this.sendNotificationToSubscription(subscription, payload)
			)
		);
		const delivered = results.filter(Boolean).length;
		logger.info(
			`Sent response_completed push to ${delivered}/${subscriptions.length} subscriptions`,
			LOG_CONTEXT,
			{
				eventId: event.eventId,
				sessionId: event.sessionId,
			}
		);
		return delivered;
	}

	async sendTestPush(endpoint?: string): Promise<boolean> {
		const subscriptions = this.getSubscriptions().filter(
			(subscription) => subscription.enabled && (!endpoint || subscription.endpoint === endpoint)
		);
		if (subscriptions.length === 0) {
			return false;
		}

		const payload = {
			type: 'response_completed',
			event: {
				eventId: `test-${Date.now()}`,
				sessionId: 'test',
				tabId: null,
				sessionName: 'Maestro Test',
				toolType: 'system',
				completedAt: Date.now(),
				title: 'Maestro Test Notification',
				body: 'Push notifications are working.',
				deepLinkUrl: '/app',
			},
		};

		const results = await Promise.all(
			subscriptions.map((subscription) =>
				this.sendNotificationToSubscription(subscription, payload)
			)
		);
		return results.some(Boolean);
	}
}
