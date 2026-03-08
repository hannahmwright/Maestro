/**
 * WebServer - HTTP and WebSocket server for remote access
 *
 * Architecture:
 * - Single server on random port
 * - Routes: /app (dashboard), /app/session/:id (session view)
 * - Live sessions: Only sessions marked as "live" appear in dashboard
 * - WebSocket: Real-time updates for session state, logs, theme
 * - Optional legacy token redirects preserved for compatibility only
 *
 * URL Structure:
 *   http://localhost:PORT/app                      → Dashboard (all live sessions)
 *   http://localhost:PORT/app/session/$UUID        → Single session view
 *   http://localhost:PORT/app/api/*                → REST API
 *   http://localhost:PORT/app/ws                   → WebSocket
 *
 * Security:
 * - Stable browser-facing scope for Cloudflare Access and PWA installability
 * - Legacy token regenerated on each app restart for internal compatibility redirects
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import path from 'path';
import { existsSync } from 'fs';
import { getLocalIpAddressSync } from '../utils/networkUtils';
import { logger } from '../utils/logger';
import { WebPushManager } from '../web-push-manager';
import { WebSocketMessageHandler } from './handlers';
import { BroadcastService } from './services';
import { ApiRoutes, StaticRoutes, WsRoute } from './routes';
import { LiveSessionManager, CallbackRegistry } from './managers';
import {
	WEB_APP_ASSETS_PATH,
	WEB_APP_BASE_PATH,
	WEB_APP_ICONS_PATH,
	type ResponseCompletedEvent,
	type WebRemoteLogEntry,
} from '../../shared/remote-web';

// Import shared types from canonical location
import type {
	Theme,
	LiveSessionInfo,
	RateLimitConfig,
	AITabData,
	CustomAICommand,
	AutoRunState,
	CliActivity,
	SessionBroadcastData,
	SessionData,
	WebClient,
	WebClientMessage,
	GetSessionsCallback,
	GetSessionDetailCallback,
	GetSessionModelsCallback,
	GetSessionDemosCallback,
	GetDemoDetailCallback,
	GetArtifactContentCallback,
	GetSessionLocalFileCallback,
	GetVoiceTranscriptionStatusCallback,
	TranscribeAudioCallback,
	PrewarmVoiceTranscriptionCallback,
	WriteToSessionCallback,
	ExecuteCommandCallback,
	InterruptSessionCallback,
	SetSessionModelCallback,
	SwitchModeCallback,
	SelectSessionCallback,
	SelectTabCallback,
	NewTabCallback,
	DeleteSessionCallback,
	CloseTabCallback,
	RenameTabCallback,
	StarTabCallback,
	ReorderTabCallback,
	ToggleBookmarkCallback,
	GetThemeCallback,
	GetCustomCommandsCallback,
	GetHistoryCallback,
} from './types';

// Logger context for all web server logs
const LOG_CONTEXT = 'WebServer';

// Default rate limit configuration
const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
	max: 100, // 100 requests per minute for GET endpoints
	timeWindow: 60000, // 1 minute in milliseconds
	maxPost: 30, // 30 requests per minute for POST endpoints (more restrictive)
	enabled: true,
};

export class WebServer {
	private server: FastifyInstance;
	private port: number;
	private isRunning: boolean = false;
	private webClients: Map<string, WebClient> = new Map();
	private rateLimitConfig: RateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG };
	private webAssetsPath: string | null = null;

	// Security token - regenerated on each app startup
	private securityToken: string;

	// Local IP address for generating URLs (detected at startup)
	private localIpAddress: string = 'localhost';

	// Extracted managers
	private liveSessionManager: LiveSessionManager;
	private callbackRegistry: CallbackRegistry;

	// WebSocket message handler instance
	private messageHandler: WebSocketMessageHandler;

	// Broadcast service instance
	private broadcastService: BroadcastService;
	private webPushManager: WebPushManager;
	private liveSessionOverrides: Map<string, Partial<SessionData>> = new Map();
	private removedSessionIds: Set<string> = new Set();

	// Route instances
	private apiRoutes: ApiRoutes;
	private staticRoutes: StaticRoutes;
	private wsRoute: WsRoute;

	constructor(port: number = 0) {
		// Use port 0 to let OS assign a random available port
		this.port = port;
		this.server = Fastify({
			logger: {
				level: 'info',
			},
		});

		// Generate a new security token (UUID v4)
		this.securityToken = randomUUID();
		logger.debug('Security token generated', LOG_CONTEXT);

		// Determine web assets path (production vs development)
		this.webAssetsPath = this.resolveWebAssetsPath();

		// Initialize managers
		this.liveSessionManager = new LiveSessionManager();
		this.callbackRegistry = new CallbackRegistry();

		// Initialize the WebSocket message handler
		this.messageHandler = new WebSocketMessageHandler();

		// Initialize the broadcast service
		this.broadcastService = new BroadcastService();
		this.broadcastService.setGetWebClientsCallback(() => this.webClients);
		this.webPushManager = new WebPushManager();

		// Wire up live session manager to broadcast service
		this.liveSessionManager.setBroadcastCallbacks({
			broadcastSessionLive: (sessionId, agentSessionId) =>
				this.broadcastService.broadcastSessionLive(sessionId, agentSessionId),
			broadcastSessionOffline: (sessionId) =>
				this.broadcastService.broadcastSessionOffline(sessionId),
			broadcastAutoRunState: (sessionId, state) =>
				this.broadcastService.broadcastAutoRunState(sessionId, state),
		});

		// Initialize route handlers
		this.apiRoutes = new ApiRoutes(this.rateLimitConfig);
		this.staticRoutes = new StaticRoutes(this.securityToken, this.webAssetsPath, {
			getPushPublicKey: () => this.webPushManager.getPublicKey(),
		});
		this.wsRoute = new WsRoute();

		// Note: setupMiddleware and setupRoutes are called in start() to handle async properly
	}

	/**
	 * Resolve the path to web assets
	 * In production: dist/web relative to app root
	 * In development: same location but might not exist until built
	 */
	private resolveWebAssetsPath(): string | null {
		// Try multiple locations for the web assets
		const possiblePaths = [
			// Production: relative to the compiled main process
			path.join(__dirname, '..', '..', 'web'),
			// Development: from project root
			path.join(process.cwd(), 'dist', 'web'),
			// Alternative: relative to __dirname going up to dist
			path.join(__dirname, '..', 'web'),
		];

		for (const p of possiblePaths) {
			if (existsSync(path.join(p, 'index.html'))) {
				logger.debug(`Web assets found at: ${p}`, LOG_CONTEXT);
				return p;
			}
		}

		logger.warn(
			'Web assets not found. Web interface will not be served. Run "npm run build:web" to build web assets.',
			LOG_CONTEXT
		);
		return null;
	}

	// ============ Live Session Management (Delegated to LiveSessionManager) ============

	/**
	 * Mark a session as live (visible in web interface)
	 */
	setSessionLive(sessionId: string, agentSessionId?: string): void {
		this.liveSessionManager.setSessionLive(sessionId, agentSessionId);
	}

	/**
	 * Mark a session as offline (no longer visible in web interface)
	 */
	setSessionOffline(sessionId: string): void {
		this.liveSessionManager.setSessionOffline(sessionId);
	}

	/**
	 * Check if a session is currently live
	 */
	isSessionLive(sessionId: string): boolean {
		return this.liveSessionManager.isSessionLive(sessionId);
	}

	/**
	 * Get all live session IDs
	 */
	getLiveSessions(): LiveSessionInfo[] {
		return this.liveSessionManager.getLiveSessions();
	}

	/**
	 * Get the security token (for constructing URLs)
	 */
	getSecurityToken(): string {
		return this.securityToken;
	}

	/**
	 * Get the public dashboard URL.
	 */
	getSecureUrl(): string {
		return `http://${this.localIpAddress}:${this.port}${WEB_APP_BASE_PATH}`;
	}

	/**
	 * Get URL for a specific session
	 * Uses the detected local IP address for LAN accessibility
	 */
	getSessionUrl(sessionId: string): string {
		return `http://${this.localIpAddress}:${this.port}${WEB_APP_BASE_PATH}/session/${sessionId}`;
	}

	// ============ Callback Setters (Delegated to CallbackRegistry) ============

	setGetSessionsCallback(callback: GetSessionsCallback): void {
		this.callbackRegistry.setGetSessionsCallback(callback);
	}

	setGetSessionDetailCallback(callback: GetSessionDetailCallback): void {
		this.callbackRegistry.setGetSessionDetailCallback(callback);
	}

	setGetSessionModelsCallback(callback: GetSessionModelsCallback): void {
		this.callbackRegistry.setGetSessionModelsCallback(callback);
	}

	setGetSessionDemosCallback(callback: GetSessionDemosCallback): void {
		this.callbackRegistry.setGetSessionDemosCallback(callback);
	}

	setGetDemoDetailCallback(callback: GetDemoDetailCallback): void {
		this.callbackRegistry.setGetDemoDetailCallback(callback);
	}

	setGetArtifactContentCallback(callback: GetArtifactContentCallback): void {
		this.callbackRegistry.setGetArtifactContentCallback(callback);
	}

	setGetSessionLocalFileCallback(callback: GetSessionLocalFileCallback): void {
		this.callbackRegistry.setGetSessionLocalFileCallback(callback);
	}

	setTranscribeAudioCallback(callback: TranscribeAudioCallback): void {
		this.callbackRegistry.setTranscribeAudioCallback(callback);
	}

	setGetVoiceTranscriptionStatusCallback(callback: GetVoiceTranscriptionStatusCallback): void {
		this.callbackRegistry.setGetVoiceTranscriptionStatusCallback(callback);
	}

	setPrewarmVoiceTranscriptionCallback(callback: PrewarmVoiceTranscriptionCallback): void {
		this.callbackRegistry.setPrewarmVoiceTranscriptionCallback(callback);
	}

	setGetThemeCallback(callback: GetThemeCallback): void {
		this.callbackRegistry.setGetThemeCallback(callback);
	}

	setGetCustomCommandsCallback(callback: GetCustomCommandsCallback): void {
		this.callbackRegistry.setGetCustomCommandsCallback(callback);
	}

	setWriteToSessionCallback(callback: WriteToSessionCallback): void {
		this.callbackRegistry.setWriteToSessionCallback(callback);
	}

	setExecuteCommandCallback(callback: ExecuteCommandCallback): void {
		this.callbackRegistry.setExecuteCommandCallback(callback);
	}

	setInterruptSessionCallback(callback: InterruptSessionCallback): void {
		this.callbackRegistry.setInterruptSessionCallback(callback);
	}

	setSetSessionModelCallback(callback: SetSessionModelCallback): void {
		this.callbackRegistry.setSetSessionModelCallback(callback);
	}

	setSwitchModeCallback(callback: SwitchModeCallback): void {
		this.callbackRegistry.setSwitchModeCallback(callback);
	}

	setSelectSessionCallback(callback: SelectSessionCallback): void {
		this.callbackRegistry.setSelectSessionCallback(callback);
	}

	setSelectTabCallback(callback: SelectTabCallback): void {
		this.callbackRegistry.setSelectTabCallback(callback);
	}

	setNewTabCallback(callback: NewTabCallback): void {
		this.callbackRegistry.setNewTabCallback(callback);
	}

	setDeleteSessionCallback(callback: DeleteSessionCallback): void {
		this.callbackRegistry.setDeleteSessionCallback(callback);
	}

	setCloseTabCallback(callback: CloseTabCallback): void {
		this.callbackRegistry.setCloseTabCallback(callback);
	}

	setRenameTabCallback(callback: RenameTabCallback): void {
		this.callbackRegistry.setRenameTabCallback(callback);
	}

	setStarTabCallback(callback: StarTabCallback): void {
		this.callbackRegistry.setStarTabCallback(callback);
	}

	setReorderTabCallback(callback: ReorderTabCallback): void {
		this.callbackRegistry.setReorderTabCallback(callback);
	}

	setToggleBookmarkCallback(callback: ToggleBookmarkCallback): void {
		this.callbackRegistry.setToggleBookmarkCallback(callback);
	}

	setGetHistoryCallback(callback: GetHistoryCallback): void {
		this.callbackRegistry.setGetHistoryCallback(callback);
	}

	// ============ Rate Limiting ============

	setRateLimitConfig(config: Partial<RateLimitConfig>): void {
		this.rateLimitConfig = { ...this.rateLimitConfig, ...config };
		logger.info(
			`Rate limiting ${this.rateLimitConfig.enabled ? 'enabled' : 'disabled'} (max: ${this.rateLimitConfig.max}/min, maxPost: ${this.rateLimitConfig.maxPost}/min)`,
			LOG_CONTEXT
		);
	}

	getRateLimitConfig(): RateLimitConfig {
		return { ...this.rateLimitConfig };
	}

	// ============ Server Setup ============

	private async setupMiddleware(): Promise<void> {
		// Enable CORS for web access
		await this.server.register(cors, {
			origin: true,
		});

		// Enable WebSocket support
		await this.server.register(websocket);

		// Enable rate limiting for web interface endpoints to prevent abuse
		await this.server.register(rateLimit, {
			global: false,
			max: this.rateLimitConfig.max,
			timeWindow: this.rateLimitConfig.timeWindow,
			errorResponseBuilder: (_request: FastifyRequest, context) => {
				return {
					statusCode: 429,
					error: 'Too Many Requests',
					message: `Rate limit exceeded. Try again later.`,
					retryAfter: context.after,
				};
			},
			allowList: (request: FastifyRequest) => {
				if (!this.rateLimitConfig.enabled) return true;
				if (request.url === '/health') return true;
				return false;
			},
			keyGenerator: (request: FastifyRequest) => {
				return request.ip;
			},
		});

		// Register static file serving for web assets
		if (this.webAssetsPath) {
			const assetsPath = path.join(this.webAssetsPath, 'assets');
			if (existsSync(assetsPath)) {
				await this.server.register(fastifyStatic, {
					root: assetsPath,
					prefix: `${WEB_APP_ASSETS_PATH}/`,
					decorateReply: false,
				});
			}

			// Register icons directory
			const iconsPath = path.join(this.webAssetsPath, 'icons');
			if (existsSync(iconsPath)) {
				await this.server.register(fastifyStatic, {
					root: iconsPath,
					prefix: `${WEB_APP_ICONS_PATH}/`,
					decorateReply: false,
				});
			}
		}
	}

	private setupRoutes(): void {
		const getMergedSessions = async () => this.getMergedSessions();

		// Setup static routes (dashboard, PWA files, health check)
		this.staticRoutes.registerRoutes(this.server);

		// Setup API routes callbacks and register routes
		this.apiRoutes.setCallbacks({
			getSessions: getMergedSessions,
			getSessionDetail: (sessionId, tabId) =>
				this.callbackRegistry.getSessionDetail(sessionId, tabId),
			getSessionModels: (sessionId, forceRefresh) =>
				this.callbackRegistry.getSessionModels(sessionId, forceRefresh),
			getSessionDemos: (sessionId, tabId) =>
				this.callbackRegistry.getSessionDemos(sessionId, tabId),
			getDemoDetail: (demoId) => this.callbackRegistry.getDemoDetail(demoId),
			getArtifactContent: (artifactId) => this.callbackRegistry.getArtifactContent(artifactId),
			getSessionLocalFile: (sessionId, requestedPath) =>
				this.callbackRegistry.getSessionLocalFile(sessionId, requestedPath),
			transcribeAudio: async (request) => this.callbackRegistry.transcribeAudio(request),
			getVoiceTranscriptionStatus: async () => this.callbackRegistry.getVoiceTranscriptionStatus(),
			prewarmVoiceTranscription: async () => this.callbackRegistry.prewarmVoiceTranscription(),
			getTheme: () => this.callbackRegistry.getTheme(),
			writeToSession: (sessionId, data) => this.callbackRegistry.writeToSession(sessionId, data),
			interruptSession: async (sessionId) => this.callbackRegistry.interruptSession(sessionId),
			setSessionModel: async (sessionId, model) =>
				this.callbackRegistry.setSessionModel(sessionId, model),
			getHistory: (projectPath, sessionId) =>
				this.callbackRegistry.getHistory(projectPath, sessionId),
			getLiveSessionInfo: (sessionId) => this.liveSessionManager.getLiveSessionInfo(sessionId),
			isSessionLive: (sessionId) => this.liveSessionManager.isSessionLive(sessionId),
			getPushStatus: (endpoint) => this.webPushManager.getStatus(endpoint),
			subscribePush: (subscription, metadata) =>
				this.webPushManager.subscribe(subscription, metadata),
			unsubscribePush: (endpoint) => this.webPushManager.unsubscribe(endpoint),
			sendTestPush: async (endpoint) => this.webPushManager.sendTestPush(endpoint),
		});
		this.apiRoutes.registerRoutes(this.server);

		// Setup WebSocket route callbacks and register route
		this.wsRoute.setCallbacks({
			getSessions: getMergedSessions,
			getTheme: () => this.callbackRegistry.getTheme(),
			getCustomCommands: () => this.callbackRegistry.getCustomCommands(),
			getAutoRunStates: () => this.liveSessionManager.getAutoRunStates(),
			getLiveSessionInfo: (sessionId) => this.liveSessionManager.getLiveSessionInfo(sessionId),
			isSessionLive: (sessionId) => this.liveSessionManager.isSessionLive(sessionId),
			onClientConnect: (client) => {
				this.webClients.set(client.id, client);
				logger.info(`Client connected: ${client.id} (total: ${this.webClients.size})`, LOG_CONTEXT);
			},
			onClientDisconnect: (clientId) => {
				this.webClients.delete(clientId);
				logger.info(
					`Client disconnected: ${clientId} (total: ${this.webClients.size})`,
					LOG_CONTEXT
				);
			},
			onClientError: (clientId) => {
				this.webClients.delete(clientId);
			},
			handleMessage: (clientId, message) => {
				this.handleWebClientMessage(clientId, message);
			},
		});
		this.wsRoute.registerRoute(this.server);
	}

	private handleWebClientMessage(clientId: string, message: WebClientMessage): void {
		const client = this.webClients.get(clientId);
		if (!client) return;
		this.messageHandler.handleMessage(client, message);
	}

	private setupMessageHandlerCallbacks(): void {
		this.messageHandler.setCallbacks({
			getSessionDetail: (sessionId: string) => this.callbackRegistry.getSessionDetail(sessionId),
			executeCommand: async (
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				images?: string[],
				textAttachments?: Array<{
					id?: string;
					name: string;
					content: string;
					mimeType?: string;
					size?: number;
				}>,
				attachments?: Array<{
					id?: string;
					kind: 'image' | 'file';
					name: string;
					mimeType?: string;
					size?: number;
				}>
			) =>
				this.callbackRegistry.executeCommand(
					sessionId,
					command,
					inputMode,
					images,
					textAttachments,
					attachments
				),
			switchMode: async (sessionId: string, mode: 'ai' | 'terminal') =>
				this.callbackRegistry.switchMode(sessionId, mode),
			selectSession: async (sessionId: string, tabId?: string) =>
				this.callbackRegistry.selectSession(sessionId, tabId),
			selectTab: async (sessionId: string, tabId: string) =>
				this.callbackRegistry.selectTab(sessionId, tabId),
			newTab: async (sessionId: string) => this.callbackRegistry.newTab(sessionId),
			deleteSession: async (sessionId: string) => this.callbackRegistry.deleteSession(sessionId),
			closeTab: async (sessionId: string, tabId: string) =>
				this.callbackRegistry.closeTab(sessionId, tabId),
			renameTab: async (sessionId: string, tabId: string, newName: string) =>
				this.callbackRegistry.renameTab(sessionId, tabId, newName),
			starTab: async (sessionId: string, tabId: string, starred: boolean) =>
				this.callbackRegistry.starTab(sessionId, tabId, starred),
			reorderTab: async (sessionId: string, fromIndex: number, toIndex: number) =>
				this.callbackRegistry.reorderTab(sessionId, fromIndex, toIndex),
			toggleBookmark: async (sessionId: string) => this.callbackRegistry.toggleBookmark(sessionId),
			getSessions: async () => this.getMergedSessions(),
			getLiveSessionInfo: (sessionId: string) =>
				this.liveSessionManager.getLiveSessionInfo(sessionId),
			isSessionLive: (sessionId: string) => this.liveSessionManager.isSessionLive(sessionId),
		});
	}

	// ============ Broadcast Methods (Delegated to BroadcastService) ============

	broadcastToWebClients(message: object): void {
		this.broadcastService.broadcastToAll(message);
	}

	broadcastToSessionClients(sessionId: string, message: object): void {
		this.broadcastService.broadcastToSession(sessionId, message);
	}

	broadcastSessionStateChange(
		sessionId: string,
		state: string,
		additionalData?: {
			name?: string;
			toolType?: string;
			inputMode?: string;
			cwd?: string;
			contextUsage?: number;
			effectiveContextWindow?: number | null;
			cliActivity?: CliActivity;
		}
	): void {
		this.removedSessionIds.delete(sessionId);
		this.liveSessionOverrides.set(sessionId, {
			...(this.liveSessionOverrides.get(sessionId) ?? {}),
			id: sessionId,
			state,
			...additionalData,
		});
		this.broadcastService.broadcastSessionStateChange(sessionId, state, additionalData);
	}

	broadcastSessionAdded(session: SessionBroadcastData): void {
		this.removedSessionIds.delete(session.id);
		this.liveSessionOverrides.set(session.id, {
			...(this.liveSessionOverrides.get(session.id) ?? {}),
			...session,
		});
		this.broadcastService.broadcastSessionAdded(session);
	}

	broadcastSessionRemoved(sessionId: string): void {
		this.liveSessionOverrides.delete(sessionId);
		this.removedSessionIds.add(sessionId);
		this.broadcastService.broadcastSessionRemoved(sessionId);
	}

	broadcastSessionsList(sessions: SessionBroadcastData[]): void {
		this.broadcastService.broadcastSessionsList(sessions);
	}

	broadcastActiveSessionChange(sessionId: string): void {
		this.broadcastService.broadcastActiveSessionChange(sessionId);
	}

	broadcastTabsChange(sessionId: string, aiTabs: AITabData[], activeTabId: string): void {
		this.removedSessionIds.delete(sessionId);
		this.liveSessionOverrides.set(sessionId, {
			...(this.liveSessionOverrides.get(sessionId) ?? {}),
			id: sessionId,
			aiTabs,
			activeTabId,
		});
		this.broadcastService.broadcastTabsChange(sessionId, aiTabs, activeTabId);
	}

	broadcastThemeChange(theme: Theme): void {
		this.broadcastService.broadcastThemeChange(theme);
	}

	broadcastCustomCommands(commands: CustomAICommand[]): void {
		this.broadcastService.broadcastCustomCommands(commands);
	}

	broadcastAutoRunState(sessionId: string, state: AutoRunState | null): void {
		this.liveSessionManager.setAutoRunState(sessionId, state);
	}

	broadcastUserInput(
		sessionId: string,
		command: string,
		inputMode: 'ai' | 'terminal',
		images?: string[],
		attachments?: Array<{
			id?: string;
			kind: 'image' | 'file';
			name: string;
			mimeType?: string;
			size?: number;
		}>
	): void {
		this.broadcastService.broadcastUserInput(sessionId, command, inputMode, images, attachments);
	}

	broadcastSessionLogEntry(
		sessionId: string,
		tabId: string | null,
		inputMode: 'ai' | 'terminal',
		logEntry: WebRemoteLogEntry
	): void {
		this.broadcastService.broadcastSessionLogEntry({
			sessionId,
			tabId,
			inputMode,
			logEntry,
		});
	}

	async broadcastResponseCompleted(event: ResponseCompletedEvent): Promise<void> {
		this.broadcastService.broadcastResponseCompleted(event);
		await this.webPushManager.sendResponseCompleted(event);
	}

	// ============ Server Lifecycle ============

	getWebClientCount(): number {
		return this.webClients.size;
	}

	async start(): Promise<{ port: number; token: string; url: string }> {
		if (this.isRunning) {
			return {
				port: this.port,
				token: this.securityToken,
				url: this.getSecureUrl(),
			};
		}

		try {
			// Detect local IP address for LAN accessibility (sync - no network delay)
			this.localIpAddress = getLocalIpAddressSync();
			logger.info(`Using IP address: ${this.localIpAddress}`, LOG_CONTEXT);

			// Setup middleware and routes (must be done before listen)
			await this.setupMiddleware();
			this.setupRoutes();

			// Wire up message handler callbacks
			this.setupMessageHandlerCallbacks();

			await this.server.listen({ port: this.port, host: '0.0.0.0' });

			// Get the actual port (important when using port 0 for random assignment)
			const address = this.server.server.address();
			if (address && typeof address === 'object') {
				this.port = address.port;
			}

			this.isRunning = true;

			return {
				port: this.port,
				token: this.securityToken,
				url: this.getSecureUrl(),
			};
		} catch (error) {
			logger.error('Failed to start server', LOG_CONTEXT, error);
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (!this.isRunning) {
			return;
		}

		// Clear all session state (handles live sessions and autorun states)
		this.liveSessionManager.clearAll();
		this.liveSessionOverrides.clear();
		this.removedSessionIds.clear();

		try {
			await this.server.close();
			this.isRunning = false;
			logger.info('Server stopped', LOG_CONTEXT);
		} catch (error) {
			logger.error('Failed to stop server', LOG_CONTEXT, error);
		}
	}

	getUrl(): string {
		return `http://${this.localIpAddress}:${this.port}`;
	}

	getPort(): number {
		return this.port;
	}

	isActive(): boolean {
		return this.isRunning;
	}

	getServer(): FastifyInstance {
		return this.server;
	}

	private async getMergedSessions(): Promise<SessionData[]> {
		const baseSessions = await this.callbackRegistry.getSessions();
		const mergedSessions = baseSessions
			.filter((session) => !this.removedSessionIds.has(session.id))
			.map((session) => ({
				...session,
				...(this.liveSessionOverrides.get(session.id) ?? {}),
			}));

		for (const [sessionId, override] of this.liveSessionOverrides.entries()) {
			if (this.removedSessionIds.has(sessionId) || !override.id) {
				continue;
			}

			if (!mergedSessions.some((session) => session.id === sessionId)) {
				mergedSessions.push(override as SessionData);
			}
		}

		return mergedSessions;
	}
}
