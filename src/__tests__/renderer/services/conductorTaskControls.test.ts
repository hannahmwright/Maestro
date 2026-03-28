import { describe, expect, it } from 'vitest';
import type { ConductorTask, ConductorTaskAttentionRequest } from '../../../shared/types';
import {
	buildConductorTaskCompletionProofRequirementPatch,
	buildConductorTaskCompletionProofStatusPatch,
	buildConductorTaskResolveAttentionPatch,
	buildConductorTaskStatusMovePatch,
} from '../../../renderer/services/conductorTaskControls';

function buildTask(overrides: Partial<ConductorTask> = {}): ConductorTask {
	return {
		id: 'task-1',
		groupId: 'group-1',
		title: 'Task',
		description: 'Original',
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

function buildAttention(overrides: Partial<ConductorTaskAttentionRequest> = {}): ConductorTaskAttentionRequest {
	return {
		id: 'attention-1',
		status: 'open',
		kind: 'clarification',
		summary: 'Need info',
		requestedAction: 'Answer the question',
		requestedByRole: 'worker',
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe('conductorTaskControls', () => {
	it('resolves non-proof attention when moving task to a non-input lane', () => {
		const patch = buildConductorTaskStatusMovePatch({
			task: buildTask(),
			nextStatus: 'ready',
			currentAttention: buildAttention(),
			isProofAttention: false,
			now: 10,
		});

		expect(patch).toEqual({
			status: 'ready',
			workerSessionId: undefined,
			workerSessionName: undefined,
			reviewerSessionId: undefined,
			reviewerSessionName: undefined,
			attentionRequest: expect.objectContaining({
				status: 'resolved',
				updatedAt: 10,
				resolvedAt: 10,
			}),
		});
	});

	it('moves done proof-required work back to needs_proof when enabling proof', () => {
		const patch = buildConductorTaskCompletionProofRequirementPatch(
			buildTask({ status: 'done' }),
			true,
			20
		);

		expect(patch.status).toBe('needs_proof');
		expect(patch.completionProofRequirement).toBeDefined();
		expect(patch.completionProof).toBeDefined();
	});

	it('approving proof moves needs_proof task to done', () => {
		const patch = buildConductorTaskCompletionProofStatusPatch(
			buildTask({
				status: 'needs_proof',
				completionProofRequirement: { required: true, requireVideo: true, minScreenshots: 1 },
			}),
			'approved',
			30
		);

		expect(patch.status).toBe('done');
		expect(patch.attentionRequest).toBeNull();
		expect(patch.completionProof).toEqual(
			expect.objectContaining({
				status: 'approved',
				approvedAt: 30,
			})
		);
	});

	it('resolving attention appends operator follow-up and returns task to ready', () => {
		const patch = buildConductorTaskResolveAttentionPatch({
			task: buildTask(),
			currentAttention: buildAttention(),
			response: 'Use the admin account.',
			now: 40,
		});

		expect(patch).toEqual({
			description: 'Original\n\nOperator follow-up:\nUse the admin account.',
			status: 'ready',
			workerSessionId: undefined,
			workerSessionName: undefined,
			reviewerSessionId: undefined,
			reviewerSessionName: undefined,
			attentionRequest: expect.objectContaining({
				status: 'resolved',
				response: 'Use the admin account.',
				updatedAt: 40,
				resolvedAt: 40,
			}),
		});
	});

	it('preserves assigned sessions when moving into another non-ready lane', () => {
		const patch = buildConductorTaskStatusMovePatch({
			task: buildTask({
				status: 'running',
				workerSessionId: 'worker-1',
				workerSessionName: 'Rowan',
				reviewerSessionId: 'reviewer-1',
				reviewerSessionName: 'Vera',
			}),
			nextStatus: 'blocked',
			currentAttention: buildAttention(),
			isProofAttention: false,
			now: 50,
		});

		expect(patch).toEqual({
			status: 'blocked',
			workerSessionId: 'worker-1',
			workerSessionName: 'Rowan',
			reviewerSessionId: 'reviewer-1',
			reviewerSessionName: 'Vera',
			attentionRequest: expect.objectContaining({
				status: 'resolved',
				updatedAt: 50,
				resolvedAt: 50,
			}),
		});
	});
});
