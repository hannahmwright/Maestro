import { describe, it, expect, vi } from 'vitest';
import { DebugFixLoopEngine } from '../../../main/core-upgrades';
import type { TaskContract } from '../../../main/core-upgrades/types';

const task: TaskContract = {
	task_id: 'task-123',
	goal: 'Fix failing test',
	repo_root: '/tmp/project',
	language_profile: 'ts_js',
	risk_level: 'medium',
	allowed_commands: ['npm test', 'npm test -- --runInBand', 'npm run build'],
	done_gate_profile: 'standard',
	max_changed_files: 5,
	created_at: Date.now(),
};

describe('DebugFixLoopEngine', () => {
	it('returns complete when targeted and full-suite checks pass', async () => {
		const engine = new DebugFixLoopEngine();
		const runCommand = vi
			.fn()
			.mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 40 })
			.mockResolvedValueOnce({ exitCode: 0, stdout: 'full ok', stderr: '', durationMs: 60 });
		const emitLifecycle = vi.fn();

		const result = await engine.run(
			{
				session_id: 'session-1',
				task,
				cwd: '/tmp/project',
				initial_command: 'npm test -- foo',
				full_suite_command: 'npm test',
				changed_files: ['src/main/file.ts', 'src/__tests__/file.test.ts'],
			},
			{ runCommand, emitLifecycle }
		);

		expect(result.status).toBe('complete');
		expect(emitLifecycle).toHaveBeenCalledWith(expect.objectContaining({ type: 'gate-result' }));
	});

	it('fails after non-progressing hypothesis loop', async () => {
		const engine = new DebugFixLoopEngine();
		const runCommand = vi
			.fn()
			.mockResolvedValueOnce({ exitCode: 1, stderr: 'Cannot find module foo', durationMs: 20 })
			.mockResolvedValueOnce({ exitCode: 1, stderr: 'Cannot find module foo', durationMs: 20 });

		const result = await engine.run(
			{
				session_id: 'session-2',
				task,
				cwd: '/tmp/project',
				initial_command: 'npm test',
			},
			{ runCommand }
		);

		expect(result.status).toBe('failed');
		expect(result.reason).toBe('non_progressing_hypothesis_loop');
		expect(result.failure).toEqual(
			expect.objectContaining({
				code: 'non_progressing_hypothesis_loop',
				attempt: 2,
				hypothesis: expect.objectContaining({
					previous_signature: expect.any(String),
					current_signature: expect.any(String),
				}),
			})
		);
	});

	it('allows retries when hypothesis metadata changes', async () => {
		const engine = new DebugFixLoopEngine();
		const runCommand = vi
			.fn()
			.mockResolvedValueOnce({ exitCode: 1, stderr: 'Cannot find module foo', durationMs: 20 })
			.mockResolvedValueOnce({
				exitCode: 1,
				stderr: "TS2304 Cannot find name 'UserType'",
				durationMs: 20,
			})
			.mockResolvedValueOnce({ exitCode: 1, stderr: 'ReferenceError: boom', durationMs: 20 });

		const result = await engine.run(
			{
				session_id: 'session-3',
				task,
				cwd: '/tmp/project',
				initial_command: 'npm test',
			},
			{ runCommand }
		);

		expect(result.status).toBe('failed');
		expect(result.reason).toBe('max_attempts_reached');
		expect(result.failure?.code).toBe('max_attempts_reached');
	});

	it('fails early when no allowed commands are available', async () => {
		const engine = new DebugFixLoopEngine();
		const runCommand = vi.fn();

		const result = await engine.run(
			{
				session_id: 'session-4',
				task: { ...task, allowed_commands: [] },
				cwd: '/tmp/project',
				initial_command: 'npm test',
			},
			{ runCommand }
		);

		expect(result.status).toBe('failed');
		expect(result.failure?.code).toBe('command_not_allowed');
		expect(runCommand).not.toHaveBeenCalled();
	});
});
