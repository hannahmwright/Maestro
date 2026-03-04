import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type RetrievalMode = 'failure_focused' | 'edit_focused' | 'review_focused';

export interface ContextIndexFile {
	path: string;
	exports: string[];
	imports: string[];
	symbols: string[];
	mtimeMs: number;
	size: number;
	isTestFile: boolean;
}

export interface ContextPack {
	mode: RetrievalMode;
	repoRoot: string;
	selectedFiles: string[];
	snippets: Array<{ filePath: string; snippet: string }>;
	ownershipHints: Record<string, string>;
}

export interface ContextRetrievalInput {
	repoRoot: string;
	mode: RetrievalMode;
	seedFiles?: string[];
	maxFiles?: number;
}

export interface TaskMemoryEntry {
	taskId: string;
	updatedAt: number;
	data: Record<string, unknown>;
}

interface ContextIndex {
	repoRoot: string;
	generatedAt: number;
	gitIndexMtimeMs: number;
	files: ContextIndexFile[];
	importGraph: Record<string, string[]>;
	reverseImportGraph: Record<string, string[]>;
	testToSourceMap: Record<string, string[]>;
}

interface FileExtraction {
	exports: string[];
	imports: string[];
	symbols: string[];
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'release', '.next']);

function hashRepoRoot(repoRoot: string): string {
	return crypto.createHash('sha1').update(repoRoot).digest('hex').slice(0, 12);
}

function isTestFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, '/');
	return (
		/(?:^|\/)(__tests__|test|tests)\//.test(normalized) ||
		/\.(test|spec)\.[jt]sx?$/.test(normalized)
	);
}

function toAbsolutePath(filePath: string, repoRoot: string): string {
	return path.normalize(path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath));
}

function extractSymbols(content: string): FileExtraction {
	const exportMatches = new Set<string>();
	const importMatches = new Set<string>();
	const symbolMatches = new Set<string>();

	for (const match of content.matchAll(
		/export\s+(?:default\s+)?(?:const|function|class|type|interface)\s+([A-Za-z_$][\w$]*)/g
	)) {
		exportMatches.add(match[1]);
	}
	for (const match of content.matchAll(/import\s+[^'"\n]+from\s+['"]([^'"]+)['"]/g)) {
		importMatches.add(match[1]);
	}
	for (const match of content.matchAll(/(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/g)) {
		symbolMatches.add(match[1]);
	}

	return {
		exports: [...exportMatches].slice(0, 25),
		imports: [...importMatches].slice(0, 60),
		symbols: [...symbolMatches].slice(0, 80),
	};
}

async function walkSourceFiles(root: string): Promise<string[]> {
	const results: string[] = [];

	async function walk(currentPath: string): Promise<void> {
		const entries = await fs.readdir(currentPath, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith('.cache')) continue;
			const nextPath = path.join(currentPath, entry.name);
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				await walk(nextPath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
			results.push(path.normalize(nextPath));
		}
	}

	await walk(root);
	results.sort();
	return results;
}

async function readSnippet(filePath: string): Promise<string> {
	const content = await fs.readFile(filePath, 'utf8');
	return content.split('\n').slice(0, 100).join('\n');
}

async function readGitIndexMtime(repoRoot: string): Promise<number> {
	try {
		const gitIndexPath = path.join(repoRoot, '.git', 'index');
		const stat = await fs.stat(gitIndexPath);
		return stat.mtimeMs;
	} catch {
		return 0;
	}
}

async function ownerForFile(repoRoot: string, filePath: string): Promise<string | null> {
	const relativePath = path.relative(repoRoot, filePath);
	try {
		const result = await execFileAsync(
			'git',
			['-C', repoRoot, 'log', '-1', '--format=%an', '--', relativePath],
			{
				timeout: 2000,
			}
		);
		const owner = result.stdout.trim();
		return owner || null;
	} catch {
		return null;
	}
}

function normalizeImportCandidate(basePath: string, knownPaths: Set<string>): string | null {
	const candidates: string[] = [basePath];
	for (const extension of SOURCE_EXTENSIONS) {
		candidates.push(`${basePath}${extension}`);
		candidates.push(path.join(basePath, `index${extension}`));
	}
	for (const candidate of candidates) {
		const normalized = path.normalize(candidate);
		if (knownPaths.has(normalized)) return normalized;
	}
	return null;
}

function resolveImportTargets(
	filePath: string,
	imports: string[],
	knownPaths: Set<string>
): string[] {
	const resolved = new Set<string>();
	for (const modulePath of imports) {
		if (!modulePath.startsWith('.')) continue;
		const basePath = path.resolve(path.dirname(filePath), modulePath);
		const target = normalizeImportCandidate(basePath, knownPaths);
		if (target) resolved.add(target);
	}
	return [...resolved];
}

function stripTestSuffix(baseName: string): string {
	return baseName
		.replace(/\.(test|spec)$/i, '')
		.replace(/[-_.](test|spec)$/i, '')
		.trim();
}

function buildTestToSourceMap(
	files: ContextIndexFile[],
	importGraph: Record<string, string[]>
): Record<string, string[]> {
	const sourceFiles = files.filter((entry) => !entry.isTestFile);
	const sourceByBaseName = new Map<string, string[]>();
	for (const source of sourceFiles) {
		const key = path.basename(source.path, path.extname(source.path));
		if (!sourceByBaseName.has(key)) sourceByBaseName.set(key, []);
		sourceByBaseName.get(key)!.push(source.path);
	}

	const map: Record<string, string[]> = {};
	for (const file of files) {
		if (!file.isTestFile) continue;
		const candidates = new Set<string>();

		for (const imported of importGraph[file.path] || []) {
			const importedEntry = files.find((entry) => entry.path === imported);
			if (importedEntry && !importedEntry.isTestFile) {
				candidates.add(imported);
			}
		}

		const baseName = stripTestSuffix(path.basename(file.path, path.extname(file.path)));
		for (const match of sourceByBaseName.get(baseName) || []) {
			candidates.add(match);
		}

		if (candidates.size > 0) {
			map[file.path] = [...candidates].slice(0, 8);
		}
	}
	return map;
}

function isValidContextIndex(input: unknown): input is ContextIndex {
	if (!input || typeof input !== 'object') return false;
	const value = input as Record<string, unknown>;
	return (
		typeof value.repoRoot === 'string' &&
		Array.isArray(value.files) &&
		typeof value.generatedAt === 'number' &&
		typeof value.gitIndexMtimeMs === 'number'
	);
}

function buildReverseGraph(importGraph: Record<string, string[]>): Record<string, string[]> {
	const reverseGraph: Record<string, string[]> = {};
	for (const [filePath, imports] of Object.entries(importGraph)) {
		for (const imported of imports) {
			if (!reverseGraph[imported]) reverseGraph[imported] = [];
			reverseGraph[imported].push(filePath);
		}
	}
	for (const key of Object.keys(reverseGraph)) {
		reverseGraph[key] = [...new Set(reverseGraph[key])];
	}
	return reverseGraph;
}

function toSourceToTestsMap(index: ContextIndex): Record<string, string[]> {
	const sourceToTests: Record<string, string[]> = {};
	for (const [testFile, sources] of Object.entries(index.testToSourceMap)) {
		for (const source of sources) {
			if (!sourceToTests[source]) sourceToTests[source] = [];
			sourceToTests[source].push(testFile);
		}
	}
	for (const key of Object.keys(sourceToTests)) {
		sourceToTests[key] = [...new Set(sourceToTests[key])];
	}
	return sourceToTests;
}

export class RepoContextService {
	private readonly cacheRoot: string;

	constructor(cacheRoot?: string) {
		this.cacheRoot =
			cacheRoot || path.join(os.homedir(), '.maestro', 'core-upgrades', 'context-cache');
	}

	private async getProjectCacheDir(repoRoot: string): Promise<string> {
		const dir = path.join(this.cacheRoot, hashRepoRoot(repoRoot));
		await fs.mkdir(dir, { recursive: true });
		return dir;
	}

	private async getIndexCachePath(repoRoot: string): Promise<string> {
		return path.join(await this.getProjectCacheDir(repoRoot), 'index.json');
	}

	private async getTaskMemoryCachePath(repoRoot: string): Promise<string> {
		return path.join(await this.getProjectCacheDir(repoRoot), 'task-memory.json');
	}

	private async loadIndex(repoRoot: string): Promise<ContextIndex | null> {
		const cachePath = await this.getIndexCachePath(repoRoot);
		try {
			const content = await fs.readFile(cachePath, 'utf8');
			const parsed: unknown = JSON.parse(content);
			if (!isValidContextIndex(parsed)) {
				await fs.rm(cachePath, { force: true });
				return null;
			}
			return parsed;
		} catch (error) {
			const fileError = error as NodeJS.ErrnoException;
			if (fileError.code === 'ENOENT') return null;
			try {
				await fs.rm(cachePath, { force: true });
			} catch {
				// Ignore cleanup failures.
			}
			return null;
		}
	}

	private async saveIndex(index: ContextIndex): Promise<void> {
		const cachePath = await this.getIndexCachePath(index.repoRoot);
		await fs.writeFile(cachePath, JSON.stringify(index), 'utf8');
	}

	private async buildOrUpdateIndex(
		repoRoot: string,
		existing: ContextIndex | null
	): Promise<ContextIndex> {
		const sourceFiles = await walkSourceFiles(repoRoot);
		const existingMap = new Map(
			(existing?.files || []).map((entry) => [path.normalize(entry.path), entry])
		);
		const files: ContextIndexFile[] = [];

		for (const filePath of sourceFiles) {
			const stat = await fs.stat(filePath);
			const cached = existingMap.get(filePath);
			if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
				files.push(cached);
				continue;
			}

			try {
				const content = await fs.readFile(filePath, 'utf8');
				const symbols = extractSymbols(content);
				files.push({
					path: filePath,
					exports: symbols.exports,
					imports: symbols.imports,
					symbols: symbols.symbols,
					mtimeMs: stat.mtimeMs,
					size: stat.size,
					isTestFile: isTestFile(filePath),
				});
			} catch {
				// Ignore unreadable files and continue indexing.
			}
		}

		const knownPaths = new Set(files.map((entry) => entry.path));
		const importGraph: Record<string, string[]> = {};
		for (const entry of files) {
			importGraph[entry.path] = resolveImportTargets(entry.path, entry.imports, knownPaths);
		}
		const reverseImportGraph = buildReverseGraph(importGraph);
		const testToSourceMap = buildTestToSourceMap(files, importGraph);

		const index: ContextIndex = {
			repoRoot,
			generatedAt: Date.now(),
			gitIndexMtimeMs: await readGitIndexMtime(repoRoot),
			files,
			importGraph,
			reverseImportGraph,
			testToSourceMap,
		};

		await this.saveIndex(index);
		return index;
	}

	private async getIndex(repoRoot: string): Promise<ContextIndex> {
		const resolvedRepoRoot = path.resolve(repoRoot);
		const cached = await this.loadIndex(resolvedRepoRoot);
		try {
			return await this.buildOrUpdateIndex(resolvedRepoRoot, cached);
		} catch {
			// Auto-rebuild once from scratch if the incremental path fails.
			return this.buildOrUpdateIndex(resolvedRepoRoot, null);
		}
	}

	private selectFiles(
		index: ContextIndex,
		mode: RetrievalMode,
		seedFiles: string[],
		maxFiles: number
	): string[] {
		const knownPaths = new Set(index.files.map((entry) => entry.path));
		const sourceToTestsMap = toSourceToTestsMap(index);
		const selected = new Set<string>();
		const normalizedSeeds = seedFiles
			.map((seed) => toAbsolutePath(seed, index.repoRoot))
			.filter((seed) => knownPaths.has(seed));

		const addFile = (filePath: string) => {
			if (!knownPaths.has(filePath)) return;
			if (selected.size >= maxFiles) return;
			selected.add(filePath);
		};

		const addNeighbors = (filePath: string) => {
			for (const imported of index.importGraph[filePath] || []) addFile(imported);
			for (const importer of index.reverseImportGraph[filePath] || []) addFile(importer);
		};

		for (const seed of normalizedSeeds) addFile(seed);

		if (mode === 'failure_focused') {
			for (const seed of normalizedSeeds) {
				const entry = index.files.find((file) => file.path === seed);
				if (!entry) continue;
				if (entry.isTestFile) {
					for (const source of index.testToSourceMap[seed] || []) addFile(source);
				} else {
					for (const testFile of sourceToTestsMap[seed] || []) addFile(testFile);
				}
				addNeighbors(seed);
			}
		}

		if (mode === 'edit_focused') {
			for (const seed of normalizedSeeds) {
				addNeighbors(seed);
				const seedDir = path.dirname(seed);
				for (const file of index.files) {
					if (selected.size >= maxFiles) break;
					if (path.dirname(file.path) === seedDir) {
						addFile(file.path);
					}
				}
			}
		}

		if (mode === 'review_focused') {
			for (const seed of normalizedSeeds) {
				addNeighbors(seed);
				for (const testFile of sourceToTestsMap[seed] || []) addFile(testFile);
			}

			const fanoutFiles = [...index.files]
				.map((file) => ({
					filePath: file.path,
					fanout: (index.reverseImportGraph[file.path] || []).length,
				}))
				.sort((a, b) => b.fanout - a.fanout)
				.map((entry) => entry.filePath);
			for (const filePath of fanoutFiles) {
				if (selected.size >= maxFiles) break;
				addFile(filePath);
			}
		}

		if (selected.size === 0) {
			for (const entry of index.files.slice(0, maxFiles)) addFile(entry.path);
		}

		for (const entry of index.files) {
			if (selected.size >= maxFiles) break;
			addFile(entry.path);
		}

		return [...selected].slice(0, maxFiles);
	}

	private async readTaskMemory(repoRoot: string): Promise<Record<string, TaskMemoryEntry>> {
		const memoryPath = await this.getTaskMemoryCachePath(repoRoot);
		try {
			const content = await fs.readFile(memoryPath, 'utf8');
			const parsed = JSON.parse(content) as Record<string, TaskMemoryEntry>;
			if (!parsed || typeof parsed !== 'object') return {};
			return parsed;
		} catch (error) {
			const fileError = error as NodeJS.ErrnoException;
			if (fileError.code === 'ENOENT') return {};
			try {
				await fs.rm(memoryPath, { force: true });
			} catch {
				// Ignore cleanup failures.
			}
			return {};
		}
	}

	private async writeTaskMemory(
		repoRoot: string,
		memory: Record<string, TaskMemoryEntry>
	): Promise<void> {
		const memoryPath = await this.getTaskMemoryCachePath(repoRoot);
		await fs.writeFile(memoryPath, JSON.stringify(memory), 'utf8');
	}

	async getTaskMemory(repoRoot: string, taskId: string): Promise<Record<string, unknown> | null> {
		const memory = await this.readTaskMemory(path.resolve(repoRoot));
		return memory[taskId]?.data || null;
	}

	async updateTaskMemory(
		repoRoot: string,
		taskId: string,
		patch: Record<string, unknown>
	): Promise<Record<string, unknown>> {
		const resolvedRepoRoot = path.resolve(repoRoot);
		const memory = await this.readTaskMemory(resolvedRepoRoot);
		const current = memory[taskId]?.data || {};
		const next = { ...current, ...patch };
		memory[taskId] = {
			taskId,
			updatedAt: Date.now(),
			data: next,
		};
		await this.writeTaskMemory(resolvedRepoRoot, memory);
		return next;
	}

	async getContextPack(input: ContextRetrievalInput): Promise<ContextPack> {
		const index = await this.getIndex(path.resolve(input.repoRoot));
		const maxFiles = Math.max(1, Math.min(input.maxFiles || 6, 20));
		const selectedFiles = this.selectFiles(index, input.mode, input.seedFiles || [], maxFiles);

		const snippets: Array<{ filePath: string; snippet: string }> = [];
		for (const filePath of selectedFiles) {
			try {
				snippets.push({ filePath, snippet: await readSnippet(filePath) });
			} catch {
				// Ignore read failures; we still provide other snippets.
			}
		}

		const ownershipHints: Record<string, string> = {};
		const ownershipTargets = selectedFiles.slice(0, 8);
		await Promise.all(
			ownershipTargets.map(async (filePath) => {
				const owner = await ownerForFile(index.repoRoot, filePath);
				if (owner) ownershipHints[filePath] = owner;
			})
		);

		return {
			mode: input.mode,
			repoRoot: index.repoRoot,
			selectedFiles,
			snippets,
			ownershipHints,
		};
	}
}
