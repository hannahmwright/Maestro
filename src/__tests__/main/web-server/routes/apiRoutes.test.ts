import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ApiRoutes,
	type ApiRouteCallbacks,
	type RateLimitConfig,
} from '../../../../main/web-server/routes/apiRoutes';
import { WEB_APP_API_BASE_PATH } from '../../../../shared/remote-web';

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

function createMockCallbacks(): ApiRouteCallbacks {
	return {
		getSessions: vi.fn().mockReturnValue([
			{
				id: 'session-1',
				name: 'Session 1',
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/test/project',
				groupId: null,
			},
		]),
		getSessionDetail: vi.fn().mockReturnValue({
			id: 'session-1',
			name: 'Session 1',
			toolType: 'claude-code',
			state: 'idle',
			inputMode: 'ai',
			cwd: '/test/project',
			aiTabs: [{ id: 'tab-1', name: 'Tab 1', logs: [] }],
			activeAITabId: 'tab-1',
		}),
		getSessionModels: vi.fn().mockResolvedValue([]),
		getSessionDemos: vi.fn().mockResolvedValue([]),
		getDemoDetail: vi.fn().mockResolvedValue(null),
		getArtifactContent: vi.fn().mockResolvedValue(null),
		getSessionLocalFile: vi.fn().mockResolvedValue({ errorCode: 404, message: 'missing' }),
		transcribeAudio: vi.fn().mockResolvedValue(null),
		getVoiceTranscriptionStatus: vi.fn().mockResolvedValue(null),
		prewarmVoiceTranscription: vi.fn().mockResolvedValue(null),
		getTheme: vi.fn().mockReturnValue({ id: 'dark', name: 'Dark' } as any),
		writeToSession: vi.fn().mockReturnValue(true),
		interruptSession: vi.fn().mockResolvedValue(true),
		setSessionModel: vi.fn().mockResolvedValue(true),
		getHistory: vi.fn().mockReturnValue([{ id: '1', command: 'test', timestamp: Date.now() }]),
		getLiveSessionInfo: vi.fn().mockReturnValue({
			sessionId: 'session-1',
			agentSessionId: 'live-123',
			enabledAt: 123456,
		}),
		isSessionLive: vi.fn().mockReturnValue(true),
		getPushStatus: vi.fn().mockReturnValue({ enabled: false, subscribed: false }),
		subscribePush: vi.fn(),
		unsubscribePush: vi.fn().mockReturnValue(false),
		sendTestPush: vi.fn().mockResolvedValue(false),
	};
}

function createMockFastify() {
	const routes: Map<string, { handler: Function; config?: any }> = new Map();

	return {
		get: vi.fn((path: string, options: any, handler?: Function) => {
			const h = handler || options;
			const config = handler ? options?.config : undefined;
			routes.set(`GET:${path}`, { handler: h, config });
		}),
		post: vi.fn((path: string, options: any, handler?: Function) => {
			const h = handler || options;
			const config = handler ? options?.config : undefined;
			routes.set(`POST:${path}`, { handler: h, config });
		}),
		delete: vi.fn((path: string, options: any, handler?: Function) => {
			const h = handler || options;
			const config = handler ? options?.config : undefined;
			routes.set(`DELETE:${path}`, { handler: h, config });
		}),
		getRoute: (method: string, path: string) => routes.get(`${method}:${path}`),
		routes,
	};
}

function createMockReply() {
	return {
		code: vi.fn().mockReturnThis(),
		send: vi.fn().mockReturnThis(),
		type: vi.fn().mockReturnThis(),
		header: vi.fn().mockReturnThis(),
	} as any;
}

describe('ApiRoutes', () => {
	const rateLimitConfig: RateLimitConfig = {
		max: 100,
		maxPost: 30,
		timeWindow: 60000,
		enabled: true,
	};

	let apiRoutes: ApiRoutes;
	let callbacks: ApiRouteCallbacks;
	let mockFastify: ReturnType<typeof createMockFastify>;

	beforeEach(() => {
		apiRoutes = new ApiRoutes(rateLimitConfig);
		callbacks = createMockCallbacks();
		apiRoutes.setCallbacks(callbacks);
		mockFastify = createMockFastify();
		apiRoutes.registerRoutes(mockFastify as any);
	});

	it('registers the core web API routes at the stable /app/api base path', () => {
		expect(mockFastify.routes.has(`GET:${WEB_APP_API_BASE_PATH}/sessions`)).toBe(true);
		expect(mockFastify.routes.has(`GET:${WEB_APP_API_BASE_PATH}/session/:id`)).toBe(true);
		expect(mockFastify.routes.has(`POST:${WEB_APP_API_BASE_PATH}/session/:id/send`)).toBe(true);
		expect(mockFastify.routes.has(`GET:${WEB_APP_API_BASE_PATH}/theme`)).toBe(true);
		expect(mockFastify.routes.has(`POST:${WEB_APP_API_BASE_PATH}/session/:id/interrupt`)).toBe(
			true
		);
		expect(mockFastify.routes.has(`GET:${WEB_APP_API_BASE_PATH}/history`)).toBe(true);
		expect(mockFastify.routes.has('GET:/api/sessions/:id/demos')).toBe(true);
		expect(mockFastify.routes.has('GET:/api/demos/:demoId')).toBe(true);
		expect(mockFastify.routes.has('GET:/api/artifacts/:artifactId/content')).toBe(true);
	});

	it('returns enriched sessions with live info', async () => {
		const route = mockFastify.getRoute('GET', `${WEB_APP_API_BASE_PATH}/sessions`);
		const result = await route!.handler();

		expect(callbacks.getSessions).toHaveBeenCalled();
		expect(result.sessions).toEqual([
			expect.objectContaining({
				id: 'session-1',
				agentSessionId: 'live-123',
				isLive: true,
				liveEnabledAt: 123456,
			}),
		]);
	});

	it('returns session detail and passes through tabId queries', async () => {
		const route = mockFastify.getRoute('GET', `${WEB_APP_API_BASE_PATH}/session/:id`);
		const reply = createMockReply();
		const result = await route!.handler(
			{ params: { id: 'session-1' }, query: { tabId: 'tab-5' } },
			reply
		);

		expect(callbacks.getSessionDetail).toHaveBeenCalledWith('session-1', 'tab-5');
		expect(result.session).toEqual(
			expect.objectContaining({
				id: 'session-1',
				agentSessionId: 'live-123',
				isLive: true,
			})
		);
	});

	it('returns 404 when session detail is missing', async () => {
		vi.mocked(callbacks.getSessionDetail).mockReturnValueOnce(null);
		const route = mockFastify.getRoute('GET', `${WEB_APP_API_BASE_PATH}/session/:id`);
		const reply = createMockReply();

		await route!.handler({ params: { id: 'missing' }, query: {} }, reply);

		expect(reply.code).toHaveBeenCalledWith(404);
		expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: 'Not Found' }));
	});

	it('sends commands to the session with a trailing newline', async () => {
		const route = mockFastify.getRoute('POST', `${WEB_APP_API_BASE_PATH}/session/:id/send`);
		const reply = createMockReply();
		const result = await route!.handler(
			{ params: { id: 'session-1' }, body: { command: 'ls -la' } },
			reply
		);

		expect(result).toEqual(expect.objectContaining({ success: true, sessionId: 'session-1' }));
		expect(callbacks.writeToSession).toHaveBeenCalledWith('session-1', 'ls -la\n');
	});

	it('validates missing commands on send', async () => {
		const route = mockFastify.getRoute('POST', `${WEB_APP_API_BASE_PATH}/session/:id/send`);
		const reply = createMockReply();

		await route!.handler({ params: { id: 'session-1' }, body: {} }, reply);

		expect(reply.code).toHaveBeenCalledWith(400);
		expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: 'Bad Request' }));
	});

	it('returns theme data when available', async () => {
		const route = mockFastify.getRoute('GET', `${WEB_APP_API_BASE_PATH}/theme`);
		const result = await route!.handler();

		expect(result.theme).toEqual(expect.objectContaining({ id: 'dark', name: 'Dark' }));
	});

	it('returns history entries and passes filters through', async () => {
		const route = mockFastify.getRoute('GET', `${WEB_APP_API_BASE_PATH}/history`);
		const result = await route!.handler({
			query: { projectPath: '/test/project', sessionId: 'session-1' },
		});

		expect(callbacks.getHistory).toHaveBeenCalledWith('/test/project', 'session-1');
		expect(result.entries).toHaveLength(1);
	});
});
