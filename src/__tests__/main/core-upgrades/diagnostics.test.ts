import { describe, expect, it } from 'vitest';
import { buildTaskDiagnostics } from '../../../main/core-upgrades';
import type {
	DebugFixLoopResult,
	TaskContract,
	TaskLifecycleEvent,
} from '../../../main/core-upgrades/types';

const task: TaskContract = {
	task_id: 'task-diag-1',
	goal: 'Fix failing checks',
	repo_root: '/tmp/project',
	language_profile: 'ts_js',
	risk_level: 'medium',
	allowed_commands: ['npm test'],
	done_gate_profile: 'standard',
	max_changed_files: 5,
	created_at: Date.now(),
};

describe('buildTaskDiagnostics', () => {
	it('aggregates lifecycle counts and blocking details', () => {
		const lifecycleEvents: TaskLifecycleEvent[] = [
			{ type: 'triage-started', attempt: 1, signal_excerpt: 'FAIL' },
			{
				type: 'hypothesis-generated',
				attempt: 1,
				triage: {
					classification: 'test_failure',
					confidence: 0.8,
					probable_files: ['src/app.ts'],
					probable_symbols: [],
					hypotheses: [],
					raw_signal_excerpt: 'FAIL',
				},
			},
			{ type: 'review-findings', attempt: 2, findings: [] },
			{
				type: 'gate-result',
				attempt: 2,
				decision: {
					decision: 'blocked',
					requires_full_suite: true,
					blocking_reasons: ['full_suite_failed'],
					blocking_findings: [],
					next_actions: ['rerun'],
				},
			},
		];
		const result: DebugFixLoopResult = {
			status: 'failed',
			reason: 'gate_blocked',
			attempts: [
				{
					attempt: 1,
					command: 'npm test',
					result: {
						command: 'npm test',
						exit_code: 1,
						pass: false,
						duration_ms: 30,
					},
				},
				{
					attempt: 2,
					command: 'npm test -- --runInBand',
					result: {
						command: 'npm test -- --runInBand',
						exit_code: 1,
						pass: false,
						duration_ms: 28,
					},
				},
			],
			decision: lifecycleEvents[3].type === 'gate-result' ? lifecycleEvents[3].decision : undefined,
			failure: {
				code: 'gate_blocked',
				message: 'blocked',
				attempt: 2,
			},
		};

		const diagnostics = buildTaskDiagnostics({
			task,
			result,
			lifecycleEvents,
			retrievalMode: 'review_focused',
			contextSelectedFiles: 6,
		});

		expect(diagnostics.task_id).toBe(task.task_id);
		expect(diagnostics.status).toBe('failed');
		expect(diagnostics.attempt_count).toBe(2);
		expect(diagnostics.failure_code).toBe('gate_blocked');
		expect(diagnostics.blocking_reasons).toContain('full_suite_failed');
		expect(diagnostics.full_suite_required).toBe(true);
		expect(diagnostics.last_command).toBe('npm test -- --runInBand');
		expect(diagnostics.last_exit_code).toBe(1);
		expect(diagnostics.retrieval_mode).toBe('review_focused');
		expect(diagnostics.context_selected_files).toBe(6);
		expect(diagnostics.lifecycle_counts).toEqual({
			triage_started: 1,
			hypothesis_generated: 1,
			edit_plan_applied: 0,
			review_findings: 1,
			gate_result: 1,
		});
	});

	it('handles empty lifecycle streams for quick success paths', () => {
		const result: DebugFixLoopResult = {
			status: 'complete',
			attempts: [
				{
					attempt: 1,
					command: 'npm test',
					result: {
						command: 'npm test',
						exit_code: 0,
						pass: true,
						duration_ms: 12,
					},
				},
			],
		};

		const diagnostics = buildTaskDiagnostics({
			task,
			result,
			lifecycleEvents: [],
			retrievalMode: 'failure_focused',
		});

		expect(diagnostics.status).toBe('complete');
		expect(diagnostics.failure_code).toBeUndefined();
		expect(diagnostics.blocking_reasons).toEqual([]);
		expect(diagnostics.full_suite_required).toBe(false);
		expect(diagnostics.lifecycle_counts.gate_result).toBe(0);
	});
});
