import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DemoArtifactService } from '../../../main/artifacts/DemoArtifactService';
import type {
	ArtifactRecord,
	CaptureRunRecord,
	DemoRecord,
	DemoStepRecord,
} from '../../../main/artifacts/types';
import type { SshRemoteConfig } from '../../../shared/types';

const { mockLogger, mockCaptureMessage } = vi.hoisted(() => ({
	mockLogger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
	mockCaptureMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => path.join(os.tmpdir(), 'maestro-artifacts-test-userdata')),
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: mockLogger,
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureMessage: mockCaptureMessage,
}));

function createPngBuffer(): Buffer {
	return Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
}

function createWebmBuffer(): Buffer {
	return Buffer.from('1a45dfa30100000000000000', 'hex');
}

class InMemoryArtifactsDb {
	private captureRuns = new Map<string, CaptureRunRecord>();
	private artifacts = new Map<string, ArtifactRecord>();
	private demos = new Map<string, DemoRecord>();
	private demoSteps = new Map<string, DemoStepRecord[]>();

	initialize(): void {}

	close(): void {}

	upsertCaptureRun(record: CaptureRunRecord): void {
		this.captureRuns.set(record.id, { ...record });
	}

	getCaptureRunByExternalId(
		sessionId: string,
		tabId: string | null,
		externalRunId: string
	): CaptureRunRecord | null {
		for (const record of this.captureRuns.values()) {
			if (
				record.sessionId === sessionId &&
				record.tabId === tabId &&
				record.externalRunId === externalRunId
			) {
				return { ...record };
			}
		}
		return null;
	}

	getCaptureRunById(id: string): CaptureRunRecord | null {
		const record = this.captureRuns.get(id);
		return record ? { ...record } : null;
	}

	listCaptureRunsByStatus(status: CaptureRunRecord['status']): CaptureRunRecord[] {
		return [...this.captureRuns.values()]
			.filter((record) => record.status === status)
			.map((record) => ({ ...record }));
	}

	listCaptureRunsOlderThan(cutoffMs: number): CaptureRunRecord[] {
		return [...this.captureRuns.values()]
			.filter((record) => record.updatedAt < cutoffMs)
			.map((record) => ({ ...record }));
	}

	insertArtifact(record: ArtifactRecord): void {
		this.artifacts.set(record.id, { ...record });
	}

	listArtifactsForCaptureRun(captureRunId: string): ArtifactRecord[] {
		return [...this.artifacts.values()]
			.filter((artifact) => artifact.captureRunId === captureRunId)
			.sort((left, right) => left.createdAt - right.createdAt)
			.map((artifact) => ({ ...artifact }));
	}

	getArtifactById(id: string): ArtifactRecord | null {
		const record = this.artifacts.get(id);
		return record ? { ...record } : null;
	}

	deleteArtifactsForCaptureRun(captureRunId: string): void {
		for (const [artifactId, artifact] of this.artifacts.entries()) {
			if (artifact.captureRunId === captureRunId) {
				this.artifacts.delete(artifactId);
			}
		}
	}

	upsertDemo(record: DemoRecord): void {
		this.demos.set(record.id, { ...record });
	}

	getDemoByCaptureRun(captureRunId: string): DemoRecord | null {
		for (const demo of this.demos.values()) {
			if (demo.captureRunId === captureRunId) {
				return { ...demo };
			}
		}
		return null;
	}

	getDemoById(id: string): DemoRecord | null {
		const record = this.demos.get(id);
		return record ? { ...record } : null;
	}

	listDemosForSession(sessionId: string, tabId?: string | null): DemoRecord[] {
		return [...this.demos.values()]
			.filter(
				(demo) => demo.sessionId === sessionId && (tabId === undefined || demo.tabId === tabId)
			)
			.sort((left, right) => right.createdAt - left.createdAt)
			.map((demo) => ({ ...demo }));
	}

	listDemosOlderThan(cutoffMs: number): DemoRecord[] {
		return [...this.demos.values()]
			.filter((demo) => demo.updatedAt < cutoffMs)
			.map((demo) => ({ ...demo }));
	}

	deleteDemo(id: string): void {
		this.demos.delete(id);
	}

	replaceDemoSteps(demoId: string, steps: DemoStepRecord[]): void {
		this.demoSteps.set(
			demoId,
			steps.map((step) => ({ ...step }))
		);
	}

	listDemoSteps(demoId: string): DemoStepRecord[] {
		return (this.demoSteps.get(demoId) || []).map((step) => ({ ...step }));
	}

	deleteDemoSteps(demoId: string): void {
		this.demoSteps.delete(demoId);
	}

	deleteCaptureRun(id: string): void {
		this.captureRuns.delete(id);
	}
}

describe('DemoArtifactService', () => {
	let tempDir: string;
	let artifactsDir: string;
	let nowMs: number;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-demo-artifacts-'));
		artifactsDir = path.join(tempDir, 'artifacts');
		nowMs = 1_700_000_000_000;
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function writeArtifactFile(filename: string, buffer: Buffer): Promise<string> {
		const fullPath = path.join(tempDir, filename);
		await fs.mkdir(path.dirname(fullPath), { recursive: true });
		await fs.writeFile(fullPath, buffer);
		return fullPath;
	}

	function createService(
		overrides: Partial<ConstructorParameters<typeof DemoArtifactService>[1]> = {},
		db = new InMemoryArtifactsDb()
	) {
		const service = new DemoArtifactService(db, {
			artifactsRoot: artifactsDir,
			now: () => nowMs,
			transcodeVideo: async (_sourcePath, outputPath) => {
				await fs.writeFile(outputPath, Buffer.from('mp4-derivative'));
				return { success: true };
			},
			...overrides,
		});
		return { db, service };
	}

	it('persists incremental capture state and finalizes a completed demo', async () => {
		const screenshotPath = await writeArtifactFile('source/step-1.png', createPngBuffer());
		const videoPath = await writeArtifactFile('source/demo.webm', createWebmBuffer());
		const { service } = createService();
		await service.initialize();

		await service.handleCaptureEvent({
			context: { sessionId: 'session-1', tabId: 'tab-1' },
			event: {
				type: 'capture_started',
				runId: 'run-1',
				title: 'Checkout demo',
				summary: 'Walk through checkout',
			},
		});

		await service.handleCaptureEvent({
			context: { sessionId: 'session-1', tabId: 'tab-1' },
			event: {
				type: 'step_created',
				runId: 'run-1',
				title: 'Cart loaded',
				description: 'Cart page is visible',
				path: screenshotPath,
				filename: 'cart.png',
				orderIndex: 0,
			},
		});

		await service.handleCaptureEvent({
			context: { sessionId: 'session-1', tabId: 'tab-1' },
			event: {
				type: 'artifact_created',
				runId: 'run-1',
				kind: 'video',
				path: videoPath,
				filename: 'demo.webm',
				role: 'video',
			},
		});

		const capturing = service.listSessionDemos('session-1', 'tab-1');
		expect(capturing).toHaveLength(1);
		expect(capturing[0].status).toBe('capturing');

		nowMs += 5_000;
		const finalCard = await service.handleCaptureEvent({
			context: { sessionId: 'session-1', tabId: 'tab-1' },
			event: {
				type: 'capture_completed',
				runId: 'run-1',
				title: 'Checkout demo',
				summary: 'Walk through checkout',
			},
		});

		expect(finalCard).not.toBeNull();
		expect(finalCard?.status).toBe('completed');
		expect(finalCard?.stepCount).toBe(1);
		expect(finalCard?.posterArtifact?.filename).toBe('cart.png');
		expect(finalCard?.videoArtifact?.filename).toBe('demo.mp4');

		const detail = service.getDemo(finalCard!.demoId);
		expect(detail?.steps).toHaveLength(1);
		expect(detail?.steps[0].title).toBe('Cart loaded');
		expect(detail?.videoArtifact?.mimeType).toBe('video/mp4');
	});

	it('recovers stale capturing runs as failed demos on initialize', async () => {
		const screenshotPath = await writeArtifactFile('source/stale-step.png', createPngBuffer());
		const db = new InMemoryArtifactsDb();
		const first = createService({ staleCaptureMs: 1_000 }, db);
		await first.service.initialize();

		await first.service.handleCaptureEvent({
			context: { sessionId: 'session-stale', tabId: 'tab-stale' },
			event: {
				type: 'capture_started',
				runId: 'stale-run',
				title: 'Stale capture',
			},
		});
		await first.service.handleCaptureEvent({
			context: { sessionId: 'session-stale', tabId: 'tab-stale' },
			event: {
				type: 'step_created',
				runId: 'stale-run',
				title: 'Before crash',
				path: screenshotPath,
				filename: 'stale-step.png',
			},
		});

		nowMs += 5_000;
		const second = createService({ staleCaptureMs: 1_000 }, db);
		await second.service.initialize();

		const demos = second.service.listSessionDemos('session-stale', 'tab-stale');
		expect(demos).toHaveLength(1);
		expect(demos[0].status).toBe('failed');
		expect(demos[0].stepCount).toBe(1);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			'Recovering stale demo capture as failed',
			'[DemoArtifactService]',
			expect.objectContaining({
				captureRunId: expect.any(String),
				sessionId: 'session-stale',
				tabId: 'tab-stale',
			})
		);
		expect(mockCaptureMessage).toHaveBeenCalledWith(
			'Recovering stale demo capture as failed',
			'warning',
			expect.objectContaining({
				context: '[DemoArtifactService]',
				sessionId: 'session-stale',
				tabId: 'tab-stale',
			})
		);
	});

	it('ingests remote SSH artifacts onto local storage before finalizing the demo', async () => {
		const remoteConfig: SshRemoteConfig = {
			id: 'remote-1',
			name: 'Remote 1',
			host: 'dev.example.com',
			port: 22,
			username: 'dev',
			privateKeyPath: '~/.ssh/id_ed25519',
			enabled: true,
		};
		const screenshotBuffer = createPngBuffer();
		const videoBuffer = createWebmBuffer();
		const { service } = createService({
			resolveSshRemote: (sshRemoteId) => (sshRemoteId === 'remote-1' ? remoteConfig : null),
			statRemoteArtifact: async (sourcePath) => {
				if (sourcePath.endsWith('.png')) {
					return {
						success: true,
						data: { size: screenshotBuffer.byteLength, isDirectory: false, mtime: nowMs },
					};
				}
				return {
					success: true,
					data: { size: videoBuffer.byteLength, isDirectory: false, mtime: nowMs },
				};
			},
			downloadRemoteArtifact: async (sourcePath, localPath) => {
				const buffer = sourcePath.endsWith('.png') ? screenshotBuffer : videoBuffer;
				await fs.mkdir(path.dirname(localPath), { recursive: true });
				await fs.writeFile(localPath, buffer);
				return {
					success: true,
					data: { byteSize: buffer.byteLength, mtime: nowMs },
				};
			},
		});
		await service.initialize();

		await service.handleCaptureEvent({
			context: {
				sessionId: 'session-remote',
				tabId: 'tab-remote',
				sshRemoteId: 'remote-1',
				sshRemoteHost: 'dev.example.com',
			},
			event: {
				type: 'capture_started',
				runId: 'remote-run',
				title: 'Remote demo',
			},
		});
		await service.handleCaptureEvent({
			context: {
				sessionId: 'session-remote',
				tabId: 'tab-remote',
				sshRemoteId: 'remote-1',
				sshRemoteHost: 'dev.example.com',
			},
			event: {
				type: 'step_created',
				runId: 'remote-run',
				title: 'Remote screenshot',
				path: '/remote/output/step.png',
				filename: 'step.png',
			},
		});
		await service.handleCaptureEvent({
			context: {
				sessionId: 'session-remote',
				tabId: 'tab-remote',
				sshRemoteId: 'remote-1',
				sshRemoteHost: 'dev.example.com',
			},
			event: {
				type: 'artifact_created',
				runId: 'remote-run',
				kind: 'video',
				path: '/remote/output/demo.webm',
				filename: 'demo.webm',
				role: 'video',
			},
		});

		const card = await service.handleCaptureEvent({
			context: {
				sessionId: 'session-remote',
				tabId: 'tab-remote',
				sshRemoteId: 'remote-1',
				sshRemoteHost: 'dev.example.com',
			},
			event: {
				type: 'capture_completed',
				runId: 'remote-run',
				title: 'Remote demo',
			},
		});

		expect(card?.status).toBe('completed');
		const detail = service.getDemo(card!.demoId);
		expect(detail?.posterArtifact?.filename).toBe('step.png');
		expect(detail?.videoArtifact?.filename).toBe('demo.mp4');
		const posterRecord = service.getArtifactRecord(detail!.posterArtifact!.id);
		expect(posterRecord?.originalPath).toBe('/remote/output/step.png');
		expect(posterRecord?.storedPath).toContain(artifactsDir);
	});

	it('cleans up expired artifacts and database records', async () => {
		const screenshotPath = await writeArtifactFile('source/cleanup-step.png', createPngBuffer());
		const videoPath = await writeArtifactFile('source/cleanup-video.webm', createWebmBuffer());
		const { service } = createService({ retentionMs: 500 });
		await service.initialize();

		await service.handleCaptureEvent({
			context: { sessionId: 'session-clean', tabId: 'tab-clean' },
			event: { type: 'capture_started', runId: 'clean-run', title: 'Cleanup demo' },
		});
		await service.handleCaptureEvent({
			context: { sessionId: 'session-clean', tabId: 'tab-clean' },
			event: {
				type: 'step_created',
				runId: 'clean-run',
				title: 'Step',
				path: screenshotPath,
				filename: 'cleanup-step.png',
			},
		});
		await service.handleCaptureEvent({
			context: { sessionId: 'session-clean', tabId: 'tab-clean' },
			event: {
				type: 'artifact_created',
				runId: 'clean-run',
				kind: 'video',
				path: videoPath,
				filename: 'cleanup-video.webm',
				role: 'video',
			},
		});
		const finalCard = await service.handleCaptureEvent({
			context: { sessionId: 'session-clean', tabId: 'tab-clean' },
			event: { type: 'capture_completed', runId: 'clean-run', title: 'Cleanup demo' },
		});
		expect(finalCard).not.toBeNull();

		nowMs += 1_000;
		await service.cleanupExpiredArtifacts();

		expect(service.listSessionDemos('session-clean', 'tab-clean')).toEqual([]);
		const remainingFiles = await fs.readdir(artifactsDir);
		expect(remainingFiles.filter((entry) => !entry.startsWith('.'))).toEqual([]);
	});

	it('rejects oversized and empty artifacts without crashing the capture', async () => {
		const emptyPath = await writeArtifactFile('source/empty.png', Buffer.alloc(0));
		const largePath = await writeArtifactFile('source/large.png', Buffer.from('123456'));
		const { service } = createService({ maxArtifactBytes: 4 });
		await service.initialize();

		await service.handleCaptureEvent({
			context: { sessionId: 'session-limit', tabId: 'tab-limit' },
			event: { type: 'capture_started', runId: 'limit-run', title: 'Limit demo' },
		});
		await service.handleCaptureEvent({
			context: { sessionId: 'session-limit', tabId: 'tab-limit' },
			event: {
				type: 'artifact_created',
				runId: 'limit-run',
				kind: 'image',
				path: emptyPath,
				filename: 'empty.png',
			},
		});
		await service.handleCaptureEvent({
			context: { sessionId: 'session-limit', tabId: 'tab-limit' },
			event: {
				type: 'artifact_created',
				runId: 'limit-run',
				kind: 'image',
				path: largePath,
				filename: 'large.png',
			},
		});

		const card = await service.handleCaptureEvent({
			context: { sessionId: 'session-limit', tabId: 'tab-limit' },
			event: { type: 'capture_failed', runId: 'limit-run', summary: 'No valid artifacts' },
		});

		expect(card?.status).toBe('failed');
		expect(card?.posterArtifact).toBeNull();
		expect(card?.videoArtifact).toBeNull();
		expect(mockLogger.warn).toHaveBeenCalledWith(
			'Skipping empty demo artifact',
			'[DemoArtifactService]',
			expect.objectContaining({
				sourcePath: emptyPath,
			})
		);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			'Skipping oversized demo artifact',
			'[DemoArtifactService]',
			expect.objectContaining({
				sourcePath: largePath,
				maxArtifactBytes: 4,
			})
		);
		expect(mockCaptureMessage).toHaveBeenCalledWith(
			'Skipping oversized demo artifact',
			'warning',
			expect.objectContaining({
				context: '[DemoArtifactService]',
				sourcePath: largePath,
			})
		);
	});
});
