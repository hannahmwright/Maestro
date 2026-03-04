import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RepoContextService } from '../../../main/core-upgrades';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function writeFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, 'utf8');
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map(async (dir) => {
			await fs.rm(dir, { recursive: true, force: true });
		})
	);
});

describe('RepoContextService', () => {
	it('includes mapped test files in failure-focused retrieval', async () => {
		const repoRoot = await makeTempDir('maestro-context-repo-');
		const cacheRoot = await makeTempDir('maestro-context-cache-');
		await writeFile(
			path.join(repoRoot, 'src/math.ts'),
			`export function add(a: number, b: number) { return a + b; }\n`
		);
		await writeFile(
			path.join(repoRoot, 'src/math.test.ts'),
			`import { add } from './math';\n\ndescribe('add', () => { expect(add(1, 2)).toBe(3); });\n`
		);

		const service = new RepoContextService(cacheRoot);
		const pack = await service.getContextPack({
			repoRoot,
			mode: 'failure_focused',
			seedFiles: ['src/math.ts'],
			maxFiles: 4,
		});

		expect(pack.selectedFiles).toContain(path.join(repoRoot, 'src/math.ts'));
		expect(pack.selectedFiles).toContain(path.join(repoRoot, 'src/math.test.ts'));
	});

	it('rebuilds when cached index is corrupt', async () => {
		const repoRoot = await makeTempDir('maestro-context-repo-');
		const cacheRoot = await makeTempDir('maestro-context-cache-');
		await writeFile(path.join(repoRoot, 'src/app.ts'), `export const value = 1;\n`);

		const service = new RepoContextService(cacheRoot);
		await service.getContextPack({
			repoRoot,
			mode: 'edit_focused',
			seedFiles: ['src/app.ts'],
			maxFiles: 3,
		});

		const cacheDirs = await fs.readdir(cacheRoot);
		expect(cacheDirs.length).toBeGreaterThan(0);
		const indexPath = path.join(cacheRoot, cacheDirs[0], 'index.json');
		await fs.writeFile(indexPath, '{"invalid":', 'utf8');

		const rebuiltPack = await service.getContextPack({
			repoRoot,
			mode: 'edit_focused',
			seedFiles: ['src/app.ts'],
			maxFiles: 3,
		});
		expect(rebuiltPack.selectedFiles).toContain(path.join(repoRoot, 'src/app.ts'));
		expect(rebuiltPack.snippets.length).toBeGreaterThan(0);
	});

	it('persists task memory per project cache', async () => {
		const repoRoot = await makeTempDir('maestro-context-repo-');
		const cacheRoot = await makeTempDir('maestro-context-cache-');
		await writeFile(path.join(repoRoot, 'src/app.ts'), `export const value = 1;\n`);

		const service = new RepoContextService(cacheRoot);
		await service.updateTaskMemory(repoRoot, 'task-1', { last_failure: 'lint_error' });
		await service.updateTaskMemory(repoRoot, 'task-1', { attempt_count: 2 });
		const memory = await service.getTaskMemory(repoRoot, 'task-1');

		expect(memory).toEqual({
			last_failure: 'lint_error',
			attempt_count: 2,
		});

		const secondInstance = new RepoContextService(cacheRoot);
		const persisted = await secondInstance.getTaskMemory(repoRoot, 'task-1');
		expect(persisted).toEqual(memory);
	});

	it('expands to transitive neighbors at depth 2 and returns strategy metadata', async () => {
		const repoRoot = await makeTempDir('maestro-context-repo-');
		const cacheRoot = await makeTempDir('maestro-context-cache-');
		await writeFile(
			path.join(repoRoot, 'src/a.ts'),
			`export function alpha() { return 1; }\nexport const aValue = alpha();\n`
		);
		await writeFile(
			path.join(repoRoot, 'src/b.ts'),
			`import { alpha } from './a';\nexport function beta() { return alpha(); }\n`
		);
		await writeFile(
			path.join(repoRoot, 'src/c.ts'),
			`import { beta } from './b';\nexport const gamma = beta();\n`
		);

		const service = new RepoContextService(cacheRoot);
		const depth1Pack = await service.getContextPack({
			repoRoot,
			mode: 'failure_focused',
			seedFiles: ['src/a.ts'],
			seedSymbols: ['alpha'],
			depth: 1,
			reason: 'initial',
			maxFiles: 10,
		});
		const depth2Pack = await service.getContextPack({
			repoRoot,
			mode: 'failure_focused',
			seedFiles: ['src/a.ts'],
			seedSymbols: ['alpha'],
			depth: 2,
			reason: 'low_confidence',
			maxFiles: 10,
		});

		const bPath = path.join(repoRoot, 'src/b.ts');
		const cPath = path.join(repoRoot, 'src/c.ts');
		expect(depth1Pack.selectedFiles).toContain(bPath);
		expect(depth1Pack.selectedFiles).not.toContain(cPath);
		expect(depth2Pack.selectedFiles).toContain(cPath);
		expect(depth2Pack.selectionReason).toBe('low_confidence');
		expect(depth2Pack.depth).toBe(2);
		expect(depth2Pack.impactedSymbols).toContain('alpha');
		expect(
			depth2Pack.selectionNarratives.some(
				(entry) => entry.filePath === cPath && entry.reason === 'depth_neighbor'
			)
		).toBe(true);
	});

	it('scores graph candidates by reachability and impact', async () => {
		const repoRoot = await makeTempDir('maestro-context-repo-');
		const cacheRoot = await makeTempDir('maestro-context-cache-');
		await writeFile(path.join(repoRoot, 'src/core.ts'), `export const core = 1;\n`);
		await writeFile(
			path.join(repoRoot, 'src/service.ts'),
			`import { core } from './core';\nexport const svc = core + 1;\n`
		);
		await writeFile(
			path.join(repoRoot, 'src/feature.ts'),
			`import { svc } from './service';\nexport const feature = svc + 1;\n`
		);
		await writeFile(path.join(repoRoot, 'src/unrelated.ts'), `export const stray = 1;\n`);

		const service = new RepoContextService(cacheRoot);
		const scores = await service.scoreCandidates({
			repoRoot,
			seedFiles: ['src/core.ts'],
			candidateFiles: ['src/feature.ts', 'src/unrelated.ts'],
			seedSymbols: ['core'],
		});

		const byPath = new Map(scores.scores.map((entry) => [entry.file_path, entry] as const));
		const featurePath = path.join(repoRoot, 'src/feature.ts');
		const unrelatedPath = path.join(repoRoot, 'src/unrelated.ts');
		expect(byPath.get(featurePath)?.score || 0).toBeGreaterThan(
			byPath.get(unrelatedPath)?.score || 0
		);
		expect(byPath.get(featurePath)?.symbol_path_distance).toBeDefined();
		expect(byPath.get(featurePath)?.bridge_file_count || 0).toBeGreaterThanOrEqual(0);
		expect(byPath.get(featurePath)?.bridge_symbol_overlap || 0).toBeGreaterThanOrEqual(0);
		expect(byPath.get(featurePath)?.transitive_importer_fanout || 0).toBeGreaterThanOrEqual(0);
		expect(scores.coverage).toBeGreaterThan(0);
		expect(scores.explored_nodes).toBeGreaterThan(0);
	});

	it('penalizes equal-depth candidates that cross package boundaries', async () => {
		const repoRoot = await makeTempDir('maestro-context-repo-');
		const cacheRoot = await makeTempDir('maestro-context-cache-');
		await writeFile(
			path.join(repoRoot, 'packages/a/package.json'),
			JSON.stringify({ name: '@maestro/a' }, null, 2)
		);
		await writeFile(
			path.join(repoRoot, 'packages/b/package.json'),
			JSON.stringify({ name: '@maestro/b' }, null, 2)
		);
		await writeFile(path.join(repoRoot, 'packages/a/src/core.ts'), `export const core = 1;\n`);
		await writeFile(
			path.join(repoRoot, 'packages/a/src/local.ts'),
			`import { core } from './core';\nexport const local = core + 1;\n`
		);
		await writeFile(
			path.join(repoRoot, 'packages/b/src/cross.ts'),
			`import { core } from '../../a/src/core';\nexport const cross = core + 1;\n`
		);

		const service = new RepoContextService(cacheRoot);
		const scores = await service.scoreCandidates({
			repoRoot,
			seedFiles: ['packages/a/src/core.ts'],
			candidateFiles: ['packages/a/src/local.ts', 'packages/b/src/cross.ts'],
			seedSymbols: ['core'],
		});

		const byPath = new Map(scores.scores.map((entry) => [entry.file_path, entry] as const));
		const localPath = path.join(repoRoot, 'packages/a/src/local.ts');
		const crossPath = path.join(repoRoot, 'packages/b/src/cross.ts');
		expect(byPath.get(localPath)?.distance).toBe(1);
		expect(byPath.get(crossPath)?.distance).toBe(1);
		expect(byPath.get(crossPath)?.package_crossings).toBeGreaterThan(0);
		expect(byPath.get(crossPath)?.package_blast_radius || 0).toBeGreaterThanOrEqual(0);
		expect(byPath.get(localPath)?.score || 0).toBeGreaterThan(byPath.get(crossPath)?.score || 0);
	});

	it('boosts candidates with larger transitive importer fanout', async () => {
		const repoRoot = await makeTempDir('maestro-context-repo-');
		const cacheRoot = await makeTempDir('maestro-context-cache-');
		await writeFile(path.join(repoRoot, 'src/core.ts'), `export const core = 1;\n`);
		await writeFile(
			path.join(repoRoot, 'src/a.ts'),
			`import { core } from './core';\nexport const a = core;\n`
		);
		await writeFile(
			path.join(repoRoot, 'src/b.ts'),
			`import { core } from './core';\nexport const b = core;\n`
		);
		await writeFile(
			path.join(repoRoot, 'src/a-consumer-1.ts'),
			`import { a } from './a';\nexport const c1 = a;\n`
		);
		await writeFile(
			path.join(repoRoot, 'src/a-consumer-2.ts'),
			`import { a } from './a';\nexport const c2 = a;\n`
		);

		const service = new RepoContextService(cacheRoot);
		const scores = await service.scoreCandidates({
			repoRoot,
			seedFiles: ['src/core.ts'],
			candidateFiles: ['src/a.ts', 'src/b.ts'],
			seedSymbols: ['core'],
		});

		const byPath = new Map(scores.scores.map((entry) => [entry.file_path, entry] as const));
		const aPath = path.join(repoRoot, 'src/a.ts');
		const bPath = path.join(repoRoot, 'src/b.ts');
		expect(byPath.get(aPath)?.transitive_importer_fanout || 0).toBeGreaterThan(
			byPath.get(bPath)?.transitive_importer_fanout || 0
		);
		expect(byPath.get(aPath)?.score || 0).toBeGreaterThan(byPath.get(bPath)?.score || 0);
	});
});
