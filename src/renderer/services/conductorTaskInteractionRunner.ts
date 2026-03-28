import type {
	ConductorRun,
	ConductorTask,
	Session,
} from '../types';
import type { ConductorOrchestratorAction } from '../../shared/conductorOrchestrator';
import { buildConductorProofPrompt } from './conductorProof';
import { runConductorAgentTurn } from './conductorAgentRuntime';
import {
	captureConductorTaskProofCommand,
	stopConductorTaskCommand,
} from './conductorTaskCommandRunner';
import { resolveConductorWorkspaceOrchestratorEffect } from './conductorWorkspaceControls';

export function findLatestExecutionRunForTask(
	runs: ConductorRun[],
	taskId: string
): ConductorRun | null {
	return (
		runs.find(
			(run) =>
				run.kind === 'execution' &&
				run.taskIds.includes(taskId) &&
				Boolean(run.taskWorktreePaths?.[taskId] || run.taskBranches?.[taskId])
		) || null
	);
}

export function findLatestRunForTask(runs: ConductorRun[], taskId: string): ConductorRun | null {
	return runs.find((run) => run.taskIds.includes(taskId)) || null;
}

export async function runConductorTaskProofCaptureAction(input: {
	task: ConductorTask;
	selectedTemplate: Session | null;
	groupName: string;
	capturingProofTaskId: string | null;
	requiresCompletionProof: (task: ConductorTask) => boolean;
	getLatestExecutionForTask: (taskId: string) => ConductorRun | null;
	isDirectory: (path: string) => Promise<boolean>;
	satisfiesRequirement: Parameters<typeof captureConductorTaskProofCommand>[0]['satisfiesRequirement'];
	recordTaskAgentHistory: (
		taskId: string,
		role: 'reviewer',
		sessionId: string,
		sessionName: string | undefined
	) => void;
	patchTask: (patch: Partial<ConductorTask>) => void;
	getDemo: (demoId: string) => Promise<Awaited<ReturnType<typeof window.maestro.artifacts.getDemo>>>;
}): Promise<
	| {
			status: 'noop';
	  }
	| {
			status: 'done';
			demoDetail?: Awaited<ReturnType<typeof window.maestro.artifacts.getDemo>>;
			toastType: 'success' | 'error';
			toastTitle: string;
			toastMessage: string;
	  }
> {
	if (!input.selectedTemplate) {
		return {
			status: 'done',
			toastType: 'error',
			toastTitle: 'Proof Capture Unavailable',
			toastMessage:
				'This workspace needs a top-level agent before Conductor can capture proof.',
		};
	}

	if (
		input.capturingProofTaskId === input.task.id ||
		!input.requiresCompletionProof(input.task)
	) {
		return { status: 'noop' };
	}

	const result = await captureConductorTaskProofCommand({
		task: input.task,
		selectedTemplate: input.selectedTemplate,
		getLatestExecutionForTask: input.getLatestExecutionForTask,
		isDirectory: input.isDirectory,
		satisfiesRequirement: input.satisfiesRequirement,
		runProofTurn: async ({ task: proofTask, cwd, branch }) =>
			runConductorAgentTurn({
				parentSession: input.selectedTemplate!,
				role: 'reviewer',
				taskTitle: proofTask.title,
				taskDescription: proofTask.description,
				scopePaths: proofTask.scopePaths,
				providerRouteHint: 'ui',
				prompt: buildConductorProofPrompt(
					input.groupName,
					{ ...input.selectedTemplate!, cwd },
					proofTask
				),
				cwd,
				branch,
				taskId: proofTask.id,
				readOnlyMode: false,
				demoCapture: { enabled: true },
				onSessionReady: (session) => {
					input.recordTaskAgentHistory(proofTask.id, 'reviewer', session.id, session.name);
					input.patchTask({
						reviewerSessionId: session.id,
						reviewerSessionName: session.name,
					});
				},
			}),
		getDemo: input.getDemo,
		patchTask: input.patchTask,
	});

	return {
		status: 'done',
		demoDetail: result.demoDetail,
		toastType: result.status === 'success' ? 'success' : 'error',
		toastTitle: result.toastTitle,
		toastMessage: result.toastMessage,
	};
}

export function applyConductorOrchestratorActionCommand(input: {
	action: ConductorOrchestratorAction;
	tasksById: Map<string, ConductorTask>;
	isAutoplayPaused: boolean;
	setAutoplayPaused: (nextPaused: boolean) => void;
	commitTaskSnapshots: (tasks: ConductorTask[]) => void;
	moveTaskStatus: (taskId: string, status: 'ready' | 'blocked') => void;
}):
	| {
			handled: false;
	  }
	| {
			handled: true;
			toastTitle: string;
			toastMessage: string;
	  } {
	const effect = resolveConductorWorkspaceOrchestratorEffect({
		action: input.action,
		tasksById: input.tasksById,
	});
	switch (effect.kind) {
		case 'pause_board':
			if (!input.isAutoplayPaused) {
				input.setAutoplayPaused(true);
			}
			break;
		case 'resume_board':
			if (input.isAutoplayPaused) {
				input.setAutoplayPaused(false);
			}
			break;
		case 'patch_tasks':
			input.commitTaskSnapshots(effect.tasks);
			break;
		case 'move_task_status':
			input.moveTaskStatus(effect.taskId, effect.status);
			break;
		case 'noop':
		default:
			return { handled: false };
	}

	return {
		handled: true,
		toastTitle: effect.toastTitle,
		toastMessage: effect.toastMessage,
	};
}

export async function runConductorTaskStopAction(input: Parameters<typeof stopConductorTaskCommand>[0]) {
	return stopConductorTaskCommand(input);
}
