/**
 * MessageHistory component for Maestro mobile web interface
 *
 * Displays the conversation history (AI logs and shell logs) for the active session.
 * Shows messages in a scrollable container with user/AI differentiation.
 */

import { Fragment, memo, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { ArrowDown, Check, CircleSlash, Clock3, FileText, Navigation2 } from 'lucide-react';
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
	/** Active session ID for resolving local project file links */
	sessionId?: string | null;
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
	/** Message key to scroll into view */
	jumpToMessageKey?: string | null;
	/** Called after a jump request is handled */
	onJumpHandled?: () => void;
	/** Called when the most visible user turn changes while scrolling */
	onVisibleUserTurnChange?: (messageKey: string | null) => void;
	/** Bottom inset reserved for the fixed mobile composer */
	bottomInset?: number | string;
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

function getInteractionBadge(
	entry: LogEntry,
	colors: ReturnType<typeof useThemeColors>
): {
	kind: 'steer' | 'delivered' | 'queued' | 'canceled';
	title: string;
	color: string;
	background: string;
	border: string;
} | null {
	if (entry.deliveryState === 'canceled') {
		return {
			kind: 'canceled',
			title: 'Stopped by user',
			color: colors.textDim,
			background: `${colors.textDim}10`,
			border: `${colors.textDim}20`,
		};
	}

	if (entry.interactionKind === 'steer') {
		if (entry.deliveryState === 'delivered' || entry.delivered) {
			return {
				kind: 'delivered',
				title: 'Steer delivered',
				color: '#16a34a',
				background: 'rgba(22, 163, 74, 0.14)',
				border: 'rgba(22, 163, 74, 0.28)',
			};
		}

		if (entry.deliveryState === 'fallback_interrupt') {
			return {
				kind: 'steer',
				title: 'Steer waiting for interrupt',
				color: colors.textDim,
				background: `${colors.textDim}12`,
				border: `${colors.textDim}22`,
			};
		}

		return {
			kind: 'steer',
			title: 'Sending steer',
			color: colors.accent,
			background: `${colors.accent}16`,
			border: `${colors.accent}33`,
		};
	}

	if (entry.interactionKind === 'queued') {
		return {
			kind: 'queued',
			title:
				entry.delivered || entry.deliveryState === 'delivered' ? 'Queued next sent' : 'Queued next',
			color: colors.textDim,
			background: `${colors.textDim}12`,
			border: `${colors.textDim}22`,
		};
	}

	return null;
}

function InteractionBadgeIcon({
	kind,
	color,
}: {
	kind: 'steer' | 'delivered' | 'queued' | 'canceled';
	color: string;
}) {
	if (kind === 'delivered') {
		return <Check size={12} strokeWidth={3} color={color} />;
	}

	if (kind === 'canceled') {
		return <CircleSlash size={12} strokeWidth={2.4} color={color} />;
	}

	if (kind === 'queued') {
		return <Clock3 size={12} strokeWidth={2.4} color={color} />;
	}

	return <Navigation2 size={12} strokeWidth={2.4} color={color} />;
}

/**
 * MessageHistory component
 */
export const MessageHistory = memo(function MessageHistory({
	logs,
	sessionId = null,
	inputMode,
	toolLogs = [],
	isSessionBusy = false,
	autoScroll = true,
	maxHeight = '300px',
	onMessageTap,
	jumpToMessageKey = null,
	onJumpHandled,
	onVisibleUserTurnChange,
	bottomInset = 0,
}: MessageHistoryProps) {
	const colors = useThemeColors();
	const containerRef = useRef<HTMLDivElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	const messageElementMapRef = useRef<Map<string, HTMLDivElement>>(new Map());
	const userMessageElementMapRef = useRef<Map<string, HTMLDivElement>>(new Map());
	const lastVisibleUserTurnKeyRef = useRef<string | null>(null);
	const scrollOverlayHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
	const [visibleUserTurnKey, setVisibleUserTurnKey] = useState<string | null>(null);
	const [showScrollTurnOverlay, setShowScrollTurnOverlay] = useState(false);
	const { canceledUserMessageKeys, canceledSystemMessageKeys } = useMemo(() => {
		const canceledKeys = new Set<string>();
		const canceledNoticeKeys = new Set<string>();
		let latestTurnKey: string | null = null;

		for (let index = 0; index < logs.length; index += 1) {
			const entry = logs[index];
			const source = entry.source || (entry.type === 'user' ? 'user' : 'stdout');
			const messageKey = entry.id || `${entry.timestamp}-${index}`;

			if (source === 'user') {
				if (entry.interactionKind !== 'steer' && entry.interactionKind !== 'queued') {
					latestTurnKey = messageKey;
				}
				continue;
			}

			if (source === 'system' && (entry.text || entry.content || '') === 'Canceled by user') {
				if (latestTurnKey) {
					canceledKeys.add(latestTurnKey);
					canceledNoticeKeys.add(messageKey);
				}
			}
		}

		return {
			canceledUserMessageKeys: canceledKeys,
			canceledSystemMessageKeys: canceledNoticeKeys,
		};
	}, [logs]);
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
	const userMessageKeys = useMemo(
		() =>
			logs
				.map((entry, index) => {
					const source = entry.source || (entry.type === 'user' ? 'user' : 'stdout');
					if (source !== 'user') {
						return null;
					}
					return entry.id || `${entry.timestamp}-${index}`;
				})
				.filter((messageKey): messageKey is string => Boolean(messageKey)),
		[logs]
	);
	const userTurnMarkers = useMemo(
		() =>
			logs
				.map((entry, index) => {
					const source = entry.source || (entry.type === 'user' ? 'user' : 'stdout');
					if (source !== 'user') {
						return null;
					}
					return {
						key: entry.id || `${entry.timestamp}-${index}`,
						label:
							(entry.text || entry.content || '').replace(/\s+/g, ' ').trim() || 'Untitled turn',
					};
				})
				.filter((entry): entry is { key: string; label: string } => Boolean(entry)),
		[logs]
	);
	const visibleScrollTurnMarkers = useMemo(() => {
		if (userTurnMarkers.length <= 1) {
			return [];
		}

		if (userTurnMarkers.length <= 6) {
			return userTurnMarkers;
		}

		const anchors = [userTurnMarkers[0], ...userTurnMarkers.slice(-5)];
		const seen = new Set<string>();
		return anchors.filter((marker) => {
			if (seen.has(marker.key)) {
				return false;
			}
			seen.add(marker.key);
			return true;
		});
	}, [userTurnMarkers]);
	const activeScrollOverlayTurnKey = useMemo(() => {
		if (visibleScrollTurnMarkers.length === 0) {
			return null;
		}

		if (!visibleUserTurnKey) {
			return visibleScrollTurnMarkers[visibleScrollTurnMarkers.length - 1]?.key || null;
		}

		const activeIndex = userTurnMarkers.findIndex((marker) => marker.key === visibleUserTurnKey);
		if (activeIndex < 0) {
			return visibleScrollTurnMarkers[visibleScrollTurnMarkers.length - 1]?.key || null;
		}

		let nearestKey = visibleScrollTurnMarkers[0]?.key || null;
		let nearestDistance = Number.POSITIVE_INFINITY;

		for (const marker of visibleScrollTurnMarkers) {
			const markerIndex = userTurnMarkers.findIndex((entry) => entry.key === marker.key);
			if (markerIndex < 0) {
				continue;
			}
			const distance = Math.abs(markerIndex - activeIndex);
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearestKey = marker.key;
			}
		}

		return nearestKey;
	}, [userTurnMarkers, visibleScrollTurnMarkers, visibleUserTurnKey]);

	const hasAssistantResponseAfterLatestUser =
		inputMode === 'ai' &&
		latestUserLogIndex >= 0 &&
		logs.slice(latestUserLogIndex + 1).some((entry) => {
			const source = entry.source || (entry.type === 'user' ? 'user' : 'stdout');
			return source !== 'user' && source !== 'system' && source !== 'thinking' && source !== 'tool';
		});

	const showPendingAssistantIndicator =
		inputMode === 'ai' &&
		isSessionBusy &&
		latestUserLogIndex >= 0 &&
		!hasAssistantResponseAfterLatestUser;

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

	const showScrollOverlayTemporarily = useCallback(() => {
		if (userTurnMarkers.length <= 1) {
			return;
		}

		setShowScrollTurnOverlay(true);
		if (scrollOverlayHideTimerRef.current) {
			clearTimeout(scrollOverlayHideTimerRef.current);
		}
		scrollOverlayHideTimerRef.current = setTimeout(() => {
			setShowScrollTurnOverlay(false);
		}, 900);
	}, [userTurnMarkers.length]);

	const syncVisibleUserTurn = useCallback(() => {
		const container = containerRef.current;
		if (!container || userMessageKeys.length === 0) {
			if (lastVisibleUserTurnKeyRef.current !== null) {
				lastVisibleUserTurnKeyRef.current = null;
				setVisibleUserTurnKey(null);
				onVisibleUserTurnChange?.(null);
			}
			return;
		}

		const containerRect = container.getBoundingClientRect();
		const anchorY = containerRect.top + Math.min(containerRect.height * 0.28, 140);
		let bestKey: string | null = null;
		let bestDistance = Number.POSITIVE_INFINITY;

		for (const messageKey of userMessageKeys) {
			const element = userMessageElementMapRef.current.get(messageKey);
			if (!element) {
				continue;
			}

			const rect = element.getBoundingClientRect();
			const distance = Math.abs(rect.top - anchorY);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestKey = messageKey;
			}
		}

		if (bestKey !== lastVisibleUserTurnKeyRef.current) {
			lastVisibleUserTurnKeyRef.current = bestKey;
			setVisibleUserTurnKey(bestKey);
			onVisibleUserTurnChange?.(bestKey);
		}
	}, [onVisibleUserTurnChange, userMessageKeys]);

	useEffect(() => {
		return () => {
			if (scrollOverlayHideTimerRef.current) {
				clearTimeout(scrollOverlayHideTimerRef.current);
			}
		};
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

	const scrollToMessageKey = useCallback((messageKey: string) => {
		const container = containerRef.current;
		const targetElement = messageElementMapRef.current.get(messageKey);
		if (!container || !targetElement) {
			return;
		}

		const containerRect = container.getBoundingClientRect();
		const targetRect = targetElement.getBoundingClientRect();
		const topPadding = 14;
		const nextScrollTop = container.scrollTop + (targetRect.top - containerRect.top) - topPadding;
		container.scrollTop = Math.max(0, nextScrollTop);
	}, []);

	useEffect(() => {
		if (!jumpToMessageKey) return;

		scrollToMessageKey(jumpToMessageKey);

		onJumpHandled?.();
	}, [jumpToMessageKey, onJumpHandled, scrollToMessageKey]);

	useEffect(() => {
		syncVisibleUserTurn();
	}, [logs, syncVisibleUserTurn]);

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

	const bottomPadding =
		typeof bottomInset === 'number'
			? `${12 + Math.max(0, bottomInset)}px`
			: `calc(12px + ${bottomInset})`;

	return (
		<div
			style={{
				position: 'relative',
				...(maxHeight === 'none'
					? {
							flex: 1,
							minHeight: 0,
							height: '100%',
							display: 'flex',
							flexDirection: 'column',
							overflow: 'hidden',
						}
					: {}),
			}}
		>
			<div
				ref={containerRef}
				className="maestro-message-history-scroll"
				onScroll={() => {
					handleScroll();
					syncVisibleUserTurn();
					showScrollOverlayTemporarily();
				}}
				style={{
					display: 'flex',
					flexDirection: 'column',
					gap: '14px',
					paddingTop: '18px',
					paddingLeft: '16px',
					paddingRight: '16px',
					paddingBottom: bottomPadding,
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
					const isSystemCanceledNotice =
						isSystem && (entry.text || entry.content || '') === 'Canceled by user';
					if (isSystemCanceledNotice && canceledSystemMessageKeys.has(messageKey)) {
						return null;
					}
					const isExpanded = expandedMessages.has(messageKey);
					const isTruncatable = !isAssistantResponse && !isTool && shouldTruncate(text);
					const displayText = isExpanded || !isTruncatable ? text : getTruncatedText(text);
					const attachments = entry.attachments || [];
					const demoCard = entry.metadata?.demoCard;
					const showInlineMeta = !isUser;
					const interactionBadge =
						isUser && canceledUserMessageKeys.has(messageKey)
							? {
									kind: 'canceled' as const,
									title: 'Stopped by user',
									color: colors.textDim,
									background: `${colors.textDim}10`,
									border: `${colors.textDim}20`,
								}
							: isUser
								? getInteractionBadge(entry, colors)
								: null;
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
								ref={(element) => {
									if (element) {
										messageElementMapRef.current.set(messageKey, element);
										if (isUser) {
											userMessageElementMapRef.current.set(messageKey, element);
										}
									} else {
										messageElementMapRef.current.delete(messageKey);
										userMessageElementMapRef.current.delete(messageKey);
									}
								}}
								data-message-key={messageKey}
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

									{isUser && interactionBadge && (
										<div
											aria-label={interactionBadge.title}
											title={interactionBadge.title}
											style={{
												display: 'inline-flex',
												alignItems: 'center',
												justifyContent: 'center',
												alignSelf: 'flex-end',
												width: '22px',
												height: '22px',
												borderRadius: '999px',
												border: `1px solid ${interactionBadge.border}`,
												background: interactionBadge.background,
												color: interactionBadge.color,
											}}
										>
											<InteractionBadgeIcon
												kind={interactionBadge.kind}
												color={interactionBadge.color}
											/>
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
												<MobileMarkdownRenderer
													content={displayText}
													fontSize={13}
													sessionId={sessionId}
												/>
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
												sessionId={sessionId}
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

			{showScrollTurnOverlay && visibleScrollTurnMarkers.length > 1 && (
				<div
					aria-label="Turn history navigator"
					style={{
						position: 'absolute',
						top: '50%',
						right: '8px',
						transform: 'translateY(-50%)',
						display: 'flex',
						flexDirection: 'column',
						alignItems: 'center',
						gap: '10px',
						padding: '10px 8px',
						borderRadius: '999px',
						background: 'rgba(255, 255, 255, 0.26)',
						border: '1px solid rgba(255, 255, 255, 0.16)',
						backdropFilter: 'blur(16px)',
						WebkitBackdropFilter: 'blur(16px)',
						boxShadow: '0 14px 28px rgba(15, 23, 42, 0.12)',
						zIndex: 12,
						pointerEvents: 'auto',
						transition: 'opacity 180ms ease',
					}}
				>
					<div
						style={{
							position: 'absolute',
							top: '12px',
							bottom: '12px',
							width: '2px',
							borderRadius: '999px',
							background: `${colors.textDim}40`,
						}}
					/>
					{visibleScrollTurnMarkers.map((marker, index) => {
						const isActive = marker.key === activeScrollOverlayTurnKey;
						return (
							<button
								key={marker.key}
								type="button"
								onClick={() => {
									scrollToMessageKey(marker.key);
									setVisibleUserTurnKey(marker.key);
									setShowScrollTurnOverlay(true);
									showScrollOverlayTemporarily();
								}}
								aria-label={`Jump to turn ${index + 1}: ${marker.label}`}
								title={marker.label}
								style={{
									appearance: 'none',
									WebkitAppearance: 'none',
									position: 'relative',
									display: 'block',
									width: isActive ? '16px' : '12px',
									height: isActive ? '16px' : '12px',
									minWidth: isActive ? '16px' : '12px',
									minHeight: isActive ? '16px' : '12px',
									borderRadius: '999px',
									border: isActive
										? `1px solid ${colors.accent}66`
										: `1px solid ${colors.textDim}40`,
									background: isActive ? colors.accent : `${colors.textDim}88`,
									boxShadow: isActive ? `0 0 0 3px ${colors.accent}18` : 'none',
									cursor: 'pointer',
									padding: 0,
									flexShrink: 0,
									boxSizing: 'border-box',
									zIndex: 1,
									transition:
										'background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease, width 140ms ease, height 140ms ease',
								}}
							/>
						);
					})}
				</div>
			)}

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
