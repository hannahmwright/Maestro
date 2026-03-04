import { describe, it, expect } from 'vitest';
import { ReviewRigorEngine } from '../../../main/core-upgrades';
import type { TaskContract } from '../../../main/core-upgrades/types';

const baseTask: TaskContract = {
	task_id: 'task-review-1',
	goal: 'Review patch',
	repo_root: '/tmp/project',
	language_profile: 'ts_js',
	risk_level: 'medium',
	allowed_commands: ['npm test'],
	done_gate_profile: 'standard',
	max_changed_files: 5,
	created_at: Date.now(),
};

describe('ReviewRigorEngine', () => {
	it('flags high-risk patches with missing tests', () => {
		const engine = new ReviewRigorEngine();
		const findings = engine.analyzePatch({
			task: { ...baseTask, risk_level: 'high' },
			changed_files: ['src/main/service.ts'],
		});

		expect(findings.some((finding) => finding.missing_tests && finding.severity === 'high')).toBe(
			true
		);
	});

	it('reports affected surfaces from changed file paths', () => {
		const engine = new ReviewRigorEngine();
		const findings = engine.analyzePatch({
			task: { ...baseTask, risk_level: 'high' },
			changed_files: ['src/main/service.ts', 'src/renderer/components/View.tsx'],
		});

		const affectedSurfaceSet = new Set(findings.flatMap((finding) => finding.affected_surfaces));
		expect(affectedSurfaceSet.has('main-process')).toBe(true);
		expect(affectedSurfaceSet.has('renderer')).toBe(true);
	});
});
