import { describe, it, expect } from 'vitest';
import { createTaskContract, validateTaskContract } from '../../../main/core-upgrades';

describe('task-contract', () => {
	it('creates a valid contract with defaults', () => {
		const contract = createTaskContract({
			goal: 'Fix failing tests',
			repo_root: '/tmp/project',
		});

		expect(contract.task_id).toContain('task-');
		expect(contract.goal).toBe('Fix failing tests');
		expect(contract.done_gate_profile).toBe('standard');
		expect(contract.allowed_commands.length).toBeGreaterThan(0);
	});

	it('rejects invalid contract state', () => {
		expect(() =>
			validateTaskContract({
				task_id: '',
				goal: '',
				repo_root: 'relative/path',
				language_profile: 'ts_js',
				risk_level: 'medium',
				allowed_commands: [],
				done_gate_profile: 'standard',
				max_changed_files: 0,
				created_at: Date.now(),
			})
		).toThrow();
	});
});
