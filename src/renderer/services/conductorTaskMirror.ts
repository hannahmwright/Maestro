import type { ConductorTask } from '../../shared/types';

export interface ConductorTaskMirrorStoreActions {
	commitTaskSnapshot: (task: ConductorTask) => ConductorTask;
	commitTaskSnapshots: (tasks: ConductorTask[]) => ConductorTask[];
	patchTaskFromSnapshot: (
		task: ConductorTask,
		updates: Partial<ConductorTask>,
		updatedAt?: number
	) => ConductorTask;
}

export interface ConductorTaskMirror {
	get: (taskId: string) => ConductorTask | undefined;
	values: () => ConductorTask[];
	commit: (task: ConductorTask) => ConductorTask;
	patch: (
		taskId: string,
		updates: Partial<ConductorTask>,
		fallbackTask?: ConductorTask,
		updatedAt?: number
	) => ConductorTask | null;
	append: (tasks: ConductorTask[]) => void;
}

export function createConductorTaskMirror(
	initialTasks: ConductorTask[],
	actions: ConductorTaskMirrorStoreActions
): ConductorTaskMirror {
	const tasksById = new Map(initialTasks.map((task) => [task.id, task] as const));

	const commit = (task: ConductorTask) => {
		const nextTask = actions.commitTaskSnapshot(task);
		tasksById.set(nextTask.id, nextTask);
		return nextTask;
	};

	return {
		get: (taskId) => tasksById.get(taskId),
		values: () => Array.from(tasksById.values()),
		commit,
		patch: (taskId, updates, fallbackTask, updatedAt) => {
			const currentTask = tasksById.get(taskId) || fallbackTask;
			if (!currentTask) {
				return null;
			}

			return commit(actions.patchTaskFromSnapshot(currentTask, updates, updatedAt));
		},
		append: (tasks) => {
			if (tasks.length === 0) {
				return;
			}

			const nextTasks = actions.commitTaskSnapshots(tasks);
			for (const nextTask of nextTasks) {
				tasksById.set(nextTask.id, nextTask);
			}
		},
	};
}
