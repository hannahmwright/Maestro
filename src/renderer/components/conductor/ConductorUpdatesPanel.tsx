import { MessageSquareText } from 'lucide-react';

import type { Theme } from '../../types';
import type { ConductorOrchestratorUpdate } from '../../../shared/conductorUpdates';

interface ConductorUpdatesPanelProps {
	theme: Theme;
	updates: ConductorOrchestratorUpdate[];
	planningSummary?: string | null;
	onOpenTask: (taskId: string) => void;
	onAskUpdate: (update: ConductorOrchestratorUpdate) => void;
	maxBodyHeight?: number;
}

function getToneColor(
	theme: Theme,
	tone: ConductorOrchestratorUpdate['tone']
): string {
	switch (tone) {
		case 'success':
			return theme.colors.success;
		case 'warning':
			return theme.colors.warning;
		case 'progress':
			return theme.colors.accent;
		case 'default':
		default:
			return theme.colors.textDim;
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

export function ConductorUpdatesPanel({
	theme,
	updates,
	planningSummary,
	onOpenTask,
	onAskUpdate,
	maxBodyHeight,
}: ConductorUpdatesPanelProps): JSX.Element {
	return (
		<div
			className="rounded-xl overflow-hidden"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				border: '1px solid rgba(255,255,255,0.08)',
			}}
		>
			{/* Header */}
			<div
				className="flex items-center gap-2 px-3 py-2"
				style={{
					borderBottom: '1px solid rgba(255,255,255,0.06)',
					backgroundColor: 'rgba(255,255,255,0.03)',
				}}
			>
				<MessageSquareText className="w-3 h-3" style={{ color: theme.colors.textDim }} />
				<span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: theme.colors.textDim }}>
					Updates
				</span>
				{planningSummary && (
					<span className="ml-auto text-[11px] truncate max-w-[50%]" style={{ color: theme.colors.textDim }}>
						{planningSummary}
					</span>
				)}
			</div>

			{/* Scrollable body */}
			<div
				className="overflow-y-auto scrollbar-thin"
				style={{ maxHeight: maxBodyHeight || 340 }}
			>
				{updates.length > 0 ? (
					<div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
						{updates.map((update) => {
							const color = getToneColor(theme, update.tone);
							return (
								<div
									key={update.id}
									className="px-3 py-2 hover:bg-white/[0.02] transition-colors"
								>
									{/* Top row: badge + task + time */}
									<div className="flex items-center gap-1.5 min-w-0">
										<span
											className="w-1.5 h-1.5 rounded-full shrink-0"
											style={{ backgroundColor: color }}
										/>
										<span
											className="text-[11px] font-medium shrink-0"
											style={{ color }}
										>
											{update.badge}
										</span>
										{update.taskId && update.taskTitle && (
											<button
												type="button"
												onClick={() => onOpenTask(update.taskId!)}
												className="text-[11px] truncate hover:underline shrink-0 max-w-[140px]"
												style={{ color: theme.colors.textDim }}
											>
												{update.taskTitle}
											</button>
										)}
										<span className="ml-auto text-[10px] shrink-0" style={{ color: theme.colors.textDim }}>
											{formatRelativeTime(update.createdAt)}
										</span>
									</div>

									{/* Summary */}
									<div
										className="text-xs mt-0.5 leading-snug line-clamp-2"
										style={{ color: theme.colors.textMain }}
									>
										{update.summary}
									</div>

									{/* Detail (collapsed to one line) */}
									{hasDistinctDetail(update) && (
										<div
											className="text-[11px] mt-0.5 leading-snug line-clamp-1"
											style={{ color: theme.colors.textDim }}
										>
											{update.detail}
										</div>
									)}

									{/* Ask link */}
									<button
										type="button"
										onClick={() => onAskUpdate(update)}
										className="text-[10px] mt-1 font-medium hover:underline"
										style={{ color: theme.colors.accent }}
									>
										Ask about this
									</button>
								</div>
							);
						})}
					</div>
				) : (
					<div className="px-3 py-4 text-xs" style={{ color: theme.colors.textDim }}>
						No updates yet.
					</div>
				)}
			</div>
		</div>
	);
}
