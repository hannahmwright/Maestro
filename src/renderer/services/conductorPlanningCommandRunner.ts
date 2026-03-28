import type {
	ConductorAgentRole,
	ConductorProviderAgent,
	ConductorRun,
	ConductorTask,
	ConductorTaskPriority,
	ConductorTaskStatus,
	Session,
} from '../types';
import type { ConductorWorkspaceMachineEvent } from '../../shared/conductorWorkspaceMachine';
import { applyConductorTaskUpdates } from '../../shared/conductorTasks';
import { generateId } from '../utils/ids';
import {
	buildConductorPlannerPrompt,
	parseConductorPlannerResponse,
	parseConductorPlannerSubmission,
	type ConductorPlanDraft,
} from './conductorPlanner';
import { createConductorRunJournal } from './conductorRunJournal';
import { runConductorAgentTurn } from './conductorAgentRuntime';

function parsePlannerResult(result: Awaited<ReturnType<typeof runConductorAgentTurn>>): ConductorPlanDraft {
	return result.structuredSubmission?.kind === 'planner'
		? parseConductorPlannerSubmission(result.structuredSubmission.payload)
		: parseConductorPlannerResponse(result.response);
}

function buildPlannerTaskIds(parsedPlan: ConductorPlanDraft, reuseFirstTaskId?: string) {
	return parsedPlan.tasks.map((plannedTask, index) => ({
		titleKey: plannedTask.title.trim().toLowerCase(),
		id: index === 0 && reuseFirstTaskId ? reuseFirstTaskId : `conductor-task-${generateId()}`,
	}));
}

export function deriveConductorPlanTitle(request: string): string {
	const firstLine = request
		.trim()
		.split('\n')
		.map((line) => line.trim())
		.find(Boolean);

	if (!firstLine) {
		return 'New Conductor request';
	}

	return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

export function approveConductorPlanningRunCommand(input: {
	runId: string;
	groupId: string;
	runs: ConductorRun[];
	tasks: ConductorTask[];
	approvedBy?: 'operator' | 'conductor';
	commitTaskSnapshots: (tasks: ConductorTask[]) => void;
	upsertRun: (run: ConductorRun) => void;
	updateRun: (runId: string, updates: Partial<ConductorRun>) => void;
	transitionConductor: (groupId: string, event: ConductorWorkspaceMachineEvent) => void;
	cleanupSessions: (sessionIds: string[]) => void;
}): boolean {
	const run = input.runs.find((candidate) => candidate.id === input.runId);
	if (!run) {
		return false;
	}

	const approvedBy = input.approvedBy || 'operator';
	const approvedAt = Date.now();
	input.commitTaskSnapshots(
		input.tasks
			.filter(
				(task) =>
					task.groupId === input.groupId && task.source === 'planner' && task.status === 'draft'
			)
			.map((task) => applyConductorTaskUpdates(task, { status: 'ready' }, approvedAt))
	);
	const planningRunJournal = createConductorRunJournal(run, {
		upsertRun: input.upsertRun,
		updateRun: input.updateRun,
	});
	planningRunJournal.appendEvent(
		'plan_approved',
		approvedBy === 'conductor'
			? 'Conductor approved the plan automatically and queued it for execution.'
			: 'You approved the plan. Planner tasks are now ready for execution.',
		approvedAt
	);
	planningRunJournal.finalize({
		status: 'completed',
		approvedAt,
		endedAt: approvedAt,
	});
	input.transitionConductor(input.groupId, { type: 'RESET_TO_IDLE' });
	input.cleanupSessions(run.agentSessionIds || []);
	return true;
}

export async function runConductorScopedTaskPlanningCommand(input: {
	groupId: string;
	groupName: string;
	task: ConductorTask;
	selectedTemplate: Session;
	sshRemoteId?: string;
	transitionConductor: (groupId: string, event: ConductorWorkspaceMachineEvent) => void;
	patchTaskById: (taskId: string, patch: Partial<ConductorTask>) => void;
	replaceTasksByIds: (taskIds: string[], nextTasks: ConductorTask[]) => void;
	upsertRun: (run: ConductorRun) => void;
	updateRun: (runId: string, updates: Partial<ConductorRun>) => void;
	cleanupSessions: (sessionIds: string[]) => void;
	isProviderLimitMessage: (message: string) => boolean;
	isCancelled: (taskId: string) => boolean;
	clearCancelled: (taskId: string) => void;
}): Promise<{
	errorMessage: string | null;
	shouldQueueReadyTasks: boolean;
}> {
	const now = Date.now();
	const runId = `conductor-run-${generateId()}`;

	input.patchTaskById(input.task.id, { status: 'planning' });
	input.transitionConductor(input.groupId, { type: 'PLANNING_STARTED' });
	const planningRunJournal = createConductorRunJournal(
		{
			id: runId,
			groupId: input.groupId,
			kind: 'planning',
			baseBranch: input.selectedTemplate.worktreeBranch || '',
			sshRemoteId: input.sshRemoteId,
			agentSessionIds: [],
			integrationBranch: '',
			status: 'planning',
			summary: '',
			plannerInput: input.task.description,
			taskIds: [input.task.id],
			events: [],
			startedAt: now,
		},
		{ upsertRun: input.upsertRun, updateRun: input.updateRun }
	);
	planningRunJournal.appendEvent(
		'planning_started',
		`Planning started for ${input.task.title}.`,
		now
	);

	let plannerSessionId: string | undefined;
	let plannerSessionName: string | undefined;

	try {
		const prompt = buildConductorPlannerPrompt({
			groupName: input.groupName,
			templateSession: input.selectedTemplate,
			manualTasks: [
				{
					title: input.task.title,
					description: input.task.description,
					priority: input.task.priority,
					status: 'ready',
				},
			],
			operatorNotes:
				'Break this task into executable work. If it can stay as one task, return a single execution task.',
		});
		const plannerResult = await runConductorAgentTurn({
			parentSession: input.selectedTemplate,
			role: 'planner',
			taskTitle: input.task.title,
			taskDescription: input.task.description,
			scopePaths: input.task.scopePaths,
			prompt,
			cwd: input.selectedTemplate.cwd,
			runId,
			taskId: input.task.id,
			readOnlyMode: true,
			expectedSubmissionKind: 'planner',
			onSessionReady: (session) => {
				plannerSessionId = session.id;
				plannerSessionName = session.name;
				input.patchTaskById(input.task.id, {
					plannerSessionId: session.id,
					plannerSessionName: session.name,
				});
				planningRunJournal.sync({
					plannerSessionId: session.id,
					agentSessionIds: [session.id],
				});
			},
		});

		if (input.isCancelled(input.task.id)) {
			const cancelledAt = Date.now();
			planningRunJournal.appendEvent(
				'task_cancelled',
				`Stopped planning for ${input.task.title}.`,
				cancelledAt
			);
			planningRunJournal.finalize({
				status: 'cancelled',
				summary: `Planning was stopped for ${input.task.title}.`,
				endedAt: cancelledAt,
			});
			input.transitionConductor(input.groupId, { type: 'RESET_TO_IDLE' });
			input.cleanupSessions([plannerSessionId || '']);
			return { errorMessage: null, shouldQueueReadyTasks: false };
		}

		const parsedPlan = parsePlannerResult(plannerResult);
		if (parsedPlan.tasks.length === 0) {
			throw new Error('Planner did not return any executable tasks.');
		}

		const updatedAt = Date.now();
		const generatedTaskIds = buildPlannerTaskIds(parsedPlan, input.task.id);
		const titleToId = new Map(generatedTaskIds.map((entry) => [entry.titleKey, entry.id]));
		const plannedTasks = parsedPlan.tasks.map((plannedTask, index) => {
			const mappedDependsOn = plannedTask.dependsOn
				.map((dependency) => titleToId.get(dependency.trim().toLowerCase()))
				.filter((dependencyId): dependencyId is string => Boolean(dependencyId));

			return {
				id: titleToId.get(plannedTask.title.trim().toLowerCase())!,
				groupId: input.groupId,
				parentTaskId: plannedTask.parentTitle
					? titleToId.get(plannedTask.parentTitle.trim().toLowerCase()) ||
						input.task.parentTaskId
					: input.task.parentTaskId,
				title: plannedTask.title,
				description: plannedTask.description,
				acceptanceCriteria: plannedTask.acceptanceCriteria,
				priority: plannedTask.priority,
				status: 'ready' as const,
				dependsOn:
					index === 0
						? Array.from(new Set([...input.task.dependsOn, ...mappedDependsOn]))
						: mappedDependsOn,
				scopePaths: plannedTask.scopePaths,
				changedPaths: [],
				completionProofRequirement:
					index === 0 ? input.task.completionProofRequirement : undefined,
				completionProof: index === 0 ? input.task.completionProof : undefined,
				source: 'planner' as const,
				plannerSessionId,
				plannerSessionName,
				createdAt: index === 0 ? input.task.createdAt : updatedAt,
				updatedAt,
			} satisfies ConductorTask;
		});
		const [anchorTask, ...extraTasks] = plannedTasks;
		input.replaceTasksByIds(
			[input.task.id, ...extraTasks.map((plannedTask) => plannedTask.id)],
			[anchorTask, ...extraTasks]
		);

		const completedAt = Date.now();
		planningRunJournal.appendEvent(
			'plan_generated',
			`Planner decomposed ${input.task.title} into ${plannedTasks.length} executable task${plannedTasks.length === 1 ? '' : 's'}.`,
			completedAt
		);
		planningRunJournal.appendEvent(
			'plan_approved',
			'Conductor auto-approved the scoped task and queued it for execution.',
			completedAt
		);
		planningRunJournal.finalize({
			status: 'completed',
			summary: parsedPlan.summary,
			taskIds: plannedTasks.map((plannedTask) => plannedTask.id),
			approvedAt: completedAt,
			endedAt: completedAt,
		});
		input.transitionConductor(input.groupId, { type: 'PLANNING_COMPLETED' });
		input.cleanupSessions([plannerSessionId || '']);
		return {
			errorMessage: null,
			shouldQueueReadyTasks: true,
		};
	} catch (error) {
		const finishedAt = Date.now();
		if (input.isCancelled(input.task.id)) {
			planningRunJournal.appendEvent(
				'task_cancelled',
				`Stopped planning for ${input.task.title}.`,
				finishedAt
			);
			planningRunJournal.finalize({
				status: 'cancelled',
				summary: `Planning was stopped for ${input.task.title}.`,
				endedAt: finishedAt,
			});
			input.transitionConductor(input.groupId, { type: 'RESET_TO_IDLE' });
			input.cleanupSessions([plannerSessionId || '']);
			return { errorMessage: null, shouldQueueReadyTasks: false };
		}

		const message = error instanceof Error ? error.message : 'Plan generation failed.';
		const isProviderLimit = input.isProviderLimitMessage(message);
		input.patchTaskById(input.task.id, {
			status: isProviderLimit ? 'ready' : 'needs_input',
		});
		planningRunJournal.appendEvent('planning_failed', message, finishedAt);
		planningRunJournal.finalize({
			status: 'attention_required',
			summary: message,
			endedAt: finishedAt,
		});
		input.transitionConductor(input.groupId, {
			type: 'EXECUTION_RESOLVED',
			nextStatus: 'attention_required',
			pause: isProviderLimit,
			holdReason: isProviderLimit ? message : null,
		});
		input.cleanupSessions([plannerSessionId || '']);
		return {
			errorMessage: message,
			shouldQueueReadyTasks: false,
		};
	} finally {
		input.clearCancelled(input.task.id);
	}
}

function buildDraftPlannerTasks(input: {
	groupId: string;
	runId: string;
	parsedPlan: ConductorPlanDraft;
	plannerSessionId?: string;
	plannerSessionName?: string;
}): ConductorTask[] {
	const titleToId = new Map<string, string>();
	const plannedTasks = input.parsedPlan.tasks.map((task) => {
		const taskId = `conductor-task-${generateId()}`;
		titleToId.set(task.title.trim().toLowerCase(), taskId);
		return {
			id: taskId,
			groupId: input.groupId,
			parentTaskId: undefined,
			title: task.title,
			description: task.description,
			acceptanceCriteria: task.acceptanceCriteria,
			priority: task.priority,
			status: 'draft' as const,
			dependsOn: [],
			scopePaths: task.scopePaths,
			changedPaths: [],
			source: 'planner' as const,
			attentionRequest: null,
			agentHistory: input.plannerSessionId
				? [
						{
							id: `conductor-task-agent-${generateId()}`,
							role: 'planner' as ConductorAgentRole,
							sessionId: input.plannerSessionId,
							sessionName: input.plannerSessionName,
							runId: input.runId,
							createdAt: Date.now(),
						},
					]
				: [],
			plannerSessionId: input.plannerSessionId,
			plannerSessionName: input.plannerSessionName,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		} satisfies ConductorTask;
	});
	return plannedTasks.map((task, index) => ({
		...task,
		parentTaskId: input.parsedPlan.tasks[index].parentTitle
			? titleToId.get(input.parsedPlan.tasks[index].parentTitle.trim().toLowerCase())
			: undefined,
		dependsOn: input.parsedPlan.tasks[index].dependsOn
			.map((dependency) => titleToId.get(dependency.trim().toLowerCase()))
			.filter((dependencyId): dependencyId is string => Boolean(dependencyId)),
	}));
}

export async function runConductorBoardPlanningCommand(input: {
	groupId: string;
	groupName: string;
	selectedTemplate: Session;
	sshRemoteId?: string;
	requestOverride?: string;
	operatorNotes: string;
	manualTasks: Array<{
		title: string;
		description: string;
		priority: ConductorTaskPriority;
		status: ConductorTaskStatus;
	}>;
	providerOverride?: ConductorProviderAgent;
	replacePlannerTasks: (groupId: string, nextTasks: ConductorTask[]) => void;
	upsertRun: (run: ConductorRun) => void;
	updateRun: (runId: string, updates: Partial<ConductorRun>) => void;
	transitionConductor: (groupId: string, event: ConductorWorkspaceMachineEvent) => void;
	cleanupSessions: (sessionIds: string[]) => void;
	isProviderLimitMessage: (message: string) => boolean;
}): Promise<{
	errorMessage: string | null;
	requestConsumed: boolean;
	autoApproveRunId: string | null;
}> {
	const requestOverride = input.requestOverride?.trim() || '';
	const planningTasks = requestOverride
		? [
				{
					title: deriveConductorPlanTitle(requestOverride),
					description: requestOverride,
					priority: 'medium' as ConductorTaskPriority,
					status: 'ready' as ConductorTaskStatus,
				},
			]
		: input.manualTasks;

	if (planningTasks.length === 0 && !input.operatorNotes.trim()) {
		return {
			errorMessage: 'Add a request before generating a plan.',
			requestConsumed: false,
			autoApproveRunId: null,
		};
	}

	const now = Date.now();
	const runId = `conductor-run-${generateId()}`;

	input.transitionConductor(input.groupId, { type: 'PLANNING_STARTED' });
	const planningRunJournal = createConductorRunJournal(
		{
			id: runId,
			groupId: input.groupId,
			kind: 'planning',
			baseBranch: input.selectedTemplate.worktreeBranch || '',
			sshRemoteId: input.sshRemoteId,
			agentSessionIds: [],
			integrationBranch: '',
			status: 'planning',
			summary: '',
			plannerInput: input.operatorNotes.trim(),
			taskIds: [],
			events: [],
			startedAt: now,
		},
		{ upsertRun: input.upsertRun, updateRun: input.updateRun }
	);
	planningRunJournal.appendEvent(
		'planning_started',
		`Planning started with ${planningTasks.length} request item${planningTasks.length === 1 ? '' : 's'}.`,
		now
	);

	let plannerSessionId: string | undefined;
	let plannerSessionName: string | undefined;
	try {
		const prompt = buildConductorPlannerPrompt({
			groupName: input.groupName,
			templateSession: input.selectedTemplate,
			manualTasks: planningTasks,
			operatorNotes: input.operatorNotes,
		});
		const plannerResult = await runConductorAgentTurn({
			parentSession: input.selectedTemplate,
			role: 'planner',
			providerOverride: input.providerOverride,
			taskDescription: planningTasks.map((candidate) => candidate.description).join('\n'),
			providerRouteHint: 'default',
			prompt,
			cwd: input.selectedTemplate.cwd,
			runId,
			readOnlyMode: true,
			expectedSubmissionKind: 'planner',
			onSessionReady: (session) => {
				plannerSessionId = session.id;
				plannerSessionName = session.name;
				planningRunJournal.sync({
					plannerSessionId: session.id,
					agentSessionIds: [session.id],
				});
			},
		});
		const parsedPlan = parsePlannerResult(plannerResult);
		const plannedTasksWithDeps = buildDraftPlannerTasks({
			groupId: input.groupId,
			runId,
			parsedPlan,
			plannerSessionId,
			plannerSessionName,
		});
		const planGeneratedAt = Date.now();

		input.replacePlannerTasks(input.groupId, plannedTasksWithDeps);
		planningRunJournal.appendEvent(
			'plan_generated',
			`Planner proposed ${plannedTasksWithDeps.length} execution task${plannedTasksWithDeps.length === 1 ? '' : 's'}.`,
			planGeneratedAt
		);
		planningRunJournal.sync({
			status: 'awaiting_approval',
			summary: parsedPlan.summary,
			taskIds: plannedTasksWithDeps.map((task) => task.id),
		});
		input.transitionConductor(input.groupId, { type: 'PLAN_AWAITING_APPROVAL' });

		return {
			errorMessage: null,
			requestConsumed: Boolean(requestOverride),
			autoApproveRunId: runId,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Plan generation failed.';
		const isProviderLimit = input.isProviderLimitMessage(message);
		const failedAt = Date.now();
		planningRunJournal.appendEvent('planning_failed', message, failedAt);
		planningRunJournal.finalize({
			status: 'attention_required',
			summary: message,
			endedAt: failedAt,
		});
		input.transitionConductor(input.groupId, {
			type: 'PLANNING_FAILED',
			pause: isProviderLimit,
			holdReason: isProviderLimit ? message : null,
		});
		input.cleanupSessions([plannerSessionId || '']);
		return {
			errorMessage: message,
			requestConsumed: false,
			autoApproveRunId: null,
		};
	}
}
