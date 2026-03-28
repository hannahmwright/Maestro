import type { ConductorResourceProfile, ConductorTask } from '../types';

export interface ConductorResourceSnapshot {
	cpuCount: number;
	loadAverage: [number, number, number];
	freeMemoryMB: number;
	availableMemoryMB: number;
	totalMemoryMB: number;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
}

export interface ConductorResourceGateResult {
	allowed: boolean;
	maxWorkers: number;
	message?: string;
}

export interface ConductorWorktreeTarget {
	branchName: string;
	worktreePath: string;
}

export function evaluateConductorResourceGate(
	profile: ConductorResourceProfile,
	snapshot?: ConductorResourceSnapshot | null
): ConductorResourceGateResult {
	const cores = Math.max(1, snapshot?.cpuCount || navigator.hardwareConcurrency || 1);
	const preferredMaxWorkers =
		profile === 'aggressive'
			? Math.max(1, Math.min(4, Math.floor(cores / 2)))
			: profile === 'balanced'
				? Math.max(1, Math.min(2, Math.floor(cores / 2)))
				: 1;
	let maxWorkers = preferredMaxWorkers;

	const freeMemoryMB = snapshot?.availableMemoryMB ?? snapshot?.freeMemoryMB ?? null;
	const oneMinuteLoad = snapshot?.loadAverage?.[0] ?? null;
	const hardMinFreeMemoryMB = 512;
	const preferredMinFreeMemoryMB =
		profile === 'aggressive' ? 3072 : profile === 'balanced' ? 2048 : 1024;
	const pressureNotes: string[] = [];

	if (cores <= 1 && profile !== 'conservative') {
		return {
			allowed: false,
			maxWorkers,
			message:
				'This machine reports only one hardware thread. Switch to Conservative or use a larger machine.',
		};
	}

	if (freeMemoryMB !== null && freeMemoryMB < hardMinFreeMemoryMB) {
		return {
			allowed: false,
			maxWorkers,
			message: `Available memory is below the ${hardMinFreeMemoryMB} MB floor for Conductor launches.`,
		};
	}

	if (freeMemoryMB !== null && freeMemoryMB < preferredMinFreeMemoryMB) {
		maxWorkers = 1;
		pressureNotes.push(
			`Available memory is below the preferred ${preferredMinFreeMemoryMB} MB target for the ${profile} profile, so Conductor is limiting this run to one worker.`
		);
	}

	if (oneMinuteLoad !== null && oneMinuteLoad > cores * 1.25 && maxWorkers > 1) {
		maxWorkers = 1;
		pressureNotes.push(
			'System load is currently high, so Conductor is limiting this run to one worker until the machine settles.'
		);
	}

	return {
		allowed: true,
		maxWorkers,
		message: pressureNotes.length > 0 ? pressureNotes.join(' ') : undefined,
	};
}

function normalizeScope(scopePath: string): string {
	return scopePath
		.replace(/\\/g, '/')
		.replace(/^\.?\//, '')
		.replace(/\/+$/, '')
		.toLowerCase();
}

function scopesOverlap(left: string, right: string): boolean {
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function tasksConflict(left: ConductorTask, right: ConductorTask): boolean {
	if (left.id === right.id) {
		return false;
	}

	if (left.scopePaths.length === 0 || right.scopePaths.length === 0) {
		return true;
	}

	const leftScopes = left.scopePaths.map(normalizeScope).filter(Boolean);
	const rightScopes = right.scopePaths.map(normalizeScope).filter(Boolean);

	if (leftScopes.length === 0 || rightScopes.length === 0) {
		return true;
	}

	return leftScopes.some((leftScope) =>
		rightScopes.some((rightScope) => scopesOverlap(leftScope, rightScope))
	);
}

export function buildConductorWorktreeTarget(
	repoRoot: string,
	groupName: string,
	runId: string,
	worktreeBasePath?: string
): ConductorWorktreeTarget {
	const groupSlug = slugify(groupName) || 'group';
	const separator = repoRoot.includes('\\') && !repoRoot.includes('/') ? '\\' : '/';
	const repoName = repoRoot.split(/[\\/]/).filter(Boolean).pop() || 'repo';
	const runSuffix = runId.replace(/^conductor-run-/, '').slice(-8);
	const branchName = `codex/conductor-${groupSlug}-${runSuffix}`;
	const repoParent = repoRoot.replace(/[\\/][^\\/]+$/, '');
	const targetBasePath = (worktreeBasePath || repoParent).replace(/[\\/]+$/, '');
	const worktreePath = `${targetBasePath}${separator}${repoName}-conductor-${groupSlug}-${runSuffix}`;

	return { branchName, worktreePath };
}

export function buildConductorIntegrationTarget(
	repoRoot: string,
	groupName: string,
	runId: string,
	worktreeBasePath?: string
): ConductorWorktreeTarget {
	const groupSlug = slugify(groupName) || 'group';
	const separator = repoRoot.includes('\\') && !repoRoot.includes('/') ? '\\' : '/';
	const repoName = repoRoot.split(/[\\/]/).filter(Boolean).pop() || 'repo';
	const runSuffix = runId.replace(/^conductor-run-/, '').slice(-8);
	const branchName = `codex/conductor-integrate-${groupSlug}-${runSuffix}`;
	const repoParent = repoRoot.replace(/[\\/][^\\/]+$/, '');
	const targetBasePath = (worktreeBasePath || repoParent).replace(/[\\/]+$/, '');
	const worktreePath = `${targetBasePath}${separator}${repoName}-conductor-integrate-${groupSlug}-${runSuffix}`;

	return { branchName, worktreePath };
}
