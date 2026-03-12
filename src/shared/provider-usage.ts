import type { ToolType } from './types';

export type ProviderUsageSource = 'codex-app-server' | 'claude-oauth-usage' | 'unknown';
export type ProviderUsageConfidence = 'high' | 'experimental' | 'low';

export interface ProviderUsageWindow {
	id: string;
	label: string;
	usedPercent: number;
	resetsAt: number | null;
	windowDurationMins: number | null;
	limitId?: string | null;
	limitName?: string | null;
}

export interface ProviderUsageCredits {
	balance: string | null;
	hasCredits: boolean;
	unlimited: boolean;
}

export interface ProviderUsageSnapshot {
	provider: ToolType;
	usedPercent: number | null;
	resetsAt: number | null;
	label: string | null;
	planType: string | null;
	accountType: string | null;
	source: ProviderUsageSource;
	confidence: ProviderUsageConfidence;
	fetchedAt: number;
	windows: ProviderUsageWindow[];
	credits?: ProviderUsageCredits | null;
}
