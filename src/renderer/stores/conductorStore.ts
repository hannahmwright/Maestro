import { create } from 'zustand';
import type {
	Conductor,
	ConductorAgentRole,
	ConductorTask,
	ConductorTaskAgentHistoryEntry,
	ConductorRun,
	ConductorProviderRouting,
	ConductorTaskPriority,
	ConductorTaskSource,
	ConductorTaskStatus,
	ConductorStatus,
	ConductorView,
	Group,
} from '../types';
import { generateId } from '../utils/ids';
import {
	applyConductorTaskUpdates,
	buildDefaultConductorTaskCompletionProof,
	buildDefaultConductorTaskCompletionProofRequirement,
	repairLegacyConductorTasks,
} from '../../shared/conductorTasks';
import {
	transitionConductorWorkspace,
	type ConductorWorkspaceMachineEvent,
} from '../../shared/conductorWorkspaceMachine';

interface ConductorStoreState {
	conductors: Conductor[];
	tasks: ConductorTask[];
	runs: ConductorRun[];
	activeConductorView: ConductorView | null;
}

interface ConductorStoreActions {
	setConductors: (v: Conductor[] | ((prev: Conductor[]) => Conductor[])) => void;
	setTasks: (v: ConductorTask[] | ((prev: ConductorTask[]) => ConductorTask[])) => void;
	setRuns: (v: ConductorRun[] | ((prev: ConductorRun[]) => ConductorRun[])) => void;
	setActiveConductorView: (
		v: ConductorView | null | ((prev: ConductorView | null) => ConductorView | null)
	) => void;
	syncWithGroups: (groups: Group[]) => void;
	setConductor: (groupId: string, updates: Partial<Conductor>) => void;
	transitionConductor: (groupId: string, event: ConductorWorkspaceMachineEvent) => void;
	addTask: (
		groupId: string,
		input: {
			title: string;
			description?: string;
			priority?: ConductorTaskPriority;
			status?: ConductorTaskStatus;
			parentTaskId?: string;
			source?: ConductorTaskSource;
			completionProofRequired?: boolean;
		}
	) => void;
	updateTask: (taskId: string, updates: Partial<ConductorTask>) => void;
	commitTaskSnapshot: (task: ConductorTask) => ConductorTask;
	commitTaskSnapshots: (tasks: ConductorTask[]) => ConductorTask[];
	patchTaskById: (
		taskId: string,
		updates: Partial<ConductorTask>,
		updatedAt?: number
	) => ConductorTask | null;
	patchTaskFromSnapshot: (
		task: ConductorTask,
		updates: Partial<ConductorTask>,
		updatedAt?: number
	) => ConductorTask;
	recoverStaleTasks: (taskIds: string[], recoveredAt?: number) => void;
	appendTaskAgentHistory: (
		taskId: string,
		input: {
			role: ConductorAgentRole;
			sessionId: string;
			sessionName?: string;
			runId?: string;
		}
	) => ConductorTask | null;
	replaceTasksByIds: (taskIdsToReplace: string[], nextTasks: ConductorTask[]) => void;
	upsertTasks: (tasks: ConductorTask[]) => void;
	deleteTask: (taskId: string) => void;
	replacePlannerTasks: (groupId: string, nextTasks: ConductorTask[]) => void;
	upsertRun: (run: ConductorRun) => void;
	updateRun: (runId: string, updates: Partial<ConductorRun>) => void;
}

type ConductorStore = ConductorStoreState & ConductorStoreActions;

function resolve<T>(valOrFn: T | ((prev: T) => T), prev: T): T {
	return typeof valOrFn === 'function' ? (valOrFn as (prev: T) => T)(prev) : valOrFn;
}

function buildProviderRouting(
	existing?: Partial<Conductor>['providerRouting']
): ConductorProviderRouting {
	return {
		default: {
			primary: existing?.default?.primary || 'workspace-lead',
			fallback: existing?.default?.fallback ?? null,
		},
		ui: {
			primary: existing?.ui?.primary || 'claude-code',
			fallback: existing?.ui?.fallback ?? 'codex',
		},
		backend: {
			primary: existing?.backend?.primary || 'codex',
			fallback: existing?.backend?.fallback ?? 'claude-code',
		},
		pauseNearLimit: existing?.pauseNearLimit ?? true,
		nearLimitPercent: existing?.nearLimitPercent ?? 88,
	};
}

function buildConductor(groupId: string, existing?: Partial<Conductor>): Conductor {
	const now = Date.now();
	const {
		templateSessionId: _legacyTemplateSessionId,
		createdAt,
		updatedAt,
		...restExisting
	} = (existing || {}) as Partial<Conductor> & { templateSessionId?: string | null };
	return {
		groupId,
		status: 'needs_setup',
		resourceProfile: 'aggressive',
		currentPlanningRunId: existing?.currentPlanningRunId ?? null,
		currentExecutionRunId: existing?.currentExecutionRunId ?? null,
		currentReviewRunId: existing?.currentReviewRunId ?? null,
		currentIntegrationRunId: existing?.currentIntegrationRunId ?? null,
		autoExecuteOnPlanCreation: existing?.autoExecuteOnPlanCreation ?? true,
		isPaused: existing?.isPaused ?? false,
		holdReason: existing?.holdReason ?? null,
		keepConductorAgentSessions: false,
		providerRouting: buildProviderRouting(existing?.providerRouting),
		publishPolicy: 'manual_pr',
		deleteWorkerBranchesOnSuccess: false,
		createdAt: createdAt ?? now,
		updatedAt: updatedAt ?? now,
		...restExisting,
	};
}

function sameConductor(left: Conductor, right: Conductor): boolean {
	return (
		left.groupId === right.groupId &&
		left.status === right.status &&
		left.resourceProfile === right.resourceProfile &&
		left.currentPlanningRunId === right.currentPlanningRunId &&
		left.currentExecutionRunId === right.currentExecutionRunId &&
		left.currentReviewRunId === right.currentReviewRunId &&
		left.currentIntegrationRunId === right.currentIntegrationRunId &&
		left.autoExecuteOnPlanCreation === right.autoExecuteOnPlanCreation &&
		left.isPaused === right.isPaused &&
		left.holdReason === right.holdReason &&
		left.keepConductorAgentSessions === right.keepConductorAgentSessions &&
		JSON.stringify(left.providerRouting) === JSON.stringify(right.providerRouting) &&
		left.validationCommand === right.validationCommand &&
		left.publishPolicy === right.publishPolicy &&
		left.deleteWorkerBranchesOnSuccess === right.deleteWorkerBranchesOnSuccess &&
		left.createdAt === right.createdAt &&
		left.updatedAt === right.updatedAt
	);
}

function sameConductorContent(left: Conductor, right: Conductor): boolean {
	return (
		left.groupId === right.groupId &&
		left.status === right.status &&
		left.resourceProfile === right.resourceProfile &&
		left.currentPlanningRunId === right.currentPlanningRunId &&
		left.currentExecutionRunId === right.currentExecutionRunId &&
		left.currentReviewRunId === right.currentReviewRunId &&
		left.currentIntegrationRunId === right.currentIntegrationRunId &&
		left.autoExecuteOnPlanCreation === right.autoExecuteOnPlanCreation &&
		left.isPaused === right.isPaused &&
		left.holdReason === right.holdReason &&
		left.keepConductorAgentSessions === right.keepConductorAgentSessions &&
		JSON.stringify(left.providerRouting) === JSON.stringify(right.providerRouting) &&
		left.validationCommand === right.validationCommand &&
		left.publishPolicy === right.publishPolicy &&
		left.deleteWorkerBranchesOnSuccess === right.deleteWorkerBranchesOnSuccess &&
		left.createdAt === right.createdAt
	);
}

type ConductorRunPointerField =
	| 'currentPlanningRunId'
	| 'currentExecutionRunId'
	| 'currentReviewRunId'
	| 'currentIntegrationRunId';

const CONDUCTOR_CURRENT_RUN_POINTERS: Array<{
	field: ConductorRunPointerField;
	kind: NonNullable<ConductorRun['kind']>;
	statuses: ConductorStatus[];
}> = [
	{
		field: 'currentPlanningRunId',
		kind: 'planning',
		statuses: ['planning', 'awaiting_approval', 'attention_required'],
	},
	{
		field: 'currentExecutionRunId',
		kind: 'execution',
		statuses: ['running', 'blocked', 'attention_required'],
	},
	{
		field: 'currentReviewRunId',
		kind: 'review',
		statuses: ['running', 'attention_required'],
	},
	{
		field: 'currentIntegrationRunId',
		kind: 'integration',
		statuses: ['integrating', 'blocked', 'attention_required'],
	},
];

function compareConductorRunRecency(left: ConductorRun, right: ConductorRun): number {
	return (
		(right.endedAt || right.startedAt || 0) - (left.endedAt || left.startedAt || 0) ||
		right.id.localeCompare(left.id)
	);
}

function pickCurrentConductorRunId(
	runs: ConductorRun[],
	groupId: string,
	kind: NonNullable<ConductorRun['kind']>,
	statuses: ConductorStatus[],
	tasksById: Map<string, ConductorTask>
): string | null {
	return (
		[...runs]
			.filter(
				(run) =>
					run.groupId === groupId &&
					(run.kind || 'planning') === kind &&
					statuses.includes(run.status) &&
					!(
						(run.status === 'blocked' || run.status === 'attention_required') &&
						run.taskIds.length > 0 &&
						run.taskIds.every((taskId) => {
							const task = tasksById.get(taskId);
							if (!task) {
								return false;
							}
							const runEndedAt = run.endedAt || run.startedAt || 0;
							return (task.updatedAt || 0) > runEndedAt;
						})
					)
			)
			.sort(compareConductorRunRecency)[0]?.id || null
	);
}

function syncConductorCurrentRunPointers(
	conductor: Conductor,
	runs: ConductorRun[],
	tasksById: Map<string, ConductorTask>
): Conductor {
	let changed = false;
	let nextConductor = conductor;

	for (const pointer of CONDUCTOR_CURRENT_RUN_POINTERS) {
		const nextRunId = pickCurrentConductorRunId(
			runs,
			conductor.groupId,
			pointer.kind,
			pointer.statuses,
			tasksById
		);
		if (nextConductor[pointer.field] === nextRunId) {
			continue;
		}

		changed = true;
		nextConductor = {
			...nextConductor,
			[pointer.field]: nextRunId,
		};
	}

	return changed ? nextConductor : conductor;
}

function syncConductorsWithCurrentRuns(
	conductors: Conductor[],
	runs: ConductorRun[],
	tasks: ConductorTask[]
): Conductor[] {
	let changed = false;
	const tasksById = new Map(tasks.map((task) => [task.id, task] as const));
	const nextConductors = conductors.map((conductor) => {
		const synced = syncConductorCurrentRunPointers(conductor, runs, tasksById);
		if (synced !== conductor) {
			changed = true;
		}
		return synced;
	});

	return changed ? nextConductors : conductors;
}

function sameConductorView(
	left: ConductorView | null | undefined,
	right: ConductorView | null | undefined
): boolean {
	if (!left && !right) {
		return true;
	}

	if (!left || !right || left.scope !== right.scope) {
		return false;
	}

	if (left.scope === 'home') {
		return true;
	}

	return left.scope === 'workspace' && right.scope === 'workspace' && left.groupId === right.groupId;
}

export const useConductorStore = create<ConductorStore>()((set) => ({
	conductors: [],
	tasks: [],
	runs: [],
	activeConductorView: null,

	setConductors: (v) =>
		set((s) => {
			const nextConductors = resolve(v, s.conductors);
			return { conductors: syncConductorsWithCurrentRuns(nextConductors, s.runs, s.tasks) };
		}),
	setTasks: (v) =>
		set((s) => {
			const nextTasks = resolve(v, s.tasks);
			const repairedTasks = repairLegacyConductorTasks(nextTasks, s.runs);
			return {
				tasks: repairedTasks,
				conductors: syncConductorsWithCurrentRuns(s.conductors, s.runs, repairedTasks),
			};
		}),
	setRuns: (v) =>
		set((s) => {
			const nextRuns = resolve(v, s.runs);
			const repairedTasks = repairLegacyConductorTasks(s.tasks, nextRuns);
			return {
				runs: nextRuns,
				conductors: syncConductorsWithCurrentRuns(s.conductors, nextRuns, repairedTasks),
				tasks: repairedTasks,
			};
		}),
	setActiveConductorView: (v) =>
		set((s) => {
			const nextView = resolve(v, s.activeConductorView);
			return sameConductorView(s.activeConductorView, nextView)
				? s
				: { activeConductorView: nextView };
		}),

	syncWithGroups: (groups) =>
		set((s) => {
			const groupIds = new Set(groups.map((group) => group.id));
			const conductors = groups.map((group) => {
				const existing = s.conductors.find((conductor) => conductor.groupId === group.id);
				if (!existing) {
					return buildConductor(group.id);
				}

				const normalized = buildConductor(group.id, existing);
				return sameConductor(existing, normalized) ? existing : normalized;
			});
			const tasks = s.tasks.filter((task) => groupIds.has(task.groupId));
			const runs = s.runs.filter((run) => groupIds.has(run.groupId));
			const syncedConductors = syncConductorsWithCurrentRuns(conductors, runs, tasks);
			const activeConductorView =
				s.activeConductorView?.scope === 'workspace' &&
				groups.length > 0 &&
				!groupIds.has(s.activeConductorView.groupId)
					? null
					: s.activeConductorView;

			const conductorsUnchanged =
				syncedConductors.length === s.conductors.length &&
				syncedConductors.every((conductor, index) => conductor === s.conductors[index]);
			const tasksUnchanged =
				tasks.length === s.tasks.length && tasks.every((task, index) => task === s.tasks[index]);
			const runsUnchanged =
				runs.length === s.runs.length && runs.every((run, index) => run === s.runs[index]);
			const activeUnchanged = activeConductorView === s.activeConductorView;

			if (conductorsUnchanged && tasksUnchanged && runsUnchanged && activeUnchanged) {
				return s;
			}

			return { conductors: syncedConductors, tasks, runs, activeConductorView };
		}),

	setConductor: (groupId, updates) =>
		set((s) => {
			let changed = false;
			const conductors = s.conductors.map((conductor) => {
				if (conductor.groupId !== groupId) {
					return conductor;
				}

				const nextConductor = {
					...conductor,
					...updates,
					updatedAt: Date.now(),
				};
				if (sameConductorContent(conductor, nextConductor)) {
					return conductor;
				}

				changed = true;
				return nextConductor;
			});

			return changed ? { conductors } : s;
		}),

	transitionConductor: (groupId, event) =>
		set((s) => {
			let changed = false;
			const conductors = s.conductors.map((conductor) => {
				if (conductor.groupId !== groupId) {
					return conductor;
				}

				const nextConductor = transitionConductorWorkspace(conductor, event);
				if (sameConductorContent(conductor, nextConductor)) {
					return conductor;
				}

				changed = true;
				return nextConductor;
			});

			return changed ? { conductors } : s;
		}),

	addTask: (groupId, input) =>
		set((s) => {
			const now = Date.now();
			const task: ConductorTask = {
				id: `conductor-task-${generateId()}`,
				groupId,
				parentTaskId: input.parentTaskId,
				title: input.title.trim(),
				description: input.description?.trim() || '',
				acceptanceCriteria: [],
				priority: input.priority || 'medium',
				status: input.status || 'draft',
				dependsOn: [],
				scopePaths: [],
				source: input.source || 'manual',
				attentionRequest: null,
				completionProofRequirement:
					!input.parentTaskId && input.completionProofRequired
						? buildDefaultConductorTaskCompletionProofRequirement()
						: undefined,
				completionProof:
					!input.parentTaskId && input.completionProofRequired
						? buildDefaultConductorTaskCompletionProof(now)
						: undefined,
				agentHistory: [],
				createdAt: now,
				updatedAt: now,
			};
			return {
				tasks: [...s.tasks, task],
				conductors: s.conductors.map((conductor) =>
					conductor.groupId === groupId
						? transitionConductorWorkspace(conductor, { type: 'SETUP_COMPLETED' }, now)
						: conductor
				),
			};
		}),

	updateTask: (taskId, updates) =>
		set((s) => {
			const tasks = s.tasks.map((task) =>
				task.id === taskId ? { ...task, ...updates, updatedAt: Date.now() } : task
			);
			return {
				tasks,
				conductors: syncConductorsWithCurrentRuns(s.conductors, s.runs, tasks),
			};
		}),

	commitTaskSnapshot: (task) => {
		set((s) => {
			const tasks = s.tasks.some((candidate) => candidate.id === task.id)
				? s.tasks.map((candidate) => (candidate.id === task.id ? task : candidate))
				: [...s.tasks, task];
			return {
				tasks,
				conductors: syncConductorsWithCurrentRuns(s.conductors, s.runs, tasks),
			};
		});
		return task;
	},

	commitTaskSnapshots: (tasks) => {
		if (tasks.length === 0) {
			return tasks;
		}

		set((s) => {
			const existingIds = new Set(s.tasks.map((task) => task.id));
			const updatesById = new Map(tasks.map((task) => [task.id, task] as const));
			const nextTasks = [
				...s.tasks.map((task) => updatesById.get(task.id) || task),
				...tasks.filter((task) => !existingIds.has(task.id)),
			];
			return {
				tasks: nextTasks,
				conductors: syncConductorsWithCurrentRuns(s.conductors, s.runs, nextTasks),
			};
		});
		return tasks;
	},

	patchTaskById: (taskId, updates, updatedAt) => {
		let nextTask: ConductorTask | null = null;
		set((s) => {
			const currentTask = s.tasks.find((task) => task.id === taskId);
			if (!currentTask) {
				return s;
			}

			nextTask = applyConductorTaskUpdates(currentTask, updates, updatedAt);
			const tasks = s.tasks.map((task) => (task.id === taskId ? nextTask! : task));
			return {
				tasks,
				conductors: syncConductorsWithCurrentRuns(s.conductors, s.runs, tasks),
			};
		});
		return nextTask;
	},

	patchTaskFromSnapshot: (task, updates, updatedAt) => {
		const nextTask = applyConductorTaskUpdates(task, updates, updatedAt);
		set((s) => {
			const tasks = s.tasks.some((candidate) => candidate.id === task.id)
				? s.tasks.map((candidate) => (candidate.id === task.id ? nextTask : candidate))
				: [...s.tasks, nextTask];
			return {
				tasks,
				conductors: syncConductorsWithCurrentRuns(s.conductors, s.runs, tasks),
			};
		});
		return nextTask;
	},

	recoverStaleTasks: (taskIds, recoveredAt = Date.now()) =>
		set((s) => {
			if (taskIds.length === 0) {
				return s;
			}

			const staleTaskIdSet = new Set(taskIds);
			let changed = false;
			const tasks = s.tasks.map((task) => {
				if (!staleTaskIdSet.has(task.id)) {
					return task;
				}

				changed = true;
				return {
					...task,
					status: 'ready' as const,
					plannerSessionId: task.status === 'planning' ? undefined : task.plannerSessionId,
					plannerSessionName: task.status === 'planning' ? undefined : task.plannerSessionName,
					workerSessionId: task.status === 'running' ? undefined : task.workerSessionId,
					workerSessionName: task.status === 'running' ? undefined : task.workerSessionName,
					updatedAt: recoveredAt,
				};
			});

			return changed
				? {
						tasks,
						conductors: syncConductorsWithCurrentRuns(s.conductors, s.runs, tasks),
				  }
				: s;
		}),

	appendTaskAgentHistory: (taskId, input) => {
		let nextTask: ConductorTask | null = null;
		set((s) => {
			const currentTask = s.tasks.find((task) => task.id === taskId);
			if (!currentTask) {
				return s;
			}

			const existingHistory = currentTask.agentHistory || [];
			if (
				existingHistory.some(
					(entry) =>
						entry.role === input.role &&
						entry.sessionId === input.sessionId &&
						entry.runId === (input.runId || undefined)
				)
			) {
				nextTask = currentTask;
				return s;
			}

			const nextEntry: ConductorTaskAgentHistoryEntry = {
				id: `conductor-task-agent-${generateId()}`,
				role: input.role,
				sessionId: input.sessionId,
				sessionName: input.sessionName,
				runId: input.runId,
				createdAt: Date.now(),
			};
			nextTask = {
				...currentTask,
				agentHistory: [...existingHistory, nextEntry],
				updatedAt: Date.now(),
			};

			const tasks = s.tasks.map((task) => (task.id === taskId ? nextTask! : task));
			return {
				tasks,
				conductors: syncConductorsWithCurrentRuns(s.conductors, s.runs, tasks),
			};
		});
		return nextTask;
	},

	replaceTasksByIds: (taskIdsToReplace, nextTasks) =>
		set((s) => {
			const replaceIds = new Set(taskIdsToReplace);
			const tasks = [...s.tasks.filter((task) => !replaceIds.has(task.id)), ...nextTasks];
			return {
				tasks,
				conductors: syncConductorsWithCurrentRuns(s.conductors, s.runs, tasks),
			};
		}),

	upsertTasks: (tasks) =>
		set((s) => {
			if (tasks.length === 0) {
				return s;
			}

			const nextTasksById = new Map(s.tasks.map((task) => [task.id, task]));
			for (const task of tasks) {
				nextTasksById.set(task.id, task);
			}

			const mergedTaskIds = new Set(tasks.map((task) => task.id));
			const nextTasks = [
				...s.tasks.map((task) => nextTasksById.get(task.id) || task),
				...tasks.filter((task) => !s.tasks.some((existing) => existing.id === task.id)),
			];

			// Preserve only one copy per id even if callers accidentally pass duplicates.
			const dedupedTasks = nextTasks.filter((task, index, array) => {
				if (!mergedTaskIds.has(task.id)) {
					return true;
				}
				return array.findIndex((candidate) => candidate.id === task.id) === index;
			});
			return {
				tasks: dedupedTasks,
				conductors: syncConductorsWithCurrentRuns(s.conductors, s.runs, dedupedTasks),
			};
		}),

	deleteTask: (taskId) =>
		set((s) => {
			const tasks = s.tasks.filter((task) => task.id !== taskId);
			return {
				tasks,
				conductors: syncConductorsWithCurrentRuns(s.conductors, s.runs, tasks),
			};
		}),

	replacePlannerTasks: (groupId, nextTasks) =>
		set((s) => {
			const tasks = [
				// Only replace unapproved planner drafts for this workspace.
				// Preserving non-draft planner tasks keeps completed/stopped history on the board.
				...s.tasks.filter(
					(task) =>
						!(task.groupId === groupId && task.source === 'planner' && task.status === 'draft')
				),
				...nextTasks,
			];
			return {
				tasks,
				conductors: syncConductorsWithCurrentRuns(s.conductors, s.runs, tasks),
			};
		}),

	upsertRun: (run) =>
		set((s) => {
			const runs = s.runs.some((candidate) => candidate.id === run.id)
				? s.runs.map((candidate) => (candidate.id === run.id ? run : candidate))
				: [run, ...s.runs];
			return {
				runs,
				conductors: syncConductorsWithCurrentRuns(s.conductors, runs, s.tasks),
			};
		}),

	updateRun: (runId, updates) =>
		set((s) => {
			const runs = s.runs.map((run) =>
				run.id === runId
					? {
							...run,
							...updates,
						}
					: run
			);
			return {
				runs,
				conductors: syncConductorsWithCurrentRuns(s.conductors, runs, s.tasks),
			};
		}),
}));
