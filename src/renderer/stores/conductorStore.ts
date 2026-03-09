import { create } from 'zustand';
import type {
	Conductor,
	ConductorTask,
	ConductorRun,
	ConductorTaskPriority,
	ConductorTaskStatus,
	Group,
} from '../types';
import { generateId } from '../utils/ids';

interface ConductorStoreState {
	conductors: Conductor[];
	tasks: ConductorTask[];
	runs: ConductorRun[];
	activeConductorGroupId: string | null;
}

interface ConductorStoreActions {
	setConductors: (v: Conductor[] | ((prev: Conductor[]) => Conductor[])) => void;
	setTasks: (v: ConductorTask[] | ((prev: ConductorTask[]) => ConductorTask[])) => void;
	setRuns: (v: ConductorRun[] | ((prev: ConductorRun[]) => ConductorRun[])) => void;
	setActiveConductorGroupId: (v: string | null | ((prev: string | null) => string | null)) => void;
	syncWithGroups: (groups: Group[]) => void;
	setConductor: (groupId: string, updates: Partial<Conductor>) => void;
	setTemplateSession: (groupId: string, sessionId: string) => void;
	addTask: (
		groupId: string,
		input: {
			title: string;
			description?: string;
			priority?: ConductorTaskPriority;
			status?: ConductorTaskStatus;
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

function buildConductor(groupId: string, existing?: Partial<Conductor>): Conductor {
	const now = Date.now();
	return {
		groupId,
		templateSessionId: null,
		status: 'needs_setup',
		resourceProfile: 'balanced',
		autoExecuteOnPlanCreation: false,
		publishPolicy: 'manual_pr',
		deleteWorkerBranchesOnSuccess: false,
		createdAt: existing?.createdAt ?? now,
		updatedAt: existing?.updatedAt ?? now,
		...existing,
	};
}

function sameConductor(left: Conductor, right: Conductor): boolean {
	return (
		left.groupId === right.groupId &&
		left.templateSessionId === right.templateSessionId &&
		left.status === right.status &&
		left.resourceProfile === right.resourceProfile &&
		left.autoExecuteOnPlanCreation === right.autoExecuteOnPlanCreation &&
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
	activeConductorGroupId: null,

	setConductors: (v) => set((s) => ({ conductors: resolve(v, s.conductors) })),
	setTasks: (v) => set((s) => ({ tasks: resolve(v, s.tasks) })),
	setRuns: (v) => set((s) => ({ runs: resolve(v, s.runs) })),
	setActiveConductorGroupId: (v) =>
		set((s) => ({ activeConductorGroupId: resolve(v, s.activeConductorGroupId) })),

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
			const activeConductorGroupId =
				s.activeConductorGroupId && groupIds.has(s.activeConductorGroupId)
					? s.activeConductorGroupId
					: null;

			const conductorsUnchanged =
				conductors.length === s.conductors.length &&
				conductors.every((conductor, index) => conductor === s.conductors[index]);
			const tasksUnchanged =
				tasks.length === s.tasks.length && tasks.every((task, index) => task === s.tasks[index]);
			const runsUnchanged =
				runs.length === s.runs.length && runs.every((run, index) => run === s.runs[index]);
			const activeUnchanged = activeConductorGroupId === s.activeConductorGroupId;

			if (conductorsUnchanged && tasksUnchanged && runsUnchanged && activeUnchanged) {
				return s;
			}

			return { conductors, tasks, runs, activeConductorGroupId };
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

	setTemplateSession: (groupId, sessionId) =>
		set((s) => ({
			conductors: s.conductors.map((conductor) =>
				conductor.groupId === groupId
					? {
							...conductor,
							templateSessionId: sessionId,
							status: 'idle',
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
				title: input.title.trim(),
				description: input.description?.trim() || '',
				acceptanceCriteria: [],
				priority: input.priority || 'medium',
				status: input.status || 'draft',
				dependsOn: [],
				scopePaths: [],
				source: 'manual',
				createdAt: now,
				updatedAt: now,
			};
			return {
				tasks: [...s.tasks, task],
				conductors: s.conductors.map((conductor) =>
					conductor.groupId === groupId
						? {
								...conductor,
								status: conductor.templateSessionId ? 'idle' : 'needs_setup',
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
				...s.tasks.filter((task) => !(task.groupId === groupId && task.source === 'planner')),
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
