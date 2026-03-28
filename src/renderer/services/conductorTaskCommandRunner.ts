import type { DemoDetail, DemoCard } from '../../shared/demo-artifacts';
import type { ConductorRun, ConductorTask, Session } from '../types';
import { ConductorAgentRunError } from './conductorAgentRuntime';
import {
	buildConductorProofCaptureFailurePatch,
	buildConductorProofCaptureStartPatch,
	buildConductorProofCaptureSuccessPatch,
	buildConductorTaskCancelledRunUpdate,
	getActiveConductorTaskSessionId,
	getConductorTaskProcessSessionIds,
	getConductorTaskProofRequirement,
	resolveConductorProofExecutionContext,
} from './conductorTaskRuntime';

export async function stopConductorTaskCommand(input: {
	task: ConductorTask;
	groupId: string;
	sessionById: Map<string, Pick<Session, 'id' | 'activeTabId' | 'state'>>;
	cancelTask: (taskId: string) => void;
	getLatestRunForTask: (taskId: string) => ConductorRun | null;
	updateRun: (runId: string, updates: Partial<ConductorRun>) => void;
	killProcess: (processSessionId: string) => Promise<boolean>;
	generateEventId: () => string;
}): Promise<{
	toastType: 'success' | 'warning';
	toastTitle: string;
	toastMessage: string;
}> {
	const sessionId = getActiveConductorTaskSessionId(input.task, input.sessionById);
	if (!sessionId) {
		return {
			toastType: 'warning',
			toastTitle: 'Nothing To Stop',
			toastMessage: `${input.task.title} does not have an active Conductor helper right now.`,
		};
	}

	input.cancelTask(input.task.id);

	let stopped = false;
	for (const processSessionId of getConductorTaskProcessSessionIds(sessionId, input.sessionById)) {
		try {
			const killed = await input.killProcess(processSessionId);
			if (killed) {
				stopped = true;
				break;
			}
		} catch {
			// Fall through to the next known process identifier.
		}
	}

	const latestRunForTask = input.getLatestRunForTask(input.task.id);
	if (latestRunForTask) {
		input.updateRun(
			latestRunForTask.id,
			buildConductorTaskCancelledRunUpdate({
				run: latestRunForTask,
				groupId: input.groupId,
				taskTitle: input.task.title,
				generateEventId: input.generateEventId,
			})
		);
	}

	return {
		toastType: stopped ? 'success' : 'warning',
		toastTitle: stopped ? 'Task Stopped' : 'Stop Requested',
		toastMessage: stopped
			? `${input.task.title} has been stopped.`
			: `Marked ${input.task.title} as stopped, but the helper did not confirm the kill.`,
	};
}

export async function captureConductorTaskProofCommand(input: {
	task: ConductorTask;
	selectedTemplate: Session;
	getLatestExecutionForTask: (taskId: string) => ConductorRun | null;
	isDirectory: (path: string) => Promise<boolean>;
	satisfiesRequirement: (
		demoCard: DemoCard,
		proofRequirement: ReturnType<typeof getConductorTaskProofRequirement>
	) => boolean;
	runProofTurn: (options: {
		task: ConductorTask;
		cwd: string;
		branch: string | null;
		proofRequirement: ReturnType<typeof getConductorTaskProofRequirement>;
	}) => Promise<{ demoCard?: DemoCard }>;
	getDemo: (demoId: string) => Promise<DemoDetail | null>;
	patchTask: (patch: Partial<ConductorTask>) => void;
}): Promise<
	| {
			status: 'success';
			demoDetail?: DemoDetail;
			toastTitle: string;
			toastMessage: string;
	  }
	| {
			status: 'failure';
			demoDetail?: DemoDetail;
			toastTitle: string;
			toastMessage: string;
	  }
> {
	const now = Date.now();
	const proofRequirement = getConductorTaskProofRequirement(input.task, now);
	const context = await resolveConductorProofExecutionContext({
		task: input.task,
		latestTaskExecution: input.getLatestExecutionForTask(input.task.id),
		selectedTemplate: input.selectedTemplate,
		isDirectory: input.isDirectory,
	});

	input.patchTask(buildConductorProofCaptureStartPatch(input.task, now));

	try {
		const proofResult = await input.runProofTurn({
			task: input.task,
			cwd: context.cwd,
			branch: context.branch,
			proofRequirement,
		});

		if (
			!proofResult.demoCard ||
			!input.satisfiesRequirement(proofResult.demoCard, proofRequirement)
		) {
			throw new ConductorAgentRunError(
				'Proof capture finished without the required recording and screenshots.',
				{
					demoCard: proofResult.demoCard,
				}
			);
		}

		const capturedAt = Date.now();
		input.patchTask(
			buildConductorProofCaptureSuccessPatch({
				task: input.task,
				demoCard: proofResult.demoCard,
				now: capturedAt,
			})
		);
		const persistedDemo = await input.getDemo(proofResult.demoCard.demoId);
		return {
			status: 'success',
			demoDetail: persistedDemo || undefined,
			toastTitle: 'Proof Captured',
			toastMessage: `Captured completion proof for ${input.task.title}.`,
		};
	} catch (error) {
		const failedDemo = error instanceof ConductorAgentRunError ? error.demoCard : undefined;
		input.patchTask(
			buildConductorProofCaptureFailurePatch({
				task: input.task,
				failedDemo,
				now: Date.now(),
			})
		);
		const previousProof = input.task.completionProof;
		const hadExistingApprovedProof =
			Boolean(previousProof?.demoId) &&
			(previousProof?.status === 'captured' || previousProof?.status === 'approved');
		const demoDetail =
			failedDemo && !hadExistingApprovedProof ? await input.getDemo(failedDemo.demoId) : undefined;
		return {
			status: 'failure',
			demoDetail: demoDetail || undefined,
			toastTitle: 'Proof Capture Failed',
			toastMessage: error instanceof Error ? error.message : 'Proof capture did not complete.',
		};
	}
}
