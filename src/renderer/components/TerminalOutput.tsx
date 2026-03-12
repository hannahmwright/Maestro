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
import { ToolActivityBlock } from './ToolActivityBlock';
import { ToolActivityPanel } from './ToolActivityPanel';
import { generateTerminalProseStyles } from '../utils/markdownConfig';
import { safeClipboardWrite } from '../utils/clipboard';
import { parseMultipleChoiceQuestions } from '../utils/multipleChoiceQuestions';
import { normalizeToolStatus } from '../../shared/tool-display';
import type { UserInputRequest, UserInputResponse } from '../../shared/user-input-requests';

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

const summarizeTurnLabel = (text: string | null | undefined): string => {
	const normalized = (text || '').replace(/\s+/g, ' ').trim();
	if (!normalized) return 'Untitled turn';
	if (normalized.length <= 48) return normalized;
	return `${normalized.slice(0, 45).trimEnd()}...`;
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
		const showDeliveredAtTimestamp = isUserAiMessage && !!log.delivered;
		const showDateSeparator =
			isAIMode &&
			(previousLogTimestamp === undefined ||
				!isSameCalendarDay(previousLogTimestamp, log.timestamp));
		const dateSeparatorLabel = showDateSeparator ? formatChatDateSeparator(log.timestamp) : null;
		const rowContainerClass = useStackedTimestampLayout
			? `group px-6 py-2 flex flex-col gap-1 ${isReversed ? 'items-end' : 'items-start'}`
			: `flex gap-4 group ${isReversed ? 'flex-row-reverse' : ''} px-6 py-2`;
		const timestampTimeLine = new Date(log.timestamp).toLocaleTimeString([], {
			hour: '2-digit',
			minute: '2-digit',
		});
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
				<div
					ref={logItemRef}
					className={rowContainerClass}
					data-log-id={log.id}
					data-log-index={index}
				>
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
							{log.source === 'tool' && (
								<ToolActivityBlock
									log={log}
									theme={theme}
									expanded={isExpanded}
									onToggleExpanded={handleExpandToggle}
								/>
							)}
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
	jumpToLogId?: string | null; // Scroll to a specific log entry on demand
	onJumpToLogHandled?: (logId: string) => void; // Called after a jump request has been processed
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

interface UserTurnMarker {
	id: string;
	offsetTop: number;
	ratio: number;
	label: string;
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
			jumpToLogId,
			onJumpToLogHandled,
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
		const userTurnMeasureFrameRef = useRef<number | null>(null);

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
		const [userTurnMarkers, setUserTurnMarkers] = useState<UserTurnMarker[]>([]);
		const userTurnMarkersRef = useRef<UserTurnMarker[]>([]);
		userTurnMarkersRef.current = userTurnMarkers;
		const [activeUserTurnId, setActiveUserTurnId] = useState<string | null>(null);
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
		const latestTurnToolLogs = useMemo(() => {
			if (session.inputMode !== 'ai') return [];

			let latestUserIndex = -1;
			for (let index = activeLogs.length - 1; index >= 0; index -= 1) {
				if (activeLogs[index]?.source === 'user') {
					latestUserIndex = index;
					break;
				}
			}

			return activeLogs
				.slice(latestUserIndex >= 0 ? latestUserIndex + 1 : 0)
				.filter((log) => log.source === 'tool');
		}, [activeLogs, session.inputMode]);
		const latestTurnToolLogRefs = useMemo(() => new Set(latestTurnToolLogs), [latestTurnToolLogs]);
		const displayLogs = useMemo(() => {
			if (session.inputMode !== 'ai' || latestTurnToolLogs.length === 0) {
				return activeLogs;
			}

			return activeLogs.filter((log) => !latestTurnToolLogRefs.has(log));
		}, [activeLogs, latestTurnToolLogRefs, latestTurnToolLogs.length, session.inputMode]);
		const toolPanelInsertLogId = useMemo(() => {
			if (session.inputMode !== 'ai' || latestTurnToolLogs.length === 0) {
				return null;
			}

			let latestUserIndex = -1;
			for (let index = displayLogs.length - 1; index >= 0; index -= 1) {
				if (displayLogs[index]?.source === 'user') {
					latestUserIndex = index;
					break;
				}
			}

			for (let index = latestUserIndex + 1; index < displayLogs.length; index += 1) {
				const entry = displayLogs[index];
				if (entry?.source !== 'user') {
					return entry.id;
				}
			}

			return null;
		}, [displayLogs, latestTurnToolLogs.length, session.inputMode]);
		const isToolPanelBusy = useMemo(
			() =>
				latestTurnToolLogs.some(
					(log) => normalizeToolStatus(log.metadata?.toolState?.status) === 'running'
				) ||
				(session.inputMode === 'ai' && session.state === 'busy'),
			[latestTurnToolLogs, session.inputMode, session.state]
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
			if (session.inputMode !== 'ai') return displayLogs;

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

			for (const log of displayLogs) {
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
		}, [displayLogs, session.inputMode]);

		// PERF: Debounce search query to avoid filtering on every keystroke
		const debouncedSearchQuery = useDebouncedValue(outputSearchQuery, 150);

		// Filter logs based on search query - memoized for performance
		// Uses debounced query to reduce CPU usage during rapid typing
		const filteredLogs = useMemo(() => {
			if (!debouncedSearchQuery) return collapsedLogs;
			const lowerQuery = debouncedSearchQuery.toLowerCase();
			return collapsedLogs.filter((log) => log.text.toLowerCase().includes(lowerQuery));
		}, [collapsedLogs, debouncedSearchQuery]);

		const showToolActivityPanel =
			session.inputMode === 'ai' && latestTurnToolLogs.length > 0 && !debouncedSearchQuery;

		const syncActiveUserTurn = useCallback(() => {
			const markers = userTurnMarkersRef.current;
			const container = scrollContainerRef.current;
			if (!container || markers.length === 0) {
				setActiveUserTurnId(null);
				return;
			}

			const referenceTop = container.scrollTop + Math.min(96, container.clientHeight * 0.2);
			let nextActiveId = markers[0].id;
			for (const marker of markers) {
				if (marker.offsetTop <= referenceTop) {
					nextActiveId = marker.id;
				} else {
					break;
				}
			}
			setActiveUserTurnId(nextActiveId);
		}, []);

		const recomputeUserTurnMarkers = useCallback(() => {
			const container = scrollContainerRef.current;
			if (!container || session.inputMode !== 'ai') {
				setUserTurnMarkers([]);
				setActiveUserTurnId(null);
				return;
			}

			const userLogs = filteredLogs.filter((log) => log.source === 'user');
			if (userLogs.length === 0) {
				setUserTurnMarkers([]);
				setActiveUserTurnId(null);
				return;
			}

			const elements = Array.from(container.querySelectorAll<HTMLElement>('[data-log-id]'));
			const elementById = new Map(
				elements
					.map((element) => {
						const logId = element.dataset.logId;
						return logId ? ([logId, element] as const) : null;
					})
					.filter((entry): entry is readonly [string, HTMLElement] => Boolean(entry))
			);
			const maxScrollable = Math.max(container.scrollHeight - container.clientHeight, 1);
			const nextMarkers = userLogs
				.map((log) => {
					const element = elementById.get(log.id);
					if (!element) {
						return null;
					}

					return {
						id: log.id,
						offsetTop: element.offsetTop,
						ratio: Math.max(0, Math.min(1, element.offsetTop / maxScrollable)),
						label: summarizeTurnLabel(log.text),
					} satisfies UserTurnMarker;
				})
				.filter((marker): marker is UserTurnMarker => Boolean(marker));

			setUserTurnMarkers(nextMarkers);
			requestAnimationFrame(() => {
				syncActiveUserTurn();
			});
		}, [filteredLogs, session.inputMode, syncActiveUserTurn]);

		const scheduleUserTurnMeasurement = useCallback(() => {
			if (userTurnMeasureFrameRef.current !== null) {
				cancelAnimationFrame(userTurnMeasureFrameRef.current);
			}
			userTurnMeasureFrameRef.current = requestAnimationFrame(() => {
				userTurnMeasureFrameRef.current = null;
				recomputeUserTurnMarkers();
			});
		}, [recomputeUserTurnMarkers]);

		const scrollToLog = useCallback(
			(logId: string, onHandled?: (handledLogId: string) => void) => {
				const container = scrollContainerRef.current;
				const target = Array.from(
					container?.querySelectorAll<HTMLElement>('[data-log-id]') || []
				).find((element) => element.dataset.logId === logId);

				if (session.inputMode === 'ai' && autoScrollAiMode) {
					setAutoScrollPaused(true);
				}

				if (target) {
					setActiveUserTurnId(logId);
					target.scrollIntoView({ behavior: 'smooth', block: 'start' });
				}

				onHandled?.(logId);
			},
			[autoScrollAiMode, session.inputMode]
		);

		useEffect(() => {
			if (!jumpToLogId) {
				return;
			}

			const frameId = requestAnimationFrame(() => {
				scrollToLog(jumpToLogId, onJumpToLogHandled);
			});

			return () => cancelAnimationFrame(frameId);
		}, [jumpToLogId, filteredLogs, onJumpToLogHandled, scrollToLog]);

		useEffect(() => {
			const container = scrollContainerRef.current;
			if (!container) {
				return;
			}

			scheduleUserTurnMeasurement();
			const observer = new MutationObserver(() => {
				scheduleUserTurnMeasurement();
			});

			observer.observe(container, {
				childList: true,
				subtree: true,
				characterData: true,
			});

			const handleWindowResize = () => {
				scheduleUserTurnMeasurement();
			};

			window.addEventListener('resize', handleWindowResize);

			return () => {
				if (userTurnMeasureFrameRef.current !== null) {
					cancelAnimationFrame(userTurnMeasureFrameRef.current);
					userTurnMeasureFrameRef.current = null;
				}
				observer.disconnect();
				window.removeEventListener('resize', handleWindowResize);
			};
		}, [scheduleUserTurnMeasurement]);

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
			syncActiveUserTurn();
		}, [
			activeTabId,
			filteredLogs.length,
			onScrollPositionChange,
			onAtBottomChange,
			autoScrollAiMode,
			syncActiveUserTurn,
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
						<React.Fragment key={log.id}>
							{showToolActivityPanel && toolPanelInsertLogId === log.id && (
								<ToolActivityPanel
									logs={latestTurnToolLogs}
									theme={theme}
									isSessionBusy={isToolPanelBusy}
								/>
							)}
							<LogItemComponent
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
						</React.Fragment>
					))}
					{showToolActivityPanel && toolPanelInsertLogId === null && (
						<ToolActivityPanel
							logs={latestTurnToolLogs}
							theme={theme}
							isSessionBusy={isToolPanelBusy}
						/>
					)}

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

				{/* User turn minimap for quick in-scroll navigation */}
				{session.inputMode === 'ai' && userTurnMarkers.length > 0 && (
					<div
						className="absolute right-2 top-20 bottom-20 w-8 pointer-events-none z-20"
						data-testid="turn-minimap"
						aria-label="User turn minimap"
					>
						<div
							className="absolute left-1/2 top-0 bottom-0 -translate-x-1/2 rounded-full"
							style={{
								width: '2px',
								backgroundColor: `${theme.colors.border}cc`,
							}}
						/>
						{userTurnMarkers.map((marker, index) => {
							const isActive = marker.id === activeUserTurnId;
							const topPercent = Math.max(4, Math.min(96, marker.ratio * 100));
							return (
								<button
									key={marker.id}
									type="button"
									onClick={() => scrollToLog(marker.id)}
									className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full pointer-events-auto transition-all"
									style={{
										top: `${topPercent}%`,
										width: isActive ? '12px' : '9px',
										height: isActive ? '12px' : '9px',
										backgroundColor: isActive ? theme.colors.accent : theme.colors.textDim,
										border: `1px solid ${isActive ? `${theme.colors.accent}55` : theme.colors.border}`,
										boxShadow: isActive
											? `0 0 0 3px ${theme.colors.accent}18`
											: `0 0 0 2px ${theme.colors.bgMain}`,
										opacity: isActive ? 1 : 0.82,
									}}
									title={`Turn ${index + 1}: ${marker.label}`}
									aria-label={`Jump to turn ${index + 1}: ${marker.label}`}
									data-testid={`scroll-turn-marker-${marker.id}`}
								/>
							);
						})}
					</div>
				)}

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
