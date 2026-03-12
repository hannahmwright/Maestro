import React, { memo } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { Theme } from '../types';

export interface ThreadTurnMarker {
	key: string;
	label: string;
	timestamp: number;
}

interface ThreadBarProps {
	theme: Theme;
	threadTitle: string;
	contextUsagePercentage?: number | null;
	contextUsageColor?: string;
	onNewThread?: () => void;
}

function ThreadBarInner({
	theme,
	threadTitle,
	contextUsagePercentage = null,
	contextUsageColor,
	onNewThread,
}: ThreadBarProps) {
	const clampedContextUsage =
		contextUsagePercentage === null ? null : Math.max(0, Math.min(100, contextUsagePercentage));
	const contextColor = contextUsageColor || theme.colors.textDim;

	return (
		<div
			className="flex items-center gap-3 px-4 py-3 border-b shrink-0"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			}}
			data-tour="thread-bar"
		>
			<div className="min-w-0 flex-1 flex items-center gap-4 overflow-hidden">
				<div className="min-w-0">
					<div
						className="text-[10px] font-bold uppercase tracking-[0.18em]"
						style={{ color: theme.colors.textDim }}
					>
						Thread
					</div>
					<div
						className="text-sm font-semibold truncate"
						style={{ color: theme.colors.textMain }}
						title={threadTitle}
					>
						{threadTitle}
					</div>
				</div>
			</div>

			{clampedContextUsage !== null && (
				<div
					className="inline-flex items-center justify-center shrink-0"
					title={`Context window ${clampedContextUsage}% used`}
					aria-label={`Context window ${clampedContextUsage}% used`}
					style={{
						width: '32px',
						height: '32px',
						borderRadius: '999px',
						background: `conic-gradient(${contextColor} ${clampedContextUsage * 3.6}deg, ${theme.colors.border} 0deg)`,
					}}
				>
					<div
						className="inline-flex items-center justify-center rounded-full text-[9px] font-bold"
						style={{
							width: '24px',
							height: '24px',
							backgroundColor: theme.colors.bgMain,
							color: contextColor,
						}}
					>
						{clampedContextUsage}%
					</div>
				</div>
			)}

			{onNewThread && (
				<button
					type="button"
					onClick={onNewThread}
					className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold transition-colors hover:bg-white/5 shrink-0"
					style={{
						borderColor: `${theme.colors.accent}40`,
						color: theme.colors.textMain,
						backgroundColor: `${theme.colors.accent}14`,
					}}
					title="Start a new chat in this workspace"
					aria-label="New Chat"
				>
					<MessageSquarePlus className="w-4 h-4" style={{ color: theme.colors.accent }} />
					<span>New Chat</span>
				</button>
			)}
		</div>
	);
}

export const ThreadBar = memo(ThreadBarInner);
