import { describe, expect, it } from 'vitest';
import {
	buildDefaultWorktreeBranch,
	isIntegrationBranchName,
	isCodexTaskBranchName,
	requiresWorktreeExecution,
	resolveExecutionWorkflowState,
	resolveSessionWorkflowState,
	sanitizeBranchComponent,
} from '../../../renderer/utils/handoffWorkflow';

describe('handoffWorkflow', () => {
	it('sanitizes branch components', () => {
		expect(sanitizeBranchComponent('Feature/API Cleanup!!')).toBe('feature-api-cleanup');
	});

	it('builds codex default worktree branch names', () => {
		const fixedDate = new Date(2026, 2, 4); // Mar 4, 2026
		expect(buildDefaultWorktreeBranch('main', fixedDate)).toBe('codex/autorun-main-0304-s1');
		expect(buildDefaultWorktreeBranch('feature/abc', fixedDate)).toBe(
			'codex/autorun-feature-abc-0304-s1'
		);
	});

	it('validates codex task branch naming', () => {
		expect(isCodexTaskBranchName('codex/123-api-cleanup-s2')).toBe(true);
		expect(isCodexTaskBranchName('feature/my-branch')).toBe(false);
	});

	it('detects integration branch naming', () => {
		expect(isIntegrationBranchName('codex/integrate-20260304-my-topic')).toBe(true);
		expect(isIntegrationBranchName('codex/autorun-main-0304-s1')).toBe(false);
	});

	it('resolves execution workflow states', () => {
		expect(resolveExecutionWorkflowState(0, false)).toBe('LOCAL_PLAN');
		expect(resolveExecutionWorkflowState(1, false)).toBe('LOCAL_EXEC');
		expect(resolveExecutionWorkflowState(1, true)).toBe('WORKTREE_EXEC');
		expect(resolveExecutionWorkflowState(3, false)).toBe('WORKTREE_EXEC');
	});

	it('requires worktree execution only for multi-task runs', () => {
		expect(requiresWorktreeExecution(1)).toBe(false);
		expect(requiresWorktreeExecution(2)).toBe(true);
	});

	it('resolves per-session workflow states for header badges', () => {
		expect(
			resolveSessionWorkflowState({
				isWorktreeChild: false,
				branchName: null,
				inputMode: 'ai',
				executionMode: 'plan',
				readOnlyMode: true,
			})
		).toBe('LOCAL_PLAN');
		expect(
			resolveSessionWorkflowState({
				isWorktreeChild: false,
				branchName: null,
				inputMode: 'terminal',
			})
		).toBe('LOCAL_EXEC');
		expect(
			resolveSessionWorkflowState({
				isWorktreeChild: true,
				branchName: 'codex/feature-api-cleanup-s1',
				inputMode: 'ai',
				executionMode: 'agent',
			})
		).toBe('WORKTREE_EXEC');
		expect(
			resolveSessionWorkflowState({
				isWorktreeChild: false,
				branchName: 'codex/integrate-20260304-topic',
				inputMode: 'ai',
				executionMode: 'agent',
			})
		).toBe('INTEGRATION');
	});
});
