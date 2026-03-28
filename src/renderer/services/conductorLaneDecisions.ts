import type {
	ConductorRunEvent,
	ConductorTask,
	ConductorTaskAttentionRequest,
	ConductorTaskCompletionProof,
	ConductorTaskCompletionProofRequirement,
	ConductorTaskEvidenceItem,
} from '../types';
import type { ConductorReviewerResult } from './conductorReviewer';
import type { ConductorWorkerResult } from './conductorWorker';
import {
	buildDefaultConductorTaskCompletionProof,
	canConductorTaskAutoApproveCompletionProof,
	hasConductorTaskApprovedCompletionProof,
	hasConductorTaskConcreteEvidence,
	requiresConductorTaskCompletionProof,
	requiresConductorTaskExplicitEvidence,
} from '../../shared/conductorTasks';
import type { DemoCard } from '../../shared/demo-artifacts';
import { isCompletedDemoCapture } from '../../shared/demo-artifacts';
import { generateId } from '../utils/ids';

export interface ConductorTaskTransitionDecision {
	taskUpdates: Partial<ConductorTask>;
	eventType: ConductorRunEvent['type'];
	eventMessage: string;
	followUpTasks?: ConductorTask[];
	blocksExecution?: boolean;
	completesTask?: boolean;
}

const OPERATOR_BLOCK_REASON_PATTERN =
	/\b(user|operator|approval|approve|confirm|credentials?|token|api key|access|permission|subscription|billing|design preference|preference|which option|what should|do you want|external dependency)\b/i;

export function satisfiesConductorTaskCompletionProofRequirement(
	demoCard: DemoCard,
	requirement: ConductorTaskCompletionProofRequirement
): boolean {
	return (
		isCompletedDemoCapture(demoCard) &&
		(!requirement.requireVideo || Boolean(demoCard.videoArtifact)) &&
		demoCard.stepCount >= Math.max(0, requirement.minScreenshots || 0)
	);
}

export function buildConductorDemoEvidenceItem(demoCard: DemoCard): ConductorTaskEvidenceItem {
	return {
		kind: 'demo',
		label: demoCard.title || 'Captured demo evidence',
		summary: demoCard.summary || demoCard.observedTitle || undefined,
		url: demoCard.observedUrl || demoCard.requestedTarget?.url || undefined,
		demoId: demoCard.demoId,
		captureRunId: demoCard.captureRunId,
	};
}

export function mergeConductorTaskEvidence(
	...sources: Array<ConductorTaskEvidenceItem[] | undefined>
): ConductorTaskEvidenceItem[] {
	const merged: ConductorTaskEvidenceItem[] = [];
	const seen = new Set<string>();
	for (const source of sources) {
		for (const item of source || []) {
			const key = [
				item.kind,
				item.label,
				item.path || '',
				item.url || '',
				item.demoId || '',
				item.captureRunId || '',
			].join('::');
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			merged.push(item);
		}
	}
	return merged;
}

export function shouldRouteWorkerBlockToOperator(blockedReason: string): boolean {
	return OPERATOR_BLOCK_REASON_PATTERN.test(blockedReason);
}

function buildFollowUpTasks(input: {
	groupId: string;
	parentTaskId: string;
	scopePaths: string[];
	followUpTasks: Array<{
		title: string;
		description: string;
		priority: ConductorTask['priority'];
	}>;
	source: ConductorTask['source'];
	createdAt: number;
}): ConductorTask[] {
	return input.followUpTasks.map((followUpTask) => ({
		id: `conductor-task-${generateId()}`,
		groupId: input.groupId,
		parentTaskId: input.parentTaskId,
		title: followUpTask.title,
		description: followUpTask.description,
		acceptanceCriteria: [],
		priority: followUpTask.priority,
		status: 'ready',
		dependsOn: [],
		scopePaths: input.scopePaths,
		changedPaths: [],
		source: input.source,
		attentionRequest: null,
		agentHistory: [],
		createdAt: input.createdAt,
		updatedAt: input.createdAt,
	}));
}

export function buildConductorWorkerBlockedDecision(input: {
	task: ConductorTask;
	result: ConductorWorkerResult;
	combinedEvidence: ConductorTaskEvidenceItem[];
	runId: string;
	workerSessionId?: string;
	clarificationGuidance?: string;
	clarificationSessionId?: string;
	finishedAt: number;
}): ConductorTaskTransitionDecision {
	const blockedReason = input.result.blockedReason || input.result.summary;
	if (
		!shouldRouteWorkerBlockToOperator(blockedReason) &&
		input.clarificationGuidance &&
		input.clarificationGuidance.trim()
	) {
		const attentionRequest: ConductorTaskAttentionRequest = {
			id: `conductor-task-attention-${generateId()}`,
			status: 'open',
			kind: 'clarification',
			summary: 'Conductor answered an agent clarification and queued another pass.',
			requestedAction: `Worker asked: ${blockedReason}\n\nConductor guidance: ${input.clarificationGuidance}`,
			requestedByRole: 'planner',
			requestedBySessionId: input.clarificationSessionId,
			runId: input.runId,
			createdAt: input.finishedAt,
			updatedAt: input.finishedAt,
		};
		return {
			taskUpdates: {
				status: 'needs_revision',
				changedPaths: input.result.changedPaths,
				evidence: input.combinedEvidence,
				attentionRequest,
			},
			eventType: 'task_needs_revision',
			eventMessage: `Conductor answered a worker clarification for ${input.task.title} and queued another pass.`,
		};
	}

	const attentionRequest: ConductorTaskAttentionRequest = {
		id: `conductor-task-attention-${generateId()}`,
		status: 'open',
		kind: 'blocked',
		summary: blockedReason,
		requestedAction: blockedReason,
		requestedByRole: 'worker',
		requestedBySessionId: input.workerSessionId,
		suggestedResponse:
			'Clarify what should happen next, then move the task back to Ready so Conductor can retry it.',
		runId: input.runId,
		createdAt: input.finishedAt,
		updatedAt: input.finishedAt,
	};

	return {
		taskUpdates: {
			status: 'needs_input',
			changedPaths: input.result.changedPaths,
			evidence: input.combinedEvidence,
			attentionRequest,
		},
		eventType: 'task_needs_input',
		eventMessage: `Task needs input: ${input.task.title}. ${blockedReason}`,
		blocksExecution: true,
	};
}

export function buildConductorWorkerCompletedDecision(input: {
	task: ConductorTask;
	groupId: string;
	result: ConductorWorkerResult;
	combinedEvidence: ConductorTaskEvidenceItem[];
	capturedProof?: ConductorTaskCompletionProof;
	runId: string;
	workerSessionId?: string;
	finishedAt: number;
}): ConductorTaskTransitionDecision {
	if (
		requiresConductorTaskExplicitEvidence(input.task) &&
		!hasConductorTaskConcreteEvidence({
			...input.task,
			evidence: input.combinedEvidence,
		})
	) {
		const attentionRequest: ConductorTaskAttentionRequest = {
			id: `conductor-task-attention-${generateId()}`,
			status: 'open',
			kind: 'blocked',
			summary: 'Worker completed without concrete evidence required for this task.',
			requestedAction:
				'This task requires explicit evidence of completion, but the worker did not return any concrete demo, file, or URL evidence.',
			requestedByRole: 'worker',
			requestedBySessionId: input.workerSessionId,
			suggestedResponse:
				'Retry after tightening the worker instructions or inspect the worker session to see why evidence capture failed.',
			runId: input.runId,
			createdAt: input.finishedAt,
			updatedAt: input.finishedAt,
		};
		return {
			taskUpdates: {
				status: 'blocked',
				changedPaths: input.result.changedPaths,
				evidence: input.combinedEvidence,
				attentionRequest,
				completionProof: input.capturedProof,
			},
			eventType: 'task_blocked',
			eventMessage: `Task blocked: ${input.task.title}. Worker finished without concrete evidence required for approval.`,
			blocksExecution: true,
		};
	}

	return {
		taskUpdates: {
			status: 'needs_review',
			changedPaths: input.result.changedPaths,
			evidence: input.combinedEvidence,
			attentionRequest: null,
			completionProof: input.capturedProof,
		},
		eventType: 'task_completed',
		eventMessage:
			input.result.followUpTasks.length > 0
				? `Completed task: ${input.task.title}. Sent to review with ${input.result.followUpTasks.length} follow-up subtask${input.result.followUpTasks.length === 1 ? '' : 's'} suggested.`
				: `Completed task: ${input.task.title}. Sent to review. ${input.result.summary}`,
		followUpTasks: buildFollowUpTasks({
			groupId: input.groupId,
			parentTaskId: input.task.id,
			scopePaths: input.task.scopePaths,
			followUpTasks: input.result.followUpTasks,
			source: 'worker_followup',
			createdAt: input.finishedAt,
		}),
		completesTask: true,
	};
}

export function resolveConductorReviewerDecision(input: {
	task: ConductorTask;
	groupId: string;
	result: ConductorReviewerResult;
	runId: string;
	reviewerSessionId?: string;
	reviewedAt: number;
}): ConductorTaskTransitionDecision {
	if (input.result.decision === 'approved') {
		if (
			requiresConductorTaskExplicitEvidence(input.task) &&
			!hasConductorTaskConcreteEvidence(input.task)
		) {
			const attentionRequest: ConductorTaskAttentionRequest = {
				id: `conductor-task-attention-${generateId()}`,
				status: 'open',
				kind: 'review_changes',
				summary: 'Review could not approve this task because explicit evidence is missing.',
				requestedAction:
					'This task requires explicit evidence of completion, but the worker result did not include concrete demo, file, or URL evidence the reviewer could trust.',
				requestedByRole: 'system',
				requestedBySessionId: input.reviewerSessionId,
				suggestedResponse:
					'Rerun the task with evidence capture enabled or inspect the worker session to understand why concrete evidence was not produced.',
				runId: input.runId,
				createdAt: input.reviewedAt,
				updatedAt: input.reviewedAt,
			};
			return {
				taskUpdates: {
					status: 'blocked',
					attentionRequest,
				},
				eventType: 'review_failed',
				eventMessage: `Review could not approve ${input.task.title} because explicit evidence is missing.`,
			};
		}

		const requiresProof = requiresConductorTaskCompletionProof(input.task);
		const hasApprovedProof = hasConductorTaskApprovedCompletionProof(input.task);
		if (requiresProof && canConductorTaskAutoApproveCompletionProof(input.task) && !hasApprovedProof) {
			const nextProof = input.task.completionProof
				? {
						...input.task.completionProof,
						status: 'approved' as const,
						approvedAt: input.reviewedAt,
						rejectedAt: undefined,
					}
				: undefined;
			return {
				taskUpdates: {
					status: 'done',
					attentionRequest: null,
					completionProof: nextProof,
				},
				eventType: 'review_passed',
				eventMessage: `Review passed for ${input.task.title}. Proof was already captured and is now approved. ${input.result.summary}`,
			};
		}
		if (requiresProof && !hasApprovedProof) {
			const nextProof =
				input.task.completionProof || buildDefaultConductorTaskCompletionProof(input.reviewedAt);
			return {
				taskUpdates: {
					status: 'needs_proof',
					attentionRequest: null,
					completionProof: {
						...nextProof,
						requestedAt: nextProof.requestedAt || input.reviewedAt,
					},
				},
				eventType: 'task_needs_proof',
				eventMessage: `Review passed for ${input.task.title}, but proof of completion is still required before it can move into Done.`,
			};
		}

		return {
			taskUpdates: {
				status: 'done',
				attentionRequest: null,
			},
			eventType: 'review_passed',
			eventMessage: `Review passed for ${input.task.title}. ${input.result.summary}`,
		};
	}

	const followUpTasks = buildFollowUpTasks({
		groupId: input.groupId,
		parentTaskId: input.task.id,
		scopePaths: input.task.scopePaths,
		followUpTasks: input.result.followUpTasks,
		source: 'reviewer_followup',
		createdAt: input.reviewedAt,
	});
	const attentionRequest: ConductorTaskAttentionRequest | null =
		input.result.followUpTasks.length === 0
			? {
					id: `conductor-task-attention-${generateId()}`,
					status: 'open' as const,
					kind: 'review_changes' as const,
					summary: input.result.summary,
					requestedAction: input.result.reviewNotes || input.result.summary,
					requestedByRole: 'reviewer' as const,
					requestedBySessionId: input.reviewerSessionId,
					suggestedResponse:
						'Conductor will send this task back to a worker automatically with the reviewer notes attached.',
					runId: input.runId,
					createdAt: input.reviewedAt,
					updatedAt: input.reviewedAt,
				}
			: null;

	return {
		taskUpdates: {
			status: 'needs_revision',
			attentionRequest,
		},
		eventType: 'task_needs_revision',
		eventMessage:
			input.result.followUpTasks.length > 0
				? `Review sent ${input.task.title} back to revision. ${input.result.followUpTasks.length} follow-up task${input.result.followUpTasks.length === 1 ? '' : 's'} queued for agents.`
				: `Review sent ${input.task.title} back for another pass. ${input.result.summary}`,
		followUpTasks,
	};
}
