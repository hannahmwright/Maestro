import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DebugFixLoopEngine } from '../../../main/core-upgrades';
import type { TaskContract } from '../../../main/core-upgrades/types';

const tempDirs: string[] = [];

function createTask(overrides?: Partial<TaskContract>): TaskContract {
	return {
		task_id: 'task-int-1',
		goal: 'Resolve failure',
		repo_root: '/tmp/project',
		language_profile: 'ts_js',
		risk_level: 'medium',
		allowed_commands: ['npm test', 'npm test -- --runInBand', 'npm run build'],
		done_gate_profile: 'standard',
		max_changed_files: 5,
		created_at: Date.now(),
		...overrides,
	};
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map(async (dir) => {
			await fs.rm(dir, { recursive: true, force: true });
		})
	);
});

describe('DebugFixLoopEngine integration scenarios', () => {
	it('retries after triage and completes when targeted validation passes', async () => {
		const engine = new DebugFixLoopEngine();
		const runCommand = vi
			.fn()
			.mockResolvedValueOnce({
				exitCode: 1,
				stderr: 'FAIL src/math.test.ts\nExpected: 3\nReceived: 2',
				durationMs: 30,
			})
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'PASS src/math.test.ts',
				durationMs: 25,
			});
		const events: string[] = [];

		const result = await engine.run(
			{
				session_id: 'session-int-1',
				task: createTask({ done_gate_profile: 'quick', risk_level: 'low' }),
				cwd: '/tmp/project',
				initial_command: 'npm test',
				changed_files: ['src/math.ts', 'src/math.test.ts'],
			},
			{
				runCommand,
				emitLifecycle: (event) => {
					events.push(event.type);
				},
			}
		);

		expect(result.status).toBe('complete');
		expect(runCommand).toHaveBeenCalledTimes(2);
		expect(runCommand).toHaveBeenNthCalledWith(2, 'npm test -- src/math.test.ts');
		expect(events).toEqual([
			'triage-started',
			'hypothesis-generated',
			'review-findings',
			'gate-result',
		]);
	});

	it('escalates to full suite for cross-package edits in standard profile', async () => {
		const engine = new DebugFixLoopEngine();
		const runCommand = vi
			.fn()
			.mockResolvedValueOnce({ exitCode: 0, stdout: 'targeted ok', durationMs: 20 })
			.mockResolvedValueOnce({ exitCode: 1, stderr: 'full suite failure', durationMs: 50 });

		const result = await engine.run(
			{
				session_id: 'session-int-2',
				task: createTask({ done_gate_profile: 'standard', risk_level: 'medium' }),
				cwd: '/tmp/project',
				initial_command: 'npm test -- packages/pkg-a',
				full_suite_command: 'npm test',
				changed_files: ['/tmp/project/packages/pkg-a/src/index.ts'],
			},
			{ runCommand }
		);

		expect(runCommand).toHaveBeenCalledTimes(2);
		expect(runCommand).toHaveBeenNthCalledWith(2, 'npm test');
		expect(result.status).toBe('failed');
		expect(result.failure?.code).toBe('gate_blocked');
		expect(result.decision?.blocking_reasons).toContain('full_suite_failed');
	});

	it('blocks completion on high-severity review findings for missing tests', async () => {
		const engine = new DebugFixLoopEngine();
		const runCommand = vi.fn().mockResolvedValue({
			exitCode: 0,
			stdout: 'targeted ok',
			durationMs: 22,
		});

		const result = await engine.run(
			{
				session_id: 'session-int-3',
				task: createTask({ done_gate_profile: 'quick', risk_level: 'medium' }),
				cwd: '/tmp/project',
				initial_command: 'npm test -- src/main/service.ts',
				changed_files: [
					'src/main/service.ts',
					'src/main/controller.ts',
					'src/main/store.ts',
					'src/main/types.ts',
				],
			},
			{ runCommand }
		);

		expect(result.status).toBe('failed');
		expect(result.review_findings?.some((finding) => finding.missing_tests)).toBe(true);
		expect(result.decision?.blocking_reasons).toContain('blocking_review_findings');
	});

	it('stops before command execution when edit plan is invalid', async () => {
		const engine = new DebugFixLoopEngine();
		const runCommand = vi.fn();

		const result = await engine.run(
			{
				session_id: 'session-int-4',
				task: createTask(),
				cwd: '/tmp/project',
				initial_command: 'npm test',
				proposed_edits: [{ file_path: 'src/unrelated.ts', reason: 'Quick cleanup' }],
				related_files: ['src/main/app.ts'],
			},
			{ runCommand }
		);

		expect(result.status).toBe('failed');
		expect(result.reason).toBe('edit_plan_blocked');
		expect(result.failure?.blocking_reasons).toContain('contains_blocked_file_changes');
		expect(runCommand).not.toHaveBeenCalled();
	});

	it('stops with edit_apply_blocked when planned patch fails syntax validation', async () => {
		const engine = new DebugFixLoopEngine();
		const runCommand = vi.fn();
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-debug-fix-'));
		tempDirs.push(repoRoot);
		const filePath = path.join(repoRoot, 'src', 'app.ts');
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, 'export const value = 1;\n', 'utf8');

		const result = await engine.run(
			{
				session_id: 'session-int-5',
				task: createTask({ repo_root: repoRoot }),
				cwd: repoRoot,
				initial_command: 'npm test',
				proposed_edits: [{ file_path: 'src/app.ts', reason: 'Fix syntax issue' }],
				planned_patches: [
					{
						file_path: 'src/app.ts',
						content: 'export const value = ;\n',
						reason: 'Fix syntax issue',
					},
				],
				related_files: ['src/app.ts'],
			},
			{ runCommand }
		);

		expect(result.status).toBe('failed');
		expect(result.reason).toBe('edit_apply_blocked');
		expect(result.failure?.blocking_reasons).toContain('syntax_validation_failed');
		expect(result.failure?.syntax_errors?.length).toBeGreaterThan(0);
		expect(runCommand).not.toHaveBeenCalled();
	});
});
