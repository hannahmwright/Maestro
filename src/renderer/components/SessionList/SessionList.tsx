import React, { useState, useEffect, useRef, useMemo, memo, useCallback } from 'react';
import {
	Plus,
	ChevronRight,
	ChevronDown,
	ChevronUp,
	Radio,
	GitBranch,
	Server,
	Menu,
	Bookmark,
	Trophy,
	Clock3,
	ArrowDownAZ,
} from 'lucide-react';
import type { Session, Group, Theme, Thread } from '../../types';
import { getBadgeForTime } from '../../constants/conductorBadges';
import { SessionItem } from '../SessionItem';
import { GroupChatList } from '../GroupChatList';
import { useLiveOverlay, useResizablePanel } from '../../hooks';
import { useGitFileStatus } from '../../contexts/GitStatusContext';
import { useUIStore } from '../../stores/uiStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useBatchStore, selectActiveBatchSessionIds } from '../../stores/batchStore';
import { useShallow } from 'zustand/react/shallow';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { getModalActions } from '../../stores/modalStore';
import { SessionContextMenu } from './SessionContextMenu';
import { GroupContextMenu } from './GroupContextMenu';
import { HamburgerMenuContent } from './HamburgerMenuContent';
import { CollapsedSessionPill } from './CollapsedSessionPill';
import { SidebarActions } from './SidebarActions';
import { SkinnySidebar } from './SkinnySidebar';
import { LiveOverlayPanel } from './LiveOverlayPanel';
import { useSessionFilterMode } from '../../hooks/session/useSessionFilterMode';
import { compareNamesIgnoringEmojis as compareNames } from '../../../shared/emojiUtils';
import {
	getRuntimeIdForSession,
	getRuntimeIdForThread,
	getSessionLastActivity,
	getThreadDisplayTitle,
} from '../../utils/workspaceThreads';
import { buildDefaultThreadName } from '../../utils/sessionValidation';

// ============================================================================
// SessionContextMenu - Right-click context menu for session items
// ============================================================================

interface SessionListProps {
	// Computed values (not in stores — remain as props)
	theme: Theme;
	sortedSessions: Session[];
	isLiveMode: boolean;
	webInterfaceUrl: string | null;
	showSessionJumpNumbers?: boolean;
	visibleSessions?: Session[];

	// Ref for the sidebar container (for focus management)
	sidebarContainerRef?: React.RefObject<HTMLDivElement>;

	// Domain handlers
	toggleGlobalLive: () => Promise<void>;
	restartWebServer: () => Promise<string | null>;
	toggleGroup: (groupId: string) => void;
	handleDragStart: (sessionId: string) => void;
	handleDragOver: (e: React.DragEvent) => void;
	handleDropOnGroup: (groupId: string) => void;
	handleDropOnUngrouped: () => void;
	finishRenamingGroup: (groupId: string, newName: string) => void;
	finishRenamingSession: (sessId: string, newName: string) => void;
	startRenamingGroup: (groupId: string) => void;
	startRenamingSession: (sessId: string) => void;
	showConfirmation: (message: string, onConfirm: () => void) => void;
	createNewGroup: () => void;
	onCreateGroupAndMove?: (sessionId: string) => void;
	addNewSession: () => void;
	onCreateSession: (
		agentId: string,
		workingDir: string,
		name: string,
		nudgeMessage?: string,
		customPath?: string,
		customArgs?: string,
		customEnvVars?: Record<string, string>,
		customModel?: string,
		customContextWindow?: number,
		customProviderPath?: string,
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
			workingDirOverride?: string;
		},
		workspaceId?: string
	) => Promise<void>;
	onDeleteSession?: (id: string) => void;
	onDeleteWorktreeGroup?: (groupId: string) => void;

	// Edit agent modal handler (for context menu edit)
	onEditAgent: (session: Session) => void;

	// Duplicate agent handlers (for context menu duplicate)
	onNewAgentSession: () => void;

	// Worktree handlers
	onToggleWorktreeExpanded?: (sessionId: string) => void;
	onOpenCreatePR?: (session: Session) => void;
	onQuickCreateWorktree?: (session: Session) => void;
	onOpenWorktreeConfig?: (session: Session) => void;
	onDeleteWorktree?: (session: Session) => void;

	// Wizard props
	openWizard?: () => void;

	// Tour props
	startTour?: () => void;
	onOpenConductor?: (groupId: string) => void;

	// Group Chat handlers
	onOpenGroupChat?: (id: string) => void;
	onNewGroupChat?: () => void;
	onEditGroupChat?: (id: string) => void;
	onRenameGroupChat?: (id: string) => void;
	onDeleteGroupChat?: (id: string) => void;
	onArchiveGroupChat?: (id: string, archived: boolean) => void;
}

function getSidebarHeaderButtonStyle(
	theme: Theme,
	options?: {
		active?: boolean;
		tint?: string;
	}
): React.CSSProperties {
	const active = options?.active ?? false;
	const tint = options?.tint || theme.colors.accent;

	return {
		backgroundColor: active ? `${tint}10` : 'transparent',
		border: `1px solid ${active ? `${tint}30` : 'transparent'}`,
		color: active ? theme.colors.textMain : theme.colors.textDim,
		boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.04)' : 'none',
	};
}

function getSidebarSectionTextStyle(theme: Theme): React.CSSProperties {
	return {
		color: theme.colors.textMain,
		opacity: 0.78,
	};
}

function getSidebarWorkspaceTextStyle(theme: Theme): React.CSSProperties {
	return {
		color: theme.colors.textMain,
		opacity: 1,
	};
}

function SessionListInner(props: SessionListProps) {
	// Store subscriptions
	const sessions = useSessionStore((s) => s.sessions);
	const groups = useSessionStore((s) => s.groups);
	const threads = useSessionStore((s) => s.threads);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen);
	const activeFocus = useUIStore((s) => s.activeFocus);
	const selectedSidebarIndex = useUIStore((s) => s.selectedSidebarIndex);
	const editingGroupId = useUIStore((s) => s.editingGroupId);
	const editingSessionId = useUIStore((s) => s.editingSessionId);
	const draggingSessionId = useUIStore((s) => s.draggingSessionId);
	const groupChatsExpanded = useUIStore((s) => s.groupChatsExpanded);
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const leftSidebarWidthState = useSettingsStore((s) => s.leftSidebarWidth);
	const workspaceSortMode = useSettingsStore((s) => s.workspaceSortMode);
	const defaultThreadProvider = useSettingsStore((s) => s.defaultThreadProvider);
	const webInterfaceUseCustomPort = useSettingsStore((s) => s.webInterfaceUseCustomPort);
	const webInterfaceCustomPort = useSettingsStore((s) => s.webInterfaceCustomPort);
	const autoRunStats = useSettingsStore((s) => s.autoRunStats);
	const contextWarningYellowThreshold = useSettingsStore(
		(s) => s.contextManagementSettings.contextWarningYellowThreshold
	);
	const contextWarningRedThreshold = useSettingsStore(
		(s) => s.contextManagementSettings.contextWarningRedThreshold
	);
	const activeBatchSessionIds = useBatchStore(useShallow(selectActiveBatchSessionIds));
	const groupChats = useGroupChatStore((s) => s.groupChats);
	const activeGroupChatId = useGroupChatStore((s) => s.activeGroupChatId);
	const groupChatState = useGroupChatStore((s) => s.groupChatState);
	const participantStates = useGroupChatStore((s) => s.participantStates);
	const groupChatStates = useGroupChatStore((s) => s.groupChatStates);
	const allGroupChatParticipantStates = useGroupChatStore((s) => s.allGroupChatParticipantStates);

	// Stable store actions
	const setActiveFocus = useUIStore.getState().setActiveFocus;
	const setLeftSidebarOpen = useUIStore.getState().setLeftSidebarOpen;
	const setGroupChatsExpanded = useUIStore.getState().setGroupChatsExpanded;
	const setActiveSessionIdRaw = useSessionStore.getState().setActiveSessionId;
	const setActiveGroupChatId = useGroupChatStore.getState().setActiveGroupChatId;
	const setActiveSessionId = useCallback(
		(id: string) => {
			setActiveGroupChatId(null);
			setActiveSessionIdRaw(id);
		},
		[setActiveSessionIdRaw, setActiveGroupChatId]
	);
	const setSessions = useSessionStore.getState().setSessions;
	const setThreads = useSessionStore.getState().setThreads;
	const setWebInterfaceUseCustomPort = useSettingsStore.getState().setWebInterfaceUseCustomPort;
	const setWebInterfaceCustomPort = useSettingsStore.getState().setWebInterfaceCustomPort;
	const setLeftSidebarWidthState = useSettingsStore.getState().setLeftSidebarWidth;
	const setWorkspaceSortMode = useSettingsStore.getState().setWorkspaceSortMode;

	// Modal actions (stable, accessed via store)
	const {
		setAboutModalOpen,
		setRenameInstanceModalOpen,
		setRenameInstanceValue,
		setRenameInstanceSessionId,
		setDuplicatingSessionId,
		setNewInstanceModalOpen,
		setNewInstanceMode,
		setNewInstanceWorkspaceId,
		setNewInstanceFixedWorkingDir,
		setNewInstanceDefaultAgentId,
	} = getModalActions();

	const {
		theme,
		sortedSessions,
		isLiveMode,
		webInterfaceUrl,
		toggleGlobalLive,
		restartWebServer,
		toggleGroup,
		handleDragStart,
		handleDragOver,
		handleDropOnUngrouped,
		finishRenamingGroup,
		finishRenamingSession,
		startRenamingGroup,
		startRenamingSession,
		onCreateSession,
		onDeleteSession,
		onEditAgent,
		onNewAgentSession,
		onToggleWorktreeExpanded,
		onOpenCreatePR,
		onQuickCreateWorktree,
		onOpenWorktreeConfig,
		onDeleteWorktree,
		onDeleteWorktreeGroup,
		showSessionJumpNumbers = false,
		visibleSessions = [],
		openWizard,
		startTour,
		sidebarContainerRef,
		onOpenGroupChat,
		onNewGroupChat,
		onEditGroupChat,
		onRenameGroupChat,
		onDeleteGroupChat,
		onArchiveGroupChat,
	} = props;

	// Derive whether any session is busy or in auto-run (for wand sparkle animation)
	const isAnyBusy = useMemo(
		() => sessions.some((s) => s.state === 'busy') || activeBatchSessionIds.length > 0,
		[sessions, activeBatchSessionIds]
	);

	const { sessionFilter, setSessionFilter } = useSessionFilterMode();
	const { onResizeStart: onSidebarResizeStart, transitionClass: sidebarTransitionClass } =
		useResizablePanel({
			width: leftSidebarWidthState,
			minWidth: 256,
			maxWidth: 600,
			settingsKey: 'leftSidebarWidth',
			setWidth: setLeftSidebarWidthState,
			side: 'left',
			externalRef: sidebarContainerRef,
		});
	const sessionFilterOpen = useUIStore((s) => s.sessionFilterOpen);
	const setSessionFilterOpen = useUIStore((s) => s.setSessionFilterOpen);
	const [menuOpen, setMenuOpen] = useState(false);

	// Live overlay state (extracted hook)
	const {
		liveOverlayOpen,
		setLiveOverlayOpen,
		liveOverlayRef,
		cloudflaredInstalled,
		cloudflaredChecked: _cloudflaredChecked,
		tunnelStatus,
		tunnelUrl,
		tunnelError,
		activeUrlTab,
		setActiveUrlTab,
		copyFlash,
		setCopyFlash,
		handleTunnelToggle,
	} = useLiveOverlay(isLiveMode);

	const liveStatusLabel = !isLiveMode
		? 'OFFLINE'
		: tunnelStatus === 'connected'
			? 'ONLINE'
			: 'LIVE';

	// Context menu state
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		sessionId: string;
	} | null>(null);
	const [groupContextMenu, setGroupContextMenu] = useState<{
		x: number;
		y: number;
		groupId: string;
	} | null>(null);
	const contextMenuSession = contextMenu
		? sessions.find((s) => s.id === contextMenu.sessionId)
		: null;
	const contextMenuThread = contextMenuSession
		? threads.find(
				(thread) => getRuntimeIdForThread(thread) === getRuntimeIdForSession(contextMenuSession)
			)
		: null;
	const contextMenuGroup = groupContextMenu
		? groups.find((group) => group.id === groupContextMenu.groupId)
		: null;
	const menuRef = useRef<HTMLDivElement>(null);
	const ignoreNextBlurRef = useRef(false);
	const [expandedOlderByWorkspace, setExpandedOlderByWorkspace] = useState<Record<string, boolean>>(
		{}
	);
	const [expandedArchivedByWorkspace, setExpandedArchivedByWorkspace] = useState<
		Record<string, boolean>
	>({});

	const toggleThreadPinned = useCallback(
		(thread: Thread) => {
			const nextPinned = !thread.pinned;
			setThreads((prev) =>
				prev.map((candidate) =>
					candidate.id === thread.id
						? {
								...candidate,
								pinned: nextPinned,
								isOpen: nextPinned ? true : candidate.isOpen,
							}
						: candidate
				)
			);
			setSessions((prev) =>
				prev.map((s) =>
					getRuntimeIdForSession(s) === getRuntimeIdForThread(thread)
						? { ...s, bookmarked: nextPinned }
						: s
				)
			);
		},
		[setSessions, setThreads]
	);

	// Context menu handlers - memoized to prevent SessionItem re-renders
	const handleContextMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
		e.preventDefault();
		e.stopPropagation();
		setGroupContextMenu(null);
		setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
	}, []);

	const handleGroupContextMenu = useCallback((e: React.MouseEvent, groupId: string) => {
		e.preventDefault();
		e.stopPropagation();
		setContextMenu(null);
		setGroupContextMenu({ x: e.clientX, y: e.clientY, groupId });
	}, []);

	const handleDeleteSession = useCallback(
		(sessionId: string) => {
			setThreads((prev) =>
				prev.filter((thread) => getRuntimeIdForThread(thread) !== sessionId)
			);
			setContextMenu(null);
			// Use the parent's delete handler if provided (includes proper cleanup)
			if (onDeleteSession) {
				onDeleteSession(sessionId);
				return;
			}
			setSessions((prev) => {
				const remaining = prev.filter((s) => s.id !== sessionId);
				const currentActive = useSessionStore.getState().activeSessionId;
				if (currentActive === sessionId && remaining.length > 0) {
					setActiveSessionId(remaining[0].id);
				}
				return remaining;
			});
		},
		[onDeleteSession, setActiveSessionId, setSessions, setThreads]
	);

	const handleSelectThread = useCallback(
		(thread: Thread) => {
			const runtimeId = getRuntimeIdForThread(thread);
			useSessionStore.setState((state) => ({
				threads: state.threads.map((candidate) =>
					candidate.id === thread.id
						? { ...candidate, isOpen: true }
						: candidate
				),
				activeSessionId: runtimeId,
				cyclePosition: -1,
			}));
			setActiveGroupChatId(null);
		},
		[setActiveGroupChatId]
	);

	const handleCloseThread = useCallback(
		(threadId: string) => {
			setThreads((prev) =>
				prev.map((thread) => (thread.id === threadId ? { ...thread, isOpen: false } : thread))
			);
		},
		[setThreads]
	);

	const handleToggleArchived = useCallback(
		(thread: Thread) => {
			setThreads((prev) =>
				prev.map((candidate) =>
					candidate.id === thread.id
						? {
								...candidate,
								archived: !candidate.archived,
								isOpen: candidate.archived ? candidate.isOpen : false,
							}
						: candidate
				)
			);
		},
		[setThreads]
	);

	const openNewWorkspaceModal = useCallback(() => {
		setNewInstanceModalOpen(true);
		setNewInstanceMode('workspace');
		setNewInstanceWorkspaceId(null);
		setNewInstanceFixedWorkingDir(null);
		setNewInstanceDefaultAgentId(null);
		setDuplicatingSessionId(null);
	}, [
		setDuplicatingSessionId,
		setNewInstanceDefaultAgentId,
		setNewInstanceFixedWorkingDir,
		setNewInstanceModalOpen,
		setNewInstanceMode,
		setNewInstanceWorkspaceId,
	]);

	const createThreadForWorkspace = useCallback(
		async (workspace: Group) => {
			const workingDir = workspace.projectRoot?.trim();
			if (!workingDir) return;

			const currentSessions = useSessionStore
				.getState()
				.sessions.filter((session) => !session.parentSessionId);
			const provider = defaultThreadProvider || 'codex';
			const name = buildDefaultThreadName(provider, currentSessions);

			await onCreateSession(
				provider,
				workingDir,
				name,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				workspace.id
			);
		},
		[defaultThreadProvider, onCreateSession]
	);

	// Close menu when clicking outside
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		if (menuOpen) {
			document.addEventListener('mousedown', handleClickOutside);
			return () => document.removeEventListener('mousedown', handleClickOutside);
		}
	}, [menuOpen]);

	// Close overlays/menus with Escape key
	useEffect(() => {
		const handleEscKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				if (liveOverlayOpen) {
					setLiveOverlayOpen(false);
					e.stopPropagation();
				} else if (menuOpen) {
					setMenuOpen(false);
					e.stopPropagation();
				}
			}
		};
		if (liveOverlayOpen || menuOpen) {
			document.addEventListener('keydown', handleEscKey);
			return () => document.removeEventListener('keydown', handleEscKey);
		}
	}, [liveOverlayOpen, menuOpen]);

	// Listen for tour UI actions to control hamburger menu state
	useEffect(() => {
		const handleTourAction = (event: Event) => {
			const customEvent = event as CustomEvent<{ type: string; value?: string }>;
			const { type } = customEvent.detail;

			switch (type) {
				case 'openHamburgerMenu':
					setMenuOpen(true);
					break;
				case 'closeHamburgerMenu':
					setMenuOpen(false);
					break;
				default:
					break;
			}
		};

		window.addEventListener('tour:action', handleTourAction);
		return () => window.removeEventListener('tour:action', handleTourAction);
	}, []);

	// Get git file change counts per session from focused context
	// Using useGitFileStatus instead of full useGitStatus reduces re-renders
	// when only branch data changes (we only need file counts here)
	const { getFileCount } = useGitFileStatus();

	const topLevelSessions = useMemo(
		() => sessions.filter((session) => !session.parentSessionId),
		[sessions]
	);

	const topLevelSessionsById = useMemo(
		() => new Map(topLevelSessions.map((session) => [session.id, session])),
		[topLevelSessions]
	);
	const topLevelSessionActivityByRuntimeId = useMemo(
		() =>
			new Map(
				topLevelSessions.map((session) => [
					getRuntimeIdForSession(session),
					getSessionLastActivity(session),
				])
			),
		[topLevelSessions]
	);

	const worktreeChildrenByParentId = useMemo(() => {
		const map = new Map<string, Session[]>();
		sessions.forEach((session) => {
			if (!session.parentSessionId) return;
			const siblings = map.get(session.parentSessionId);
			if (siblings) {
				siblings.push(session);
			} else {
				map.set(session.parentSessionId, [session]);
			}
		});
		return map;
	}, [sessions]);

	const sortedWorktreeChildrenByParentId = useMemo(() => {
		const map = new Map<string, Session[]>();
		worktreeChildrenByParentId.forEach((children, parentId) => {
			map.set(parentId, [...children].sort((a, b) => compareNames(a.name, b.name)));
		});
		return map;
	}, [worktreeChildrenByParentId]);

	const sortedSessionIndexById = useMemo(() => {
		const map = new Map<string, number>();
		sortedSessions.forEach((session, index) => {
			map.set(session.id, index);
		});
		return map;
	}, [sortedSessions]);

	const getWorktreeChildren = useCallback(
		(parentId: string): Session[] => worktreeChildrenByParentId.get(parentId) || [],
		[worktreeChildrenByParentId]
	);

	const threadBySessionId = useMemo(() => {
		const map = new Map<string, Thread>();
		threads.forEach((thread) => {
			const runtimeId = getRuntimeIdForThread(thread);
			if (topLevelSessionsById.has(runtimeId)) {
				map.set(runtimeId, thread);
			}
		});
		return map;
	}, [threads, topLevelSessionsById]);

	const getThreadRecentTimestamp = useCallback(
		(thread: Thread) =>
			Math.max(
				thread.lastUsedAt,
				topLevelSessionActivityByRuntimeId.get(getRuntimeIdForThread(thread)) || 0
			),
		[topLevelSessionActivityByRuntimeId]
	);

	const nonArchivedThreads = useMemo(
		() =>
			threads
				.filter(
					(thread) => !thread.archived && topLevelSessionsById.has(getRuntimeIdForThread(thread))
				)
				.sort((a, b) => getThreadRecentTimestamp(b) - getThreadRecentTimestamp(a)),
		[threads, topLevelSessionsById, getThreadRecentTimestamp]
	);

	const pinnedThreads = useMemo(
		() => nonArchivedThreads.filter((thread) => thread.pinned),
		[nonArchivedThreads]
	);

	const pinnedThreadIds = useMemo(() => new Set(pinnedThreads.map((thread) => thread.id)), [pinnedThreads]);

	const recentThreads = useMemo(
		() => nonArchivedThreads.filter((thread) => !pinnedThreadIds.has(thread.id)).slice(0, 5),
		[nonArchivedThreads, pinnedThreadIds]
	);

	const filteredWorkspaces = useMemo(() => {
		const query = sessionFilter.trim().toLowerCase();
		const matchesWorkspace = (group: Group) =>
			!query ||
			group.name.toLowerCase().includes(query) ||
			(group.projectRoot || '').toLowerCase().includes(query);

		const withStats = groups
			.filter(matchesWorkspace)
			.map((workspace) => {
				const workspaceThreads = threads
					.filter(
						(thread) =>
							thread.workspaceId === workspace.id &&
							topLevelSessionsById.has(getRuntimeIdForThread(thread))
					)
					.sort((a, b) => getThreadRecentTimestamp(b) - getThreadRecentTimestamp(a));
				const workspaceSessionIds = new Set(
					workspaceThreads.map((thread) => getRuntimeIdForThread(thread))
				);
				const workspaceSessions = topLevelSessions.filter((session) => workspaceSessionIds.has(session.id));
				const statusSession = workspaceSessions[0] || null;
				const unreadCount = workspaceSessions.reduce(
					(count, session) =>
						count + (session.aiTabs?.some((tab) => tab.hasUnread) ? 1 : 0),
					0
				);
				const hasBusy = workspaceSessions.some(
					(session) => session.state === 'busy' || activeBatchSessionIds.includes(session.id)
				);
				const openThreads = workspaceThreads.filter((thread) => !thread.archived && thread.isOpen);
				const recentCandidateThreads = workspaceThreads
					.filter((thread) => !thread.archived)
					.slice(0, 5);
				const excludedIds = new Set([
					...openThreads.map((thread) => thread.id),
					...workspaceThreads.filter((thread) => thread.pinned).map((thread) => thread.id),
				]);
				const recentVisibleThreads = recentCandidateThreads.filter(
					(thread) => !excludedIds.has(thread.id)
				);
				const recentCandidateIds = new Set(recentCandidateThreads.map((thread) => thread.id));
				const recentVisibleIds = new Set(recentVisibleThreads.map((thread) => thread.id));
				const olderThreads = workspaceThreads.filter(
					(thread) =>
						!thread.archived &&
						!excludedIds.has(thread.id) &&
						!recentVisibleIds.has(thread.id) &&
						!recentCandidateIds.has(thread.id)
				);
				const archivedThreads = workspaceThreads.filter((thread) => thread.archived);
				return {
					workspace,
					threads: workspaceThreads,
					openThreads,
					recentThreads: recentVisibleThreads,
					olderThreads,
					archivedThreads,
					statusSession,
					unreadCount,
					hasBusy,
					defaultAgentId: workspaceThreads[0]?.agentId,
					sortKey: Math.max(
						workspace.lastUsedAt || 0,
						workspaceThreads[0] ? getThreadRecentTimestamp(workspaceThreads[0]) : 0
					),
					hasPinned: workspaceThreads.some((thread) => thread.pinned),
				};
			});

		return withStats.sort((a, b) => {
			if (a.hasPinned !== b.hasPinned) return a.hasPinned ? -1 : 1;
			if (workspaceSortMode === 'alpha') {
				return compareNames(a.workspace.name, b.workspace.name);
			}
			return b.sortKey - a.sortKey || compareNames(a.workspace.name, b.workspace.name);
		});
	}, [
		groups,
		threads,
		topLevelSessions,
		topLevelSessionsById,
		sessionFilter,
		activeBatchSessionIds,
		workspaceSortMode,
		getThreadRecentTimestamp,
	]);

	// PERF: Cached callback maps to prevent SessionItem re-renders
	// These Maps store stable function references keyed by session/editing ID
	// The callbacks themselves are memoized, so the Map values remain stable
	const selectHandlers = useMemo(() => {
		const map = new Map<string, () => void>();
		sessions.forEach((s) => {
			const thread = threadBySessionId.get(s.id);
			map.set(s.id, () => (thread ? handleSelectThread(thread) : setActiveSessionId(s.id)));
		});
		return map;
	}, [sessions, handleSelectThread, setActiveSessionId, threadBySessionId]);

	const dragStartHandlers = useMemo(() => {
		const map = new Map<string, () => void>();
		sessions.forEach((s) => {
			map.set(s.id, () => handleDragStart(s.id));
		});
		return map;
	}, [sessions, handleDragStart]);

	const contextMenuHandlers = useMemo(() => {
		const map = new Map<string, (e: React.MouseEvent) => void>();
		sessions.forEach((s) => {
			map.set(s.id, (e: React.MouseEvent) => handleContextMenu(e, s.id));
		});
		return map;
	}, [sessions, handleContextMenu]);

	const finishRenameHandlers = useMemo(() => {
		const map = new Map<string, (newName: string) => void>();
		sessions.forEach((s) => {
			map.set(s.id, (newName: string) => finishRenamingSession(s.id, newName));
		});
		return map;
	}, [sessions, finishRenamingSession]);

	const toggleBookmarkHandlers = useMemo(() => {
		const map = new Map<string, () => void>();
		sessions.forEach((s) => {
			const thread = threadBySessionId.get(s.id);
			map.set(s.id, () => {
				if (thread) {
					toggleThreadPinned(thread);
				}
			});
		});
		return map;
	}, [sessions, threadBySessionId, toggleThreadPinned]);

	// Helper component: Renders a session item with its worktree children (if any)
	const renderSessionWithWorktrees = (
		session: Session,
		variant: 'bookmark' | 'group' | 'flat' | 'ungrouped',
		options: {
			keyPrefix: string;
			groupId?: string;
			group?: Group;
			onDrop?: () => void;
			displayName?: string;
			providerAgentId?: Session['toolType'];
			workspaceEmoji?: string;
		}
	) => {
		const worktreeChildren = getWorktreeChildren(session.id);
		const hasWorktrees = worktreeChildren.length > 0;
		const worktreesExpanded = session.worktreesExpanded ?? true;
		const globalIdx = sortedSessionIndexById.get(session.id) ?? -1;
		const isKeyboardSelected = activeFocus === 'sidebar' && globalIdx === selectedSidebarIndex;

		// In flat/ungrouped view, wrap sessions with worktrees in a left-bordered container
		// to visually associate parent and worktrees together (similar to grouped view)
		const needsWorktreeWrapper = hasWorktrees && (variant === 'flat' || variant === 'ungrouped');

		// When wrapped, use 'ungrouped' styling for flat sessions (no mx-3, consistent with grouped look)
		const effectiveVariant = needsWorktreeWrapper && variant === 'flat' ? 'ungrouped' : variant;

		const content = (
			<>
				{/* Parent session - no chevron, maintains alignment */}
				<SessionItem
					session={session}
					variant={effectiveVariant}
					theme={theme}
					displayName={options.displayName}
					isActive={activeSessionId === session.id && !activeGroupChatId}
					isKeyboardSelected={isKeyboardSelected}
					isDragging={draggingSessionId === session.id}
					isEditing={editingSessionId === `${options.keyPrefix}-${session.id}`}
					leftSidebarOpen={leftSidebarOpen}
					group={options.group}
					groupId={options.groupId}
					providerAgentId={options.providerAgentId}
					workspaceEmoji={options.workspaceEmoji}
					isInBatch={activeBatchSessionIds.includes(session.id)}
					jumpNumber={getSessionJumpNumber(session.id)}
					onSelect={selectHandlers.get(session.id)!}
					onDragStart={dragStartHandlers.get(session.id)!}
					onDragOver={handleDragOver}
					onDrop={options.onDrop || handleDropOnUngrouped}
					onContextMenu={contextMenuHandlers.get(session.id)!}
					onFinishRename={finishRenameHandlers.get(session.id)!}
					onStartRename={() => startRenamingSession(`${options.keyPrefix}-${session.id}`)}
					onToggleBookmark={toggleBookmarkHandlers.get(session.id)!}
				/>

				{/* Thin band below parent when worktrees exist but collapsed - click to expand */}
				{hasWorktrees && !worktreesExpanded && onToggleWorktreeExpanded && (
					<button
						onClick={(e) => {
							e.stopPropagation();
							onToggleWorktreeExpanded(session.id);
						}}
						className="w-full flex items-center justify-center gap-1.5 py-0.5 text-[9px] font-medium hover:opacity-80 transition-opacity cursor-pointer"
						style={{
							backgroundColor: theme.colors.accent + '15',
							color: theme.colors.accent,
						}}
						title={`${worktreeChildren.length} worktree${worktreeChildren.length > 1 ? 's' : ''} (click to expand)`}
					>
						<GitBranch className="w-2.5 h-2.5" />
						<span>
							{worktreeChildren.length} worktree{worktreeChildren.length > 1 ? 's' : ''}
						</span>
						<ChevronDown className="w-2.5 h-2.5" />
					</button>
				)}

				{/* Worktree children drawer (when expanded) */}
				{hasWorktrees && worktreesExpanded && onToggleWorktreeExpanded && (
					<div
						className={`rounded-bl overflow-hidden ${needsWorktreeWrapper ? '' : 'ml-1'}`}
						style={{
							backgroundColor: theme.colors.accent + '10',
							borderLeft: needsWorktreeWrapper ? 'none' : `1px solid ${theme.colors.accent}30`,
							borderBottom: `1px solid ${theme.colors.accent}30`,
						}}
					>
						{/* Worktree children list */}
						<div>
							{(sortedWorktreeChildrenByParentId.get(session.id) || []).map((child) => {
								const childGlobalIdx = sortedSessionIndexById.get(child.id) ?? -1;
								const isChildKeyboardSelected =
									activeFocus === 'sidebar' && childGlobalIdx === selectedSidebarIndex;
								return (
									<SessionItem
										key={`worktree-${session.id}-${child.id}`}
										session={child}
										variant="worktree"
										theme={theme}
										isActive={activeSessionId === child.id && !activeGroupChatId}
										isKeyboardSelected={isChildKeyboardSelected}
										isDragging={draggingSessionId === child.id}
										isEditing={editingSessionId === `worktree-${session.id}-${child.id}`}
										leftSidebarOpen={leftSidebarOpen}
										isInBatch={activeBatchSessionIds.includes(child.id)}
										jumpNumber={getSessionJumpNumber(child.id)}
										onSelect={selectHandlers.get(child.id)!}
										onDragStart={dragStartHandlers.get(child.id)!}
										onContextMenu={contextMenuHandlers.get(child.id)!}
										onFinishRename={finishRenameHandlers.get(child.id)!}
										onStartRename={() => startRenamingSession(`worktree-${session.id}-${child.id}`)}
										onToggleBookmark={toggleBookmarkHandlers.get(child.id)!}
									/>
								);
							})}
						</div>
						{/* Drawer handle at bottom - click to collapse */}
						<button
							onClick={(e) => {
								e.stopPropagation();
								onToggleWorktreeExpanded(session.id);
							}}
							className="w-full flex items-center justify-center gap-1.5 py-0.5 text-[9px] font-medium hover:opacity-80 transition-opacity cursor-pointer"
							style={{
								backgroundColor: theme.colors.accent + '20',
								color: theme.colors.accent,
							}}
							title="Click to collapse worktrees"
						>
							<GitBranch className="w-2.5 h-2.5" />
							<span>
								{worktreeChildren.length} worktree{worktreeChildren.length > 1 ? 's' : ''}
							</span>
							<ChevronUp className="w-2.5 h-2.5" />
						</button>
					</div>
				)}
			</>
		);

		// Wrap in left-bordered container for flat/ungrouped sessions with worktrees
		// Use ml-3 to align left edge, mr-3 minus the extra px-1 from ungrouped (px-4 vs px-3)
		if (needsWorktreeWrapper) {
			return (
				<div
					key={`${options.keyPrefix}-${session.id}`}
					className="border-l ml-3 mr-2 mb-1"
					style={{ borderColor: theme.colors.accent + '50' }}
				>
					{content}
				</div>
			);
		}

		return <div key={`${options.keyPrefix}-${session.id}`}>{content}</div>;
	};

	// Precomputed jump number map (1-9, 0=10th) for sessions based on position in visibleSessions
	const jumpNumberMap = useMemo(() => {
		if (!showSessionJumpNumbers) return new Map<string, string>();
		const map = new Map<string, string>();
		for (let i = 0; i < Math.min(visibleSessions.length, 10); i++) {
			map.set(visibleSessions[i].id, i === 9 ? '0' : String(i + 1));
		}
		return map;
	}, [showSessionJumpNumbers, visibleSessions]);

	const getSessionJumpNumber = (sessionId: string): string | null => {
		return jumpNumberMap.get(sessionId) ?? null;
	};

	const renderThread = useCallback(
		(
			thread: Thread,
			variant: 'bookmark' | 'group' | 'flat' | 'ungrouped',
			options: {
				keyPrefix: string;
				group?: Group;
			}
		) => {
			const runtimeId = getRuntimeIdForThread(thread);
			const session = topLevelSessionsById.get(runtimeId);
			if (!session) return null;
			const displayName = getThreadDisplayTitle(thread, session);
			return renderSessionWithWorktrees(session, variant, {
				keyPrefix: options.keyPrefix,
				groupId: options.group?.id,
				group: options.group,
				displayName,
				providerAgentId: thread.agentId,
				workspaceEmoji: options.group?.emoji,
			});
		},
		[topLevelSessionsById]
	);

	return (
		<div
			ref={sidebarContainerRef}
			tabIndex={0}
			className={`border-r flex flex-col shrink-0 ${sidebarTransitionClass} outline-none relative z-20`}
			style={
				{
					width: leftSidebarOpen ? `${leftSidebarWidthState}px` : '64px',
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				} as React.CSSProperties
			}
			onClick={() => setActiveFocus('sidebar')}
			onFocus={() => setActiveFocus('sidebar')}
			onKeyDown={(e) => {
				// Open session filter with Cmd+F when sidebar has focus
				if (
					e.key === 'f' &&
					(e.metaKey || e.ctrlKey) &&
					activeFocus === 'sidebar' &&
					leftSidebarOpen &&
					!sessionFilterOpen
				) {
					e.preventDefault();
					setSessionFilterOpen(true);
				}
			}}
		>
			{/* Resize Handle */}
			{leftSidebarOpen && (
				<div
					className="absolute top-0 right-0 w-3 h-full cursor-col-resize border-r-4 border-transparent hover:border-blue-500 transition-colors z-20"
					onMouseDown={onSidebarResizeStart}
				/>
			)}

			{/* Branding Header */}
			<div
				className="p-4 border-b flex items-center justify-between h-16 shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				{leftSidebarOpen ? (
					<>
						<div className="flex items-center gap-2">
							<img
								src="/icon.png"
								alt=""
								aria-hidden="true"
								className={`w-5 h-5 rounded-sm object-cover${isAnyBusy ? ' animate-pulse' : ''}`}
							/>
							<h1
								className="font-bold tracking-widest text-lg"
								style={{ color: theme.colors.textMain }}
							>
								MAESTRO
							</h1>
							{/* Badge Level Indicator */}
							{autoRunStats && autoRunStats.currentBadgeLevel > 0 && (
								<button
									onClick={() => setAboutModalOpen(true)}
									className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold transition-colors hover:bg-white/10"
									title={`${getBadgeForTime(autoRunStats.cumulativeTimeMs)?.name || 'Apprentice'} - Click to view achievements`}
									style={{
										color: autoRunStats.currentBadgeLevel >= 8 ? '#FFD700' : theme.colors.accent,
									}}
								>
									<Trophy className="w-3 h-3" />
									<span>{autoRunStats.currentBadgeLevel}</span>
								</button>
							)}
							{/* Global LIVE Toggle */}
							<div className="ml-2 relative" ref={liveOverlayRef} data-tour="remote-control">
								<button
									onClick={() => {
										if (!isLiveMode) {
											void toggleGlobalLive();
											setLiveOverlayOpen(true);
										} else {
											setLiveOverlayOpen(!liveOverlayOpen);
										}
									}}
									className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${
										isLiveMode
											? 'bg-green-500/20 text-green-500 hover:bg-green-500/30'
											: 'text-gray-500 hover:bg-white/10'
									}`}
									title={
										isLiveMode
											? tunnelStatus === 'connected'
												? 'Remote tunnel online - Click to show URLs'
												: 'Web interface active - Click to show URL'
											: 'Click to enable web interface'
									}
								>
									<Radio className={`w-3 h-3 ${isLiveMode ? 'animate-pulse' : ''}`} />
									{leftSidebarWidthState >=
										(autoRunStats && autoRunStats.currentBadgeLevel > 0 ? 295 : 256) &&
										liveStatusLabel}
								</button>

								{/* LIVE Overlay with URL and QR Code */}
								{isLiveMode && liveOverlayOpen && webInterfaceUrl && (
									<LiveOverlayPanel
										theme={theme}
										webInterfaceUrl={webInterfaceUrl}
										tunnelStatus={tunnelStatus}
										tunnelUrl={tunnelUrl}
										tunnelError={tunnelError}
										cloudflaredInstalled={cloudflaredInstalled}
										activeUrlTab={activeUrlTab}
										setActiveUrlTab={setActiveUrlTab}
										copyFlash={copyFlash}
										setCopyFlash={setCopyFlash}
										handleTunnelToggle={handleTunnelToggle}
										webInterfaceUseCustomPort={webInterfaceUseCustomPort}
										webInterfaceCustomPort={webInterfaceCustomPort}
										setWebInterfaceUseCustomPort={setWebInterfaceUseCustomPort}
										setWebInterfaceCustomPort={setWebInterfaceCustomPort}
										isLiveMode={isLiveMode}
										toggleGlobalLive={toggleGlobalLive}
										setLiveOverlayOpen={setLiveOverlayOpen}
										restartWebServer={restartWebServer}
									/>
								)}
							</div>
						</div>
						{/* Hamburger Menu */}
						<div className="relative" ref={menuRef} data-tour="hamburger-menu">
							<button
								onClick={() => setMenuOpen(!menuOpen)}
								className="p-2 rounded hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textDim }}
								title="Menu"
							>
								<Menu className="w-4 h-4" />
							</button>
							{/* Menu Overlay */}
							{menuOpen && (
								<div
									className="absolute top-full left-0 mt-2 w-72 rounded-lg shadow-2xl z-50 overflow-y-auto scrollbar-thin"
									data-tour="hamburger-menu-contents"
									style={{
										backgroundColor: theme.colors.bgSidebar,
										border: `1px solid ${theme.colors.border}`,
										maxHeight: 'calc(100vh - 90px)',
									}}
								>
									<HamburgerMenuContent
										theme={theme}
										onNewAgentSession={onNewAgentSession}
										openWizard={openWizard}
										startTour={startTour}
										setMenuOpen={setMenuOpen}
									/>
								</div>
							)}
						</div>
					</>
				) : (
					<div className="w-full flex flex-col items-center gap-2 relative" ref={menuRef}>
						<button
							onClick={() => setMenuOpen(!menuOpen)}
							className="p-2 rounded hover:bg-white/10 transition-colors"
							title="Menu"
						>
							<img
								src="/icon.png"
								alt=""
								aria-hidden="true"
								className={`w-6 h-6 rounded-md object-cover${isAnyBusy ? ' animate-pulse' : ''}`}
							/>
						</button>
						{/* Menu Overlay for Collapsed Sidebar */}
						{menuOpen && (
							<div
								className="absolute top-full left-0 mt-2 w-72 rounded-lg shadow-2xl z-50 overflow-y-auto scrollbar-thin"
								style={{
									backgroundColor: theme.colors.bgSidebar,
									border: `1px solid ${theme.colors.border}`,
									maxHeight: 'calc(100vh - 90px)',
								}}
							>
								<HamburgerMenuContent
									theme={theme}
									onNewAgentSession={onNewAgentSession}
									openWizard={openWizard}
									startTour={startTour}
									setMenuOpen={setMenuOpen}
								/>
							</div>
						)}
					</div>
				)}
			</div>

			{/* SIDEBAR CONTENT: EXPANDED */}
			{leftSidebarOpen ? (
				<div
					className="flex-1 overflow-y-auto py-2 select-none scrollbar-thin flex flex-col"
					data-tour="session-list"
				>
					{/* Session Filter */}
					{sessionFilterOpen && (
						<div className="mx-3 mb-3">
							<input
								autoFocus
								type="text"
								placeholder="Filter workspaces..."
								value={sessionFilter}
								onChange={(e) => setSessionFilter(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Escape') {
										setSessionFilterOpen(false);
										setSessionFilter('');
									}
								}}
								className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
								style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
							/>
						</div>
					)}

					<div className="px-3 pb-2">
						<div className="flex items-center justify-between gap-2">
							<div
								className="text-[11px] font-semibold tracking-[0.08em]"
								style={getSidebarSectionTextStyle(theme)}
							>
								Workspaces
							</div>
							<div className="flex items-center gap-1">
								<button
									type="button"
									onClick={() => setWorkspaceSortMode(workspaceSortMode === 'recent' ? 'alpha' : 'recent')}
									className="p-1.5 rounded hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textDim }}
									title={
										workspaceSortMode === 'recent'
											? 'Sorting by last used'
											: 'Sorting alphabetically'
									}
								>
									{workspaceSortMode === 'recent' ? (
										<Clock3 className="w-3.5 h-3.5" />
									) : (
										<ArrowDownAZ className="w-3.5 h-3.5" />
									)}
								</button>
								<button
									type="button"
									onClick={openNewWorkspaceModal}
									className="p-1.5 rounded hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.accent }}
									title="New Workspace"
								>
									<Plus className="w-3.5 h-3.5" />
								</button>
							</div>
						</div>
					</div>

					{recentThreads.length > 0 && (
						<div className="mb-3">
							<div className="px-3 py-1.5 text-[11px] font-semibold tracking-[0.08em]">
								<span style={getSidebarSectionTextStyle(theme)}>Recent Threads</span>
							</div>
							<div className="flex flex-col">
								{recentThreads.map((thread) =>
									renderThread(thread, 'flat', {
										keyPrefix: 'recent',
										group: groups.find((group) => group.id === thread.workspaceId),
									})
								)}
							</div>
						</div>
					)}

					{pinnedThreads.length > 0 && (
						<div className="mb-3">
							<div className="px-3 py-1.5 text-[11px] font-semibold tracking-[0.08em] flex items-center gap-2">
								<Bookmark className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
								<span style={{ color: theme.colors.accent }}>Pinned</span>
							</div>
							<div
								className="flex flex-col border-l ml-4"
								style={{ borderColor: `${theme.colors.accent}28` }}
							>
								{pinnedThreads.map((thread) =>
									renderThread(thread, 'bookmark', {
										keyPrefix: 'pinned',
										group: groups.find((group) => group.id === thread.workspaceId),
									})
								)}
							</div>
						</div>
					)}

					{filteredWorkspaces.map((workspaceEntry) => {
						const { workspace, openThreads, recentThreads, olderThreads, archivedThreads } =
							workspaceEntry;
						const expandedOlder = !!expandedOlderByWorkspace[workspace.id];
						const expandedArchived = !!expandedArchivedByWorkspace[workspace.id];
						const workspaceGitFileCount = workspaceEntry.statusSession
							? getFileCount(workspaceEntry.statusSession.id)
							: undefined;
						const collapsedPaletteThreads = workspaceEntry.threads
							.map((thread) => topLevelSessionsById.get(getRuntimeIdForThread(thread)))
							.filter((session): session is Session => !!session);

						return (
							<div key={workspace.id} className="mb-2">
								<div
									role="button"
									tabIndex={0}
									aria-expanded={!workspace.collapsed}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											toggleGroup(workspace.id);
										}
									}}
									onClick={() => toggleGroup(workspace.id)}
									onContextMenu={(e) => handleGroupContextMenu(e, workspace.id)}
									className="px-3 py-1.5 flex items-center justify-between cursor-pointer group rounded-lg"
									style={getSidebarHeaderButtonStyle(theme, {
										active: !workspace.collapsed,
										tint: theme.colors.textDim,
									})}
								>
									<div
										className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] min-w-0 flex-1"
										style={getSidebarWorkspaceTextStyle(theme)}
									>
										{workspace.collapsed ? (
											<ChevronRight className="w-3 h-3 shrink-0" />
										) : (
											<ChevronDown className="w-3 h-3 shrink-0" />
										)}
										<span className="text-sm shrink-0">{workspace.emoji}</span>
										{editingGroupId === workspace.id ? (
											<input
												autoFocus
												className="bg-transparent outline-none w-full border-b border-indigo-500"
												defaultValue={workspace.name}
												onClick={(e) => e.stopPropagation()}
												onBlur={(e) => {
													if (ignoreNextBlurRef.current) {
														ignoreNextBlurRef.current = false;
														return;
													}
													finishRenamingGroup(workspace.id, e.target.value);
												}}
												onKeyDown={(e) => {
													e.stopPropagation();
													if (e.key === 'Enter') {
														ignoreNextBlurRef.current = true;
														finishRenamingGroup(workspace.id, e.currentTarget.value);
													}
												}}
											/>
										) : (
											<span
												className="truncate"
												style={getSidebarWorkspaceTextStyle(theme)}
												onDoubleClick={(e) => {
													e.stopPropagation();
													startRenamingGroup(workspace.id);
												}}
											>
												{workspace.name}
											</span>
										)}
										{workspaceEntry.hasBusy && (
											<span
												className="w-2 h-2 rounded-full shrink-0 animate-pulse"
												style={{ backgroundColor: theme.colors.warning }}
												title="Workspace has active threads"
											/>
										)}
										{workspaceEntry.unreadCount > 0 && (
											<span
												className="px-1.5 py-0.5 rounded-full text-[9px] font-bold shrink-0"
												style={{
													backgroundColor: `${theme.colors.accent}22`,
													color: theme.colors.accent,
												}}
											>
												{workspaceEntry.unreadCount}
											</span>
										)}
										{workspaceEntry.statusSession && (
											<>
												{workspaceGitFileCount !== undefined && workspaceGitFileCount > 0 && (
													<div
														className="flex items-center gap-0.5 text-[10px] shrink-0"
														style={{ color: theme.colors.warning }}
														title={`${workspaceGitFileCount} changed file${workspaceGitFileCount === 1 ? '' : 's'}`}
													>
														<GitBranch className="w-2.5 h-2.5" />
														<span>{workspaceGitFileCount}</span>
													</div>
												)}
												{workspaceEntry.statusSession.isGitRepo ? (
													<div
														className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase shrink-0"
														style={{
															backgroundColor: `${theme.colors.accent}30`,
															color: theme.colors.accent,
														}}
														title="Git repository"
													>
														GIT
													</div>
												) : (
													<div
														className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase shrink-0"
														style={{
															backgroundColor: workspaceEntry.statusSession.sessionSshRemoteConfig?.enabled
																? `${theme.colors.warning}30`
																: `${theme.colors.textDim}20`,
															color: workspaceEntry.statusSession.sessionSshRemoteConfig?.enabled
																? theme.colors.warning
																: theme.colors.textDim,
														}}
														title={
															workspaceEntry.statusSession.sessionSshRemoteConfig?.enabled
																? 'Running on remote host via SSH'
																: 'Local directory'
														}
													>
														{workspaceEntry.statusSession.sessionSshRemoteConfig?.enabled
															? 'REMOTE'
															: 'LOCAL'}
													</div>
												)}
												{workspaceEntry.statusSession.sessionSshRemoteConfig?.enabled &&
													workspaceEntry.statusSession.isGitRepo && (
														<div
															className="px-1.5 py-0.5 rounded text-[9px] font-bold flex items-center shrink-0"
															style={{
																backgroundColor: `${theme.colors.warning}30`,
																color: theme.colors.warning,
															}}
															title="Running on remote host via SSH"
														>
															<Server className="w-3 h-3" />
														</div>
													)}
											</>
										)}
									</div>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											void createThreadForWorkspace(workspace);
										}}
										className="p-1 rounded hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.accent }}
										title="New Thread"
									>
										<Plus className="w-3.5 h-3.5" />
									</button>
								</div>

								{!workspace.collapsed ? (
									<div
										className="flex flex-col border-l ml-4 mt-1"
										style={{ borderColor: 'rgba(255,255,255,0.06)' }}
									>
										{openThreads.length > 0 && (
											<>
												<div className="px-3 py-1 text-[10px] font-semibold tracking-[0.08em]">
													<span style={getSidebarSectionTextStyle(theme)}>Open</span>
												</div>
												<div className="flex flex-col">
													{openThreads.map((thread) =>
														renderThread(thread, 'group', {
															keyPrefix: `workspace-open-${workspace.id}`,
															group: workspace,
														})
													)}
												</div>
											</>
										)}

										{recentThreads.length > 0 && (
											<>
												<div className="px-3 py-1 text-[10px] font-semibold tracking-[0.08em]">
													<span style={getSidebarSectionTextStyle(theme)}>Recent</span>
												</div>
												<div className="flex flex-col">
													{recentThreads.map((thread) =>
														renderThread(thread, 'group', {
															keyPrefix: `workspace-recent-${workspace.id}`,
															group: workspace,
														})
													)}
												</div>
											</>
										)}

										{expandedOlder && (
											<div className="flex flex-col">
												{olderThreads.map((thread) =>
													renderThread(thread, 'group', {
														keyPrefix: `workspace-older-${workspace.id}`,
														group: workspace,
													})
												)}
											</div>
										)}

										{olderThreads.length > 0 && (
											<button
												type="button"
												onClick={() =>
													setExpandedOlderByWorkspace((prev) => ({
														...prev,
														[workspace.id]: !prev[workspace.id],
													}))
												}
												className="mx-3 my-1 px-2 py-1 rounded text-[11px] text-left hover:bg-white/5 transition-colors"
												style={{ color: theme.colors.textDim }}
											>
												{expandedOlder ? 'Hide older threads' : `Show older (${olderThreads.length})`}
											</button>
										)}

										{expandedArchived && (
											<div className="flex flex-col">
												{archivedThreads.map((thread) =>
													renderThread(thread, 'group', {
														keyPrefix: `workspace-archived-${workspace.id}`,
														group: workspace,
													})
												)}
											</div>
										)}

										{archivedThreads.length > 0 && (
											<button
												type="button"
												onClick={() =>
													setExpandedArchivedByWorkspace((prev) => ({
														...prev,
														[workspace.id]: !prev[workspace.id],
													}))
												}
												className="mx-3 my-1 px-2 py-1 rounded text-[11px] text-left hover:bg-white/5 transition-colors"
												style={{ color: theme.colors.textDim }}
											>
												{expandedArchived
													? 'Hide archived'
													: `Show archived (${archivedThreads.length})`}
											</button>
										)}
									</div>
								) : (
									<div
										className="ml-8 mr-3 mt-1 mb-2 flex gap-1 h-1.5 cursor-pointer"
										onClick={() => toggleGroup(workspace.id)}
									>
										{collapsedPaletteThreads.map((session) => (
											<CollapsedSessionPill
												key={`workspace-collapsed-${workspace.id}-${session.id}`}
												session={session}
												keyPrefix={`workspace-collapsed-${workspace.id}`}
												theme={theme}
												activeBatchSessionIds={activeBatchSessionIds}
												leftSidebarWidth={leftSidebarWidthState}
												contextWarningYellowThreshold={contextWarningYellowThreshold}
												contextWarningRedThreshold={contextWarningRedThreshold}
												getFileCount={getFileCount}
												getWorktreeChildren={getWorktreeChildren}
												setActiveSessionId={setActiveSessionId}
											/>
										))}
									</div>
								)}
							</div>
						);
					})}

					{filteredWorkspaces.length === 0 && (
						<div className="px-3 py-6 text-sm" style={{ color: theme.colors.textDim }}>
							{sessionFilter.trim() ? 'No workspaces match this filter.' : 'No workspaces yet.'}
						</div>
					)}

					{/* Flexible spacer to push group chats to bottom */}
					<div className="flex-grow min-h-4" />

					{/* GROUP CHATS SECTION - Only show when at least 2 AI agents exist */}
					{onNewGroupChat &&
						onOpenGroupChat &&
						onEditGroupChat &&
						onRenameGroupChat &&
						onDeleteGroupChat &&
						sessions.filter((s) => s.toolType !== 'terminal').length >= 2 && (
							<GroupChatList
								theme={theme}
								groupChats={groupChats}
								activeGroupChatId={activeGroupChatId}
								onOpenGroupChat={onOpenGroupChat}
								onNewGroupChat={onNewGroupChat}
								onEditGroupChat={onEditGroupChat}
								onRenameGroupChat={onRenameGroupChat}
								onDeleteGroupChat={onDeleteGroupChat}
								onArchiveGroupChat={onArchiveGroupChat}
								isExpanded={groupChatsExpanded}
								onExpandedChange={setGroupChatsExpanded}
								groupChatState={groupChatState}
								participantStates={participantStates}
								groupChatStates={groupChatStates}
								allGroupChatParticipantStates={allGroupChatParticipantStates}
							/>
						)}
				</div>
			) : (
				/* SIDEBAR CONTENT: SKINNY MODE */
				<SkinnySidebar
					theme={theme}
					sortedSessions={sortedSessions}
					activeSessionId={activeSessionId}
					groups={groups}
					activeBatchSessionIds={activeBatchSessionIds}
					contextWarningYellowThreshold={contextWarningYellowThreshold}
					contextWarningRedThreshold={contextWarningRedThreshold}
					getFileCount={getFileCount}
					setActiveSessionId={setActiveSessionId}
					handleContextMenu={handleContextMenu}
				/>
			)}

			{/* SIDEBAR BOTTOM ACTIONS */}
			<SidebarActions
				theme={theme}
				leftSidebarOpen={leftSidebarOpen}
				hasNoSessions={sessions.length === 0}
				shortcuts={shortcuts}
				openWizard={openWizard}
				setLeftSidebarOpen={setLeftSidebarOpen}
			/>

			{/* Session Context Menu */}
			{contextMenu && contextMenuSession && (
				<SessionContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					theme={theme}
					session={contextMenuSession}
					isPinned={!!contextMenuThread?.pinned}
					isArchived={!!contextMenuThread?.archived}
					hasWorktreeChildren={sessions.some((s) => s.parentSessionId === contextMenuSession.id)}
					onRename={() => {
						setRenameInstanceValue(
							contextMenuThread ? getThreadDisplayTitle(contextMenuThread, contextMenuSession) : contextMenuSession.name
						);
						setRenameInstanceSessionId(contextMenuSession.id);
						setRenameInstanceModalOpen(true);
					}}
					onEdit={() => onEditAgent(contextMenuSession)}
					onDuplicate={() => {
						setNewInstanceModalOpen(true);
						setNewInstanceMode('thread');
						setNewInstanceWorkspaceId(contextMenuThread?.workspaceId || contextMenuSession.workspaceId || null);
						setNewInstanceFixedWorkingDir(contextMenuSession.projectRoot || contextMenuSession.cwd);
						setNewInstanceDefaultAgentId(contextMenuSession.toolType);
						setDuplicatingSessionId(contextMenuSession.id);
						setContextMenu(null);
					}}
					onTogglePinned={() => contextMenuThread && toggleThreadPinned(contextMenuThread)}
					onCloseThread={() => contextMenuThread && handleCloseThread(contextMenuThread.id)}
					onToggleArchived={() => contextMenuThread && handleToggleArchived(contextMenuThread)}
					onDelete={() => handleDeleteSession(contextMenuSession.id)}
					onDismiss={() => setContextMenu(null)}
					onCreatePR={
						onOpenCreatePR && contextMenuSession.parentSessionId
							? () => onOpenCreatePR(contextMenuSession)
							: undefined
					}
					onQuickCreateWorktree={
						onQuickCreateWorktree && !contextMenuSession.parentSessionId
							? () => onQuickCreateWorktree(contextMenuSession)
							: undefined
					}
					onConfigureWorktrees={
						onOpenWorktreeConfig && !contextMenuSession.parentSessionId
							? () => onOpenWorktreeConfig(contextMenuSession)
							: undefined
					}
					onDeleteWorktree={
						onDeleteWorktree && contextMenuSession.parentSessionId
							? () => onDeleteWorktree(contextMenuSession)
							: undefined
					}
				/>
			)}

			{groupContextMenu && contextMenuGroup && onDeleteWorktreeGroup && (
				<GroupContextMenu
					x={groupContextMenu.x}
					y={groupContextMenu.y}
					theme={theme}
					group={contextMenuGroup}
					onEdit={() => startRenamingGroup(contextMenuGroup.id)}
					onDelete={() => onDeleteWorktreeGroup(contextMenuGroup.id)}
					onDismiss={() => setGroupContextMenu(null)}
				/>
			)}
		</div>
	);
}

export const SessionList = memo(SessionListInner);
