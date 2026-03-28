import type { ThemeColors } from '../../shared/theme-types';
import type { ConductorOrchestratorUpdate } from '../../shared/conductorUpdates';

interface MobileUpdatesPanelProps {
	colors: ThemeColors;
	updates: ConductorOrchestratorUpdate[];
	planningSummary?: string | null;
	onOpenTask: (taskId: string) => void;
	onAskUpdate: (update: ConductorOrchestratorUpdate) => void;
}

function getToneColor(colors: ThemeColors, tone: ConductorOrchestratorUpdate['tone']): string {
	switch (tone) {
		case 'success':
			return colors.success;
		case 'warning':
			return colors.warning;
		case 'progress':
			return colors.accent;
		case 'default':
		default:
			return colors.textDim;
	}
}

function formatRelativeTime(ts: number): string {
	const delta = Date.now() - ts;
	const seconds = Math.floor(delta / 1000);
	if (seconds < 60) return 'just now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function hasDistinctDetail(update: ConductorOrchestratorUpdate): boolean {
	if (!update.detail) return false;
	const summary = update.summary.trim().toLowerCase();
	const detail = update.detail.trim().toLowerCase();
	return detail.length > 0 && detail !== summary;
}

export function MobileUpdatesPanel({
	colors,
	updates,
	planningSummary,
	onOpenTask,
	onAskUpdate,
}: MobileUpdatesPanelProps): JSX.Element {
	return (
		<div
			style={{
				borderRadius: '14px',
				overflow: 'hidden',
				backgroundColor: colors.bgSidebar,
				border: '1px solid rgba(255,255,255,0.08)',
			}}
		>
			{/* Header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '8px',
					padding: '10px 14px',
					borderBottom: '1px solid rgba(255,255,255,0.06)',
					backgroundColor: 'rgba(255,255,255,0.03)',
				}}
			>
				<span
					style={{
						fontSize: '11px',
						fontWeight: 700,
						textTransform: 'uppercase',
						letterSpacing: '0.06em',
						color: colors.textDim,
					}}
				>
					Updates
				</span>
				{planningSummary && (
					<span
						style={{
							marginLeft: 'auto',
							fontSize: '11px',
							color: colors.textDim,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
							maxWidth: '50%',
						}}
					>
						{planningSummary}
					</span>
				)}
			</div>

			{/* Scrollable body */}
			<div
				style={{
					maxHeight: 400,
					overflowY: 'auto',
					WebkitOverflowScrolling: 'touch',
				}}
			>
				{updates.length > 0 ? (
					<div>
						{updates.map((update, index) => {
							const toneColor = getToneColor(colors, update.tone);
							return (
								<div
									key={update.id}
									style={{
										padding: '10px 14px',
										borderTop: index > 0 ? '1px solid rgba(255,255,255,0.05)' : 'none',
									}}
								>
									{/* Top row: dot + badge + task + time */}
									<div
										style={{
											display: 'flex',
											alignItems: 'center',
											gap: '6px',
											minWidth: 0,
										}}
									>
										<span
											style={{
												width: '6px',
												height: '6px',
												borderRadius: '50%',
												backgroundColor: toneColor,
												flexShrink: 0,
											}}
										/>
										<span
											style={{
												fontSize: '11px',
												fontWeight: 700,
												color: toneColor,
												flexShrink: 0,
											}}
										>
											{update.badge}
										</span>
										{update.taskId && update.taskTitle && (
											<button
												type="button"
												onClick={() => onOpenTask(update.taskId!)}
												style={{
													fontSize: '11px',
													color: colors.textDim,
													background: 'none',
													border: 'none',
													padding: 0,
													cursor: 'pointer',
													overflow: 'hidden',
													textOverflow: 'ellipsis',
													whiteSpace: 'nowrap',
													maxWidth: '120px',
													flexShrink: 0,
													textDecoration: 'underline',
													textDecorationColor: 'rgba(255,255,255,0.15)',
												}}
											>
												{update.taskTitle}
											</button>
										)}
										<span
											style={{
												marginLeft: 'auto',
												fontSize: '10px',
												color: colors.textDim,
												flexShrink: 0,
											}}
										>
											{formatRelativeTime(update.createdAt)}
										</span>
									</div>

									{/* Summary */}
									<div
										style={{
											fontSize: '12px',
											marginTop: '4px',
											lineHeight: 1.4,
											color: colors.textMain,
											display: '-webkit-box',
											WebkitLineClamp: 2,
											WebkitBoxOrient: 'vertical',
											overflow: 'hidden',
										}}
									>
										{update.summary}
									</div>

									{/* Detail */}
									{hasDistinctDetail(update) && (
										<div
											style={{
												fontSize: '11px',
												marginTop: '3px',
												lineHeight: 1.4,
												color: colors.textDim,
												display: '-webkit-box',
												WebkitLineClamp: 1,
												WebkitBoxOrient: 'vertical',
												overflow: 'hidden',
											}}
										>
											{update.detail}
										</div>
									)}

									{/* Ask link */}
									<button
										type="button"
										onClick={() => onAskUpdate(update)}
										style={{
											fontSize: '10px',
											marginTop: '5px',
											fontWeight: 600,
											color: colors.accent,
											background: 'none',
											border: 'none',
											padding: 0,
											cursor: 'pointer',
										}}
									>
										Ask about this
									</button>
								</div>
							);
						})}
					</div>
				) : (
					<div
						style={{
							padding: '20px 14px',
							fontSize: '12px',
							color: colors.textDim,
						}}
					>
						No updates yet.
					</div>
				)}
			</div>
		</div>
	);
}
