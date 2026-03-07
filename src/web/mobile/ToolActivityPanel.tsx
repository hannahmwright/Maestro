import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useThemeColors } from '../components/ThemeProvider';
import type { LogEntry } from '../hooks/useMobileSessionManagement';
import {
	buildToolDisplayData,
	collectSearchSourceDomains,
	describeToolActivity,
	extractWebSearchTimelineItems,
	formatDurationMs,
	normalizeToolName,
	normalizeToolStatus,
} from '../../shared/tool-display';

interface ToolActivityPanelProps {
	logs: LogEntry[];
	isSessionBusy?: boolean;
}

function getTimingValue(
	toolState: LogEntry['metadata'] extends { toolState?: infer T } ? T : unknown,
	keys: string[]
): number | null {
	if (!toolState || typeof toolState !== 'object') {
		return null;
	}

	const record = toolState as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
	}

	const timing = record.timing;
	if (timing && typeof timing === 'object') {
		const timingRecord = timing as Record<string, unknown>;
		for (const key of keys) {
			const value = timingRecord[key];
			if (typeof value === 'number' && Number.isFinite(value)) {
				return value;
			}
		}
	}

	return null;
}

function getFeedDuration(logs: LogEntry[], isSessionBusy: boolean): number | null {
	if (logs.length === 0) {
		return null;
	}

	let earliest = Number.POSITIVE_INFINITY;
	let latest = 0;

	for (const log of logs) {
		const toolState = log.metadata?.toolState;
		const start = getTimingValue(toolState, ['startTimestamp', 'startedAt']) ?? log.timestamp;
		const status = normalizeToolStatus((toolState as Record<string, unknown> | undefined)?.status);
		const end =
			getTimingValue(toolState, ['endTimestamp', 'completedAt']) ??
			(status === 'running' || isSessionBusy ? Date.now() : log.timestamp);

		earliest = Math.min(earliest, start);
		latest = Math.max(latest, end);
	}

	if (!Number.isFinite(earliest) || latest < earliest) {
		return null;
	}

	return latest - earliest;
}

function RunningSpinner() {
	const colors = useThemeColors();

	return (
		<span
			aria-hidden="true"
			style={{
				display: 'inline-flex',
				width: '12px',
				height: '12px',
				borderRadius: '999px',
				border: `1.6px solid ${colors.warning}35`,
				borderTopColor: colors.warning,
				animation: 'maestro-mobile-tool-feed-spin 0.9s linear infinite',
				flexShrink: 0,
			}}
		/>
	);
}

function FailedMarker() {
	const colors = useThemeColors();

	return (
		<span
			aria-hidden="true"
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				width: '12px',
				height: '12px',
				flexShrink: 0,
				color: colors.error,
			}}
		>
			<svg
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2.4"
			>
				<line x1="18" y1="6" x2="6" y2="18" />
				<line x1="6" y1="6" x2="18" y2="18" />
			</svg>
		</span>
	);
}

export function ToolActivityPanel({ logs, isSessionBusy = false }: ToolActivityPanelProps) {
	const colors = useThemeColors();
	const scrollRef = useRef<HTMLDivElement>(null);
	const previousLogCountRef = useRef(logs.length);
	const previousBusyRef = useRef(isSessionBusy);
	const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
	const [isPanelExpanded, setIsPanelExpanded] = useState(isSessionBusy);
	const [isAtBottom, setIsAtBottom] = useState(true);
	const [pendingCount, setPendingCount] = useState(0);

	const totalDuration = useMemo(() => getFeedDuration(logs, isSessionBusy), [isSessionBusy, logs]);
	const summaryLabel =
		totalDuration !== null ? `Worked for ${formatDurationMs(totalDuration)}` : 'Worked';

	useEffect(() => {
		if (!logs.length) {
			setExpandedItems(new Set());
			setIsPanelExpanded(false);
			setIsAtBottom(true);
			setPendingCount(0);
			previousLogCountRef.current = 0;
			previousBusyRef.current = isSessionBusy;
			return;
		}

		if (isSessionBusy && !previousBusyRef.current) {
			setIsPanelExpanded(true);
		}

		if (!isSessionBusy && previousBusyRef.current) {
			setIsPanelExpanded(false);
			setExpandedItems(new Set());
		}

		previousBusyRef.current = isSessionBusy;
	}, [isSessionBusy, logs.length]);

	const handleScroll = useCallback(() => {
		const container = scrollRef.current;
		if (!container) return;
		const distanceFromBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight;
		const atBottom = distanceFromBottom < 18;
		setIsAtBottom(atBottom);
		if (atBottom) {
			setPendingCount(0);
		}
	}, []);

	const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
		const container = scrollRef.current;
		if (!container) return;
		container.scrollTo({ top: container.scrollHeight, behavior });
		setPendingCount(0);
	}, []);

	useEffect(() => {
		if (!logs.length || !isPanelExpanded) {
			previousLogCountRef.current = logs.length;
			return;
		}

		const previousCount = previousLogCountRef.current;
		const newCount = Math.max(0, logs.length - previousCount);
		previousLogCountRef.current = logs.length;

		if (previousCount === 0) {
			window.requestAnimationFrame(() => {
				scrollToBottom('auto');
			});
			return;
		}

		if (newCount === 0) {
			return;
		}

		if (isAtBottom) {
			window.requestAnimationFrame(() => {
				scrollToBottom('smooth');
			});
			return;
		}

		setPendingCount((current) => current + newCount);
	}, [isAtBottom, isPanelExpanded, logs.length, scrollToBottom]);

	const toggleExpanded = useCallback((itemKey: string) => {
		setExpandedItems((current) => {
			const next = new Set(current);
			if (next.has(itemKey)) {
				next.delete(itemKey);
			} else {
				next.add(itemKey);
			}
			return next;
		});
	}, []);

	const toolRows = useMemo(
		() =>
			logs.map((log, index) => {
				const toolName = log.text || log.content || 'tool';
				const toolState = log.metadata?.toolState;
				const status = normalizeToolStatus(toolState?.status);
				const copy = describeToolActivity(toolName, toolState);
				const details = buildToolDisplayData(toolState);
				const searchItems = extractWebSearchTimelineItems(toolState);
				const sourceDomains = collectSearchSourceDomains(toolState, searchItems).slice(0, 6);
				const itemKey = log.id || `${log.timestamp}-${index}`;
				const isExpanded = expandedItems.has(itemKey);
				const subtitle = copy.subtitle || normalizeToolName(toolName).replace(/:/g, ' ');
				const visibleDetailRows = details.detailRows.filter(
					(row) => !(row.label === 'command' && copy.rawCommand && row.value === copy.rawCommand)
				);

				return {
					itemKey,
					status,
					title: copy.title,
					subtitle,
					rawCommand: copy.rawCommand,
					details,
					searchItems,
					sourceDomains,
					isExpanded,
					visibleDetailRows,
				};
			}),
		[expandedItems, logs]
	);

	if (!logs.length) {
		return null;
	}

	if (!isSessionBusy && !isPanelExpanded) {
		return (
			<button
				type="button"
				onClick={() => setIsPanelExpanded(true)}
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '8px',
					alignSelf: 'stretch',
					padding: '8px 0 2px',
					border: 'none',
					background: 'transparent',
					color: colors.textDim,
					cursor: 'pointer',
					textAlign: 'left',
				}}
				aria-label={`${summaryLabel} across ${logs.length} tool calls. Expand details.`}
			>
				<span
					style={{
						fontSize: '12px',
						fontWeight: 600,
						color: colors.textDim,
					}}
				>
					{summaryLabel}
				</span>
				<span
					style={{
						fontSize: '11px',
						color: colors.textDim,
						opacity: 0.74,
					}}
				>
					{logs.length} action{logs.length === 1 ? '' : 's'}
				</span>
				<ChevronDown size={14} color={colors.textDim} />
			</button>
		);
	}

	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: '8px',
				alignSelf: 'stretch',
				paddingTop: '4px',
			}}
		>
			<style>
				{`
					@keyframes maestro-mobile-tool-feed-spin {
						from { transform: rotate(0deg); }
						to { transform: rotate(360deg); }
					}

					.maestro-tool-feed-scroll {
						scrollbar-width: thin;
						scrollbar-color: rgba(15, 23, 42, 0.22) transparent;
					}

					.maestro-tool-feed-scroll::-webkit-scrollbar {
						width: 6px;
					}

					.maestro-tool-feed-scroll::-webkit-scrollbar-track {
						background: transparent;
					}

					.maestro-tool-feed-scroll::-webkit-scrollbar-thumb {
						background: rgba(15, 23, 42, 0.18);
						border-radius: 999px;
					}

					.maestro-tool-feed-scroll::-webkit-scrollbar-thumb:hover {
						background: rgba(15, 23, 42, 0.26);
					}
				`}
			</style>

			{!isSessionBusy && (
				<button
					type="button"
					onClick={() => setIsPanelExpanded(false)}
					style={{
						display: 'inline-flex',
						alignItems: 'center',
						gap: '8px',
						padding: 0,
						border: 'none',
						background: 'transparent',
						color: colors.textDim,
						cursor: 'pointer',
						textAlign: 'left',
						alignSelf: 'flex-start',
					}}
				>
					<span
						style={{
							fontSize: '12px',
							fontWeight: 600,
						}}
					>
						{summaryLabel}
					</span>
					<span
						style={{
							fontSize: '11px',
							opacity: 0.74,
						}}
					>
						{logs.length} action{logs.length === 1 ? '' : 's'}
					</span>
					<ChevronUp size={14} color={colors.textDim} />
				</button>
			)}

			<div
				style={{
					position: 'relative',
					borderRadius: '16px',
					background: `linear-gradient(180deg, ${colors.bgSidebar}b8 0%, ${colors.bgMain}c8 100%)`,
					overflow: 'hidden',
				}}
			>
				<div
					ref={scrollRef}
					onScroll={handleScroll}
					className="maestro-tool-feed-scroll"
					style={{
						height: '156px',
						overflowY: 'auto',
						overflowX: 'hidden',
						WebkitOverflowScrolling: 'touch',
						overscrollBehavior: 'contain',
					}}
				>
					{toolRows.map(
						(
							{
								itemKey,
								status,
								title,
								subtitle,
								rawCommand,
								details,
								searchItems,
								sourceDomains,
								isExpanded,
								visibleDetailRows,
							},
							index
						) => (
							<div
								key={itemKey}
								style={{
									borderTop: index === 0 ? 'none' : '1px solid rgba(15, 23, 42, 0.06)',
								}}
							>
								<button
									type="button"
									onClick={() => toggleExpanded(itemKey)}
									style={{
										display: 'flex',
										alignItems: 'flex-start',
										gap: '10px',
										width: '100%',
										padding: '11px 12px',
										border: 'none',
										background: 'transparent',
										cursor: 'pointer',
										color: 'inherit',
										textAlign: 'left',
									}}
									aria-expanded={isExpanded}
								>
									<span
										style={{
											display: 'inline-flex',
											alignItems: 'center',
											justifyContent: 'center',
											width: '12px',
											height: '16px',
											flexShrink: 0,
											marginTop: '1px',
										}}
									>
										{status === 'running' ? (
											<RunningSpinner />
										) : status === 'error' ? (
											<FailedMarker />
										) : null}
									</span>
									<div
										style={{
											display: 'flex',
											flexDirection: 'column',
											gap: '2px',
											minWidth: 0,
											flex: 1,
										}}
									>
										<div
											style={{
												fontSize: '13px',
												fontWeight: 650,
												lineHeight: 1.35,
												color: colors.textMain,
											}}
										>
											{title}
										</div>
										<div
											style={{
												fontSize: '10px',
												lineHeight: 1.35,
												color: colors.textDim,
												fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
												whiteSpace: 'nowrap',
												overflow: 'hidden',
												textOverflow: 'ellipsis',
											}}
										>
											{subtitle}
										</div>
									</div>
									{isExpanded ? (
										<ChevronUp size={14} color={colors.textDim} />
									) : (
										<ChevronDown size={14} color={colors.textDim} />
									)}
								</button>

								{isExpanded && (
									<div
										onClick={() => toggleExpanded(itemKey)}
										style={{
											padding: '0 12px 10px 34px',
											display: 'flex',
											flexDirection: 'column',
											gap: '8px',
											cursor: 'pointer',
										}}
									>
										{visibleDetailRows.map((row) => (
											<div
												key={`${itemKey}-${row.label}-${row.value}`}
												style={{
													display: 'flex',
													gap: '8px',
													alignItems: 'flex-start',
												}}
											>
												<span
													style={{
														fontSize: '10px',
														fontWeight: 700,
														letterSpacing: '0.08em',
														textTransform: 'uppercase',
														color: colors.textDim,
														flexShrink: 0,
													}}
												>
													{row.label}
												</span>
												<span
													style={{
														fontSize: '11px',
														lineHeight: 1.45,
														color: colors.textMain,
														wordBreak: 'break-word',
													}}
												>
													{row.value}
												</span>
											</div>
										))}

										{rawCommand && (
											<div
												style={{
													display: 'flex',
													flexDirection: 'column',
													gap: '4px',
												}}
											>
												<span
													style={{
														fontSize: '10px',
														fontWeight: 700,
														letterSpacing: '0.08em',
														textTransform: 'uppercase',
														color: colors.textDim,
													}}
												>
													Command
												</span>
												<div
													style={{
														padding: '8px 10px',
														borderRadius: '12px',
														background: `${colors.bgSidebar}b8`,
														fontSize: '11px',
														fontFamily:
															'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
														color: colors.textMain,
														whiteSpace: 'pre-wrap',
														wordBreak: 'break-word',
													}}
												>
													{rawCommand}
												</div>
											</div>
										)}

										{searchItems.length > 0 && (
											<div
												style={{
													display: 'flex',
													flexDirection: 'column',
													gap: '6px',
												}}
											>
												{searchItems.map((item) => (
													<div
														key={`${itemKey}-${item.id}`}
														style={{
															fontSize: '11px',
															lineHeight: 1.45,
															color: colors.textMain,
														}}
													>
														{item.query}
														<span
															style={{
																color: colors.textDim,
															}}
														>
															{' '}
															• {item.resultCount} result{item.resultCount === 1 ? '' : 's'} •{' '}
															{item.status}
														</span>
													</div>
												))}
											</div>
										)}

										{sourceDomains.length > 0 && (
											<div
												style={{
													display: 'flex',
													flexWrap: 'wrap',
													gap: '6px',
												}}
											>
												{sourceDomains.map((domain) => (
													<span
														key={`${itemKey}-${domain}`}
														style={{
															padding: '2px 7px',
															borderRadius: '999px',
															border: `1px solid ${colors.border}`,
															background: `${colors.bgSidebar}bb`,
															fontSize: '10px',
															color: colors.textDim,
														}}
													>
														{domain}
													</span>
												))}
											</div>
										)}

										{details.outputDetail && (
											<div
												style={{
													padding: '8px 10px',
													borderRadius: '12px',
													background: `${colors.bgSidebar}b8`,
													fontSize: '11px',
													fontFamily:
														'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
													color: colors.textMain,
													whiteSpace: 'pre-wrap',
													wordBreak: 'break-word',
													maxHeight: '112px',
													overflow: 'auto',
												}}
											>
												{details.outputDetail}
											</div>
										)}
									</div>
								)}
							</div>
						)
					)}
				</div>

				{pendingCount > 0 && !isAtBottom && (
					<button
						type="button"
						onClick={() => scrollToBottom('smooth')}
						style={{
							position: 'absolute',
							right: '10px',
							bottom: '10px',
							display: 'inline-flex',
							alignItems: 'center',
							justifyContent: 'center',
							padding: '5px 9px',
							borderRadius: '999px',
							border: `1px solid ${colors.border}`,
							background: `${colors.bgMain}f5`,
							color: colors.accent,
							fontSize: '10px',
							fontWeight: 700,
							cursor: 'pointer',
							boxShadow: '0 8px 16px rgba(15, 23, 42, 0.12)',
						}}
					>
						{pendingCount} new
					</button>
				)}
			</div>
		</div>
	);
}

export default ToolActivityPanel;
