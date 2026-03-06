/**
 * MessageHistory component for Maestro mobile web interface
 *
 * Displays the conversation history (AI logs and shell logs) for the active session.
 * Shows messages in a scrollable container with user/AI differentiation.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { ArrowDown } from 'lucide-react';
import { useThemeColors } from '../components/ThemeProvider';
import { stripAnsiCodes } from '../../shared/stringUtils';
import { MobileMarkdownRenderer } from './MobileMarkdownRenderer';
import { ToolActivityBlock } from './ToolActivityBlock';
import type { LogEntry } from '../hooks/useMobileSessionManagement';

/** Threshold for character-based truncation */
const CHAR_TRUNCATE_THRESHOLD = 500;
/** Threshold for line-based truncation */
const LINE_TRUNCATE_THRESHOLD = 8;

export interface MessageHistoryProps {
	/** Log entries to display */
	logs: LogEntry[];
	/** Input mode to determine which logs to show */
	inputMode: 'ai' | 'terminal';
	/** Whether to auto-scroll to bottom on new messages */
	autoScroll?: boolean;
	/** Max height of the container */
	maxHeight?: string;
	/** Callback when user taps a message */
	onMessageTap?: (entry: LogEntry) => void;
}

/**
 * Format timestamp for display
 * Shows time only for today's messages, date + time for older messages
 */
function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	const now = new Date();
	const isToday = date.toDateString() === now.toDateString();

	if (isToday) {
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	} else {
		return (
			date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
			' ' +
			date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		);
	}
}

/**
 * MessageHistory component
 */
export function MessageHistory({
	logs,
	inputMode,
	autoScroll = true,
	maxHeight = '300px',
	onMessageTap,
}: MessageHistoryProps) {
	const colors = useThemeColors();
	const containerRef = useRef<HTMLDivElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	const [hasInitiallyScrolled, setHasInitiallyScrolled] = useState(false);
	const prevLogsLengthRef = useRef(0);
	// Track which messages are expanded (by id or index)
	const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());

	// New message indicator state
	const [isAtBottom, setIsAtBottom] = useState(true);
	const [hasNewMessages, setHasNewMessages] = useState(false);
	const [newMessageCount, setNewMessageCount] = useState(0);

	/**
	 * Check if a message should be truncated
	 */
	const shouldTruncate = useCallback((text: string): boolean => {
		if (text.length > CHAR_TRUNCATE_THRESHOLD) return true;
		const lineCount = text.split('\n').length;
		return lineCount > LINE_TRUNCATE_THRESHOLD;
	}, []);

	/**
	 * Get truncated text for display
	 */
	const getTruncatedText = useCallback((text: string): string => {
		const lines = text.split('\n');
		if (lines.length > LINE_TRUNCATE_THRESHOLD) {
			return lines.slice(0, LINE_TRUNCATE_THRESHOLD).join('\n');
		}
		if (text.length > CHAR_TRUNCATE_THRESHOLD) {
			return text.slice(0, CHAR_TRUNCATE_THRESHOLD);
		}
		return text;
	}, []);

	/**
	 * Toggle expansion state for a message
	 */
	const toggleExpanded = useCallback((messageKey: string) => {
		setExpandedMessages((prev) => {
			const next = new Set(prev);
			if (next.has(messageKey)) {
				next.delete(messageKey);
			} else {
				next.add(messageKey);
			}
			return next;
		});
	}, []);

	// Initial scroll - jump to bottom immediately without animation
	useEffect(() => {
		if (!hasInitiallyScrolled && logs.length > 0 && bottomRef.current) {
			// Use instant scroll for initial load
			bottomRef.current.scrollIntoView({ behavior: 'instant' });
			setHasInitiallyScrolled(true);
			prevLogsLengthRef.current = logs.length;
		}
	}, [logs, hasInitiallyScrolled]);

	// Auto-scroll to bottom when new messages arrive (after initial load)
	useEffect(() => {
		if (
			hasInitiallyScrolled &&
			autoScroll &&
			bottomRef.current &&
			logs.length > prevLogsLengthRef.current
		) {
			bottomRef.current.scrollIntoView({ behavior: 'smooth' });
			prevLogsLengthRef.current = logs.length;
		}
	}, [logs, autoScroll, hasInitiallyScrolled]);

	// Reset scroll state when logs are cleared (e.g., session change)
	useEffect(() => {
		if (logs.length === 0) {
			setHasInitiallyScrolled(false);
			prevLogsLengthRef.current = 0;
			setHasNewMessages(false);
			setNewMessageCount(0);
			setIsAtBottom(true);
		}
	}, [logs.length]);

	// Track scroll position to detect when user scrolls away from bottom
	const handleScroll = useCallback(() => {
		const container = containerRef.current;
		if (!container) return;

		const { scrollTop, scrollHeight, clientHeight } = container;
		const atBottom = scrollHeight - scrollTop - clientHeight < 50;
		setIsAtBottom(atBottom);

		if (atBottom) {
			setHasNewMessages(false);
			setNewMessageCount(0);
		}
	}, []);

	// Detect new messages when user is not at bottom
	useEffect(() => {
		const currentCount = logs.length;
		if (currentCount > prevLogsLengthRef.current && hasInitiallyScrolled) {
			// Check actual scroll position
			const container = containerRef.current;
			let actuallyAtBottom = isAtBottom;
			if (container) {
				const { scrollTop, scrollHeight, clientHeight } = container;
				actuallyAtBottom = scrollHeight - scrollTop - clientHeight < 50;
			}

			if (!actuallyAtBottom) {
				const newCount = currentCount - prevLogsLengthRef.current;
				setHasNewMessages(true);
				setNewMessageCount((prev) => prev + newCount);
				setIsAtBottom(false);
			}
		}
		prevLogsLengthRef.current = currentCount;
	}, [logs.length, isAtBottom, hasInitiallyScrolled]);

	// Scroll to bottom function
	const scrollToBottom = useCallback(() => {
		if (bottomRef.current) {
			bottomRef.current.scrollIntoView({ behavior: 'smooth' });
			setHasNewMessages(false);
			setNewMessageCount(0);
		}
	}, []);

	if (!logs || logs.length === 0) {
		return (
			<div
				style={{
					padding: '16px',
					textAlign: 'center',
					color: colors.textDim,
					fontSize: '13px',
				}}
			>
				No messages yet
			</div>
		);
	}

	return (
		<div
			style={{
				position: 'relative',
				...(maxHeight === 'none'
					? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }
					: {}),
			}}
		>
			<div
				ref={containerRef}
				onScroll={handleScroll}
				style={{
					display: 'flex',
					flexDirection: 'column',
					gap: '18px',
					padding: '18px 16px 28px',
					...(maxHeight === 'none' ? { flex: 1, minHeight: 0 } : { maxHeight }),
					overflowY: 'auto',
					overflowX: 'hidden',
				}}
			>
				{logs.map((entry, index) => {
					const rawText = entry.text || entry.content || '';
					const text = stripAnsiCodes(rawText);
					const source = entry.source || (entry.type === 'user' ? 'user' : 'stdout');
					const isUser = source === 'user';
					const isError = source === 'stderr';
					const isSystem = source === 'system';
					const isThinking = source === 'thinking';
					const isTool = source === 'tool';
					const isAssistantResponse =
						inputMode === 'ai' && !isUser && !isError && !isSystem && !isThinking && !isTool;
					const messageKey = entry.id || `${entry.timestamp}-${index}`;
					const isExpanded = expandedMessages.has(messageKey);
					const isTruncatable = !isAssistantResponse && !isTool && shouldTruncate(text);
					const displayText = isExpanded || !isTruncatable ? text : getTruncatedText(text);
					const messageLabel = isUser
						? 'You'
						: isError
							? 'Error'
							: isSystem
								? 'System'
								: isThinking
									? 'Reasoning'
									: inputMode === 'ai'
										? isTool
											? 'Tool'
											: 'Model'
										: 'Output';

					return (
						<div
							key={messageKey}
							onClick={() => {
								if (isTruncatable) {
									toggleExpanded(messageKey);
								}
								onMessageTap?.(entry);
							}}
							style={{
								display: 'flex',
								flexDirection: 'column',
								gap: isAssistantResponse ? '6px' : '8px',
								padding: isAssistantResponse ? 0 : '12px 14px',
								borderRadius: isAssistantResponse ? 0 : '14px',
								backgroundColor: isUser
									? `${colors.accent}14`
									: isError
										? `${colors.error}10`
										: isThinking
											? 'transparent'
											: isSystem
												? `${colors.textDim}10`
												: 'transparent',
								border:
									isAssistantResponse || isThinking || isTool
										? 'none'
										: `1px solid ${
												isUser
													? `${colors.accent}30`
													: isError
														? `${colors.error}28`
														: colors.border
											}`,
								cursor: isTruncatable ? 'pointer' : 'default',
								alignSelf: isUser ? 'flex-end' : 'stretch',
								maxWidth: isAssistantResponse ? '100%' : '88%',
							}}
						>
							<div
								style={{
									display: 'flex',
									alignItems: 'center',
									justifyContent: isAssistantResponse ? 'flex-end' : 'flex-start',
									gap: '8px',
									fontSize: '10px',
									color: colors.textDim,
								}}
							>
								{!isAssistantResponse && (
									<span
										style={{
											fontWeight: 600,
											textTransform: 'uppercase',
											letterSpacing: '0.08em',
											color: isUser ? colors.accent : isError ? colors.error : colors.textDim,
										}}
									>
										{messageLabel}
									</span>
								)}
								<span style={{ opacity: 0.7 }}>{formatTime(entry.timestamp)}</span>
								{isTruncatable && (
									<span
										style={{
											marginLeft: 'auto',
											color: colors.accent,
											fontSize: '10px',
										}}
									>
										{isExpanded ? '▼ collapse' : '▶ expand'}
									</span>
								)}
							</div>

							{/* Message content */}
							<div
								style={{
									color: isError ? colors.error : colors.textMain,
									textAlign: 'left',
									paddingTop: isAssistantResponse ? '2px' : 0,
								}}
							>
								{isTool ? (
									<ToolActivityBlock
										log={entry}
										expanded={isExpanded}
										onToggleExpanded={() => toggleExpanded(messageKey)}
									/>
								) : isThinking ? (
									<div
										style={{
											paddingLeft: '12px',
											borderLeft: `2px solid ${colors.accent}`,
											fontSize: '13px',
											lineHeight: 1.65,
											color: colors.textMain,
										}}
									>
										<div
											style={{
												fontSize: '10px',
												fontWeight: 700,
												letterSpacing: '0.08em',
												textTransform: 'uppercase',
												color: colors.accent,
												marginBottom: '6px',
											}}
										>
											thinking
										</div>
										<MobileMarkdownRenderer content={displayText} fontSize={13} />
									</div>
								) : inputMode === 'terminal' || isUser ? (
									<div
										style={{
											fontSize: '13px',
											lineHeight: 1.65,
											fontFamily: 'ui-monospace, monospace',
											whiteSpace: 'pre-wrap',
											wordBreak: 'break-word',
										}}
									>
										{displayText}
									</div>
								) : (
									<MobileMarkdownRenderer
										content={displayText}
										fontSize={isAssistantResponse ? 14 : 13}
									/>
								)}
								{isTruncatable && !isExpanded && (
									<span style={{ color: colors.textDim, fontStyle: 'italic', fontSize: '13px' }}>
										{'\n'}... (tap to expand)
									</span>
								)}
							</div>
						</div>
					);
				})}
				{/* Bottom ref with padding to ensure last message is fully visible */}
				<div ref={bottomRef} style={{ minHeight: '8px' }} />
			</div>

			{/* New Message Indicator - floating arrow button */}
			{hasNewMessages && !isAtBottom && (
				<button
					onClick={scrollToBottom}
					style={{
						position: 'absolute',
						bottom: '16px',
						right: '24px',
						display: 'flex',
						alignItems: 'center',
						gap: '8px',
						padding: '8px 12px',
						borderRadius: '9999px',
						backgroundColor: colors.accent,
						color: colors.accentForeground || '#fff',
						border: 'none',
						boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
						cursor: 'pointer',
						zIndex: 20,
						animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
					}}
					title="Scroll to new messages"
				>
					<ArrowDown style={{ width: '16px', height: '16px' }} />
					{newMessageCount > 0 && (
						<span style={{ fontSize: '12px', fontWeight: 'bold' }}>
							{newMessageCount > 99 ? '99+' : newMessageCount}
						</span>
					)}
				</button>
			)}
		</div>
	);
}

export default MessageHistory;
