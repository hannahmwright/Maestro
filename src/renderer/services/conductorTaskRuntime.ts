import type { Session, ConductorRun, ConductorTask } from '../types';
import type { DemoCard } from '../../shared/demo-artifacts';
import {
	buildDefaultConductorTaskCompletionProof,
	buildDefaultConductorTaskCompletionProofRequirement,
} from '../../shared/conductorTasks';

export function getActiveConductorTaskSessionId(
	task: ConductorTask,
	sessionById: Map<string, Pick<Session, 'id' | 'state'>>
): string | null {
	if (task.status === 'planning') {
		return task.plannerSessionId || null;
	}
	if (task.status === 'running') {
		return task.workerSessionId || null;
	}
	if (task.status === 'needs_review') {
		const reviewerSession = task.reviewerSessionId
			? sessionById.get(task.reviewerSessionId)
			: null;
		if (reviewerSession?.state === 'busy') {
			return reviewerSession.id;
		}
	}

	return null;
}

export function getConductorTaskProcessSessionIds(
	sessionId: string,
	sessionById: Map<string, Pick<Session, 'activeTabId'>>
): string[] {
	const session = sessionById.get(sessionId);
	const ids = new Set<string>();
	if (session?.activeTabId) {
		ids.add(`${sessionId}-ai-${session.activeTabId}`);
	}
	ids.add(`${sessionId}-ai`);
	return [...ids];
}

export function buildConductorTaskCancelledRunUpdate(input: {
	run: ConductorRun;
	groupId: string;
	taskTitle: string;
	createdAt?: number;
	generateEventId: () => string;
}): Partial<ConductorRun> {
	const createdAt = input.createdAt ?? Date.now();
	return {
		events: [
			...input.run.events,
			{
				id: input.generateEventId(),
				runId: input.run.id,
				groupId: input.groupId,
				type: 'task_cancelled',
				message: `Manager stopped ${input.taskTitle}.`,
				createdAt,
			},
		],
	};
}

export async function resolveConductorProofExecutionContext(input: {
	task: ConductorTask;
	latestTaskExecution: ConductorRun | null;
	selectedTemplate: Pick<Session, 'cwd'> | null;
	isDirectory: (path: string) => Promise<boolean>;
}): Promise<{ cwd: string; branch: string | null }> {
	const candidateContexts = [
		{
			cwd: input.latestTaskExecution?.taskWorktreePaths?.[input.task.id] || null,
			branch: input.latestTaskExecution?.taskBranches?.[input.task.id] || null,
		},
		{
			cwd: input.latestTaskExecution?.worktreePath || null,
			branch: input.latestTaskExecution?.branchName || null,
		},
		{
			cwd: input.selectedTemplate?.cwd || null,
			branch: null,
		},
	];

	for (const candidate of candidateContexts) {
		if (!candidate.cwd) {
			continue;
		}

		try {
			if (await input.isDirectory(candidate.cwd)) {
				return {
					cwd: candidate.cwd,
					branch: candidate.branch,
				};
			}
		} catch {
			// Fall through to the next candidate path.
		}
	}

	return {
		cwd: input.selectedTemplate?.cwd || input.task.scopePaths[0] || '',
		branch: null,
	};
}

export function buildConductorProofCaptureStartPatch(task: ConductorTask, now = Date.now()): Pick<
	ConductorTask,
	'status' | 'completionProof'
> {
	const previousProof = task.completionProof || buildDefaultConductorTaskCompletionProof(now);
	const requestedAt = previousProof.requestedAt || now;
	return {
		status: 'needs_proof',
		completionProof: {
			...previousProof,
			status: 'capturing',
			requestedAt,
			approvedAt: undefined,
			rejectedAt: undefined,
		},
	};
}

export function buildConductorProofCaptureSuccessPatch(input: {
	task: ConductorTask;
	demoCard: DemoCard;
	now?: number;
}): Pick<ConductorTask, 'status' | 'completionProof'> {
	const now = input.now ?? Date.now();
	const previousProof = input.task.completionProof || buildDefaultConductorTaskCompletionProof(now);
	const requestedAt = previousProof.requestedAt || now;
	return {
		status: 'needs_proof',
		completionProof: {
			...previousProof,
			status: 'captured',
			demoId: input.demoCard.demoId,
			captureRunId: input.demoCard.captureRunId,
			screenshotCount: input.demoCard.stepCount,
			videoArtifactId: input.demoCard.videoArtifact?.id,
			requestedAt,
			capturedAt: now,
			approvedAt: undefined,
			rejectedAt: undefined,
		},
	};
}

export function buildConductorProofCaptureFailurePatch(input: {
	task: ConductorTask;
	failedDemo?: DemoCard;
	now?: number;
}): Pick<ConductorTask, 'status' | 'completionProof'> {
	const now = input.now ?? Date.now();
	const previousProof = input.task.completionProof || buildDefaultConductorTaskCompletionProof(now);
	const requestedAt = previousProof.requestedAt || now;
	const hadExistingApprovedProof =
		previousProof.demoId &&
		(previousProof.status === 'captured' || previousProof.status === 'approved');

	if (hadExistingApprovedProof) {
		return {
			status: 'needs_proof',
			completionProof: previousProof,
		};
	}

	if (input.failedDemo) {
		return {
			status: 'needs_proof',
			completionProof: {
				...previousProof,
				status: 'rejected',
				demoId: input.failedDemo.demoId,
				captureRunId: input.failedDemo.captureRunId,
				screenshotCount: input.failedDemo.stepCount,
				videoArtifactId: input.failedDemo.videoArtifact?.id,
				requestedAt,
				capturedAt: undefined,
				approvedAt: undefined,
				rejectedAt: now,
			},
		};
	}

	return {
		status: 'needs_proof',
		completionProof: {
			...previousProof,
			status: previousProof.status === 'capturing' ? 'missing' : previousProof.status,
			requestedAt,
			approvedAt: previousProof.status === 'approved' ? previousProof.approvedAt : undefined,
			rejectedAt: previousProof.status === 'rejected' ? previousProof.rejectedAt : undefined,
		},
	};
}

export function getConductorTaskProofRequirement(task: ConductorTask, now = Date.now()) {
	return (
		task.completionProofRequirement || buildDefaultConductorTaskCompletionProofRequirement()
	);
}
