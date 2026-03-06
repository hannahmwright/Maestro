declare module 'web-push' {
	export interface VapidKeys {
		publicKey: string;
		privateKey: string;
	}

	export interface PushSubscription {
		endpoint: string;
		expirationTime?: number | null;
		keys: {
			p256dh: string;
			auth: string;
		};
	}

	export interface SendResult {
		statusCode?: number;
	}

	export function generateVAPIDKeys(): VapidKeys;
	export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
	export function sendNotification(
		subscription: PushSubscription,
		payload?: string
	): Promise<SendResult>;
}
