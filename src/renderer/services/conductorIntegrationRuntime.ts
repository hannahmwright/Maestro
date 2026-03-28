import type { ConductorRun, ConductorTask } from '../types';

export function buildConductorConflictResolutionPrompt(input: {
	groupName: string;
	integrationBranch: string;
	baseBranch: string;
	worktreePath: string;
	validationCommand?: string;
}): string {
	const validationLine = input.validationCommand?.trim()
		? `After resolving the merge conflict, run \`${input.validationCommand.trim()}\` and include the result in your summary.`
		: 'After resolving the merge conflict, run `git status --short` and include the result in your summary.';

	return [
		`Resolve the current git merge conflict for the ${input.groupName} integration branch.`,
		`Work in \`${input.worktreePath}\` on branch \`${input.integrationBranch}\`, which is integrating changes back into \`${input.baseBranch}\`.`,
		'Inspect the conflicted files, resolve the conflicts carefully, and stage the resolved files when you are done.',
		validationLine,
		'Do not open a PR or start a new branch. In your final response, list the files you resolved and whether any conflicts remain.',
	].join('\n\n');
}

export function collectConductorRunArtifactPaths(run: ConductorRun | null): string[] {
	if (!run) {
		return [];
	}

	const paths = new Set<string>();
	if (run.worktreePath) {
		paths.add(run.worktreePath);
	}
	for (const path of run.worktreePaths || []) {
		if (path) {
			paths.add(path);
		}
	}
	for (const path of Object.values(run.taskWorktreePaths || {})) {
		if (path) {
			paths.add(path);
		}
	}
	return [...paths];
}

export function collectConductorWorkerBranches(run: ConductorRun | null): string[] {
	if (!run) {
		return [];
	}

	const branches = new Set<string>();
	for (const branch of run.workerBranches || []) {
		if (branch) {
			branches.add(branch);
		}
	}
	for (const branch of Object.values(run.taskBranches || {})) {
		if (branch) {
			branches.add(branch);
		}
	}
	return [...branches];
}

export function getConductorCompletedBranchSelection(input: {
	executionRun: ConductorRun | null;
	tasksById: Map<string, ConductorTask>;
}): {
	completedTaskIds: string[];
	completedBranches: string[];
} {
	const executionRun = input.executionRun;
	if (!executionRun?.taskBranches) {
		return {
			completedTaskIds: [],
			completedBranches: [],
		};
	}

	const completedTaskIds = executionRun.taskIds.filter((taskId) => {
		const task = input.tasksById.get(taskId);
		return task?.status === 'done' && Boolean(executionRun.taskBranches?.[taskId]);
	});
	const completedBranches = completedTaskIds
		.map((taskId) => executionRun.taskBranches?.[taskId])
		.filter((branch): branch is string => Boolean(branch));

	return {
		completedTaskIds,
		completedBranches,
	};
}
