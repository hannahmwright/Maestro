import { describe, it, expect } from 'vitest';
import { EditPlanner } from '../../../main/core-upgrades';
import type { TaskContract } from '../../../main/core-upgrades/types';

const baseTask: TaskContract = {
	task_id: 'task-ep-1',
	goal: 'Apply focused patch',
	repo_root: '/tmp/project',
	language_profile: 'ts_js',
	risk_level: 'medium',
	allowed_commands: ['npm test'],
	done_gate_profile: 'standard',
	max_changed_files: 2,
	created_at: Date.now(),
};

describe('EditPlanner', () => {
	it('blocks edits without a change reason', () => {
		const planner = new EditPlanner();
		const plan = planner.planEdits({
			task: baseTask,
			proposed_edits: [{ file_path: 'src/main/app.ts', reason: '   ' }],
			related_files: ['src/main/app.ts'],
		});

		expect(plan.valid).toBe(false);
		expect(plan.file_plans[0].block_reason).toContain('missing_change_reason');
	});

	it('blocks unrelated files by default', () => {
		const planner = new EditPlanner();
		const plan = planner.planEdits({
			task: baseTask,
			proposed_edits: [{ file_path: 'src/other.ts', reason: 'Fix type mismatch' }],
			related_files: ['src/main/app.ts'],
		});

		expect(plan.valid).toBe(false);
		expect(plan.file_plans[0].block_reason).toContain('unrelated_file');
	});

	it('allows unrelated files when explicitly enabled in task metadata', () => {
		const planner = new EditPlanner();
		const plan = planner.planEdits({
			task: {
				...baseTask,
				metadata: { allow_unrelated_file_edits: true },
			},
			proposed_edits: [{ file_path: 'src/other.ts', reason: 'Fix shared helper import' }],
			related_files: ['src/main/app.ts'],
		});

		expect(plan.valid).toBe(true);
		expect(plan.file_plans[0].blocked).toBe(false);
	});
});
