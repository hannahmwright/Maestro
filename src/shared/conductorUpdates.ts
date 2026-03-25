import type { ConductorRun, ConductorRunEvent, ConductorTask } from './types';
import { formatConductorOperatorMessage } from './conductorTasks';

export type ConductorOrchestratorUpdateTone = 'progress' | 'success' | 'warning' | 'default';

export interface ConductorOrchestratorUpdate {
	id: string;
	tone: ConductorOrchestratorUpdateTone;
	badge: string;
	summary: string;
	detail?: string;
	taskId?: string;
	taskTitle?: string;
	createdAt: number;
	isHistorical: boolean;
}

function isTaskScopedEvent(eventType: ConductorRunEvent['type']): boolean {
	return [
		'task_started',
		'task_completed',
		'task_needs_revision',
		'task_needs_input',
		'task_needs_proof',
		'task_blocked',
		'task_cancelled',
		'review_passed',
		'review_failed',
	].includes(eventType);
}

function resolveEventTask(
	run: ConductorRun,
	event: ConductorRunEvent,
	tasksById: Map<string, ConductorTask>
): ConductorTask | null {
	const relatedTasks = run.taskIds
		.map((taskId) => tasksById.get(taskId))
		.filter((task): task is ConductorTask => Boolean(task));

	const titleMatches = relatedTasks
		.filter((task) => event.message.includes(task.title))
		.sort((left, right) => right.title.length - left.title.length);
	if (titleMatches.length > 0) {
		return titleMatches[0];
	}

	if (isTaskScopedEvent(event.type) && relatedTasks.length === 1) {
		return relatedTasks[0];
	}

	return null;
}

function getUpdateTone(eventType: ConductorRunEvent['type']): ConductorOrchestratorUpdateTone {
	switch (eventType) {
		case 'task_completed':
		case 'review_passed':
		case 'integration_completed':
		case 'validation_passed':
		case 'cleanup_completed':
		case 'pr_created':
			return 'success';
		case 'task_needs_input':
		case 'task_needs_proof':
		case 'task_needs_revision':
		case 'task_blocked':
		case 'planning_failed':
		case 'execution_failed':
		case 'review_failed':
		case 'integration_conflict':
		case 'validation_failed':
			return 'warning';
		case 'planning_started':
		case 'plan_generated':
		case 'plan_approved':
		case 'execution_started':
		case 'task_started':
		case 'review_started':
		case 'integration_started':
		case 'validation_started':
			return 'progress';
		default:
			return 'default';
	}
}

function buildSummary(
	event: ConductorRunEvent,
	taskTitle?: string
): { badge: string; summary: string; detail?: string } {
	const detail = formatConductorOperatorMessage(event.message);
	switch (event.type) {
		case 'planning_started':
			return { badge: 'Planning', summary: 'Started building a plan.' };
		case 'plan_generated':
			return {
				badge: 'Planning',
				summary: 'Prepared a plan for review.',
				detail,
			};
		case 'plan_approved':
			return { badge: 'Planning', summary: 'Plan approved and ready to run.' };
		case 'planning_failed':
			return {
				badge: 'Needs attention',
				summary: 'Planner could not produce a clean planning update.',
				detail,
			};
		case 'execution_started':
			return { badge: 'Progress', summary: 'Started working through the next tasks.', detail };
		case 'task_started':
			return { badge: 'Assigned', summary: 'Assigned to a teammate.', detail: taskTitle ? undefined : detail };
		case 'task_completed':
			return { badge: 'Progress', summary: 'Moved to QA.', detail: taskTitle ? undefined : detail };
		case 'task_needs_revision':
			return { badge: 'Revision', summary: 'Sent back to agents for another pass.', detail };
		case 'task_needs_input':
			return { badge: 'Needs you', summary: 'Waiting on your guidance.', detail };
		case 'task_needs_proof':
			return { badge: 'Proof', summary: 'Waiting on proof of completion.', detail };
		case 'task_blocked':
			return { badge: 'Blocked', summary: 'Blocked.', detail };
		case 'task_cancelled':
			return { badge: 'Stopped', summary: 'Stopped.', detail: taskTitle ? undefined : detail };
		case 'execution_completed':
			return { badge: 'Progress', summary: 'Finished the current execution pass.', detail };
		case 'execution_failed':
			return {
				badge: 'Needs attention',
				summary: 'A helper run needs attention.',
				detail,
			};
		case 'review_started':
			return { badge: 'QA', summary: 'QA started.', detail };
		case 'review_passed':
			return { badge: 'Completed', summary: 'Passed QA.' };
		case 'review_failed':
			return {
				badge: 'QA',
				summary: 'QA helper could not produce a clean review update.',
				detail,
			};
		case 'integration_started':
			return { badge: 'Integration', summary: 'Started pulling finished work together.' };
		case 'branch_merged':
			return { badge: 'Integration', summary: 'Merged one completed branch.' };
		case 'integration_conflict':
			return { badge: 'Blocked', summary: 'Integration hit a merge conflict.', detail };
		case 'integration_completed':
			return { badge: 'Success', summary: 'Pulled finished work together.' };
		case 'validation_started':
			return { badge: 'Validation', summary: 'Running validation.', detail };
		case 'validation_passed':
			return { badge: 'Validation', summary: 'Validation passed.' };
		case 'validation_failed':
			return { badge: 'Validation', summary: 'Validation failed.', detail };
		case 'cleanup_completed':
			return { badge: 'Cleanup', summary: 'Cleaned up helper workspaces.', detail: taskTitle ? undefined : detail };
		case 'pr_created':
			return { badge: 'PR', summary: 'Opened a PR.', detail };
		default:
			return { badge: 'Update', summary: detail };
	}
}

function shouldKeepUpdateDetail(
	update: Pick<ConductorOrchestratorUpdate, 'isHistorical' | 'detail' | 'tone'>
): boolean {
	if (!update.detail) {
		return false;
	}

	if (update.isHistorical) {
		return update.detail.length <= 140;
	}

	if (update.tone === 'warning' && update.detail.length > 180) {
		return false;
	}

	return true;
}

export function buildConductorOrchestratorUpdates(input: {
	runs: ConductorRun[];
	tasksById: Map<string, ConductorTask>;
	runIsLiveById: Map<string, boolean>;
	limit?: number;
}): ConductorOrchestratorUpdate[] {
	const limit = input.limit ?? 6;
	return [...input.runs]
		.flatMap((run) =>
			run.events.map((event) => {
				const task = resolveEventTask(run, event, input.tasksById);
				const summary = buildSummary(event, task?.title);
				const isHistorical = Boolean(run.endedAt) && !input.runIsLiveById.get(run.id);
				const detail = shouldKeepUpdateDetail({
					isHistorical,
					detail: summary.detail,
					tone: getUpdateTone(event.type),
				})
					? summary.detail
					: undefined;
				return {
					id: event.id,
					tone: getUpdateTone(event.type),
					badge: summary.badge,
					summary: summary.summary,
					detail,
					taskId: task?.id,
					taskTitle: task?.title,
					createdAt: event.createdAt,
					isHistorical,
				} satisfies ConductorOrchestratorUpdate;
			})
		)
		.sort((left, right) => {
			if (left.isHistorical !== right.isHistorical) {
				return left.isHistorical ? 1 : -1;
			}

			return right.createdAt - left.createdAt;
		})
		.slice(0, limit);
}
