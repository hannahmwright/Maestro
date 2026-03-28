import type {
	ConductorTask,
	ConductorTaskAttentionRequest,
	ConductorTaskCompletionProofStatus,
	ConductorTaskStatus,
} from '../types';
import {
	buildDefaultConductorTaskCompletionProof,
	buildDefaultConductorTaskCompletionProofRequirement,
	hasConductorTaskApprovedCompletionProof,
	requiresConductorTaskCompletionProof,
} from '../../shared/conductorTasks';

export function buildConductorTaskStatusMovePatch(input: {
	task: ConductorTask;
	nextStatus: ConductorTaskStatus;
	currentAttention: ConductorTaskAttentionRequest | null;
	isProofAttention: boolean;
	now?: number;
}): Pick<
	ConductorTask,
	| 'status'
	| 'attentionRequest'
	| 'workerSessionId'
	| 'workerSessionName'
	| 'reviewerSessionId'
	| 'reviewerSessionName'
> {
	const now = input.now ?? Date.now();
	const nextAttentionRequest =
		input.nextStatus === 'needs_input' || input.nextStatus === 'needs_proof'
			? input.currentAttention
			: input.isProofAttention
				? null
				: input.currentAttention?.status === 'open'
					? {
							...input.currentAttention,
							status: 'resolved' as const,
							updatedAt: now,
							resolvedAt: now,
						}
					: input.currentAttention;
	const shouldClearAssignedSessions = input.nextStatus === 'ready';

	return {
		status: input.nextStatus,
		attentionRequest: nextAttentionRequest,
		workerSessionId: shouldClearAssignedSessions ? undefined : input.task.workerSessionId,
		workerSessionName: shouldClearAssignedSessions ? undefined : input.task.workerSessionName,
		reviewerSessionId: shouldClearAssignedSessions ? undefined : input.task.reviewerSessionId,
		reviewerSessionName: shouldClearAssignedSessions
			? undefined
			: input.task.reviewerSessionName,
	};
}

export function buildConductorTaskCompletionProofRequirementPatch(
	task: ConductorTask,
	enabled: boolean,
	now = Date.now()
): Pick<
	ConductorTask,
	'status' | 'attentionRequest' | 'completionProofRequirement' | 'completionProof'
> {
	const nextRequirement = enabled
		? task.completionProofRequirement || buildDefaultConductorTaskCompletionProofRequirement()
		: undefined;
	const nextProof = enabled
		? task.completionProof || buildDefaultConductorTaskCompletionProof(now)
		: undefined;

	return {
		status: enabled
			? task.status === 'done' &&
				!hasConductorTaskApprovedCompletionProof({
					...task,
					completionProofRequirement: nextRequirement,
					completionProof: nextProof,
				})
				? 'needs_proof'
				: task.status
			: task.status === 'needs_proof'
				? 'done'
				: task.status,
		attentionRequest: !enabled ? null : task.attentionRequest,
		completionProofRequirement: nextRequirement,
		completionProof: nextProof,
	};
}

export function buildConductorTaskCompletionProofStatusPatch(
	task: ConductorTask,
	nextStatus: ConductorTaskCompletionProofStatus,
	now = Date.now()
): Pick<ConductorTask, 'status' | 'attentionRequest' | 'completionProof'> {
	const currentProof = task.completionProof || buildDefaultConductorTaskCompletionProof(now);
	const nextTaskStatus =
		nextStatus === 'approved'
			? task.status === 'needs_proof'
				? 'done'
				: task.status
			: task.status === 'done' && requiresConductorTaskCompletionProof(task)
				? 'needs_proof'
				: task.status;

	return {
		status: nextTaskStatus,
		attentionRequest: nextTaskStatus === 'done' ? null : task.attentionRequest,
		completionProof: {
			...currentProof,
			status: nextStatus,
			requestedAt: currentProof.requestedAt || now,
			capturedAt:
				nextStatus === 'captured' || nextStatus === 'approved'
					? currentProof.capturedAt || now
					: undefined,
			approvedAt: nextStatus === 'approved' ? currentProof.approvedAt || now : undefined,
			rejectedAt: nextStatus === 'rejected' ? now : undefined,
		},
	};
}

export function buildConductorTaskResolveAttentionPatch(input: {
	task: ConductorTask;
	currentAttention: ConductorTaskAttentionRequest | null;
	response: string;
	now?: number;
}): Pick<
	ConductorTask,
	| 'description'
	| 'status'
	| 'attentionRequest'
	| 'workerSessionId'
	| 'workerSessionName'
	| 'reviewerSessionId'
	| 'reviewerSessionName'
> {
	const now = input.now ?? Date.now();
	const nextDescription = input.response
		? [input.task.description.trim(), `Operator follow-up:\n${input.response}`]
				.filter(Boolean)
				.join('\n\n')
		: input.task.description;

	return {
		description: nextDescription,
		status: 'ready',
		workerSessionId: undefined,
		workerSessionName: undefined,
		reviewerSessionId: undefined,
		reviewerSessionName: undefined,
		attentionRequest: input.currentAttention
			? {
					...input.currentAttention,
					status: 'resolved',
					response: input.response,
					updatedAt: now,
					resolvedAt: now,
				}
			: null,
	};
}
