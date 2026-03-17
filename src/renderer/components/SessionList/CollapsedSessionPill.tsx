import { memo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Session, Theme, Thread } from '../../types';
import { SessionTooltipContent } from './SessionTooltipContent';
import { hasUnreadForThread, isThreadBusyForSession } from '../../utils/workspaceThreads';

interface CollapsedSessionPillProps {
	thread: Thread;
	session: Session;
	keyPrefix: string;
	theme: Theme;
	activeBatchSessionIds: string[];
	leftSidebarWidth: number;
	contextWarningYellowThreshold: number;
	contextWarningRedThreshold: number;
	getFileCount: (sessionId: string) => number;
	displayName: string;
	onSelect: () => void;
}

export const CollapsedSessionPill = memo(function CollapsedSessionPill({
	thread,
	session,
	keyPrefix,
	theme,
	activeBatchSessionIds,
	leftSidebarWidth,
	contextWarningYellowThreshold,
	contextWarningRedThreshold,
	getFileCount,
	displayName,
	onSelect,
}: CollapsedSessionPillProps) {
	const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);
	const isInBatch = activeBatchSessionIds.includes(session.id);
	const isWorking =
		isThreadBusyForSession(thread, session) || isInBatch || Boolean(session.cliActivity);
	const hasUnreadTabs = hasUnreadForThread(thread, session);

	return (
		<div
			key={`${keyPrefix}-${thread.id}`}
			className="relative flex-1 flex rounded-full overflow-hidden opacity-50 hover:opacity-100 transition-opacity"
		>
			<div
				role="button"
				tabIndex={0}
				aria-label={`Switch to ${displayName}`}
				className="group/segment relative flex-1 h-full flex items-center justify-center"
				style={{
					backgroundColor: `${theme.colors.textDim}22`,
					border: `1px solid ${theme.colors.border}`,
					borderRadius: '9999px',
				}}
				onMouseEnter={(e) => setTooltipPosition({ x: e.clientX, y: e.clientY })}
				onMouseLeave={() => setTooltipPosition(null)}
				onFocus={(e) =>
					setTooltipPosition({
						x: e.currentTarget.getBoundingClientRect().x,
						y: e.currentTarget.getBoundingClientRect().y,
					})
				}
				onBlur={() => setTooltipPosition(null)}
				onClick={(e) => {
					e.stopPropagation();
					onSelect();
				}}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						e.stopPropagation();
						onSelect();
					}
				}}
			>
				{isWorking ? (
					<span title="Agent is working">
						<Loader2
							className="w-3 h-3 animate-spin"
							style={{ color: isInBatch ? theme.colors.warning : theme.colors.accent }}
						/>
					</span>
				) : hasUnreadTabs ? (
					<div
						className="w-2 h-2 rounded-full"
						style={{ backgroundColor: theme.colors.accent }}
						title="Awaiting your input"
					/>
				) : null}
				<div
					className="fixed rounded px-3 py-2 z-[100] opacity-0 group-hover/segment:opacity-100 pointer-events-none transition-opacity shadow-xl"
					style={{
						minWidth: '240px',
						left: `${leftSidebarWidth + 8}px`,
						top: tooltipPosition ? `${tooltipPosition.y}px` : undefined,
						backgroundColor: theme.colors.bgSidebar,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					<SessionTooltipContent
						session={session}
						theme={theme}
						displayName={displayName}
						gitFileCount={getFileCount(session.id)}
						isInBatch={isInBatch}
						contextWarningYellowThreshold={contextWarningYellowThreshold}
						contextWarningRedThreshold={contextWarningRedThreshold}
					/>
				</div>
			</div>
		</div>
	);
});
