import { create } from 'zustand';
import type {
	Conductor,
	ConductorTask,
	ConductorRun,
	ConductorProviderRouting,
	ConductorTaskPriority,
	ConductorTaskSource,
	ConductorTaskStatus,
	ConductorView,
	Group,
} from '../types';
import { generateId } from '../utils/ids';
import {
	buildDefaultConductorTaskCompletionProof,
	buildDefaultConductorTaskCompletionProofRequirement,
	repairLegacyConductorTasks,
} from '../../shared/conductorTasks';

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

export const useConductorStore = create<ConductorStore>()((set) => ({
	conductors: [],
	tasks: [],
	runs: [],
	activeConductorView: null,

	setConductors: (v) => set((s) => ({ conductors: resolve(v, s.conductors) })),
	setTasks: (v) =>
		set((s) => {
			const nextTasks = resolve(v, s.tasks);
			return { tasks: repairLegacyConductorTasks(nextTasks, s.runs) };
		}),
	setRuns: (v) =>
		set((s) => {
			const nextRuns = resolve(v, s.runs);
			return {
				runs: nextRuns,
				tasks: repairLegacyConductorTasks(s.tasks, nextRuns),
			};
		}),
	setActiveConductorView: (v) =>
		set((s) => ({ activeConductorView: resolve(v, s.activeConductorView) })),

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
			const activeConductorView =
				s.activeConductorView?.scope === 'workspace' &&
				!groupIds.has(s.activeConductorView.groupId)
					? null
					: s.activeConductorView;

			const conductorsUnchanged =
				conductors.length === s.conductors.length &&
				conductors.every((conductor, index) => conductor === s.conductors[index]);
			const tasksUnchanged =
				tasks.length === s.tasks.length && tasks.every((task, index) => task === s.tasks[index]);
			const runsUnchanged =
				runs.length === s.runs.length && runs.every((run, index) => run === s.runs[index]);
			const activeUnchanged = activeConductorView === s.activeConductorView;

			if (conductorsUnchanged && tasksUnchanged && runsUnchanged && activeUnchanged) {
				return s;
			}

			return { conductors, tasks, runs, activeConductorView };
		}),

	setConductor: (groupId, updates) =>
		set((s) => ({
			conductors: s.conductors.map((conductor) =>
				conductor.groupId === groupId
					? {
							...conductor,
							...updates,
							updatedAt: Date.now(),
						}
					: conductor
			),
		})),

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
						? {
								...conductor,
								status: conductor.status === 'needs_setup' ? 'idle' : conductor.status,
								updatedAt: now,
							}
						: conductor
				),
			};
		}),

	updateTask: (taskId, updates) =>
		set((s) => ({
			tasks: s.tasks.map((task) =>
				task.id === taskId ? { ...task, ...updates, updatedAt: Date.now() } : task
			),
		})),

	deleteTask: (taskId) =>
		set((s) => ({
			tasks: s.tasks.filter((task) => task.id !== taskId),
		})),

	replacePlannerTasks: (groupId, nextTasks) =>
		set((s) => ({
			tasks: [
				// Only replace unapproved planner drafts for this workspace.
				// Preserving non-draft planner tasks keeps completed/stopped history on the board.
				...s.tasks.filter(
					(task) =>
						!(
							task.groupId === groupId &&
							task.source === 'planner' &&
							task.status === 'draft'
						)
				),
				...nextTasks,
			],
		})),

	upsertRun: (run) =>
		set((s) => ({
			runs: s.runs.some((candidate) => candidate.id === run.id)
				? s.runs.map((candidate) => (candidate.id === run.id ? run : candidate))
				: [run, ...s.runs],
		})),

	updateRun: (runId, updates) =>
		set((s) => ({
			runs: s.runs.map((run) =>
				run.id === runId
					? {
							...run,
							...updates,
						}
					: run
			),
		})),
}));
