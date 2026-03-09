import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ApiRoutes } from '../../../../main/web-server/routes/apiRoutes';
import { WEB_APP_API_BASE_PATH } from '../../../../shared/remote-web';

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

describe('demo artifact API routes', () => {
	let tempDir: string;
	let artifactPath: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-demo-routes-'));
		artifactPath = path.join(tempDir, 'artifact.webm');
		await fs.writeFile(artifactPath, Buffer.from('video-content'));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function createServer(getArtifactContent: (artifactId: string) => any) {
		const server = fastify();
		const routes = new ApiRoutes({
			max: 100,
			maxPost: 20,
			timeWindow: 60_000,
			enabled: true,
		});
		routes.setCallbacks({
			getSessions: () => [],
			getSessionDetail: () => null,
			getSessionModels: async () => [],
			getSessionDemos: () => [],
			getDemoDetail: () => null,
			getArtifactContent,
			transcribeAudio: async () => null,
			getVoiceTranscriptionStatus: async () => null,
			prewarmVoiceTranscription: async () => null,
			getTheme: () => null,
			writeToSession: () => false,
			interruptSession: async () => false,
			setSessionModel: async () => false,
			getHistory: () => [],
			getLiveSessionInfo: () => undefined,
			isSessionLive: () => false,
			getPushStatus: () => ({ enabled: false, subscribed: false }),
			subscribePush: () => {
				throw new Error('not used');
			},
			unsubscribePush: () => false,
			sendTestPush: async () => false,
		});
		routes.registerRoutes(server);
		return server;
	}

	it('streams artifact content with range support', async () => {
		const server = createServer(() => ({
			path: artifactPath,
			mimeType: 'video/webm',
			filename: 'artifact.webm',
		}));

		const response = await server.inject({
			method: 'GET',
			url: `${WEB_APP_API_BASE_PATH}/artifacts/demo-1/content`,
			headers: { range: 'bytes=0-4' },
		});

		expect(response.statusCode).toBe(206);
		expect(response.headers['content-range']).toBe('bytes 0-4/13');
		expect(response.headers['accept-ranges']).toBe('bytes');
		expect(response.headers['cache-control']).toBe('private, no-store');
		expect(response.body).toBe('video');

		await server.close();
	});

	it('returns 404 when artifact metadata exists but the file is missing', async () => {
		const missingPath = path.join(tempDir, 'missing.webm');
		const server = createServer(() => ({
			path: missingPath,
			mimeType: 'video/webm',
			filename: 'missing.webm',
		}));

		const response = await server.inject({
			method: 'GET',
			url: `${WEB_APP_API_BASE_PATH}/artifacts/demo-2/content`,
		});

		expect(response.statusCode).toBe(404);
		expect(response.json().message).toContain('no longer available');

		await server.close();
	});

	it('returns 416 for invalid range requests', async () => {
		const server = createServer(() => ({
			path: artifactPath,
			mimeType: 'video/webm',
			filename: 'artifact.webm',
		}));

		const response = await server.inject({
			method: 'GET',
			url: `${WEB_APP_API_BASE_PATH}/artifacts/demo-3/content`,
			headers: { range: 'bytes=99-120' },
		});

		expect(response.statusCode).toBe(416);

		await server.close();
	});
});
