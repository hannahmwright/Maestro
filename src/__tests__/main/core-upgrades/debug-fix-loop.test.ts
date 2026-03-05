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

	it('fails fast when no feasible follow-up command is allowed', async () => {
		const engine = new DebugFixLoopEngine();
		const runCommand = vi
			.fn()
			.mockResolvedValue({ exitCode: 1, stderr: 'Cannot find module foo', durationMs: 20 });

		const result = await engine.run(
			{
				session_id: 'session-2',
				task: { ...task, allowed_commands: ['npm run verify'] },
				cwd: '/tmp/project',
				initial_command: 'npm run verify',
			},
			{ runCommand }
		);

		expect(result.status).toBe('failed');
		expect(result.reason).toBe('command_not_allowed');
		expect(result.failure).toEqual(
			expect.objectContaining({
				code: 'command_not_allowed',
				attempt: 1,
				blocking_reasons: expect.arrayContaining([
					'triage_command_not_allowed',
					'no_feasible_followup_command',
				]),
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

	it('allows derived command variants from an allowed base command', async () => {
		const engine = new DebugFixLoopEngine();
		const runCommand = vi.fn().mockResolvedValue({
			exitCode: 0,
			stdout: 'PASS',
			durationMs: 12,
		});

		const result = await engine.run(
			{
				session_id: 'session-5',
				task: { ...task, done_gate_profile: 'quick' },
				cwd: '/tmp/project',
				initial_command: 'npm test -- src/math.test.ts',
				changed_files: ['src/math.test.ts'],
			},
			{ runCommand }
		);

		expect(result.status).toBe('complete');
		expect(runCommand).toHaveBeenCalledWith('npm test -- src/math.test.ts');
	});

	it('blocks derived commands that add shell control operators', async () => {
		const engine = new DebugFixLoopEngine();
		const runCommand = vi.fn();

		const result = await engine.run(
			{
				session_id: 'session-6',
				task: { ...task, done_gate_profile: 'quick' },
				cwd: '/tmp/project',
				initial_command: 'npm test -- src/math.test.ts && rm -rf /',
			},
			{ runCommand }
		);

		expect(result.status).toBe('failed');
		expect(result.failure?.code).toBe('command_not_allowed');
		expect(runCommand).not.toHaveBeenCalled();
	});

	it('uses prior memory to avoid repeating the same hypothesis family', async () => {
		const engine = new DebugFixLoopEngine();
		const runCommand = vi.fn().mockResolvedValue({
			exitCode: 1,
			stderr: 'FAIL src/math.test.ts\nExpected: 3\nReceived: 2',
			durationMs: 16,
		});

		const result = await engine.run(
			{
				session_id: 'session-7',
				task: { ...task, done_gate_profile: 'standard' },
				cwd: '/tmp/project',
				initial_command: 'npm test',
				max_attempts: 1,
				prior_memory: {
					family_attempts: { test_logic: 4 },
					selected_hypothesis_history: ['hyp-test_failure-1'],
					stagnation_count: 2,
				},
			},
			{ runCommand }
		);

		expect(result.status).toBe('failed');
		expect(result.attempts[0].selected_hypothesis_id).toBe('hyp-test_failure-2');
		expect(result.memory_state?.strategy_switch_count).toBeGreaterThanOrEqual(1);
	});

	it('tracks fix-path candidates and avoids exact command repeats without new evidence', async () => {
		const engine = new DebugFixLoopEngine();
		const runCommand = vi.fn(async (command: string) => {
			if (command === 'npm run build') {
				return { exitCode: 1, stderr: 'TS2304 Cannot find name BuildOnly', durationMs: 18 };
			}
			return {
				exitCode: 1,
				stderr: 'FAIL src/math.test.ts\nExpected: 3\nReceived: 2',
				durationMs: 16,
			};
		});

		const result = await engine.run(
			{
				session_id: 'session-8',
				task: {
					...task,
					allowed_commands: ['npm test', 'npm run build'],
				},
				cwd: '/tmp/project',
				initial_command: 'npm test',
				max_attempts: 2,
			},
			{ runCommand }
		);

		expect(result.attempts.length).toBe(2);
		expect(result.attempts[0].fix_path_candidates?.length || 0).toBeGreaterThan(0);
		expect(result.attempts[0].fix_path_candidates?.length || 0).toBeLessThanOrEqual(3);
		expect(result.attempts[0].selected_command).toBeDefined();
		expect(result.attempts[1].command).not.toBe(result.attempts[0].command);
		expect(Object.keys(result.memory_state?.failure_fingerprints || {})).toHaveLength(1);
		expect(Object.keys(result.memory_state?.module_area_memory || {}).length).toBeGreaterThan(0);
	});

	it('completes in the same attempt when selected precheck command already passes', async () => {
		const engine = new DebugFixLoopEngine();
		let npmTestCalls = 0;
		const runCommand = vi.fn(async (command: string) => {
			if (command === 'npm test') {
				npmTestCalls += 1;
				if (npmTestCalls === 1) {
					return {
						exitCode: 1,
						stderr: 'FAIL src/math.test.ts\nExpected: 3\nReceived: 2',
						durationMs: 18,
					};
				}
				return {
					exitCode: 0,
					stdout: 'PASS src/math.test.ts',
					durationMs: 17,
				};
			}
			if (command === 'npm run build') {
				return {
					exitCode: 0,
					stdout: 'build ok',
					durationMs: 20,
				};
			}
			return {
				exitCode: 1,
				stderr: `unexpected command ${command}`,
				durationMs: 1,
			};
		});

		const result = await engine.run(
			{
				session_id: 'session-8b',
				task: {
					...task,
					allowed_commands: ['npm test', 'npm run build'],
				},
				cwd: '/tmp/project',
				initial_command: 'npm test',
				max_attempts: 3,
			},
			{ runCommand }
		);

		expect(result.status).toBe('complete');
		expect(result.attempts).toHaveLength(1);
		expect(result.attempts[0].selected_command_result?.pass).toBe(true);
	});

	it('records context narratives and long-horizon checkpoints in attempt traces', async () => {
		const engine = new DebugFixLoopEngine();
		const runCommand = vi.fn().mockResolvedValue({
			exitCode: 1,
			stderr: 'ReferenceError: boom in src/runtime/handler.ts',
			durationMs: 18,
		});

		const result = await engine.run(
			{
				session_id: 'session-9',
				task,
				cwd: '/tmp/project',
				initial_command: 'npm test',
				max_attempts: 2,
			},
			{
				runCommand,
				getContextPack: vi.fn().mockResolvedValue({
					selectedFiles: ['src/runtime/handler.ts', 'src/runtime/handler.test.ts'],
					impactedSymbols: ['handler'],
					selection_narratives: [
						{
							file_path: 'src/runtime/handler.ts',
							reason: 'seed_file',
							path: ['src/runtime/handler.ts'],
						},
						{
							file_path: 'src/runtime/handler.test.ts',
							reason: 'test_source_link',
							path: ['src/runtime/handler.ts', 'src/runtime/handler.test.ts'],
						},
					],
				}),
				getGraphScores: vi.fn().mockResolvedValue({
					scores: [
						{
							file_path: 'src/runtime/handler.ts',
							score: 0.91,
							impact_score: 1.2,
							fanout: 1,
						},
					],
					coverage: 1,
					explored_nodes: 2,
				}),
			}
		);

		expect(result.status).toBe('failed');
		expect(result.attempts[0].context_selection_narratives?.[0]?.reason).toBe('seed_file');
		expect(result.attempts[0].long_horizon_checkpoints?.length || 0).toBeGreaterThan(0);
	});
});
