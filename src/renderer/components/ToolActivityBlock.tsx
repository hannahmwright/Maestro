import { useMemo } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { LogEntry, Theme } from '../types';
import {
	buildToolDisplayData,
	collectSearchSourceDomains,
	extractWebSearchTimelineItems,
	formatDurationMs,
	getToolDurationMs,
	getWebSearchResponseDomains,
	isWebSearchTool,
	normalizeToolName,
	normalizeToolStatus,
} from '../../shared/tool-display';

interface ToolActivityBlockProps {
	log: LogEntry;
	theme: Theme;
	expanded: boolean;
	onToggleExpanded: () => void;
}

export function ToolActivityBlock({
	log,
	theme,
	expanded,
	onToggleExpanded,
}: ToolActivityBlockProps) {
	const toolName = log.text || 'tool';
	const toolState = log.metadata?.toolState;
	const toolStatus = normalizeToolStatus(toolState?.status);
	const normalizedToolName = normalizeToolName(toolName);
	const isSearchTool = normalizedToolName.includes('search');
	const webSearchItems = useMemo(
		() =>
			isWebSearchTool(toolName) || isSearchTool ? extractWebSearchTimelineItems(toolState) : [],
		[isSearchTool, toolName, toolState]
	);
	const hasWebSearchItems = webSearchItems.length > 0;
	const runningSearches = webSearchItems.filter((item) => item.status === 'running').length;
	const failedSearches = webSearchItems.filter((item) => item.status === 'error').length;
	const totalResults = webSearchItems.reduce((total, item) => total + item.resultCount, 0);
	const toolDisplay = useMemo(() => buildToolDisplayData(toolState), [toolState]);
	const durationMs = getToolDurationMs(toolState, log.timestamp);
	const suppressRawSearchDetails = isSearchTool && toolStatus === 'running' && !hasWebSearchItems;
	const showToolDetails = toolStatus === 'running' || expanded;
	const collapsedSourceDomains = hasWebSearchItems
		? collectSearchSourceDomains(toolState, webSearchItems)
		: [];
	const canToggleToolDetails =
		toolStatus !== 'running' &&
		(hasWebSearchItems || toolDisplay.detailRows.length > 0 || !!toolDisplay.outputDetail);
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
			? 'Searching web...'
			: toolDisplay.summary;
	const searchTimelineSummary = `${totalResults} result${totalResults === 1 ? '' : 's'} • ${
		webSearchItems.length
	} search${webSearchItems.length === 1 ? '' : 'es'}${
		runningSearches > 0 ? ` • ${runningSearches} running` : ''
	}${failedSearches > 0 ? ` • ${failedSearches} failed` : ''}`;
	const statusColor =
		toolStatus === 'completed'
			? theme.colors.success
			: toolStatus === 'error'
				? theme.colors.error
				: theme.colors.warning;
	const statusLabel =
		toolStatus === 'completed' ? '[DONE]' : toolStatus === 'error' ? '[ERROR]' : '[RUN]';

	return (
		<div
			style={{
				padding: '10px 12px 10px 14px',
				borderRadius: '12px',
				backgroundColor: `${theme.colors.bgMain}96`,
				border: `1px solid ${theme.colors.border}`,
				borderLeft: `2px solid ${statusColor}`,
				fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
			}}
		>
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '8px',
					flexWrap: 'wrap',
				}}
			>
				<style>
					{`@keyframes maestro-mobile-tool-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.88); } }`}
				</style>
				<span aria-hidden="true" style={{ color: statusColor, fontSize: '12px', lineHeight: 1 }}>
					{toolStatus === 'running' ? '◐' : '●'}
				</span>
				<span
					style={{
						fontSize: '12px',
						fontWeight: 600,
						color: theme.colors.textMain,
					}}
				>
					{toolName}
				</span>
				<span
					style={{
						fontSize: '10px',
						fontWeight: 700,
						letterSpacing: '0.08em',
						textTransform: 'uppercase',
						color: statusColor,
					}}
				>
					{statusLabel}
				</span>
				{toolStatus === 'running' && (
					<span
						aria-label="Tool running"
						style={{
							color: statusColor,
							fontSize: '10px',
							lineHeight: 1,
							animation: 'maestro-mobile-tool-pulse 1.4s ease-in-out infinite',
						}}
					>
						●
					</span>
				)}
				{durationMs !== null && (
					<span
						style={{
							fontSize: '10px',
							color: theme.colors.textDim,
						}}
					>
						{formatDurationMs(durationMs)}
					</span>
				)}
				{!showToolDetails && toolSummary && (
					<span
						style={{
							fontSize: '11px',
							color: theme.colors.textDim,
							minWidth: 0,
							flex: 1,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						}}
						title={toolSummary}
					>
						{toolSummary}
					</span>
				)}
				{canToggleToolDetails && (
					<button
						type="button"
						onClick={onToggleExpanded}
						style={{
							marginLeft: 'auto',
							display: 'inline-flex',
							alignItems: 'center',
							justifyContent: 'center',
							width: '20px',
							height: '20px',
							padding: 0,
							borderRadius: '999px',
							border: `1px solid ${theme.colors.border}`,
							backgroundColor: `${theme.colors.bgMain}80`,
							color: theme.colors.textDim,
							cursor: 'pointer',
						}}
						aria-label={showToolDetails ? 'Collapse tool details' : 'Expand tool details'}
						title={showToolDetails ? 'Collapse' : 'Expand'}
					>
						{showToolDetails ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
					</button>
				)}
			</div>

			{!showToolDetails && collapsedSourceDomains.length > 0 && (
				<div
					style={{
						display: 'flex',
						flexWrap: 'wrap',
						gap: '6px',
						marginTop: '8px',
					}}
				>
					{collapsedSourceDomains.slice(0, 6).map((domain) => (
						<span
							key={`${log.id || log.timestamp}-${domain}`}
							style={{
								padding: '3px 7px',
								borderRadius: '999px',
								backgroundColor: `${theme.colors.bgMain}aa`,
								border: `1px solid ${theme.colors.border}`,
								fontSize: '10px',
								color: theme.colors.textDim,
							}}
						>
							{domain}
						</span>
					))}
				</div>
			)}

			{showToolDetails && (
				<div
					style={{
						marginTop: '10px',
						display: 'flex',
						flexDirection: 'column',
						gap: '10px',
					}}
				>
					{suppressRawSearchDetails && (
						<div style={{ fontSize: '11px', color: theme.colors.textDim, fontStyle: 'italic' }}>
							Searching web...
						</div>
					)}

					{hasWebSearchItems && (
						<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
							<div
								style={{
									fontSize: '10px',
									fontWeight: 700,
									letterSpacing: '0.08em',
									textTransform: 'uppercase',
									color: theme.colors.textDim,
								}}
							>
								Web Search Timeline
							</div>
							<div
								style={{
									fontSize: '10px',
									color: theme.colors.textDim,
								}}
							>
								{searchTimelineSummary}
							</div>
							{webSearchItems.map((item, index) => {
								const responseDomains = getWebSearchResponseDomains(item);
								const searchStatusColor =
									item.status === 'completed'
										? theme.colors.success
										: item.status === 'error'
											? theme.colors.error
											: theme.colors.warning;
								return (
									<div
										key={`${item.id}-${index}`}
										style={{
											padding: '8px 0 8px 12px',
											borderRadius: '0 10px 10px 0',
											backgroundColor: `${theme.colors.bgActivity}55`,
											borderLeft: `2px solid ${searchStatusColor}`,
											display: 'flex',
											flexDirection: 'column',
											gap: '8px',
										}}
									>
										<div
											style={{
												display: 'flex',
												alignItems: 'flex-start',
												justifyContent: 'space-between',
												gap: '10px',
											}}
										>
											<div style={{ minWidth: 0 }}>
												<div
													style={{
														fontSize: '10px',
														fontWeight: 700,
														letterSpacing: '0.08em',
														textTransform: 'uppercase',
														color: searchStatusColor,
													}}
												>
													{item.status}
												</div>
												<div
													style={{
														fontSize: '11px',
														color: theme.colors.textMain,
														marginTop: '4px',
														wordBreak: 'break-word',
													}}
												>
													{item.query}
												</div>
											</div>
											<div
												style={{
													fontSize: '10px',
													color: theme.colors.textDim,
													flexShrink: 0,
												}}
											>
												{item.resultCount} result{item.resultCount === 1 ? '' : 's'}
											</div>
										</div>
										{item.responsePreview && (
											<div
												style={{
													padding: '2px 0 2px 10px',
													borderRadius: '0 8px 8px 0',
													backgroundColor: `${theme.colors.bgMain}66`,
													borderLeft: `2px solid ${theme.colors.border}`,
													fontSize: '10px',
													color: theme.colors.textDim,
													whiteSpace: 'pre-wrap',
													wordBreak: 'break-word',
												}}
											>
												{item.responsePreview}
											</div>
										)}
										{responseDomains.length > 0 && (
											<div
												style={{
													display: 'flex',
													flexDirection: 'column',
													gap: '6px',
												}}
											>
												<div
													style={{
														fontSize: '10px',
														fontWeight: 700,
														letterSpacing: '0.08em',
														textTransform: 'uppercase',
														color: theme.colors.textDim,
													}}
												>
													Response Sources
												</div>
												<div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
													{responseDomains.map((domain) => (
														<span
															key={`${item.id}-${domain}`}
															style={{
																padding: '3px 7px',
																borderRadius: '999px',
																backgroundColor: `${theme.colors.bgSidebar}bb`,
																border: `1px solid ${theme.colors.border}`,
																fontSize: '10px',
																color: theme.colors.textDim,
															}}
														>
															{domain}
														</span>
													))}
												</div>
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}

					{!hasWebSearchItems &&
						!suppressRawSearchDetails &&
						toolDisplay.detailRows.map((row) => (
							<div
								key={`${log.id || log.timestamp}-${row.label}-${row.value}`}
								style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}
							>
								<span
									style={{
										fontSize: '10px',
										fontWeight: 700,
										letterSpacing: '0.08em',
										textTransform: 'uppercase',
										color: theme.colors.textDim,
										flexShrink: 0,
									}}
								>
									{row.label}
								</span>
								<span
									style={{
										fontSize: '11px',
										color: theme.colors.textMain,
										whiteSpace: 'pre-wrap',
										wordBreak: 'break-word',
									}}
								>
									{row.value}
								</span>
							</div>
						))}

					{!hasWebSearchItems && !suppressRawSearchDetails && toolDisplay.outputDetail && (
						<div>
							<div
								style={{
									fontSize: '10px',
									fontWeight: 700,
									letterSpacing: '0.08em',
									textTransform: 'uppercase',
									color: theme.colors.textDim,
									marginBottom: '6px',
								}}
							>
								Output
							</div>
							<div
								style={{
									padding: '9px 10px',
									borderRadius: '12px',
									backgroundColor: `${theme.colors.bgMain}cc`,
									border: `1px solid ${theme.colors.border}`,
									fontSize: '11px',
									color: theme.colors.textMain,
									whiteSpace: 'pre-wrap',
									wordBreak: 'break-word',
									maxHeight: '220px',
									overflow: 'auto',
								}}
							>
								{toolDisplay.outputDetail}
							</div>
						</div>
					)}

					{toolStatus === 'running' && !toolDisplay.outputDetail && !suppressRawSearchDetails && (
						<div style={{ fontSize: '11px', color: theme.colors.textDim, fontStyle: 'italic' }}>
							Waiting for tool output...
						</div>
					)}
				</div>
			)}
		</div>
	);
}

export default ToolActivityBlock;
