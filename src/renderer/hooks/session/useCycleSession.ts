/**
 * useCycleSession — extracted from App.tsx
 *
 * Provides session cycling functionality (Cmd+Shift+[/]):
 *   - Cycles through sessions and group chats in visual sidebar order
 *   - Handles bookmarks (sessions appearing in both locations)
 *   - Handles worktree children, collapsed groups, collapsed sidebar
 *   - Handles group chat cycling
 *
 * Reads from: sessionStore, groupChatStore, uiStore
 */

import { useCallback, useMemo } from 'react';
import type { Session, SidebarThreadTarget } from '../../types';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useUIStore } from '../../stores/uiStore';
import { compareNamesIgnoringEmojis } from '../session/useSortedSessions';
import { findActiveThreadForSession } from '../../utils/workspaceThreads';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseCycleSessionDeps {
	/** Sorted sessions array (used when sidebar is collapsed) */
	sortedSessions: Session[];
	/** Visible thread rows in sidebar order (used when sidebar is expanded) */
	sidebarThreadTargets: SidebarThreadTarget[];
	/** Open a group chat (loads messages etc.) */
	handleOpenGroupChat: (groupChatId: string) => void;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseCycleSessionReturn {
	/** Cycle to next or previous session/group chat in visual order */
	cycleSession: (dir: 'next' | 'prev') => void;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useCycleSession(deps: UseCycleSessionDeps): UseCycleSessionReturn {
	const { sortedSessions, sidebarThreadTargets, handleOpenGroupChat } = deps;

	// --- Reactive subscriptions ---
	const threads = useSessionStore((s) => s.threads);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const activeSession = useSessionStore(selectActiveSession);
	// cyclePosition tracks where we are in the visual order for cycling
	const groupChats = useGroupChatStore((s) => s.groupChats);
	const activeGroupChatId = useGroupChatStore((s) => s.activeGroupChatId);
	const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen);
	const groupChatsExpanded = useUIStore((s) => s.groupChatsExpanded);

	// --- Store actions (stable via getState) ---
	const { setActiveSessionIdInternal, setCyclePosition, setSessions, setThreads } =
		useSessionStore.getState();
	const { setActiveGroupChatId } = useGroupChatStore.getState();

	const activeSidebarThreadTargetId = useMemo(() => {
		if (!leftSidebarOpen || !activeSession) return null;

		const activeThread = findActiveThreadForSession(threads, activeSession);
		if (!activeThread) return null;

		const activeTabId = activeSession.activeTabId || activeSession.aiTabs?.[0]?.id || null;
		return (
			sidebarThreadTargets.find(
				(target) =>
					target.threadId === activeThread.id &&
					target.sessionId === activeSession.id &&
					target.tabId === activeTabId
			)?.id ||
			sidebarThreadTargets.find(
				(target) => target.threadId === activeThread.id && target.sessionId === activeSession.id
			)?.id ||
			null
		);
	}, [activeSession, leftSidebarOpen, sidebarThreadTargets, threads]);

	const cycleSession = useCallback(
		(dir: 'next' | 'prev') => {
			type VisualOrderItem =
				| { type: 'session'; id: string; name: string }
				| { type: 'thread'; id: string; name: string; target: SidebarThreadTarget }
				| { type: 'groupChat'; id: string; name: string };

			const visualOrder: VisualOrderItem[] = [];
			const openThreadTarget = (target: SidebarThreadTarget) => {
				setActiveGroupChatId(null);
				setActiveSessionIdInternal(target.sessionId);

				setSessions((prev) =>
					prev.map((session) => {
						if (session.id !== target.sessionId) return session;
						const nextTabId =
							target.tabId && session.aiTabs?.some((tab) => tab.id === target.tabId)
								? target.tabId
								: session.activeTabId;
						return {
							...session,
							...(nextTabId ? { activeTabId: nextTabId } : {}),
							activeFileTabId: null,
							inputMode: 'ai',
						};
					})
				);
			};

			if (sidebarThreadTargets.length > 0) {
				visualOrder.push(
					...sidebarThreadTargets.map((target) => ({
						type: 'thread' as const,
						id: target.id,
						name: target.threadId,
						target,
					}))
				);

				const activeGroupChats = groupChats.filter((gc) => !gc.archived);
				if (leftSidebarOpen && groupChatsExpanded && activeGroupChats.length > 0) {
					const sortedGroupChats = [...activeGroupChats].sort((a, b) =>
						compareNamesIgnoringEmojis(a.name, b.name)
					);
					visualOrder.push(
						...sortedGroupChats.map((gc) => ({
							type: 'groupChat' as const,
							id: gc.id,
							name: gc.name,
						}))
					);
				}
			} else {
				// Sidebar collapsed: cycle through all sessions in their sorted order
				visualOrder.push(
					...sortedSessions.map((s) => ({
						type: 'session' as const,
						id: s.id,
						name: s.name,
					}))
				);
			}

			if (visualOrder.length === 0) return;

			const currentActiveId =
				activeGroupChatId || (sidebarThreadTargets.length > 0 ? activeSidebarThreadTargetId : activeSessionId);
			const currentIsGroupChat = activeGroupChatId !== null;
			const currentIsThread = !currentIsGroupChat && sidebarThreadTargets.length > 0;

			let currentIndex = useSessionStore.getState().cyclePosition;
			if (
				currentIndex < 0 ||
				currentIndex >= visualOrder.length ||
				visualOrder[currentIndex].id !== currentActiveId
			) {
				currentIndex = visualOrder.findIndex(
					(item) =>
						item.id === currentActiveId &&
						(currentIsGroupChat
							? item.type === 'groupChat'
							: currentIsThread
								? item.type === 'thread'
								: item.type === 'session')
				);
			}

			if (currentIndex === -1) {
				setCyclePosition(0);
				const firstItem = visualOrder[0];
				if (firstItem.type === 'session') {
					setActiveGroupChatId(null);
					setActiveSessionIdInternal(firstItem.id);
				} else if (firstItem.type === 'thread') {
					openThreadTarget(firstItem.target);
				} else {
					handleOpenGroupChat(firstItem.id);
				}
				return;
			}

			let nextIndex;
			if (dir === 'next') {
				nextIndex = currentIndex === visualOrder.length - 1 ? 0 : currentIndex + 1;
			} else {
				nextIndex = currentIndex === 0 ? visualOrder.length - 1 : currentIndex - 1;
			}

			setCyclePosition(nextIndex);
			const nextItem = visualOrder[nextIndex];
			if (nextItem.type === 'session') {
				setActiveGroupChatId(null);
				setActiveSessionIdInternal(nextItem.id);
			} else if (nextItem.type === 'thread') {
				openThreadTarget(nextItem.target);
			} else {
				handleOpenGroupChat(nextItem.id);
			}
		},
		[
			activeSessionId,
			activeSession,
			activeSidebarThreadTargetId,
			activeGroupChatId,
			groupChats,
			handleOpenGroupChat,
			groupChatsExpanded,
			leftSidebarOpen,
			setActiveGroupChatId,
			setActiveSessionIdInternal,
			setSessions,
			sidebarThreadTargets,
			sortedSessions,
		]
	);

	return { cycleSession };
}
