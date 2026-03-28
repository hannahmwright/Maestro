import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

let lastDbPath: string | null = null;
let artifactRow: any = null;
let demoRows: any[] = [];
let deleteRuns: any[] = [];
let insertRuns: any[] = [];
let tableInfoRows: Record<string, Array<{ name: string }>> = {};
const mockExec = vi.fn();
const mockPragma = vi.fn();
const mockClose = vi.fn();

const mockStatement = {
	run: vi.fn((...args: unknown[]) => {
		deleteRuns.push(args);
		return { changes: 1 };
	}),
	get: vi.fn(() => artifactRow),
	all: vi.fn(() => demoRows),
};

const mockPrepare = vi.fn((sql: string) => {
	const tableInfoMatch = sql.match(/^PRAGMA table_info\(([^)]+)\)$/);
	if (tableInfoMatch) {
		const tableName = tableInfoMatch[1];
		return {
			all: vi.fn(() => tableInfoRows[tableName] || []),
		};
	}

	if (sql.includes('DELETE FROM demo_steps')) {
		return {
			run: vi.fn((...args: unknown[]) => {
				deleteRuns.push(args);
				return { changes: 1 };
			}),
		};
	}

	if (sql.includes('INSERT INTO demo_steps')) {
		return {
			run: vi.fn((params: unknown) => {
				insertRuns.push(params);
				return { changes: 1 };
			}),
		};
	}

	return mockStatement;
});

vi.mock('better-sqlite3', () => ({
	default: class MockDatabase {
		constructor(dbPath: string) {
			lastDbPath = dbPath;
		}
		pragma = mockPragma;
		exec = mockExec;
		prepare = mockPrepare;
		close = mockClose;
		transaction = vi.fn(
			(fn: (...args: any[]) => void) =>
				(...args: any[]) =>
					fn(...args)
		);
	},
}));

const mockMkdirSync = vi.fn();
const mockExistsSync = vi.fn(() => true);

vi.mock('fs', () => ({
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
	mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
}));

const mockUserDataPath = path.join(os.tmpdir(), 'maestro-artifacts-db-tests');

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === 'userData') {
				return mockUserDataPath;
			}
			return os.tmpdir();
		}),
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('ArtifactsDB', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lastDbPath = null;
		artifactRow = null;
		demoRows = [];
		deleteRuns = [];
		insertRuns = [];
		tableInfoRows = {};
		mockExistsSync.mockReturnValue(true);
	});

	afterEach(async () => {
		vi.resetModules();
	});

	it('initializes under userData/artifacts.db and creates the schema', async () => {
		const { ArtifactsDB } = await import('../../../main/artifacts/ArtifactsDB');
		const db = new ArtifactsDB();
		db.initialize();

		expect(lastDbPath).toBe(path.join(mockUserDataPath, 'artifacts.db'));
		expect(mockPragma).toHaveBeenCalledWith('journal_mode = WAL');
		expect(mockExec).toHaveBeenCalledWith(
			expect.stringContaining('CREATE TABLE IF NOT EXISTS capture_runs')
		);
		expect(mockExec).toHaveBeenCalledWith(
			expect.stringContaining('CREATE TABLE IF NOT EXISTS artifacts')
		);
		expect(mockExec).toHaveBeenCalledWith(
			expect.stringContaining('CREATE TABLE IF NOT EXISTS demos')
		);
		expect(mockExec).toHaveBeenCalledWith(
			expect.stringContaining('CREATE TABLE IF NOT EXISTS demo_steps')
		);
	});

	it('adds turn columns before creating turn-based indexes for legacy databases', async () => {
		tableInfoRows.capture_runs = [
			{ name: 'id' },
			{ name: 'session_id' },
			{ name: 'tab_id' },
			{ name: 'external_run_id' },
			{ name: 'status' },
			{ name: 'title' },
			{ name: 'summary' },
			{ name: 'created_at' },
			{ name: 'updated_at' },
		];

		const { ArtifactsDB } = await import('../../../main/artifacts/ArtifactsDB');
		const db = new ArtifactsDB();
		db.initialize();

		expect(mockExec.mock.calls[0]?.[0]).toContain('CREATE TABLE IF NOT EXISTS capture_runs');
		expect(mockExec.mock.calls[0]?.[0]).not.toContain('idx_capture_runs_turn');
		expect(mockExec).toHaveBeenCalledWith('ALTER TABLE capture_runs ADD COLUMN turn_id TEXT');
		expect(mockExec).toHaveBeenCalledWith('ALTER TABLE capture_runs ADD COLUMN turn_token TEXT');
		expect(mockExec).toHaveBeenCalledWith(
			expect.stringContaining('CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_runs_turn')
		);
		expect(mockExec).toHaveBeenCalledWith(
			expect.stringContaining('CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_runs_turn_token')
		);
	});

	it('maps artifact rows from snake_case to camelCase', async () => {
		artifactRow = {
			id: 'artifact-1',
			session_id: 'session-1',
			tab_id: 'tab-1',
			capture_run_id: 'capture-1',
			kind: 'image',
			mime_type: 'image/png',
			byte_size: 42,
			sha256: 'hash',
			filename: 'step.png',
			storage_backend: 'local',
			created_at: 10,
			updated_at: 11,
			width: 1200,
			height: 800,
			duration_ms: null,
			original_path: '/tmp/original.png',
			stored_path: '/tmp/stored.png',
			derived_from_artifact_id: null,
		};

		const { ArtifactsDB } = await import('../../../main/artifacts/ArtifactsDB');
		const db = new ArtifactsDB();
		db.initialize();

		expect(db.getArtifactById('artifact-1')).toEqual({
			id: 'artifact-1',
			sessionId: 'session-1',
			tabId: 'tab-1',
			captureRunId: 'capture-1',
			kind: 'image',
			mimeType: 'image/png',
			byteSize: 42,
			sha256: 'hash',
			filename: 'step.png',
			storageBackend: 'local',
			createdAt: 10,
			updatedAt: 11,
			width: 1200,
			height: 800,
			durationMs: null,
			originalPath: '/tmp/original.png',
			storedPath: '/tmp/stored.png',
			derivedFromArtifactId: null,
		});
	});

	it('replaces demo steps transactionally with mapped insert params', async () => {
		const { ArtifactsDB } = await import('../../../main/artifacts/ArtifactsDB');
		const db = new ArtifactsDB();
		db.initialize();

		db.replaceDemoSteps('demo-1', [
			{
				id: 'step-1',
				demoId: 'demo-1',
				orderIndex: 0,
				title: 'Loaded dashboard',
				description: 'Dashboard visible',
				timestampMs: 100,
				screenshotArtifactId: 'artifact-1',
				actionType: 'navigate',
				toolContext: 'playwright',
				createdAt: 50,
			},
		]);

		expect(deleteRuns).toContainEqual(['demo-1']);
		expect(insertRuns).toContainEqual({
			id: 'step-1',
			demoId: 'demo-1',
			orderIndex: 0,
			title: 'Loaded dashboard',
			description: 'Dashboard visible',
			timestampMs: 100,
			screenshotArtifactId: 'artifact-1',
			actionType: 'navigate',
			toolContext: 'playwright',
			createdAt: 50,
		});
	});
});
