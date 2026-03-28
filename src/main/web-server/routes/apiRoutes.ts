/**
 * API Routes for Web Server
 *
 * This module contains all REST API route handlers extracted from web-server.ts.
 * Routes are under /app/api/* and handle session data, theme, history, commands,
 * and web push subscription management.
 *
 * API Endpoints:
 * - GET /api/sessions - List all sessions with live info
 * - GET /api/session/:id - Get single session detail
 * - POST /api/session/:id/send - Send command to session
 * - GET /api/theme - Get current theme
 * - POST /api/session/:id/interrupt - Interrupt session
 * - GET /api/history - Get history entries
 */

import { createReadStream } from 'fs';
import fs from 'fs/promises';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
	WEB_APP_API_BASE_PATH,
	type PushStatusResponse,
	type PushSubscriptionRecord,
	type WebVoiceTranscriptionRequest,
	type WebVoiceTranscriptionResponse,
	type WebVoiceTranscriptionStatusResponse,
	type WebPushSubscriptionInput,
} from '../../../shared/remote-web';
import type { AgentModelCatalogGroup } from '../../../shared/agent-model-catalog';
import type { DemoCard, DemoDetail } from '../../../shared/demo-artifacts';
import {
	HistoryEntry,
	type ToolType,
	type ConductorTaskPriority,
	type ConductorTaskStatus,
} from '../../../shared/types';
import { logger } from '../../utils/logger';
import type {
	Theme,
	SessionData,
	SessionDetail,
	LiveSessionInfo,
	RateLimitConfig,
	ConductorSnapshot,
	UpdateConductorTaskInput,
} from '../types';
import type { ProviderUsageSnapshot } from '../../../shared/provider-usage';

// Re-export types for backwards compatibility
export type {
	Theme,
	SessionUsageStats,
	LastResponsePreview,
	AITabData,
	SessionData,
	SessionDetail,
	LiveSessionInfo,
	RateLimitConfig,
} from '../types';

// Logger context for all API route logs
const LOG_CONTEXT = 'WebServer:API';
const ROOT_SCOPED_API_BASE_PATH = '/api';

/**
 * Callbacks required by API routes
 */
export interface ApiRouteCallbacks {
	getSessions: () => Promise<SessionData[]> | SessionData[];
	getSessionDetail: (sessionId: string, tabId?: string) => SessionDetail | null;
	getSessionModels: (sessionId: string, forceRefresh?: boolean) => Promise<string[]> | string[];
	getSessionModelCatalog: (
		sessionId: string,
		forceRefresh?: boolean
	) => Promise<AgentModelCatalogGroup[]> | AgentModelCatalogGroup[];
	getSessionProviderUsage: (
		sessionId: string,
		forceRefresh?: boolean
	) => Promise<ProviderUsageSnapshot | null> | ProviderUsageSnapshot | null;
	getConductorSnapshot: () => Promise<ConductorSnapshot> | ConductorSnapshot;
	getSessionDemos: (sessionId: string, tabId?: string | null) => Promise<DemoCard[]> | DemoCard[];
	getDemoDetail: (demoId: string) => Promise<DemoDetail | null> | DemoDetail | null;
	getArtifactContent: (
		artifactId: string
	) =>
		| Promise<{ path: string; mimeType: string; filename: string } | null>
		| { path: string; mimeType: string; filename: string }
		| null;
	getSessionLocalFile: (
		sessionId: string,
		requestedPath: string
	) =>
		| Promise<
				| { path: string; mimeType: string; filename: string; requestedPath: string }
				| { errorCode: number; message: string }
		  >
		| { path: string; mimeType: string; filename: string; requestedPath: string }
		| { errorCode: number; message: string };
	transcribeAudio: (
		request: WebVoiceTranscriptionRequest
	) => Promise<WebVoiceTranscriptionResponse | null>;
	getVoiceTranscriptionStatus: () => Promise<WebVoiceTranscriptionStatusResponse | null>;
	prewarmVoiceTranscription: () => Promise<WebVoiceTranscriptionStatusResponse | null>;
	getTheme: () => Theme | null;
	writeToSession: (sessionId: string, data: string) => boolean;
	interruptSession: (sessionId: string) => Promise<boolean>;
	setSessionModel: (sessionId: string, model: string | null) => Promise<boolean> | boolean;
	forkThread: (
		sessionId: string,
		options?: { toolType?: ToolType; model?: string | null }
	) => Promise<{ success: boolean; sessionId?: string | null }>;
	getHistory: (projectPath?: string, sessionId?: string) => HistoryEntry[];
	getLiveSessionInfo: (sessionId: string) => LiveSessionInfo | undefined;
	isSessionLive: (sessionId: string) => boolean;
	getPushStatus: (endpoint?: string) => PushStatusResponse;
	subscribePush: (
		subscription: WebPushSubscriptionInput,
		metadata?: {
			userAgent?: string;
			deviceLabel?: string;
		}
	) => PushSubscriptionRecord;
	unsubscribePush: (endpoint: string) => boolean;
	sendTestPush: (endpoint?: string) => Promise<boolean>;
	createConductorTask: (input: {
		groupId: string;
		title: string;
		description?: string;
		priority?: ConductorTaskPriority;
		status?: ConductorTaskStatus;
	}) => Promise<boolean>;
	updateConductorTask: (taskId: string, updates: UpdateConductorTaskInput) => Promise<boolean>;
	deleteConductorTask: (taskId: string) => Promise<boolean>;
	openConductorWorkspace: (groupId: string) => Promise<boolean>;
}

/**
 * API Routes Class
 *
 * Encapsulates all REST API route setup logic.
 * Uses dependency injection for callbacks to maintain separation from WebServer class.
 */
export class ApiRoutes {
	private callbacks: Partial<ApiRouteCallbacks> = {};
	private rateLimitConfig: RateLimitConfig;

	constructor(rateLimitConfig: RateLimitConfig) {
		this.rateLimitConfig = rateLimitConfig;
	}

	/**
	 * Set the callbacks for API operations
	 */
	setCallbacks(callbacks: ApiRouteCallbacks): void {
		this.callbacks = callbacks;
	}

	/**
	 * Update rate limit configuration
	 */
	updateRateLimitConfig(config: RateLimitConfig): void {
		this.rateLimitConfig = config;
	}

	private isHtmlNavigationRequest(request: FastifyRequest): boolean {
		const acceptHeader = request.headers.accept || '';
		return (
			request.headers['sec-fetch-dest'] === 'document' ||
			acceptHeader.includes('text/html') ||
			request.headers['upgrade-insecure-requests'] === '1'
		);
	}

	private escapeHtml(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	private sendContentError(
		request: FastifyRequest,
		reply: FastifyReply,
		statusCode: number,
		title: string,
		message: string
	): FastifyReply {
		if (this.isHtmlNavigationRequest(request)) {
			const escapedTitle = this.escapeHtml(title);
			const escapedMessage = this.escapeHtml(message);
			return reply.code(statusCode).type('text/html').send(`<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>${escapedTitle}</title>
		<style>
			body {
				margin: 0;
				font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
				background: #020617;
				color: #e2e8f0;
				min-height: 100vh;
				display: flex;
				align-items: center;
				justify-content: center;
				padding: 24px;
			}
			.card {
				max-width: 640px;
				width: 100%;
				background: rgba(15, 23, 42, 0.92);
				border: 1px solid rgba(148, 163, 184, 0.24);
				border-radius: 20px;
				padding: 24px;
				box-shadow: 0 24px 60px rgba(15, 23, 42, 0.45);
			}
			h1 {
				margin: 0 0 12px;
				font-size: 24px;
				line-height: 1.2;
			}
			p {
				margin: 0;
				font-size: 15px;
				line-height: 1.6;
				color: #cbd5e1;
			}
		</style>
	</head>
	<body>
		<div class="card">
			<h1>${escapedTitle}</h1>
			<p>${escapedMessage}</p>
		</div>
	</body>
</html>`);
		}

		return reply.code(statusCode).send({
			error: title,
			message,
			timestamp: Date.now(),
		});
	}

	private async sendStreamableFile(
		request: FastifyRequest,
		reply: FastifyReply,
		file: { path: string; mimeType: string; filename: string }
	): Promise<FastifyReply | void> {
		let stats;
		try {
			stats = await fs.stat(file.path);
		} catch (error) {
			logger.warn('File content missing or unreadable', LOG_CONTEXT, {
				path: file.path,
				error: String(error),
			});
			return this.sendContentError(
				request,
				reply,
				404,
				'Not Found',
				`The requested file is no longer available: ${file.filename}`
			);
		}

		const rangeHeader = request.headers.range;

		reply.header('Accept-Ranges', 'bytes');
		reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
		reply.header('Cache-Control', 'private, no-store');
		reply.type(file.mimeType);

		if (rangeHeader) {
			const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
			if (!match) {
				return reply.code(416).send();
			}

			const start = match[1] ? Number.parseInt(match[1], 10) : 0;
			const end = match[2] ? Number.parseInt(match[2], 10) : stats.size - 1;
			if (
				Number.isNaN(start) ||
				Number.isNaN(end) ||
				start < 0 ||
				end < start ||
				start >= stats.size ||
				end >= stats.size
			) {
				return reply.code(416).send();
			}
			const chunkSize = end - start + 1;

			reply.code(206);
			reply.header('Content-Range', `bytes ${start}-${end}/${stats.size}`);
			reply.header('Content-Length', chunkSize);
			return reply.send(createReadStream(file.path, { start, end }));
		}

		reply.header('Content-Length', stats.size);
		return reply.send(createReadStream(file.path));
	}

	private buildLocalFileViewerHtml(file: {
		filename: string;
		mimeType: string;
		contentUrl: string;
		requestedPath: string;
	}): string {
		const escapedFilename = this.escapeHtml(file.filename);
		const escapedMimeType = this.escapeHtml(file.mimeType);
		const escapedRequestedPath = this.escapeHtml(file.requestedPath);
		const escapedContentUrl = this.escapeHtml(file.contentUrl);
		const isVideo = file.mimeType.startsWith('video/');
		const isImage = file.mimeType.startsWith('image/');
		const mediaMarkup = isVideo
			? `<video id="media" controls playsinline preload="metadata" src="${escapedContentUrl}"></video>`
			: isImage
				? `<img id="media" src="${escapedContentUrl}" alt="${escapedFilename}" />`
				: `<div class="fallback"><p>This file can be downloaded from Maestro, but it does not have an inline viewer.</p></div>`;
		const unsupportedHint = isVideo
			? 'If this browser cannot play the recording, the video format is likely unsupported on this device.'
			: 'If the preview does not load, try downloading the file instead.';

		return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>${escapedFilename}</title>
		<style>
			body {
				margin: 0;
				font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
				background: #020617;
				color: #e2e8f0;
				min-height: 100vh;
			}
			.shell {
				min-height: 100vh;
				display: flex;
				flex-direction: column;
				padding: 20px;
				gap: 16px;
				box-sizing: border-box;
			}
			.card {
				background: rgba(15, 23, 42, 0.92);
				border: 1px solid rgba(148, 163, 184, 0.22);
				border-radius: 20px;
				padding: 18px;
				box-shadow: 0 24px 60px rgba(15, 23, 42, 0.35);
			}
			h1 {
				margin: 0 0 6px;
				font-size: 22px;
				line-height: 1.2;
			}
			.meta {
				font-size: 13px;
				color: #94a3b8;
				word-break: break-word;
			}
			.viewer {
				flex: 1;
				display: flex;
				align-items: center;
				justify-content: center;
				background: #000;
				border-radius: 20px;
				overflow: hidden;
				min-height: 280px;
			}
			#media {
				width: 100%;
				max-width: 100%;
				max-height: calc(100vh - 220px);
				display: block;
				background: #000;
			}
			#error {
				display: none;
				margin-top: 12px;
				padding: 14px 16px;
				border-radius: 14px;
				border: 1px solid rgba(248, 113, 113, 0.3);
				background: rgba(127, 29, 29, 0.28);
				color: #fecaca;
				font-size: 14px;
				line-height: 1.5;
			}
			a.button {
				display: inline-flex;
				align-items: center;
				justify-content: center;
				margin-top: 16px;
				padding: 12px 16px;
				border-radius: 999px;
				background: #2563eb;
				color: #eff6ff;
				text-decoration: none;
				font-weight: 600;
			}
			.fallback p {
				margin: 0;
				font-size: 15px;
				line-height: 1.6;
				color: #cbd5e1;
			}
		</style>
	</head>
	<body>
		<div class="shell">
			<div class="card">
				<h1>${escapedFilename}</h1>
				<div class="meta">${escapedMimeType}</div>
				<div class="meta">${escapedRequestedPath}</div>
			</div>
			<div class="card viewer">
				${mediaMarkup}
			</div>
			<div id="error" class="card">
				Unable to open this file remotely. ${unsupportedHint}
			</div>
			<a class="button" href="${escapedContentUrl}" target="_blank" rel="noopener noreferrer">Open Raw File</a>
		</div>
		<script>
			const media = document.getElementById('media');
			const error = document.getElementById('error');
			if (media && error) {
				media.addEventListener('error', () => {
					error.style.display = 'block';
				});
			}
		</script>
	</body>
</html>`;
	}

	/**
	 * Register all API routes on the Fastify server
	 */
	registerRoutes(server: FastifyInstance): void {
		// Get all sessions (not just "live" ones - perimeter auth protects access)
		server.get(
			`${WEB_APP_API_BASE_PATH}/sessions`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async () => {
				const sessions = this.callbacks.getSessions ? await this.callbacks.getSessions() : [];

				// Enrich all sessions with live info if available
				const sessionData = sessions.map((s) => {
					const liveInfo = this.callbacks.getLiveSessionInfo?.(s.id);
					return {
						...s,
						agentSessionId: liveInfo?.agentSessionId || s.agentSessionId,
						liveEnabledAt: liveInfo?.enabledAt,
						isLive: this.callbacks.isSessionLive?.(s.id) || false,
					};
				});

				return {
					sessions: sessionData,
					count: sessionData.length,
					timestamp: Date.now(),
				};
			}
		);

		server.get(
			`${WEB_APP_API_BASE_PATH}/conductor`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (_request, reply) => {
				if (!this.callbacks.getConductorSnapshot) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Conductor service not configured',
						timestamp: Date.now(),
					});
				}

				const snapshot = await this.callbacks.getConductorSnapshot();
				return {
					...snapshot,
					timestamp: Date.now(),
				};
			}
		);

		server.post(
			`${WEB_APP_API_BASE_PATH}/conductor/tasks`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.maxPost,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				if (!this.callbacks.createConductorTask) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Conductor task creation is not configured',
						timestamp: Date.now(),
					});
				}

				const body = (request.body || {}) as {
					groupId?: string;
					title?: string;
					description?: string;
					priority?: ConductorTaskPriority;
					status?: ConductorTaskStatus;
				};

				if (!body.groupId || !body.title?.trim()) {
					return reply.code(400).send({
						error: 'Bad Request',
						message: 'groupId and title are required',
						timestamp: Date.now(),
					});
				}

				const success = await this.callbacks.createConductorTask({
					groupId: body.groupId,
					title: body.title.trim(),
					description: body.description?.trim() || '',
					priority: body.priority,
					status: body.status,
				});

				return reply.code(success ? 200 : 500).send({
					success,
					timestamp: Date.now(),
				});
			}
		);

		server.post(
			`${WEB_APP_API_BASE_PATH}/conductor/tasks/:taskId`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.maxPost,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				if (!this.callbacks.updateConductorTask) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Conductor task updates are not configured',
						timestamp: Date.now(),
					});
				}

				const { taskId } = request.params as { taskId: string };
				const body = (request.body || {}) as UpdateConductorTaskInput;
				const success = await this.callbacks.updateConductorTask(taskId, body);

				return reply.code(success ? 200 : 500).send({
					success,
					timestamp: Date.now(),
				});
			}
		);

		server.delete(
			`${WEB_APP_API_BASE_PATH}/conductor/tasks/:taskId`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.maxPost,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				if (!this.callbacks.deleteConductorTask) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Conductor task deletion is not configured',
						timestamp: Date.now(),
					});
				}

				const { taskId } = request.params as { taskId: string };
				const success = await this.callbacks.deleteConductorTask(taskId);
				return reply.code(success ? 200 : 500).send({
					success,
					timestamp: Date.now(),
				});
			}
		);

		server.post(
			`${WEB_APP_API_BASE_PATH}/conductor/workspaces/:groupId/open`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.maxPost,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				if (!this.callbacks.openConductorWorkspace) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Conductor workspace opening is not configured',
						timestamp: Date.now(),
					});
				}

				const { groupId } = request.params as { groupId: string };
				if (!groupId) {
					return reply.code(400).send({
						error: 'Bad Request',
						message: 'groupId is required',
						timestamp: Date.now(),
					});
				}

				const success = await this.callbacks.openConductorWorkspace(groupId);
				return reply.code(success ? 200 : 500).send({
					success,
					timestamp: Date.now(),
				});
			}
		);

		// Session detail endpoint - works for any valid session.
		// Optional ?tabId= query param to fetch logs for a specific tab (avoids race conditions)
		server.get(
			`${WEB_APP_API_BASE_PATH}/session/:id`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params as { id: string };
				const { tabId } = request.query as { tabId?: string };

				if (!this.callbacks.getSessionDetail) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Session detail service not configured',
						timestamp: Date.now(),
					});
				}

				const session = this.callbacks.getSessionDetail(id, tabId);
				if (!session) {
					return reply.code(404).send({
						error: 'Not Found',
						message: `Session with id '${id}' not found`,
						timestamp: Date.now(),
					});
				}

				const liveInfo = this.callbacks.getLiveSessionInfo?.(id);
				return {
					session: {
						...session,
						agentSessionId: liveInfo?.agentSessionId || session.agentSessionId,
						liveEnabledAt: liveInfo?.enabledAt,
						isLive: this.callbacks.isSessionLive?.(id) || false,
					},
					timestamp: Date.now(),
				};
			}
		);

		server.get(
			`${WEB_APP_API_BASE_PATH}/session/:id/models`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params as { id: string };
				const { forceRefresh } = request.query as { forceRefresh?: string };

				if (!this.callbacks.getSessionModels) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Session model discovery service not configured',
						timestamp: Date.now(),
					});
				}

				const models = await this.callbacks.getSessionModels(id, forceRefresh === 'true');
				return {
					models,
					timestamp: Date.now(),
				};
			}
		);

		server.get(
			`${WEB_APP_API_BASE_PATH}/session/:id/model-catalog`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params as { id: string };
				const { forceRefresh } = request.query as { forceRefresh?: string };

				if (!this.callbacks.getSessionModelCatalog) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Session model catalog service not configured',
						timestamp: Date.now(),
					});
				}

				const groups = await this.callbacks.getSessionModelCatalog(id, forceRefresh === 'true');
				return {
					groups,
					timestamp: Date.now(),
				};
			}
		);

		server.get(
			`${WEB_APP_API_BASE_PATH}/session/:id/provider-usage`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params as { id: string };
				const { forceRefresh } = request.query as { forceRefresh?: string };

				if (!this.callbacks.getSessionProviderUsage) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Provider usage service not configured',
						timestamp: Date.now(),
					});
				}

				const usage = await this.callbacks.getSessionProviderUsage(id, forceRefresh === 'true');
				return {
					usage,
					timestamp: Date.now(),
				};
			}
		);

		server.get(
			`${WEB_APP_API_BASE_PATH}/sessions/:id/demos`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params as { id: string };
				const { tabId } = request.query as { tabId?: string };

				if (!this.callbacks.getSessionDemos) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Demo listing service not configured',
						timestamp: Date.now(),
					});
				}

				const demos = await this.callbacks.getSessionDemos(id, tabId || null);
				return {
					demos,
					timestamp: Date.now(),
				};
			}
		);

		server.get(
			`${ROOT_SCOPED_API_BASE_PATH}/sessions/:id/demos`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params as { id: string };
				const { tabId } = request.query as { tabId?: string };

				if (!this.callbacks.getSessionDemos) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Demo listing service not configured',
						timestamp: Date.now(),
					});
				}

				const demos = await this.callbacks.getSessionDemos(id, tabId || null);
				return {
					demos,
					timestamp: Date.now(),
				};
			}
		);

		server.get(
			`${WEB_APP_API_BASE_PATH}/demos/:demoId`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { demoId } = request.params as { demoId: string };
				if (!this.callbacks.getDemoDetail) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Demo detail service not configured',
						timestamp: Date.now(),
					});
				}

				const demo = await this.callbacks.getDemoDetail(demoId);
				if (!demo) {
					return reply.code(404).send({
						error: 'Not Found',
						message: `Demo with id '${demoId}' not found`,
						timestamp: Date.now(),
					});
				}

				return {
					demo,
					timestamp: Date.now(),
				};
			}
		);

		server.get(
			`${ROOT_SCOPED_API_BASE_PATH}/demos/:demoId`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { demoId } = request.params as { demoId: string };
				if (!this.callbacks.getDemoDetail) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Demo detail service not configured',
						timestamp: Date.now(),
					});
				}

				const demo = await this.callbacks.getDemoDetail(demoId);
				if (!demo) {
					return reply.code(404).send({
						error: 'Not Found',
						message: `Demo with id '${demoId}' not found`,
						timestamp: Date.now(),
					});
				}

				return {
					demo,
					timestamp: Date.now(),
				};
			}
		);

		server.get(
			`${WEB_APP_API_BASE_PATH}/artifacts/:artifactId/content`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { artifactId } = request.params as { artifactId: string };

				if (!this.callbacks.getArtifactContent) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Artifact content service not configured',
						timestamp: Date.now(),
					});
				}

				const artifact = await this.callbacks.getArtifactContent(artifactId);
				if (!artifact) {
					return this.sendContentError(
						request,
						reply,
						404,
						'Not Found',
						`Artifact with id '${artifactId}' not found`
					);
				}

				return this.sendStreamableFile(request, reply, artifact);
			}
		);

		server.get(
			`${ROOT_SCOPED_API_BASE_PATH}/artifacts/:artifactId/content`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { artifactId } = request.params as { artifactId: string };

				if (!this.callbacks.getArtifactContent) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Artifact content service not configured',
						timestamp: Date.now(),
					});
				}

				const artifact = await this.callbacks.getArtifactContent(artifactId);
				if (!artifact) {
					return this.sendContentError(
						request,
						reply,
						404,
						'Not Found',
						`Artifact with id '${artifactId}' not found`
					);
				}

				return this.sendStreamableFile(request, reply, artifact);
			}
		);

		server.get(
			`${WEB_APP_API_BASE_PATH}/session/:id/local-file/content`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params as { id: string };
				const { path: requestedPath } = request.query as { path?: string };

				if (!requestedPath) {
					return this.sendContentError(
						request,
						reply,
						400,
						'Bad Request',
						'A local file path is required.'
					);
				}

				if (!this.callbacks.getSessionLocalFile) {
					return this.sendContentError(
						request,
						reply,
						503,
						'Service Unavailable',
						'Local file streaming is not configured.'
					);
				}

				const file = await this.callbacks.getSessionLocalFile(id, requestedPath);
				if ('errorCode' in file) {
					return this.sendContentError(
						request,
						reply,
						file.errorCode,
						'Local File Unavailable',
						file.message
					);
				}

				return this.sendStreamableFile(request, reply, file);
			}
		);

		server.get(
			`${WEB_APP_API_BASE_PATH}/session/:id/local-file/view`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params as { id: string };
				const { path: requestedPath } = request.query as { path?: string };

				if (!requestedPath) {
					return this.sendContentError(
						request,
						reply,
						400,
						'Bad Request',
						'A local file path is required.'
					);
				}

				if (!this.callbacks.getSessionLocalFile) {
					return this.sendContentError(
						request,
						reply,
						503,
						'Service Unavailable',
						'Local file streaming is not configured.'
					);
				}

				const file = await this.callbacks.getSessionLocalFile(id, requestedPath);
				if ('errorCode' in file) {
					return this.sendContentError(
						request,
						reply,
						file.errorCode,
						'Local File Unavailable',
						file.message
					);
				}

				const contentUrl = `${WEB_APP_API_BASE_PATH}/session/${encodeURIComponent(
					id
				)}/local-file/content?path=${encodeURIComponent(file.requestedPath)}`;
				reply.header('Cache-Control', 'private, no-store');
				return reply.type('text/html').send(
					this.buildLocalFileViewerHtml({
						filename: file.filename,
						mimeType: file.mimeType,
						contentUrl,
						requestedPath: file.requestedPath,
					})
				);
			}
		);

		server.post(
			`${WEB_APP_API_BASE_PATH}/transcribe`,
			{
				bodyLimit: 12 * 1024 * 1024,
				config: {
					rateLimit: {
						max: this.rateLimitConfig.maxPost,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const body = request.body as WebVoiceTranscriptionRequest | undefined;

				if (!body?.audioBase64 || !body?.mimeType) {
					return reply.code(400).send({
						error: 'Bad Request',
						message: 'audioBase64 and mimeType are required',
						timestamp: Date.now(),
					});
				}

				if (!this.callbacks.transcribeAudio) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Voice transcription service not configured',
						timestamp: Date.now(),
					});
				}

				try {
					const result = await this.callbacks.transcribeAudio(body);
					if (!result) {
						return reply.code(503).send({
							error: 'Service Unavailable',
							message: 'Voice transcription is unavailable',
							timestamp: Date.now(),
						});
					}

					return {
						...result,
						timestamp: Date.now(),
					};
				} catch (error) {
					logger.warn('Voice transcription request failed', LOG_CONTEXT, { error });
					return reply.code(500).send({
						error: 'Internal Server Error',
						message: error instanceof Error ? error.message : 'Voice transcription failed',
						timestamp: Date.now(),
					});
				}
			}
		);

		server.get(
			`${WEB_APP_API_BASE_PATH}/transcribe/status`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (_request, reply) => {
				if (!this.callbacks.getVoiceTranscriptionStatus) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Voice transcription status service not configured',
						timestamp: Date.now(),
					});
				}

				const status = await this.callbacks.getVoiceTranscriptionStatus();
				if (!status) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Voice transcription is unavailable',
						timestamp: Date.now(),
					});
				}

				return {
					...status,
					timestamp: Date.now(),
				};
			}
		);

		server.post(
			`${WEB_APP_API_BASE_PATH}/transcribe/prewarm`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.maxPost,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (_request, reply) => {
				if (!this.callbacks.prewarmVoiceTranscription) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Voice transcription prewarm service not configured',
						timestamp: Date.now(),
					});
				}

				try {
					const status = await this.callbacks.prewarmVoiceTranscription();
					if (!status) {
						return reply.code(503).send({
							error: 'Service Unavailable',
							message: 'Voice transcription is unavailable',
							timestamp: Date.now(),
						});
					}

					return {
						...status,
						timestamp: Date.now(),
					};
				} catch (error) {
					logger.warn('Voice transcription prewarm failed', LOG_CONTEXT, { error });
					return reply.code(500).send({
						error: 'Internal Server Error',
						message: error instanceof Error ? error.message : 'Voice transcription prewarm failed',
						timestamp: Date.now(),
					});
				}
			}
		);

		server.post(
			`${WEB_APP_API_BASE_PATH}/session/:id/model`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.maxPost,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params as { id: string };
				const body = request.body as { model?: string | null } | undefined;
				const model = typeof body?.model === 'string' ? body.model : (body?.model ?? null);

				if (!this.callbacks.setSessionModel) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Session model update service not configured',
						timestamp: Date.now(),
					});
				}

				const success = await this.callbacks.setSessionModel(
					id,
					model?.trim() ? model.trim() : null
				);
				if (!success) {
					return reply.code(500).send({
						error: 'Internal Server Error',
						message: 'Failed to update session model',
						timestamp: Date.now(),
					});
				}

				return {
					success: true,
					model: model?.trim() ? model.trim() : null,
					sessionId: id,
					timestamp: Date.now(),
				};
			}
		);

		server.post(
			`${WEB_APP_API_BASE_PATH}/session/:id/fork-thread`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.maxPost,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params as { id: string };
				const body = request.body as { toolType?: string; model?: string | null } | undefined;
				const nextToolType =
					body?.toolType === 'codex' ||
					body?.toolType === 'claude-code' ||
					body?.toolType === 'opencode' ||
					body?.toolType === 'factory-droid' ||
					body?.toolType === 'terminal'
						? (body.toolType as ToolType)
						: undefined;

				if (!this.callbacks.forkThread) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Thread forking service not configured',
						timestamp: Date.now(),
					});
				}

				const result = await this.callbacks.forkThread(id, {
					toolType: nextToolType,
					model: typeof body?.model === 'string' ? body.model : (body?.model ?? null),
				});

				if (!result.success) {
					return reply.code(500).send({
						error: 'Internal Server Error',
						message: 'Failed to fork thread',
						timestamp: Date.now(),
					});
				}

				return {
					success: true,
					sessionId: result.sessionId || null,
					timestamp: Date.now(),
				};
			}
		);

		// Send command to session - works for any valid session.
		server.post(
			`${WEB_APP_API_BASE_PATH}/session/:id/send`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.maxPost,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params as { id: string };
				const body = request.body as { command?: string } | undefined;
				const command = body?.command;

				if (!command || typeof command !== 'string') {
					return reply.code(400).send({
						error: 'Bad Request',
						message: 'Command is required and must be a string',
						timestamp: Date.now(),
					});
				}

				if (!this.callbacks.writeToSession) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Session write service not configured',
						timestamp: Date.now(),
					});
				}

				const success = this.callbacks.writeToSession(id, command + '\n');
				if (!success) {
					return reply.code(500).send({
						error: 'Internal Server Error',
						message: 'Failed to send command to session',
						timestamp: Date.now(),
					});
				}

				return {
					success: true,
					message: 'Command sent successfully',
					sessionId: id,
					timestamp: Date.now(),
				};
			}
		);

		// Theme endpoint
		server.get(
			`${WEB_APP_API_BASE_PATH}/theme`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (_request, reply) => {
				if (!this.callbacks.getTheme) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Theme service not configured',
						timestamp: Date.now(),
					});
				}

				const theme = this.callbacks.getTheme();
				if (!theme) {
					return reply.code(404).send({
						error: 'Not Found',
						message: 'No theme currently configured',
						timestamp: Date.now(),
					});
				}

				return {
					theme,
					timestamp: Date.now(),
				};
			}
		);

		// Interrupt session - works for any valid session.
		server.post(
			`${WEB_APP_API_BASE_PATH}/session/:id/interrupt`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.maxPost,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params as { id: string };

				if (!this.callbacks.interruptSession) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Session interrupt service not configured',
						timestamp: Date.now(),
					});
				}

				try {
					// Forward to desktop's interrupt logic - handles state updates and broadcasts
					const success = await this.callbacks.interruptSession(id);
					if (!success) {
						return reply.code(500).send({
							error: 'Internal Server Error',
							message: 'Failed to interrupt session',
							timestamp: Date.now(),
						});
					}

					return {
						success: true,
						message: 'Interrupt signal sent successfully',
						sessionId: id,
						timestamp: Date.now(),
					};
				} catch (error: any) {
					return reply.code(500).send({
						error: 'Internal Server Error',
						message: `Failed to interrupt session: ${error.message}`,
						timestamp: Date.now(),
					});
				}
			}
		);

		// History endpoint - returns history entries filtered by project/session
		server.get(
			`${WEB_APP_API_BASE_PATH}/history`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				if (!this.callbacks.getHistory) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'History service not configured',
						timestamp: Date.now(),
					});
				}

				// Extract optional projectPath and sessionId from query params
				const { projectPath, sessionId } = request.query as {
					projectPath?: string;
					sessionId?: string;
				};

				try {
					const entries = this.callbacks.getHistory(projectPath, sessionId);
					return {
						entries,
						count: entries.length,
						timestamp: Date.now(),
					};
				} catch (error: any) {
					return reply.code(500).send({
						error: 'Internal Server Error',
						message: `Failed to fetch history: ${error.message}`,
						timestamp: Date.now(),
					});
				}
			}
		);

		server.get(
			`${WEB_APP_API_BASE_PATH}/push/status`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.max,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				if (!this.callbacks.getPushStatus) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Push status service not configured',
						timestamp: Date.now(),
					});
				}

				const { endpoint } = request.query as { endpoint?: string };
				return {
					...this.callbacks.getPushStatus(endpoint),
					timestamp: Date.now(),
				};
			}
		);

		server.post(
			`${WEB_APP_API_BASE_PATH}/push/subscribe`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.maxPost,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				if (!this.callbacks.subscribePush) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Push subscribe service not configured',
						timestamp: Date.now(),
					});
				}

				const body = request.body as {
					subscription?: WebPushSubscriptionInput;
					deviceLabel?: string;
				};
				if (
					!body?.subscription?.endpoint ||
					!body.subscription.keys?.p256dh ||
					!body.subscription.keys?.auth
				) {
					return reply.code(400).send({
						error: 'Bad Request',
						message: 'A valid push subscription is required',
						timestamp: Date.now(),
					});
				}

				const record = this.callbacks.subscribePush(body.subscription, {
					userAgent: request.headers['user-agent'],
					deviceLabel: body.deviceLabel,
				});
				return {
					success: true,
					record,
					timestamp: Date.now(),
				};
			}
		);

		server.post(
			`${WEB_APP_API_BASE_PATH}/push/unsubscribe`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.maxPost,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				if (!this.callbacks.unsubscribePush) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Push unsubscribe service not configured',
						timestamp: Date.now(),
					});
				}

				const body = request.body as { endpoint?: string };
				if (!body?.endpoint) {
					return reply.code(400).send({
						error: 'Bad Request',
						message: 'Push endpoint is required',
						timestamp: Date.now(),
					});
				}

				return {
					success: this.callbacks.unsubscribePush(body.endpoint),
					timestamp: Date.now(),
				};
			}
		);

		server.post(
			`${WEB_APP_API_BASE_PATH}/push/test`,
			{
				config: {
					rateLimit: {
						max: this.rateLimitConfig.maxPost,
						timeWindow: this.rateLimitConfig.timeWindow,
					},
				},
			},
			async (request, reply) => {
				if (!this.callbacks.sendTestPush) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Push test service not configured',
						timestamp: Date.now(),
					});
				}

				const body = request.body as { endpoint?: string } | undefined;
				const success = await this.callbacks.sendTestPush(body?.endpoint);
				return {
					success,
					timestamp: Date.now(),
				};
			}
		);

		logger.debug('API routes registered', LOG_CONTEXT);
	}
}
