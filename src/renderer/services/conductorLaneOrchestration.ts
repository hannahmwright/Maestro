import type {
	ConductorRun,
	ConductorStatus,
	ConductorTask,
	ConductorTaskPriority,
} from '../types';
import {
	getConductorTaskQaFailureState,
	getConductorTaskRollupStatus,
	isConductorTaskOperatorActionRequired,
	isConductorTaskRunnableByAgent,
} from '../../shared/conductorTasks';

const PRIORITY_RANK = new Map<ConductorTaskPriority, number>([
	['critical', 0],
	['high', 1],
	['medium', 2],
	['low', 3],
]);

function compareConductorTaskPriority(
	left: { priority: ConductorTaskPriority; createdAt: number },
	right: { priority: ConductorTaskPriority; createdAt: number }
): number {
	const priorityDiff =
		(PRIORITY_RANK.get(left.priority) ?? 99) - (PRIORITY_RANK.get(right.priority) ?? 99);
	if (priorityDiff !== 0) {
		return priorityDiff;
	}
	return left.createdAt - right.createdAt;
}

export function getDependencyReadyConductorTasks(input: {
	tasks: ConductorTask[];
	childTasksByParentId: Map<string, ConductorTask[]>;
	runs: ConductorRun[];
	completedTaskIds: Set<string>;
	stateOptions: { allowLegacyFallback?: boolean };
}): ConductorTask[] {
	return [...input.tasks]
		.filter(
			(task) =>
				task.source !== 'manual' &&
				isConductorTaskRunnableByAgent(
					task,
					input.childTasksByParentId,
					input.runs,
					input.stateOptions
				) &&
				task.dependsOn.every((dependencyId) => input.completedTaskIds.has(dependencyId))
		)
		.sort(compareConductorTaskPriority);
}

export interface ConductorExecutionLaneResolution {
	finalBlocked: boolean;
	runStatus: ConductorStatus;
	runSummary: string;
	eventType: 'execution_completed' | 'execution_failed';
	eventMessage: string;
	conductorStatus: ConductorStatus;
	holdReason: string | null;
	errorMessage: string | null;
}

export function resolveConductorExecutionLane(input: {
	tasks: ConductorTask[];
	childTasksByParentId: Map<string, ConductorTask[]>;
	runs: ConductorRun[];
	blockedTaskIds: Set<string>;
	blockedMessage: string | null;
	pausedByUser: boolean;
	userPausedMessage: string;
	stateOptions: { allowLegacyFallback?: boolean };
}): ConductorExecutionLaneResolution {
	const finalBlocked = Boolean(input.blockedMessage) || input.blockedTaskIds.size > 0;
	const runSummary =
		input.blockedMessage ||
		(finalBlocked
			? 'Execution completed with blocked tasks.'
			: 'Execution lane completed all runnable tasks.');
	const needsOperatorAttention = input.tasks.some((task) =>
		isConductorTaskOperatorActionRequired(
			task,
			input.childTasksByParentId,
			input.runs,
			input.stateOptions
		)
	);

	return {
		finalBlocked,
		runStatus: input.pausedByUser ? 'cancelled' : finalBlocked ? 'blocked' : 'completed',
		runSummary,
		eventType: finalBlocked && !input.pausedByUser ? 'execution_failed' : 'execution_completed',
		eventMessage: runSummary,
		conductorStatus: input.pausedByUser
			? 'idle'
			: needsOperatorAttention
				? 'attention_required'
				: finalBlocked
					? 'blocked'
					: 'idle',
		holdReason: input.pausedByUser
			? input.userPausedMessage
			: finalBlocked
				? input.blockedMessage
				: null,
		errorMessage:
			finalBlocked && !input.pausedByUser
				? input.blockedMessage ||
					'One or more tasks blocked during execution. Check the event feed for details.'
				: null,
	};
}

export interface ConductorReviewLaneResolution {
	remainingMalformedResponses: number;
	quarantinedMalformedTaskIds: string[];
	dependencyReadyTasks: ConductorTask[];
	runStatus: ConductorStatus;
	runSummary: string;
	conductorStatus: ConductorStatus;
	holdReason: string | null;
	reviewError: string | null;
}

export function resolveConductorReviewLane(input: {
	reviewReadyTasks: ConductorTask[];
	postReviewTasks: ConductorTask[];
	postReviewChildTaskMap: Map<string, ConductorTask[]>;
	runs: ConductorRun[];
	malformedResponses: number;
	changesRequested: number;
	pausedByUser: boolean;
	userPausedMessage: string;
	stateOptions: { allowLegacyFallback?: boolean };
}): ConductorReviewLaneResolution {
	const quarantinedMalformedTaskIds = input.reviewReadyTasks
		.filter(
			(task) =>
				getConductorTaskQaFailureState(task, input.runs).isQuarantined
		)
		.map((task) => task.id);
	const remainingMalformedResponses = Math.max(
		0,
		input.malformedResponses - quarantinedMalformedTaskIds.length
	);
	const completedTaskIds = new Set(
		input.postReviewTasks
			.filter(
				(task) =>
					getConductorTaskRollupStatus(
						task,
						input.postReviewChildTaskMap,
						input.runs,
						input.stateOptions
					) === 'done'
			)
			.map((task) => task.id)
	);
	const dependencyReadyTasks = getDependencyReadyConductorTasks({
		tasks: input.postReviewTasks,
		childTasksByParentId: input.postReviewChildTaskMap,
		runs: input.runs,
		completedTaskIds,
		stateOptions: input.stateOptions,
	});
	const runSummary = input.pausedByUser
		? input.userPausedMessage
		: remainingMalformedResponses > 0
			? `Review finished with ${remainingMalformedResponses} malformed response${remainingMalformedResponses === 1 ? '' : 's'} left in QA${quarantinedMalformedTaskIds.length > 0 ? ` after quarantining ${quarantinedMalformedTaskIds.length} task${quarantinedMalformedTaskIds.length === 1 ? '' : 's'}` : ''}${input.changesRequested > 0 ? ` and ${input.changesRequested} task${input.changesRequested === 1 ? '' : 's'} sent to revision` : ''}.`
			: quarantinedMalformedTaskIds.length > 0
				? `Review paused QA for ${quarantinedMalformedTaskIds.length} task${quarantinedMalformedTaskIds.length === 1 ? '' : 's'} after repeated malformed reviewer replies${input.changesRequested > 0 ? ` and sent ${input.changesRequested} task${input.changesRequested === 1 ? '' : 's'} to revision` : ''}.`
				: input.changesRequested > 0
					? `Review finished with ${input.changesRequested} task${input.changesRequested === 1 ? '' : 's'} sent to revision.`
					: 'Review lane approved all queued tasks.';

	return {
		remainingMalformedResponses,
		quarantinedMalformedTaskIds,
		dependencyReadyTasks,
		runStatus: input.pausedByUser
			? 'cancelled'
			: remainingMalformedResponses > 0
				? 'attention_required'
				: 'completed',
		runSummary,
		conductorStatus: input.pausedByUser
			? 'idle'
			: remainingMalformedResponses > 0
				? 'attention_required'
				: 'idle',
		holdReason: input.pausedByUser ? input.userPausedMessage : null,
		reviewError: input.pausedByUser
			? null
			: remainingMalformedResponses > 0
				? runSummary
				: null,
	};
}

export function canRecoverStaleConductorReviewRun(input: {
	run: ConductorRun;
	tasksById: Map<string, ConductorTask>;
	sessionById: Map<string, { state?: string } | null | undefined>;
	now: number;
	staleAfterMs: number;
}): boolean {
	if (input.run.kind !== 'review') {
		return false;
	}

	return input.run.taskIds.every((taskId) => {
		const task = input.tasksById.get(taskId);
		if (!task || task.status !== 'needs_review') {
			return true;
		}

		const reviewerSessionId = task.reviewerSessionId || input.run.taskReviewerSessionIds?.[taskId];
		if (reviewerSessionId && input.sessionById.get(reviewerSessionId)?.state === 'busy') {
			return false;
		}

		const updatedAt = task.updatedAt || task.createdAt || input.now;
		return Math.max(0, input.now - updatedAt) >= input.staleAfterMs;
	});
}
