import { describe, it, expect } from 'vitest';
import { DoneGateEngine } from '../../../main/core-upgrades';
import type { ReviewFinding, TaskContract } from '../../../main/core-upgrades/types';

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
	const criticalFinding: ReviewFinding = {
		id: 'finding-critical',
		severity: 'critical',
		confidence: 0.9,
		regression_risk: 'high',
		message: 'Critical regression risk',
		missing_tests: true,
		affected_surfaces: ['main-process'],
		blocking: true,
	};

	it('blocks completion when targeted checks are missing', () => {
		const engine = new DoneGateEngine();
		const decision = engine.evaluate({
			task: baseTask,
			targeted_checks: [],
		});
		expect(decision.decision).toBe('continue');
		expect(decision.blocking_reasons).toContain('targeted_checks_missing');
	});

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

	it('blocks completion when non-waived high-severity review findings exist', () => {
		const engine = new DoneGateEngine();
		const decision = engine.evaluate({
			task: { ...baseTask, done_gate_profile: 'quick' },
			targeted_checks: [{ command: 'npm test', exit_code: 0, pass: true, duration_ms: 120 }],
			review_findings: [criticalFinding],
		});
		expect(decision.decision).toBe('blocked');
		expect(decision.blocking_reasons).toContain('blocking_review_findings');
	});

	it('allows completion when blocking findings are explicitly waived in task metadata', () => {
		const engine = new DoneGateEngine();
		const decision = engine.evaluate({
			task: {
				...baseTask,
				done_gate_profile: 'quick',
				metadata: { waived_review_finding_ids: ['finding-critical'] },
			},
			targeted_checks: [{ command: 'npm test', exit_code: 0, pass: true, duration_ms: 120 }],
			review_findings: [criticalFinding],
		});
		expect(decision.decision).toBe('complete');
		expect(decision.blocking_reasons).toEqual([]);
	});

	it('requires full suite for cross-package changes in standard profile', () => {
		const engine = new DoneGateEngine();
		const decision = engine.evaluate({
			task: baseTask,
			targeted_checks: [{ command: 'npm test', exit_code: 0, pass: true, duration_ms: 100 }],
			cross_package_change: true,
		});
		expect(decision.requires_full_suite).toBe(true);
		expect(decision.blocking_reasons).toContain('full_suite_required');
	});

	it('requires full suite for high-risk edit signals in standard profile', () => {
		const engine = new DoneGateEngine();
		const decision = engine.evaluate({
			task: { ...baseTask, done_gate_profile: 'standard' },
			targeted_checks: [{ command: 'npm test', exit_code: 0, pass: true, duration_ms: 90 }],
			high_risk_edit: true,
		});
		expect(decision.requires_full_suite).toBe(true);
		expect(decision.blocking_reasons).toContain('full_suite_required');
	});

	it('keeps quick profile targeted-only even when risk signals are high', () => {
		const engine = new DoneGateEngine();
		const decision = engine.evaluate({
			task: { ...baseTask, done_gate_profile: 'quick' },
			targeted_checks: [{ command: 'npm test', exit_code: 0, pass: true, duration_ms: 90 }],
			high_risk_edit: true,
		});
		expect(decision.requires_full_suite).toBe(false);
		expect(decision.blocking_reasons).not.toContain('full_suite_required');
		expect(decision.decision).toBe('complete');
	});
});
