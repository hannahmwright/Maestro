import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type RetrievalMode = 'failure_focused' | 'edit_focused' | 'review_focused';

export interface ContextIndexFile {
	path: string;
	exports: string[];
	imports: string[];
	symbols: string[];
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

interface ContextIndex {
	repoRoot: string;
	generatedAt: number;
	gitIndexMtimeMs: number;
	files: ContextIndexFile[];
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'release', '.next']);

function hashRepoRoot(repoRoot: string): string {
	return crypto.createHash('sha1').update(repoRoot).digest('hex').slice(0, 12);
}

function extractSymbols(content: string): {
	exports: string[];
	imports: string[];
	symbols: string[];
} {
	const exportMatches = new Set<string>();
	const importMatches = new Set<string>();
	const symbolMatches = new Set<string>();

	for (const match of content.matchAll(
		/export\s+(?:const|function|class|type|interface)\s+([A-Za-z_$][\w$]*)/g
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
		imports: [...importMatches].slice(0, 40),
		symbols: [...symbolMatches].slice(0, 60),
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
			results.push(nextPath);
		}
	}

	await walk(root);
	return results;
}

async function readSnippet(filePath: string): Promise<string> {
	const content = await fs.readFile(filePath, 'utf8');
	return content.split('\n').slice(0, 80).join('\n');
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

export class RepoContextService {
	private readonly cacheRoot: string;

	constructor(cacheRoot?: string) {
		this.cacheRoot =
			cacheRoot || path.join(os.homedir(), '.maestro', 'core-upgrades', 'context-cache');
	}

	private async getCachePath(repoRoot: string): Promise<string> {
		await fs.mkdir(this.cacheRoot, { recursive: true });
		return path.join(this.cacheRoot, `${hashRepoRoot(repoRoot)}.json`);
	}

	private async loadIndex(repoRoot: string): Promise<ContextIndex | null> {
		const cachePath = await this.getCachePath(repoRoot);
		try {
			const content = await fs.readFile(cachePath, 'utf8');
			const parsed = JSON.parse(content) as ContextIndex;
			const gitIndexMtimeMs = await readGitIndexMtime(repoRoot);
			if (parsed.gitIndexMtimeMs !== gitIndexMtimeMs) return null;
			return parsed;
		} catch {
			return null;
		}
	}

	private async buildIndex(repoRoot: string): Promise<ContextIndex> {
		const sourceFiles = await walkSourceFiles(repoRoot);
		const files: ContextIndexFile[] = [];

		for (const filePath of sourceFiles) {
			try {
				const content = await fs.readFile(filePath, 'utf8');
				const symbols = extractSymbols(content);
				files.push({
					path: filePath,
					exports: symbols.exports,
					imports: symbols.imports,
					symbols: symbols.symbols,
				});
			} catch {
				// Ignore unreadable files and continue indexing.
			}
		}

		const index: ContextIndex = {
			repoRoot,
			generatedAt: Date.now(),
			gitIndexMtimeMs: await readGitIndexMtime(repoRoot),
			files,
		};

		const cachePath = await this.getCachePath(repoRoot);
		await fs.writeFile(cachePath, JSON.stringify(index), 'utf8');
		return index;
	}

	private async getIndex(repoRoot: string): Promise<ContextIndex> {
		const cached = await this.loadIndex(repoRoot);
		if (cached) return cached;
		return this.buildIndex(repoRoot);
	}

	private selectFiles(
		index: ContextIndex,
		mode: RetrievalMode,
		seedFiles: string[],
		maxFiles: number
	): string[] {
		const normalizedSeeds = new Set(
			seedFiles.map((filePath) => path.resolve(index.repoRoot, filePath))
		);
		const selected = new Set<string>();

		for (const seed of normalizedSeeds) {
			if (index.files.some((entry) => entry.path === seed)) selected.add(seed);
		}

		if (mode === 'failure_focused') {
			for (const entry of index.files) {
				if (selected.size >= maxFiles) break;
				if (entry.imports.some((modulePath) => /test|spec|assert/i.test(modulePath))) {
					selected.add(entry.path);
				}
			}
		}

		if (mode === 'edit_focused') {
			for (const entry of index.files) {
				if (selected.size >= maxFiles) break;
				if (entry.exports.length > 0 && entry.symbols.length > 0) {
					selected.add(entry.path);
				}
			}
		}

		if (mode === 'review_focused') {
			for (const entry of index.files) {
				if (selected.size >= maxFiles) break;
				if (entry.path.includes('/main/') || entry.path.includes('/renderer/')) {
					selected.add(entry.path);
				}
			}
		}

		if (selected.size === 0) {
			for (const entry of index.files.slice(0, maxFiles)) selected.add(entry.path);
		}

		return [...selected].slice(0, maxFiles);
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
		for (const filePath of selectedFiles.slice(0, 5)) {
			const owner = await ownerForFile(index.repoRoot, filePath);
			if (owner) ownershipHints[filePath] = owner;
		}

		return {
			mode: input.mode,
			repoRoot: index.repoRoot,
			selectedFiles,
			snippets,
			ownershipHints,
		};
	}
}
