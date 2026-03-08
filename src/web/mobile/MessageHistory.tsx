/**
 * MessageHistory component for Maestro mobile web interface
 *
 * Displays the conversation history (AI logs and shell logs) for the active session.
 * Shows messages in a scrollable container with user/AI differentiation.
 */

import { Fragment, memo, useEffect, useRef, useState, useCallback } from 'react';
import { ArrowDown, FileText } from 'lucide-react';
import { useThemeColors } from '../components/ThemeProvider';
import { stripAnsiCodes } from '../../shared/stringUtils';
import { MobileMarkdownRenderer } from './MobileMarkdownRenderer';
import { ToolActivityBlock } from './ToolActivityBlock';
import { ToolActivityPanel } from './ToolActivityPanel';
import type { LogEntry } from '../hooks/useMobileSessionManagement';
import { buildApiUrl } from '../utils/config';

/** Threshold for character-based truncation */
const CHAR_TRUNCATE_THRESHOLD = 500;
/** Threshold for line-based truncation */
const LINE_TRUNCATE_THRESHOLD = 8;

export interface MessageHistoryProps {
	/** Log entries to display */
	logs: LogEntry[];
	/** Input mode to determine which logs to show */
	inputMode: 'ai' | 'terminal';
	/** Tool activity entries for the latest assistant turn */
	toolLogs?: LogEntry[];
	/** Whether the active session is currently busy */
	isSessionBusy?: boolean;
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

function artifactUrl(artifactId?: string | null): string | null {
	if (!artifactId) return null;
	return buildApiUrl(`/artifacts/${artifactId}/content`);
}

/**
 * MessageHistory component
 */
export const MessageHistory = memo(function MessageHistory({
	logs,
	inputMode,
	toolLogs = [],
	isSessionBusy = false,
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
	const [lightboxImages, setLightboxImages] = useState<string[]>([]);
	const [lightboxIndex, setLightboxIndex] = useState(0);
	const latestUserLogIndex =
		inputMode === 'ai'
			? (() => {
					for (let index = logs.length - 1; index >= 0; index -= 1) {
						const entry = logs[index];
						const source = entry.source || (entry.type === 'user' ? 'user' : 'stdout');
						if (source === 'user') {
							return index;
						}
					}
					return -1;
				})()
			: -1;
	const toolPanelInsertIndex =
		toolLogs.length > 0 && latestUserLogIndex >= 0
			? (() => {
					for (let index = latestUserLogIndex + 1; index < logs.length; index += 1) {
						const entry = logs[index];
						const source = entry.source || (entry.type === 'user' ? 'user' : 'stdout');
						if (source !== 'user') {
							return index;
						}
					}
					return logs.length;
				})()
			: -1;

	const showPendingAssistantIndicator =
		inputMode === 'ai' &&
		toolLogs.length === 0 &&
		isSessionBusy &&
		(() => {
			for (let index = logs.length - 1; index >= 0; index -= 1) {
				const entry = logs[index];
				const source = entry.source || (entry.type === 'user' ? 'user' : 'stdout');
				if (source === 'system') {
					continue;
				}
				return source === 'user';
			}
			return false;
		})();

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

	useEffect(() => {
		if (showPendingAssistantIndicator && autoScroll && isAtBottom && bottomRef.current) {
			bottomRef.current.scrollIntoView({ behavior: hasInitiallyScrolled ? 'smooth' : 'instant' });
		}
	}, [autoScroll, hasInitiallyScrolled, isAtBottom, showPendingAssistantIndicator]);

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

	const openImageLightbox = useCallback((images: string[], index: number) => {
		setLightboxImages(images);
		setLightboxIndex(index);
	}, []);

	const closeImageLightbox = useCallback(() => {
		setLightboxImages([]);
		setLightboxIndex(0);
	}, []);

	const showPrevLightboxImage = useCallback(() => {
		setLightboxIndex((prev) => (prev > 0 ? prev - 1 : prev));
	}, []);

	const showNextLightboxImage = useCallback(() => {
		setLightboxIndex((prev) => (prev < lightboxImages.length - 1 ? prev + 1 : prev));
	}, [lightboxImages.length]);

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
				className="maestro-message-history-scroll"
				onScroll={handleScroll}
				style={{
					display: 'flex',
					flexDirection: 'column',
					gap: '14px',
					padding: '18px 16px 12px',
					...(maxHeight === 'none' ? { flex: 1, minHeight: 0 } : { maxHeight }),
					overflowY: 'auto',
					overflowX: 'hidden',
					scrollbarWidth: 'none',
					msOverflowStyle: 'none',
					WebkitOverflowScrolling: 'touch',
					overscrollBehavior: 'contain',
				}}
			>
				{logs.map((entry, index) => {
					const shouldRenderToolPanelBeforeRow =
						toolPanelInsertIndex >= 0 && index === toolPanelInsertIndex;
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
					const attachments = entry.attachments || [];
					const demoCard = entry.metadata?.demoCard;
					const showInlineMeta = !isUser;
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
						<Fragment key={messageKey}>
							{shouldRenderToolPanelBeforeRow && (
								<ToolActivityPanel logs={toolLogs} isSessionBusy={isSessionBusy} />
							)}
							<div
								style={{
									display: 'flex',
									flexDirection: 'column',
									gap: isUser ? '2px' : '0',
								}}
							>
								{isUser && (
									<div
										style={{
											fontSize: '10px',
											color: colors.textDim,
											opacity: 0.72,
											paddingRight: '2px',
											alignSelf: 'flex-end',
										}}
									>
										{formatTime(entry.timestamp)}
									</div>
								)}
								<div
									onClick={() => {
										if (isTruncatable) {
											toggleExpanded(messageKey);
										}
										onMessageTap?.(entry);
									}}
									style={{
										display: 'flex',
										flexDirection: 'column',
										gap: isAssistantResponse ? '2px' : '8px',
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
									{showInlineMeta && (
										<div
											style={{
												display: 'flex',
												alignItems: 'center',
												justifyContent: 'flex-start',
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
														color: isError ? colors.error : colors.textDim,
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
									)}

									{/* Message content */}
									<div
										style={{
											color: isError ? colors.error : colors.textMain,
											textAlign: 'left',
											paddingTop: 0,
										}}
									>
										{demoCard ? (
											<div
												style={{
													border: `1px solid ${colors.border}`,
													borderRadius: '18px',
													padding: '12px',
													background: `${colors.bgMain}cc`,
													display: 'flex',
													flexDirection: 'column',
													gap: '10px',
												}}
											>
												{demoCard.posterArtifact && (
													<img
														src={artifactUrl(demoCard.posterArtifact.id) || undefined}
														alt={demoCard.title}
														style={{
															width: '100%',
															borderRadius: '14px',
															border: `1px solid ${colors.border}`,
															display: 'block',
														}}
													/>
												)}
												<div style={{ fontSize: '15px', fontWeight: 700 }}>{demoCard.title}</div>
												{demoCard.summary && (
													<div style={{ fontSize: '13px', color: colors.textDim }}>
														{demoCard.summary}
													</div>
												)}
												<div
													style={{
														display: 'flex',
														flexWrap: 'wrap',
														gap: '8px',
														fontSize: '12px',
														color: colors.textDim,
													}}
												>
													<span>{demoCard.stepCount} steps</span>
													{demoCard.durationMs ? (
														<span>{Math.round(demoCard.durationMs / 1000)}s</span>
													) : null}
													<span>{demoCard.status}</span>
												</div>
											</div>
										) : null}

										{!demoCard && entry.images && entry.images.length > 0 && (
											<div
												style={{
													display: 'flex',
													flexWrap: 'wrap',
													gap: '8px',
													marginBottom: text ? '10px' : 0,
												}}
											>
												{entry.images.map((image, imageIndex) => (
													<img
														key={`${messageKey}-image-${imageIndex}`}
														src={image}
														alt={`Attachment ${imageIndex + 1}`}
														onClick={(event) => {
															event.stopPropagation();
															openImageLightbox(entry.images || [], imageIndex);
														}}
														style={{
															width: '96px',
															height: '96px',
															borderRadius: '16px',
															objectFit: 'cover',
															border: `1px solid ${colors.border}`,
															boxShadow: '0 10px 18px rgba(15, 23, 42, 0.08)',
															cursor: 'zoom-in',
														}}
													/>
												))}
											</div>
										)}

										{!demoCard && attachments.length > 0 && (
											<div
												style={{
													display: 'flex',
													flexWrap: 'wrap',
													gap: '8px',
													marginBottom: text ? '10px' : 0,
												}}
											>
												{attachments.map((attachment, attachmentIndex) => (
													<div
														key={attachment.id || `${messageKey}-attachment-${attachmentIndex}`}
														style={{
															display: 'inline-flex',
															alignItems: 'center',
															gap: '8px',
															padding: '8px 10px',
															borderRadius: '14px',
															border: `1px solid ${colors.border}`,
															background: `${colors.bgSidebar}cc`,
															maxWidth: '100%',
														}}
													>
														<FileText size={14} color={colors.accent} />
														<span
															style={{
																fontSize: '12px',
																fontWeight: 600,
																color: colors.textMain,
																overflow: 'hidden',
																textOverflow: 'ellipsis',
																whiteSpace: 'nowrap',
															}}
														>
															{attachment.name}
														</span>
													</div>
												))}
											</div>
										)}

										{demoCard ? null : isTool ? (
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
											<span
												style={{ color: colors.textDim, fontStyle: 'italic', fontSize: '13px' }}
											>
												{'\n'}... (tap to expand)
											</span>
										)}
									</div>
								</div>
							</div>
						</Fragment>
					);
				})}
				{toolLogs.length > 0 && toolPanelInsertIndex === logs.length && (
					<ToolActivityPanel logs={toolLogs} isSessionBusy={isSessionBusy} />
				)}
				{showPendingAssistantIndicator && (
					<div
						style={{
							display: 'flex',
							alignSelf: 'flex-start',
							maxWidth: '88%',
						}}
						aria-live="polite"
						aria-label="Assistant is thinking"
					>
						<div
							style={{
								display: 'inline-flex',
								alignItems: 'center',
								gap: '10px',
								padding: '12px 14px',
								borderRadius: '18px',
								background: `linear-gradient(180deg, ${colors.bgSidebar} 0%, ${colors.bgMain} 100%)`,
								border: `1px solid ${colors.border}`,
								boxShadow: '0 8px 18px rgba(15, 23, 42, 0.08)',
							}}
						>
							<span
								style={{
									display: 'inline-flex',
									alignItems: 'center',
									gap: '5px',
								}}
							>
								{[0, 1, 2].map((dotIndex) => (
									<span
										key={dotIndex}
										style={{
											width: '6px',
											height: '6px',
											borderRadius: '999px',
											backgroundColor: colors.textDim,
											opacity: 0.85,
											animation: 'maestro-mobile-thinking-bounce 1.25s infinite ease-in-out',
											animationDelay: `${dotIndex * 0.14}s`,
										}}
									/>
								))}
							</span>
							<span
								style={{
									fontSize: '12px',
									fontWeight: 600,
									color: colors.textDim,
									letterSpacing: '0.01em',
								}}
							>
								Thinking
							</span>
						</div>
					</div>
				)}
				{/* Bottom ref with padding to ensure last message is fully visible */}
				<div ref={bottomRef} style={{ minHeight: '8px' }} />
			</div>

			{lightboxImages.length > 0 && (
				<div
					style={{
						position: 'fixed',
						inset: 0,
						zIndex: 220,
						background: 'rgba(2, 6, 23, 0.88)',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						padding: '20px',
					}}
					onClick={closeImageLightbox}
				>
					<button
						type="button"
						onClick={closeImageLightbox}
						aria-label="Close image preview"
						style={{
							position: 'absolute',
							top: '18px',
							right: '18px',
							width: '40px',
							height: '40px',
							borderRadius: '999px',
							border: '1px solid rgba(255, 255, 255, 0.16)',
							background: 'rgba(15, 23, 42, 0.55)',
							color: '#fff',
							fontSize: '24px',
							lineHeight: 1,
							cursor: 'pointer',
						}}
					>
						×
					</button>
					{lightboxImages.length > 1 && (
						<>
							<button
								type="button"
								onClick={(event) => {
									event.stopPropagation();
									showPrevLightboxImage();
								}}
								disabled={lightboxIndex === 0}
								aria-label="Previous image"
								style={{
									position: 'absolute',
									left: '14px',
									top: '50%',
									transform: 'translateY(-50%)',
									width: '40px',
									height: '40px',
									borderRadius: '999px',
									border: '1px solid rgba(255, 255, 255, 0.16)',
									background: 'rgba(15, 23, 42, 0.55)',
									color: '#fff',
									fontSize: '22px',
									cursor: lightboxIndex === 0 ? 'default' : 'pointer',
									opacity: lightboxIndex === 0 ? 0.45 : 1,
								}}
							>
								‹
							</button>
							<button
								type="button"
								onClick={(event) => {
									event.stopPropagation();
									showNextLightboxImage();
								}}
								disabled={lightboxIndex >= lightboxImages.length - 1}
								aria-label="Next image"
								style={{
									position: 'absolute',
									right: '14px',
									top: '50%',
									transform: 'translateY(-50%)',
									width: '40px',
									height: '40px',
									borderRadius: '999px',
									border: '1px solid rgba(255, 255, 255, 0.16)',
									background: 'rgba(15, 23, 42, 0.55)',
									color: '#fff',
									fontSize: '22px',
									cursor: lightboxIndex >= lightboxImages.length - 1 ? 'default' : 'pointer',
									opacity: lightboxIndex >= lightboxImages.length - 1 ? 0.45 : 1,
								}}
							>
								›
							</button>
						</>
					)}
					<img
						src={lightboxImages[lightboxIndex]}
						alt="Expanded attachment preview"
						onClick={(event) => event.stopPropagation()}
						style={{
							maxWidth: '100%',
							maxHeight: '82vh',
							borderRadius: '24px',
							objectFit: 'contain',
							boxShadow: '0 24px 64px rgba(0, 0, 0, 0.38)',
						}}
					/>
				</div>
			)}

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
			<style>
				{`
					.maestro-message-history-scroll::-webkit-scrollbar {
						width: 0;
						height: 0;
						display: none;
					}

					@keyframes maestro-mobile-thinking-bounce {
						0%, 80%, 100% {
							transform: translateY(0) scale(0.82);
							opacity: 0.4;
						}
						40% {
							transform: translateY(-2px) scale(1);
							opacity: 1;
						}
					}
				`}
			</style>
		</div>
	);
});

export default MessageHistory;
