import type {
	Group,
	ConductorTask,
	ConductorTaskStatus,
	ConductorTaskPriority,
} from '../../shared/types';

export const MOBILE_CONDUCTOR_COLUMNS: ConductorTaskStatus[] = [
	'draft',
	'planning',
	'ready',
	'running',
	'needs_input',
	'blocked',
	'needs_review',
	'cancelled',
	'done',
];

export const MOBILE_CONDUCTOR_STATUS_LABELS: Record<ConductorTaskStatus, string> = {
	draft: 'Brainstorm',
	planning: 'Planning',
	ready: 'Ready',
	running: 'In progress',
	needs_input: 'Needs input',
	blocked: 'Blocked',
	needs_review: 'Check me',
	cancelled: 'Stopped',
	done: 'Done',
};

export const MOBILE_CONDUCTOR_PRIORITY_LABELS: Record<ConductorTaskPriority, string> = {
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	critical: 'Critical',
};

const PRIORITY_RANK: Record<ConductorTaskPriority, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

export interface MobileConductorWorkspaceSummary {
	group: Group;
	tasks: ConductorTask[];
	openCount: number;
	runningCount: number;
	attentionCount: number;
	doneCount: number;
}

export interface MobileConductorMetrics {
	total: number;
	open: number;
	running: number;
	attention: number;
	done: number;
}

export function sortConductorTasks(tasks: ConductorTask[]): ConductorTask[] {
	return [...tasks].sort((left, right) => {
		const priorityDiff = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
		if (priorityDiff !== 0) {
			return priorityDiff;
		}

		return right.updatedAt - left.updatedAt || left.title.localeCompare(right.title);
	});
}

export function groupTasksByStatus(
	tasks: ConductorTask[]
): Record<ConductorTaskStatus, ConductorTask[]> {
	const grouped = Object.fromEntries(
		MOBILE_CONDUCTOR_COLUMNS.map((status) => [status, [] as ConductorTask[]])
	) as Record<ConductorTaskStatus, ConductorTask[]>;

	for (const task of sortConductorTasks(tasks)) {
		grouped[task.status].push(task);
	}

	return grouped;
}

export function buildConductorMetrics(tasks: ConductorTask[]): MobileConductorMetrics {
	return {
		total: tasks.length,
		open: tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled').length,
		running: tasks.filter((task) => task.status === 'running' || task.status === 'planning').length,
		attention: tasks.filter((task) =>
			['needs_input', 'blocked', 'needs_review'].includes(task.status)
		).length,
		done: tasks.filter((task) => task.status === 'done').length,
	};
}

export function buildWorkspaceSummaries(
	groups: Group[],
	tasks: ConductorTask[]
): MobileConductorWorkspaceSummary[] {
	return groups
		.map((group) => {
			const groupTasks = sortConductorTasks(tasks.filter((task) => task.groupId === group.id));
			return {
				group,
				tasks: groupTasks,
				openCount: groupTasks.filter(
					(task) => task.status !== 'done' && task.status !== 'cancelled'
				).length,
				runningCount: groupTasks.filter(
					(task) => task.status === 'running' || task.status === 'planning'
				).length,
				attentionCount: groupTasks.filter((task) =>
					['needs_input', 'blocked', 'needs_review'].includes(task.status)
				).length,
				doneCount: groupTasks.filter((task) => task.status === 'done').length,
			};
		})
		.filter((summary) => summary.tasks.length > 0)
		.sort((left, right) => {
			return (
				right.runningCount - left.runningCount ||
				right.openCount - left.openCount ||
				left.group.name.localeCompare(right.group.name)
			);
		});
}
