import { describe, expect, it } from 'vitest';
import type { Conductor } from '../../shared/types';
import { transitionConductorWorkspace } from '../../shared/conductorWorkspaceMachine';

function buildConductor(overrides: Partial<Conductor> = {}): Conductor {
	return {
		groupId: 'group-1',
		status: 'idle',
		resourceProfile: 'balanced',
		currentPlanningRunId: null,
		currentExecutionRunId: null,
		currentReviewRunId: null,
		currentIntegrationRunId: null,
		autoExecuteOnPlanCreation: true,
		isPaused: false,
		holdReason: null,
		keepConductorAgentSessions: false,
		publishPolicy: 'manual_pr',
		deleteWorkerBranchesOnSuccess: false,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe('conductorWorkspaceMachine', () => {
	it('moves planning into awaiting approval and then back to idle', () => {
		const planning = transitionConductorWorkspace(
			buildConductor(),
			{ type: 'PLANNING_STARTED' },
			10
		);
		const awaiting = transitionConductorWorkspace(
			planning,
			{ type: 'PLAN_AWAITING_APPROVAL' },
			11
		);
		const idle = transitionConductorWorkspace(awaiting, { type: 'RESET_TO_IDLE' }, 12);

		expect(planning).toEqual(
			expect.objectContaining({ status: 'planning', isPaused: false, holdReason: null, updatedAt: 10 })
		);
		expect(awaiting).toEqual(
			expect.objectContaining({
				status: 'awaiting_approval',
				isPaused: false,
				holdReason: null,
				updatedAt: 11,
			})
		);
		expect(idle).toEqual(
			expect.objectContaining({ status: 'idle', isPaused: false, holdReason: null, updatedAt: 12 })
		);
	});

	it('captures paused attention when planning fails on provider limits', () => {
		const next = transitionConductorWorkspace(
			buildConductor({ status: 'planning' }),
			{ type: 'PLANNING_FAILED', pause: true, holdReason: 'Codex credits are exhausted.' },
			20
		);

		expect(next).toEqual(
			expect.objectContaining({
				status: 'attention_required',
				isPaused: true,
				holdReason: 'Codex credits are exhausted.',
				updatedAt: 20,
			})
		);
	});

	it('resolves execution and review lanes through explicit next states', () => {
		const afterExecution = transitionConductorWorkspace(
			buildConductor({ status: 'running' }),
			{ type: 'EXECUTION_RESOLVED', nextStatus: 'blocked', holdReason: 'Waiting on API key.' },
			30
		);
		const afterReview = transitionConductorWorkspace(
			buildConductor({ status: 'running' }),
			{ type: 'REVIEW_RESOLVED', nextStatus: 'idle', holdReason: null },
			31
		);

		expect(afterExecution).toEqual(
			expect.objectContaining({
				status: 'blocked',
				holdReason: 'Waiting on API key.',
				updatedAt: 30,
			})
		);
		expect(afterReview).toEqual(
			expect.objectContaining({ status: 'idle', holdReason: null, updatedAt: 31 })
		);
	});
});
