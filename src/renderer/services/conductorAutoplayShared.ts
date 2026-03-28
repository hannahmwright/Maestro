import type { ConductorTask } from '../types';

export interface ConductorResourceSnapshot {
	cpuCount: number;
	loadAverage: [number, number, number];
	freeMemoryMB: number;
	availableMemoryMB: number;
	totalMemoryMB: number;
	platform: string;
}

export const LIVE_CONDUCTOR_STATE_OPTIONS = { allowLegacyFallback: false } as const;

export const USER_PAUSED_MESSAGE = 'Paused by you.';
export const USER_PAUSING_MESSAGE = 'Pausing after the current work finishes.';
export const RESOURCE_HOLD_MESSAGE = 'Conductor is waiting for system resources.';

export const CONDUCTOR_AUTOPLAY_RETRY_COOLDOWN_MS = 5 * 60_000;

export const conductorAutoplayLocks = {
	planning: new Set<string>(),
	execution: new Set<string>(),
	review: new Set<string>(),
};

const PROVIDER_LIMIT_HOLD_PATTERN =
	/(you(?:'|')ve hit your limit|resets?\s+\d|quota|rate limit|out of credits|no credits|subscription.*exhausted)/i;

export function isConductorProviderLimitMessage(message: string | null | undefined): boolean {
	return Boolean(message && PROVIDER_LIMIT_HOLD_PATTERN.test(message));
}

export function normalizeConductorTaskDuplicateKey(task: ConductorTask): string {
	return `${task.parentTaskId || 'root'}::${task.title.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}
