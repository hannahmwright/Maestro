import { describe, expect, it } from 'vitest';
import {
	buildConductorIntegrationTarget,
	buildConductorWorktreeTarget,
	evaluateConductorResourceGate,
	tasksConflict,
} from '../../../renderer/services/conductorRuntime';
import type { ConductorTask } from '../../../renderer/types';

function createTask(id: string, scopePaths: string[]): ConductorTask {
	return {
		id,
		groupId: 'group-1',
		title: id,
		description: '',
		acceptanceCriteria: [],
		priority: 'medium',
		status: 'ready',
		dependsOn: [],
		scopePaths,
		source: 'planner',
		createdAt: 1,
		updatedAt: 1,
	};
}

describe('conductorRuntime', () => {
	it('builds a codex-prefixed worktree branch and sibling path', () => {
		const target = buildConductorWorktreeTarget(
			'/Users/hannahwright/Documents/Code/Maestro',
			'Main Product',
			'conductor-run-12345678'
		);

		expect(target.branchName).toBe('codex/conductor-main-product-12345678');
		expect(target.worktreePath).toBe(
			'/Users/hannahwright/Documents/Code/Maestro-conductor-main-product-12345678'
		);
	});

	it('builds an integration worktree target', () => {
		const target = buildConductorIntegrationTarget(
			'/Users/hannahwright/Documents/Code/Maestro',
			'Main Product',
			'conductor-run-87654321'
		);

		expect(target.branchName).toBe('codex/conductor-integrate-main-product-87654321');
		expect(target.worktreePath).toBe(
			'/Users/hannahwright/Documents/Code/Maestro-conductor-integrate-main-product-87654321'
		);
	});

	it('returns a conservative single-worker resource cap', () => {
		const result = evaluateConductorResourceGate('conservative');

		expect(result.maxWorkers).toBe(1);
		expect(result.allowed).toBe(true);
	});

	it('treats overlapping scope paths as conflicting', () => {
		expect(
			tasksConflict(
				createTask('left', ['src/renderer']),
				createTask('right', ['src/renderer/components'])
			)
		).toBe(true);
		expect(
			tasksConflict(createTask('left', ['src/main']), createTask('right', ['src/renderer']))
		).toBe(false);
		expect(tasksConflict(createTask('left', []), createTask('right', ['src/renderer']))).toBe(true);
	});
});
