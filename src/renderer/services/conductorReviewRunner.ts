import type { ConductorRun, ConductorTask, Session } from '../types';
import type { ConductorRunJournal } from './conductorRunJournal';
import type { ConductorTaskMirror } from './conductorTaskMirror';
import {
	CONDUCTOR_REVIEWER_JSON_ERROR,
	buildConductorReviewerPrompt,
	parseConductorReviewerResponse,
	parseConductorReviewerSubmission,
	type ConductorReviewerResult,
} from './conductorReviewer';
import {
	runConductorAgentTurn,
	type ConductorAgentRunOptions,
	type ConductorAgentRunResult,
} from './conductorAgentRuntime';
import { applyConductorTaskUpdates } from '../../shared/conductorTasks';
import { resolveConductorReviewerDecision } from './conductorLaneDecisions';

export interface ConductorReviewRunnerInput {
	groupId: string;
	groupName: string;
	runId: string;
	selectedTemplate: Session;
	reviewReadyTasks: ConductorTask[];
	taskMirror: ConductorTaskMirror;
	runJournal: ConductorRunJournal;
	isPaused: () => boolean;
	isCancelled: (taskId: string) => boolean;
	clearCancelled: (taskId: string) => void;
	recordTaskAgentHistory: (
		taskId: string,
		role: 'reviewer',
		sessionId: string,
		sessionName: string | undefined,
		runId: string
	) => void;
	getLatestExecutionForTask: (taskId: string) => ConductorRun | null | undefined;
	runAgentTurn?: (
		options: ConductorAgentRunOptions
	) => Promise<ConductorAgentRunResult>;
}

export interface ConductorReviewRunnerResult {
	changesRequested: number;
	malformedResponses: number;
	pausedByUser: boolean;
	reviewAgentSessionIds: string[];
	taskReviewerSessionIds: Record<string, string>;
}

export async function runConductorReviewLane(
	input: ConductorReviewRunnerInput
): Promise<ConductorReviewRunnerResult> {
	const runAgentTurn = input.runAgentTurn || runConductorAgentTurn;
	let changesRequested = 0;
	let malformedResponses = 0;
	let pausedByUser = false;
	let reviewAgentSessionIds: string[] = [];
	const taskReviewerSessionIds: Record<string, string> = {};

	const runReviewerAttempt = async (
		task: ConductorTask,
		prompt: string,
		reviewCwd: string,
		branch?: string | null
	) => {
		return runAgentTurn({
			parentSession: input.selectedTemplate,
			role: 'reviewer',
			taskTitle: task.title,
			taskDescription: task.description,
			scopePaths: task.scopePaths,
			prompt,
			cwd: reviewCwd,
			branch,
			runId: input.runId,
			taskId: task.id,
			readOnlyMode: true,
			expectedSubmissionKind: 'reviewer',
			onSessionReady: (session) => {
				taskReviewerSessionIds[task.id] = session.id;
				reviewAgentSessionIds = Array.from(new Set([...reviewAgentSessionIds, session.id]));
				input.recordTaskAgentHistory(task.id, 'reviewer', session.id, session.name, input.runId);
				input.taskMirror.patch(
					task.id,
					{
						reviewerSessionId: session.id,
						reviewerSessionName: session.name,
					},
					task
				);
				input.runJournal.sync({
					taskReviewerSessionIds: { ...taskReviewerSessionIds },
					agentSessionIds: [...reviewAgentSessionIds],
				});
			},
		});
	};

	for (const task of input.reviewReadyTasks) {
		if (input.isPaused()) {
			pausedByUser = true;
			break;
		}
		const latestTaskExecution = input.getLatestExecutionForTask(task.id);
		const reviewCwd =
			latestTaskExecution?.taskWorktreePaths?.[task.id] ||
			latestTaskExecution?.worktreePath ||
			input.selectedTemplate.cwd;
		const prompt = buildConductorReviewerPrompt(
			input.groupName,
			{ ...input.selectedTemplate, cwd: reviewCwd },
			task
		);

		try {
			const reviewBranch = latestTaskExecution?.taskBranches?.[task.id];
			let reviewAttempt = await runReviewerAttempt(task, prompt, reviewCwd, reviewBranch);
			let result: ConductorReviewerResult;
			try {
				result =
					reviewAttempt.structuredSubmission?.kind === 'reviewer'
						? parseConductorReviewerSubmission(reviewAttempt.structuredSubmission.payload)
						: parseConductorReviewerResponse(reviewAttempt.response);
			} catch (error) {
				const shouldRetry =
					error instanceof Error && error.message === CONDUCTOR_REVIEWER_JSON_ERROR;
				if (!shouldRetry) {
					throw error;
				}

				const retryPrompt = `${prompt}

IMPORTANT:
- Return exactly one JSON object and nothing else.
- Do not include markdown code fences.
- Do not include commentary before or after the JSON.
- The first character of your response must be { and the last character must be }.`;
				reviewAttempt = await runReviewerAttempt(task, retryPrompt, reviewCwd, reviewBranch);
				result =
					reviewAttempt.structuredSubmission?.kind === 'reviewer'
						? parseConductorReviewerSubmission(reviewAttempt.structuredSubmission.payload)
						: parseConductorReviewerResponse(reviewAttempt.response);
			}
			const reviewedAt = Date.now();
			if (result.decision !== 'approved') {
				changesRequested += 1;
			}
			const reviewDecision = resolveConductorReviewerDecision({
				task,
				groupId: input.groupId,
				result,
				runId: input.runId,
				reviewerSessionId: taskReviewerSessionIds[task.id],
				reviewedAt,
			});
			input.taskMirror.patch(task.id, reviewDecision.taskUpdates, task);
			if (reviewDecision.followUpTasks && reviewDecision.followUpTasks.length > 0) {
				input.taskMirror.append(reviewDecision.followUpTasks);
			}
			input.runJournal.appendEvent(
				reviewDecision.eventType,
				reviewDecision.eventMessage,
				reviewedAt
			);
		} catch (error) {
			if (input.isCancelled(task.id)) {
				const cancelledAt = Date.now();
				input.taskMirror.commit(
					applyConductorTaskUpdates(task, { status: 'cancelled' }, cancelledAt)
				);
				input.runJournal.appendEvent(
					'task_cancelled',
					`Stopped review for ${task.title}.`,
					cancelledAt
				);
				continue;
			}
			const message = error instanceof Error ? error.message : 'Review failed.';
			if (message === CONDUCTOR_REVIEWER_JSON_ERROR) {
				malformedResponses += 1;
				input.runJournal.appendEvent(
					'review_failed',
					`Review output for ${task.title} was not valid JSON after retry. Task remains in QA.`
				);
				continue;
			}
			throw error;
		} finally {
			input.clearCancelled(task.id);
		}
	}

	return {
		changesRequested,
		malformedResponses,
		pausedByUser,
		reviewAgentSessionIds,
		taskReviewerSessionIds,
	};
}
