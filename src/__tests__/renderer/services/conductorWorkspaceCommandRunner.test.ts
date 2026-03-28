import { describe, expect, it, vi } from 'vitest';
import type {
	ConductorRun,
	ConductorTask,
	Session,
} from '../../../shared/types';
import {
	bootstrapConductorGitRepoCommand,
	cleanupConductorRunArtifactsCommand,
	createConductorIntegrationPrCommand,
	integrateConductorCompletedWorkCommand,
	resolveConductorIntegrationConflictCommand,
} from '../../../renderer/services/conductorWorkspaceCommandRunner';

function buildTask(overrides: Partial<ConductorTask> = {}): ConductorTask {
	return {
		id: 'task-1',
		groupId: 'group-1',
		title: 'Task',
		description: '',
		acceptanceCriteria: [],
		priority: 'medium',
		status: 'ready',
		dependsOn: [],
		scopePaths: [],
		source: 'planner',
		attentionRequest: null,
		agentHistory: [],
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function buildRun(overrides: Partial<ConductorRun> = {}): ConductorRun {
	return {
		id: 'run-1',
		groupId: 'group-1',
		kind: 'integration',
		baseBranch: 'main',
		integrationBranch: 'codex/integration',
		status: 'completed',
		taskIds: ['task-1'],
		events: [],
		startedAt: 1,
		worktreePath: '/tmp/integration',
		branchName: 'codex/integration',
		...overrides,
	};
}

function buildSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Session',
		cwd: '/tmp/project',
		type: 'claude-code',
		state: 'idle',
		tabs: [],
		activeTabId: 'tab-1',
		gitBranches: ['main'],
		inputMode: 'ai',
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	} as Session;
}

describe('conductorWorkspaceCommandRunner', () => {
	it('returns a session patch and setup transition flag for successful git bootstrap', async () => {
		const result = await bootstrapConductorGitRepoCommand({
			selectedTemplate: buildSession({ id: 'lead-1', cwd: '/tmp/project', gitBranches: ['main'] }),
			sshRemoteId: 'remote-1',
			leadCommitCount: 0,
			conductorStatus: 'needs_setup',
			initializeRepo: vi.fn().mockResolvedValue({
				success: true,
				currentBranch: 'main',
				createdCommit: true,
			}),
		});

		expect(result).toEqual(
			expect.objectContaining({
				status: 'success',
				nextLeadCommitCount: 1,
				shouldTransitionSetupCompleted: true,
				toastTitle: 'Git Ready',
			})
		);
		if (result.status !== 'success') {
			throw new Error('Expected bootstrap success');
		}
		expect(result.sessionPatch).toEqual(
			expect.objectContaining({
				isGitRepo: true,
				gitBranches: ['main'],
			})
		);
	});

	it('returns an immediate cleanup error when no lead session exists', async () => {
		const result = await cleanupConductorRunArtifactsCommand({
			run: buildRun(),
			selectedTemplate: null,
			deleteWorkerBranchesOnSuccess: false,
			getRepoRoot: vi.fn(),
			removeWorktree: vi.fn(),
			deleteLocalBranch: vi.fn(),
			upsertRun: vi.fn(),
			updateRun: vi.fn(),
		});

		expect(result.errorMessage).toContain('top-level agent');
	});

	it('refuses integration when no completed worker branches are available', async () => {
		const transitionConductor = vi.fn();
		const result = await integrateConductorCompletedWorkCommand({
			groupId: 'group-1',
			groupName: 'Questionaire',
			selectedTemplate: buildSession(),
			executionRun: buildRun({
				kind: 'execution',
				taskIds: ['task-1'],
				taskBranches: { 'task-1': 'codex/task-1' },
			}),
			tasksById: new Map([['task-1', buildTask({ status: 'needs_review' })]]),
			deleteWorkerBranchesOnSuccess: false,
			transitionConductor,
			getRepoRoot: vi.fn(),
			worktreeSetup: vi.fn(),
			mergeBranchIntoWorktree: vi.fn(),
			runValidationCommand: vi.fn(),
			removeWorktree: vi.fn(),
			deleteLocalBranch: vi.fn(),
			upsertRun: vi.fn(),
			updateRun: vi.fn(),
		});

		expect(result.errorMessage).toBe('No completed worker branches are available to integrate.');
		expect(transitionConductor).not.toHaveBeenCalled();
	});

	it('creates a PR and records the published URL on the integration run', async () => {
		const upsertRun = vi.fn();
		const updateRun = vi.fn();
		const result = await createConductorIntegrationPrCommand({
			groupName: 'Questionaire',
			integrationRun: buildRun(),
			checkGhCli: vi.fn().mockResolvedValue({ installed: true, authenticated: true }),
			createPr: vi.fn().mockResolvedValue({
				success: true,
				prUrl: 'https://github.com/example/repo/pull/1',
			}),
			upsertRun,
			updateRun,
		});

		expect(result).toEqual({ errorMessage: null });
		expect(upsertRun).toHaveBeenCalled();
		expect(updateRun).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({ prUrl: 'https://github.com/example/repo/pull/1' })
		);
	});

	it('fails conflict resolution loudly when no integration worktree exists', async () => {
		const result = await resolveConductorIntegrationConflictCommand({
			groupName: 'Questionaire',
			selectedTemplate: buildSession(),
			integrationRun: null,
			updateRun: vi.fn(),
			setSelectedConductorSessionId: vi.fn(),
		});

		expect(result).toEqual(
			expect.objectContaining({
				status: 'failure',
				errorMessage: 'No conflicted integration worktree is available to resolve.',
			})
		);
	});
});
