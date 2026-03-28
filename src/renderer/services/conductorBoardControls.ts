import type {
	ConductorTask,
	ConductorTaskAttentionRequest,
	ConductorTaskCompletionProofStatus,
	ConductorTaskStatus,
} from '../types';
import { isConductorCompletionProofAttentionRequestId } from '../../shared/conductorTasks';
import {
	buildConductorTaskCompletionProofRequirementPatch,
	buildConductorTaskCompletionProofStatusPatch,
	buildConductorTaskResolveAttentionPatch,
	buildConductorTaskStatusMovePatch,
} from './conductorTaskControls';

export function resolveConductorBootstrapExecutionFollowUp(input: {
	isAutoplayPaused: boolean;
	dependencyReadyCount: number;
	hasPendingRun: boolean;
	isPlanning: boolean;
	isReviewing: boolean;
	isIntegrating: boolean;
}): boolean {
	return (
		!input.isAutoplayPaused &&
		input.dependencyReadyCount > 0 &&
		!input.hasPendingRun &&
		!input.isPlanning &&
		!input.isReviewing &&
		!input.isIntegrating
	);
}

export function resolveConductorRemotePathCopyToast(input: {
	copied: boolean;
	remotePath: string;
}): {
	type: 'success' | 'error';
	title: string;
	message: string;
} {
	if (input.copied) {
		return {
			type: 'success',
			title: 'Remote Path Copied',
			message: input.remotePath,
		};
	}

	return {
		type: 'error',
		title: 'Copy Failed',
		message: 'Failed to copy remote path to the clipboard.',
	};
}

export function buildConductorBoardTaskStatusPatch(input: {
	task: ConductorTask;
	nextStatus: ConductorTaskStatus;
	currentAttention: ConductorTaskAttentionRequest | null;
}): Partial<ConductorTask> {
	return buildConductorTaskStatusMovePatch({
		task: input.task,
		nextStatus: input.nextStatus,
		currentAttention: input.currentAttention,
		isProofAttention: isConductorCompletionProofAttentionRequestId(input.currentAttention?.id),
	});
}

export function buildConductorBoardTaskProofRequirementPatch(
	task: ConductorTask,
	enabled: boolean
): Partial<ConductorTask> {
	return buildConductorTaskCompletionProofRequirementPatch(task, enabled);
}

export function buildConductorBoardTaskProofStatusPatch(
	task: ConductorTask,
	nextStatus: ConductorTaskCompletionProofStatus
): Partial<ConductorTask> {
	return buildConductorTaskCompletionProofStatusPatch(task, nextStatus);
}

export function buildConductorBoardTaskAttentionResolutionPatch(input: {
	task: ConductorTask;
	currentAttention: ConductorTaskAttentionRequest | null;
	response: string;
}): Partial<ConductorTask> {
	return buildConductorTaskResolveAttentionPatch({
		task: input.task,
		currentAttention: input.currentAttention,
		response: input.response,
	});
}
