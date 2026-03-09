import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { app } from 'electron';
import { execFileNoThrow } from '../utils/execFile';
import {
	downloadFileRemote,
	statRemote,
	type RemoteFsResult,
	type RemoteStatResult,
} from '../utils/remote-fs';
import { logger } from '../utils/logger';
import { captureMessage } from '../utils/sentry';
import type { SshRemoteConfig } from '../../shared/types';
import type {
	ArtifactRef,
	DemoCard,
	DemoCaptureEvent,
	DemoDetail,
	DemoStep,
	DemoStatus,
} from '../../shared/demo-artifacts';
import { ArtifactsDB } from './ArtifactsDB';
import type {
	ArtifactRecord,
	CaptureRunRecord,
	DemoCaptureContext,
	DemoCaptureEventInput,
	DemoRecord,
	DemoStepRecord,
} from './types';

const LOG_CONTEXT = '[DemoArtifactService]';
const ARTIFACTS_DIRNAME = 'artifacts';
const DEFAULT_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_STALE_CAPTURE_MS = 30 * 60 * 1000;

export interface DemoArtifactServiceOptions {
	artifactsRoot?: string;
	now?: () => number;
	maxArtifactBytes?: number;
	retentionMs?: number;
	staleCaptureMs?: number;
	transcodeVideo?: (
		sourcePath: string,
		outputPath: string
	) => Promise<{ success: boolean; stderr?: string }>;
	resolveSshRemote?: (sshRemoteId: string) => SshRemoteConfig | null;
	statRemoteArtifact?: (
		sourcePath: string,
		sshRemote: SshRemoteConfig
	) => Promise<RemoteFsResult<RemoteStatResult>>;
	downloadRemoteArtifact?: (
		sourcePath: string,
		localPath: string,
		sshRemote: SshRemoteConfig
	) => Promise<RemoteFsResult<{ byteSize: number; mtime: number }>>;
}

function guessMimeType(
	filePath: string,
	explicitMimeType?: string,
	kind?: ArtifactRecord['kind']
): string {
	if (explicitMimeType) {
		return explicitMimeType;
	}
	const ext = path.extname(filePath).toLowerCase();
	if (ext === '.png') return 'image/png';
	if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
	if (ext === '.webp') return 'image/webp';
	if (ext === '.gif') return 'image/gif';
	if (ext === '.svg') return 'image/svg+xml';
	if (ext === '.mp4') return 'video/mp4';
	if (ext === '.webm') return 'video/webm';
	if (kind === 'video') return 'video/mp4';
	if (kind === 'image') return 'image/png';
	return 'application/octet-stream';
}

function sanitizeFilename(filename: string): string {
	const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '-');
	return base.length > 0 ? base : 'artifact';
}

export class DemoArtifactService {
	private readonly db: ArtifactsDB;
	private readonly artifactsRoot: string;
	private readonly now: () => number;
	private readonly maxArtifactBytes: number;
	private readonly retentionMs: number;
	private readonly staleCaptureMs: number;
	private readonly transcodeVideo?: DemoArtifactServiceOptions['transcodeVideo'];
	private readonly resolveSshRemote?: DemoArtifactServiceOptions['resolveSshRemote'];
	private readonly statRemoteArtifact: NonNullable<
		DemoArtifactServiceOptions['statRemoteArtifact']
	>;
	private readonly downloadRemoteArtifact: NonNullable<
		DemoArtifactServiceOptions['downloadRemoteArtifact']
	>;
	private readonly sessionRunMap = new Map<string, string>();
	private readonly captureRunDemoMap = new Map<string, string>();
	private readonly captureRunArtifacts = new Map<string, ArtifactRecord[]>();
	private readonly captureRunSteps = new Map<string, DemoStepRecord[]>();

	constructor(db: ArtifactsDB, options: DemoArtifactServiceOptions = {}) {
		this.db = db;
		this.artifactsRoot =
			options.artifactsRoot ?? path.join(app.getPath('userData'), ARTIFACTS_DIRNAME);
		this.now = options.now ?? (() => Date.now());
		this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
		this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
		this.staleCaptureMs = options.staleCaptureMs ?? DEFAULT_STALE_CAPTURE_MS;
		this.transcodeVideo = options.transcodeVideo;
		this.resolveSshRemote = options.resolveSshRemote;
		this.statRemoteArtifact = options.statRemoteArtifact ?? statRemote;
		this.downloadRemoteArtifact = options.downloadRemoteArtifact ?? downloadFileRemote;
	}

	async initialize(): Promise<void> {
		this.db.initialize();
		await fs.mkdir(this.artifactsRoot, { recursive: true });
		await this.recoverStaleCaptures();
		await this.cleanupExpiredArtifacts();
	}

	private getSessionKey(context: DemoCaptureContext): string {
		return `${context.sessionId}::${context.tabId || ''}`;
	}

	private async logLifecycle(
		level: 'info' | 'warn' | 'error',
		message: string,
		extra?: Record<string, unknown>
	): Promise<void> {
		logger[level](message, LOG_CONTEXT, extra);
		if (level !== 'info') {
			void captureMessage(message, level === 'error' ? 'error' : 'warning', {
				context: LOG_CONTEXT,
				...extra,
			});
		}
	}

	private hydrateCaptureRunCaches(captureRunId: string): void {
		if (!this.captureRunArtifacts.has(captureRunId)) {
			this.captureRunArtifacts.set(captureRunId, this.db.listArtifactsForCaptureRun(captureRunId));
		}
		const demo = this.db.getDemoByCaptureRun(captureRunId);
		if (demo) {
			this.captureRunDemoMap.set(captureRunId, demo.id);
			if (!this.captureRunSteps.has(captureRunId)) {
				this.captureRunSteps.set(captureRunId, this.db.listDemoSteps(demo.id));
			}
		}
	}

	private cleanupRunCaches(captureRunId: string, sessionKey?: string): void {
		this.captureRunArtifacts.delete(captureRunId);
		this.captureRunSteps.delete(captureRunId);
		this.captureRunDemoMap.delete(captureRunId);
		if (sessionKey) {
			this.sessionRunMap.delete(sessionKey);
			return;
		}
		for (const [key, value] of this.sessionRunMap.entries()) {
			if (value === captureRunId) {
				this.sessionRunMap.delete(key);
			}
		}
	}

	private selectPosterArtifact(
		artifacts: ArtifactRecord[],
		preferredArtifactId?: string | null
	): ArtifactRecord | null {
		if (preferredArtifactId) {
			const preferred = artifacts.find((artifact) => artifact.id === preferredArtifactId);
			if (preferred) {
				return preferred;
			}
		}
		return artifacts.find((artifact) => artifact.kind === 'image') || null;
	}

	private selectVideoArtifact(
		artifacts: ArtifactRecord[],
		preferredArtifactId?: string | null
	): ArtifactRecord | null {
		if (preferredArtifactId) {
			const preferred = artifacts.find((artifact) => artifact.id === preferredArtifactId);
			if (preferred) {
				return preferred;
			}
		}
		return artifacts.find((artifact) => artifact.kind === 'video') || null;
	}

	private async ensureCaptureRun(
		context: DemoCaptureContext,
		event: DemoCaptureEvent
	): Promise<CaptureRunRecord> {
		const sessionKey = this.getSessionKey(context);
		const externalRunId = event.runId?.trim() || null;
		if (externalRunId) {
			const existing = this.db.getCaptureRunByExternalId(
				context.sessionId,
				context.tabId || null,
				externalRunId
			);
			if (existing) {
				this.sessionRunMap.set(sessionKey, existing.id);
				this.hydrateCaptureRunCaches(existing.id);
				return existing;
			}
		}

		const existingRunId = this.sessionRunMap.get(sessionKey);
		if (existingRunId) {
			const persistedRun = this.db.getCaptureRunById(existingRunId);
			if (persistedRun) {
				this.hydrateCaptureRunCaches(persistedRun.id);
				return persistedRun;
			}
		}

		const now = this.now();
		const record: CaptureRunRecord = {
			id: randomUUID(),
			sessionId: context.sessionId,
			tabId: context.tabId || null,
			externalRunId,
			status: 'capturing',
			title: event.title || null,
			summary: event.summary || null,
			createdAt: now,
			updatedAt: now,
		};
		this.db.upsertCaptureRun(record);
		this.sessionRunMap.set(sessionKey, record.id);
		this.captureRunArtifacts.set(record.id, []);
		this.captureRunSteps.set(record.id, []);
		return record;
	}

	private ensureDemoRecord(
		captureRun: CaptureRunRecord,
		status: DemoStatus = 'capturing'
	): DemoRecord {
		this.hydrateCaptureRunCaches(captureRun.id);
		const existing = this.db.getDemoByCaptureRun(captureRun.id);
		const now = this.now();
		if (existing) {
			const updatedDemo: DemoRecord = {
				...existing,
				status,
				title: captureRun.title || existing.title || 'Captured demo',
				summary: captureRun.summary ?? existing.summary ?? null,
				updatedAt: now,
			};
			this.db.upsertDemo(updatedDemo);
			this.captureRunDemoMap.set(captureRun.id, updatedDemo.id);
			return updatedDemo;
		}

		const demo: DemoRecord = {
			id: randomUUID(),
			sessionId: captureRun.sessionId,
			tabId: captureRun.tabId,
			captureRunId: captureRun.id,
			status,
			title: captureRun.title || 'Captured demo',
			summary: captureRun.summary || null,
			posterArtifactId: null,
			videoArtifactId: null,
			createdAt: captureRun.createdAt,
			updatedAt: now,
		};
		this.db.upsertDemo(demo);
		this.captureRunDemoMap.set(captureRun.id, demo.id);
		return demo;
	}

	private async defaultTranscodeVideo(
		sourcePath: string,
		outputPath: string
	): Promise<{ success: boolean; stderr?: string }> {
		const result = await execFileNoThrow(
			'ffmpeg',
			[
				'-y',
				'-i',
				sourcePath,
				'-c:v',
				'libx264',
				'-pix_fmt',
				'yuv420p',
				'-movflags',
				'+faststart',
				'-c:a',
				'aac',
				outputPath,
			],
			undefined,
			{ timeout: 60_000 }
		);
		return {
			success: result.exitCode === 0,
			stderr: result.stderr,
		};
	}

	private async copyArtifact(
		inputPath: string,
		artifactId: string,
		filename: string
	): Promise<string> {
		const ext = path.extname(filename) || path.extname(inputPath);
		const safeName = `${artifactId}${ext}`;
		const storedPath = path.join(this.artifactsRoot, safeName);
		await fs.copyFile(inputPath, storedPath);
		return storedPath;
	}

	private buildStoredArtifactPath(
		artifactId: string,
		filename: string,
		sourcePath: string
	): string {
		const ext = path.extname(filename) || path.extname(sourcePath);
		return path.join(this.artifactsRoot, `${artifactId}${ext}`);
	}

	private async createMp4Derivative(source: ArtifactRecord): Promise<ArtifactRecord | null> {
		if (!source.mimeType.startsWith('video/') || source.mimeType === 'video/mp4') {
			return null;
		}

		const derivativeId = randomUUID();
		const outputPath = path.join(this.artifactsRoot, `${derivativeId}.mp4`);
		const transcode = this.transcodeVideo ?? this.defaultTranscodeVideo.bind(this);
		const result = await transcode(source.storedPath, outputPath);
		if (!result.success) {
			await this.logLifecycle(
				'warn',
				'Failed to create MP4 derivative; using original video artifact',
				{
					artifactId: source.id,
					stderr: result.stderr,
				}
			);
			await fs.rm(outputPath, { force: true });
			return null;
		}

		const stats = await fs.stat(outputPath);
		if (stats.size <= 0) {
			await this.logLifecycle('warn', 'Discarding empty MP4 derivative', {
				artifactId: source.id,
				outputPath,
			});
			await fs.rm(outputPath, { force: true });
			return null;
		}

		const buffer = await fs.readFile(outputPath);
		const record: ArtifactRecord = {
			id: derivativeId,
			sessionId: source.sessionId,
			tabId: source.tabId,
			captureRunId: source.captureRunId,
			kind: 'video',
			mimeType: 'video/mp4',
			byteSize: stats.size,
			sha256: createHash('sha256').update(buffer).digest('hex'),
			filename: `${path.parse(source.filename).name}.mp4`,
			storageBackend: 'local',
			createdAt: this.now(),
			updatedAt: this.now(),
			width: source.width,
			height: source.height,
			durationMs: source.durationMs,
			originalPath: source.storedPath,
			storedPath: outputPath,
			derivedFromArtifactId: source.id,
		};
		this.db.insertArtifact(record);
		const artifacts = this.captureRunArtifacts.get(source.captureRunId) || [];
		artifacts.push(record);
		this.captureRunArtifacts.set(source.captureRunId, artifacts);
		return record;
	}

	private async ingestArtifact(
		context: DemoCaptureContext,
		captureRunId: string,
		event: DemoCaptureEvent,
		overridePath?: string
	): Promise<ArtifactRecord | null> {
		const sourcePath = overridePath || event.path || event.artifactPath;
		if (!sourcePath) {
			return null;
		}

		if (context.sshRemoteId) {
			const sshRemote = this.resolveSshRemote?.(context.sshRemoteId);
			if (!sshRemote) {
				await this.logLifecycle('error', 'Failed to resolve SSH remote for demo artifact ingest', {
					captureRunId,
					sourcePath,
					sshRemoteId: context.sshRemoteId,
					sshRemoteHost: context.sshRemoteHost,
				});
				return null;
			}

			const statResult = await this.statRemoteArtifact(sourcePath, sshRemote);
			if (!statResult.success || !statResult.data) {
				await this.logLifecycle('error', 'Failed to stat remote demo artifact', {
					captureRunId,
					sourcePath,
					sshRemoteId: context.sshRemoteId,
					sshRemoteHost: context.sshRemoteHost,
					error: statResult.error,
				});
				return null;
			}

			if (statResult.data.isDirectory) {
				await this.logLifecycle(
					'warn',
					'Skipping remote demo artifact because path is a directory',
					{
						captureRunId,
						sourcePath,
						sshRemoteId: context.sshRemoteId,
						sshRemoteHost: context.sshRemoteHost,
					}
				);
				return null;
			}

			if (statResult.data.size <= 0) {
				await this.logLifecycle('warn', 'Skipping empty demo artifact', {
					captureRunId,
					sourcePath,
					sshRemoteId: context.sshRemoteId,
					sshRemoteHost: context.sshRemoteHost,
				});
				return null;
			}

			if (statResult.data.size > this.maxArtifactBytes) {
				await this.logLifecycle('warn', 'Skipping oversized demo artifact', {
					captureRunId,
					sourcePath,
					byteSize: statResult.data.size,
					maxArtifactBytes: this.maxArtifactBytes,
					sshRemoteId: context.sshRemoteId,
					sshRemoteHost: context.sshRemoteHost,
				});
				return null;
			}

			const artifactId = randomUUID();
			const filename = sanitizeFilename(event.filename || path.basename(sourcePath));
			const storedPath = this.buildStoredArtifactPath(artifactId, filename, sourcePath);
			const downloadResult = await this.downloadRemoteArtifact(sourcePath, storedPath, sshRemote);
			if (!downloadResult.success) {
				await this.logLifecycle('error', 'Failed to ingest remote demo artifact', {
					captureRunId,
					sourcePath,
					storedPath,
					sshRemoteId: context.sshRemoteId,
					sshRemoteHost: context.sshRemoteHost,
					error: downloadResult.error,
				});
				await fs.rm(storedPath, { force: true });
				return null;
			}

			try {
				const buffer = await fs.readFile(storedPath);
				const record: ArtifactRecord = {
					id: artifactId,
					sessionId: context.sessionId,
					tabId: context.tabId || null,
					captureRunId,
					kind:
						event.kind ||
						(guessMimeType(sourcePath, event.mimeType).startsWith('video/') ? 'video' : 'image'),
					mimeType: guessMimeType(sourcePath, event.mimeType, event.kind || undefined),
					byteSize: buffer.byteLength,
					sha256: createHash('sha256').update(buffer).digest('hex'),
					filename,
					storageBackend: 'local',
					createdAt: this.now(),
					updatedAt: this.now(),
					width: event.width ?? null,
					height: event.height ?? null,
					durationMs: event.durationMs ?? null,
					originalPath: sourcePath,
					storedPath,
					derivedFromArtifactId: null,
				};
				this.db.insertArtifact(record);
				const artifacts = this.captureRunArtifacts.get(captureRunId) || [];
				artifacts.push(record);
				this.captureRunArtifacts.set(captureRunId, artifacts);
				return record;
			} catch (error) {
				await fs.rm(storedPath, { force: true });
				await this.logLifecycle('error', 'Failed to finalize remote demo artifact ingest', {
					captureRunId,
					sourcePath,
					storedPath,
					sshRemoteId: context.sshRemoteId,
					sshRemoteHost: context.sshRemoteHost,
					error: String(error),
				});
				return null;
			}
		}

		try {
			const normalizedPath = path.resolve(sourcePath);
			const stats = await fs.stat(normalizedPath);
			if (stats.size <= 0) {
				await this.logLifecycle('warn', 'Skipping empty demo artifact', {
					captureRunId,
					sourcePath: normalizedPath,
				});
				return null;
			}
			if (stats.size > this.maxArtifactBytes) {
				await this.logLifecycle('warn', 'Skipping oversized demo artifact', {
					captureRunId,
					sourcePath: normalizedPath,
					byteSize: stats.size,
					maxArtifactBytes: this.maxArtifactBytes,
				});
				return null;
			}

			const buffer = await fs.readFile(normalizedPath);
			const artifactId = randomUUID();
			const filename = sanitizeFilename(event.filename || path.basename(normalizedPath));
			const storedPath = await this.copyArtifact(normalizedPath, artifactId, filename);
			const record: ArtifactRecord = {
				id: artifactId,
				sessionId: context.sessionId,
				tabId: context.tabId || null,
				captureRunId,
				kind:
					event.kind ||
					(guessMimeType(normalizedPath, event.mimeType).startsWith('video/') ? 'video' : 'image'),
				mimeType: guessMimeType(normalizedPath, event.mimeType, event.kind || undefined),
				byteSize: stats.size,
				sha256: createHash('sha256').update(buffer).digest('hex'),
				filename,
				storageBackend: 'local',
				createdAt: this.now(),
				updatedAt: this.now(),
				width: event.width ?? null,
				height: event.height ?? null,
				durationMs: event.durationMs ?? null,
				originalPath: normalizedPath,
				storedPath,
				derivedFromArtifactId: null,
			};
			this.db.insertArtifact(record);
			const artifacts = this.captureRunArtifacts.get(captureRunId) || [];
			artifacts.push(record);
			this.captureRunArtifacts.set(captureRunId, artifacts);
			return record;
		} catch (error) {
			await this.logLifecycle('error', 'Failed to ingest demo artifact', {
				captureRunId,
				sourcePath,
				error: String(error),
			});
			return null;
		}
	}

	private mapArtifactRef(record: ArtifactRecord | null | undefined): ArtifactRef | null {
		if (!record) {
			return null;
		}
		return {
			id: record.id,
			kind: record.kind,
			mimeType: record.mimeType,
			byteSize: record.byteSize,
			createdAt: record.createdAt,
			filename: record.filename,
			width: record.width,
			height: record.height,
			durationMs: record.durationMs,
			derivedFromArtifactId: record.derivedFromArtifactId,
		};
	}

	private buildDemoCard(demo: DemoRecord): DemoCard {
		const artifacts =
			this.captureRunArtifacts.get(demo.captureRunId) ||
			this.db.listArtifactsForCaptureRun(demo.captureRunId);
		const poster = this.selectPosterArtifact(artifacts, demo.posterArtifactId);
		const video = this.selectVideoArtifact(artifacts, demo.videoArtifactId);
		const steps = this.db.listDemoSteps(demo.id);
		return {
			demoId: demo.id,
			captureRunId: demo.captureRunId,
			title: demo.title,
			summary: demo.summary,
			status: demo.status,
			createdAt: demo.createdAt,
			updatedAt: demo.updatedAt,
			stepCount: steps.length,
			durationMs: video?.durationMs ?? null,
			posterArtifact: this.mapArtifactRef(poster),
			videoArtifact: this.mapArtifactRef(video),
		};
	}

	private persistSteps(captureRunId: string, demoId: string): void {
		const steps = (this.captureRunSteps.get(captureRunId) || []).map((step) => ({
			...step,
			demoId,
		}));
		this.captureRunSteps.set(captureRunId, steps);
		this.db.replaceDemoSteps(demoId, steps);
	}

	private async updateCapturingDemoArtifacts(
		captureRun: CaptureRunRecord,
		recentArtifact?: ArtifactRecord | null,
		event?: DemoCaptureEvent
	): Promise<void> {
		const demo = this.ensureDemoRecord(captureRun, 'capturing');
		const artifacts =
			this.captureRunArtifacts.get(captureRun.id) ||
			this.db.listArtifactsForCaptureRun(captureRun.id);
		const posterCandidate =
			event?.role === 'poster' && recentArtifact?.kind === 'image'
				? recentArtifact
				: this.selectPosterArtifact(artifacts, demo.posterArtifactId);
		const videoCandidate =
			event?.role === 'video' && recentArtifact?.kind === 'video'
				? recentArtifact
				: this.selectVideoArtifact(artifacts, demo.videoArtifactId);
		this.db.upsertDemo({
			...demo,
			title: captureRun.title || demo.title,
			summary: captureRun.summary ?? demo.summary,
			posterArtifactId: posterCandidate?.id || demo.posterArtifactId,
			videoArtifactId: videoCandidate?.id || demo.videoArtifactId,
			updatedAt: this.now(),
		});
	}

	private async finalizeDemo(
		context: DemoCaptureContext,
		captureRun: CaptureRunRecord,
		status: DemoStatus,
		event: DemoCaptureEvent
	): Promise<DemoCard> {
		this.hydrateCaptureRunCaches(captureRun.id);
		const existingDemo = this.db.getDemoByCaptureRun(captureRun.id);
		if (existingDemo && existingDemo.status !== 'capturing') {
			await this.logLifecycle('warn', 'Ignoring duplicate demo finalization event', {
				captureRunId: captureRun.id,
				demoId: existingDemo.id,
				status: existingDemo.status,
				eventType: event.type,
			});
			return this.buildDemoCard(existingDemo);
		}

		const posterArtifact =
			(await this.ingestArtifact(
				context,
				captureRun.id,
				{ ...event, kind: 'image' },
				event.path && event.kind === 'image'
					? event.path
					: event.artifactPath && event.kind === 'image'
						? event.artifactPath
						: undefined
			)) || null;
		const videoArtifact =
			(await this.ingestArtifact(
				context,
				captureRun.id,
				{ ...event, kind: 'video' },
				event.path && event.kind === 'video'
					? event.path
					: event.artifactPath && event.kind === 'video'
						? event.artifactPath
						: undefined
			)) || null;

		const artifacts =
			this.captureRunArtifacts.get(captureRun.id) ||
			this.db.listArtifactsForCaptureRun(captureRun.id);
		const demo = this.ensureDemoRecord(
			{
				...captureRun,
				status,
				title: event.title || captureRun.title,
				summary: event.summary || captureRun.summary,
				updatedAt: this.now(),
			},
			status
		);
		let selectedVideo = videoArtifact || this.selectVideoArtifact(artifacts, demo.videoArtifactId);
		const videoDerivative = selectedVideo ? await this.createMp4Derivative(selectedVideo) : null;
		if (videoDerivative) {
			selectedVideo = videoDerivative;
		}
		const finalizedDemo: DemoRecord = {
			...demo,
			status,
			title: event.title || captureRun.title || demo.title || 'Captured demo',
			summary: event.summary || captureRun.summary || demo.summary || null,
			posterArtifactId:
				posterArtifact?.id ||
				this.selectPosterArtifact(artifacts, demo.posterArtifactId)?.id ||
				demo.posterArtifactId,
			videoArtifactId: selectedVideo?.id || demo.videoArtifactId,
			updatedAt: this.now(),
		};
		this.db.upsertDemo(finalizedDemo);
		this.persistSteps(captureRun.id, finalizedDemo.id);
		this.db.upsertCaptureRun({
			...captureRun,
			status,
			title: finalizedDemo.title,
			summary: finalizedDemo.summary,
			updatedAt: this.now(),
		});
		await this.logLifecycle(status === 'failed' ? 'warn' : 'info', 'Demo capture finalized', {
			captureRunId: captureRun.id,
			demoId: finalizedDemo.id,
			status,
			stepCount: this.db.listDemoSteps(finalizedDemo.id).length,
			artifactCount: artifacts.length,
		});
		const card = this.buildDemoCard(finalizedDemo);
		this.cleanupRunCaches(captureRun.id, this.getSessionKey(context));
		void this.cleanupExpiredArtifacts();
		return card;
	}

	private async recoverStaleCaptures(): Promise<void> {
		const cutoff = this.now() - this.staleCaptureMs;
		const staleRuns = this.db
			.listCaptureRunsByStatus('capturing')
			.filter((run) => run.updatedAt <= cutoff);
		for (const run of staleRuns) {
			await this.logLifecycle('warn', 'Recovering stale demo capture as failed', {
				captureRunId: run.id,
				sessionId: run.sessionId,
				tabId: run.tabId,
				updatedAt: run.updatedAt,
			});
			await this.finalizeDemo({ sessionId: run.sessionId, tabId: run.tabId }, run, 'failed', {
				type: 'capture_failed',
				runId: run.externalRunId || undefined,
				title: run.title || 'Captured demo',
				summary: run.summary || 'Capture did not complete before the session ended.',
			});
		}
	}

	private async deleteCaptureRunBundle(captureRunId: string): Promise<void> {
		const artifacts = this.db.listArtifactsForCaptureRun(captureRunId);
		const demo = this.db.getDemoByCaptureRun(captureRunId);
		for (const artifact of artifacts) {
			try {
				await fs.rm(artifact.storedPath, { force: true });
			} catch (error) {
				await this.logLifecycle('warn', 'Failed to delete artifact file during cleanup', {
					captureRunId,
					artifactId: artifact.id,
					storedPath: artifact.storedPath,
					error: String(error),
				});
			}
		}
		if (demo) {
			this.db.deleteDemoSteps(demo.id);
			this.db.deleteDemo(demo.id);
		}
		this.db.deleteArtifactsForCaptureRun(captureRunId);
		this.db.deleteCaptureRun(captureRunId);
		this.cleanupRunCaches(captureRunId);
	}

	async cleanupExpiredArtifacts(): Promise<void> {
		const cutoff = this.now() - this.retentionMs;
		const expiredRunIds = new Set<string>();
		for (const demo of this.db.listDemosOlderThan(cutoff)) {
			expiredRunIds.add(demo.captureRunId);
		}
		for (const run of this.db.listCaptureRunsOlderThan(cutoff)) {
			if (run.status !== 'capturing') {
				expiredRunIds.add(run.id);
			}
		}
		for (const captureRunId of expiredRunIds) {
			await this.deleteCaptureRunBundle(captureRunId);
		}
	}

	async handleCaptureEvent(input: DemoCaptureEventInput): Promise<DemoCard | null> {
		const { context, event } = input;
		const captureRun = await this.ensureCaptureRun(context, event);
		const updatedRun: CaptureRunRecord = {
			...captureRun,
			status: event.type === 'capture_failed' ? 'failed' : captureRun.status,
			title: event.title || captureRun.title,
			summary: event.summary || captureRun.summary,
			updatedAt: this.now(),
		};
		this.db.upsertCaptureRun(updatedRun);

		if (event.type === 'capture_started') {
			this.ensureDemoRecord(updatedRun, 'capturing');
			await this.logLifecycle('info', 'Demo capture started', {
				captureRunId: updatedRun.id,
				runId: event.runId,
				sessionId: context.sessionId,
				tabId: context.tabId,
			});
			return null;
		}

		if (event.type === 'artifact_created') {
			const artifact = await this.ingestArtifact(context, updatedRun.id, event);
			await this.updateCapturingDemoArtifacts(updatedRun, artifact, event);
			return null;
		}

		if (event.type === 'step_created') {
			const screenshotArtifact = await this.ingestArtifact(context, updatedRun.id, {
				...event,
				kind: event.kind || 'image',
			});
			const demo = this.ensureDemoRecord(updatedRun, 'capturing');
			const currentSteps =
				this.captureRunSteps.get(updatedRun.id) || this.db.listDemoSteps(demo.id);
			const nextStep: DemoStepRecord = {
				id: randomUUID(),
				demoId: demo.id,
				orderIndex: event.orderIndex ?? currentSteps.length,
				title: event.title || `Step ${currentSteps.length + 1}`,
				description: event.description || null,
				timestampMs: event.timestampMs ?? null,
				screenshotArtifactId: screenshotArtifact?.id || null,
				actionType: event.actionType || null,
				toolContext: event.toolContext || null,
				createdAt: this.now(),
			};
			currentSteps.push(nextStep);
			this.captureRunSteps.set(updatedRun.id, currentSteps);
			this.persistSteps(updatedRun.id, demo.id);
			await this.updateCapturingDemoArtifacts(updatedRun, screenshotArtifact, {
				...event,
				role: event.role || 'poster',
			});
			return null;
		}

		if (event.type === 'capture_completed' || event.type === 'capture_failed') {
			return this.finalizeDemo(
				context,
				updatedRun,
				event.type === 'capture_failed' ? 'failed' : 'completed',
				event
			);
		}

		return null;
	}

	listSessionDemos(sessionId: string, tabId?: string | null): DemoCard[] {
		return this.db.listDemosForSession(sessionId, tabId).map((demo) => this.buildDemoCard(demo));
	}

	getDemo(demoId: string): DemoDetail | null {
		const demo = this.db.getDemoById(demoId);
		if (!demo) {
			return null;
		}
		const steps = this.db.listDemoSteps(demo.id);
		const detailSteps: DemoStep[] = steps.map((step) => ({
			id: step.id,
			demoId: step.demoId,
			orderIndex: step.orderIndex,
			title: step.title,
			description: step.description,
			timestampMs: step.timestampMs,
			actionType: step.actionType,
			toolContext: step.toolContext,
			screenshotArtifact: this.mapArtifactRef(
				step.screenshotArtifactId ? this.db.getArtifactById(step.screenshotArtifactId) : null
			),
		}));
		return {
			...this.buildDemoCard(demo),
			sessionId: demo.sessionId,
			tabId: demo.tabId,
			steps: detailSteps,
		};
	}

	getArtifactRecord(artifactId: string): ArtifactRecord | null {
		return this.db.getArtifactById(artifactId);
	}

	async loadArtifactAsDataUrl(artifactId: string): Promise<string | null> {
		const artifact = this.db.getArtifactById(artifactId);
		if (!artifact) {
			return null;
		}
		const buffer = await fs.readFile(artifact.storedPath);
		return `data:${artifact.mimeType};base64,${buffer.toString('base64')}`;
	}
}
