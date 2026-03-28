import { describe, expect, it } from 'vitest';
import type {
	ConductorTask,
	ConductorTaskAttentionRequest,
} from '../../../shared/types';
import {
	buildConductorBoardTaskAttentionResolutionPatch,
	buildConductorBoardTaskProofRequirementPatch,
	buildConductorBoardTaskProofStatusPatch,
	buildConductorBoardTaskStatusPatch,
	resolveConductorBootstrapExecutionFollowUp,
	resolveConductorRemotePathCopyToast,
} from '../../../renderer/services/conductorBoardControls';

function buildTask(overrides: Partial<ConductorTask> = {}): ConductorTask {
	return {
		id: 'task-1',
		groupId: 'group-1',
		title: 'Task',
		description: '',
		acceptanceCriteria: [],
		priority: 'medium',
		status: 'needs_input',
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

function buildAttention(
	overrides: Partial<ConductorTaskAttentionRequest> = {}
): ConductorTaskAttentionRequest {
	return {
		id: 'attention-1',
		status: 'open',
		kind: 'operator_reply',
		summary: 'Need input',
		requestedAction: 'Respond',
		requestedByRole: 'worker',
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe('conductorBoardControls', () => {
	it('decides whether git bootstrap should immediately kick execution', () => {
		expect(
			resolveConductorBootstrapExecutionFollowUp({
				isAutoplayPaused: false,
				dependencyReadyCount: 2,
				hasPendingRun: false,
				isPlanning: false,
				isReviewing: false,
				isIntegrating: false,
			})
		).toBe(true);

		expect(
			resolveConductorBootstrapExecutionFollowUp({
				isAutoplayPaused: true,
				dependencyReadyCount: 2,
				hasPendingRun: false,
				isPlanning: false,
				isReviewing: false,
				isIntegrating: false,
			})
		).toBe(false);
	});

	it('builds copy-path feedback toasts', () => {
		expect(
			resolveConductorRemotePathCopyToast({
				copied: true,
				remotePath: '/remote/path',
			})
		).toEqual({
			type: 'success',
			title: 'Remote Path Copied',
			message: '/remote/path',
		});

		expect(
			resolveConductorRemotePathCopyToast({
				copied: false,
				remotePath: '/remote/path',
			})
		).toEqual({
			type: 'error',
			title: 'Copy Failed',
			message: 'Failed to copy remote path to the clipboard.',
		});
	});

	it('builds board task patches through the shared task-control rules', () => {
		const task = buildTask({ status: 'needs_input', attentionRequest: buildAttention() });

		expect(
			buildConductorBoardTaskStatusPatch({
				task,
				nextStatus: 'ready',
				currentAttention: task.attentionRequest,
			})
		).toEqual(expect.objectContaining({ status: 'ready' }));
		expect(buildConductorBoardTaskProofRequirementPatch(task, true)).toEqual(
			expect.objectContaining({
				completionProofRequirement: expect.objectContaining({ required: true }),
			})
		);
		expect(buildConductorBoardTaskProofStatusPatch(task, 'approved')).toEqual(
			expect.objectContaining({
				completionProof: expect.objectContaining({ status: 'approved' }),
			})
		);
		expect(
			buildConductorBoardTaskAttentionResolutionPatch({
				task,
				currentAttention: task.attentionRequest,
				response: 'Use the existing API.',
			})
		).toEqual(
			expect.objectContaining({
				status: 'ready',
				description: expect.stringContaining('Use the existing API.'),
				attentionRequest: expect.objectContaining({
					status: 'resolved',
					response: 'Use the existing API.',
				}),
			})
		);
	});
});
