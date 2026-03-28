import { describe, expect, it } from 'vitest';
import {
	buildConductorAutoplayReadyKey,
	canConductorAutoplayRetryTask,
	deriveConductorWorkspaceAutoplayAction,
	deriveConductorWorkspaceResourceHoldUpdate,
	isConductorAutoplayTaskCoolingDown,
} from '../../../renderer/services/conductorWorkspaceAutoplay';

describe('conductorWorkspaceAutoplay', () => {
	it('prioritizes auto-approving a pending plan before other work', () => {
		expect(
			deriveConductorWorkspaceAutoplayAction({
				hasPendingRun: true,
				autoExecuteOnPlanCreation: true,
				tasksNeedingPlanningCount: 2,
				dependencyReadyCount: 3,
				reviewReadyCount: 1,
				hasSelectedTemplate: true,
				gitReady: true,
				resourceAllowed: true,
				isAutoplayPaused: false,
				isPlanning: false,
				isExecuting: false,
				isReviewing: false,
				isIntegrating: false,
				hasPlanningLock: false,
				hasExecutionLock: false,
				hasReviewLock: false,
			})
		).toBe('approve_plan');
	});

	it('chooses execution before review when runnable tasks are ready', () => {
		expect(
			deriveConductorWorkspaceAutoplayAction({
				hasPendingRun: false,
				autoExecuteOnPlanCreation: true,
				tasksNeedingPlanningCount: 0,
				dependencyReadyCount: 2,
				reviewReadyCount: 4,
				hasSelectedTemplate: true,
				gitReady: true,
				resourceAllowed: true,
				isAutoplayPaused: false,
				isPlanning: false,
				isExecuting: false,
				isReviewing: false,
				isIntegrating: false,
				hasPlanningLock: false,
				hasExecutionLock: false,
				hasReviewLock: false,
			})
		).toBe('run_execution');
	});

	it('returns a hold update only when resource gating should change the board state', () => {
		expect(
			deriveConductorWorkspaceResourceHoldUpdate({
				currentHoldReason: null,
				resourceAllowed: false,
				resourceHoldMessage: 'Resources are constrained.',
				dependencyReadyCount: 1,
				reviewReadyCount: 0,
			})
		).toBe('Resources are constrained.');

		expect(
			deriveConductorWorkspaceResourceHoldUpdate({
				currentHoldReason: 'Resources are constrained.',
				resourceAllowed: true,
				resourceHoldMessage: 'Resources are constrained.',
				dependencyReadyCount: 0,
				reviewReadyCount: 0,
			})
		).toBeNull();
	});

	it('lets an explicitly updated task bypass blocked-run cooldown immediately', () => {
		expect(
			canConductorAutoplayRetryTask({
				run: {
					status: 'blocked',
					startedAt: 100,
					endedAt: 200,
				},
				retryableStatuses: ['blocked', 'attention_required'],
				taskUpdatedAt: 250,
				cooldownMs: 300000,
				now: 260,
			})
		).toBe(true);
	});

	it('still reports cooldown when the task has not changed since the blocked run', () => {
		expect(
			isConductorAutoplayTaskCoolingDown({
				run: {
					status: 'attention_required',
					startedAt: 100,
					endedAt: 200,
				},
				retryableStatuses: ['blocked', 'attention_required'],
				taskUpdatedAt: 199,
				cooldownMs: 300000,
				now: 260,
			})
		).toBe(true);
	});

	it('treats a task reset at the same timestamp as the last run end as immediately retryable', () => {
		expect(
			canConductorAutoplayRetryTask({
				run: {
					status: 'attention_required',
					startedAt: 100,
					endedAt: 200,
				},
				retryableStatuses: ['blocked', 'attention_required'],
				taskUpdatedAt: 200,
				cooldownMs: 300000,
				now: 201,
			})
		).toBe(true);
	});

	it('includes task freshness in autoplay ready keys', () => {
		expect(
			buildConductorAutoplayReadyKey([
				{ id: 'task-1', updatedAt: 100 },
				{ id: 'task-2', updatedAt: 200 },
			])
		).toBe('task-1:100|task-2:200');
	});
});
