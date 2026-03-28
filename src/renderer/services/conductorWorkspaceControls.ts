import type {
	Conductor,
	ConductorProviderAgent,
	ConductorProviderChoice,
	ConductorProviderRouteKey,
	ConductorResourceProfile,
	ConductorTask,
} from '../types';
import { applyConductorTaskUpdates } from '../../shared/conductorTasks';
import type { ConductorOrchestratorAction } from '../../shared/conductorOrchestrator';

export type ConductorWorkspaceSettingsAction =
	| { type: 'set_resource_profile'; value: ConductorResourceProfile }
	| { type: 'set_publish_policy'; value: 'none' | 'manual_pr' }
	| { type: 'set_validation_command'; value?: string }
	| { type: 'set_auto_execute'; value: boolean }
	| { type: 'set_delete_worker_branches_on_success'; value: boolean }
	| { type: 'set_keep_agent_sessions'; value: boolean }
	| { type: 'set_provider_primary'; routeKey: ConductorProviderRouteKey; value: ConductorProviderChoice }
	| { type: 'set_provider_fallback'; routeKey: ConductorProviderRouteKey; value: ConductorProviderAgent | null }
	| { type: 'set_pause_near_limit'; value: boolean }
	| { type: 'set_near_limit_percent'; value: number };

export function buildConductorWorkspaceSettingsPatch(
	conductor: Conductor | null | undefined,
	action: ConductorWorkspaceSettingsAction
): Partial<Conductor> {
	const providerRouting = conductor?.providerRouting;
	switch (action.type) {
		case 'set_resource_profile':
			return { resourceProfile: action.value };
		case 'set_publish_policy':
			return { publishPolicy: action.value };
		case 'set_validation_command':
			return { validationCommand: action.value };
		case 'set_auto_execute':
			return { autoExecuteOnPlanCreation: action.value };
		case 'set_delete_worker_branches_on_success':
			return { deleteWorkerBranchesOnSuccess: action.value };
		case 'set_keep_agent_sessions':
			return { keepConductorAgentSessions: action.value };
		case 'set_provider_primary':
			if (!providerRouting) {
				return {};
			}
			return {
				providerRouting: {
					...providerRouting,
					[action.routeKey]: {
						...providerRouting[action.routeKey],
						primary: action.value,
					},
				},
			};
		case 'set_provider_fallback':
			if (!providerRouting) {
				return {};
			}
			return {
				providerRouting: {
					...providerRouting,
					[action.routeKey]: {
						...providerRouting[action.routeKey],
						fallback: action.value,
					},
				},
			};
		case 'set_pause_near_limit':
			if (!providerRouting) {
				return {};
			}
			return {
				providerRouting: {
					...providerRouting,
					pauseNearLimit: action.value,
				},
			};
		case 'set_near_limit_percent':
			if (!providerRouting) {
				return {};
			}
			return {
				providerRouting: {
					...providerRouting,
					nearLimitPercent: Math.min(99, Math.max(50, action.value || 88)),
				},
			};
		default: {
			const exhaustive: never = action;
			return exhaustive;
		}
	}
}

export type ConductorWorkspaceOrchestratorEffect =
	| { kind: 'pause_board'; toastTitle: string; toastMessage: string }
	| { kind: 'resume_board'; toastTitle: string; toastMessage: string }
	| { kind: 'patch_tasks'; tasks: ConductorTask[]; toastTitle: string; toastMessage: string }
	| {
			kind: 'move_task_status';
			taskId: string;
			status: 'ready' | 'blocked';
			toastTitle: string;
			toastMessage: string;
	  }
	| { kind: 'noop' };

export function resolveConductorWorkspaceOrchestratorEffect(input: {
	action: ConductorOrchestratorAction;
	tasksById: Map<string, ConductorTask>;
}): ConductorWorkspaceOrchestratorEffect {
	const { action, tasksById } = input;
	switch (action.type) {
		case 'pause_board':
			return {
				kind: 'pause_board',
				toastTitle: 'Conductor Paused',
				toastMessage: 'New helper work is paused until you resume it.',
			};
		case 'resume_board':
			return {
				kind: 'resume_board',
				toastTitle: 'Conductor Resumed',
				toastMessage: 'Queued work can start moving again.',
			};
		case 'prioritize_task': {
			const task = tasksById.get(action.taskId);
			if (!task || task.priority === action.priority) {
				return { kind: 'noop' };
			}
			return {
				kind: 'patch_tasks',
				tasks: [applyConductorTaskUpdates(task, { priority: action.priority })],
				toastTitle: 'Priority Updated',
				toastMessage: `${task.title} is now ${action.priority} priority.`,
			};
		}
		case 'set_task_group_priority': {
			const tasks = action.taskIds
				.map((taskId) => tasksById.get(taskId))
				.filter((task): task is ConductorTask => Boolean(task))
				.filter((task) => task.priority !== action.priority)
				.map((task) => applyConductorTaskUpdates(task, { priority: action.priority }));
			if (tasks.length === 0) {
				return { kind: 'noop' };
			}
			return {
				kind: 'patch_tasks',
				tasks,
				toastTitle: 'Workstream Reprioritized',
				toastMessage: `${action.summary} Updated ${tasks.length} task${tasks.length === 1 ? '' : 's'}.`,
			};
		}
		case 'rebalance_task_groups': {
			const raiseTasks = action.raiseTaskIds
				.map((taskId) => tasksById.get(taskId))
				.filter((task): task is ConductorTask => Boolean(task))
				.filter((task) => task.priority !== action.raisePriority)
				.map((task) => applyConductorTaskUpdates(task, { priority: action.raisePriority }));
			const lowerTasks = action.lowerTaskIds
				.map((taskId) => tasksById.get(taskId))
				.filter((task): task is ConductorTask => Boolean(task))
				.filter((task) => task.priority !== action.lowerPriority)
				.map((task) => applyConductorTaskUpdates(task, { priority: action.lowerPriority }));
			const tasks = [...raiseTasks, ...lowerTasks];
			if (tasks.length === 0) {
				return { kind: 'noop' };
			}
			return {
				kind: 'patch_tasks',
				tasks,
				toastTitle: 'Priority Plan Applied',
				toastMessage: `${action.summary} Updated ${tasks.length} task${tasks.length === 1 ? '' : 's'}.`,
			};
		}
		case 'pause_task': {
			const task = tasksById.get(action.taskId);
			if (!task) {
				return { kind: 'noop' };
			}
			return {
				kind: 'move_task_status',
				taskId: task.id,
				status: 'blocked',
				toastTitle: 'Task Paused',
				toastMessage: `${task.title} is paused for now.`,
			};
		}
		case 'resume_task':
		case 'requeue_task': {
			const task = tasksById.get(action.taskId);
			if (!task) {
				return { kind: 'noop' };
			}
			return {
				kind: 'move_task_status',
				taskId: task.id,
				status: 'ready',
				toastTitle: action.type === 'resume_task' ? 'Task Resumed' : 'Task Re-Queued',
				toastMessage:
					action.type === 'resume_task'
						? `${task.title} is back in the queue.`
						: `${task.title} is ready for another agent pass.`,
			};
		}
		case 'open_task':
		case 'open_member':
		default:
			return { kind: 'noop' };
	}
}
