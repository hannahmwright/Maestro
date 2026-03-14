import type { LogEntry } from '../types';

export type PreservedReasoningReason = 'failed' | 'interrupted' | 'killed';

export interface PreservedReasoningEntrySnapshot {
	source: 'thinking' | 'tool';
	text: string;
	timestamp: number;
	metadata?: LogEntry['metadata'];
}

export interface PreservedReasoningPayload {
	reason: PreservedReasoningReason;
	title: string;
	excerpt?: string;
	entryCount: number;
	thinkingCount: number;
	toolCount: number;
	entries: PreservedReasoningEntrySnapshot[];
}

const PRESERVED_REASONING_TITLES: Record<PreservedReasoningReason, string> = {
	failed: 'Reasoning preserved from failed turn',
	interrupted: 'Reasoning preserved from interrupted turn',
	killed: 'Reasoning preserved from force-killed turn',
};

function isReasoningLog(log: LogEntry): boolean {
	return log.source === 'thinking' || log.source === 'tool';
}

function buildExcerpt(entries: PreservedReasoningEntrySnapshot[]): string | undefined {
	for (const entry of entries) {
		if (entry.source !== 'thinking') continue;
		const normalized = entry.text.replace(/\s+/g, ' ').trim();
		if (!normalized) continue;
		return normalized.length > 180 ? `${normalized.slice(0, 177).trimEnd()}...` : normalized;
	}

	return undefined;
}

function flattenEntries(entries: PreservedReasoningEntrySnapshot[]): string {
	return entries
		.map((entry) => {
			if (entry.source === 'tool') {
				const status = entry.metadata?.toolState?.status;
				return `Tool: ${entry.text}${status ? ` (${status})` : ''}`;
			}
			return entry.text;
		})
		.join('\n\n');
}

export function preserveTrailingReasoning(
	logs: LogEntry[],
	reason: PreservedReasoningReason,
	timestamp = Date.now()
): LogEntry[] {
	let trailingStart = logs.length;
	for (let index = logs.length - 1; index >= 0; index -= 1) {
		if (!isReasoningLog(logs[index])) break;
		trailingStart = index;
	}

	if (trailingStart === logs.length) {
		return logs;
	}

	const trailingReasoning = logs
		.slice(trailingStart)
		.filter((log): log is LogEntry & { source: 'thinking' | 'tool' } => isReasoningLog(log));

	if (trailingReasoning.length === 0) {
		return logs;
	}

	const entries: PreservedReasoningEntrySnapshot[] = trailingReasoning.map((log) => ({
		source: log.source,
		text: log.text,
		timestamp: log.timestamp,
		metadata: log.metadata,
	}));
	const thinkingCount = entries.filter((entry) => entry.source === 'thinking').length;
	const toolCount = entries.filter((entry) => entry.source === 'tool').length;
	const excerpt = buildExcerpt(entries);
	const title = PRESERVED_REASONING_TITLES[reason];
	const flattenedText = flattenEntries(entries);

	const preservedLog: LogEntry = {
		id: logs[trailingStart]?.id || `${reasonedIdPrefix(reason)}-${timestamp}`,
		timestamp,
		source: 'system',
		text: `${title}\n\n${flattenedText}`,
		metadata: {
			preservedReasoning: {
				reason,
				title,
				excerpt,
				entryCount: entries.length,
				thinkingCount,
				toolCount,
				entries,
			},
		},
	};

	return [...logs.slice(0, trailingStart), preservedLog];
}

function reasonedIdPrefix(reason: PreservedReasoningReason): string {
	return `preserved-${reason}-reasoning`;
}

export function preserveTrailingReasoningAndAppend(
	logs: LogEntry[],
	reason: PreservedReasoningReason,
	appendedLog?: LogEntry | null
): LogEntry[] {
	const nextLogs = preserveTrailingReasoning(logs, reason, appendedLog?.timestamp || Date.now());
	return appendedLog ? [...nextLogs, appendedLog] : nextLogs;
}
