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
});
