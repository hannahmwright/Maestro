import type {
	Conductor,
	ConductorRun,
	Session,
	GhCliStatus,
} from '../types';
import type { ConductorWorkspaceMachineEvent } from '../../shared/conductorWorkspaceMachine';
import { generateId } from '../utils/ids';
import { createConductorRunJournal } from './conductorRunJournal';
import { runConductorAgentTurn } from './conductorAgentRuntime';
import { buildConductorIntegrationTarget } from './conductorRuntime';
import {
	buildConductorConflictResolutionPrompt,
	collectConductorRunArtifactPaths,
	collectConductorWorkerBranches,
	getConductorCompletedBranchSelection,
} from './conductorIntegrationRuntime';

type GitRepoRootResult = Awaited<ReturnType<typeof window.maestro.git.getRepoRoot>>;
type GitWorktreeSetupResult = Awaited<ReturnType<typeof window.maestro.git.worktreeSetup>>;
type GitMergeResult = Awaited<ReturnType<typeof window.maestro.git.mergeBranchIntoWorktree>>;
type GitCleanupResult = Awaited<ReturnType<typeof window.maestro.git.removeWorktree>>;
type GitDeleteBranchResult = Awaited<ReturnType<typeof window.maestro.git.deleteLocalBranch>>;
type GitInitializeRepoResult = Awaited<ReturnType<typeof window.maestro.git.initializeRepo>>;
type GitCreatePrResult = Awaited<ReturnType<typeof window.maestro.git.createPR>>;

export async function bootstrapConductorGitRepoCommand(input: {
	selectedTemplate: Pick<Session, 'id' | 'cwd' | 'gitBranches'>;
	sshRemoteId?: string;
	leadCommitCount: number;
	conductorStatus?: Conductor['status'] | null;
	initializeRepo: (
		cwd: string,
		createInitialCommit: boolean,
		sshRemoteId?: string
	) => Promise<GitInitializeRepoResult>;
}): Promise<
	| {
			status: 'success';
			sessionPatch: Pick<Session, 'isGitRepo' | 'gitBranches' | 'gitRefsCacheTime'>;
			nextLeadCommitCount: number;
			shouldTransitionSetupCompleted: boolean;
			toastTitle: string;
			toastMessage: string;
	  }
	| {
			status: 'failure';
			errorMessage: string;
			toastTitle: string;
			toastMessage: string;
	  }
> {
	const result = await input.initializeRepo(
		input.selectedTemplate.cwd,
		true,
		input.sshRemoteId
	);

	if (!result.success) {
		const message = result.error || 'Failed to initialize a git repository for this workspace.';
		return {
			status: 'failure',
			errorMessage: message,
			toastTitle: 'Git Setup Failed',
			toastMessage: message,
		};
	}

	return {
		status: 'success',
		sessionPatch: {
			isGitRepo: true,
			gitBranches: result.currentBranch
				? [result.currentBranch]
				: input.selectedTemplate.gitBranches,
			gitRefsCacheTime: Date.now(),
		},
		nextLeadCommitCount: result.createdCommit ? 1 : Math.max(input.leadCommitCount || 0, 1),
		shouldTransitionSetupCompleted:
			input.conductorStatus === 'attention_required' || input.conductorStatus === 'needs_setup',
		toastTitle: 'Git Ready',
		toastMessage: result.createdCommit
			? 'Initialized the repository and created an initial commit.'
			: 'The workspace repository is ready for Conductor.',
	};
}

export async function cleanupConductorRunArtifactsCommand(input: {
	run: ConductorRun;
	selectedTemplate: Pick<Session, 'cwd'> | null;
	sshRemoteId?: string;
	deleteWorkerBranchesOnSuccess: boolean;
	getRepoRoot: (cwd: string, sshRemoteId?: string) => Promise<GitRepoRootResult>;
	removeWorktree: (
		worktreePath: string,
		force?: boolean,
		sshRemoteId?: string
	) => Promise<GitCleanupResult>;
	deleteLocalBranch: (
		cwd: string,
		branchName: string,
		force?: boolean,
		sshRemoteId?: string
	) => Promise<GitDeleteBranchResult>;
	upsertRun: (run: ConductorRun) => void;
	updateRun: (runId: string, updates: Partial<ConductorRun>) => void;
}): Promise<{
	errorMessage: string | null;
}> {
	if (!input.selectedTemplate) {
		return {
			errorMessage:
				'This workspace needs at least one top-level agent before Conductor can clean up run artifacts.',
		};
	}

	const worktreePaths = collectConductorRunArtifactPaths(input.run);
	const workerBranches = collectConductorWorkerBranches(input.run);
	if (worktreePaths.length === 0 && workerBranches.length === 0) {
		return {
			errorMessage: 'No run artifacts were recorded for cleanup.',
		};
	}

	const repoRootResult = await input.getRepoRoot(
		input.selectedTemplate.cwd,
		input.sshRemoteId
	);
	if (!repoRootResult.success || !repoRootResult.root) {
		return {
			errorMessage: repoRootResult.error || 'Cleanup requires a git repository.',
		};
	}

	const cleanupFailures: string[] = [];
	let cleanedWorktrees = 0;
	let deletedBranches = 0;

	for (const worktreePath of worktreePaths) {
		const cleanupResult = await input.removeWorktree(worktreePath, true, input.sshRemoteId);
		if (!cleanupResult.success) {
			cleanupFailures.push(`${worktreePath}: ${cleanupResult.error || 'cleanup failed'}`);
			continue;
		}
		cleanedWorktrees += 1;
	}

	if (input.deleteWorkerBranchesOnSuccess && workerBranches.length > 0) {
		for (const branchName of workerBranches) {
			const deleteResult = await input.deleteLocalBranch(
				repoRootResult.root,
				branchName,
				true,
				input.sshRemoteId
			);
			if (!deleteResult.success) {
				cleanupFailures.push(`${branchName}: ${deleteResult.error || 'branch delete failed'}`);
				continue;
			}
			deletedBranches += 1;
		}
	}

	const finishedAt = Date.now();
	const cleanupMessageParts = [
		`Cleaned ${cleanedWorktrees} worktree${cleanedWorktrees === 1 ? '' : 's'}.`,
	];
	if (input.deleteWorkerBranchesOnSuccess) {
		cleanupMessageParts.push(
			`Deleted ${deletedBranches} worker branch${deletedBranches === 1 ? '' : 'es'}.`
		);
	}
	if (cleanupFailures.length > 0) {
		cleanupMessageParts.push(
			`${cleanupFailures.length} cleanup issue${cleanupFailures.length === 1 ? '' : 's'} need attention.`
		);
	}

	const cleanupRunJournal = createConductorRunJournal(input.run, {
		upsertRun: input.upsertRun,
		updateRun: input.updateRun,
	});
	cleanupRunJournal.appendEvent(
		'cleanup_completed',
		cleanupMessageParts.join(' '),
		finishedAt
	);
	cleanupRunJournal.sync({
		status: cleanupFailures.length === 0 ? input.run.status : 'attention_required',
	});

	return {
		errorMessage: cleanupFailures.length > 0 ? cleanupFailures.join('\n') : null,
	};
}

export async function integrateConductorCompletedWorkCommand(input: {
	groupId: string;
	groupName: string;
	selectedTemplate: Pick<Session, 'cwd' | 'sessionSshRemoteConfig' | 'worktreeBranch'> | null;
	executionRun: ConductorRun | null;
	tasksById: Map<string, import('../types').ConductorTask>;
	worktreeBasePath?: string;
	validationCommand?: string;
	deleteWorkerBranchesOnSuccess: boolean;
	transitionConductor: (groupId: string, event: ConductorWorkspaceMachineEvent) => void;
	getRepoRoot: (cwd: string, sshRemoteId?: string) => Promise<GitRepoRootResult>;
	worktreeSetup: (
		mainRepoCwd: string,
		worktreePath: string,
		branchName: string,
		sshRemoteId?: string
	) => Promise<GitWorktreeSetupResult>;
	mergeBranchIntoWorktree: (
		worktreePath: string,
		branchName: string,
		sshRemoteId?: string
	) => Promise<GitMergeResult>;
	runValidationCommand: (options: {
		sessionId: string;
		command: string;
		cwd: string;
		sessionSshRemoteConfig?: Session['sessionSshRemoteConfig'];
	}) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
	removeWorktree: (
		worktreePath: string,
		force?: boolean,
		sshRemoteId?: string
	) => Promise<GitCleanupResult>;
	deleteLocalBranch: (
		cwd: string,
		branchName: string,
		force?: boolean,
		sshRemoteId?: string
	) => Promise<GitDeleteBranchResult>;
	upsertRun: (run: ConductorRun) => void;
	updateRun: (runId: string, updates: Partial<ConductorRun>) => void;
}): Promise<{
	errorMessage: string | null;
}> {
	if (!input.selectedTemplate || !input.executionRun?.taskBranches) {
		return {
			errorMessage: 'Run an execution lane before starting integration.',
		};
	}

	const { completedTaskIds, completedBranches } = getConductorCompletedBranchSelection({
		executionRun: input.executionRun,
		tasksById: input.tasksById,
	});
	if (completedBranches.length === 0) {
		return {
			errorMessage: 'No completed worker branches are available to integrate.',
		};
	}

	const sshRemoteId =
		input.selectedTemplate.sessionSshRemoteConfig?.enabled &&
		input.selectedTemplate.sessionSshRemoteConfig.remoteId
			? input.selectedTemplate.sessionSshRemoteConfig.remoteId
			: undefined;
	const repoRootResult = await input.getRepoRoot(input.selectedTemplate.cwd, sshRemoteId);
	if (!repoRootResult.success || !repoRootResult.root) {
		return {
			errorMessage: repoRootResult.error || 'Integration requires a git repository.',
		};
	}

	input.transitionConductor(input.groupId, { type: 'INTEGRATION_STARTED' });

	const repoRoot = repoRootResult.root;
	const integrationRunId = `conductor-run-${generateId()}`;
	const integrationTarget = buildConductorIntegrationTarget(
		repoRoot,
		input.groupName,
		integrationRunId,
		input.worktreeBasePath
	);
	const setupResult = await input.worktreeSetup(
		repoRoot,
		integrationTarget.worktreePath,
		integrationTarget.branchName,
		sshRemoteId
	);
	if (!setupResult.success) {
		input.transitionConductor(input.groupId, {
			type: 'INTEGRATION_RESOLVED',
			nextStatus: 'attention_required',
		});
		return {
			errorMessage: setupResult.error || 'Failed to create integration worktree.',
		};
	}

	const startedAt = Date.now();
	const integrationRunJournal = createConductorRunJournal(
		{
			id: integrationRunId,
			groupId: input.groupId,
			kind: 'integration',
			baseBranch: input.executionRun.baseBranch,
			sshRemoteId,
			branchName: integrationTarget.branchName,
			workerBranches: [...completedBranches],
			taskBranches: input.executionRun.taskBranches,
			integrationBranch: integrationTarget.branchName,
			worktreePath: integrationTarget.worktreePath,
			worktreePaths: [integrationTarget.worktreePath],
			taskWorktreePaths: input.executionRun.taskWorktreePaths,
			status: 'integrating',
			summary: `Integrating ${completedBranches.length} completed worker branch${completedBranches.length === 1 ? '' : 'es'}.`,
			taskIds: completedTaskIds,
			events: [],
			startedAt,
		},
		{ upsertRun: input.upsertRun, updateRun: input.updateRun }
	);
	integrationRunJournal.appendEvent(
		'integration_started',
		`Integration started for ${completedBranches.length} completed worker branch${completedBranches.length === 1 ? '' : 'es'}.`,
		startedAt
	);

	for (const taskId of completedTaskIds) {
		const branchName = input.executionRun.taskBranches[taskId];
		if (!branchName) {
			continue;
		}

		const mergeResult = await input.mergeBranchIntoWorktree(
			integrationTarget.worktreePath,
			branchName,
			sshRemoteId
		);
		const eventTime = Date.now();

		if (!mergeResult.success) {
			integrationRunJournal.appendEvent(
				'integration_conflict',
				mergeResult.conflicted
					? `Merge conflict while integrating ${branchName}.`
					: `Failed to integrate ${branchName}. ${mergeResult.error || ''}`.trim(),
				eventTime
			);
			integrationRunJournal.finalize({
				status: 'attention_required',
				summary: mergeResult.conflicted
					? `Integration stopped on a merge conflict in ${branchName}.`
					: mergeResult.error || `Failed to integrate ${branchName}.`,
				endedAt: eventTime,
			});
			input.transitionConductor(input.groupId, {
				type: 'INTEGRATION_RESOLVED',
				nextStatus: 'attention_required',
			});
			return {
				errorMessage: mergeResult.conflicted
					? `Merge conflict in ${branchName}. Inspect ${integrationTarget.worktreePath}.`
					: mergeResult.error || `Failed to integrate ${branchName}.`,
			};
		}

		integrationRunJournal.appendEvent(
			'branch_merged',
			`Merged ${branchName} into ${integrationTarget.branchName}.`,
			eventTime
		);
	}

	const trimmedValidationCommand = input.validationCommand?.trim();
	if (trimmedValidationCommand) {
		const validationStartedAt = Date.now();
		integrationRunJournal.appendEvent(
			'validation_started',
			`Validation started: ${trimmedValidationCommand}`,
			validationStartedAt
		);

		const validationResult = await input.runValidationCommand({
			sessionId: `conductor-validation-${integrationRunId}`,
			command: trimmedValidationCommand,
			cwd: integrationTarget.worktreePath,
			sessionSshRemoteConfig: input.selectedTemplate.sessionSshRemoteConfig,
		});

		if (validationResult.exitCode !== 0) {
			const failedAt = Date.now();
			integrationRunJournal.appendEvent(
				'validation_failed',
				`Validation failed: ${trimmedValidationCommand}`,
				failedAt
			);
			integrationRunJournal.finalize({
				status: 'attention_required',
				summary: `Validation failed for integration branch ${integrationTarget.branchName}.`,
				endedAt: failedAt,
			});
			input.transitionConductor(input.groupId, {
				type: 'INTEGRATION_RESOLVED',
				nextStatus: 'attention_required',
			});
			return {
				errorMessage:
					(validationResult.stderr || validationResult.stdout || '').trim() ||
					`Validation failed: ${trimmedValidationCommand}`,
			};
		}

		integrationRunJournal.appendEvent(
			'validation_passed',
			`Validation passed: ${trimmedValidationCommand}`,
			Date.now()
		);
	}

	const workerPathsToClean = Object.values(input.executionRun.taskWorktreePaths || {});
	const uniqueWorkerPaths = [...new Set(workerPathsToClean.filter(Boolean))];
	const cleanupFailures: string[] = [];
	for (const worktreePath of uniqueWorkerPaths) {
		const cleanupResult = await input.removeWorktree(worktreePath, true, sshRemoteId);
		if (!cleanupResult.success) {
			cleanupFailures.push(`${worktreePath}: ${cleanupResult.error || 'cleanup failed'}`);
		}
	}

	let deletedBranches = 0;
	if (input.deleteWorkerBranchesOnSuccess) {
		for (const branchName of completedBranches) {
			const deleteResult = await input.deleteLocalBranch(
				repoRoot,
				branchName,
				true,
				sshRemoteId
			);
			if (!deleteResult.success) {
				cleanupFailures.push(`${branchName}: ${deleteResult.error || 'branch delete failed'}`);
				continue;
			}
			deletedBranches += 1;
		}
	}

	integrationRunJournal.appendEvent(
		'cleanup_completed',
		cleanupFailures.length === 0
			? `Cleaned up ${uniqueWorkerPaths.length} worker worktree${uniqueWorkerPaths.length === 1 ? '' : 's'}${input.deleteWorkerBranchesOnSuccess ? ` and deleted ${deletedBranches} worker branch${deletedBranches === 1 ? '' : 'es'}` : ''}.`
			: `Cleanup finished with ${cleanupFailures.length} issue${cleanupFailures.length === 1 ? '' : 's'}.`,
		Date.now()
	);

	const endedAt = Date.now();
	integrationRunJournal.appendEvent(
		'integration_completed',
		`Integration completed in ${integrationTarget.branchName}.`,
		endedAt
	);
	integrationRunJournal.finalize({
		status: cleanupFailures.length === 0 ? 'completed' : 'attention_required',
		summary:
			cleanupFailures.length === 0
				? `Integration branch ready: ${integrationTarget.branchName}.`
				: 'Integration branch ready, but worker cleanup needs attention.',
		endedAt,
	});
	input.transitionConductor(input.groupId, {
		type: 'INTEGRATION_RESOLVED',
		nextStatus: cleanupFailures.length === 0 ? 'idle' : 'attention_required',
	});

	return {
		errorMessage: cleanupFailures.length > 0 ? cleanupFailures.join('\n') : null,
	};
}

export async function resolveConductorIntegrationConflictCommand(input: {
	groupName: string;
	selectedTemplate: Session | null;
	integrationRun: ConductorRun | null;
	validationCommand?: string;
	updateRun: (runId: string, updates: Partial<ConductorRun>) => void;
	setSelectedConductorSessionId: (sessionId: string) => void;
}): Promise<
	| {
			status: 'success';
			toastTitle: string;
			toastMessage: string;
	  }
	| {
			status: 'failure';
			errorMessage: string;
			toastTitle: string;
			toastMessage: string;
	  }
> {
	if (!input.selectedTemplate || !input.integrationRun?.worktreePath) {
		return {
			status: 'failure',
			errorMessage: 'No conflicted integration worktree is available to resolve.',
			toastTitle: 'Conflict Resolution Failed',
			toastMessage: 'No conflicted integration worktree is available to resolve.',
		};
	}

	const integrationBranch =
		input.integrationRun.integrationBranch || input.integrationRun.branchName || 'integration';
	const prompt = buildConductorConflictResolutionPrompt({
		groupName: input.groupName,
		integrationBranch,
		baseBranch: input.integrationRun.baseBranch,
		worktreePath: input.integrationRun.worktreePath,
		validationCommand: input.validationCommand,
	});

	try {
		await runConductorAgentTurn({
			parentSession: input.selectedTemplate,
			role: 'worker',
			taskTitle: 'Resolve integration merge conflict',
			taskDescription: `Resolve merge conflict in ${integrationBranch}`,
			scopePaths: [],
			prompt,
			cwd: input.integrationRun.worktreePath,
			branch: integrationBranch,
			runId: input.integrationRun.id,
			onSessionReady: (session) => {
				input.setSelectedConductorSessionId(session.id);
				input.updateRun(input.integrationRun!.id, {
					agentSessionIds: Array.from(
						new Set([...(input.integrationRun?.agentSessionIds || []), session.id])
					),
				});
			},
		});

		return {
			status: 'success',
			toastTitle: 'Conflict Resolver Finished',
			toastMessage:
				'Conductor opened a helper in the integration worktree. Review the result or rerun integration if more merges remain.',
		};
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Conductor could not resolve the merge conflict.';
		return {
			status: 'failure',
			errorMessage: message,
			toastTitle: 'Conflict Resolution Failed',
			toastMessage: message,
		};
	}
}

export async function createConductorIntegrationPrCommand(input: {
	groupName: string;
	integrationRun: ConductorRun | null;
	sshRemoteId?: string;
	checkGhCli: (ghPath?: string, sshRemoteId?: string) => Promise<GhCliStatus>;
	createPr: (
		worktreePath: string,
		baseBranch: string,
		title: string,
		body: string,
		ghPath?: string,
		sshRemoteId?: string
	) => Promise<GitCreatePrResult>;
	upsertRun: (run: ConductorRun) => void;
	updateRun: (runId: string, updates: Partial<ConductorRun>) => void;
}): Promise<{
	errorMessage: string | null;
}> {
	if (!input.integrationRun?.worktreePath || !input.integrationRun.baseBranch) {
		return {
			errorMessage: 'No completed integration branch is available to publish.',
		};
	}

	const ghStatus = await input.checkGhCli(undefined, input.sshRemoteId);
	if (!ghStatus.installed || !ghStatus.authenticated) {
		return {
			errorMessage: input.sshRemoteId
				? 'GitHub CLI is not installed or authenticated on the remote host.'
				: 'GitHub CLI is not installed or authenticated.',
		};
	}

	const title = `${input.groupName} integration`;
	const body = [
		`This PR was prepared by Conductor for the ${input.groupName} group.`,
		'',
		`Integration branch: \`${input.integrationRun.integrationBranch || input.integrationRun.branchName}\``,
		`Base branch: \`${input.integrationRun.baseBranch}\``,
	].join('\n');
	const prResult = await input.createPr(
		input.integrationRun.worktreePath,
		input.integrationRun.baseBranch,
		title,
		body,
		undefined,
		input.sshRemoteId
	);

	if (!prResult.success || !prResult.prUrl) {
		return {
			errorMessage: prResult.error || 'Failed to create PR.',
		};
	}

	const integrationRunJournal = createConductorRunJournal(input.integrationRun, {
		upsertRun: input.upsertRun,
		updateRun: input.updateRun,
	});
	integrationRunJournal.appendEvent('pr_created', `Created PR: ${prResult.prUrl}`, Date.now());
	integrationRunJournal.sync({ prUrl: prResult.prUrl });

	return {
		errorMessage: null,
	};
}
