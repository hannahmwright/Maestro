import { describe, expect, it } from 'vitest';
import type { ConductorRun, ConductorTask } from '../../../shared/types';
import {
	canRecoverStaleConductorReviewRun,
	getDependencyReadyConductorTasks,
	resolveConductorExecutionLane,
	resolveConductorReviewLane,
} from '../../../renderer/services/conductorLaneOrchestration';

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
		status: 'running',
		taskIds: ['task-1'],
		events: [],
		startedAt: 1,
		...overrides,
	};
}

describe('conductorLaneOrchestration', () => {
	it('returns dependency-ready tasks sorted by priority then createdAt', () => {
		const tasks = [
			buildTask({ id: 'task-1', priority: 'medium', createdAt: 3 }),
			buildTask({ id: 'task-2', priority: 'high', createdAt: 5 }),
			buildTask({ id: 'task-3', priority: 'high', createdAt: 2 }),
		];

		const ready = getDependencyReadyConductorTasks({
			tasks,
			childTasksByParentId: new Map(),
			runs: [],
			completedTaskIds: new Set(),
			stateOptions: { allowLegacyFallback: false },
		});

		expect(ready.map((task) => task.id)).toEqual(['task-3', 'task-2', 'task-1']);
	});

	it('resolves execution lane completion with blocked attention', () => {
		const resolution = resolveConductorExecutionLane({
			tasks: [buildTask({ status: 'needs_input' })],
			childTasksByParentId: new Map(),
			runs: [],
			blockedTaskIds: new Set(['task-1']),
			blockedMessage: 'Blocked by dependency',
			pausedByUser: false,
			userPausedMessage: 'Paused by you.',
			stateOptions: { allowLegacyFallback: false },
		});

		expect(resolution.runStatus).toBe('blocked');
		expect(resolution.eventType).toBe('execution_failed');
		expect(resolution.conductorStatus).toBe('blocked');
		expect(resolution.errorMessage).toBe('Blocked by dependency');
	});

	it('resolves review lane outcome and rerunnable tasks', () => {
		const reviewTask = buildTask({ id: 'task-1', status: 'needs_revision' });
		const followUp = buildTask({ id: 'task-2', status: 'ready', createdAt: 2 });
		const resolution = resolveConductorReviewLane({
			reviewReadyTasks: [reviewTask],
			postReviewTasks: [reviewTask, followUp],
			postReviewChildTaskMap: new Map(),
			runs: [buildRun({ kind: 'review', status: 'completed', taskIds: ['task-1'] })],
			malformedResponses: 0,
			changesRequested: 1,
			pausedByUser: false,
			userPausedMessage: 'Paused by you.',
			stateOptions: { allowLegacyFallback: false },
		});

		expect(resolution.runStatus).toBe('completed');
		expect(resolution.conductorStatus).toBe('idle');
		expect(resolution.reviewError).toBeNull();
		expect(resolution.dependencyReadyTasks.map((task) => task.id)).toEqual(['task-1', 'task-2']);
	});

	it('allows stale review recovery when review tasks are still in QA but reviewers are idle', () => {
		const reviewTask = buildTask({
			id: 'task-1',
			status: 'needs_review',
			updatedAt: 1,
			reviewerSessionId: 'reviewer-1',
		});
		const run = buildRun({
			kind: 'review',
			taskIds: ['task-1'],
			taskReviewerSessionIds: {
				'task-1': 'reviewer-1',
			},
			startedAt: 1,
		});

		const result = canRecoverStaleConductorReviewRun({
			run,
			tasksById: new Map([[reviewTask.id, reviewTask]]),
			sessionById: new Map([['reviewer-1', { state: 'idle' }]]),
			now: 100_000,
			staleAfterMs: 90_000,
		});

		expect(result).toBe(true);
	});

	it('keeps review recovery blocked while a reviewer is still busy', () => {
		const reviewTask = buildTask({
			id: 'task-1',
			status: 'needs_review',
			updatedAt: 1,
			reviewerSessionId: 'reviewer-1',
		});
		const run = buildRun({
			kind: 'review',
			taskIds: ['task-1'],
			taskReviewerSessionIds: {
				'task-1': 'reviewer-1',
			},
			startedAt: 1,
		});

		const result = canRecoverStaleConductorReviewRun({
			run,
			tasksById: new Map([[reviewTask.id, reviewTask]]),
			sessionById: new Map([['reviewer-1', { state: 'busy' }]]),
			now: 100_000,
			staleAfterMs: 90_000,
		});

		expect(result).toBe(false);
	});
});
