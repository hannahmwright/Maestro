import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StaticRoutes } from '../../../../main/web-server/routes/staticRoutes';
import {
	WEB_APP_BASE_PATH,
	WEB_APP_MANIFEST_PATH,
	WEB_APP_SERVICE_WORKER_PATH,
} from '../../../../shared/remote-web';

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

function createMockFastify() {
	const routes: Map<string, { handler: Function }> = new Map();

	return {
		get: vi.fn((path: string, handler: Function) => {
			routes.set(`GET:${path}`, { handler });
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
		redirect: vi.fn().mockReturnThis(),
	};
}

describe('StaticRoutes', () => {
	const securityToken = 'test-token-123';
	const webAssetsPath = '/path/to/web/assets';

	let staticRoutes: StaticRoutes;
	let mockFastify: ReturnType<typeof createMockFastify>;

	beforeEach(() => {
		vi.clearAllMocks();
		staticRoutes = new StaticRoutes(securityToken, webAssetsPath);
		mockFastify = createMockFastify();
		staticRoutes.registerRoutes(mockFastify as any);
	});

	it('registers the stable app routes and legacy token redirects', () => {
		expect(mockFastify.get).toHaveBeenCalledTimes(12);
		expect(mockFastify.routes.has('GET:/')).toBe(true);
		expect(mockFastify.routes.has('GET:/health')).toBe(true);
		expect(mockFastify.routes.has(`GET:${WEB_APP_MANIFEST_PATH}`)).toBe(true);
		expect(mockFastify.routes.has(`GET:${WEB_APP_SERVICE_WORKER_PATH}`)).toBe(true);
		expect(mockFastify.routes.has(`GET:${WEB_APP_BASE_PATH}`)).toBe(true);
		expect(mockFastify.routes.has(`GET:${WEB_APP_BASE_PATH}/`)).toBe(true);
		expect(mockFastify.routes.has(`GET:${WEB_APP_BASE_PATH}/session/:sessionId`)).toBe(true);
		expect(mockFastify.routes.has(`GET:${WEB_APP_BASE_PATH}/session/:sessionId/demo/:demoId`)).toBe(
			true
		);
		expect(mockFastify.routes.has(`GET:/${securityToken}`)).toBe(true);
		expect(mockFastify.routes.has(`GET:/${securityToken}/`)).toBe(true);
		expect(mockFastify.routes.has(`GET:/${securityToken}/session/:sessionId`)).toBe(true);
		expect(mockFastify.routes.has('GET:/:token')).toBe(true);
	});

	it('redirects root requests to the stable app scope', async () => {
		const route = mockFastify.getRoute('GET', '/');
		const reply = createMockReply();

		await route!.handler({}, reply);

		expect(reply.redirect).toHaveBeenCalledWith(302, WEB_APP_BASE_PATH);
	});

	it('returns a health payload', async () => {
		const route = mockFastify.getRoute('GET', '/health');
		const result = await route!.handler();

		expect(result.status).toBe('ok');
		expect(result.timestamp).toBeTypeOf('number');
	});

	it('returns missing-asset responses when web assets are unavailable', async () => {
		const noAssetsRoutes = new StaticRoutes(securityToken, null);
		const noAssetsFastify = createMockFastify();
		noAssetsRoutes.registerRoutes(noAssetsFastify as any);

		const manifestRoute = noAssetsFastify.getRoute('GET', WEB_APP_MANIFEST_PATH);
		const swRoute = noAssetsFastify.getRoute('GET', WEB_APP_SERVICE_WORKER_PATH);
		const appRoute = noAssetsFastify.getRoute('GET', WEB_APP_BASE_PATH);
		const reply = createMockReply();

		await manifestRoute!.handler({}, reply);
		expect(reply.code).toHaveBeenCalledWith(404);

		reply.code.mockClear();
		reply.send.mockClear();
		await swRoute!.handler({}, reply);
		expect(reply.code).toHaveBeenCalledWith(404);

		reply.code.mockClear();
		reply.send.mockClear();
		await appRoute!.handler({}, reply);
		expect(reply.code).toHaveBeenCalledWith(503);
		expect(reply.send).toHaveBeenCalledWith(
			expect.objectContaining({ error: 'Service Unavailable' })
		);
	});

	it('redirects invalid token requests to the website', async () => {
		const route = mockFastify.getRoute('GET', '/:token');
		const reply = createMockReply();

		await route!.handler({ params: { token: 'invalid-token' } }, reply);

		expect(reply.redirect).toHaveBeenCalledWith(302, 'https://runmaestro.ai');
	});

	it('keeps legacy redirects for the configured security token', async () => {
		const route = mockFastify.getRoute('GET', `/${securityToken}/session/:sessionId`);
		const reply = createMockReply();

		await route!.handler(
			{
				params: { sessionId: 'session-123' },
				query: { tabId: 'tab-456' },
			},
			reply
		);

		expect(reply.redirect).toHaveBeenCalledWith(
			302,
			`${WEB_APP_BASE_PATH}/session/session-123?tabId=tab-456`
		);
	});

	it('sanitizes session and tab ids for injected config', () => {
		const sanitizeId = (staticRoutes as any).sanitizeId.bind(staticRoutes);

		expect(sanitizeId('session-1')).toBe('session-1');
		expect(sanitizeId('tab_123')).toBe('tab_123');
		expect(sanitizeId('<script>alert(1)</script>')).toBeNull();
		expect(sanitizeId('session?alert=1')).toBeNull();
		expect(sanitizeId('../../../etc/passwd')).toBeNull();
	});
});
