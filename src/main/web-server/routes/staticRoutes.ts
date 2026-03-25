/**
 * Static Routes for Web Server
 *
 * This module contains core route handlers extracted from web-server.ts.
 * Routes handle static files, dashboard views, PWA files, and security redirects.
 *
 * Routes:
 * - / - Redirect to /app
 * - /health - Health check endpoint
 * - /app/manifest.json - PWA manifest
 * - /app/sw.js - PWA service worker
 * - /app - Dashboard (list all sessions)
 * - /app/session/:sessionId - Single session view
 * - /:token - Legacy compatibility redirect to the stable scope
 */

import { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import path from 'path';
import { existsSync, readFileSync, statSync } from 'fs';
import {
	WEB_APP_BASE_PATH,
	WEB_APP_ICONS_PATH,
	WEB_APP_MANIFEST_PATH,
	WEB_APP_SERVICE_WORKER_PATH,
	type MaestroWebConfig,
} from '../../../shared/remote-web';
import { logger } from '../../utils/logger';

// Logger context for all static route logs
const LOG_CONTEXT = 'WebServer:Static';

// Redirect URL for invalid/missing token requests
const REDIRECT_URL = 'https://runmaestro.ai';

/**
 * File cache for static assets that don't change at runtime.
 * Prevents blocking file reads on every request.
 */
interface CachedFile {
	content: string;
	exists: boolean;
	mtimeMs: number;
}

const fileCache = new Map<string, CachedFile>();

/**
 * Read a file with caching - only reads from disk once per path.
 * Returns null if file doesn't exist.
 */
function getCachedFile(filePath: string): string | null {
	const cached = fileCache.get(filePath);
	if (!existsSync(filePath)) {
		fileCache.set(filePath, { content: '', exists: false, mtimeMs: 0 });
		return null;
	}

	try {
		const stats = statSync(filePath);
		if (cached !== undefined && cached.exists && cached.mtimeMs === stats.mtimeMs) {
			return cached.content;
		}

		const content = readFileSync(filePath, 'utf-8');
		fileCache.set(filePath, { content, exists: true, mtimeMs: stats.mtimeMs });
		return content;
	} catch {
		fileCache.set(filePath, { content: '', exists: false, mtimeMs: 0 });
		return null;
	}
}

/**
 * Static Routes Class
 *
 * Encapsulates all static/core route setup logic.
 * Handles dashboard, PWA files, and security redirects.
 */
export class StaticRoutes {
	private securityToken: string;
	private webAssetsPath: string | null;
	private getPushPublicKey: () => string | undefined;

	constructor(
		securityToken: string,
		webAssetsPath: string | null,
		options?: { getPushPublicKey?: () => string | undefined }
	) {
		this.securityToken = securityToken;
		this.webAssetsPath = webAssetsPath;
		this.getPushPublicKey = options?.getPushPublicKey || (() => undefined);
	}

	/**
	 * Validate the security token from a request
	 */
	private validateToken(token: string): boolean {
		return token === this.securityToken;
	}

	/**
	 * Sanitize a string for safe injection into HTML/JavaScript
	 * Only allows alphanumeric characters, hyphens, and underscores (valid for UUIDs and IDs)
	 * Returns null if the input contains invalid characters
	 */
	private sanitizeId(input: string | undefined | null): string | null {
		if (!input) return null;
		// Only allow characters that are safe for UUID-style IDs
		// This prevents XSS attacks via malicious sessionId/tabId parameters
		if (!/^[a-zA-Z0-9_-]+$/.test(input)) {
			logger.warn(`Rejected potentially unsafe ID: ${input.substring(0, 50)}`, LOG_CONTEXT);
			return null;
		}
		return input;
	}

	/**
	 * Serve the index.html file for SPA routes
	 * Rewrites asset paths to use the stable /app scope.
	 */
	private serveIndexHtml(reply: FastifyReply, sessionId?: string, tabId?: string | null): void {
		if (!this.webAssetsPath) {
			reply.code(503).send({
				error: 'Service Unavailable',
				message: 'Web interface not built. Run "npm run build:web" to build web assets.',
			});
			return;
		}

		const indexPath = path.join(this.webAssetsPath, 'index.html');
		const cachedHtml = getCachedFile(indexPath);
		if (cachedHtml === null) {
			reply.code(404).send({
				error: 'Not Found',
				message: 'Web interface index.html not found.',
			});
			return;
		}

		try {
			// Use cached HTML and transform asset paths
			let html = cachedHtml;

			// Transform relative paths to use the stable /app absolute paths
			html = html.replace(/\.\/assets\//g, `${WEB_APP_BASE_PATH}/assets/`);
			html = html.replace(/\.\/manifest\.json/g, WEB_APP_MANIFEST_PATH);
			html = html.replace(/\.\/icons\//g, `${WEB_APP_ICONS_PATH}/`);
			html = html.replace(/\.\/sw\.js/g, WEB_APP_SERVICE_WORKER_PATH);
			html = html.replace(
				/<link\s+rel="manifest"\s+href="([^"]+)"(?:\s+crossorigin="[^"]*")?\s*\/?>/i,
				`<link rel="manifest" href="${WEB_APP_MANIFEST_PATH}" crossorigin="use-credentials" />`
			);

			// Sanitize sessionId and tabId to prevent XSS attacks
			// Only allow safe characters (alphanumeric, hyphens, underscores)
			const safeSessionId = this.sanitizeId(sessionId);
			const safeTabId = this.sanitizeId(tabId);
			const pushPublicKey = this.getPushPublicKey();
			const webConfig: MaestroWebConfig = {
				basePath: WEB_APP_BASE_PATH,
				sessionId: safeSessionId,
				tabId: safeTabId,
				apiBase: `${WEB_APP_BASE_PATH}/api`,
				wsUrl: `${WEB_APP_BASE_PATH}/ws`,
				authMode: 'cloudflare-access',
				clientInstanceId: `${this.securityToken}-${randomUUID()}`,
				webPush: {
					enabled: Boolean(pushPublicKey),
					publicKey: pushPublicKey,
				},
			};

			// Inject config for the React app to know the stable base path and session context.
			const configScript = `<script>
        window.__MAESTRO_CONFIG__ = ${JSON.stringify(webConfig)};
      </script>`;
			html = html.replace('</head>', `${configScript}</head>`);

			reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
			reply.type('text/html').send(html);
		} catch (err) {
			logger.error('Error serving index.html', LOG_CONTEXT, err);
			reply.code(500).send({
				error: 'Internal Server Error',
				message: 'Failed to serve web interface.',
			});
		}
	}

	/**
	 * Register all static routes on the Fastify server
	 */
	registerRoutes(server: FastifyInstance): void {
		const token = this.securityToken;

		// Root path - redirect to the stable app scope.
		server.get('/', async (_request, reply) => {
			return reply.redirect(302, WEB_APP_BASE_PATH);
		});

		// Health check (no auth required)
		server.get('/health', async () => {
			return { status: 'ok', timestamp: Date.now() };
		});

		// PWA manifest.json (cached)
		server.get(WEB_APP_MANIFEST_PATH, async (_request, reply) => {
			if (!this.webAssetsPath) {
				return reply.code(404).send({ error: 'Not Found' });
			}
			const manifestPath = path.join(this.webAssetsPath, 'manifest.json');
			const content = getCachedFile(manifestPath);
			if (content === null) {
				return reply.code(404).send({ error: 'Not Found' });
			}
			reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
			return reply.type('application/json').send(content);
		});

		// PWA service worker (cached)
		server.get(WEB_APP_SERVICE_WORKER_PATH, async (_request, reply) => {
			if (!this.webAssetsPath) {
				return reply.code(404).send({ error: 'Not Found' });
			}
			const swPath = path.join(this.webAssetsPath, 'sw.js');
			const content = getCachedFile(swPath);
			if (content === null) {
				return reply.code(404).send({ error: 'Not Found' });
			}
			reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
			return reply.type('application/javascript').send(content);
		});

		// Dashboard - list all live sessions
		server.get(WEB_APP_BASE_PATH, async (_request, reply) => {
			this.serveIndexHtml(reply);
		});

		// Dashboard with trailing slash
		server.get(`${WEB_APP_BASE_PATH}/`, async (_request, reply) => {
			this.serveIndexHtml(reply);
		});

		// Single session view - perimeter auth (for example Cloudflare Access) protects access.
		// Supports ?tabId=xxx query parameter for deep-linking to specific tabs
		server.get(`${WEB_APP_BASE_PATH}/session/:sessionId`, async (request, reply) => {
			const { sessionId } = request.params as { sessionId: string };
			const { tabId } = request.query as { tabId?: string };
			// Note: Session validation happens in the frontend via the sessions list
			this.serveIndexHtml(reply, sessionId, tabId || null);
		});

		server.get(`${WEB_APP_BASE_PATH}/session/:sessionId/demo/:demoId`, async (request, reply) => {
			const { sessionId } = request.params as { sessionId: string; demoId: string };
			this.serveIndexHtml(reply, sessionId, null);
		});

		// Normalize any root-scoped session routes back to the canonical /app surface.
		server.get('/session/:sessionId', async (request, reply) => {
			const { sessionId } = request.params as { sessionId: string };
			const { tabId } = request.query as { tabId?: string };
			const destination = `${WEB_APP_BASE_PATH}/session/${encodeURIComponent(sessionId)}${
				tabId ? `?tabId=${encodeURIComponent(tabId)}` : ''
			}`;
			return reply.redirect(302, destination);
		});

		server.get('/session/:sessionId/demo/:demoId', async (request, reply) => {
			const { sessionId, demoId } = request.params as { sessionId: string; demoId: string };
			const destination = `${WEB_APP_BASE_PATH}/session/${encodeURIComponent(
				sessionId
			)}/demo/${encodeURIComponent(demoId)}`;
			return reply.redirect(302, destination);
		});

		// Legacy compatibility: redirect the old tokenized routes to /app.
		server.get(`/${token}`, async (_request, reply) => {
			return reply.redirect(302, WEB_APP_BASE_PATH);
		});

		server.get(`/${token}/`, async (_request, reply) => {
			return reply.redirect(302, WEB_APP_BASE_PATH);
		});

		server.get(`/${token}/session/:sessionId`, async (request, reply) => {
			const { sessionId } = request.params as { sessionId: string };
			const { tabId } = request.query as { tabId?: string };
			const destination = `${WEB_APP_BASE_PATH}/session/${encodeURIComponent(sessionId)}${
				tabId ? `?tabId=${encodeURIComponent(tabId)}` : ''
			}`;
			return reply.redirect(302, destination);
		});

		// Catch-all for invalid tokens - redirect to website.
		server.get('/:token', async (request, reply) => {
			const { token: reqToken } = request.params as { token: string };
			if (!this.validateToken(reqToken)) {
				return reply.redirect(302, REDIRECT_URL);
			}
			return reply.redirect(302, WEB_APP_BASE_PATH);
		});

		logger.debug('Static routes registered', LOG_CONTEXT);
	}
}
