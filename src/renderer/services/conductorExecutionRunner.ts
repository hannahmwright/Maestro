import type {
	ConductorRun,
	ConductorTask,
	ConductorTaskAttentionRequest,
	Session,
} from '../types';
import type { ConductorRunJournal } from './conductorRunJournal';
import type { ConductorTaskMirror } from './conductorTaskMirror';
import { applyConductorTaskUpdates, getEffectiveConductorTaskAttentionRequest } from '../../shared/conductorTasks';
import { buildConductorWorktreeTarget, tasksConflict } from './conductorRuntime';
import {
	buildConductorWorkerPrompt,
	parseConductorWorkerResponse,
	parseConductorWorkerSubmission,
} from './conductorWorker';
import {
	buildConductorDemoEvidenceItem,
	buildConductorWorkerBlockedDecision,
	buildConductorWorkerCompletedDecision,
	mergeConductorTaskEvidence,
	satisfiesConductorTaskCompletionProofRequirement,
	shouldRouteWorkerBlockToOperator,
} from './conductorLaneDecisions';
import {
	buildDefaultConductorTaskCompletionProof,
	buildDefaultConductorTaskCompletionProofRequirement,
	requiresConductorTaskCompletionProof,
	requiresConductorTaskExplicitEvidence,
} from '../../shared/conductorTasks';
import {
	runConductorAgentTurn,
	type ConductorAgentRunOptions,
	type ConductorAgentRunResult,
} from './conductorAgentRuntime';
import { isCompletedDemoCapture } from '../../shared/demo-artifacts';

export interface ConductorExecutionRunnerInput {
	groupId: string;
	groupName: string;
	runId: string;
	selectedTemplate: Session;
	repoRoot: string;
	sshRemoteId?: string;
	conductorWorktreeBasePath?: string;
	maxWorkers: number;
	taskMirror: ConductorTaskMirror;
	runJournal: ConductorRunJournal;
	liveRuns: ConductorRun[];
	childTasksByParentId: Map<string, ConductorTask[]>;
	completedTaskIds: Set<string>;
	blockedTaskIds: Set<string>;
	getDependencyReadyTasks: () => ConductorTask[];
	isPaused: () => boolean;
	userPausedMessage: string;
	isCancelled: (taskId: string) => boolean;
	clearCancelled: (taskId: string) => void;
	recordTaskAgentHistory: (
		taskId: string,
		role: 'worker' | 'planner',
		sessionId: string,
		sessionName: string | undefined,
		runId: string
	) => void;
	buildTaskAttentionRequest: (input: {
		kind: ConductorTaskAttentionRequest['kind'];
		summary: string;
		requestedAction: string;
		requestedByRole: ConductorTaskAttentionRequest['requestedByRole'];
		requestedBySessionId?: string;
		suggestedResponse?: string;
		runId?: string;
	}) => ConductorTaskAttentionRequest;
	buildClarificationPrompt: (input: {
		task: ConductorTask;
		dependencyTitles: string[];
		blockedReason: string;
		cwd: string;
	}) => string;
	isProviderLimitMessage: (message: string) => boolean;
	runAgentTurn?: (
		options: ConductorAgentRunOptions
	) => Promise<ConductorAgentRunResult>;
	worktreeSetup?: (
		repoRoot: string,
		worktreePath: string,
		branchName: string,
		sshRemoteId?: string
	) => Promise<{ success: boolean; error?: string }>;
}

export interface ConductorExecutionRunnerResult {
	blockedMessage: string | null;
	pausedByUser: boolean;
	workerAgentSessionIds: string[];
	taskWorkerSessionIds: Record<string, string>;
	workerBranches: string[];
	worktreePaths: string[];
	taskBranches: Record<string, string>;
	taskWorktreePaths: Record<string, string>;
}

export async function runConductorExecutionLane(
	input: ConductorExecutionRunnerInput
): Promise<ConductorExecutionRunnerResult> {
	const runAgentTurn = input.runAgentTurn || runConductorAgentTurn;
	const worktreeSetup =
		input.worktreeSetup ||
		((repoRoot, worktreePath, branchName, sshRemoteId) =>
			window.maestro.git.worktreeSetup(repoRoot, worktreePath, branchName, sshRemoteId));

	let blockedMessage: string | null = null;
	let pausedByUser = false;
	let workerAgentSessionIds: string[] = [];
	const taskWorkerSessionIds: Record<string, string> = {};
	const workerBranches: string[] = [];
	const worktreePaths: string[] = [];
	const taskBranches: Record<string, string> = {};
	const taskWorktreePaths: Record<string, string> = {};
	const activeWorkers = new Map<string, Promise<void>>();
	const runningTaskIds = new Set<string>();

	const launchTask = async (taskId: string) => {
		const task = input.taskMirror.get(taskId);
		if (!task) {
			return;
		}

		const workerTarget = buildConductorWorktreeTarget(
			input.repoRoot,
			input.groupName || 'group',
			`${input.runId}-${task.id}`,
			input.conductorWorktreeBasePath || undefined
		);
		const workerSetupResult = await worktreeSetup(
			input.repoRoot,
			workerTarget.worktreePath,
			workerTarget.branchName,
			input.sshRemoteId
		);
		if (!workerSetupResult.success) {
			throw new Error(workerSetupResult.error || `Failed to create worktree for ${task.title}.`);
		}

		if (!workerBranches.includes(workerTarget.branchName)) {
			workerBranches.push(workerTarget.branchName);
		}
		if (!worktreePaths.includes(workerTarget.worktreePath)) {
			worktreePaths.push(workerTarget.worktreePath);
		}
		taskBranches[task.id] = workerTarget.branchName;
		taskWorktreePaths[task.id] = workerTarget.worktreePath;

		const taskStartedAt = Date.now();
		input.runJournal.appendEvent(
			'task_started',
			`Started task: ${task.title} in ${workerTarget.branchName}`,
			taskStartedAt
		);
		input.runJournal.sync({
			workerBranches: [...workerBranches],
			worktreePaths: [...worktreePaths],
			taskBranches: { ...taskBranches },
			taskWorktreePaths: { ...taskWorktreePaths },
			branchName: workerBranches[0],
			worktreePath: worktreePaths[0],
		});
		input.taskMirror.patch(task.id, { status: 'running' }, task);

		const markTaskNeedsAttention = (message: string, suggestedResponse: string) => {
			const finishedAt = Date.now();
			const liveTask = input.taskMirror.get(task.id) || task;
			const attentionRequest = input.buildTaskAttentionRequest({
				kind: 'blocked',
				summary: message,
				requestedAction: message,
				requestedByRole: 'worker',
				requestedBySessionId: taskWorkerSessionIds[task.id],
				suggestedResponse,
				runId: input.runId,
			});
			input.taskMirror.patch(
				task.id,
				{
					status: 'needs_input',
					changedPaths: liveTask.changedPaths || [],
					attentionRequest,
				},
				liveTask
			);
			input.blockedTaskIds.add(task.id);
			input.runJournal.appendEvent(
				'task_needs_input',
				`Task needs input: ${task.title}. ${message}`,
				finishedAt
			);
		};

		try {
			const dependencyTitles = task.dependsOn
				.map((dependencyId) => input.taskMirror.get(dependencyId)?.title)
				.filter((title): title is string => Boolean(title));
			const revisionRequest = getEffectiveConductorTaskAttentionRequest(
				task,
				input.liveRuns,
				{ allowLegacyFallback: false }
			);
			const explicitEvidenceRequired = requiresConductorTaskExplicitEvidence(task);
			const proofRequirement = requiresConductorTaskCompletionProof(task)
				? task.completionProofRequirement || buildDefaultConductorTaskCompletionProofRequirement()
				: null;
			const prompt = buildConductorWorkerPrompt(
				input.groupName || 'Unnamed Group',
				{ ...input.selectedTemplate, cwd: workerTarget.worktreePath },
				task,
				dependencyTitles,
				revisionRequest?.status === 'open' ? revisionRequest.requestedAction : null
			);
			const runWorkerAttempt = (workerPrompt: string, enableDemoCapture: boolean) =>
				runAgentTurn({
					parentSession: input.selectedTemplate,
					role: 'worker',
					taskTitle: task.title,
					taskDescription: task.description,
					scopePaths: task.scopePaths,
					prompt: workerPrompt,
					cwd: workerTarget.worktreePath,
					branch: workerTarget.branchName,
					runId: input.runId,
					taskId: task.id,
					readOnlyMode: false,
					expectedSubmissionKind: 'worker',
					demoCapture: enableDemoCapture
						? { enabled: true, browserMode: 'chrome' }
						: undefined,
					onSessionReady: (session) => {
						taskWorkerSessionIds[task.id] = session.id;
						workerAgentSessionIds = Array.from(new Set([...workerAgentSessionIds, session.id]));
						input.recordTaskAgentHistory(task.id, 'worker', session.id, session.name, input.runId);
						input.taskMirror.patch(
							task.id,
							{
								status: 'running',
								workerSessionId: session.id,
								workerSessionName: session.name,
								attentionRequest: null,
							},
							task
						);
						input.runJournal.sync({
							taskWorkerSessionIds: { ...taskWorkerSessionIds },
							agentSessionIds: [...workerAgentSessionIds],
						});
					},
				});
			let workerResult = await runWorkerAttempt(
				prompt,
				Boolean(explicitEvidenceRequired || proofRequirement)
			);
			let result;
			try {
				result =
					workerResult.structuredSubmission?.kind === 'worker'
						? parseConductorWorkerSubmission(workerResult.structuredSubmission.payload)
						: parseConductorWorkerResponse(workerResult.response);
			} catch (error) {
				const retryPrompt = `${prompt}

IMPORTANT:
- You have already attempted this Conductor task.
- Do not repeat the work unless it is strictly necessary to inspect the current workspace state.
- Submit the required final Conductor result now.
- Return exactly one JSON object and nothing else.
- Do not include markdown code fences.
- The first character of your response must be { and the last character must be }.
- If you already captured proof or created artifacts, include them in the evidence array.`;
				try {
					const retryResult = await runWorkerAttempt(retryPrompt, false);
					workerResult = {
						...retryResult,
						demoCard: retryResult.demoCard || workerResult.demoCard,
					};
					result =
						retryResult.structuredSubmission?.kind === 'worker'
							? parseConductorWorkerSubmission(retryResult.structuredSubmission.payload)
							: parseConductorWorkerResponse(retryResult.response);
				} catch (retryError) {
					const message =
						retryError instanceof Error
							? retryError.message
							: error instanceof Error
								? error.message
								: 'Worker returned an unreadable result.';
					markTaskNeedsAttention(
						`Worker finished but returned an unreadable result. ${message}`,
						'Review the worker response or logs, then move the task back to Ready to retry it.'
					);
					return;
				}
			}
			const finishedAt = Date.now();
			const demoEvidence =
				workerResult.demoCard && isCompletedDemoCapture(workerResult.demoCard)
					? [buildConductorDemoEvidenceItem(workerResult.demoCard)]
					: [];
			const combinedEvidence = mergeConductorTaskEvidence(
				task.evidence,
				result.evidence,
				demoEvidence
			);

			if (result.outcome === 'blocked') {
				const blockedReason = result.blockedReason || result.summary;
				if (!shouldRouteWorkerBlockToOperator(blockedReason)) {
					let clarificationSessionId: string | undefined;
					let clarificationGuidance = `Make the narrowest reasonable assumption that fits the task description, acceptance criteria, and nearby code patterns. Keep scope tight and avoid introducing extra work.`;

					try {
						const clarificationResult = await runAgentTurn({
							parentSession: input.selectedTemplate,
							role: 'planner',
							taskTitle: task.title,
							taskDescription: task.description,
							scopePaths: task.scopePaths,
							prompt: input.buildClarificationPrompt({
								task,
								dependencyTitles,
								blockedReason,
								cwd: workerTarget.worktreePath,
							}),
							cwd: workerTarget.worktreePath,
							branch: workerTarget.branchName,
							runId: input.runId,
							taskId: task.id,
							readOnlyMode: true,
							onSessionReady: (session) => {
								clarificationSessionId = session.id;
								workerAgentSessionIds = Array.from(
									new Set([...workerAgentSessionIds, session.id])
								);
								input.recordTaskAgentHistory(
									task.id,
									'planner',
									session.id,
									session.name,
									input.runId
								);
								input.runJournal.sync({
									agentSessionIds: [...workerAgentSessionIds],
								});
							},
						});
						if (clarificationResult.response.trim()) {
							clarificationGuidance = clarificationResult.response.trim();
						}
					} catch {
						// Keep narrow default guidance.
					}

					const clarificationDecision = buildConductorWorkerBlockedDecision({
						task,
						result,
						combinedEvidence,
						runId: input.runId,
						clarificationGuidance,
						clarificationSessionId,
						finishedAt,
					});
					input.taskMirror.patch(task.id, clarificationDecision.taskUpdates, task);
					input.runJournal.appendEvent(
						clarificationDecision.eventType,
						clarificationDecision.eventMessage,
						finishedAt
					);
					return;
				}

				const blockedDecision = buildConductorWorkerBlockedDecision({
					task,
					result,
					combinedEvidence,
					runId: input.runId,
					workerSessionId: taskWorkerSessionIds[task.id],
					finishedAt,
				});
				input.taskMirror.patch(task.id, blockedDecision.taskUpdates, task);
				if (blockedDecision.blocksExecution) {
					input.blockedTaskIds.add(task.id);
				}
				input.runJournal.appendEvent(
					blockedDecision.eventType,
					blockedDecision.eventMessage,
					finishedAt
				);
				return;
			}

			const capturedProof =
				proofRequirement &&
				workerResult.demoCard &&
				satisfiesConductorTaskCompletionProofRequirement(workerResult.demoCard, proofRequirement)
					? {
							...(task.completionProof || buildDefaultConductorTaskCompletionProof(finishedAt)),
							status: 'captured' as const,
							demoId: workerResult.demoCard.demoId,
							captureRunId: workerResult.demoCard.captureRunId,
							screenshotCount: workerResult.demoCard.stepCount,
							videoArtifactId: workerResult.demoCard.videoArtifact?.id,
							requestedAt: task.completionProof?.requestedAt || finishedAt,
							capturedAt: finishedAt,
							approvedAt: undefined,
							rejectedAt: undefined,
						}
					: task.completionProof;

			const completionDecision = buildConductorWorkerCompletedDecision({
				task,
				groupId: input.groupId,
				result,
				combinedEvidence,
				capturedProof,
				runId: input.runId,
				workerSessionId: taskWorkerSessionIds[task.id],
				finishedAt,
			});
			input.taskMirror.patch(task.id, completionDecision.taskUpdates, task);
			if (completionDecision.completesTask) {
				input.completedTaskIds.add(task.id);
			}
			if (completionDecision.blocksExecution) {
				input.blockedTaskIds.add(task.id);
			}
			if (completionDecision.followUpTasks && completionDecision.followUpTasks.length > 0) {
				input.taskMirror.append(completionDecision.followUpTasks);
				input.runJournal.sync({
					taskIds: Array.from(
						new Set([
							...input.runJournal.getRun().taskIds,
							...completionDecision.followUpTasks.map((followUpTask) => followUpTask.id),
						])
					),
				});
			}
			input.runJournal.appendEvent(
				completionDecision.eventType,
				completionDecision.eventMessage,
				finishedAt
			);
		} catch (error) {
			if (input.isCancelled(task.id)) {
				const cancelledAt = Date.now();
				input.taskMirror.commit(
					applyConductorTaskUpdates(task, { status: 'cancelled' }, cancelledAt)
				);
				input.runJournal.appendEvent(
					'task_cancelled',
					`Stopped task: ${task.title}.`,
					cancelledAt
				);
				return;
			}
			const message = error instanceof Error ? error.message : 'Task execution failed.';
			if (input.isProviderLimitMessage(message)) {
				throw error;
			}
			markTaskNeedsAttention(
				message,
				'Inspect the worker session output, address the blocker, then move the task back to Ready to retry it.'
			);
			return;
		} finally {
			input.clearCancelled(task.id);
			runningTaskIds.delete(task.id);
			activeWorkers.delete(task.id);
		}
	};

	while (true) {
		let launchedWorker = false;

		while (activeWorkers.size < input.maxWorkers && !input.isPaused()) {
			const runningTasks = Array.from(runningTaskIds)
				.map((taskId) => input.taskMirror.get(taskId))
				.filter((task): task is NonNullable<typeof task> => Boolean(task));
			const nextTask = input
				.getDependencyReadyTasks()
				.find((task) => !runningTasks.some((runningTask) => tasksConflict(task, runningTask)));

			if (!nextTask) {
				break;
			}

			runningTaskIds.add(nextTask.id);
			const workerPromise = launchTask(nextTask.id);
			activeWorkers.set(nextTask.id, workerPromise);
			launchedWorker = true;
		}

		if (activeWorkers.size === 0) {
			if (input.isPaused()) {
				pausedByUser = true;
				blockedMessage = input.userPausedMessage;
				break;
			}
			const remainingReady = input.getDependencyReadyTasks();
			if (remainingReady.length > 0) {
				blockedMessage =
					input.blockedTaskIds.size > 0
						? 'Execution finished with blocked tasks. Some remaining tasks could not start because their dependencies are blocked.'
						: 'Execution stopped because remaining runnable tasks overlap in scope or are still waiting on dependencies.';
			}
			break;
		}

		if (launchedWorker) {
			await Promise.resolve();
		}

		await Promise.race(Array.from(activeWorkers.values()));
	}

	return {
		blockedMessage,
		pausedByUser,
		workerAgentSessionIds,
		taskWorkerSessionIds,
		workerBranches,
		worktreePaths,
		taskBranches,
		taskWorktreePaths,
	};
}
