import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import ts from 'typescript';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type RetrievalMode = 'failure_focused' | 'edit_focused' | 'review_focused';

export interface ContextIndexFile {
	path: string;
	exports: string[];
	imports: string[];
	symbols: string[];
	referencedSymbols: string[];
	referencedFiles: string[];
	mtimeMs: number;
	size: number;
	isTestFile: boolean;
	fanout: number;
	impactScore: number;
}

export interface ContextPack {
	mode: RetrievalMode;
	repoRoot: string;
	selectedFiles: string[];
	snippets: Array<{ filePath: string; snippet: string }>;
	ownershipHints: Record<string, string>;
	selectionReason: 'initial' | 'low_confidence' | 'strategy_switch';
	depth: 1 | 2;
	impactedSymbols: string[];
	bridgeFiles: string[];
	bridgeSymbols: string[];
	selectionNarratives: Array<{
		filePath: string;
		reason: string;
		path?: string[];
	}>;
}

export interface ContextRetrievalInput {
	repoRoot: string;
	mode: RetrievalMode;
	seedFiles?: string[];
	maxFiles?: number;
	depth?: 1 | 2;
	seedSymbols?: string[];
	reason?: 'initial' | 'low_confidence' | 'strategy_switch';
}

export interface GraphCandidateScoreInput {
	repoRoot: string;
	seedFiles?: string[];
	candidateFiles: string[];
	seedSymbols?: string[];
	maxDepth?: number;
}

export interface GraphCandidateScore {
	file_path: string;
	score: number;
	distance?: number;
	symbol_path_distance?: number;
	path_strength?: number;
	package_crossings?: number;
	package_blast_radius?: number;
	bridge_file_count?: number;
	bridge_symbol_count?: number;
	bridge_symbol_overlap?: number;
	transitive_importer_fanout?: number;
	explanation_path?: string[];
	explanation?: string;
	impact_score: number;
	fanout: number;
}

export interface GraphCandidateScoreResult {
	scores: GraphCandidateScore[];
	coverage: number;
	explored_nodes: number;
}

export interface TaskMemoryEntry {
	taskId: string;
	updatedAt: number;
	data: Record<string, unknown>;
}

interface FileStatInfo {
	mtimeMs: number;
	size: number;
}

interface ContextIndex {
	repoRoot: string;
	generatedAt: number;
	tsconfigHash: string;
	fileStats: Record<string, FileStatInfo>;
	files: ContextIndexFile[];
	importGraph: Record<string, string[]>;
	reverseImportGraph: Record<string, string[]>;
	referenceGraph: Record<string, string[]>;
	reverseReferenceGraph: Record<string, string[]>;
	testToSourceMap: Record<string, string[]>;
	symbolToFiles: Record<string, string[]>;
	fileToPackage: Record<string, string>;
	packageGraph: Record<string, string[]>;
	packageBlastRadius: Record<string, number>;
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'release', '.next']);

function hashRepoRoot(repoRoot: string): string {
	return crypto.createHash('sha1').update(repoRoot).digest('hex').slice(0, 12);
}

function hashString(value: string): string {
	return crypto.createHash('sha1').update(value).digest('hex');
}

function normalizeFilePath(filePath: string): string {
	return path.normalize(filePath);
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

function normalizeSet(values: string[]): string[] {
	return [...new Set(values.map((value) => normalizeFilePath(value)))];
}

function ensureInsideRepo(repoRoot: string, candidate: string): boolean {
	const normalizedRepo = normalizeFilePath(repoRoot);
	const normalizedCandidate = normalizeFilePath(candidate);
	return (
		normalizedCandidate === normalizedRepo ||
		normalizedCandidate.startsWith(`${normalizedRepo}${path.sep}`)
	);
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
			results.push(normalizeFilePath(nextPath));
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

function isValidContextIndex(input: unknown): input is ContextIndex {
	if (!input || typeof input !== 'object') return false;
	const value = input as Record<string, unknown>;
	return (
		typeof value.repoRoot === 'string' &&
		typeof value.tsconfigHash === 'string' &&
		typeof value.generatedAt === 'number' &&
		Array.isArray(value.files)
	);
}

function buildReverseGraph(graph: Record<string, string[]>): Record<string, string[]> {
	const reverseGraph: Record<string, string[]> = {};
	for (const [source, targets] of Object.entries(graph)) {
		for (const target of targets) {
			if (!reverseGraph[target]) reverseGraph[target] = [];
			reverseGraph[target].push(source);
		}
	}
	for (const [key, values] of Object.entries(reverseGraph)) {
		reverseGraph[key] = normalizeSet(values);
	}
	return reverseGraph;
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
			map[file.path] = [...candidates].slice(0, 10);
		}
	}
	return map;
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
		sourceToTests[key] = normalizeSet(sourceToTests[key]);
	}
	return sourceToTests;
}

function shouldIncludeSourceFile(repoRoot: string, fileName: string): boolean {
	const ext = path.extname(fileName).toLowerCase();
	if (!SOURCE_EXTENSIONS.has(ext)) return false;
	if (!ensureInsideRepo(repoRoot, fileName)) return false;
	return !fileName.includes('node_modules');
}

function resolveModuleFile(
	moduleSpecifier: string,
	containingFile: string,
	repoRoot: string,
	options: ts.CompilerOptions
): string | null {
	if (!moduleSpecifier.startsWith('.')) return null;
	const resolved = ts.resolveModuleName(
		moduleSpecifier,
		containingFile,
		options,
		ts.sys
	).resolvedModule;
	if (!resolved?.resolvedFileName) return null;
	const normalized = normalizeFilePath(resolved.resolvedFileName);
	if (!shouldIncludeSourceFile(repoRoot, normalized)) return null;
	return normalized;
}

function getIdentifierSymbol(
	checker: ts.TypeChecker,
	identifier: ts.Identifier
): ts.Symbol | undefined {
	const symbol = checker.getSymbolAtLocation(identifier);
	if (!symbol) return undefined;
	if (symbol.flags & ts.SymbolFlags.Alias) {
		return checker.getAliasedSymbol(symbol);
	}
	return symbol;
}

function collectDeclaredSymbols(sourceFile: ts.SourceFile): string[] {
	const declared = new Set<string>();
	const addName = (node: ts.Node | undefined) => {
		if (!node) return;
		if (ts.isIdentifier(node)) {
			declared.add(node.text);
		}
	};

	const visit = (node: ts.Node) => {
		if (
			ts.isFunctionDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isInterfaceDeclaration(node) ||
			ts.isTypeAliasDeclaration(node) ||
			ts.isEnumDeclaration(node)
		) {
			addName(node.name);
		}
		if (ts.isVariableDeclaration(node)) {
			addName(node.name);
		}
		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return [...declared].slice(0, 300);
}

interface ExtractedFileData {
	exports: string[];
	imports: string[];
	symbols: string[];
	referencedSymbols: string[];
	referencedFiles: string[];
}

function extractFileData(
	checker: ts.TypeChecker,
	sourceFile: ts.SourceFile,
	options: ts.CompilerOptions,
	repoRoot: string,
	knownFiles: Set<string>
): ExtractedFileData {
	const filePath = normalizeFilePath(sourceFile.fileName);
	const exports = new Set<string>();
	const imports = new Set<string>();
	const symbols = new Set<string>(collectDeclaredSymbols(sourceFile));
	const referencedSymbols = new Set<string>();
	const referencedFiles = new Set<string>();

	const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
	if (moduleSymbol) {
		for (const exportSymbol of checker.getExportsOfModule(moduleSymbol)) {
			const exportName = exportSymbol.getName();
			if (exportName && exportName !== '__export') {
				exports.add(exportName);
			}
		}
	}

	for (const statement of sourceFile.statements) {
		if (
			(ts.isImportDeclaration(statement) ||
				ts.isExportDeclaration(statement) ||
				ts.isImportEqualsDeclaration(statement)) &&
			'moduleSpecifier' in statement &&
			statement.moduleSpecifier &&
			ts.isStringLiteral(statement.moduleSpecifier)
		) {
			const resolved = resolveModuleFile(
				statement.moduleSpecifier.text,
				filePath,
				repoRoot,
				options
			);
			if (resolved && knownFiles.has(resolved)) {
				imports.add(resolved);
			}
		}
	}

	const visit = (node: ts.Node) => {
		if (ts.isIdentifier(node)) {
			const symbol = getIdentifierSymbol(checker, node);
			if (symbol) {
				const name = symbol.getName();
				if (name && name !== 'default') {
					referencedSymbols.add(name);
				}
				const declaration = symbol.declarations?.[0];
				if (declaration) {
					const declarationFile = normalizeFilePath(declaration.getSourceFile().fileName);
					if (declarationFile !== filePath && knownFiles.has(declarationFile)) {
						referencedFiles.add(declarationFile);
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	return {
		exports: [...exports].slice(0, 200),
		imports: [...imports].slice(0, 200),
		symbols: [...symbols].slice(0, 300),
		referencedSymbols: [...referencedSymbols].slice(0, 400),
		referencedFiles: [...referencedFiles].slice(0, 200),
	};
}

async function readTsconfigHash(repoRoot: string): Promise<string> {
	const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
	try {
		const content = await fs.readFile(tsconfigPath, 'utf8');
		return hashString(content);
	} catch {
		return hashString('no-tsconfig');
	}
}

function parseTsConfig(
	repoRoot: string
): { fileNames: string[]; options: ts.CompilerOptions } | null {
	const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
	if (!ts.sys.fileExists(tsconfigPath)) {
		return null;
	}

	const readResult = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (readResult.error) {
		return null;
	}
	const parsed = ts.parseJsonConfigFileContent(
		readResult.config,
		ts.sys,
		repoRoot,
		undefined,
		tsconfigPath
	);
	const fileNames = parsed.fileNames
		.map(normalizeFilePath)
		.filter((filePath) => shouldIncludeSourceFile(repoRoot, filePath));
	const options: ts.CompilerOptions = {
		...parsed.options,
		allowJs: true,
		checkJs: false,
	};
	return { fileNames, options };
}

async function collectFileStats(filePaths: string[]): Promise<Record<string, FileStatInfo>> {
	const stats: Record<string, FileStatInfo> = {};
	await Promise.all(
		filePaths.map(async (filePath) => {
			try {
				const stat = await fs.stat(filePath);
				stats[filePath] = {
					mtimeMs: stat.mtimeMs,
					size: stat.size,
				};
			} catch {
				// File can disappear during indexing; ignore.
			}
		})
	);
	return stats;
}

function computeDirtyFiles(
	filePaths: string[],
	currentStats: Record<string, FileStatInfo>,
	existing: ContextIndex | null,
	tsconfigHash: string
): Set<string> {
	if (!existing || existing.tsconfigHash !== tsconfigHash) {
		return new Set(filePaths);
	}

	const dirty = new Set<string>();
	for (const filePath of filePaths) {
		const current = currentStats[filePath];
		const previous = existing.fileStats[filePath];
		if (!previous || !current) {
			dirty.add(filePath);
			continue;
		}
		if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
			dirty.add(filePath);
		}
	}
	for (const previousPath of Object.keys(existing.fileStats)) {
		if (!currentStats[previousPath]) {
			dirty.add(previousPath);
		}
	}
	return dirty;
}

function calculateImpactScore(input: {
	exportCount: number;
	symbolCount: number;
	fanout: number;
	referenceFanout: number;
	isTestFile: boolean;
}): number {
	const base = input.fanout * 1.5 + input.referenceFanout * 1.1;
	const symbolContribution = Math.min(3, input.symbolCount / 40);
	const exportContribution = Math.min(2, input.exportCount / 20);
	const testPenalty = input.isTestFile ? -0.8 : 0;
	return Math.max(0, base + symbolContribution + exportContribution + testPenalty);
}

function combinedNeighbors(index: ContextIndex, filePath: string): string[] {
	return normalizeSet([
		...(index.importGraph[filePath] || []),
		...(index.reverseImportGraph[filePath] || []),
		...(index.referenceGraph[filePath] || []),
		...(index.reverseReferenceGraph[filePath] || []),
	]);
}

function intersectionSize(left: string[], right: Set<string>): number {
	let count = 0;
	for (const value of left) {
		if (right.has(value)) count++;
	}
	return count;
}

function countTransitiveImporters(index: ContextIndex, filePath: string, maxDepth: number): number {
	const visited = new Set<string>();
	let frontier = [filePath];
	for (let depth = 0; depth < maxDepth; depth++) {
		const nextFrontier = new Set<string>();
		for (const node of frontier) {
			for (const importer of index.reverseImportGraph[node] || []) {
				if (visited.has(importer)) continue;
				visited.add(importer);
				nextFrontier.add(importer);
			}
		}
		frontier = [...nextFrontier];
		if (frontier.length === 0) break;
	}
	return visited.size;
}

async function fileExists(filePath: string, cache: Map<string, boolean>): Promise<boolean> {
	if (cache.has(filePath)) return cache.get(filePath)!;
	try {
		await fs.access(filePath);
		cache.set(filePath, true);
		return true;
	} catch {
		cache.set(filePath, false);
		return false;
	}
}

async function readPackageName(
	packageJsonPath: string,
	cache: Map<string, string | null>
): Promise<string | null> {
	if (cache.has(packageJsonPath)) return cache.get(packageJsonPath)!;
	try {
		const raw = await fs.readFile(packageJsonPath, 'utf8');
		const parsed = JSON.parse(raw) as { name?: unknown };
		const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null;
		cache.set(packageJsonPath, name);
		return name;
	} catch {
		cache.set(packageJsonPath, null);
		return null;
	}
}

async function mapFilesToPackages(
	repoRoot: string,
	filePaths: string[]
): Promise<Record<string, string>> {
	const fileToPackage: Record<string, string> = {};
	const dirPackageCache = new Map<string, string>();
	const packageJsonExistsCache = new Map<string, boolean>();
	const packageNameCache = new Map<string, string | null>();
	const repoRootNormalized = normalizeFilePath(repoRoot);

	for (const filePath of filePaths) {
		let directory = path.dirname(filePath);
		const traversedDirs: string[] = [];
		let resolvedPackage = '__root__';

		while (
			directory.startsWith(repoRootNormalized) &&
			directory.length >= repoRootNormalized.length
		) {
			if (dirPackageCache.has(directory)) {
				resolvedPackage = dirPackageCache.get(directory)!;
				break;
			}
			traversedDirs.push(directory);
			const packageJsonPath = path.join(directory, 'package.json');
			if (await fileExists(packageJsonPath, packageJsonExistsCache)) {
				const packageName = await readPackageName(packageJsonPath, packageNameCache);
				const relativeDir = path.relative(repoRootNormalized, directory).replace(/\\/g, '/');
				resolvedPackage = packageName || relativeDir || '__root__';
				break;
			}
			if (directory === repoRootNormalized) break;
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}

		for (const traversedDir of traversedDirs) {
			dirPackageCache.set(traversedDir, resolvedPackage);
		}
		fileToPackage[filePath] = resolvedPackage;
	}

	return fileToPackage;
}

function buildPackageGraph(
	importGraph: Record<string, string[]>,
	fileToPackage: Record<string, string>
): Record<string, string[]> {
	const packageGraph: Record<string, string[]> = {};
	for (const [source, targets] of Object.entries(importGraph)) {
		const sourcePackage = fileToPackage[source] || '__root__';
		if (!packageGraph[sourcePackage]) packageGraph[sourcePackage] = [];
		for (const target of targets) {
			const targetPackage = fileToPackage[target] || '__root__';
			if (sourcePackage === targetPackage) continue;
			packageGraph[sourcePackage].push(targetPackage);
		}
	}
	for (const packageName of Object.keys(packageGraph)) {
		packageGraph[packageName] = normalizeSet(packageGraph[packageName]);
	}
	return packageGraph;
}

function buildPackageBlastRadius(packageGraph: Record<string, string[]>): Record<string, number> {
	const radius: Record<string, number> = {};
	const packages = new Set<string>([
		...Object.keys(packageGraph),
		...Object.values(packageGraph).flat(),
	]);
	for (const packageName of packages) {
		const visited = new Set<string>();
		const queue: string[] = [...(packageGraph[packageName] || [])];
		while (queue.length > 0) {
			const next = queue.shift()!;
			if (visited.has(next) || next === packageName) continue;
			visited.add(next);
			for (const neighbor of packageGraph[next] || []) {
				if (!visited.has(neighbor)) queue.push(neighbor);
			}
		}
		radius[packageName] = visited.size;
	}
	return radius;
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
		const tsconfig = parseTsConfig(repoRoot);
		const discoveredFiles = tsconfig ? tsconfig.fileNames : await walkSourceFiles(repoRoot);
		const filePaths = normalizeSet(discoveredFiles).filter((filePath) =>
			shouldIncludeSourceFile(repoRoot, filePath)
		);
		const compilerOptions: ts.CompilerOptions = tsconfig?.options || {
			allowJs: true,
			checkJs: false,
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			jsx: ts.JsxEmit.ReactJSX,
		};
		const tsconfigHash = await readTsconfigHash(repoRoot);
		const currentStats = await collectFileStats(filePaths);
		const dirtyFiles = computeDirtyFiles(filePaths, currentStats, existing, tsconfigHash);

		const program = ts.createProgram(filePaths, compilerOptions);
		const checker = program.getTypeChecker();
		const knownFiles = new Set(filePaths);
		const existingMap = new Map(
			(existing?.files || []).map((entry) => [normalizeFilePath(entry.path), entry])
		);

		const files: ContextIndexFile[] = [];
		for (const filePath of filePaths) {
			const normalizedPath = normalizeFilePath(filePath);
			const stat = currentStats[normalizedPath];
			if (!stat) continue;

			const existingEntry = existingMap.get(normalizedPath);
			if (existingEntry && !dirtyFiles.has(normalizedPath)) {
				files.push(existingEntry);
				continue;
			}

			const sourceFile = program.getSourceFile(normalizedPath);
			if (!sourceFile) {
				if (existingEntry) {
					files.push({
						...existingEntry,
						mtimeMs: stat.mtimeMs,
						size: stat.size,
					});
				}
				continue;
			}

			const extracted = extractFileData(checker, sourceFile, compilerOptions, repoRoot, knownFiles);
			files.push({
				path: normalizedPath,
				exports: extracted.exports,
				imports: extracted.imports,
				symbols: extracted.symbols,
				referencedSymbols: extracted.referencedSymbols,
				referencedFiles: extracted.referencedFiles,
				mtimeMs: stat.mtimeMs,
				size: stat.size,
				isTestFile: isTestFile(normalizedPath),
				fanout: 0,
				impactScore: 0,
			});
		}

		const importGraph: Record<string, string[]> = {};
		const referenceGraph: Record<string, string[]> = {};
		const symbolToFiles: Record<string, string[]> = {};
		for (const file of files) {
			importGraph[file.path] = normalizeSet(
				file.imports.filter((target) => knownFiles.has(target))
			);
			referenceGraph[file.path] = normalizeSet(
				file.referencedFiles.filter((target) => knownFiles.has(target))
			);
			for (const symbol of file.symbols) {
				if (!symbolToFiles[symbol]) symbolToFiles[symbol] = [];
				symbolToFiles[symbol].push(file.path);
			}
		}
		for (const key of Object.keys(symbolToFiles)) {
			symbolToFiles[key] = normalizeSet(symbolToFiles[key]);
		}

		const reverseImportGraph = buildReverseGraph(importGraph);
		const reverseReferenceGraph = buildReverseGraph(referenceGraph);
		const testToSourceMap = buildTestToSourceMap(files, importGraph);
		const fileToPackage = await mapFilesToPackages(repoRoot, filePaths);
		const packageGraph = buildPackageGraph(importGraph, fileToPackage);
		const packageBlastRadius = buildPackageBlastRadius(packageGraph);

		const filesWithImpact = files.map((file) => {
			const fanout = (reverseImportGraph[file.path] || []).length;
			const referenceFanout = (reverseReferenceGraph[file.path] || []).length;
			return {
				...file,
				fanout,
				impactScore: calculateImpactScore({
					exportCount: file.exports.length,
					symbolCount: file.symbols.length,
					fanout,
					referenceFanout,
					isTestFile: file.isTestFile,
				}),
			};
		});

		const index: ContextIndex = {
			repoRoot,
			generatedAt: Date.now(),
			tsconfigHash,
			fileStats: currentStats,
			files: filesWithImpact,
			importGraph,
			reverseImportGraph,
			referenceGraph,
			reverseReferenceGraph,
			testToSourceMap,
			symbolToFiles,
			fileToPackage,
			packageGraph,
			packageBlastRadius,
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
			return this.buildOrUpdateIndex(resolvedRepoRoot, null);
		}
	}

	private selectFiles(
		index: ContextIndex,
		mode: RetrievalMode,
		seedFiles: string[],
		maxFiles: number,
		depth: 1 | 2,
		seedSymbols: string[]
	): {
		selectedFiles: string[];
		impactedSymbols: string[];
		bridgeFiles: string[];
		bridgeSymbols: string[];
		selectionNarratives: Array<{
			filePath: string;
			reason: string;
			path?: string[];
		}>;
	} {
		const knownPaths = new Set(index.files.map((entry) => entry.path));
		const sourceToTestsMap = toSourceToTestsMap(index);
		const selected = new Set<string>();
		const impactedSymbols = new Set<string>(seedSymbols);
		const bridgeFiles = new Set<string>();
		const selectionMeta = new Map<
			string,
			{
				reason: string;
				path?: string[];
				priority: number;
			}
		>();
		const seedSymbolSet = new Set(seedSymbols);
		const normalizedSeeds = seedFiles
			.map((seed) => toAbsolutePath(seed, index.repoRoot))
			.filter((seed) => knownPaths.has(seed));
		const symbolSeedFiles = seedSymbols.flatMap((symbol) => index.symbolToFiles[symbol] || []);
		const allSeeds = normalizeSet([...normalizedSeeds, ...symbolSeedFiles]).filter((seed) =>
			knownPaths.has(seed)
		);
		const explicitSeedSet = new Set(normalizedSeeds);

		const reasonPriority = (reason: string): number => {
			switch (reason) {
				case 'seed_file':
					return 1;
				case 'seed_symbol':
					return 2;
				case 'depth_neighbor':
					return 3;
				case 'test_source_link':
					return 4;
				case 'same_directory':
					return 5;
				case 'review_test_link':
					return 6;
				case 'high_impact_rank':
					return 7;
				default:
					return 8;
			}
		};

		const addFile = (filePath: string, reason: string, traversalPath?: string[]) => {
			if (!knownPaths.has(filePath)) return;
			if (!selected.has(filePath) && selected.size >= maxFiles) return;
			selected.add(filePath);
			const nextPriority = reasonPriority(reason);
			const existingMeta = selectionMeta.get(filePath);
			if (!existingMeta || nextPriority < existingMeta.priority) {
				selectionMeta.set(filePath, {
					reason,
					path: traversalPath?.slice(0, 8),
					priority: nextPriority,
				});
			}
		};

		const neighborsFor = (filePath: string): string[] =>
			normalizeSet([
				...(index.importGraph[filePath] || []),
				...(index.reverseImportGraph[filePath] || []),
				...(index.referenceGraph[filePath] || []),
				...(index.reverseReferenceGraph[filePath] || []),
			]);

		const expandByDepth = (seed: string, currentDepth: 1 | 2) => {
			let frontier: Array<{ node: string; path: string[] }> = [{ node: seed, path: [seed] }];
			for (let layer = 0; layer < currentDepth; layer++) {
				const nextFrontier = new Map<string, string[]>();
				for (const entry of frontier) {
					for (const neighbor of neighborsFor(entry.node)) {
						const traversalPath = [...entry.path, neighbor];
						addFile(neighbor, 'depth_neighbor', traversalPath);
						if (layer >= 0 && neighbor !== seed) {
							bridgeFiles.add(neighbor);
						}
						const currentBest = nextFrontier.get(neighbor);
						if (!currentBest || traversalPath.length < currentBest.length) {
							nextFrontier.set(neighbor, traversalPath);
						}
					}
				}
				frontier = [...nextFrontier.entries()].map(([node, path]) => ({ node, path }));
			}
		};

		for (const seed of allSeeds) {
			addFile(seed, explicitSeedSet.has(seed) ? 'seed_file' : 'seed_symbol', [seed]);
			expandByDepth(seed, depth);
		}

		if (mode === 'failure_focused') {
			for (const seed of allSeeds) {
				const entry = index.files.find((file) => file.path === seed);
				if (!entry) continue;
				if (entry.isTestFile) {
					for (const source of index.testToSourceMap[seed] || []) {
						addFile(source, 'test_source_link', [seed, source]);
					}
				} else {
					for (const testFile of sourceToTestsMap[seed] || []) {
						addFile(testFile, 'test_source_link', [seed, testFile]);
					}
				}
			}
		}

		if (mode === 'edit_focused') {
			for (const seed of allSeeds) {
				const seedDir = path.dirname(seed);
				for (const file of index.files) {
					if (selected.size >= maxFiles) break;
					if (path.dirname(file.path) === seedDir) {
						addFile(file.path, 'same_directory', [seed, file.path]);
					}
				}
			}
		}

		if (mode === 'review_focused') {
			for (const seed of allSeeds) {
				for (const testFile of sourceToTestsMap[seed] || []) {
					addFile(testFile, 'review_test_link', [seed, testFile]);
				}
			}
			const fanoutFiles = [...index.files]
				.sort((a, b) => b.impactScore - a.impactScore)
				.map((entry) => entry.path);
			for (const filePath of fanoutFiles) {
				if (selected.size >= maxFiles) break;
				addFile(filePath, 'high_impact_rank');
			}
		}

		if (selected.size === 0) {
			for (const entry of [...index.files].sort((a, b) => b.impactScore - a.impactScore)) {
				addFile(entry.path, 'fallback_impact');
				if (selected.size >= maxFiles) break;
			}
		}

		for (const filePath of selected) {
			const file = index.files.find((entry) => entry.path === filePath);
			for (const symbol of file?.symbols || []) {
				if (impactedSymbols.size >= 50) break;
				impactedSymbols.add(symbol);
			}
		}
		const seedSet = new Set(allSeeds);
		const selectedBridgeFiles = [...bridgeFiles]
			.filter((filePath) => selected.has(filePath) && !seedSet.has(filePath))
			.slice(0, 8);
		const bridgeSymbols = new Set<string>();
		for (const bridgeFile of selectedBridgeFiles) {
			const file = index.files.find((entry) => entry.path === bridgeFile);
			if (!file) continue;
			if (seedSymbolSet.size > 0) {
				for (const symbol of file.referencedSymbols || []) {
					if (seedSymbolSet.has(symbol)) bridgeSymbols.add(symbol);
				}
			} else {
				for (const symbol of file.symbols.slice(0, 4)) {
					bridgeSymbols.add(symbol);
				}
			}
			if (bridgeSymbols.size >= 20) break;
		}
		const selectedFiles = [...selected].slice(0, maxFiles);
		const selectionNarratives = selectedFiles.map((filePath) => {
			const meta = selectionMeta.get(filePath);
			return {
				filePath,
				reason: meta?.reason || 'selected',
				path: meta?.path,
			};
		});

		return {
			selectedFiles,
			impactedSymbols: [...impactedSymbols].slice(0, 50),
			bridgeFiles: selectedBridgeFiles,
			bridgeSymbols: [...bridgeSymbols].slice(0, 20),
			selectionNarratives,
		};
	}

	async scoreCandidates(input: GraphCandidateScoreInput): Promise<GraphCandidateScoreResult> {
		const index = await this.getIndex(path.resolve(input.repoRoot));
		const knownPaths = new Set(index.files.map((entry) => entry.path));
		const fileByPath = new Map(index.files.map((entry) => [entry.path, entry] as const));
		const seedSymbolSet = new Set(input.seedSymbols || []);
		const maxDepth = Math.max(1, Math.min(input.maxDepth || 6, 10));

		const normalizedSeeds = (input.seedFiles || [])
			.map((seed) => toAbsolutePath(seed, index.repoRoot))
			.filter((seed) => knownPaths.has(seed));
		const symbolSeedFiles = normalizeSet(
			(input.seedSymbols || []).flatMap((symbol) => index.symbolToFiles[symbol] || [])
		).filter((seed) => knownPaths.has(seed));
		const symbolSeedFileSet = new Set(symbolSeedFiles);
		const seeds = normalizeSet([...normalizedSeeds, ...symbolSeedFiles]).filter((seed) =>
			knownPaths.has(seed)
		);
		const normalizedCandidates = normalizeSet(
			input.candidateFiles
				.map((candidate) => toAbsolutePath(candidate, index.repoRoot))
				.filter((candidate) => knownPaths.has(candidate))
		);

		if (normalizedCandidates.length === 0 || seeds.length === 0) {
			return {
				scores: normalizedCandidates.map((candidate) => {
					const entry = fileByPath.get(candidate);
					return {
						file_path: candidate,
						score: 0,
						distance: undefined,
						impact_score: entry?.impactScore || 0,
						fanout: entry?.fanout || 0,
					};
				}),
				coverage: 0,
				explored_nodes: 0,
			};
		}

		const distances = new Map<string, number>();
		const packageCrossings = new Map<string, number>();
		const parents = new Map<string, string | null>();
		const queue: Array<{ filePath: string; depth: number; packageCrossings: number }> = [];
		const seedPackages = new Set(seeds.map((seed) => index.fileToPackage[seed] || '__root__'));
		for (const seed of seeds) {
			distances.set(seed, 0);
			packageCrossings.set(seed, 0);
			parents.set(seed, null);
			queue.push({ filePath: seed, depth: 0, packageCrossings: 0 });
		}

		let cursor = 0;
		while (cursor < queue.length) {
			const current = queue[cursor++];
			const knownDistance = distances.get(current.filePath);
			const knownCrossings = packageCrossings.get(current.filePath);
			if (
				knownDistance === undefined ||
				knownCrossings === undefined ||
				current.depth > knownDistance ||
				(current.depth === knownDistance && current.packageCrossings > knownCrossings)
			) {
				continue;
			}
			if (current.depth >= maxDepth) continue;
			const currentPackage = index.fileToPackage[current.filePath] || '__root__';
			for (const neighbor of combinedNeighbors(index, current.filePath)) {
				const neighborPackage = index.fileToPackage[neighbor] || '__root__';
				const nextDepth = current.depth + 1;
				const nextCrossings =
					current.packageCrossings + (currentPackage === neighborPackage ? 0 : 1);
				const previousDepth = distances.get(neighbor);
				const previousCrossings = packageCrossings.get(neighbor);
				const isBetter =
					previousDepth === undefined ||
					nextDepth < previousDepth ||
					(nextDepth === previousDepth &&
						(previousCrossings === undefined || nextCrossings < previousCrossings));
				if (!isBetter) continue;
				distances.set(neighbor, nextDepth);
				packageCrossings.set(neighbor, nextCrossings);
				parents.set(neighbor, current.filePath);
				queue.push({
					filePath: neighbor,
					depth: nextDepth,
					packageCrossings: nextCrossings,
				});
			}
		}

		const scores: GraphCandidateScore[] = normalizedCandidates.map((candidate) => {
			const entry = fileByPath.get(candidate);
			const distance = distances.get(candidate);
			const crossings = packageCrossings.get(candidate);
			const candidatePackage = index.fileToPackage[candidate] || '__root__';
			const packageBlastRadius = index.packageBlastRadius[candidatePackage] || 0;
			const distanceScore = distance === undefined ? 0 : 1 / (distance + 1);
			const crossingPenalty = crossings === undefined ? 0 : Math.min(0.35, crossings * 0.08);
			const pathStrength = Math.max(0, distanceScore - crossingPenalty);
			const impactScore = Math.min(1, (entry?.impactScore || 0) / 8);
			const fanoutScore = Math.min(1, (entry?.fanout || 0) / 12);
			const symbolOverlap =
				seedSymbolSet.size === 0
					? 0
					: intersectionSize(entry?.symbols || [], seedSymbolSet) / seedSymbolSet.size;
			const packageAlignment = seedPackages.has(candidatePackage) ? 1 : 0;
			const pathFiles: string[] = [];
			let cursorPath: string | null = distance === undefined ? null : candidate;
			const pathSeen = new Set<string>();
			while (cursorPath && !pathSeen.has(cursorPath)) {
				pathSeen.add(cursorPath);
				pathFiles.unshift(cursorPath);
				cursorPath = parents.get(cursorPath) || null;
			}
			const hasSymbolSeedInPath = pathFiles.some((filePath) => symbolSeedFileSet.has(filePath));
			const symbolPathDistance =
				seedSymbolSet.size === 0 || distance === undefined || !hasSymbolSeedInPath
					? undefined
					: distance;
			const symbolPathScore =
				typeof symbolPathDistance === 'number' ? 1 / (symbolPathDistance + 1) : 0;
			const bridgeFiles = pathFiles.length > 2 ? pathFiles.slice(1, -1) : [];
			const bridgeFileCount = bridgeFiles.length;
			const bridgeSymbolCount = bridgeFiles.reduce((count, filePath) => {
				if (seedSymbolSet.size === 0) return count;
				const symbols = fileByPath.get(filePath)?.symbols || [];
				return count + intersectionSize(symbols, seedSymbolSet);
			}, 0);
			const bridgeSymbolOverlap =
				seedSymbolSet.size === 0
					? 0
					: Math.min(1, bridgeSymbolCount / Math.max(1, seedSymbolSet.size));
			const transitiveImporterFanout = countTransitiveImporters(
				index,
				candidate,
				Math.min(5, maxDepth)
			);
			const transitiveImporterScore = Math.min(1, transitiveImporterFanout / 12);
			const bridgePenalty = Math.min(0.12, bridgeFileCount * 0.025);
			const blastRadiusPenalty = Math.min(0.2, packageBlastRadius * 0.01);
			const explanationPath = pathFiles.length > 0 ? pathFiles : undefined;
			const explanation =
				distance === undefined
					? 'No graph path from seed set to candidate within max depth.'
					: `Path depth ${distance}, crossings ${crossings || 0}, bridge files ${bridgeFileCount}, bridge overlap ${bridgeSymbolOverlap.toFixed(2)}, transitive importers ${transitiveImporterFanout}, package blast radius ${packageBlastRadius}.`;
			const score =
				pathStrength * 0.32 +
				symbolPathScore * 0.16 +
				impactScore * 0.24 +
				fanoutScore * 0.1 +
				symbolOverlap * 0.08 +
				packageAlignment * 0.1 +
				(bridgeSymbolCount > 0 ? 0.04 : 0) +
				bridgeSymbolOverlap * 0.06 +
				transitiveImporterScore * 0.08 -
				bridgePenalty -
				blastRadiusPenalty;

			return {
				file_path: candidate,
				score: Number(Math.max(0, score).toFixed(4)),
				distance,
				symbol_path_distance: symbolPathDistance,
				path_strength: Number(pathStrength.toFixed(4)),
				package_crossings: crossings,
				package_blast_radius: packageBlastRadius,
				bridge_file_count: bridgeFileCount,
				bridge_symbol_count: bridgeSymbolCount,
				bridge_symbol_overlap: Number(bridgeSymbolOverlap.toFixed(4)),
				transitive_importer_fanout: transitiveImporterFanout,
				explanation_path: explanationPath,
				explanation,
				impact_score: entry?.impactScore || 0,
				fanout: entry?.fanout || 0,
			};
		});

		const reachableCount = scores.filter((score) => score.distance !== undefined).length;
		return {
			scores: scores.sort((left, right) => right.score - left.score),
			coverage: normalizedCandidates.length ? reachableCount / normalizedCandidates.length : 0,
			explored_nodes: distances.size,
		};
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
		const depth: 1 | 2 = input.depth === 2 ? 2 : 1;
		const selection = this.selectFiles(
			index,
			input.mode,
			input.seedFiles || [],
			maxFiles,
			depth,
			input.seedSymbols || []
		);

		const snippets: Array<{ filePath: string; snippet: string }> = [];
		for (const filePath of selection.selectedFiles) {
			try {
				snippets.push({ filePath, snippet: await readSnippet(filePath) });
			} catch {
				// Ignore read failures; we still provide other snippets.
			}
		}

		const ownershipHints: Record<string, string> = {};
		const ownershipTargets = selection.selectedFiles.slice(0, 8);
		await Promise.all(
			ownershipTargets.map(async (filePath) => {
				const owner = await ownerForFile(index.repoRoot, filePath);
				if (owner) ownershipHints[filePath] = owner;
			})
		);

		return {
			mode: input.mode,
			repoRoot: index.repoRoot,
			selectedFiles: selection.selectedFiles,
			snippets,
			ownershipHints,
			selectionReason: input.reason || 'initial',
			depth,
			impactedSymbols: selection.impactedSymbols,
			bridgeFiles: selection.bridgeFiles,
			bridgeSymbols: selection.bridgeSymbols,
			selectionNarratives: selection.selectionNarratives,
		};
	}
}
