import { describe, it, expect } from 'vitest';
import { DoneGateEngine } from '../../../main/core-upgrades';
import type { TaskContract } from '../../../main/core-upgrades/types';

const baseTask: TaskContract = {
	task_id: 'task-1',
	goal: 'Implement fix',
	repo_root: '/tmp/project',
	language_profile: 'ts_js',
	risk_level: 'medium',
	allowed_commands: ['npm test'],
	done_gate_profile: 'standard',
	max_changed_files: 5,
	created_at: Date.now(),
};

describe('DoneGateEngine', () => {
	it('blocks completion when targeted checks fail', () => {
		const engine = new DoneGateEngine();
		const decision = engine.evaluate({
			task: baseTask,
			targeted_checks: [{ command: 'npm test', exit_code: 1, pass: false, duration_ms: 100 }],
		});
		expect(decision.decision).toBe('continue');
		expect(decision.blocking_reasons).toContain('targeted_checks_failed');
	});

	it('marks task complete when checks pass and no blockers exist', () => {
		const engine = new DoneGateEngine();
		const decision = engine.evaluate({
			task: { ...baseTask, done_gate_profile: 'quick' },
			targeted_checks: [{ command: 'npm test', exit_code: 0, pass: true, duration_ms: 120 }],
			review_findings: [],
		});
		expect(decision.decision).toBe('complete');
	});
});
