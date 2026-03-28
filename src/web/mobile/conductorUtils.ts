import type {
	Group,
	Conductor,
	ConductorTask,
	ConductorTaskStatus,
	ConductorTaskPriority,
	ConductorRun,
} from '../../shared/types';
import {
	buildConductorChildTaskMap,
	formatConductorOperatorMessage,
	getConductorTaskQaFailureState,
	getEffectiveConductorTaskAttentionRequest,
	getConductorTaskOpenFollowUps,
	getConductorTaskRollupStatus,
	getTopLevelConductorTasks,
} from '../../shared/conductorTasks';
import {
	BOARD_COLUMNS,
	FRIENDLY_TASK_STATUS_LABELS,
	KANBAN_LANES,
} from '../../renderer/components/conductor/conductorConstants';
import type { KanbanLane } from '../../renderer/components/conductor/conductorConstants';
import { PASTEL_STATUS_TONES } from '../../renderer/components/conductor/conductorStyles';

// ── Re-export shared constants so existing consumers keep working ────
export { KANBAN_LANES, PASTEL_STATUS_TONES };
export type { KanbanLane };

export const MOBILE_CONDUCTOR_COLUMNS: ConductorTaskStatus[] = BOARD_COLUMNS;
export const MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS = { allowLegacyFallback: false } as const;

export const MOBILE_CONDUCTOR_STATUS_LABELS: Record<ConductorTaskStatus, string> =
	FRIENDLY_TASK_STATUS_LABELS;

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
	tasks: ConductorTask[],
	runs: ConductorRun[] = []
): Record<ConductorTaskStatus, ConductorTask[]> {
	const grouped = Object.fromEntries(
		MOBILE_CONDUCTOR_COLUMNS.map((status) => [status, [] as ConductorTask[]])
	) as Record<ConductorTaskStatus, ConductorTask[]>;
	const childTaskMap = buildConductorChildTaskMap(tasks);

	for (const task of sortConductorTasks(getTopLevelConductorTasks(tasks))) {
		grouped[
			getConductorTaskRollupStatus(
				task,
				childTaskMap,
				runs,
				MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS
			)
		].push(task);
	}

	return grouped;
}

export interface LaneGroup {
	lane: KanbanLane;
	tasks: ConductorTask[];
	statusCounts: Record<string, number>;
}

export function groupTasksByLane(tasks: ConductorTask[], runs: ConductorRun[] = []): LaneGroup[] {
	const byStatus = groupTasksByStatus(tasks, runs);
	return KANBAN_LANES.map((lane) => {
		const laneTasks = lane.statuses.flatMap((status) => byStatus[status] || []);
		const statusCounts: Record<string, number> = {};
		for (const status of lane.statuses) {
			const count = (byStatus[status] || []).length;
			if (count > 0) {
				statusCounts[status] = count;
			}
		}
		return { lane, tasks: laneTasks, statusCounts };
	});
}

export function buildConductorMetrics(
	tasks: ConductorTask[],
	runs: ConductorRun[] = []
): MobileConductorMetrics {
	const childTaskMap = buildConductorChildTaskMap(tasks);
	const topLevelTasks = getTopLevelConductorTasks(tasks);
	const rolledUpStatuses = topLevelTasks.map((task) =>
		getConductorTaskRollupStatus(task, childTaskMap, runs, MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS)
	);
	return {
		total: topLevelTasks.length,
		open: rolledUpStatuses.filter((status) => status !== 'done' && status !== 'cancelled').length,
		running: rolledUpStatuses.filter((status) => status === 'running' || status === 'planning')
			.length,
		attention: rolledUpStatuses.filter((status) =>
			['needs_input', 'needs_proof', 'needs_revision', 'blocked', 'needs_review'].includes(status)
		).length,
		done: rolledUpStatuses.filter((status) => status === 'done').length,
	};
}

export function buildWorkspaceSummaries(
	groups: Group[],
	tasks: ConductorTask[],
	runs: ConductorRun[] = []
): MobileConductorWorkspaceSummary[] {
	return groups
		.map((group) => {
			const groupTasks = sortConductorTasks(
				getTopLevelConductorTasks(tasks.filter((task) => task.groupId === group.id))
			);
			const childTaskMap = buildConductorChildTaskMap(
				tasks.filter((task) => task.groupId === group.id)
			);
			const rolledUpStatuses = groupTasks.map((task) =>
				getConductorTaskRollupStatus(
					task,
					childTaskMap,
					runs,
					MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS
				)
			);
			return {
				group,
				tasks: groupTasks,
				openCount: rolledUpStatuses.filter((status) => status !== 'done' && status !== 'cancelled')
					.length,
				runningCount: rolledUpStatuses.filter(
					(status) => status === 'running' || status === 'planning'
				).length,
				attentionCount: rolledUpStatuses.filter((status) =>
					['needs_input', 'needs_proof', 'needs_revision', 'blocked', 'needs_review'].includes(
						status
					)
				).length,
				doneCount: rolledUpStatuses.filter((status) => status === 'done').length,
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

export function buildConductorHoldReason(
	conductor: Conductor | null,
	tasks: ConductorTask[],
	runs: ConductorRun[]
): string | null {
	if (!conductor) {
		return null;
	}

	if (conductor.holdReason?.trim()) {
		return formatConductorOperatorMessage(conductor.holdReason);
	}

	if (conductor.isPaused) {
		return 'Paused by you.';
	}

	const latestRun = runs.find((run) => run.groupId === conductor.groupId) || null;
	const childTaskMap = buildConductorChildTaskMap(tasks);
	const revisionEntry = tasks.find(
		(task) =>
			getConductorTaskRollupStatus(
				task,
				childTaskMap,
				runs,
				MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS
			) === 'needs_revision'
	);
	if (revisionEntry) {
		const followUpTasks = getConductorTaskOpenFollowUps(revisionEntry, childTaskMap);
		if (followUpTasks.length > 0) {
			return `${revisionEntry.title}: ${followUpTasks[0].title}`;
		}
		return `${revisionEntry.title}: agents are revising reviewer feedback.`;
	}
	const qaBlockedEntry = tasks.find(
		(task) => getConductorTaskQaFailureState(task, runs).isQuarantined
	);
	if (qaBlockedEntry) {
		const qaFailureState = getConductorTaskQaFailureState(qaBlockedEntry, runs);
		return `${qaBlockedEntry.title}: QA is paused after ${qaFailureState.malformedFailureCount} malformed reviewer response${qaFailureState.malformedFailureCount === 1 ? '' : 's'}.`;
	}
	const openAttentionEntry = tasks
		.map((task) => ({
			task,
			attentionRequest: getEffectiveConductorTaskAttentionRequest(
				task,
				runs,
				MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS
			),
		}))
		.find(({ attentionRequest }) => attentionRequest?.status === 'open');

	if (openAttentionEntry?.attentionRequest?.status === 'open') {
		const followUpTasks = getConductorTaskOpenFollowUps(openAttentionEntry.task, childTaskMap);
		if (followUpTasks.length > 0) {
			return `${openAttentionEntry.task.title}: ${followUpTasks[0].title}`;
		}
		return formatConductorOperatorMessage(openAttentionEntry.attentionRequest.requestedAction);
	}

	if (
		latestRun?.summary &&
		(conductor.status === 'blocked' || conductor.status === 'attention_required')
	) {
		return formatConductorOperatorMessage(latestRun.summary);
	}

	return null;
}
