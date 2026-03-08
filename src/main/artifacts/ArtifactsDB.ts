import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { logger } from '../utils/logger';
import type {
	ArtifactRecord,
	CaptureRunRecord,
	DemoRecord,
	DemoStepRecord,
} from './types';

const LOG_CONTEXT = '[ArtifactsDB]';

export class ArtifactsDB {
	private db: Database.Database | null = null;
	private readonly dbPath: string;
	private initialized = false;

	constructor(dbPath?: string) {
		this.dbPath = dbPath ?? path.join(app.getPath('userData'), 'artifacts.db');
	}

	get database(): Database.Database {
		if (!this.db) {
			throw new Error('ArtifactsDB not initialized');
		}
		return this.db;
	}

	initialize(): void {
		if (this.initialized) {
			return;
		}

		const dir = path.dirname(this.dbPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		this.db = new Database(this.dbPath);
		this.db.pragma('journal_mode = WAL');
		this.createSchema();
		this.initialized = true;
		logger.info(`Artifacts database initialized at ${this.dbPath}`, LOG_CONTEXT);
	}

	close(): void {
		if (!this.db) {
			return;
		}

		this.db.close();
		this.db = null;
		this.initialized = false;
	}

	private createSchema(): void {
		const db = this.database;
		db.exec(`
			CREATE TABLE IF NOT EXISTS capture_runs (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				tab_id TEXT,
				external_run_id TEXT,
				status TEXT NOT NULL,
				title TEXT,
				summary TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_capture_runs_session_tab
				ON capture_runs(session_id, tab_id, created_at DESC);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_runs_external
				ON capture_runs(session_id, tab_id, external_run_id)
				WHERE external_run_id IS NOT NULL;

			CREATE TABLE IF NOT EXISTS artifacts (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				tab_id TEXT,
				capture_run_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				mime_type TEXT NOT NULL,
				byte_size INTEGER NOT NULL,
				sha256 TEXT NOT NULL,
				filename TEXT NOT NULL,
				storage_backend TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				width INTEGER,
				height INTEGER,
				duration_ms INTEGER,
				original_path TEXT,
				stored_path TEXT NOT NULL,
				derived_from_artifact_id TEXT,
				FOREIGN KEY (capture_run_id) REFERENCES capture_runs(id)
			);
			CREATE INDEX IF NOT EXISTS idx_artifacts_capture_run ON artifacts(capture_run_id, created_at ASC);
			CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, tab_id, created_at DESC);

			CREATE TABLE IF NOT EXISTS demos (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				tab_id TEXT,
				capture_run_id TEXT NOT NULL,
				status TEXT NOT NULL,
				title TEXT NOT NULL,
				summary TEXT,
				poster_artifact_id TEXT,
				video_artifact_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (capture_run_id) REFERENCES capture_runs(id),
				FOREIGN KEY (poster_artifact_id) REFERENCES artifacts(id),
				FOREIGN KEY (video_artifact_id) REFERENCES artifacts(id)
			);
			CREATE INDEX IF NOT EXISTS idx_demos_session_tab ON demos(session_id, tab_id, created_at DESC);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_demos_capture_run ON demos(capture_run_id);

			CREATE TABLE IF NOT EXISTS demo_steps (
				id TEXT PRIMARY KEY,
				demo_id TEXT NOT NULL,
				order_index INTEGER NOT NULL,
				title TEXT NOT NULL,
				description TEXT,
				timestamp_ms INTEGER,
				screenshot_artifact_id TEXT,
				action_type TEXT,
				tool_context TEXT,
				created_at INTEGER NOT NULL,
				FOREIGN KEY (demo_id) REFERENCES demos(id),
				FOREIGN KEY (screenshot_artifact_id) REFERENCES artifacts(id)
			);
			CREATE INDEX IF NOT EXISTS idx_demo_steps_demo ON demo_steps(demo_id, order_index ASC);
		`);
	}

	upsertCaptureRun(record: CaptureRunRecord): void {
		this.database
			.prepare(
				`INSERT INTO capture_runs (
					id, session_id, tab_id, external_run_id, status, title, summary, created_at, updated_at
				) VALUES (
					@id, @sessionId, @tabId, @externalRunId, @status, @title, @summary, @createdAt, @updatedAt
				)
				ON CONFLICT(id) DO UPDATE SET
					status = excluded.status,
					title = excluded.title,
					summary = excluded.summary,
					updated_at = excluded.updated_at`
			)
			.run({
				id: record.id,
				sessionId: record.sessionId,
				tabId: record.tabId,
				externalRunId: record.externalRunId,
				status: record.status,
				title: record.title,
				summary: record.summary,
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
			});
	}

	getCaptureRunByExternalId(
		sessionId: string,
		tabId: string | null,
		externalRunId: string
	): CaptureRunRecord | null {
		const row = this.database
			.prepare(
				`SELECT * FROM capture_runs
				WHERE session_id = ? AND COALESCE(tab_id, '') = COALESCE(?, '') AND external_run_id = ?`
			)
			.get(sessionId, tabId, externalRunId) as
			| {
					id: string;
					session_id: string;
					tab_id: string | null;
					external_run_id: string | null;
					status: CaptureRunRecord['status'];
					title: string | null;
					summary: string | null;
					created_at: number;
					updated_at: number;
			  }
			| undefined;
		if (!row) {
			return null;
		}
		return {
			id: row.id,
			sessionId: row.session_id,
			tabId: row.tab_id,
			externalRunId: row.external_run_id,
			status: row.status,
			title: row.title,
			summary: row.summary,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	getCaptureRunById(id: string): CaptureRunRecord | null {
		const row = this.database.prepare(`SELECT * FROM capture_runs WHERE id = ?`).get(id) as
			| {
					id: string;
					session_id: string;
					tab_id: string | null;
					external_run_id: string | null;
					status: CaptureRunRecord['status'];
					title: string | null;
					summary: string | null;
					created_at: number;
					updated_at: number;
			  }
			| undefined;
		if (!row) {
			return null;
		}
		return {
			id: row.id,
			sessionId: row.session_id,
			tabId: row.tab_id,
			externalRunId: row.external_run_id,
			status: row.status,
			title: row.title,
			summary: row.summary,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	listCaptureRunsByStatus(status: CaptureRunRecord['status']): CaptureRunRecord[] {
		const rows = this.database
			.prepare(`SELECT * FROM capture_runs WHERE status = ? ORDER BY created_at ASC`)
			.all(status) as any[];
		return rows.map((row) => ({
			id: row.id,
			sessionId: row.session_id,
			tabId: row.tab_id,
			externalRunId: row.external_run_id,
			status: row.status,
			title: row.title,
			summary: row.summary,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	}

	listCaptureRunsOlderThan(cutoffMs: number): CaptureRunRecord[] {
		const rows = this.database
			.prepare(`SELECT * FROM capture_runs WHERE updated_at < ? ORDER BY updated_at ASC`)
			.all(cutoffMs) as any[];
		return rows.map((row) => ({
			id: row.id,
			sessionId: row.session_id,
			tabId: row.tab_id,
			externalRunId: row.external_run_id,
			status: row.status,
			title: row.title,
			summary: row.summary,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	}

	insertArtifact(record: ArtifactRecord): void {
		this.database
			.prepare(
				`INSERT INTO artifacts (
					id, session_id, tab_id, capture_run_id, kind, mime_type, byte_size, sha256, filename,
					storage_backend, created_at, updated_at, width, height, duration_ms, original_path,
					stored_path, derived_from_artifact_id
				) VALUES (
					@id, @sessionId, @tabId, @captureRunId, @kind, @mimeType, @byteSize, @sha256, @filename,
					@storageBackend, @createdAt, @updatedAt, @width, @height, @durationMs, @originalPath,
					@storedPath, @derivedFromArtifactId
				)`
			)
			.run({
				id: record.id,
				sessionId: record.sessionId,
				tabId: record.tabId,
				captureRunId: record.captureRunId,
				kind: record.kind,
				mimeType: record.mimeType,
				byteSize: record.byteSize,
				sha256: record.sha256,
				filename: record.filename,
				storageBackend: record.storageBackend,
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
				width: record.width,
				height: record.height,
				durationMs: record.durationMs,
				originalPath: record.originalPath,
				storedPath: record.storedPath,
				derivedFromArtifactId: record.derivedFromArtifactId,
			});
	}

	listArtifactsForCaptureRun(captureRunId: string): ArtifactRecord[] {
		const rows = this.database
			.prepare(`SELECT * FROM artifacts WHERE capture_run_id = ? ORDER BY created_at ASC`)
			.all(captureRunId) as any[];
		return rows.map((row) => this.mapArtifact(row));
	}

	upsertDemo(record: DemoRecord): void {
		this.database
			.prepare(
				`INSERT INTO demos (
					id, session_id, tab_id, capture_run_id, status, title, summary,
					poster_artifact_id, video_artifact_id, created_at, updated_at
				) VALUES (
					@id, @sessionId, @tabId, @captureRunId, @status, @title, @summary,
					@posterArtifactId, @videoArtifactId, @createdAt, @updatedAt
				)
				ON CONFLICT(id) DO UPDATE SET
					status = excluded.status,
					title = excluded.title,
					summary = excluded.summary,
					poster_artifact_id = excluded.poster_artifact_id,
					video_artifact_id = excluded.video_artifact_id,
					updated_at = excluded.updated_at`
			)
			.run({
				id: record.id,
				sessionId: record.sessionId,
				tabId: record.tabId,
				captureRunId: record.captureRunId,
				status: record.status,
				title: record.title,
				summary: record.summary,
				posterArtifactId: record.posterArtifactId,
				videoArtifactId: record.videoArtifactId,
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
			});
	}

	replaceDemoSteps(demoId: string, steps: DemoStepRecord[]): void {
		const deleteStmt = this.database.prepare(`DELETE FROM demo_steps WHERE demo_id = ?`);
		const insertStmt = this.database.prepare(
			`INSERT INTO demo_steps (
				id, demo_id, order_index, title, description, timestamp_ms,
				screenshot_artifact_id, action_type, tool_context, created_at
			) VALUES (
				@id, @demoId, @orderIndex, @title, @description, @timestampMs,
				@screenshotArtifactId, @actionType, @toolContext, @createdAt
			)`
		);
		const tx = this.database.transaction((records: DemoStepRecord[]) => {
			deleteStmt.run(demoId);
			for (const record of records) {
				insertStmt.run({
					id: record.id,
					demoId: record.demoId,
					orderIndex: record.orderIndex,
					title: record.title,
					description: record.description,
					timestampMs: record.timestampMs,
					screenshotArtifactId: record.screenshotArtifactId,
					actionType: record.actionType,
					toolContext: record.toolContext,
					createdAt: record.createdAt,
				});
			}
		});
		tx(steps);
	}

	getArtifactById(id: string): ArtifactRecord | null {
		const row = this.database.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as any;
		if (!row) {
			return null;
		}
		return this.mapArtifact(row);
	}

	listDemosForSession(sessionId: string, tabId?: string | null): DemoRecord[] {
		const rows = (tabId
			? this.database
					.prepare(
						`SELECT * FROM demos WHERE session_id = ? AND COALESCE(tab_id, '') = COALESCE(?, '') ORDER BY created_at DESC`
					)
					.all(sessionId, tabId)
			: this.database
					.prepare(`SELECT * FROM demos WHERE session_id = ? ORDER BY created_at DESC`)
					.all(sessionId)) as any[];
		return rows.map((row) => this.mapDemo(row));
	}

	getDemoById(id: string): DemoRecord | null {
		const row = this.database.prepare(`SELECT * FROM demos WHERE id = ?`).get(id) as any;
		return row ? this.mapDemo(row) : null;
	}

	getDemoByCaptureRun(captureRunId: string): DemoRecord | null {
		const row = this.database
			.prepare(`SELECT * FROM demos WHERE capture_run_id = ?`)
			.get(captureRunId) as any;
		return row ? this.mapDemo(row) : null;
	}

	listDemosOlderThan(cutoffMs: number): DemoRecord[] {
		const rows = this.database
			.prepare(`SELECT * FROM demos WHERE updated_at < ? ORDER BY updated_at ASC`)
			.all(cutoffMs) as any[];
		return rows.map((row) => this.mapDemo(row));
	}

	listDemoSteps(demoId: string): DemoStepRecord[] {
		const rows = this.database
			.prepare(`SELECT * FROM demo_steps WHERE demo_id = ? ORDER BY order_index ASC`)
			.all(demoId) as any[];
		return rows.map((row) => ({
			id: row.id,
			demoId: row.demo_id,
			orderIndex: row.order_index,
			title: row.title,
			description: row.description,
			timestampMs: row.timestamp_ms,
			screenshotArtifactId: row.screenshot_artifact_id,
			actionType: row.action_type,
			toolContext: row.tool_context,
			createdAt: row.created_at,
		}));
	}

	deleteDemo(demoId: string): void {
		this.database.prepare(`DELETE FROM demos WHERE id = ?`).run(demoId);
	}

	deleteDemoSteps(demoId: string): void {
		this.database.prepare(`DELETE FROM demo_steps WHERE demo_id = ?`).run(demoId);
	}

	deleteArtifactsForCaptureRun(captureRunId: string): void {
		this.database.prepare(`DELETE FROM artifacts WHERE capture_run_id = ?`).run(captureRunId);
	}

	deleteCaptureRun(captureRunId: string): void {
		this.database.prepare(`DELETE FROM capture_runs WHERE id = ?`).run(captureRunId);
	}

	private mapArtifact(row: any): ArtifactRecord {
		return {
			id: row.id,
			sessionId: row.session_id,
			tabId: row.tab_id,
			captureRunId: row.capture_run_id,
			kind: row.kind,
			mimeType: row.mime_type,
			byteSize: row.byte_size,
			sha256: row.sha256,
			filename: row.filename,
			storageBackend: row.storage_backend,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			width: row.width,
			height: row.height,
			durationMs: row.duration_ms,
			originalPath: row.original_path,
			storedPath: row.stored_path,
			derivedFromArtifactId: row.derived_from_artifact_id,
		};
	}

	private mapDemo(row: any): DemoRecord {
		return {
			id: row.id,
			sessionId: row.session_id,
			tabId: row.tab_id,
			captureRunId: row.capture_run_id,
			status: row.status,
			title: row.title,
			summary: row.summary,
			posterArtifactId: row.poster_artifact_id,
			videoArtifactId: row.video_artifact_id,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}
}
