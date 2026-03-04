/**
 * Handoff-first workflow policy helpers.
 *
 * Encodes the execution-state model used for local vs worktree execution.
 */

export type HandoffWorkflowState = 'LOCAL_PLAN' | 'LOCAL_EXEC' | 'WORKTREE_EXEC' | 'INTEGRATION';
export type SessionExecutionMode = 'ask' | 'plan' | 'agent';
export type SessionInputMode = 'terminal' | 'ai';

export interface SessionWorkflowStateInput {
	isWorktreeChild: boolean;
	branchName?: string | null;
	inputMode: SessionInputMode;
	executionMode?: SessionExecutionMode;
	readOnlyMode?: boolean;
}

/** Simple branch component sanitization for predictable codex/* branch names. */
export function sanitizeBranchComponent(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+/, '')
		.replace(/-+$/, '')
		.replace(/-+/g, '-');
}

/**
 * Default branch name for worktree execution paths.
 * Follows: codex/<task-id>-<slug>-s<session-number>
 */
export function buildDefaultWorktreeBranch(baseBranch: string, now: Date = new Date()): string {
	const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
	const slug = sanitizeBranchComponent(`${baseBranch}-${mmdd}`) || 'task';
	return `codex/autorun-${slug}-s1`;
}

export function isCodexTaskBranchName(branchName: string): boolean {
	return /^codex\/[a-z0-9][a-z0-9-]*-s\d+$/.test(branchName.trim());
}

export function isIntegrationBranchName(branchName?: string | null): boolean {
	if (!branchName) return false;
	return /^codex\/integrate-\d{8}(?:-[a-z0-9-]+)?$/.test(branchName.trim().toLowerCase());
}

/**
 * Resolve workflow state for execution config.
 *
 * Rules:
 * - taskCount <= 0: LOCAL_PLAN
 * - taskCount == 1: LOCAL_EXEC unless explicitly using worktree
 * - taskCount >= 2: WORKTREE_EXEC (mandatory)
 */
export function resolveExecutionWorkflowState(
	taskCount: number,
	hasWorktreeTarget: boolean
): HandoffWorkflowState {
	if (taskCount <= 0) return 'LOCAL_PLAN';
	if (taskCount === 1) return hasWorktreeTarget ? 'WORKTREE_EXEC' : 'LOCAL_EXEC';
	return 'WORKTREE_EXEC';
}

export function requiresWorktreeExecution(taskCount: number): boolean {
	return taskCount > 1;
}

/**
 * Resolve per-session workflow state shown in the header badge.
 *
 * Rules:
 * - Integration branch always shows INTEGRATION
 * - Worktree child sessions show WORKTREE_EXEC
 * - Terminal mode is considered LOCAL_EXEC
 * - Ask/Plan or read-only AI tabs show LOCAL_PLAN
 * - Otherwise default to LOCAL_EXEC
 */
export function resolveSessionWorkflowState({
	isWorktreeChild,
	branchName,
	inputMode,
	executionMode,
	readOnlyMode,
}: SessionWorkflowStateInput): HandoffWorkflowState {
	if (isIntegrationBranchName(branchName)) return 'INTEGRATION';
	if (isWorktreeChild) return 'WORKTREE_EXEC';
	if (inputMode === 'terminal') return 'LOCAL_EXEC';
	if (executionMode === 'ask' || executionMode === 'plan') return 'LOCAL_PLAN';
	if (readOnlyMode) return 'LOCAL_PLAN';
	return 'LOCAL_EXEC';
}
