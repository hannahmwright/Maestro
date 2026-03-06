const BASE_PATH = '/app';
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE_NAME = `maestro-remote-${VERSION}`;
const ICON_URL = `${BASE_PATH}/icons/icon-192x192.png`;
const PRECACHE_ASSETS = [
	BASE_PATH,
	`${BASE_PATH}/manifest.json`,
	`${BASE_PATH}/icons/icon-72x72.png`,
	`${BASE_PATH}/icons/icon-96x96.png`,
	`${BASE_PATH}/icons/icon-192x192.png`,
	`${BASE_PATH}/icons/icon-512x512.png`,
];
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const seenEventIds = new Map();

function pruneSeenEventIds() {
	const cutoff = Date.now() - DEDUPE_WINDOW_MS;
	for (const [eventId, timestamp] of seenEventIds.entries()) {
		if (timestamp < cutoff) {
			seenEventIds.delete(eventId);
		}
	}
}

function rememberEvent(eventId) {
	pruneSeenEventIds();
	if (!eventId) {
		return false;
	}
	if (seenEventIds.has(eventId)) {
		return true;
	}
	seenEventIds.set(eventId, Date.now());
	return false;
}

function isStaticAsset(pathname) {
	return (
		pathname.startsWith(`${BASE_PATH}/assets/`) ||
		pathname.startsWith(`${BASE_PATH}/icons/`) ||
		pathname.endsWith('.js') ||
		pathname.endsWith('.css') ||
		pathname.endsWith('.png') ||
		pathname.endsWith('.jpg') ||
		pathname.endsWith('.jpeg') ||
		pathname.endsWith('.svg') ||
		pathname.endsWith('.ico') ||
		pathname.endsWith('.woff') ||
		pathname.endsWith('.woff2')
	);
}

function isApiRequest(pathname) {
	return pathname.startsWith(`${BASE_PATH}/api/`) || pathname.startsWith(`${BASE_PATH}/ws`);
}

async function fetchAndCache(request) {
	try {
		const response = await fetch(request);
		if (response.ok) {
			const responseClone = response.clone();
			const cache = await caches.open(CACHE_NAME);
			await cache.put(request, responseClone);
		}
		return response;
	} catch (error) {
		const cached = await caches.match(request);
		if (cached) {
			return cached;
		}
		throw error;
	}
}

async function getAppShellFallback() {
	return (await caches.match(BASE_PATH)) || (await caches.match(`${BASE_PATH}/`));
}

async function hasVisibleClient() {
	const clients = await self.clients.matchAll({
		type: 'window',
		includeUncontrolled: true,
	});
	return clients.some((client) => client.visibilityState === 'visible' || client.focused);
}

async function showResponseNotification(eventPayload, source) {
	if (!eventPayload?.eventId) {
		return;
	}

	if (rememberEvent(eventPayload.eventId)) {
		return;
	}

	if (source === 'push' && (await hasVisibleClient())) {
		return;
	}

	const title = eventPayload.title || `${eventPayload.sessionName || 'Maestro'} - Response Ready`;
	const body = eventPayload.body || 'AI response completed.';
	const deepLinkUrl = eventPayload.deepLinkUrl || BASE_PATH;

	await self.registration.showNotification(title, {
		body,
		icon: ICON_URL,
		badge: ICON_URL,
		tag: `maestro-response-${eventPayload.eventId}`,
		renotify: false,
		data: {
			eventId: eventPayload.eventId,
			sessionId: eventPayload.sessionId || null,
			tabId: eventPayload.tabId || null,
			deepLinkUrl,
		},
	});
}

function resolveDeepLink(deepLinkUrl) {
	try {
		return new URL(deepLinkUrl, self.location.origin).toString();
	} catch {
		return `${self.location.origin}${BASE_PATH}`;
	}
}

function urlBase64ToUint8Array(base64String) {
	const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
	const rawData = atob(base64);
	return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

function serializeSubscription(subscription) {
	return subscription.toJSON
		? subscription.toJSON()
		: {
				endpoint: subscription.endpoint,
				expirationTime: subscription.expirationTime,
				keys: {
					p256dh: subscription.getKey('p256dh'),
					auth: subscription.getKey('auth'),
				},
			};
}

async function cacheAppShell(response) {
	if (!response.ok) {
		return;
	}

	const cache = await caches.open(CACHE_NAME);
	await cache.put(BASE_PATH, response);
}

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => cache.addAll(PRECACHE_ASSETS).catch(() => undefined))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((cacheNames) =>
				Promise.all(
					cacheNames
						.filter((name) => name.startsWith('maestro-remote-') && name !== CACHE_NAME)
						.map((name) => caches.delete(name))
				)
			)
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);

	if (request.method !== 'GET') {
		return;
	}

	if (url.protocol === 'ws:' || url.protocol === 'wss:') {
		return;
	}

	if (isApiRequest(url.pathname)) {
		event.respondWith(
			fetch(request).catch(
				() =>
					new Response(
						JSON.stringify({
							error: 'offline',
							message: 'You are offline. Please reconnect to use Maestro.',
						}),
						{
							status: 503,
							statusText: 'Service Unavailable',
							headers: {
								'Content-Type': 'application/json',
							},
						}
					)
			)
		);
		return;
	}

	if (isStaticAsset(url.pathname)) {
		event.respondWith(
			caches.match(request).then((cachedResponse) => {
				if (cachedResponse) {
					fetchAndCache(request).catch(() => undefined);
					return cachedResponse;
				}
				return fetchAndCache(request);
			})
		);
		return;
	}

	const isNavigationRequest =
		request.mode === 'navigate' ||
		request.headers.get('accept')?.includes('text/html') ||
		url.pathname === BASE_PATH ||
		url.pathname.startsWith(`${BASE_PATH}/session/`);

	if (!isNavigationRequest) {
		return;
	}

	event.respondWith(
		fetch(request)
			.then((response) => {
				if (response.ok) {
					const responseClone = response.clone();
					event.waitUntil(cacheAppShell(responseClone).catch(() => undefined));
				}
				return response;
			})
			.catch(async () => {
				const appShell = await getAppShellFallback();
				if (appShell) {
					return appShell;
				}
				return new Response('Offline', { status: 503, statusText: 'Offline' });
			})
	);
});

self.addEventListener('message', (event) => {
	const message = event.data;

	if (message === 'skipWaiting' || message?.type === 'skipWaiting') {
		self.skipWaiting();
		return;
	}

	if (message === 'ping' || message?.type === 'ping') {
		event.ports[0]?.postMessage('pong');
		return;
	}

	if (message?.type === 'show-local-notification') {
		event.waitUntil(showResponseNotification(message.payload, 'local'));
	}
});

self.addEventListener('push', (event) => {
	if (!event.data) {
		return;
	}

	event.waitUntil(
		(async () => {
			try {
				const payload = event.data.json();
				if (payload?.type === 'response_completed') {
					await showResponseNotification(payload.event, 'push');
				}
			} catch (error) {
				console.error('[SW] Failed to handle push event', error);
			}
		})()
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const deepLinkUrl = resolveDeepLink(event.notification.data?.deepLinkUrl || BASE_PATH);

	event.waitUntil(
		(async () => {
			const clients = await self.clients.matchAll({
				type: 'window',
				includeUncontrolled: true,
			});
			for (const client of clients) {
				if ('navigate' in client) {
					await client.navigate(deepLinkUrl);
				}
				await client.focus();
				return;
			}

			await self.clients.openWindow(deepLinkUrl);
		})()
	);
});

self.addEventListener('pushsubscriptionchange', (event) => {
	event.waitUntil(
		(async () => {
			try {
				const statusResponse = await fetch(`${BASE_PATH}/api/push/status`, {
					credentials: 'same-origin',
				});
				if (!statusResponse.ok) {
					return;
				}

				const status = await statusResponse.json();
				if (!status?.publicKey) {
					return;
				}

				const subscription = await self.registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: urlBase64ToUint8Array(status.publicKey),
				});

				await fetch(`${BASE_PATH}/api/push/subscribe`, {
					method: 'POST',
					credentials: 'same-origin',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						subscription: serializeSubscription(subscription),
						deviceLabel: 'PWA',
					}),
				});
			} catch (error) {
				console.error('[SW] Failed to refresh push subscription', error);
			}
		})()
	);
});
