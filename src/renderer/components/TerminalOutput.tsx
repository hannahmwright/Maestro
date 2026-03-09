import React, { useRef, useEffect, useMemo, forwardRef, useState, useCallback, memo } from 'react';
import {
	ChevronDown,
	ChevronUp,
	Trash2,
	Copy,
	Check,
	ArrowDown,
	Eye,
	FileText,
	RotateCcw,
	AlertCircle,
	Save,
} from 'lucide-react';
import type { Session, Theme, LogEntry, FocusArea, AgentError } from '../types';
import type { FileNode } from '../types/fileTree';
import Convert from 'ansi-to-html';
import DOMPurify from 'dompurify';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { getActiveTab } from '../utils/tabHelpers';
import { useDebouncedValue, useThrottledCallback } from '../hooks';
import {
	processLogTextHelper,
	filterTextByLinesHelper,
	getCachedAnsiHtml,
} from '../utils/textProcessing';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { MarkdownRenderer } from './MarkdownRenderer';
import { QueuedItemsList } from './QueuedItemsList';
import { LogFilterControls } from './LogFilterControls';
import { SaveMarkdownModal } from './SaveMarkdownModal';
import { DemoCardPanel } from './DemoCardPanel';
import { DemoViewerModal } from './DemoViewerModal';
import { generateTerminalProseStyles } from '../utils/markdownConfig';
import { safeClipboardWrite } from '../utils/clipboard';
import { parseMultipleChoiceQuestions } from '../utils/multipleChoiceQuestions';
import type { UserInputRequest, UserInputResponse } from '../../shared/user-input-requests';

// ============================================================================
// Tool display helpers (pure functions, hoisted out of render path)
// ============================================================================

/** Type-safe string extraction — returns null for non-strings */
const safeStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Handle command values that may be strings or string arrays (Codex uses arrays) */
const safeCommand = (v: unknown): string | null => {
	if (typeof v === 'string') return v;
	if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) {
		return v.join(' ');
	}
	return null;
};

/** Truncate a value to max length with ellipsis, returns null for non-strings */
const truncateStr = (v: unknown, max: number): string | null => {
	const s = safeStr(v);
	if (!s) return null;
	return s.length > max ? s.substring(0, max) + '\u2026' : s;
};

/** Summarize TodoWrite todos array — shows in-progress task and progress count */
const summarizeTodos = (v: unknown): string | null => {
	if (!Array.isArray(v) || v.length === 0) return null;
	const todos = v as Array<{ content?: string; status?: string; activeForm?: string }>;
	const completed = todos.filter((t) => t.status === 'completed').length;
	const inProgress = todos.find((t) => t.status === 'in_progress');
	const label = inProgress?.activeForm || inProgress?.content || todos[0]?.content;
	if (!label) return `${todos.length} tasks`;
	return `${label} (${completed}/${todos.length})`;
};

/** Normalize status aliases from different providers into shared UI states. */
const normalizeToolStatus = (status: unknown): 'running' | 'completed' | 'error' => {
	if (status === 'completed' || status === 'success') return 'completed';
	if (status === 'error' || status === 'failed') return 'error';
	return 'running';
};

/** Compact preview for tool output values (string/object/array). */
const summarizeToolOutput = (v: unknown): string | null => {
	if (v === null || v === undefined) return null;
	if (typeof v === 'string') {
		const compact = v.replace(/\s+/g, ' ').trim();
		return compact.length > 140 ? compact.substring(0, 140) + '\u2026' : compact;
	}
	try {
		const json = JSON.stringify(v);
		if (!json) return null;
		return json.length > 140 ? json.substring(0, 140) + '\u2026' : json;
	} catch {
		return null;
	}
};

/** Convert tool values to a compact one-line representation. */
const summarizeToolValue = (v: unknown, max = 160): string | null => {
	if (v === null || v === undefined) return null;
	if (typeof v === 'string') {
		const compact = v.replace(/\s+/g, ' ').trim();
		if (!compact) return null;
		return compact.length > max ? compact.substring(0, max) + '\u2026' : compact;
	}
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	if (Array.isArray(v)) {
		const asCommand = safeCommand(v);
		if (asCommand) return summarizeToolValue(asCommand, max);
		try {
			const json = JSON.stringify(v);
			return json.length > max ? json.substring(0, max) + '\u2026' : json;
		} catch {
			return null;
		}
	}
	try {
		const json = JSON.stringify(v);
		if (!json) return null;
		return json.length > max ? json.substring(0, max) + '\u2026' : json;
	} catch {
		return null;
	}
};

/** Convert tool values to multiline detail text for expanded display. */
const formatToolDetailValue = (v: unknown, max = 2400): string | null => {
	if (v === null || v === undefined) return null;
	let text: string;
	if (typeof v === 'string') {
		text = v.trim();
		if (!text) return null;
	} else if (typeof v === 'number' || typeof v === 'boolean') {
		text = String(v);
	} else if (Array.isArray(v)) {
		const asCommand = safeCommand(v);
		if (asCommand) {
			text = asCommand;
		} else {
			try {
				text = JSON.stringify(v, null, 2);
			} catch {
				return null;
			}
		}
	} else {
		try {
			text = JSON.stringify(v, null, 2);
		} catch {
			return null;
		}
	}

	return text.length > max
		? text.substring(0, max) + `\n... [truncated ${text.length - max} chars]`
		: text;
};

interface ToolDetailRow {
	label: string;
	value: string;
}

interface ToolDisplayData {
	summary: string | null;
	detailRows: ToolDetailRow[];
	outputDetail: string | null;
}

/** Build detail rows + summary from tool state so RUN cards can show live context. */
const buildToolDisplayData = (
	toolState: NonNullable<LogEntry['metadata']>['toolState'] | undefined
): ToolDisplayData => {
	const detailRows: ToolDetailRow[] = [];
	const input = toolState?.input as Record<string, unknown> | undefined;

	const pushDetail = (label: string, value: string | null) => {
		if (!value) return;
		const duplicate = detailRows.some((row) => row.label === label && row.value === value);
		if (!duplicate) {
			detailRows.push({ label, value });
		}
	};

	if (input) {
		pushDetail('command', safeCommand(input.command) || safeCommand(input.cmd));
		pushDetail('query', safeStr(input.query) || safeStr(input.pattern));
		pushDetail('path', safeStr(input.path) || safeStr(input.file_path) || safeStr(input.filePath));
		pushDetail(
			'task',
			safeStr(input.description) || safeStr(input.prompt) || safeStr(input.task_id)
		);
		pushDetail('todos', summarizeTodos(input.todos));
		pushDetail('code', truncateStr(input.code, 140));
		pushDetail('content', truncateStr(input.content, 120));

		const consumedKeys = new Set([
			'command',
			'cmd',
			'query',
			'pattern',
			'path',
			'file_path',
			'filePath',
			'description',
			'prompt',
			'task_id',
			'todos',
			'code',
			'content',
		]);

		for (const [key, value] of Object.entries(input)) {
			if (consumedKeys.has(key)) continue;
			pushDetail(key, summarizeToolValue(value, 120));
			if (detailRows.length >= 6) break;
		}
	}

	const outputDetail = formatToolDetailValue(toolState?.output);
	const outputSummary = summarizeToolOutput(toolState?.output);
	const pathSummary = detailRows.find((row) => row.label === 'path')?.value;
	const summary = (pathSummary ? `file: ${pathSummary}` : detailRows[0]?.value) || outputSummary;

	return {
		summary,
		detailRows,
		outputDetail,
	};
};

const normalizeToolName = (toolName: string): string => toolName.toLowerCase().replace(/_/g, ':');
const isWebSearchTool = (toolName: string): boolean => normalizeToolName(toolName) === 'web:search';

const asRecord = (value: unknown): Record<string, unknown> | null => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
};

const asStringArray = (value: unknown): string[] => {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
	);
};

interface WebSearchTimelineItem {
	id: string;
	query: string;
	status: 'running' | 'completed' | 'error';
	timestamp?: number;
	responseDomains: string[];
	sourceUrls: string[];
	resultCount: number;
	latestResponseDomain?: string;
	responsePreview?: string;
}

const extractWebSearchTimelineItems = (
	toolState: NonNullable<LogEntry['metadata']>['toolState'] | undefined
): WebSearchTimelineItem[] => {
	if (!toolState) return [];
	const items: WebSearchTimelineItem[] = [];
	const stateRecord = toolState as Record<string, unknown>;
	const fallbackResponseDomains = extractDomainsFromUnknown(stateRecord.output, 8);
	for (const domain of extractDomainsFromUnknown(stateRecord.result, 8)) {
		if (!fallbackResponseDomains.includes(domain)) fallbackResponseDomains.push(domain);
	}
	const fallbackSourceUrls = extractUrlsFromUnknown(stateRecord.output, 32);
	for (const url of extractUrlsFromUnknown(stateRecord.result, 32)) {
		if (!fallbackSourceUrls.includes(url)) fallbackSourceUrls.push(url);
	}
	const push = (
		queryValue: unknown,
		status: unknown,
		id: string,
		timestamp?: number,
		responseDomains: string[] = fallbackResponseDomains,
		latestResponseDomain?: string,
		sourceUrls: string[] = fallbackSourceUrls,
		responsePreview?: string
	) => {
		if (typeof queryValue !== 'string') return;
		const query = queryValue.trim();
		if (!query) return;
		if (items.some((item) => item.query === query && item.id === id)) return;
		const resultCount = sourceUrls.length > 0 ? sourceUrls.length : responseDomains.length;
		items.push({
			id,
			query,
			status: normalizeToolStatus(status),
			timestamp,
			responseDomains,
			sourceUrls,
			resultCount,
			latestResponseDomain,
			responsePreview,
		});
	};

	if (Array.isArray(stateRecord.searches)) {
		for (const raw of stateRecord.searches) {
			const entry = asRecord(raw);
			if (!entry) continue;
			const id =
				typeof entry.id === 'string' && entry.id.trim()
					? entry.id
					: `search-${String(entry.query || '')}`;
			const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : undefined;
			const responseDomains = Array.isArray(entry.domains)
				? entry.domains.filter(
						(value): value is string => typeof value === 'string' && value.trim().length > 0
					)
				: [];
			const latestResponseDomain =
				typeof entry.latestResponseDomain === 'string' && entry.latestResponseDomain.trim()
					? entry.latestResponseDomain.trim()
					: responseDomains[responseDomains.length - 1];
			const sourceUrls = Array.isArray(entry.sourceUrls)
				? entry.sourceUrls.filter(
						(value): value is string => typeof value === 'string' && value.trim().length > 0
					)
				: Array.isArray(entry.urls)
					? entry.urls.filter(
							(value): value is string => typeof value === 'string' && value.trim().length > 0
						)
					: [];
			const responsePreview =
				typeof entry.responsePreview === 'string' && entry.responsePreview.trim()
					? entry.responsePreview.trim()
					: undefined;
			push(
				entry.query,
				entry.status,
				id,
				timestamp,
				responseDomains,
				latestResponseDomain,
				sourceUrls,
				responsePreview
			);
		}
	}

	// Fallback for non-aggregated web_search tool states.
	if (items.length === 0) {
		const input = asRecord(stateRecord.input);
		const output = asRecord(stateRecord.output);
		const action = asRecord(input?.action);
		const outputAction = asRecord(output?.action);
		const status = stateRecord.status;

		push(input?.query, status, 'input-query');
		push(stateRecord.query, status, 'state-query');
		push(action?.query, status, 'action-query');
		push(output?.query, status, 'output-query');
		push(outputAction?.query, status, 'output-action-query');

		for (const query of asStringArray(action?.queries)) {
			push(query, status, `action-list:${query}`);
		}
		for (const query of asStringArray(output?.queries)) {
			push(query, status, `output-list:${query}`);
		}
		for (const query of asStringArray(outputAction?.queries)) {
			push(query, status, `output-action-list:${query}`);
		}
	}

	return items.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
};

const extractSiteFilter = (query: string): string | null => {
	const match = query.match(/\bsite:([^\s]+)/i);
	return match?.[1] || null;
};

const URL_DOMAIN_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
const SITE_FILTER_GLOBAL_RE = /\bsite:([^\s]+)/gi;

const normalizeDomain = (value: string): string | null => {
	const cleaned = value.trim().replace(/[),.;:!?]+$/, '');
	if (!cleaned) return null;
	try {
		const withProtocol = cleaned.includes('://') ? cleaned : `https://${cleaned}`;
		const hostname = new URL(withProtocol).hostname.replace(/^www\./, '');
		return hostname || null;
	} catch {
		return null;
	}
};

const sourceEmblemLabel = (domain: string): string => {
	const host = domain.replace(/^www\./, '');
	const base = host.split('.')[0] || host;
	return base.slice(0, 2).toUpperCase();
};

const faviconUrlForDomain = (domain: string): string =>
	`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;

const SourceFaviconBadge = memo(
	({ domain, overlap, theme }: { domain: string; overlap: boolean; theme: Theme }) => {
		const [imageFailed, setImageFailed] = useState(false);
		return (
			<span
				className={`inline-flex shrink-0 items-center justify-center w-5 h-5 aspect-square rounded-full border overflow-hidden ${overlap ? '-ml-2' : ''}`}
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgMain,
				}}
				title={domain}
			>
				{imageFailed ? (
					<span className="text-[9px] font-semibold" style={{ color: theme.colors.textDim }}>
						{sourceEmblemLabel(domain)}
					</span>
				) : (
					<img
						src={faviconUrlForDomain(domain)}
						alt={domain}
						className="w-full h-full rounded-full object-cover"
						loading="lazy"
						onError={() => setImageFailed(true)}
					/>
				)}
			</span>
		);
	}
);

const cleanDetectedUrl = (value: string): string => value.trim().replace(/[),.;:!?]+$/, '');

const extractUrlsFromUnknown = (value: unknown, maxUrls = 32): string[] => {
	const urls: string[] = [];
	const seen = new Set<string>();

	const pushUrl = (raw: string) => {
		const cleaned = cleanDetectedUrl(raw);
		if (!cleaned || seen.has(cleaned)) return;
		seen.add(cleaned);
		urls.push(cleaned);
	};

	const visit = (input: unknown, depth = 0) => {
		if (!input || depth > 3 || urls.length >= maxUrls) return;
		if (typeof input === 'string') {
			URL_DOMAIN_RE.lastIndex = 0;
			let urlMatch: RegExpExecArray | null = null;
			while ((urlMatch = URL_DOMAIN_RE.exec(input)) !== null) {
				pushUrl(urlMatch[0]);
				if (urls.length >= maxUrls) return;
			}
			return;
		}

		if (Array.isArray(input)) {
			for (const entry of input) {
				visit(entry, depth + 1);
				if (urls.length >= maxUrls) break;
			}
			return;
		}

		if (typeof input === 'object') {
			for (const entry of Object.values(input as Record<string, unknown>)) {
				visit(entry, depth + 1);
				if (urls.length >= maxUrls) break;
			}
		}
	};

	visit(value);
	return urls;
};

const extractDomainsFromUnknown = (value: unknown, maxDomains = 8): string[] => {
	const domains: string[] = [];
	const seen = new Set<string>();
	const pushDomain = (raw: string) => {
		const normalized = normalizeDomain(raw);
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		domains.push(normalized);
	};

	const visit = (input: unknown, depth = 0) => {
		if (!input || depth > 3 || domains.length >= maxDomains) return;
		if (typeof input === 'string') {
			SITE_FILTER_GLOBAL_RE.lastIndex = 0;
			let siteMatch: RegExpExecArray | null = null;
			while ((siteMatch = SITE_FILTER_GLOBAL_RE.exec(input)) !== null) {
				pushDomain(siteMatch[1]);
				if (domains.length >= maxDomains) return;
			}

			URL_DOMAIN_RE.lastIndex = 0;
			let urlMatch: RegExpExecArray | null = null;
			while ((urlMatch = URL_DOMAIN_RE.exec(input)) !== null) {
				pushDomain(urlMatch[0]);
				if (domains.length >= maxDomains) return;
			}
			return;
		}

		if (Array.isArray(input)) {
			for (const entry of input) {
				visit(entry, depth + 1);
				if (domains.length >= maxDomains) break;
			}
			return;
		}

		if (typeof input === 'object') {
			for (const entry of Object.values(input as Record<string, unknown>)) {
				visit(entry, depth + 1);
				if (domains.length >= maxDomains) break;
			}
		}
	};

	visit(value);
	return domains;
};

const collectSearchSourceDomains = (
	toolState: NonNullable<LogEntry['metadata']>['toolState'] | undefined,
	webSearchItems: WebSearchTimelineItem[]
): string[] => {
	const domains: string[] = [];
	const seen = new Set<string>();
	const pushDomain = (raw: string) => {
		const normalized = normalizeDomain(raw);
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		domains.push(normalized);
	};

	for (const item of webSearchItems) {
		for (const url of item.sourceUrls) {
			pushDomain(url);
		}
		for (const domain of item.responseDomains) {
			pushDomain(domain);
		}
		const site = extractSiteFilter(item.query);
		if (site) pushDomain(site);
	}

	for (const domain of extractDomainsFromUnknown(toolState?.output, Number.MAX_SAFE_INTEGER)) {
		pushDomain(domain);
	}
	for (const domain of extractDomainsFromUnknown(
		(toolState as Record<string, unknown> | undefined)?.result,
		Number.MAX_SAFE_INTEGER
	)) {
		pushDomain(domain);
	}
	return domains;
};

const getWebSearchResponseDomains = (item: WebSearchTimelineItem): string[] => {
	const domains: string[] = [];
	const seen = new Set<string>();
	const pushDomain = (raw: string) => {
		const normalized = normalizeDomain(raw);
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		domains.push(normalized);
	};

	for (const url of item.sourceUrls) {
		pushDomain(url);
	}
	for (const domain of item.responseDomains) {
		pushDomain(domain);
	}
	if (domains.length === 0) {
		const site = extractSiteFilter(item.query);
		if (site) pushDomain(site);
	}
	return domains;
};

const asFiniteNumber = (value: unknown): number | null => {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
};

const formatDurationMs = (durationMs: number): string => {
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	const totalSeconds = Math.round(durationMs / 1000);
	if (totalSeconds < 60) {
		const seconds = durationMs / 1000;
		return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`;
	}
	const totalMinutes = Math.floor(totalSeconds / 60);
	const secondsRemainder = totalSeconds % 60;
	if (totalMinutes < 60) {
		return `${totalMinutes}m ${secondsRemainder.toString().padStart(2, '0')}s`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutesRemainder = totalMinutes % 60;
	return `${hours}h ${minutesRemainder.toString().padStart(2, '0')}m`;
};

const getToolDurationMs = (log: LogEntry): number | null => {
	if (log.source !== 'tool') return null;
	const toolState = asRecord(log.metadata?.toolState);
	if (!toolState) return null;

	const explicitDurationCandidates = [
		toolState.durationMs,
		toolState.duration_ms,
		toolState.elapsedMs,
		toolState.elapsed_ms,
		toolState.executionTimeMs,
	];

	for (const candidate of explicitDurationCandidates) {
		const duration = asFiniteNumber(candidate);
		if (duration !== null && duration >= 0) return duration;
	}

	const timing = asRecord(toolState.timing);
	const startTimestamp =
		asFiniteNumber(toolState.startTimestamp) ??
		asFiniteNumber(toolState.startedAt) ??
		asFiniteNumber(timing?.startTimestamp) ??
		asFiniteNumber(timing?.startedAt);
	const endTimestamp =
		asFiniteNumber(toolState.endTimestamp) ??
		asFiniteNumber(toolState.completedAt) ??
		asFiniteNumber(timing?.endTimestamp) ??
		asFiniteNumber(timing?.completedAt);
	const status = normalizeToolStatus(toolState.status);

	if (startTimestamp === null) return null;
	const resolvedEnd = endTimestamp ?? (status === 'running' ? Date.now() : log.timestamp);
	if (!Number.isFinite(resolvedEnd) || resolvedEnd < startTimestamp) return null;
	return resolvedEnd - startTimestamp;
};

interface SourceLink {
	url: string;
	label: string;
}

const SOURCE_HEADER_RE = /^(?:[-*]\s*)?sources?\s*:?\s*$/i;
const SOURCE_PREFIX_RE = /^(?:[-*]\s*)?sources?\s*:/i;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;
const PLAIN_URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

const cleanSourceUrl = (value: string): string => value.trim().replace(/[),.;:!?]+$/, '');

const sourceLabelFromUrl = (url: string): string => {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return 'source';
	}
};

const sourceDomainFromUrl = (url: string): string | null => {
	const cleaned = cleanSourceUrl(url);
	if (!cleaned) return null;
	try {
		return new URL(cleaned).hostname.replace(/^www\./, '');
	} catch {
		return normalizeDomain(cleaned);
	}
};

const extractSourceLinksFromLine = (line: string): SourceLink[] => {
	const found: SourceLink[] = [];
	let withoutMarkdownLinks = line;
	let markdownMatch: RegExpExecArray | null = null;
	MARKDOWN_LINK_RE.lastIndex = 0;

	while ((markdownMatch = MARKDOWN_LINK_RE.exec(line)) !== null) {
		const label = markdownMatch[1]?.trim() || sourceLabelFromUrl(markdownMatch[2] || '');
		const url = cleanSourceUrl(markdownMatch[2] || '');
		if (!url) continue;
		found.push({ url, label });
	}

	withoutMarkdownLinks = withoutMarkdownLinks.replace(MARKDOWN_LINK_RE, ' ');
	PLAIN_URL_RE.lastIndex = 0;

	let plainMatch: RegExpExecArray | null = null;
	while ((plainMatch = PLAIN_URL_RE.exec(withoutMarkdownLinks)) !== null) {
		const url = cleanSourceUrl(plainMatch[0] || '');
		if (!url) continue;
		found.push({ url, label: sourceLabelFromUrl(url) });
	}

	return found;
};

const splitSourcesFromResponse = (text: string): { content: string; sources: SourceLink[] } => {
	if (!text.trim()) return { content: text, sources: [] };

	const lines = text.split('\n');
	const contentLines: string[] = [];
	const sources: SourceLink[] = [];
	const seenUrls = new Set<string>();
	let inSourcesBlock = false;

	const pushSources = (items: SourceLink[]) => {
		for (const item of items) {
			if (seenUrls.has(item.url)) continue;
			seenUrls.add(item.url);
			sources.push(item);
		}
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			if (!inSourcesBlock) contentLines.push(line);
			continue;
		}

		if (SOURCE_HEADER_RE.test(trimmed)) {
			inSourcesBlock = true;
			continue;
		}

		const hasSourcePrefix = SOURCE_PREFIX_RE.test(trimmed);
		const isBullet = /^\s*[-*]\s+/.test(line);
		const lineSources = extractSourceLinksFromLine(line);

		if (hasSourcePrefix && lineSources.length > 0) {
			pushSources(lineSources);
			continue;
		}

		if (inSourcesBlock) {
			if (lineSources.length > 0) {
				pushSources(lineSources);
				continue;
			}
			if (isBullet) {
				continue;
			}
			inSourcesBlock = false;
		}

		contentLines.push(line);
	}

	const content = contentLines
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trimEnd();
	return { content, sources };
};

const isSameCalendarDay = (left: number, right: number): boolean => {
	const leftDate = new Date(left);
	const rightDate = new Date(right);
	return (
		leftDate.getFullYear() === rightDate.getFullYear() &&
		leftDate.getMonth() === rightDate.getMonth() &&
		leftDate.getDate() === rightDate.getDate()
	);
};

const formatChatDateSeparator = (timestamp: number): string => {
	const date = new Date(timestamp);
	const now = new Date();
	const weekday = date.toLocaleDateString(undefined, { weekday: 'short' });
	const month = date.toLocaleDateString(undefined, { month: 'short' });
	const day = date.getDate();
	const year = date.getFullYear();
	return year === now.getFullYear()
		? `${weekday} ${month} ${day}`
		: `${weekday} ${month} ${day}, ${year}`;
};

// ============================================================================
// LogItem - Memoized component for individual log entries
// ============================================================================

interface LogItemProps {
	log: LogEntry;
	index: number;
	previousLogTimestamp?: number;
	hasLaterUserResponse: boolean;
	isTerminal: boolean;
	isAIMode: boolean;
	theme: Theme;
	fontFamily: string;
	maxOutputLines: number;
	outputSearchQuery: string;
	lastUserCommand?: string;
	// Expansion state
	isExpanded: boolean;
	onToggleExpanded: (logId: string) => void;
	// Local filter state
	localFilterQuery: string;
	filterMode: { mode: 'include' | 'exclude'; regex: boolean };
	activeLocalFilter: string | null;
	onToggleLocalFilter: (logId: string) => void;
	onSetLocalFilterQuery: (logId: string, query: string) => void;
	onSetFilterMode: (
		logId: string,
		update: (current: { mode: 'include' | 'exclude'; regex: boolean }) => {
			mode: 'include' | 'exclude';
			regex: boolean;
		}
	) => void;
	onClearLocalFilter: (logId: string) => void;
	// Delete state
	deleteConfirmLogId: string | null;
	onDeleteLog?: (logId: string) => number | null;
	onSetDeleteConfirmLogId: (logId: string | null) => void;
	scrollContainerRef: React.RefObject<HTMLDivElement>;
	// Other callbacks
	setLightboxImage: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	copyToClipboard: (text: string) => void;
	// ANSI converter
	ansiConverter: Convert;
	// Markdown rendering mode for AI responses (when true, shows raw text)
	markdownEditMode: boolean;
	onToggleMarkdownEditMode: () => void;
	// Replay message callback (AI mode only)
	onReplayMessage?: (text: string, images?: string[]) => void;
	// File linking support
	fileTree?: FileNode[];
	cwd?: string;
	projectRoot?: string;
	onFileClick?: (path: string) => void;
	// Error details callback - receives the specific AgentError from the log entry
	onShowErrorDetails?: (error: AgentError) => void;
	// Save to file callback (AI mode only, non-user messages)
	onSaveToFile?: (text: string) => void;
	// Message alignment
	userMessageAlignment: 'left' | 'right';
}

const LogItemComponent = memo(
	({
		log,
		index,
		previousLogTimestamp,
		hasLaterUserResponse,
		isTerminal,
		isAIMode,
		theme,
		fontFamily,
		maxOutputLines,
		outputSearchQuery,
		lastUserCommand,
		isExpanded,
		onToggleExpanded,
		localFilterQuery,
		filterMode,
		activeLocalFilter,
		onToggleLocalFilter,
		onSetLocalFilterQuery,
		onSetFilterMode,
		onClearLocalFilter,
		deleteConfirmLogId,
		onDeleteLog,
		onSetDeleteConfirmLogId,
		scrollContainerRef,
		setLightboxImage,
		copyToClipboard,
		ansiConverter,
		markdownEditMode,
		onToggleMarkdownEditMode,
		onReplayMessage,
		fileTree,
		cwd,
		projectRoot,
		onFileClick,
		onShowErrorDetails,
		onSaveToFile,
		userMessageAlignment,
	}: LogItemProps) => {
		// Ref for the log item container - used for scroll-into-view on expand
		const logItemRef = useRef<HTMLDivElement>(null);
		const previousToolStatusRef = useRef<'running' | 'completed' | 'error' | null>(null);
		const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
		const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});
		const [manualAnswer, setManualAnswer] = useState('');
		const [isSubmittingQuestionnaire, setIsSubmittingQuestionnaire] = useState(false);
		const [openDemoId, setOpenDemoId] = useState<string | null>(null);

		// Handle expand toggle with scroll adjustment
		const handleExpandToggle = useCallback(() => {
			const wasExpanded = isExpanded;
			onToggleExpanded(log.id);

			// After expanding, scroll to ensure the bottom of the item is visible
			if (!wasExpanded) {
				// Use setTimeout to wait for the DOM to update after expansion
				setTimeout(() => {
					const logItem = logItemRef.current;
					const container = scrollContainerRef.current;
					if (logItem && container) {
						const itemRect = logItem.getBoundingClientRect();
						const containerRect = container.getBoundingClientRect();

						// Check if the bottom of the item is below the visible area
						const itemBottom = itemRect.bottom;
						const containerBottom = containerRect.bottom;

						if (itemBottom > containerBottom) {
							// Scroll to show the bottom of the item with some padding
							const scrollAmount = itemBottom - containerBottom + 20; // 20px padding
							container.scrollBy({ top: scrollAmount, behavior: 'smooth' });
						}
					}
				}, 50); // Small delay to allow React to re-render
			}
		}, [isExpanded, log.id, onToggleExpanded, scrollContainerRef]);

		useEffect(() => {
			if (log.source !== 'tool') return;
			const isSearchTool = normalizeToolName(log.text).includes('search');
			if (!isSearchTool) return;
			const currentStatus = normalizeToolStatus(log.metadata?.toolState?.status);
			const previousStatus = previousToolStatusRef.current;

			// Auto-collapse expanded running search cards once they complete/fail.
			if (isExpanded && previousStatus === 'running' && currentStatus !== 'running') {
				onToggleExpanded(log.id);
			}

			previousToolStatusRef.current = currentStatus;
		}, [
			isExpanded,
			log.id,
			log.metadata?.toolState?.status,
			log.source,
			log.text,
			onToggleExpanded,
		]);

		// Helper function to highlight search matches in text
		const highlightMatches = (text: string, query: string): React.ReactNode => {
			if (!query) return text;

			const parts: React.ReactNode[] = [];
			let lastIndex = 0;
			const lowerText = text.toLowerCase();
			const lowerQuery = query.toLowerCase();
			let searchIndex = 0;

			while (searchIndex < lowerText.length) {
				const matchStart = lowerText.indexOf(lowerQuery, searchIndex);
				if (matchStart === -1) break;

				if (matchStart > lastIndex) {
					parts.push(text.substring(lastIndex, matchStart));
				}

				parts.push(
					<span
						key={`match-${matchStart}`}
						style={{
							backgroundColor: theme.colors.warning,
							color: theme.mode === 'light' ? '#fff' : '#000',
							padding: '1px 2px',
							borderRadius: '2px',
						}}
					>
						{text.substring(matchStart, matchStart + query.length)}
					</span>
				);

				lastIndex = matchStart + query.length;
				searchIndex = lastIndex;
			}

			if (lastIndex < text.length) {
				parts.push(text.substring(lastIndex));
			}

			return parts.length > 0 ? parts : text;
		};

		// Helper function to add search highlighting markers to text (before ANSI conversion)
		const addHighlightMarkers = (text: string, query: string): string => {
			if (!query) return text;

			let result = '';
			let lastIndex = 0;
			const lowerText = text.toLowerCase();
			const lowerQuery = query.toLowerCase();
			let searchIndex = 0;

			while (searchIndex < lowerText.length) {
				const matchStart = lowerText.indexOf(lowerQuery, searchIndex);
				if (matchStart === -1) break;

				result += text.substring(lastIndex, matchStart);
				result += `<mark style="background-color: ${theme.colors.warning}; color: ${theme.mode === 'light' ? '#fff' : '#000'}; padding: 1px 2px; border-radius: 2px;">`;
				result += text.substring(matchStart, matchStart + query.length);
				result += '</mark>';

				lastIndex = matchStart + query.length;
				searchIndex = lastIndex;
			}

			result += text.substring(lastIndex);
			return result;
		};

		// Strip command echo from terminal output
		let textToProcess = log.text;
		if (isTerminal && log.source !== 'user' && lastUserCommand) {
			if (textToProcess.startsWith(lastUserCommand)) {
				textToProcess = textToProcess.slice(lastUserCommand.length);
				if (textToProcess.startsWith('\r\n')) {
					textToProcess = textToProcess.slice(2);
				} else if (textToProcess.startsWith('\n') || textToProcess.startsWith('\r')) {
					textToProcess = textToProcess.slice(1);
				}
			}
		}

		const processedText = processLogTextHelper(textToProcess, isTerminal && log.source !== 'user');

		const skipEmptyStderr = log.source === 'stderr' && !processedText.trim();

		// Separate stdout and stderr for terminal output
		const separated =
			log.source === 'stderr'
				? { stdout: '', stderr: processedText }
				: { stdout: processedText, stderr: '' };

		// Apply local filter if active for this log entry
		const filteredStdout =
			localFilterQuery && log.source !== 'user'
				? filterTextByLinesHelper(
						separated.stdout,
						localFilterQuery,
						filterMode.mode,
						filterMode.regex
					)
				: separated.stdout;
		const filteredStderr =
			localFilterQuery && log.source !== 'user'
				? filterTextByLinesHelper(
						separated.stderr,
						localFilterQuery,
						filterMode.mode,
						filterMode.regex
					)
				: separated.stderr;

		// Check if filter returned no results
		const hasNoMatches =
			localFilterQuery && !filteredStdout.trim() && !filteredStderr.trim() && log.source !== 'user';

		// For stderr entries, use stderr content; for all others, use stdout content
		const contentToDisplay = log.source === 'stderr' ? filteredStderr : filteredStdout;

		// Apply search highlighting before ANSI conversion for terminal output
		const contentWithHighlights =
			isTerminal && log.source !== 'user' && outputSearchQuery
				? addHighlightMarkers(contentToDisplay, outputSearchQuery)
				: contentToDisplay;

		// PERF: Convert ANSI codes to HTML, using cache when no search highlighting is applied
		// When search is active, highlighting markers change the text so we can't use cache
		const htmlContent =
			isTerminal && log.source !== 'user'
				? outputSearchQuery
					? DOMPurify.sanitize(ansiConverter.toHtml(contentWithHighlights))
					: getCachedAnsiHtml(contentToDisplay, theme.id, ansiConverter)
				: contentToDisplay;

		const filteredText = contentToDisplay;
		const canExtractSources =
			isAIMode &&
			!isTerminal &&
			log.source !== 'user' &&
			log.source !== 'tool' &&
			log.source !== 'thinking' &&
			log.source !== 'error' &&
			!markdownEditMode;
		const { content: filteredTextWithoutSources, sources: extractedSources } = canExtractSources
			? splitSourcesFromResponse(filteredText)
			: { content: filteredText, sources: [] as SourceLink[] };
		const effectiveFilteredText = canExtractSources ? filteredTextWithoutSources : filteredText;

		// Count lines in the filtered text
		const lineCount = effectiveFilteredText.split('\n').length;
		const shouldCollapse = lineCount > maxOutputLines && maxOutputLines !== Infinity;

		// Truncate text if collapsed
		const displayText =
			shouldCollapse && !isExpanded
				? effectiveFilteredText.split('\n').slice(0, maxOutputLines).join('\n')
				: effectiveFilteredText;

		// Apply highlighting to truncated text as well
		const displayTextWithHighlights =
			shouldCollapse && !isExpanded && isTerminal && log.source !== 'user' && outputSearchQuery
				? addHighlightMarkers(displayText, outputSearchQuery)
				: displayText;

		// PERF: Sanitize with DOMPurify, using cache when no search highlighting
		const displayHtmlContent =
			shouldCollapse && !isExpanded && isTerminal && log.source !== 'user'
				? outputSearchQuery
					? DOMPurify.sanitize(ansiConverter.toHtml(displayTextWithHighlights))
					: getCachedAnsiHtml(displayText, theme.id, ansiConverter)
				: htmlContent;

		const isUserMessage = log.source === 'user';
		const isUserAiMessage = isUserMessage && isAIMode;
		const isReversed = isAIMode
			? isUserMessage && userMessageAlignment === 'right'
			: isUserMessage
				? userMessageAlignment === 'left'
				: userMessageAlignment === 'right';
		const isToolLog = log.source === 'tool';
		const isThinkingLog = log.source === 'thinking';
		const multipleChoiceQuestions =
			isAIMode &&
			!isTerminal &&
			!isUserMessage &&
			!isToolLog &&
			!isThinkingLog &&
			log.source !== 'error'
				? parseMultipleChoiceQuestions(effectiveFilteredText)
				: [];
		const activeQuestion = multipleChoiceQuestions[currentQuestionIndex];
		const questionnaireQuestionCount = multipleChoiceQuestions.length;
		const showQuestionnaire =
			questionnaireQuestionCount > 0 &&
			!!onReplayMessage &&
			!hasLaterUserResponse &&
			currentQuestionIndex < questionnaireQuestionCount;
		const isModelResponseMessage =
			isAIMode &&
			!isUserMessage &&
			!isToolLog &&
			!isThinkingLog &&
			log.source !== 'error' &&
			log.source !== 'stderr';
		const hideBubbleBorder = isToolLog || isModelResponseMessage || isUserAiMessage;
		const useStackedTimestampLayout = isAIMode && !isThinkingLog;
		const showActionButtons = !isToolLog && !isThinkingLog;
		const toolDurationMs = isToolLog ? getToolDurationMs(log) : null;
		const toolDurationLabel =
			toolDurationMs !== null && toolDurationMs >= 0 ? formatDurationMs(toolDurationMs) : null;
		const showDeliveredAtTimestamp = isUserAiMessage && !!log.delivered;
		const showDateSeparator =
			isAIMode &&
			(previousLogTimestamp === undefined ||
				!isSameCalendarDay(previousLogTimestamp, log.timestamp));
		const dateSeparatorLabel = showDateSeparator ? formatChatDateSeparator(log.timestamp) : null;
		const rowContainerClass = useStackedTimestampLayout
			? `group px-6 py-2 flex flex-col gap-1 ${isReversed ? 'items-end' : 'items-start'}`
			: `flex gap-4 group ${isReversed ? 'flex-row-reverse' : ''} px-6 py-2`;
		const timestampTimeLine = (() => {
			const logDate = new Date(log.timestamp);
			const time = logDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			return isToolLog && toolDurationLabel ? `${time} • ${toolDurationLabel}` : time;
		})();
		const timestampClass = useStackedTimestampLayout
			? `text-[10px] px-1 ${isReversed ? 'text-right' : 'text-left'}`
			: `w-20 shrink-0 text-[10px] pt-2 ${isReversed ? 'text-right' : 'text-left'}`;
		const bubbleCornerClass = useStackedTimestampLayout
			? 'rounded-xl'
			: `rounded-xl ${isReversed ? 'rounded-tr-none' : 'rounded-tl-none'}`;
		const messageWidthClass = useStackedTimestampLayout ? 'w-fit max-w-[78%]' : 'flex-1 min-w-0';
		const isDeleteConfirming = deleteConfirmLogId === log.id;
		const messageActionAreaHeightPx = isDeleteConfirming ? 34 : 30;
		const messageWrapperClass =
			isToolLog || !showActionButtons ? messageWidthClass : `${messageWidthClass} relative`;
		const messageContainerClass = isToolLog
			? 'flex-1 min-w-0 p-1 pb-1 rounded-lg relative overflow-hidden'
			: `p-4 pb-4 ${bubbleCornerClass} ${hideBubbleBorder ? '' : 'border'} relative overflow-hidden`;
		const actionBarClass = isDeleteConfirming
			? 'opacity-100 pointer-events-auto'
			: 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto';
		useEffect(() => {
			setCurrentQuestionIndex(0);
			setQuestionAnswers({});
			setManualAnswer('');
			setIsSubmittingQuestionnaire(false);
		}, [log.id, questionnaireQuestionCount]);

		const submitQuestionnaire = useCallback(
			async (answers: Record<string, string>) => {
				if (!onReplayMessage || isSubmittingQuestionnaire) return;
				const compiledAnswer = multipleChoiceQuestions
					.map((question, idx) => {
						const answer = answers[question.id];
						if (!answer) return null;
						return `${question.label || `Q${idx + 1}`}: ${answer}`;
					})
					.filter((value): value is string => !!value)
					.join('\n');
				if (!compiledAnswer) return;
				setIsSubmittingQuestionnaire(true);
				try {
					await Promise.resolve(onReplayMessage(compiledAnswer));
					setCurrentQuestionIndex(questionnaireQuestionCount);
				} finally {
					setIsSubmittingQuestionnaire(false);
				}
			},
			[
				isSubmittingQuestionnaire,
				multipleChoiceQuestions,
				onReplayMessage,
				questionnaireQuestionCount,
			]
		);

		const handleQuestionAnswer = useCallback(
			async (answer: string) => {
				if (!activeQuestion || isSubmittingQuestionnaire) return;
				const nextAnswers = {
					...questionAnswers,
					[activeQuestion.id]: answer.trim(),
				};
				setQuestionAnswers(nextAnswers);
				setManualAnswer('');
				const isLastQuestion = currentQuestionIndex >= questionnaireQuestionCount - 1;
				if (isLastQuestion) {
					await submitQuestionnaire(nextAnswers);
					return;
				}
				setCurrentQuestionIndex((prev) => prev + 1);
			},
			[
				activeQuestion,
				currentQuestionIndex,
				isSubmittingQuestionnaire,
				questionAnswers,
				questionnaireQuestionCount,
				submitQuestionnaire,
			]
		);

		if (skipEmptyStderr) {
			return null;
		}

		return (
			<>
				{showDateSeparator && dateSeparatorLabel && (
					<div className="px-6 py-2">
						<div className="flex items-center gap-3">
							<div
								className="h-px flex-1"
								style={{ backgroundColor: theme.colors.border, opacity: 0.5 }}
							/>
							<div
								className="text-[11px] px-2 py-0.5 rounded-full"
								style={{
									backgroundColor: `${theme.colors.bgActivity}cc`,
									border: `1px solid ${theme.colors.border}`,
									color: theme.colors.textDim,
								}}
							>
								{dateSeparatorLabel}
							</div>
							<div
								className="h-px flex-1"
								style={{ backgroundColor: theme.colors.border, opacity: 0.5 }}
							/>
						</div>
					</div>
				)}
				<div ref={logItemRef} className={rowContainerClass} data-log-index={index}>
					<div
						className={timestampClass}
						style={{ fontFamily, color: theme.colors.textDim, opacity: 0.6 }}
					>
						<div
							className={`inline-flex items-center gap-1 ${isReversed ? 'justify-end' : 'justify-start'}`}
						>
							<span>{timestampTimeLine}</span>
							{showDeliveredAtTimestamp && (
								<Check
									className="w-3.5 h-3.5"
									style={{ color: theme.colors.success, opacity: 0.8 }}
									aria-label="Message delivered"
								/>
							)}
						</div>
					</div>
					<div
						className={messageWrapperClass}
						style={
							showActionButtons && !isToolLog
								? { paddingBottom: `${messageActionAreaHeightPx}px` }
								: undefined
						}
					>
						<div
							className={messageContainerClass}
							style={{
								backgroundColor: isUserMessage
									? isAIMode
										? `color-mix(in srgb, ${theme.colors.accent} 20%, ${theme.colors.bgSidebar})`
										: `color-mix(in srgb, ${theme.colors.accent} 15%, ${theme.colors.bgActivity})`
									: isToolLog
										? theme.colors.bgMain
										: log.source === 'stderr' || log.source === 'error'
											? `color-mix(in srgb, ${theme.colors.error} 8%, ${theme.colors.bgActivity})`
											: isAIMode
												? theme.colors.bgMain
												: 'transparent',
								borderColor: hideBubbleBorder
									? 'transparent'
									: isUserMessage && isAIMode
										? theme.colors.accent + '40'
										: isToolLog
											? theme.colors.border
											: log.source === 'stderr' || log.source === 'error'
												? theme.colors.error
												: theme.colors.border,
								textAlign: isUserAiMessage ? 'right' : undefined,
							}}
						>
							{/* Local filter icon for system output only */}
							{log.source !== 'user' && isTerminal && (
								<div className="absolute top-2 right-2 flex items-center gap-2">
									<LogFilterControls
										logId={log.id}
										fontFamily={fontFamily}
										theme={theme}
										filterQuery={localFilterQuery}
										filterMode={filterMode}
										isActive={activeLocalFilter === log.id}
										onToggleFilter={onToggleLocalFilter}
										onSetFilterQuery={onSetLocalFilterQuery}
										onSetFilterMode={onSetFilterMode}
										onClearFilter={onClearLocalFilter}
									/>
								</div>
							)}
							{log.images && log.images.length > 0 && (
								<div
									className="flex gap-2 mb-2 overflow-x-auto scrollbar-thin"
									style={{ overscrollBehavior: 'contain' }}
								>
									{log.images.map((img, imgIdx) => (
										<button
											key={`${img}-${imgIdx}`}
											type="button"
											className="shrink-0 p-0 bg-transparent outline-none focus:ring-2 focus:ring-accent rounded"
											onClick={() => setLightboxImage(img, log.images, 'history')}
										>
											<img
												src={img}
												alt={`Terminal output image ${imgIdx + 1}`}
												className="h-20 rounded border cursor-zoom-in block"
												style={{ objectFit: 'contain', maxWidth: '200px' }}
											/>
										</button>
									))}
								</div>
							)}
							{log.source === 'stderr' && (
								<div className="mb-2">
									<span
										className="px-2 py-1 rounded text-xs font-bold uppercase tracking-wide"
										style={{
											backgroundColor: theme.colors.error,
											color: '#fff',
										}}
									>
										STDERR
									</span>
								</div>
							)}
							{/* Special rendering for error log entries */}
							{log.source === 'error' && (
								<div className="flex flex-col gap-3">
									<div className="flex items-center gap-2">
										<AlertCircle className="w-5 h-5" style={{ color: theme.colors.error }} />
										<span className="text-sm font-medium" style={{ color: theme.colors.error }}>
											Error
										</span>
									</div>
									<p className="text-sm" style={{ color: theme.colors.textMain }}>
										{log.text}
									</p>
									{!!log.agentError?.parsedJson && onShowErrorDetails && (
										<button
											onClick={() => onShowErrorDetails(log.agentError!)}
											className="self-start flex items-center gap-2 px-3 py-1.5 text-xs rounded border hover:opacity-80 transition-opacity"
											style={{
												backgroundColor: theme.colors.error + '15',
												borderColor: theme.colors.error + '40',
												color: theme.colors.error,
											}}
										>
											<Eye className="w-3 h-3" />
											View Details
										</button>
									)}
								</div>
							)}
							{/* Special rendering for thinking/streaming content (AI reasoning in real-time) */}
							{log.source === 'thinking' && (
								<div
									className="px-4 py-2 text-sm font-mono border-l-2"
									style={{
										color: theme.colors.textMain,
										borderColor: theme.colors.accent,
									}}
								>
									<div className="flex items-center gap-2 mb-1">
										<span
											className="text-[10px] px-1.5 py-0.5 rounded"
											style={{
												backgroundColor: `${theme.colors.accent}30`,
												color: theme.colors.accent,
											}}
										>
											thinking
										</span>
									</div>
									<div className="whitespace-pre-wrap text-sm break-words">
										{isAIMode && !markdownEditMode ? (
											<MarkdownRenderer
												content={log.text}
												theme={theme}
												onCopy={copyToClipboard}
												fileTree={fileTree}
												cwd={cwd}
												projectRoot={projectRoot}
												onFileClick={onFileClick}
											/>
										) : (
											log.text
										)}
									</div>
								</div>
							)}
							{/* Special rendering for tool execution events (shown alongside thinking) */}
							{log.source === 'tool' &&
								(() => {
									const toolState = log.metadata?.toolState;
									const toolStatus = normalizeToolStatus(toolState?.status);
									const normalizedToolName = normalizeToolName(log.text);
									const isSearchTool = normalizedToolName.includes('search');
									const webSearchItems =
										isWebSearchTool(log.text) || isSearchTool
											? extractWebSearchTimelineItems(toolState)
											: [];
									const hasWebSearchItems = webSearchItems.length > 0;
									const runningSearches = webSearchItems.filter(
										(item) => item.status === 'running'
									).length;
									const failedSearches = webSearchItems.filter(
										(item) => item.status === 'error'
									).length;
									const totalResults = webSearchItems.reduce(
										(total, item) => total + item.resultCount,
										0
									);
									const toolDisplay = buildToolDisplayData(toolState);
									const suppressRawSearchDetails =
										isSearchTool && toolStatus === 'running' && !hasWebSearchItems;
									const showToolDetails = toolStatus === 'running' || isExpanded;
									const collapsedSourceDomains = hasWebSearchItems
										? collectSearchSourceDomains(toolState, webSearchItems)
										: [];
									const collapsedSourceBadgeDomains = collapsedSourceDomains;
									const showCollapsedSourceBadges =
										!showToolDetails && collapsedSourceBadgeDomains.length > 0;
									const canToggleToolDetails =
										toolStatus !== 'running' &&
										(hasWebSearchItems ||
											toolDisplay.detailRows.length > 0 ||
											!!toolDisplay.outputDetail);
									const toolSummary = hasWebSearchItems
										? `${totalResults} result${totalResults === 1 ? '' : 's'} from ${webSearchItems.length} search${
												webSearchItems.length === 1 ? '' : 'es'
											}${
												runningSearches > 0
													? ` • ${runningSearches} running`
													: failedSearches > 0
														? ` • ${failedSearches} failed`
														: ''
											}`
										: suppressRawSearchDetails
											? 'Searching web…'
											: toolDisplay.summary;
									const statusLabel =
										toolStatus === 'completed'
											? '[DONE]'
											: toolStatus === 'error'
												? '[ERROR]'
												: '[RUN]';
									const statusColor =
										toolStatus === 'completed'
											? theme.colors.success
											: toolStatus === 'error'
												? theme.colors.error
												: theme.colors.warning;

									return (
										<div
											className="rounded-md px-2 py-1.5 text-[11px] font-mono"
											style={{
												color: theme.colors.textMain,
												backgroundColor: `${theme.colors.bgMain}66`,
											}}
										>
											<div className="flex items-center gap-1.5">
												<span
													className="shrink-0"
													style={{ color: statusColor }}
													aria-hidden="true"
												>
													{toolStatus === 'running' ? '◐' : '●'}
												</span>
												<span
													className="shrink-0 text-[11px] font-semibold"
													style={{ color: theme.colors.textMain }}
												>
													{log.text}
												</span>
												<span
													className="shrink-0 text-[10px] tracking-wide font-semibold uppercase"
													style={{ color: statusColor }}
												>
													{statusLabel}
												</span>
												{toolStatus === 'running' && (
													<span
														className="animate-pulse shrink-0 text-[10px]"
														style={{ color: statusColor }}
														aria-label="Tool running"
													>
														●
													</span>
												)}
												{showCollapsedSourceBadges && (
													<div className="shrink-0 flex items-center ml-1 max-w-[220px] overflow-x-auto scrollbar-thin pr-1">
														{collapsedSourceBadgeDomains.map((domain, idx) => (
															<SourceFaviconBadge
																key={`${log.id}-source-badge-${domain}`}
																domain={domain}
																overlap={idx > 0}
																theme={theme}
															/>
														))}
													</div>
												)}
												{!showToolDetails && toolSummary && (
													<span
														className="min-w-0 flex-1 truncate text-[11px]"
														style={{ color: theme.colors.textDim }}
														title={toolSummary}
													>
														{toolSummary}
													</span>
												)}
												{canToggleToolDetails && (
													<button
														type="button"
														onClick={handleExpandToggle}
														className="ml-auto flex items-center justify-center w-5 h-5 rounded border hover:opacity-80 transition-opacity"
														style={{
															color: theme.colors.textDim,
															borderColor: `${theme.colors.border}80`,
															backgroundColor: `${theme.colors.bgMain}50`,
														}}
														aria-label={
															showToolDetails ? 'Collapse tool details' : 'Expand tool details'
														}
														title={showToolDetails ? 'Collapse' : 'Expand'}
													>
														{showToolDetails ? (
															<ChevronUp className="w-3 h-3" />
														) : (
															<ChevronDown className="w-3 h-3" />
														)}
														<span className="sr-only">
															{showToolDetails ? 'Collapse tool details' : 'Expand tool details'}
														</span>
													</button>
												)}
											</div>
											{showToolDetails && (
												<div className="mt-2 space-y-1.5">
													{suppressRawSearchDetails && (
														<div
															className="text-[10px] italic"
															style={{ color: theme.colors.textDim, opacity: 0.85 }}
														>
															Searching web...
														</div>
													)}
													{hasWebSearchItems && (
														<div className="space-y-2">
															<div
																className="flex items-center justify-between text-[10px] uppercase tracking-wide"
																style={{ color: theme.colors.textDim, opacity: 0.9 }}
															>
																<span>Web Search Timeline</span>
																<span>
																	{totalResults} result{totalResults === 1 ? '' : 's'} •{' '}
																	{webSearchItems.length} search
																	{webSearchItems.length === 1 ? '' : 'es'}
																	{runningSearches > 0 ? ` • ${runningSearches} running` : ''}
																	{failedSearches > 0 ? ` • ${failedSearches} failed` : ''}
																</span>
															</div>
															<div className="space-y-1.5 max-h-64 overflow-auto pr-1">
																{webSearchItems.map((item, idx) => {
																	const searchStatusColor =
																		item.status === 'completed'
																			? theme.colors.success
																			: item.status === 'error'
																				? theme.colors.error
																				: theme.colors.warning;
																	const responseDomains = getWebSearchResponseDomains(item);
																	return (
																		<div
																			key={`${item.id}-${idx}`}
																			className="rounded border px-2 py-1.5"
																			style={{
																				borderColor: `${theme.colors.border}90`,
																				backgroundColor: `${theme.colors.bgMain}55`,
																			}}
																		>
																			<div className="flex items-start justify-between gap-3">
																				<div className="min-w-0 flex-1">
																					<div
																						className="text-[10px] font-semibold uppercase tracking-wide"
																						style={{ color: searchStatusColor }}
																					>
																						{item.status === 'completed'
																							? 'Completed'
																							: item.status === 'error'
																								? 'Failed'
																								: 'Running'}
																					</div>
																					<div
																						className="mt-1 text-[11px] break-words"
																						style={{ color: theme.colors.textMain }}
																					>
																						{item.query}
																					</div>
																				</div>
																				<div
																					className="shrink-0 text-[10px] font-semibold"
																					style={{ color: theme.colors.textDim }}
																				>
																					{item.resultCount} result
																					{item.resultCount === 1 ? '' : 's'}
																				</div>
																			</div>
																			{item.responsePreview && (
																				<div
																					className="mt-2 rounded border px-2 py-1.5 text-[10px] whitespace-pre-wrap break-words"
																					style={{
																						borderColor: `${theme.colors.border}80`,
																						backgroundColor: `${theme.colors.bgMain}45`,
																						color: theme.colors.textDim,
																					}}
																				>
																					{item.responsePreview}
																				</div>
																			)}
																			{responseDomains.length > 0 ? (
																				<div className="mt-2 space-y-1.5">
																					<div
																						className="text-[10px] uppercase tracking-wide"
																						style={{ color: theme.colors.textDim, opacity: 0.9 }}
																					>
																						Response Sources
																					</div>
																					<div className="max-w-full overflow-x-auto scrollbar-thin pr-1">
																						<div className="flex items-center min-w-max">
																							{responseDomains.map((domain, domainIdx) => (
																								<SourceFaviconBadge
																									key={`${item.id}-response-badge-${domain}`}
																									domain={domain}
																									overlap={domainIdx > 0}
																									theme={theme}
																								/>
																							))}
																						</div>
																					</div>
																					<div className="flex flex-wrap gap-1">
																						{responseDomains.map((domain) => (
																							<span
																								key={`${item.id}-response-domain-${domain}`}
																								className="px-1.5 py-0.5 rounded border text-[10px]"
																								style={{
																									borderColor: `${theme.colors.border}80`,
																									backgroundColor: `${theme.colors.bgMain}40`,
																									color: theme.colors.textDim,
																								}}
																							>
																								{domain}
																							</span>
																						))}
																					</div>
																				</div>
																			) : item.status === 'running' ? (
																				<div
																					className="mt-2 text-[10px] italic"
																					style={{ color: theme.colors.textDim, opacity: 0.8 }}
																				>
																					waiting for response sources...
																				</div>
																			) : null}
																		</div>
																	);
																})}
															</div>
														</div>
													)}
													{!hasWebSearchItems &&
														!suppressRawSearchDetails &&
														toolDisplay.detailRows.map((row) => (
															<div
																key={`${log.id}-${row.label}-${row.value}`}
																className="flex gap-2"
															>
																<span
																	className="shrink-0 uppercase tracking-wide text-[10px]"
																	style={{ color: theme.colors.textDim, opacity: 0.85 }}
																>
																	{row.label}
																</span>
																<span
																	className="break-words whitespace-pre-wrap text-[11px]"
																	style={{ color: theme.colors.textMain, opacity: 0.92 }}
																>
																	{row.value}
																</span>
															</div>
														))}
													{!hasWebSearchItems &&
														!suppressRawSearchDetails &&
														toolDisplay.outputDetail && (
															<div className="pt-1">
																<div
																	className="uppercase tracking-wide text-[10px] mb-1"
																	style={{ color: theme.colors.textDim, opacity: 0.85 }}
																>
																	output
																</div>
																<div
																	className="rounded border px-2 py-1.5 whitespace-pre-wrap break-words text-[11px] max-h-52 overflow-auto"
																	style={{
																		backgroundColor: `${theme.colors.bgMain}55`,
																		borderColor: `${theme.colors.border}80`,
																		color: theme.colors.textMain,
																	}}
																>
																	{toolDisplay.outputDetail}
																</div>
															</div>
														)}
													{toolStatus === 'running' &&
														!toolDisplay.outputDetail &&
														!suppressRawSearchDetails && (
															<div
																className="text-[10px] italic"
																style={{ color: theme.colors.textDim, opacity: 0.8 }}
															>
																Waiting for tool output...
															</div>
														)}
												</div>
											)}
										</div>
									);
								})()}
							{log.source !== 'error' &&
								log.source !== 'thinking' &&
								log.source !== 'tool' &&
								(hasNoMatches ? (
									<div
										className="flex items-center justify-center py-8 text-sm"
										style={{ color: theme.colors.textDim }}
									>
										<span>No matches found for filter</span>
									</div>
								) : shouldCollapse && !isExpanded ? (
									<div>
										<div
											className={`${isTerminal && log.source !== 'user' ? 'whitespace-pre text-sm' : 'whitespace-pre-wrap text-sm break-words'}`}
											style={{
												maxHeight: `${maxOutputLines * 1.5}em`,
												overflow: isTerminal && log.source !== 'user' ? 'hidden' : 'hidden',
												color: theme.colors.textMain,
												fontFamily,
												overflowWrap:
													isTerminal && log.source !== 'user' ? undefined : 'break-word',
											}}
										>
											{isTerminal && log.source !== 'user' ? (
												// Content sanitized with DOMPurify above
												// Horizontal scroll for terminal output to preserve column alignment
												<div
													className="overflow-x-auto scrollbar-thin"
													dangerouslySetInnerHTML={{ __html: displayHtmlContent }}
												/>
											) : log.metadata?.demoCard ? (
												<DemoCardPanel
													theme={theme}
													demoCard={log.metadata.demoCard}
													onOpen={() => setOpenDemoId(log.metadata?.demoCard?.demoId || null)}
												/>
											) : isAIMode && !markdownEditMode ? (
												// Collapsed markdown preview with rendered markdown
												<MarkdownRenderer
													content={displayText}
													theme={theme}
													onCopy={copyToClipboard}
													fileTree={fileTree}
													cwd={cwd}
													projectRoot={projectRoot}
													onFileClick={onFileClick}
												/>
											) : (
												displayText
											)}
										</div>
										<button
											onClick={handleExpandToggle}
											className="flex items-center gap-2 mt-2 text-xs px-3 py-1.5 rounded border hover:opacity-70 transition-opacity"
											style={{
												borderColor: theme.colors.border,
												backgroundColor: theme.colors.bgActivity,
												color: theme.colors.accent,
											}}
										>
											<ChevronDown className="w-3 h-3" />
											Show all {lineCount} lines
										</button>
									</div>
								) : shouldCollapse && isExpanded ? (
									<div>
										<div
											className={`${isTerminal && log.source !== 'user' ? 'whitespace-pre text-sm scrollbar-thin' : 'whitespace-pre-wrap text-sm break-words'}`}
											style={{
												maxHeight: '600px',
												overflow: 'auto',
												overscrollBehavior: 'contain',
												color: theme.colors.textMain,
												fontFamily,
												overflowWrap:
													isTerminal && log.source !== 'user' ? undefined : 'break-word',
											}}
											onWheel={(e) => {
												// Prevent scroll from propagating to parent when this container can scroll
												const el = e.currentTarget;
												const { scrollTop, scrollHeight, clientHeight } = el;
												const atTop = scrollTop <= 0;
												const atBottom = scrollTop + clientHeight >= scrollHeight - 1;

												// Only stop propagation if we're not at the boundary we're scrolling towards
												if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) {
													e.stopPropagation();
												}
											}}
										>
											{isTerminal && log.source !== 'user' ? (
												// Content sanitized with DOMPurify above
												// Horizontal scroll for terminal output to preserve column alignment
												<div dangerouslySetInnerHTML={{ __html: displayHtmlContent }} />
											) : log.source === 'user' && isTerminal ? (
												<div style={{ fontFamily }}>
													<span style={{ color: theme.colors.accent }}>$ </span>
													{highlightMatches(filteredText, outputSearchQuery)}
												</div>
											) : log.aiCommand ? (
												<div className="space-y-3">
													<div
														className="flex items-center gap-2 px-3 py-2 rounded-lg border"
														style={{
															backgroundColor: theme.colors.accent + '15',
															borderColor: theme.colors.accent + '30',
														}}
													>
														<span
															className="font-mono font-bold text-sm"
															style={{ color: theme.colors.accent }}
														>
															{log.aiCommand.command}:
														</span>
														<span className="text-sm" style={{ color: theme.colors.textMain }}>
															{log.aiCommand.description}
														</span>
													</div>
													<div>{highlightMatches(filteredText, outputSearchQuery)}</div>
												</div>
											) : log.metadata?.demoCard ? (
												<div className="space-y-3">
													<DemoCardPanel
														theme={theme}
														demoCard={log.metadata.demoCard}
														onOpen={() => setOpenDemoId(log.metadata?.demoCard?.demoId || null)}
													/>
													{effectiveFilteredText.trim().length > 0 ? (
														<div>{highlightMatches(filteredText, outputSearchQuery)}</div>
													) : null}
												</div>
											) : isAIMode && !markdownEditMode ? (
												// Expanded markdown rendering
												<MarkdownRenderer
													content={effectiveFilteredText}
													theme={theme}
													onCopy={copyToClipboard}
													fileTree={fileTree}
													cwd={cwd}
													projectRoot={projectRoot}
													onFileClick={onFileClick}
												/>
											) : (
												<div>{highlightMatches(filteredText, outputSearchQuery)}</div>
											)}
										</div>
										<button
											onClick={handleExpandToggle}
											className="flex items-center gap-2 mt-2 text-xs px-3 py-1.5 rounded border hover:opacity-70 transition-opacity"
											style={{
												borderColor: theme.colors.border,
												backgroundColor: theme.colors.bgActivity,
												color: theme.colors.accent,
											}}
										>
											<ChevronUp className="w-3 h-3" />
											Show less
										</button>
									</div>
								) : (
									<>
										{isTerminal && log.source !== 'user' ? (
											// Content sanitized with DOMPurify above
											<div
												className="whitespace-pre text-sm overflow-x-auto scrollbar-thin"
												style={{
													color: theme.colors.textMain,
													fontFamily,
													overscrollBehavior: 'contain',
												}}
												dangerouslySetInnerHTML={{ __html: displayHtmlContent }}
											/>
										) : log.source === 'user' && isTerminal ? (
											<div
												className="whitespace-pre-wrap text-sm break-words"
												style={{ color: theme.colors.textMain, fontFamily }}
											>
												<span style={{ color: theme.colors.accent }}>$ </span>
												{highlightMatches(filteredText, outputSearchQuery)}
											</div>
										) : log.aiCommand ? (
											<div className="space-y-3">
												<div
													className="flex items-center gap-2 px-3 py-2 rounded-lg border"
													style={{
														backgroundColor: theme.colors.accent + '15',
														borderColor: theme.colors.accent + '30',
													}}
												>
													<span
														className="font-mono font-bold text-sm"
														style={{ color: theme.colors.accent }}
													>
														{log.aiCommand.command}:
													</span>
													<span className="text-sm" style={{ color: theme.colors.textMain }}>
														{log.aiCommand.description}
													</span>
												</div>
												<div
													className="whitespace-pre-wrap text-sm break-words"
													style={{ color: theme.colors.textMain }}
												>
													{highlightMatches(filteredText, outputSearchQuery)}
												</div>
											</div>
										) : log.metadata?.demoCard ? (
											<div className="space-y-3">
												<DemoCardPanel
													theme={theme}
													demoCard={log.metadata.demoCard}
													onOpen={() => setOpenDemoId(log.metadata?.demoCard?.demoId || null)}
												/>
												{effectiveFilteredText.trim().length > 0 ? (
													<div
														className="whitespace-pre-wrap text-sm break-words"
														style={{ color: theme.colors.textMain }}
													>
														{highlightMatches(filteredText, outputSearchQuery)}
													</div>
												) : null}
											</div>
										) : isAIMode && !markdownEditMode ? (
											// Rendered markdown for AI responses
											<MarkdownRenderer
												content={effectiveFilteredText}
												theme={theme}
												onCopy={copyToClipboard}
												fileTree={fileTree}
												cwd={cwd}
												projectRoot={projectRoot}
												onFileClick={onFileClick}
											/>
										) : (
											// Raw markdown source mode (show original text with markdown syntax visible)
											<div
												className="whitespace-pre-wrap text-sm break-words"
												style={{ color: theme.colors.textMain }}
											>
												{highlightMatches(filteredText, outputSearchQuery)}
											</div>
										)}
									</>
								))}
							{showQuestionnaire && activeQuestion && (
								<div
									className="mt-4 space-y-3 rounded-lg border p-3"
									style={{
										borderColor: `${theme.colors.accent}35`,
										backgroundColor: `${theme.colors.accent}10`,
									}}
								>
									<div
										className="text-[11px] font-semibold uppercase tracking-wide"
										style={{ color: theme.colors.accent }}
									>
										Quick reply
									</div>
									<div
										className="text-[11px] uppercase tracking-wide"
										style={{ color: theme.colors.textDim }}
									>
										Question {currentQuestionIndex + 1} of {questionnaireQuestionCount}
									</div>
									{activeQuestion.prompt && (
										<div className="text-sm" style={{ color: theme.colors.textMain }}>
											{activeQuestion.prompt}
										</div>
									)}
									<div className="flex flex-wrap gap-2">
										{activeQuestion.options.map((option) => (
											<button
												key={`${activeQuestion.id}-${option.replyValue}`}
												type="button"
												className="rounded-md border px-3 py-2 text-left transition-opacity hover:opacity-85 disabled:cursor-wait disabled:opacity-60"
												style={{
													borderColor: option.isRecommended
														? `${theme.colors.accent}80`
														: `${theme.colors.border}cc`,
													backgroundColor: option.isRecommended
														? `${theme.colors.accent}18`
														: `${theme.colors.bgMain}b3`,
													color: theme.colors.textMain,
												}}
												onClick={() => {
													void handleQuestionAnswer(option.replyValue);
												}}
												disabled={isSubmittingQuestionnaire}
												title={option.description || `Reply with ${option.replyValue}`}
											>
												<span className="block text-sm font-semibold">
													Option {option.label}
													{option.isRecommended ? ' (Recommended)' : ''}
												</span>
												{option.description && (
													<span
														className="mt-1 block text-xs"
														style={{ color: theme.colors.textDim }}
													>
														{option.description}
													</span>
												)}
											</button>
										))}
									</div>
									{activeQuestion.manualAnswerOption && (
										<div className="space-y-2">
											<div className="text-xs" style={{ color: theme.colors.textDim }}>
												{activeQuestion.manualAnswerOption.label}: answer in your own words.
											</div>
											<div className="flex flex-col gap-2 sm:flex-row">
												<input
													type="text"
													value={manualAnswer}
													onChange={(e) => setManualAnswer(e.target.value)}
													placeholder={
														activeQuestion.manualAnswerOption.description || 'Type your answer'
													}
													className="min-w-0 flex-1 rounded-md border px-3 py-2 text-sm outline-none"
													style={{
														borderColor: `${theme.colors.border}cc`,
														backgroundColor: `${theme.colors.bgMain}cc`,
														color: theme.colors.textMain,
													}}
													disabled={isSubmittingQuestionnaire}
												/>
												<button
													type="button"
													className="rounded-md border px-3 py-2 text-sm font-semibold transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-60"
													style={{
														borderColor: `${theme.colors.accent}60`,
														backgroundColor: `${theme.colors.accent}18`,
														color: theme.colors.accent,
													}}
													onClick={() => {
														void handleQuestionAnswer(manualAnswer);
													}}
													disabled={!manualAnswer.trim() || isSubmittingQuestionnaire}
												>
													Use custom answer
												</button>
											</div>
										</div>
									)}
									{isSubmittingQuestionnaire && (
										<div
											className="text-[10px] uppercase tracking-wide"
											style={{ color: theme.colors.accent }}
										>
											Sending answers...
										</div>
									)}
								</div>
							)}
							{extractedSources.length > 0 && (
								<details
									className="mt-3 rounded-lg border px-3 py-2"
									style={{
										borderColor: `${theme.colors.border}90`,
										backgroundColor: `${theme.colors.bgMain}55`,
									}}
								>
									{(() => {
										const summaryDomains = Array.from(
											new Set(
												extractedSources
													.map((source) => sourceDomainFromUrl(source.url))
													.filter((value): value is string => !!value)
											)
										);
										return (
											<summary
												className="cursor-pointer select-none text-xs font-semibold flex items-center gap-2"
												style={{ color: theme.colors.textDim }}
											>
												<span>Sources ({extractedSources.length})</span>
												{summaryDomains.length > 0 && (
													<span className="flex items-center max-w-[220px] overflow-x-auto scrollbar-thin pr-1">
														{summaryDomains.map((domain, idx) => (
															<SourceFaviconBadge
																key={`${log.id}-response-source-${domain}`}
																domain={domain}
																overlap={idx > 0}
																theme={theme}
															/>
														))}
													</span>
												)}
											</summary>
										);
									})()}
									<div className="mt-2 space-y-1.5">
										{extractedSources.map((source, idx) => {
											const sourceDomain = sourceDomainFromUrl(source.url);
											return (
												<button
													key={`${source.url}-${idx}`}
													type="button"
													className="w-full text-left text-xs hover:opacity-80 transition-opacity"
													style={{ color: theme.colors.accent }}
													onClick={() => {
														void window.maestro.shell.openExternal(source.url);
													}}
													title={source.url}
												>
													<span className="flex items-center gap-2 min-w-0">
														{sourceDomain && (
															<SourceFaviconBadge
																domain={sourceDomain}
																overlap={false}
																theme={theme}
															/>
														)}
														<span className="truncate underline decoration-dotted">
															{source.label}
														</span>
														{sourceDomain && (
															<span
																className="shrink-0 text-[10px]"
																style={{ color: theme.colors.textDim }}
															>
																{sourceDomain}
															</span>
														)}
													</span>
												</button>
											);
										})}
									</div>
								</details>
							)}
						</div>
						{/* Action buttons - positioned below the bubble */}
						{showActionButtons && (
							<div
								className={`absolute bottom-0 right-0 flex items-center gap-1 ${actionBarClass}`}
								style={{ transition: 'opacity 0.15s ease-in-out' }}
							>
								{/* Markdown toggle button for AI responses */}
								{log.source !== 'user' && isAIMode && (
									<button
										onClick={onToggleMarkdownEditMode}
										className="p-1.5 rounded hover:opacity-100 transition-opacity"
										style={{
											color: markdownEditMode ? theme.colors.accent : theme.colors.textDim,
										}}
										title={
											markdownEditMode
												? `Show formatted (${formatShortcutKeys(['Meta', 'e'])})`
												: `Show plain text (${formatShortcutKeys(['Meta', 'e'])})`
										}
									>
										{markdownEditMode ? (
											<Eye className="w-4 h-4" />
										) : (
											<FileText className="w-4 h-4" />
										)}
									</button>
								)}
								{/* Replay button for user messages in AI mode */}
								{isUserMessage && isAIMode && onReplayMessage && (
									<button
										onClick={() => onReplayMessage(log.text, log.images)}
										className="p-1.5 rounded hover:opacity-100 transition-opacity"
										style={{ color: theme.colors.textDim }}
										title="Replay message"
									>
										<RotateCcw className="w-3.5 h-3.5" />
									</button>
								)}
								{/* Copy to Clipboard Button */}
								<button
									onClick={() => copyToClipboard(log.text)}
									className="p-1.5 rounded hover:opacity-100 transition-opacity"
									style={{ color: theme.colors.textDim }}
									title="Copy to clipboard"
								>
									<Copy className="w-3.5 h-3.5" />
								</button>
								{/* Save to File Button - only for AI responses */}
								{log.source !== 'user' && isAIMode && onSaveToFile && (
									<button
										onClick={() => onSaveToFile(log.text)}
										className="p-1.5 rounded hover:opacity-100 transition-opacity"
										style={{ color: theme.colors.textDim }}
										title="Save to file"
									>
										<Save className="w-3.5 h-3.5" />
									</button>
								)}
								{/* Delete button for user messages (both AI and terminal modes) */}
								{log.source === 'user' &&
									onDeleteLog &&
									(isDeleteConfirming ? (
										<div
											className="flex items-center gap-1 p-1 rounded border"
											style={{
												backgroundColor: theme.colors.bgSidebar,
												borderColor: theme.colors.error,
											}}
										>
											<span className="text-xs px-1" style={{ color: theme.colors.error }}>
												Delete?
											</span>
											<button
												onClick={() => {
													const nextIndex = onDeleteLog(log.id);
													onSetDeleteConfirmLogId(null);
													if (nextIndex !== null && nextIndex >= 0) {
														setTimeout(() => {
															const container = scrollContainerRef.current;
															const items = container?.querySelectorAll('[data-log-index]');
															const targetItem = items?.[nextIndex] as HTMLElement;
															if (targetItem && container) {
																container.scrollTop = targetItem.offsetTop;
															}
														}, 50);
													}
												}}
												className="px-2 py-0.5 rounded text-xs font-medium hover:opacity-80"
												style={{ backgroundColor: theme.colors.error, color: '#fff' }}
											>
												Yes
											</button>
											<button
												onClick={() => onSetDeleteConfirmLogId(null)}
												className="px-2 py-0.5 rounded text-xs hover:opacity-80"
												style={{ color: theme.colors.textDim }}
											>
												No
											</button>
										</div>
									) : (
										<button
											onClick={() => onSetDeleteConfirmLogId(log.id)}
											className="p-1.5 rounded hover:opacity-100 transition-opacity"
											style={{ color: theme.colors.textDim }}
											title={isAIMode ? 'Delete message and response' : 'Delete command and output'}
										>
											<Trash2 className="w-3.5 h-3.5" />
										</button>
									))}
							</div>
						)}
					</div>
				</div>
				{openDemoId && (
					<DemoViewerModal theme={theme} demoId={openDemoId} onClose={() => setOpenDemoId(null)} />
				)}
			</>
		);
	},
	(prevProps, nextProps) => {
		// Custom comparison - only re-render if these specific props change
		// IMPORTANT: Include ALL props that affect visual rendering
		return (
			prevProps.log.id === nextProps.log.id &&
			prevProps.log.timestamp === nextProps.log.timestamp &&
			prevProps.log.text === nextProps.log.text &&
			prevProps.log.delivered === nextProps.log.delivered &&
			prevProps.log.readOnly === nextProps.log.readOnly &&
			prevProps.log.metadata === nextProps.log.metadata &&
			prevProps.log.agentError === nextProps.log.agentError &&
			prevProps.isExpanded === nextProps.isExpanded &&
			prevProps.localFilterQuery === nextProps.localFilterQuery &&
			prevProps.filterMode.mode === nextProps.filterMode.mode &&
			prevProps.filterMode.regex === nextProps.filterMode.regex &&
			prevProps.activeLocalFilter === nextProps.activeLocalFilter &&
			prevProps.deleteConfirmLogId === nextProps.deleteConfirmLogId &&
			prevProps.outputSearchQuery === nextProps.outputSearchQuery &&
			prevProps.theme === nextProps.theme &&
			prevProps.maxOutputLines === nextProps.maxOutputLines &&
			prevProps.markdownEditMode === nextProps.markdownEditMode &&
			prevProps.fontFamily === nextProps.fontFamily &&
			prevProps.previousLogTimestamp === nextProps.previousLogTimestamp &&
			prevProps.userMessageAlignment === nextProps.userMessageAlignment
		);
	}
);

LogItemComponent.displayName = 'LogItemComponent';

// ============================================================================
// ElapsedTimeDisplay - Separate component for elapsed time
// ============================================================================

// Separate component for elapsed time to prevent re-renders of the entire list
const ElapsedTimeDisplay = memo(
	({ thinkingStartTime, textColor }: { thinkingStartTime: number; textColor: string }) => {
		const [elapsedSeconds, setElapsedSeconds] = useState(() =>
			Math.floor((Date.now() - thinkingStartTime) / 1000)
		);

		useEffect(() => {
			// Update every second
			const interval = setInterval(() => {
				setElapsedSeconds(Math.floor((Date.now() - thinkingStartTime) / 1000));
			}, 1000);

			return () => clearInterval(interval);
		}, [thinkingStartTime]);

		// Format elapsed time as mm:ss or hh:mm:ss
		const formatElapsedTime = (seconds: number): string => {
			const hours = Math.floor(seconds / 3600);
			const minutes = Math.floor((seconds % 3600) / 60);
			const secs = seconds % 60;

			if (hours > 0) {
				return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
			}
			return `${minutes}:${secs.toString().padStart(2, '0')}`;
		};

		return (
			<span className="text-sm font-mono" style={{ color: textColor }}>
				{formatElapsedTime(elapsedSeconds)}
			</span>
		);
	}
);

interface TerminalOutputProps {
	session: Session;
	theme: Theme;
	fontFamily: string;
	activeFocus: FocusArea;
	outputSearchOpen: boolean;
	outputSearchQuery: string;
	setOutputSearchOpen: (open: boolean) => void;
	setOutputSearchQuery: (query: string) => void;
	setActiveFocus: (focus: FocusArea) => void;
	setLightboxImage: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	inputRef: React.RefObject<HTMLTextAreaElement>;
	logsEndRef: React.RefObject<HTMLDivElement>;
	maxOutputLines: number;
	onDeleteLog?: (logId: string) => number | null; // Returns the index to scroll to after deletion
	onRemoveQueuedItem?: (itemId: string) => void; // Callback to remove a queued item from execution queue
	onInterrupt?: () => void; // Callback to interrupt the current process
	onScrollPositionChange?: (scrollTop: number) => void; // Callback to save scroll position
	onAtBottomChange?: (isAtBottom: boolean) => void; // Callback when user scrolls to/away from bottom
	initialScrollTop?: number; // Initial scroll position to restore
	markdownEditMode: boolean; // Whether to show raw markdown or rendered markdown for AI responses
	setMarkdownEditMode: (value: boolean) => void; // Toggle markdown mode
	onReplayMessage?: (text: string, images?: string[]) => void; // Replay a user message
	onSubmitUserInputRequest?: (
		request: UserInputRequest,
		response: UserInputResponse
	) => Promise<void>; // Respond to a live Codex request_user_input prompt
	fileTree?: FileNode[]; // File tree for linking file references
	cwd?: string; // Current working directory for proximity-based matching
	projectRoot?: string; // Project root absolute path for converting absolute paths to relative
	onFileClick?: (path: string) => void; // Callback when a file link is clicked
	onShowErrorDetails?: (error: AgentError) => void; // Callback to show the error modal (for error log entries)
	onFileSaved?: () => void; // Callback when markdown content is saved to file (e.g., to refresh file list)
	autoScrollAiMode?: boolean; // Whether to auto-scroll in AI mode (like terminal mode)
	setAutoScrollAiMode?: (value: boolean) => void; // Toggle auto-scroll in AI mode
	userMessageAlignment?: 'left' | 'right'; // User message bubble alignment (default: right)
	onOpenInTab?: (file: {
		path: string;
		name: string;
		content: string;
		sshRemoteId?: string;
	}) => void; // Callback to open saved file in a tab
}

// PERFORMANCE: Wrap in React.memo to prevent re-renders when parent re-renders
// but TerminalOutput's props haven't changed. This is critical because TerminalOutput
// can render many log entries and is expensive to re-render.
export const TerminalOutput = memo(
	forwardRef<HTMLDivElement, TerminalOutputProps>((props, ref) => {
		const {
			session,
			theme,
			fontFamily,
			activeFocus: _activeFocus,
			outputSearchOpen,
			outputSearchQuery,
			setOutputSearchOpen,
			setOutputSearchQuery,
			setActiveFocus,
			setLightboxImage,
			inputRef,
			logsEndRef,
			maxOutputLines,
			onDeleteLog,
			onRemoveQueuedItem,
			onInterrupt: _onInterrupt,
			onScrollPositionChange,
			onAtBottomChange,
			initialScrollTop,
			markdownEditMode,
			setMarkdownEditMode,
			onReplayMessage,
			onSubmitUserInputRequest,
			fileTree,
			cwd,
			projectRoot,
			onFileClick,
			onShowErrorDetails,
			onFileSaved,
			autoScrollAiMode,
			setAutoScrollAiMode,
			userMessageAlignment = 'right',
			onOpenInTab,
		} = props;

		// Use the forwarded ref if provided, otherwise create a local one
		const localRef = useRef<HTMLDivElement>(null);
		const terminalOutputRef = (ref as React.RefObject<HTMLDivElement>) || localRef;

		// Scroll container ref for native scrolling
		const scrollContainerRef = useRef<HTMLDivElement>(null);

		// Track which log entries are expanded (by log ID)
		const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
		// Use a ref to access current value without recreating LogItem callback
		const expandedLogsRef = useRef(expandedLogs);
		expandedLogsRef.current = expandedLogs;
		// Counter to force re-render of LogItem when expanded state changes
		const [_expandedTrigger, setExpandedTrigger] = useState(0);

		// Track local filters per log entry (log ID -> filter query)
		const [localFilters, setLocalFilters] = useState<Map<string, string>>(new Map());
		// Use refs to access current values without recreating LogItem callback
		const localFiltersRef = useRef(localFilters);
		localFiltersRef.current = localFilters;
		const [activeLocalFilter, setActiveLocalFilter] = useState<string | null>(null);
		const activeLocalFilterRef = useRef(activeLocalFilter);
		activeLocalFilterRef.current = activeLocalFilter;
		// Counter to force re-render when local filter state changes
		const [_filterTrigger, setFilterTrigger] = useState(0);

		// Track filter modes per log entry (log ID -> {mode: 'include'|'exclude', regex: boolean})
		const [filterModes, setFilterModes] = useState<
			Map<string, { mode: 'include' | 'exclude'; regex: boolean }>
		>(new Map());
		const filterModesRef = useRef(filterModes);
		filterModesRef.current = filterModes;

		// Delete confirmation state
		const [deleteConfirmLogId, setDeleteConfirmLogId] = useState<string | null>(null);
		const deleteConfirmLogIdRef = useRef(deleteConfirmLogId);
		deleteConfirmLogIdRef.current = deleteConfirmLogId;
		// Counter to force re-render when delete confirmation changes
		const [_deleteConfirmTrigger, _setDeleteConfirmTrigger] = useState(0);

		// Copy to clipboard notification state
		const [showCopiedNotification, setShowCopiedNotification] = useState(false);

		// Save markdown modal state
		const [saveModalContent, setSaveModalContent] = useState<string | null>(null);

		// New message indicator state
		const [isAtBottom, setIsAtBottom] = useState(true);
		const [hasNewMessages, setHasNewMessages] = useState(false);
		const [newMessageCount, setNewMessageCount] = useState(0);
		const lastLogCountRef = useRef(0);
		// Track previous isAtBottom to detect changes for callback
		const prevIsAtBottomRef = useRef(true);
		// Ref mirror of isAtBottom for MutationObserver closure (avoids stale state)
		const isAtBottomRef = useRef(true);
		isAtBottomRef.current = isAtBottom;
		// Track whether auto-scroll is paused because user scrolled up (state so button re-renders)
		const [autoScrollPaused, setAutoScrollPaused] = useState(false);
		// Guard flag: prevents the scroll handler from pausing auto-scroll
		// during programmatic scrollTo() calls from the MutationObserver effect.
		const isProgrammaticScrollRef = useRef(false);

		// Track read state per tab - stores the log count when user scrolled to bottom
		const tabReadStateRef = useRef<Map<string, number>>(new Map());

		// Throttle timer ref for scroll position saves
		const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		// Track if initial scroll restore has been done
		const hasRestoredScrollRef = useRef(false);

		// Get active tab ID for resetting state on tab switch
		const activeTabId = session.inputMode === 'ai' ? session.activeTabId : null;
		const [pendingQuestionIndex, setPendingQuestionIndex] = useState(0);
		const [pendingQuestionAnswers, setPendingQuestionAnswers] = useState<Record<string, string[]>>(
			{}
		);
		const [pendingManualAnswer, setPendingManualAnswer] = useState('');
		const [pendingUsingOtherInput, setPendingUsingOtherInput] = useState(false);
		const [isSubmittingPendingRequest, setIsSubmittingPendingRequest] = useState(false);

		// Copy text to clipboard with notification
		const copyToClipboard = useCallback(async (text: string) => {
			const ok = await safeClipboardWrite(text);
			if (ok) {
				setShowCopiedNotification(true);
				setTimeout(() => setShowCopiedNotification(false), 1500);
			}
		}, []);

		// Open save modal for markdown content
		const handleSaveToFile = useCallback((text: string) => {
			setSaveModalContent(text);
		}, []);

		// Layer stack integration for search overlay
		const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
		const layerIdRef = useRef<string>();

		// Register layer when search is open
		useEffect(() => {
			if (outputSearchOpen) {
				layerIdRef.current = registerLayer({
					type: 'overlay',
					priority: MODAL_PRIORITIES.SLASH_AUTOCOMPLETE, // Use same priority as slash autocomplete (low priority)
					blocksLowerLayers: false,
					capturesFocus: true,
					focusTrap: 'none',
					onEscape: () => {
						setOutputSearchOpen(false);
						setOutputSearchQuery('');
						terminalOutputRef.current?.focus();
					},
					allowClickOutside: true,
					ariaLabel: 'Output Search',
				});

				return () => {
					if (layerIdRef.current) {
						unregisterLayer(layerIdRef.current);
					}
				};
			}
		}, [outputSearchOpen, registerLayer, unregisterLayer]);

		// Update the handler when dependencies change
		useEffect(() => {
			if (outputSearchOpen && layerIdRef.current) {
				updateLayerHandler(layerIdRef.current, () => {
					setOutputSearchOpen(false);
					setOutputSearchQuery('');
					terminalOutputRef.current?.focus();
				});
			}
		}, [outputSearchOpen, updateLayerHandler]);

		const toggleExpanded = useCallback((logId: string) => {
			setExpandedLogs((prev) => {
				const newSet = new Set(prev);
				if (newSet.has(logId)) {
					newSet.delete(logId);
				} else {
					newSet.add(logId);
				}
				return newSet;
			});
			// Trigger re-render after state update
			setExpandedTrigger((t) => t + 1);
		}, []);

		const toggleLocalFilter = useCallback((logId: string) => {
			setActiveLocalFilter((prev) => (prev === logId ? null : logId));
			setFilterTrigger((t) => t + 1);
		}, []);

		const setLocalFilterQuery = useCallback((logId: string, query: string) => {
			setLocalFilters((prev) => {
				const newMap = new Map(prev);
				if (query) {
					newMap.set(logId, query);
				} else {
					newMap.delete(logId);
				}
				return newMap;
			});
		}, []);

		// Callback to update filter mode for a log entry
		const setFilterModeForLog = useCallback(
			(
				logId: string,
				update: (current: { mode: 'include' | 'exclude'; regex: boolean }) => {
					mode: 'include' | 'exclude';
					regex: boolean;
				}
			) => {
				setFilterModes((prev) => {
					const newMap = new Map(prev);
					const current = newMap.get(logId) || { mode: 'include' as const, regex: false };
					newMap.set(logId, update(current));
					return newMap;
				});
			},
			[]
		);

		// Callback to clear local filter for a log entry
		const clearLocalFilter = useCallback(
			(logId: string) => {
				setActiveLocalFilter(null);
				setLocalFilterQuery(logId, '');
				setFilterModes((prev) => {
					const newMap = new Map(prev);
					newMap.delete(logId);
					return newMap;
				});
			},
			[setLocalFilterQuery]
		);

		// Callback to toggle markdown mode
		const toggleMarkdownEditMode = useCallback(() => {
			setMarkdownEditMode(!markdownEditMode);
		}, [markdownEditMode, setMarkdownEditMode]);

		// Auto-focus on search input when opened
		useEffect(() => {
			if (outputSearchOpen) {
				terminalOutputRef.current?.querySelector('input')?.focus();
			}
		}, [outputSearchOpen]);

		// Create ANSI converter with theme-aware colors
		const ansiConverter = useMemo(() => {
			return new Convert({
				fg: theme.colors.textMain,
				bg: theme.colors.bgMain,
				newline: false,
				escapeXML: true,
				stream: false,
				colors: {
					0: theme.colors.textMain, // black -> textMain
					1: theme.colors.error, // red -> error
					2: theme.colors.success, // green -> success
					3: theme.colors.warning, // yellow -> warning
					4: theme.colors.accent, // blue -> accent
					5: theme.colors.accentDim, // magenta -> accentDim
					6: theme.colors.accent, // cyan -> accent
					7: theme.colors.textDim, // white -> textDim
				},
			});
		}, [theme]);

		// PERF: Memoize active tab lookup to avoid O(n) .find() on every render
		const activeTab = useMemo(
			() => (session.inputMode === 'ai' ? getActiveTab(session) : undefined),
			[session.inputMode, session.aiTabs, session.activeTabId]
		);
		const pendingUserInputRequest = activeTab?.pendingUserInputRequest ?? null;
		const activePendingQuestion = pendingUserInputRequest?.questions[pendingQuestionIndex] ?? null;
		const showPendingUserInputRequest =
			!!pendingUserInputRequest &&
			pendingQuestionIndex < pendingUserInputRequest.questions.length &&
			!!onSubmitUserInputRequest;

		// PERF: Memoize activeLogs to provide stable reference for collapsedLogs dependency
		const activeLogs = useMemo(
			(): LogEntry[] => (session.inputMode === 'ai' ? (activeTab?.logs ?? []) : session.shellLogs),
			[session.inputMode, activeTab?.logs, session.shellLogs]
		);

		useEffect(() => {
			setPendingQuestionIndex(0);
			setPendingQuestionAnswers({});
			setPendingManualAnswer('');
			setPendingUsingOtherInput(false);
			setIsSubmittingPendingRequest(false);
		}, [pendingUserInputRequest?.requestId]);

		const submitPendingRequestAnswers = useCallback(
			async (answers: Record<string, string[]>) => {
				if (!pendingUserInputRequest || !onSubmitUserInputRequest || isSubmittingPendingRequest) {
					return;
				}
				setIsSubmittingPendingRequest(true);
				try {
					await Promise.resolve(
						onSubmitUserInputRequest(pendingUserInputRequest, {
							answers: Object.fromEntries(
								Object.entries(answers).map(([questionId, values]) => [
									questionId,
									{ answers: values },
								])
							),
						})
					);
					setPendingQuestionIndex(pendingUserInputRequest.questions.length);
				} finally {
					setIsSubmittingPendingRequest(false);
				}
			},
			[isSubmittingPendingRequest, onSubmitUserInputRequest, pendingUserInputRequest]
		);

		const handlePendingQuestionAnswer = useCallback(
			async (answers: string[]) => {
				if (!activePendingQuestion || isSubmittingPendingRequest) return;
				const normalizedAnswers = answers.map((answer) => answer.trim()).filter(Boolean);
				if (normalizedAnswers.length === 0) return;
				const nextAnswers = {
					...pendingQuestionAnswers,
					[activePendingQuestion.id]: normalizedAnswers,
				};
				setPendingQuestionAnswers(nextAnswers);
				setPendingManualAnswer('');
				setPendingUsingOtherInput(false);

				const isLastQuestion =
					!!pendingUserInputRequest &&
					pendingQuestionIndex >= pendingUserInputRequest.questions.length - 1;
				if (isLastQuestion) {
					await submitPendingRequestAnswers(nextAnswers);
					return;
				}

				setPendingQuestionIndex((prev) => prev + 1);
			},
			[
				activePendingQuestion,
				isSubmittingPendingRequest,
				pendingQuestionAnswers,
				pendingQuestionIndex,
				pendingUserInputRequest,
				submitPendingRequestAnswers,
			]
		);

		// In AI mode, collapse consecutive non-user entries into single response blocks
		// This provides a cleaner view where each user message gets one response
		// Tool and thinking entries are kept separate (not collapsed)
		const collapsedLogs = useMemo(() => {
			// Only collapse in AI mode
			if (session.inputMode !== 'ai') return activeLogs;

			const result: LogEntry[] = [];
			let currentResponseGroup: LogEntry[] = [];

			// Helper to flush accumulated response group
			const flushResponseGroup = () => {
				if (currentResponseGroup.length > 0) {
					// Combine all response entries into one
					const combinedText = currentResponseGroup.map((l) => l.text).join('');
					result.push({
						...currentResponseGroup[0],
						text: combinedText,
						// Keep the first entry's timestamp and id
					});
					currentResponseGroup = [];
				}
			};

			for (const log of activeLogs) {
				if (log.source === 'user') {
					// Flush any accumulated response group before user message
					flushResponseGroup();
					result.push(log);
				} else if (log.source === 'tool' || log.source === 'thinking') {
					// Flush response group before tool/thinking, then add tool/thinking separately
					flushResponseGroup();
					result.push(log);
				} else {
					// Accumulate non-user entries (AI responses)
					currentResponseGroup.push(log);
				}
			}

			// Flush final response group
			flushResponseGroup();

			return result;
		}, [activeLogs, session.inputMode]);

		// PERF: Debounce search query to avoid filtering on every keystroke
		const debouncedSearchQuery = useDebouncedValue(outputSearchQuery, 150);

		// Filter logs based on search query - memoized for performance
		// Uses debounced query to reduce CPU usage during rapid typing
		const filteredLogs = useMemo(() => {
			if (!debouncedSearchQuery) return collapsedLogs;
			const lowerQuery = debouncedSearchQuery.toLowerCase();
			return collapsedLogs.filter((log) => log.text.toLowerCase().includes(lowerQuery));
		}, [collapsedLogs, debouncedSearchQuery]);

		// PERF: Throttle scroll handler to reduce state updates (4ms = ~240fps for smooth scrollbar)
		// The actual logic is in handleScrollInner, wrapped with useThrottledCallback
		const handleScrollInner = useCallback(() => {
			if (!scrollContainerRef.current) return;
			const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
			// Consider "at bottom" if within 50px of the bottom
			const atBottom = scrollHeight - scrollTop - clientHeight < 50;
			setIsAtBottom(atBottom);

			// Notify parent when isAtBottom changes (for hasUnread logic)
			if (atBottom !== prevIsAtBottomRef.current) {
				prevIsAtBottomRef.current = atBottom;
				onAtBottomChange?.(atBottom);
			}

			// Clear new message indicator when user scrolls to bottom
			if (atBottom) {
				setHasNewMessages(false);
				setNewMessageCount(0);
				// Resume auto-scroll when user scrolls back to bottom
				setAutoScrollPaused(false);
				// Save read state for current tab
				if (activeTabId) {
					tabReadStateRef.current.set(activeTabId, filteredLogs.length);
				}
			} else if (autoScrollAiMode) {
				if (isProgrammaticScrollRef.current) {
					// This scroll event was triggered by our own scrollTo() call —
					// consume the guard flag here inside the throttled handler to avoid
					// the race where queueMicrotask clears the flag before a deferred
					// throttled invocation fires (throttle delay is 16ms > microtask).
					isProgrammaticScrollRef.current = false;
				} else {
					// Genuine user scroll away from bottom — pause auto-scroll
					setAutoScrollPaused(true);
				}
			}

			// Throttled scroll position save (200ms)
			if (onScrollPositionChange) {
				if (scrollSaveTimerRef.current) {
					clearTimeout(scrollSaveTimerRef.current);
				}
				scrollSaveTimerRef.current = setTimeout(() => {
					onScrollPositionChange(scrollTop);
					scrollSaveTimerRef.current = null;
				}, 200);
			}
		}, [
			activeTabId,
			filteredLogs.length,
			onScrollPositionChange,
			onAtBottomChange,
			autoScrollAiMode,
		]);

		// PERF: Throttle at 16ms (60fps) instead of 4ms to reduce state updates during scroll
		const handleScroll = useThrottledCallback(handleScrollInner, 16);

		// Restore read state when switching tabs
		useEffect(() => {
			if (!activeTabId) {
				// Terminal mode - just reset
				setHasNewMessages(false);
				setNewMessageCount(0);
				setIsAtBottom(true);
				lastLogCountRef.current = filteredLogs.length;
				return;
			}

			// Restore saved read state for this tab
			const savedReadCount = tabReadStateRef.current.get(activeTabId);
			const currentCount = filteredLogs.length;

			if (savedReadCount !== undefined) {
				// Tab was visited before - check for new messages since last read
				const unreadCount = currentCount - savedReadCount;
				if (unreadCount > 0) {
					setHasNewMessages(true);
					setNewMessageCount(unreadCount);
					setIsAtBottom(false);
				} else {
					setHasNewMessages(false);
					setNewMessageCount(0);
					setIsAtBottom(true);
				}
			} else {
				// First visit to this tab - mark all as read
				tabReadStateRef.current.set(activeTabId, currentCount);
				setHasNewMessages(false);
				setNewMessageCount(0);
				setIsAtBottom(true);
			}

			lastLogCountRef.current = currentCount;
		}, [activeTabId]); // Only run when tab changes, not when filteredLogs changes

		// Detect new messages when user is not at bottom (while staying on same tab).
		// NOTE: This intentionally uses filteredLogs.length (not the MutationObserver) because
		// unread badge counts should only increment on NEW log entries, not on in-place text
		// updates (thinking stream growth). The MutationObserver handles scroll triggering;
		// this effect handles the unread badge.
		useEffect(() => {
			const currentCount = filteredLogs.length;
			if (currentCount > lastLogCountRef.current) {
				// Check actual scroll position, not just state (state may be stale)
				const container = scrollContainerRef.current;
				let actuallyAtBottom = isAtBottom;
				if (container) {
					const { scrollTop, scrollHeight, clientHeight } = container;
					actuallyAtBottom = scrollHeight - scrollTop - clientHeight < 50;
				}

				if (!actuallyAtBottom) {
					const newCount = currentCount - lastLogCountRef.current;
					setHasNewMessages(true);
					setNewMessageCount((prev) => prev + newCount);
					// Also update isAtBottom state to match reality
					setIsAtBottom(false);
				} else {
					// At bottom, update read state
					if (activeTabId) {
						tabReadStateRef.current.set(activeTabId, currentCount);
					}
				}
			}
			lastLogCountRef.current = currentCount;
		}, [filteredLogs.length, isAtBottom, activeTabId]);

		// Reset auto-scroll pause when user explicitly re-enables auto-scroll (button or shortcut)
		useEffect(() => {
			if (autoScrollAiMode) {
				setAutoScrollPaused(false);
			}
		}, [autoScrollAiMode]);

		// Auto-scroll to bottom when DOM content changes in the scroll container.
		// Uses MutationObserver to detect ALL content mutations — new nodes (log entries),
		// text changes (thinking stream growth), and attribute changes (tool status updates).
		// This replaces the previous filteredLogs.length dependency, which missed in-place
		// text updates during thinking/tool streaming (GitHub issue #402).
		useEffect(() => {
			const container = scrollContainerRef.current;
			if (!container) return;

			const shouldAutoScroll = () =>
				session.inputMode === 'terminal' ||
				(session.inputMode === 'ai' && autoScrollAiMode && !autoScrollPaused) ||
				(session.inputMode === 'ai' && isAtBottomRef.current);

			const scrollToBottom = () => {
				if (!scrollContainerRef.current) return;
				requestAnimationFrame(() => {
					if (scrollContainerRef.current) {
						// Set guard flag BEFORE scrollTo — the throttled scroll handler
						// checks this flag and consumes it (clears it) when it fires,
						// preventing the programmatic scroll from being misinterpreted
						// as a user scroll-up that should pause auto-scroll.
						isProgrammaticScrollRef.current = true;
						scrollContainerRef.current.scrollTo({
							top: scrollContainerRef.current.scrollHeight,
							behavior: 'auto',
						});
						// Fallback: if scrollTo is a no-op (already at bottom), the browser
						// won't fire a scroll event, so the handler never consumes the guard.
						// Clear it after 32ms (2x the 16ms throttle window) to prevent a
						// stale true from eating the next genuine user scroll-up.
						setTimeout(() => {
							isProgrammaticScrollRef.current = false;
						}, 32);
					}
				});
			};

			// Initial scroll on mount/dep change
			if (shouldAutoScroll()) {
				scrollToBottom();
			}

			const observer = new MutationObserver(() => {
				if (shouldAutoScroll()) {
					scrollToBottom();
				}
			});

			observer.observe(container, {
				childList: true, // New/removed DOM nodes (new log entries, tool events)
				subtree: true, // Watch all descendants, not just direct children
				characterData: true, // Text node mutations (thinking stream text growth)
			});

			return () => observer.disconnect();
		}, [session.inputMode, autoScrollAiMode, autoScrollPaused]);

		// Restore scroll position when component mounts or initialScrollTop changes
		// Uses requestAnimationFrame to ensure DOM is ready
		useEffect(() => {
			// Only restore if we have a saved position and haven't restored yet for this mount
			if (initialScrollTop !== undefined && initialScrollTop > 0 && !hasRestoredScrollRef.current) {
				hasRestoredScrollRef.current = true;
				requestAnimationFrame(() => {
					if (scrollContainerRef.current) {
						const { scrollHeight, clientHeight } = scrollContainerRef.current;
						// Clamp to max scrollable area
						const maxScroll = Math.max(0, scrollHeight - clientHeight);
						const targetScroll = Math.min(initialScrollTop, maxScroll);
						scrollContainerRef.current.scrollTop = targetScroll;
					}
				});
			}
		}, [initialScrollTop]);

		// Reset restore flag when session/tab changes (handled by key prop on TerminalOutput)
		useEffect(() => {
			hasRestoredScrollRef.current = false;
		}, [session.id, activeTabId]);

		// Cleanup throttle timer on unmount
		useEffect(() => {
			return () => {
				if (scrollSaveTimerRef.current) {
					clearTimeout(scrollSaveTimerRef.current);
				}
			};
		}, []);

		// Helper to find last user command for echo stripping in terminal mode
		const getLastUserCommand = useCallback(
			(index: number): string | undefined => {
				for (let i = index - 1; i >= 0; i--) {
					if (filteredLogs[i]?.source === 'user') {
						return filteredLogs[i].text;
					}
				}
				return undefined;
			},
			[filteredLogs]
		);

		// Computed values for rendering
		const isTerminal = session.inputMode === 'terminal';
		const isAIMode = session.inputMode === 'ai';

		// Memoized prose styles - applied once at container level instead of per-log-item
		// IMPORTANT: Scoped to .terminal-output to avoid CSS conflicts with other prose containers (e.g., AutoRun panel)
		const proseStyles = useMemo(
			() => generateTerminalProseStyles(theme, '.terminal-output'),
			[theme]
		);

		const isAutoScrollActive = autoScrollAiMode && !autoScrollPaused;

		return (
			<div
				ref={terminalOutputRef}
				tabIndex={0}
				role="region"
				aria-label="Terminal output"
				className="terminal-output flex-1 flex flex-col overflow-hidden transition-colors outline-none relative"
				style={{
					backgroundColor:
						session.inputMode === 'ai' ? theme.colors.bgMain : theme.colors.bgActivity,
				}}
				onKeyDown={(e) => {
					// Cmd+F to open search
					if (e.key === 'f' && (e.metaKey || e.ctrlKey) && !outputSearchOpen) {
						e.preventDefault();
						setOutputSearchOpen(true);
						return;
					}
					// Escape handling removed - delegated to layer stack for search
					// When search is not open, Escape should still focus back to input
					if (e.key === 'Escape' && !outputSearchOpen) {
						e.preventDefault();
						e.stopPropagation();
						// Focus back to text input
						inputRef.current?.focus();
						setActiveFocus('main');
						return;
					}
					// Arrow key scrolling (instant, no smooth behavior)
					// Plain arrow keys: scroll by ~100px
					if (e.key === 'ArrowUp' && !e.metaKey && !e.ctrlKey && !e.altKey) {
						e.preventDefault();
						scrollContainerRef.current?.scrollBy({ top: -100 });
						return;
					}
					if (e.key === 'ArrowDown' && !e.metaKey && !e.ctrlKey && !e.altKey) {
						e.preventDefault();
						scrollContainerRef.current?.scrollBy({ top: 100 });
						return;
					}
					// Option/Alt+Up: page up
					if (e.key === 'ArrowUp' && e.altKey && !e.metaKey && !e.ctrlKey) {
						e.preventDefault();
						const height = terminalOutputRef.current?.clientHeight || 400;
						scrollContainerRef.current?.scrollBy({ top: -height });
						return;
					}
					// Option/Alt+Down: page down
					if (e.key === 'ArrowDown' && e.altKey && !e.metaKey && !e.ctrlKey) {
						e.preventDefault();
						const height = terminalOutputRef.current?.clientHeight || 400;
						scrollContainerRef.current?.scrollBy({ top: height });
						return;
					}
					// Cmd+Up to jump to top
					if (e.key === 'ArrowUp' && (e.metaKey || e.ctrlKey) && !e.altKey) {
						e.preventDefault();
						scrollContainerRef.current?.scrollTo({ top: 0 });
						return;
					}
					// Cmd+Down to jump to bottom
					if (e.key === 'ArrowDown' && (e.metaKey || e.ctrlKey) && !e.altKey) {
						e.preventDefault();
						const container = scrollContainerRef.current;
						if (container) {
							container.scrollTo({ top: container.scrollHeight });
						}
						return;
					}
				}}
			>
				{/* Output Search */}
				{outputSearchOpen && (
					<div className="sticky top-0 z-10 pb-4">
						<input
							type="text"
							value={outputSearchQuery}
							onChange={(e) => setOutputSearchQuery(e.target.value)}
							placeholder={
								isAIMode ? 'Filter output... (Esc to close)' : 'Search output... (Esc to close)'
							}
							className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
							style={{
								borderColor: theme.colors.accent,
								color: theme.colors.textMain,
								backgroundColor: theme.colors.bgSidebar,
							}}
						/>
					</div>
				)}
				{/* Prose styles for markdown rendering - injected once at container level for performance */}
				<style>{proseStyles}</style>
				{/* Native scroll log list */}
				{/* overflow-anchor: disabled in AI mode when auto-scroll is off to prevent
				    browser from automatically keeping viewport pinned to bottom on new content */}
				<div
					ref={scrollContainerRef}
					className="flex-1 overflow-y-auto scrollbar-thin"
					style={{
						overflowAnchor:
							session.inputMode === 'ai' && (!autoScrollAiMode || autoScrollPaused)
								? 'none'
								: undefined,
					}}
					onScroll={handleScroll}
				>
					{/* Log entries */}
					{filteredLogs.map((log, index) => (
						<LogItemComponent
							key={log.id}
							log={log}
							index={index}
							previousLogTimestamp={index > 0 ? filteredLogs[index - 1].timestamp : undefined}
							hasLaterUserResponse={filteredLogs
								.slice(index + 1)
								.some((entry) => entry.source === 'user')}
							isTerminal={isTerminal}
							isAIMode={isAIMode}
							theme={theme}
							fontFamily={fontFamily}
							maxOutputLines={maxOutputLines}
							outputSearchQuery={outputSearchQuery}
							lastUserCommand={
								isTerminal && log.source !== 'user' ? getLastUserCommand(index) : undefined
							}
							isExpanded={expandedLogs.has(log.id)}
							onToggleExpanded={toggleExpanded}
							localFilterQuery={localFilters.get(log.id) || ''}
							filterMode={filterModes.get(log.id) || { mode: 'include', regex: false }}
							activeLocalFilter={activeLocalFilter}
							onToggleLocalFilter={toggleLocalFilter}
							onSetLocalFilterQuery={setLocalFilterQuery}
							onSetFilterMode={setFilterModeForLog}
							onClearLocalFilter={clearLocalFilter}
							deleteConfirmLogId={deleteConfirmLogId}
							onDeleteLog={onDeleteLog}
							onSetDeleteConfirmLogId={setDeleteConfirmLogId}
							scrollContainerRef={scrollContainerRef}
							setLightboxImage={setLightboxImage}
							copyToClipboard={copyToClipboard}
							ansiConverter={ansiConverter}
							markdownEditMode={markdownEditMode}
							onToggleMarkdownEditMode={toggleMarkdownEditMode}
							onReplayMessage={onReplayMessage}
							fileTree={fileTree}
							cwd={cwd}
							projectRoot={projectRoot}
							onFileClick={onFileClick}
							onShowErrorDetails={onShowErrorDetails}
							onSaveToFile={handleSaveToFile}
							userMessageAlignment={userMessageAlignment}
						/>
					))}

					{/* Terminal busy indicator - only show for terminal commands (AI thinking moved to ThinkingStatusPill) */}
					{session.state === 'busy' &&
						session.inputMode === 'terminal' &&
						session.busySource === 'terminal' && (
							<div
								className="flex flex-col items-center justify-center gap-2 py-6 mx-6 my-4 rounded-xl border"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
								}}
							>
								<div className="flex items-center gap-3">
									<div
										className="w-2 h-2 rounded-full animate-pulse"
										style={{ backgroundColor: theme.colors.warning }}
									/>
									<span className="text-sm" style={{ color: theme.colors.textMain }}>
										{session.statusMessage || 'Executing command...'}
									</span>
									{session.thinkingStartTime && (
										<ElapsedTimeDisplay
											thinkingStartTime={session.thinkingStartTime}
											textColor={theme.colors.textDim}
										/>
									)}
								</div>
							</div>
						)}

					{/* Queued items section - only show in AI mode, filtered to active tab */}
					{session.inputMode === 'ai' &&
						session.executionQueue &&
						session.executionQueue.length > 0 && (
							<QueuedItemsList
								executionQueue={session.executionQueue}
								theme={theme}
								onRemoveQueuedItem={onRemoveQueuedItem}
								activeTabId={activeTabId || undefined}
							/>
						)}

					{showPendingUserInputRequest && activePendingQuestion && (
						<div className="px-6 py-3">
							<div
								className="rounded-xl border p-4"
								style={{
									backgroundColor: theme.colors.bgMain,
									borderColor: theme.colors.accent,
								}}
							>
								<div
									className="text-[11px] uppercase tracking-[0.16em]"
									style={{ color: theme.colors.accent }}
								>
									{activePendingQuestion.header} • Question {pendingQuestionIndex + 1} of{' '}
									{pendingUserInputRequest.questions.length}
								</div>
								<div className="mt-2 text-sm font-medium" style={{ color: theme.colors.textMain }}>
									{activePendingQuestion.question}
								</div>
								<div className="mt-3 flex flex-col gap-2">
									{(activePendingQuestion.options || []).map((option) => (
										<button
											key={option.label}
											type="button"
											className="w-full rounded-lg border px-3 py-2 text-left transition-colors"
											style={{
												borderColor: theme.colors.border,
												backgroundColor: theme.colors.bgSidebar,
												color: theme.colors.textMain,
											}}
											onClick={() => void handlePendingQuestionAnswer([option.label])}
											disabled={isSubmittingPendingRequest}
										>
											<div className="text-sm font-medium">{option.label}</div>
											<div className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
												{option.description}
											</div>
										</button>
									))}
								</div>
								{activePendingQuestion.isOther && (
									<div className="mt-3">
										{!pendingUsingOtherInput ? (
											<button
												type="button"
												className="rounded-lg border px-3 py-2 text-sm"
												style={{
													borderColor: theme.colors.border,
													color: theme.colors.textDim,
												}}
												onClick={() => setPendingUsingOtherInput(true)}
												disabled={isSubmittingPendingRequest}
											>
												Type another answer
											</button>
										) : (
											<div className="flex flex-col gap-2">
												<textarea
													value={pendingManualAnswer}
													onChange={(e) => setPendingManualAnswer(e.target.value)}
													placeholder="Type your answer"
													className="min-h-[88px] rounded-lg border px-3 py-2 text-sm outline-none"
													style={{
														borderColor: theme.colors.border,
														backgroundColor: theme.colors.bgSidebar,
														color: theme.colors.textMain,
													}}
												/>
												<div className="flex gap-2">
													<button
														type="button"
														className="rounded-lg px-3 py-2 text-sm"
														style={{
															backgroundColor: theme.colors.accent,
															color: theme.colors.accentForeground,
														}}
														onClick={() => void handlePendingQuestionAnswer([pendingManualAnswer])}
														disabled={isSubmittingPendingRequest || !pendingManualAnswer.trim()}
													>
														Continue
													</button>
													<button
														type="button"
														className="rounded-lg border px-3 py-2 text-sm"
														style={{
															borderColor: theme.colors.border,
															color: theme.colors.textDim,
														}}
														onClick={() => {
															setPendingUsingOtherInput(false);
															setPendingManualAnswer('');
														}}
														disabled={isSubmittingPendingRequest}
													>
														Cancel
													</button>
												</div>
											</div>
										)}
									</div>
								)}
							</div>
						</div>
					)}

					{/* End ref for scrolling - always rendered so Cmd+Shift+J works even when busy */}
					<div ref={logsEndRef} />
				</div>

				{/* Auto-scroll toggle — positioned opposite AI response side (AI mode only) */}
				{/* Visible when: has content AND (not at bottom (dimmed, click to pin) OR pinned at bottom (accent, click to unpin)) */}
				{session.inputMode === 'ai' &&
					setAutoScrollAiMode &&
					filteredLogs.length > 0 &&
					(!isAtBottom || isAutoScrollActive) && (
						<button
							onClick={() => {
								if (isAutoScrollActive && isAtBottom) {
									// Currently pinned at bottom — unpin
									setAutoScrollAiMode(false);
								} else {
									// Not pinned — jump to bottom and pin
									setAutoScrollPaused(false);
									setAutoScrollAiMode(true);
									setHasNewMessages(false);
									setNewMessageCount(0);
									if (scrollContainerRef.current) {
										scrollContainerRef.current.scrollTo({
											top: scrollContainerRef.current.scrollHeight,
											behavior: 'smooth',
										});
									}
								}
							}}
							className={`absolute bottom-4 ${userMessageAlignment === 'right' ? 'left-6' : 'right-6'} flex items-center gap-2 px-3 py-2 rounded-full shadow-lg transition-all hover:scale-105 z-20 outline-none`}
							style={{
								backgroundColor: isAutoScrollActive
									? theme.colors.accent
									: hasNewMessages
										? theme.colors.accent
										: theme.colors.bgSidebar,
								color: isAutoScrollActive
									? theme.colors.accentForeground
									: hasNewMessages
										? theme.colors.accentForeground
										: theme.colors.textDim,
								border: `1px solid ${isAutoScrollActive || hasNewMessages ? 'transparent' : theme.colors.border}`,
								animation:
									hasNewMessages && !isAutoScrollActive
										? 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite'
										: undefined,
							}}
							title={
								isAutoScrollActive
									? 'Auto-scroll ON (click to unpin)'
									: hasNewMessages
										? 'New messages (click to pin to bottom)'
										: 'Scroll to bottom (click to pin)'
							}
						>
							<ArrowDown className="w-4 h-4" />
							{newMessageCount > 0 && !isAutoScrollActive && (
								<span className="text-xs font-bold">
									{newMessageCount > 99 ? '99+' : newMessageCount}
								</span>
							)}
						</button>
					)}

				{/* Copied to Clipboard Notification */}
				{showCopiedNotification && (
					<div
						className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 px-6 py-4 rounded-lg shadow-2xl text-base font-bold animate-in fade-in zoom-in-95 duration-200 z-50"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
							textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
						}}
					>
						Copied to Clipboard
					</div>
				)}

				{/* Save Markdown Modal */}
				{saveModalContent !== null && (
					<SaveMarkdownModal
						theme={theme}
						content={saveModalContent}
						onClose={() => setSaveModalContent(null)}
						defaultFolder={cwd || session.cwd || ''}
						isRemoteSession={
							session.sessionSshRemoteConfig?.enabled && !!session.sessionSshRemoteConfig?.remoteId
						}
						sshRemoteId={
							session.sessionSshRemoteConfig?.enabled
								? (session.sessionSshRemoteConfig?.remoteId ?? undefined)
								: undefined
						}
						onFileSaved={onFileSaved}
						onOpenInTab={onOpenInTab}
					/>
				)}
			</div>
		);
	})
);

TerminalOutput.displayName = 'TerminalOutput';
