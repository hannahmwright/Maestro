import { memo } from 'react';
import { Loader2 } from 'lucide-react';
import type { Session, Theme, SidebarThreadTarget } from '../../types';
import { SessionTooltipContent } from './SessionTooltipContent';

export interface SkinnySidebarThreadItem {
	target: SidebarThreadTarget;
	session: Session;
	displayName: string;
	groupName?: string;
}

interface SkinnySidebarProps {
	theme: Theme;
	threadItems: SkinnySidebarThreadItem[];
	activeThreadTargetId: string | null;
	activeBatchSessionIds: string[];
	contextWarningYellowThreshold: number;
	contextWarningRedThreshold: number;
	getFileCount: (sessionId: string) => number;
	openThreadTarget: (target: SidebarThreadTarget) => void;
	handleContextMenu: (e: React.MouseEvent, sessionId: string, threadId?: string) => void;
}

export const SkinnySidebar = memo(function SkinnySidebar({
	theme,
	threadItems,
	activeThreadTargetId,
	activeBatchSessionIds,
	contextWarningYellowThreshold,
	contextWarningRedThreshold,
	getFileCount,
	openThreadTarget,
	handleContextMenu,
}: SkinnySidebarProps) {
	return (
		<div className="flex-1 flex flex-col items-center py-4 gap-2 overflow-y-auto overflow-x-visible no-scrollbar">
			{threadItems.map(({ target, session, displayName, groupName }) => {
				const isInBatch = activeBatchSessionIds.includes(session.id);
				const hasUnreadTabs = session.aiTabs?.some((tab) => tab.hasUnread);
				const isWorking = session.state === 'busy' || isInBatch;
				const isActive = activeThreadTargetId === target.id;

				return (
					<div
						key={target.id}
						role="button"
						tabIndex={0}
						aria-label={`Switch to ${displayName}`}
						onClick={() => openThreadTarget(target)}
						onContextMenu={(e) => handleContextMenu(e, session.id, target.threadId)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								openThreadTarget(target);
							}
						}}
						className={`group relative w-8 h-8 rounded-full flex items-center justify-center cursor-pointer transition-all outline-none ${isActive ? '' : 'hover:bg-white/10'}`}
					>
						<div className="relative">
							{isWorking ? (
								<span title="Agent is working">
									<Loader2
										className="w-3 h-3 animate-spin"
										style={{
											opacity: isActive ? 1 : 0.6,
											color: isInBatch ? theme.colors.warning : theme.colors.accent,
										}}
									/>
								</span>
							) : hasUnreadTabs ? (
								<div
									className="w-2 h-2 rounded-full"
									style={{
										opacity: isActive ? 1 : 0.7,
										backgroundColor: theme.colors.accent,
									}}
									title="Awaiting your input"
								/>
							) : (
								<div
									className="w-2 h-2 rounded-full"
									style={{
										opacity: isActive ? 0.9 : 0.35,
										border: `1px solid ${theme.colors.textDim}`,
										backgroundColor: 'transparent',
									}}
									title="Idle"
								/>
							)}
						</div>

						{/* Hover Tooltip for Skinny Mode */}
						<div
							className="fixed rounded px-3 py-2 z-[100] opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity shadow-xl"
							style={{
								minWidth: '240px',
								left: '80px',
								backgroundColor: theme.colors.bgSidebar,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<SessionTooltipContent
								session={session}
								theme={theme}
								displayName={displayName}
								gitFileCount={getFileCount(session.id)}
								groupName={groupName}
								isInBatch={isInBatch}
								contextWarningYellowThreshold={contextWarningYellowThreshold}
								contextWarningRedThreshold={contextWarningRedThreshold}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
});
