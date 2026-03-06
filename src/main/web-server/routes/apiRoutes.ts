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

import { FastifyInstance } from 'fastify';
import {
	WEB_APP_API_BASE_PATH,
	type PushStatusResponse,
	type PushSubscriptionRecord,
	type WebVoiceTranscriptionRequest,
	type WebVoiceTranscriptionResponse,
	type WebVoiceTranscriptionStatusResponse,
	type WebPushSubscriptionInput,
} from '../../../shared/remote-web';
import { HistoryEntry } from '../../../shared/types';
import { logger } from '../../utils/logger';
import type { Theme, SessionData, SessionDetail, LiveSessionInfo, RateLimitConfig } from '../types';

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

/**
 * Callbacks required by API routes
 */
export interface ApiRouteCallbacks {
	getSessions: () => Promise<SessionData[]> | SessionData[];
	getSessionDetail: (sessionId: string, tabId?: string) => SessionDetail | null;
	getSessionModels: (sessionId: string, forceRefresh?: boolean) => Promise<string[]> | string[];
	transcribeAudio: (
		request: WebVoiceTranscriptionRequest
	) => Promise<WebVoiceTranscriptionResponse | null>;
	getVoiceTranscriptionStatus: () => Promise<WebVoiceTranscriptionStatusResponse | null>;
	prewarmVoiceTranscription: () => Promise<WebVoiceTranscriptionStatusResponse | null>;
	getTheme: () => Theme | null;
	writeToSession: (sessionId: string, data: string) => boolean;
	interruptSession: (sessionId: string) => Promise<boolean>;
	setSessionModel: (sessionId: string, model: string | null) => Promise<boolean> | boolean;
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
