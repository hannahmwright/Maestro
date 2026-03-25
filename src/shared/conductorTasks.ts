import type {
	ConductorRun,
	ConductorRunEvent,
	ConductorTask,
	ConductorTaskAttentionRequest,
	ConductorTaskCompletionProof,
	ConductorTaskCompletionProofRequirement,
	ConductorTaskStatus,
} from './types';

export interface ConductorTaskProgress {
	totalSubtasks: number;
	completedSubtasks: number;
	openSubtasks: number;
	completionRatio: number;
}

export interface ConductorTaskAttentionBlocker {
	task: ConductorTask;
	attentionRequest: ConductorTaskAttentionRequest | null;
	followUpTasks: ConductorTask[];
}

export interface ConductorTaskVisibleAttention {
	task: ConductorTask;
	attentionRequest: ConductorTaskAttentionRequest;
	source: 'self' | 'child';
}

export interface ConductorTaskQaFailureState {
	malformedFailureCount: number;
	isQuarantined: boolean;
	lastFailureEvent: ConductorRunEvent | null;
}

export const CONDUCTOR_QA_QUARANTINE_FAILURE_COUNT = 3;
export const CONDUCTOR_COMPLETION_PROOF_ATTENTION_ID_PREFIX = 'completion-proof-attention-';

const DEFAULT_CONDUCTOR_TASK_COMPLETION_PROOF_REQUIREMENT: ConductorTaskCompletionProofRequirement =
	{
		required: true,
		requireVideo: true,
		minScreenshots: 1,
	};

const CONDUCTOR_QA_MALFORMED_RESPONSE_PATTERN =
	/(not valid json|did not return a json object)/i;
const CONDUCTOR_PROVIDER_LIMIT_PATTERN =
	/(you(?:'|’)ve hit your limit|resets?\s+\d|quota|rate limit|out of credits|no credits|subscription.*exhausted)/i;

export function buildDefaultConductorTaskCompletionProofRequirement(): ConductorTaskCompletionProofRequirement {
	return { ...DEFAULT_CONDUCTOR_TASK_COMPLETION_PROOF_REQUIREMENT };
}

export function buildDefaultConductorTaskCompletionProof(
	requestedAt = Date.now()
): ConductorTaskCompletionProof {
	return {
		status: 'missing',
		requestedAt,
	};
}

export function requiresConductorTaskCompletionProof(task: ConductorTask): boolean {
	return !task.parentTaskId && task.completionProofRequirement?.required === true;
}

export function hasConductorTaskApprovedCompletionProof(task: ConductorTask): boolean {
	if (!requiresConductorTaskCompletionProof(task)) {
		return true;
	}

	return task.completionProof?.status === 'approved';
}

export function isConductorCompletionProofAttentionRequestId(
	attentionRequestId?: string | null
): boolean {
	return Boolean(
		attentionRequestId?.startsWith(CONDUCTOR_COMPLETION_PROOF_ATTENTION_ID_PREFIX)
	);
}

function getConductorCompletionProofRequestedAction(task: ConductorTask): string {
	const requirement =
		task.completionProofRequirement || buildDefaultConductorTaskCompletionProofRequirement();
	const screenshotLabel =
		requirement.minScreenshots === 1
			? 'at least 1 screenshot'
			: `at least ${requirement.minScreenshots} screenshots`;
	const requiredArtifacts = `${requirement.requireVideo ? 'a screen recording and ' : ''}${screenshotLabel}`;

	switch (task.completionProof?.status) {
		case 'captured':
			return `Review the proof of completion for ${task.title} and mark it approved before moving the task into Done. Required artifacts: ${requiredArtifacts}.`;
		case 'capturing':
			return `Finish capturing proof of completion for ${task.title}. Required artifacts: ${requiredArtifacts}.`;
		case 'rejected':
			return `Replace the rejected proof of completion for ${task.title}. Required artifacts: ${requiredArtifacts}.`;
		default:
			return `Capture proof of completion for ${task.title} before moving it into Done. Required artifacts: ${requiredArtifacts}.`;
	}
}

function getConductorCompletionProofAttentionRequest(
	task: ConductorTask
): ConductorTaskAttentionRequest | null {
	if (!requiresConductorTaskCompletionProof(task) || hasConductorTaskApprovedCompletionProof(task)) {
		return null;
	}

	if (task.status !== 'needs_proof') {
		return null;
	}

	const requestedAt = task.completionProof?.requestedAt || task.updatedAt;
	return {
		id: `${CONDUCTOR_COMPLETION_PROOF_ATTENTION_ID_PREFIX}${task.id}`,
		status: 'open',
		kind: 'operator_decision',
		summary: 'Completion proof is required before this task can move into Done.',
		requestedAction: getConductorCompletionProofRequestedAction(task),
		requestedByRole: 'system',
		suggestedResponse:
			'Attach or review the proof artifacts, then mark the proof approved so the task can move into Done.',
		createdAt: requestedAt,
		updatedAt: Math.max(task.updatedAt, requestedAt),
	};
}

export function formatConductorOperatorMessage(message?: string | null): string {
	const trimmed = message?.trim();
	if (!trimmed) {
		return '';
	}

	if (
		/(\blet me\b.*\blet me\b)|(\*\*plan summary:?\*\*)|(this is a simple, targeted task)/i.test(
			trimmed
		)
	) {
		return 'A helper produced verbose internal reasoning instead of a clean manager-facing update.';
	}

	if (/waiting for plan approval to proceed/i.test(trimmed)) {
		return 'QA helper paused before running the requested verification steps.';
	}

	if (
		/plan mode/i.test(trimmed) &&
		/(?:cannot|can't)\s+run/i.test(trimmed) &&
		/(npx\s+tsc|tsc\s+--noEmit|npm\s+run\s+build)/i.test(trimmed)
	) {
		return 'QA helper could not run the TypeScript/build verification commands.';
	}

	if (/submit_conductor_(?:plan|work|review)|structured result|result tool/i.test(trimmed)) {
		return 'A helper could not submit its structured Conductor result.';
	}

	if (/planner did not return a json object/i.test(trimmed)) {
		return 'Planner run failed to submit a structured result.';
	}

	if (
		/reviewer did not return a json object/i.test(trimmed) ||
		/review output .* not valid json/i.test(trimmed)
	) {
		return 'QA helper failed to submit a structured review result.';
	}

	if (CONDUCTOR_PROVIDER_LIMIT_PATTERN.test(trimmed)) {
		return 'Conductor paused because the current provider hit its usage limit.';
	}

	return trimmed;
}

function isReviewOwnedAttention(
	attentionRequest: ConductorTaskAttentionRequest | null,
	followUpTasks: ConductorTask[]
): boolean {
	if (followUpTasks.length > 0) {
		return true;
	}

	return Boolean(
		attentionRequest?.status === 'open' &&
			(attentionRequest.requestedByRole === 'reviewer' ||
				attentionRequest.kind === 'review_changes')
	);
}

function isLegacyReviewRequestedChangeEvent(
	task: ConductorTask,
	runs: ConductorRun[]
): boolean {
	return runs
		.filter((run) => run.taskIds.includes(task.id))
		.some((run) =>
			run.events.some(
				(event) =>
					event.type === 'task_needs_input' &&
					eventRelatesToConductorTask(run, event, task) &&
					/^review requested changes/i.test(event.message)
			)
		);
}

export function isConductorTaskOperatorActionRequired(
	task: ConductorTask,
	childTasksByParentId: Map<string, ConductorTask[]>,
	runs: ConductorRun[]
): boolean {
	const attentionRequest = getEffectiveConductorTaskAttentionRequest(task, runs);
	if (attentionRequest?.status !== 'open') {
		return false;
	}

	return !isReviewOwnedAttention(
		attentionRequest,
		getConductorTaskOpenFollowUps(task, childTasksByParentId)
	);
}

export function isConductorTaskAgentRevision(
	task: ConductorTask,
	childTasksByParentId: Map<string, ConductorTask[]>,
	runs: ConductorRun[]
): boolean {
	if (task.status === 'needs_revision') {
		return true;
	}

	return isReviewOwnedAttention(
		getEffectiveConductorTaskAttentionRequest(task, runs),
		getConductorTaskOpenFollowUps(task, childTasksByParentId)
	);
}

export function isConductorTaskRunnableByAgent(
	task: ConductorTask,
	childTasksByParentId: Map<string, ConductorTask[]>,
	runs: ConductorRun[]
): boolean {
	if (
		task.status === 'planning' ||
		task.status === 'running' ||
		task.status === 'needs_review' ||
		task.status === 'needs_proof' ||
		task.status === 'blocked' ||
		isConductorTaskTerminalStatus(task.status)
	) {
		return false;
	}

	const childTasks = (childTasksByParentId.get(task.id) || []).filter(
		(childTask) => !isConductorTaskDormantFollowUp(childTask)
	);
	if (childTasks.some((childTask) => !isConductorTaskTerminalStatus(childTask.status))) {
		return false;
	}

	if (task.status === 'ready' || task.status === 'needs_revision') {
		return true;
	}

	const attentionRequest = getEffectiveConductorTaskAttentionRequest(task, runs);
	const followUpTasks = getConductorTaskOpenFollowUps(task, childTasksByParentId);
	return isReviewOwnedAttention(attentionRequest, followUpTasks);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildLegacyAttentionDetails(
	task: ConductorTask,
	event: ConductorRunEvent
): Pick<
	ConductorTaskAttentionRequest,
	'kind' | 'summary' | 'requestedAction' | 'requestedByRole' | 'suggestedResponse'
> {
	const taskTitlePattern = escapeRegExp(task.title.trim());
	const cleanedMessage = event.message
		.replace(new RegExp(`^Task needs input:\\s*${taskTitlePattern}\\.\\s*`, 'i'), '')
		.replace(new RegExp(`^Review requested changes for\\s*${taskTitlePattern}\\.\\s*`, 'i'), '')
		.trim();
	const requestedAction = cleanedMessage || event.message;
	const requestedByRole = /^review requested changes/i.test(event.message) ? 'reviewer' : 'worker';
	const kind = requestedByRole === 'reviewer' ? 'review_changes' : 'blocked';

	return {
		kind,
		summary: requestedAction,
		requestedAction,
		requestedByRole,
		suggestedResponse:
			requestedByRole === 'reviewer'
				? 'Summarize the requested fixes or missing behavior, then move the task back to Ready once the next pass is clear.'
				: 'Add the clarification or decision the worker needs, then move the task back to Ready so it can continue.',
	};
}

export function eventRelatesToConductorTask(
	run: ConductorRun,
	event: ConductorRunEvent,
	task: ConductorTask
): boolean {
	if (!run.taskIds.includes(task.id)) {
		return false;
	}

	if (run.taskIds.length === 1) {
		return true;
	}

	return event.message.toLowerCase().includes(task.title.trim().toLowerCase());
}

export function getConductorTaskQaFailureState(
	task: ConductorTask,
	runs: ConductorRun[]
): ConductorTaskQaFailureState {
	let malformedFailureCount = 0;
	let lastFailureEvent: ConductorRunEvent | null = null;
	const qaCycleStartedAt =
		[...runs]
			.filter((run) => run.taskIds.includes(task.id))
			.flatMap((run) =>
				run.events.filter(
					(event) =>
						event.type === 'task_completed' && eventRelatesToConductorTask(run, event, task)
				)
			)
			.sort((left, right) => right.createdAt - left.createdAt)[0]?.createdAt || task.createdAt;

	const relatedReviewRuns = [...runs]
		.filter((run) => run.kind === 'review' && run.taskIds.includes(task.id))
		.sort(
			(left, right) =>
				(right.endedAt || right.startedAt || 0) - (left.endedAt || left.startedAt || 0)
		);

	for (const run of relatedReviewRuns) {
		const relatedEvents = [...run.events]
			.filter(
				(event) =>
					event.createdAt >= qaCycleStartedAt && eventRelatesToConductorTask(run, event, task)
			)
			.sort((left, right) => right.createdAt - left.createdAt);

		if (relatedEvents.length === 0) {
			continue;
		}

		const successEvent = relatedEvents.find(
			(event) =>
				event.type === 'review_passed' ||
				event.type === 'task_needs_proof' ||
				event.type === 'task_needs_revision' ||
				event.type === 'task_cancelled'
		);
		if (successEvent) {
			break;
		}

		const malformedFailureEvent = relatedEvents.find(
			(event) =>
				event.type === 'review_failed' &&
				CONDUCTOR_QA_MALFORMED_RESPONSE_PATTERN.test(event.message)
		);
		if (malformedFailureEvent) {
			malformedFailureCount += 1;
			lastFailureEvent ||= malformedFailureEvent;
			continue;
		}

		const explicitFailureEvent = relatedEvents.find((event) => event.type === 'review_failed');
		if (explicitFailureEvent) {
			lastFailureEvent ||= explicitFailureEvent;
		}

		break;
	}

	return {
		malformedFailureCount,
		isQuarantined:
			task.status === 'needs_review' &&
			malformedFailureCount >= CONDUCTOR_QA_QUARANTINE_FAILURE_COUNT,
		lastFailureEvent,
	};
}

export function getEffectiveConductorTaskAttentionRequest(
	task: ConductorTask,
	runs: ConductorRun[]
): ConductorTaskAttentionRequest | null {
	const completionProofAttention = getConductorCompletionProofAttentionRequest(task);
	if (completionProofAttention) {
		return completionProofAttention;
	}

	if (task.attentionRequest) {
		return task.attentionRequest;
	}

	if (task.status !== 'needs_input' && task.status !== 'blocked') {
		return null;
	}

	const relatedRuns = runs.filter((run) => run.taskIds.includes(task.id));
	const latestEventMatch = relatedRuns
		.flatMap((run) =>
			run.events
				.filter(
					(event) =>
						(event.type === 'task_needs_input' || event.type === 'task_blocked') &&
						eventRelatesToConductorTask(run, event, task)
				)
				.map((event) => ({ run, event }))
		)
		.sort((left, right) => right.event.createdAt - left.event.createdAt)[0];

	if (!latestEventMatch) {
		const latestRelatedEvent = relatedRuns
			.flatMap((run) =>
				run.events
					.filter((event) => eventRelatesToConductorTask(run, event, task))
					.map((event) => ({ run, event }))
			)
			.sort((left, right) => right.event.createdAt - left.event.createdAt)[0];
		const latestRelatedRun = [...relatedRuns].sort(
			(left, right) =>
				(right.endedAt || right.startedAt || 0) - (left.endedAt || left.startedAt || 0)
		)[0];
		const fallbackSummary =
			latestRelatedEvent?.event.message ||
			latestRelatedRun?.summary ||
			(task.status === 'blocked'
				? 'This task is blocked, but the original blocking note was not captured in a structured form.'
				: 'This task is waiting for input, but the original request was not captured in a structured form.');

		return {
			id: `legacy-attention-${task.id}-fallback`,
			status: 'open',
			kind: task.status === 'blocked' ? 'blocked' : 'clarification',
			summary:
				task.status === 'blocked'
					? 'Recovered blocker context from legacy run history.'
					: 'Recovered input request from legacy run history.',
			requestedAction: fallbackSummary,
			requestedByRole: 'system',
			suggestedResponse:
				'Open the latest agent thread if needed, add the missing clarification here, then move the task back to Ready.',
			runId: latestRelatedRun?.id,
			createdAt:
				latestRelatedEvent?.event.createdAt ||
				latestRelatedRun?.endedAt ||
				latestRelatedRun?.startedAt ||
				task.updatedAt,
			updatedAt:
				latestRelatedEvent?.event.createdAt ||
				latestRelatedRun?.endedAt ||
				latestRelatedRun?.startedAt ||
				task.updatedAt,
		};
	}

	const details = buildLegacyAttentionDetails(task, latestEventMatch.event);
	const requestedBySessionId =
		details.requestedByRole === 'reviewer'
			? latestEventMatch.run.taskReviewerSessionIds?.[task.id]
			: latestEventMatch.run.taskWorkerSessionIds?.[task.id];

	return {
		id: `legacy-attention-${task.id}-${latestEventMatch.event.id}`,
		status: 'open',
		kind: details.kind,
		summary: details.summary,
		requestedAction: details.requestedAction,
		requestedByRole: details.requestedByRole,
		requestedBySessionId,
		suggestedResponse: details.suggestedResponse,
		runId: latestEventMatch.run.id,
		createdAt: latestEventMatch.event.createdAt,
		updatedAt: latestEventMatch.event.createdAt,
	};
}

export function hasConductorTaskAttentionEvent(
	task: ConductorTask,
	runs: ConductorRun[]
): boolean {
	return runs
		.filter((run) => run.taskIds.includes(task.id))
		.some((run) =>
			run.events.some(
				(event) =>
					(event.type === 'task_needs_input' || event.type === 'task_blocked') &&
					eventRelatesToConductorTask(run, event, task)
			)
		);
}

export function isConductorTaskTerminalStatus(status: ConductorTaskStatus): boolean {
	return status === 'done' || status === 'cancelled';
}

export function isConductorTaskDormantFollowUp(task: ConductorTask): boolean {
	return (
		task.status === 'draft' &&
		(task.source === 'worker_followup' || task.source === 'reviewer_followup')
	);
}

export function getConductorTaskOpenFollowUps(
	task: ConductorTask,
	childTasksByParentId: Map<string, ConductorTask[]>
): ConductorTask[] {
	const childTasks = (childTasksByParentId.get(task.id) || []).filter(
		(childTask) => !isConductorTaskDormantFollowUp(childTask)
	);
	const reviewerFollowUps = childTasks.filter(
		(childTask) =>
			childTask.source === 'reviewer_followup' && !isConductorTaskTerminalStatus(childTask.status)
	);
	if (reviewerFollowUps.length > 0) {
		return reviewerFollowUps;
	}

	return childTasks.filter(
		(childTask) =>
			childTask.source !== 'planner' && !isConductorTaskTerminalStatus(childTask.status)
	);
}

export function getConductorTaskAttentionBlockers(
	task: ConductorTask,
	childTasksByParentId: Map<string, ConductorTask[]>,
	runs: ConductorRun[]
): ConductorTaskAttentionBlocker[] {
	const childTasks = (childTasksByParentId.get(task.id) || []).filter(
		(childTask) => !isConductorTaskDormantFollowUp(childTask)
	);
	return childTasks
		.map((childTask) => {
			const attentionRequest = getEffectiveConductorTaskAttentionRequest(childTask, runs);
			const followUpTasks = getConductorTaskOpenFollowUps(childTask, childTasksByParentId);
			return {
				task: childTask,
				attentionRequest,
				followUpTasks,
			};
		})
		.filter(
			({ task: childTask, attentionRequest, followUpTasks }) =>
				attentionRequest?.status === 'open' ||
				childTask.status === 'needs_revision' ||
				childTask.status === 'needs_input' ||
				childTask.status === 'needs_proof' ||
				childTask.status === 'blocked' ||
				getConductorTaskQaFailureState(childTask, runs).isQuarantined ||
				followUpTasks.length > 0
		);
}

export function getConductorTaskVisibleAttention(
	task: ConductorTask,
	childTasksByParentId: Map<string, ConductorTask[]>,
	runs: ConductorRun[]
): ConductorTaskVisibleAttention | null {
	const ownAttention = getEffectiveConductorTaskAttentionRequest(task, runs);
	if (ownAttention?.status === 'open') {
		return {
			task,
			attentionRequest: ownAttention,
			source: 'self',
		};
	}

	const blockers = getConductorTaskAttentionBlockers(task, childTasksByParentId, runs);
	const operatorBlocker = blockers.find(
		({ task: blockerTask, attentionRequest }) =>
			attentionRequest?.status === 'open' &&
			isConductorTaskOperatorActionRequired(blockerTask, childTasksByParentId, runs)
	);
	if (operatorBlocker?.attentionRequest) {
		return {
			task: operatorBlocker.task,
			attentionRequest: operatorBlocker.attentionRequest,
			source: 'child',
		};
	}

	const openBlocker = blockers.find(({ attentionRequest }) => attentionRequest?.status === 'open');
	if (openBlocker?.attentionRequest) {
		return {
			task: openBlocker.task,
			attentionRequest: openBlocker.attentionRequest,
			source: 'child',
		};
	}

	return null;
}

export function buildConductorChildTaskMap(tasks: ConductorTask[]): Map<string, ConductorTask[]> {
	const map = new Map<string, ConductorTask[]>();
	for (const task of tasks) {
		if (!task.parentTaskId) {
			continue;
		}
		const existing = map.get(task.parentTaskId);
		if (existing) {
			existing.push(task);
			continue;
		}
		map.set(task.parentTaskId, [task]);
	}
	return map;
}

export function getTopLevelConductorTasks(tasks: ConductorTask[]): ConductorTask[] {
	return tasks.filter((task) => !task.parentTaskId);
}

export function getConductorTaskProgress(
	task: ConductorTask,
	childTasksByParentId: Map<string, ConductorTask[]>
): ConductorTaskProgress {
	const childTasks = (childTasksByParentId.get(task.id) || []).filter(
		(childTask) => !isConductorTaskDormantFollowUp(childTask)
	);
	const completedSubtasks = childTasks.filter((childTask) =>
		isConductorTaskTerminalStatus(childTask.status)
	).length;
	const totalSubtasks = childTasks.length;
	const openSubtasks = Math.max(0, totalSubtasks - completedSubtasks);

	return {
		totalSubtasks,
		completedSubtasks,
		openSubtasks,
		completionRatio: totalSubtasks > 0 ? completedSubtasks / totalSubtasks : 0,
	};
}

export function repairLegacyConductorTasks(
	tasks: ConductorTask[],
	runs: ConductorRun[]
): ConductorTask[] {
	const childTasksByParentId = buildConductorChildTaskMap(tasks);
	let changed = false;

	const repairedTasks = tasks.map((task) => {
		if (task.status !== 'needs_input' || task.attentionRequest || task.source === 'manual') {
			return task;
		}

		const childTasks = (childTasksByParentId.get(task.id) || []).filter(
			(childTask) => !isConductorTaskDormantFollowUp(childTask)
		);
		const hasAttentionEvent = hasConductorTaskAttentionEvent(task, runs);
		const hasReviewRequestedChangeEvent = isLegacyReviewRequestedChangeEvent(task, runs);
		const isAgentOwnedLegacyState =
			Boolean(task.parentTaskId) ||
			task.source === 'worker_followup' ||
			task.source === 'reviewer_followup' ||
			childTasks.some(
				(childTask) =>
					childTask.source === 'worker_followup' ||
					childTask.source === 'reviewer_followup' ||
					childTask.status === 'needs_revision' ||
					childTask.status === 'needs_review'
			);

		if (
			task.source === 'planner' &&
			!task.parentTaskId &&
			childTasks.length === 0 &&
			!hasAttentionEvent
		) {
			changed = true;
			return {
				...task,
				status: 'ready' as ConductorTaskStatus,
			};
		}

		if (hasAttentionEvent && !hasReviewRequestedChangeEvent) {
			return task;
		}

		if (!isAgentOwnedLegacyState) {
			return task;
		}

		changed = true;
		return {
			...task,
			status: 'needs_revision' as ConductorTaskStatus,
		};
	});

	return changed ? repairedTasks : tasks;
}

export function getConductorTaskRollupStatus(
	task: ConductorTask,
	childTasksByParentId: Map<string, ConductorTask[]>,
	runs: ConductorRun[] = []
): ConductorTaskStatus {
	const childTasks = (childTasksByParentId.get(task.id) || []).filter(
		(childTask) => !isConductorTaskDormantFollowUp(childTask)
	);
	const taskNeedsOperatorAttention = isConductorTaskOperatorActionRequired(
		task,
		childTasksByParentId,
		runs
	);
	const taskNeedsRevision = isConductorTaskAgentRevision(task, childTasksByParentId, runs);
	if (childTasks.length === 0) {
		if (getConductorTaskQaFailureState(task, runs).isQuarantined) {
			return 'blocked';
		}
		if (task.status === 'needs_proof') {
			return 'needs_proof';
		}
		if (taskNeedsOperatorAttention) {
			return 'needs_input';
		}
		if (taskNeedsRevision) {
			return 'needs_revision';
		}
		return task.status;
	}

	const openChildren = childTasks.filter((childTask) => !isConductorTaskTerminalStatus(childTask.status));
	if (openChildren.length === 0) {
		return task.status === 'cancelled' ? 'cancelled' : 'done';
	}

	if (task.status === 'needs_proof') {
		return 'needs_proof';
	}
	if (taskNeedsOperatorAttention || task.status === 'needs_input') {
		return 'needs_input';
	}
	if (taskNeedsRevision) {
		return 'needs_revision';
	}
	if (task.status === 'blocked') {
		return 'blocked';
	}
	if (task.status === 'needs_review') {
		return 'needs_review';
	}

	if (
		openChildren.some(
			(childTask) =>
				getConductorTaskRollupStatus(childTask, childTasksByParentId, runs) === 'needs_proof'
		)
	) {
		return 'needs_proof';
	}
	if (
		openChildren.some(
			(childTask) =>
				getConductorTaskRollupStatus(childTask, childTasksByParentId, runs) === 'needs_input'
		)
	) {
		return 'needs_input';
	}
	if (openChildren.some((childTask) => childTask.status === 'blocked')) {
		return 'blocked';
	}
	if (
		openChildren.some(
			(childTask) =>
				getConductorTaskRollupStatus(childTask, childTasksByParentId, runs) === 'needs_revision'
		)
	) {
		return 'needs_revision';
	}
	if (
		openChildren.some(
			(childTask) =>
				getConductorTaskRollupStatus(childTask, childTasksByParentId, runs) === 'needs_review'
		)
	) {
		return 'needs_review';
	}
	if (
		openChildren.some(
			(childTask) =>
				getConductorTaskRollupStatus(childTask, childTasksByParentId, runs) === 'running'
		)
	) {
		return 'running';
	}
	if (
		openChildren.some(
			(childTask) =>
				getConductorTaskRollupStatus(childTask, childTasksByParentId, runs) === 'planning'
		)
	) {
		return 'planning';
	}
	if (
		openChildren.some(
			(childTask) =>
				getConductorTaskRollupStatus(childTask, childTasksByParentId, runs) === 'ready'
		)
	) {
		return 'ready';
	}
	if (
		openChildren.some(
			(childTask) =>
				getConductorTaskRollupStatus(childTask, childTasksByParentId, runs) === 'draft'
		)
	) {
		return 'draft';
	}

	return task.status;
}
