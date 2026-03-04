import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { EditApplier, EditPlanner } from '../../../main/core-upgrades';
import type { TaskContract } from '../../../main/core-upgrades/types';

const tempDirs: string[] = [];

async function createTaskWithTempRepo(): Promise<TaskContract> {
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-edit-applier-'));
	tempDirs.push(repoRoot);
	return {
		task_id: 'task-ea-1',
		goal: 'Apply safe patch',
		repo_root: repoRoot,
		language_profile: 'ts_js',
		risk_level: 'medium',
		allowed_commands: ['npm test'],
		done_gate_profile: 'standard',
		max_changed_files: 3,
		created_at: Date.now(),
	};
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map(async (dir) => {
			await fs.rm(dir, { recursive: true, force: true });
		})
	);
});

describe('EditApplier', () => {
	it('blocks apply when TS/JS syntax validation fails', async () => {
		const task = await createTaskWithTempRepo();
		const planner = new EditPlanner();
		const applier = new EditApplier();
		const plan = planner.planEdits({
			task,
			proposed_edits: [{ file_path: 'src/app.ts', reason: 'Fix broken statement' }],
			related_files: ['src/app.ts'],
		});

		const result = await applier.applyPlan({
			task,
			edit_plan: plan,
			patches: [
				{ file_path: 'src/app.ts', content: 'const x = ;', reason: 'Fix broken statement' },
			],
		});

		expect(result.applied).toBe(false);
		expect(result.blocked_reasons).toContain('syntax_validation_failed');
		expect(result.syntax_errors.length).toBeGreaterThan(0);
	});

	it('applies valid patch content and writes only changed files', async () => {
		const task = await createTaskWithTempRepo();
		const planner = new EditPlanner();
		const applier = new EditApplier();
		const targetPath = path.join(task.repo_root, 'src', 'app.ts');
		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		await fs.writeFile(targetPath, 'export const value = 1;\n', 'utf8');

		const plan = planner.planEdits({
			task,
			proposed_edits: [{ file_path: 'src/app.ts', reason: 'Update constant value' }],
			related_files: ['src/app.ts'],
		});

		const result = await applier.applyPlan({
			task,
			edit_plan: plan,
			patches: [
				{
					file_path: 'src/app.ts',
					content: 'export const value = 2;\n',
					reason: 'Update constant value',
				},
			],
		});

		expect(result.applied).toBe(true);
		expect(result.applied_files).toContain(targetPath);
		expect(result.blocked_reasons).toEqual([]);
		expect(await fs.readFile(targetPath, 'utf8')).toBe('export const value = 2;\n');
	});
});
