import type { WebRemoteToolState } from './remote-web';

export interface ToolDetailRow {
	label: string;
	value: string;
}

export interface ToolDisplayData {
	summary: string | null;
	detailRows: ToolDetailRow[];
	outputDetail: string | null;
}

export interface WebSearchTimelineItem {
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

const URL_DOMAIN_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
const SITE_FILTER_GLOBAL_RE = /\bsite:([^\s]+)/gi;

const safeStr = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const safeCommand = (value: unknown): string | null => {
	if (typeof value === 'string') return value;
	if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) {
		return value.join(' ');
	}
	return null;
};

const truncateStr = (value: unknown, max: number): string | null => {
	const text = safeStr(value);
	if (!text) return null;
	return text.length > max ? text.substring(0, max) + '\u2026' : text;
};

const summarizeTodos = (value: unknown): string | null => {
	if (!Array.isArray(value) || value.length === 0) return null;
	const todos = value as Array<{ content?: string; status?: string; activeForm?: string }>;
	const completed = todos.filter((todo) => todo.status === 'completed').length;
	const inProgress = todos.find((todo) => todo.status === 'in_progress');
	const label = inProgress?.activeForm || inProgress?.content || todos[0]?.content;
	if (!label) return `${todos.length} tasks`;
	return `${label} (${completed}/${todos.length})`;
};

const summarizeToolOutput = (value: unknown): string | null => {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string') {
		const compact = value.replace(/\s+/g, ' ').trim();
		return compact.length > 140 ? compact.substring(0, 140) + '\u2026' : compact;
	}
	try {
		const json = JSON.stringify(value);
		if (!json) return null;
		return json.length > 140 ? json.substring(0, 140) + '\u2026' : json;
	} catch {
		return null;
	}
};

const summarizeToolValue = (value: unknown, max = 160): string | null => {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string') {
		const compact = value.replace(/\s+/g, ' ').trim();
		if (!compact) return null;
		return compact.length > max ? compact.substring(0, max) + '\u2026' : compact;
	}
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		const asCommand = safeCommand(value);
		if (asCommand) return summarizeToolValue(asCommand, max);
		try {
			const json = JSON.stringify(value);
			return json.length > max ? json.substring(0, max) + '\u2026' : json;
		} catch {
			return null;
		}
	}
	try {
		const json = JSON.stringify(value);
		if (!json) return null;
		return json.length > max ? json.substring(0, max) + '\u2026' : json;
	} catch {
		return null;
	}
};

const formatToolDetailValue = (value: unknown, max = 2400): string | null => {
	if (value === null || value === undefined) return null;
	let text: string;
	if (typeof value === 'string') {
		text = value.trim();
		if (!text) return null;
	} else if (typeof value === 'number' || typeof value === 'boolean') {
		text = String(value);
	} else if (Array.isArray(value)) {
		const asCommand = safeCommand(value);
		if (asCommand) {
			text = asCommand;
		} else {
			try {
				text = JSON.stringify(value, null, 2);
			} catch {
				return null;
			}
		}
	} else {
		try {
			text = JSON.stringify(value, null, 2);
		} catch {
			return null;
		}
	}

	return text.length > max
		? text.substring(0, max) + `\n... [truncated ${text.length - max} chars]`
		: text;
};

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

export const normalizeToolStatus = (status: unknown): 'running' | 'completed' | 'error' => {
	if (status === 'completed' || status === 'success') return 'completed';
	if (status === 'error' || status === 'failed') return 'error';
	return 'running';
};

export const normalizeToolName = (toolName: string): string =>
	toolName.toLowerCase().replace(/_/g, ':');

export const isWebSearchTool = (toolName: string): boolean =>
	normalizeToolName(toolName) === 'web:search';

export const buildToolDisplayData = (
	toolState: WebRemoteToolState | undefined
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

const cleanDetectedUrl = (value: string): string => value.trim().replace(/[),.;:!?]+$/, '');

export const normalizeDomain = (value: string): string | null => {
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

export const extractUrlsFromUnknown = (value: unknown, maxUrls = 32): string[] => {
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

export const extractDomainsFromUnknown = (value: unknown, maxDomains = 8): string[] => {
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

const extractSiteFilter = (query: string): string | null => {
	const match = query.match(/\bsite:([^\s]+)/i);
	return match?.[1] || null;
};

export const extractWebSearchTimelineItems = (
	toolState: WebRemoteToolState | undefined
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

	return items.sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
};

export const collectSearchSourceDomains = (
	toolState: WebRemoteToolState | undefined,
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

export const getWebSearchResponseDomains = (item: WebSearchTimelineItem): string[] => {
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

export const formatDurationMs = (durationMs: number): string => {
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

export const getToolDurationMs = (
	toolState: WebRemoteToolState | undefined,
	logTimestamp: number
): number | null => {
	if (!toolState) return null;
	const stateRecord = asRecord(toolState);
	if (!stateRecord) return null;

	const explicitDurationCandidates = [
		stateRecord.durationMs,
		stateRecord.duration_ms,
		stateRecord.elapsedMs,
		stateRecord.elapsed_ms,
		stateRecord.executionTimeMs,
	];

	for (const candidate of explicitDurationCandidates) {
		const duration = asFiniteNumber(candidate);
		if (duration !== null && duration >= 0) return duration;
	}

	const timing = asRecord(stateRecord.timing);
	const startTimestamp =
		asFiniteNumber(stateRecord.startTimestamp) ??
		asFiniteNumber(stateRecord.startedAt) ??
		asFiniteNumber(timing?.startTimestamp) ??
		asFiniteNumber(timing?.startedAt);
	const endTimestamp =
		asFiniteNumber(stateRecord.endTimestamp) ??
		asFiniteNumber(stateRecord.completedAt) ??
		asFiniteNumber(timing?.endTimestamp) ??
		asFiniteNumber(timing?.completedAt);
	const status = normalizeToolStatus(stateRecord.status);

	if (startTimestamp === null) return null;
	const resolvedEnd = endTimestamp ?? (status === 'running' ? Date.now() : logTimestamp);
	if (!Number.isFinite(resolvedEnd) || resolvedEnd < startTimestamp) return null;
	return resolvedEnd - startTimestamp;
};
