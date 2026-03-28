import { describe, expect, it } from 'vitest';
import type { ConductorRun, ConductorTask } from '../../../shared/types';
import {
	buildConductorConflictResolutionPrompt,
	collectConductorRunArtifactPaths,
	collectConductorWorkerBranches,
	getConductorCompletedBranchSelection,
} from '../../../renderer/services/conductorIntegrationRuntime';

function buildTask(overrides: Partial<ConductorTask> = {}): ConductorTask {
	return {
		id: 'task-1',
		groupId: 'group-1',
		title: 'Task',
		description: '',
		acceptanceCriteria: [],
		priority: 'medium',
		status: 'ready',
		dependsOn: [],
		scopePaths: [],
		source: 'planner',
		attentionRequest: null,
		agentHistory: [],
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function buildRun(overrides: Partial<ConductorRun> = {}): ConductorRun {
	return {
		id: 'run-1',
		groupId: 'group-1',
		kind: 'execution',
		baseBranch: 'main',
		integrationBranch: '',
		status: 'completed',
		taskIds: ['task-1'],
		events: [],
		startedAt: 1,
		...overrides,
	};
}

describe('conductorIntegrationRuntime', () => {
	it('deduplicates collected artifact paths and worker branches', () => {
		const run = buildRun({
			worktreePath: '/tmp/integration',
			worktreePaths: ['/tmp/integration', '/tmp/worker-a'],
			taskWorktreePaths: {
				'task-1': '/tmp/worker-a',
				'task-2': '/tmp/worker-b',
			},
			workerBranches: ['codex/a', 'codex/b'],
			taskBranches: {
				'task-1': 'codex/b',
				'task-2': 'codex/c',
			},
		});

		expect(collectConductorRunArtifactPaths(run)).toEqual([
			'/tmp/integration',
			'/tmp/worker-a',
			'/tmp/worker-b',
		]);
		expect(collectConductorWorkerBranches(run)).toEqual(['codex/a', 'codex/b', 'codex/c']);
	});

	it('selects only done tasks with recorded branches for integration', () => {
		const executionRun = buildRun({
			taskIds: ['task-1', 'task-2', 'task-3'],
			taskBranches: {
				'task-1': 'codex/task-1',
				'task-2': 'codex/task-2',
			},
		});
		const tasksById = new Map([
			['task-1', buildTask({ id: 'task-1', status: 'done' })],
			['task-2', buildTask({ id: 'task-2', status: 'needs_review' })],
			['task-3', buildTask({ id: 'task-3', status: 'done' })],
		]);

		expect(
			getConductorCompletedBranchSelection({
				executionRun,
				tasksById,
			})
		).toEqual({
			completedTaskIds: ['task-1'],
			completedBranches: ['codex/task-1'],
		});
	});

	it('builds a conflict-resolution prompt with validation guidance', () => {
		const prompt = buildConductorConflictResolutionPrompt({
			groupName: 'Questionaire',
			integrationBranch: 'codex/conductor-integrate-questionaire-1234',
			baseBranch: 'main',
			worktreePath: '/tmp/questionaire',
			validationCommand: 'npm test',
		});

		expect(prompt).toContain('Resolve the current git merge conflict');
		expect(prompt).toContain('`npm test`');
		expect(prompt).toContain('/tmp/questionaire');
	});
});
