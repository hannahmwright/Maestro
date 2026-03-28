import type { LogEntry, Session } from '../types';
import { isConductorHelperLikeSession } from '../utils/workspaceThreads';

const CONDUCTOR_HELPER_MAX_LOG_ENTRIES = 80;
const CONDUCTOR_HELPER_MAX_TEXT_CHARS = 12_000;
const CONDUCTOR_HELPER_MAX_TOOL_PREVIEW_CHARS = 1_200;
const CONDUCTOR_HELPER_MAX_SEARCH_ENTRIES = 6;

export function isConductorHelperSession(
	session:
		| (Pick<Session, 'conductorMetadata'> & Partial<Pick<Session, 'name' | 'aiTabs'>>)
		| null
		| undefined
): boolean {
	return Boolean(session && isConductorHelperLikeSession(session));
}

export function compactConductorHelperSession<T extends Pick<
	Session,
	'aiTabs' | 'aiLogs' | 'shellLogs' | 'workLog' | 'executionQueue' | 'conductorMetadata'
>>(session: T): T {
	if (!isConductorHelperSession(session)) {
		return session;
	}

	return {
		...session,
		aiTabs: session.aiTabs.map((tab) => ({
			...tab,
			logs: [],
			inputValue: '',
			stagedImages: [],
		})),
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		executionQueue: [],
	};
}

export function truncateConductorHelperText(
	text: string,
	maxChars: number = CONDUCTOR_HELPER_MAX_TEXT_CHARS
): string {
	if (text.length <= maxChars) {
		return text;
	}

	const truncatedChars = text.length - maxChars;
	return `[truncated ${truncatedChars} chars]\n${text.slice(-maxChars)}`;
}

export function appendConductorHelperText(existing: string, incoming: string): string {
	return truncateConductorHelperText(existing + incoming);
}

export function capConductorHelperLogs(logs: LogEntry[]): LogEntry[] {
	if (logs.length <= CONDUCTOR_HELPER_MAX_LOG_ENTRIES) {
		return logs;
	}

	return logs.slice(-CONDUCTOR_HELPER_MAX_LOG_ENTRIES);
}

function summarizeConductorToolValue(value: unknown): unknown {
	if (value == null) {
		return value;
	}

	if (typeof value === 'string') {
		return truncateConductorHelperText(value, CONDUCTOR_HELPER_MAX_TOOL_PREVIEW_CHARS);
	}

	if (typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}

	if (Array.isArray(value)) {
		return {
			count: value.length,
			preview: value
				.slice(0, 3)
				.map((entry) => summarizeConductorToolValue(entry)),
		};
	}

	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const summarized: Record<string, unknown> = {};
		for (const key of ['id', 'status', 'mode', 'title', 'message', 'error', 'url', 'query']) {
			if (record[key] !== undefined) {
				summarized[key] = summarizeConductorToolValue(record[key]);
			}
		}
		if (record.input !== undefined) {
			summarized.inputPreview = summarizeConductorToolValue(record.input);
		}
		if (record.output !== undefined) {
			summarized.outputPreview = summarizeConductorToolValue(record.output);
		}
		if (Object.keys(summarized).length > 0) {
			return summarized;
		}
		return { keys: Object.keys(record).slice(0, 10) };
	}

	return String(value);
}

export function sanitizeConductorToolStateForLog(state: unknown): Record<string, unknown> {
	const record =
		state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
	const sanitized: Record<string, unknown> = {};

	for (const key of ['id', 'status', 'mode', 'title', 'message', 'error']) {
		if (record[key] !== undefined) {
			sanitized[key] = summarizeConductorToolValue(record[key]);
		}
	}

	if (record.searches && Array.isArray(record.searches)) {
		sanitized.searches = record.searches
			.slice(-CONDUCTOR_HELPER_MAX_SEARCH_ENTRIES)
			.map((entry) => summarizeConductorToolValue(entry));
	}

	if (record.input !== undefined) {
		sanitized.inputPreview = summarizeConductorToolValue(record.input);
	}

	if (record.output !== undefined) {
		sanitized.outputPreview = summarizeConductorToolValue(record.output);
	}

	if (Object.keys(sanitized).length > 0) {
		return sanitized;
	}

	return { keys: Object.keys(record).slice(0, 10) };
}
