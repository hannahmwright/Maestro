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
	FolderKanban,
} from 'lucide-react';
import type {
	Session,
	Group,
	Theme,
	Thread,
	SidebarThreadTarget,
	SidebarNavTarget,
} from '../../types';
import { getBadgeForTime } from '../../constants/conductorBadges';
import { SessionItem } from '../SessionItem';
import { GroupChatList } from '../GroupChatList';
import { useLiveOverlay, useResizablePanel } from '../../hooks';
import { useGitFileStatus } from '../../contexts/GitStatusContext';
import { useUIStore } from '../../stores/uiStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useBatchStore, selectActiveBatchSessionIds } from '../../stores/batchStore';
import { useConductorStore } from '../../stores/conductorStore';
import { useShallow } from 'zustand/react/shallow';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { getModalActions } from '../../stores/modalStore';
import { SessionContextMenu } from './SessionContextMenu';
import { GroupContextMenu } from './GroupContextMenu';
import { HamburgerMenuContent } from './HamburgerMenuContent';
import { CollapsedSessionPill } from './CollapsedSessionPill';
import { SidebarActions } from './SidebarActions';
import { SkinnySidebar, type SkinnySidebarThreadItem } from './SkinnySidebar';
import { LiveOverlayPanel } from './LiveOverlayPanel';
import { useSessionFilterMode } from '../../hooks/session/useSessionFilterMode';
import { compareNamesIgnoringEmojis as compareNames } from '../../../shared/emojiUtils';
import { generateId } from '../../utils/ids';
import {
	getRuntimeIdForSession,
	getRuntimeIdForThread,
	hasUnreadForThread,
	getSessionLastActivity,
	getThreadTabId,
	getThreadDisplayTitle,
	isThreadBusyForSession,
	isThreadActiveForSession,
} from '../../utils/workspaceThreads';
import { buildDefaultThreadName } from '../../utils/sessionValidation';
import { closeTab, createTab } from '../../utils/tabHelpers';

// ============================================================================
// SessionContextMenu - Right-click context menu for session items
// ============================================================================

interface SessionListProps {
	// Computed values (not in stores — remain as props)
	theme: Theme;
	isLiveMode: boolean;
	webInterfaceUrl: string | null;
	showSessionJumpNumbers?: boolean;

	// Ref for the sidebar container (for focus management)
	sidebarContainerRef?: React.RefObject<HTMLDivElement>;

	// Domain handlers
	toggleGlobalLive: () => Promise<void>;
	restartWebServer: () => Promise<string | null>;
	toggleGroup: (groupId: string) => void;
	handleDragStart: (sessionId: string) => void;
	finishRenamingGroup: (groupId: string, newName: string) => void;
	startRenamingGroup: (groupId: string) => void;
	startRenamingSession: (sessId: string) => void;
	createNewGroup: () => void;
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
	onOpenCreatePR?: (session: Session) => void;
	onQuickCreateWorktree?: (session: Session) => void;
	onOpenWorktreeConfig?: (session: Session) => void;
	onDeleteWorktree?: (session: Session) => void;

	// Wizard props
	openWizard?: () => void;

	// Tour props
	startTour?: () => void;
	onOpenConductor?: (groupId: string) => void;
	onOpenConductorHome?: () => void;

	// Group Chat handlers
	onOpenGroupChat?: (id: string) => void;
	onNewGroupChat?: () => void;
	onEditGroupChat?: (id: string) => void;
	onRenameGroupChat?: (id: string) => void;
	onDeleteGroupChat?: (id: string) => void;
	onArchiveGroupChat?: (id: string, archived: boolean) => void;
}

function isHiddenConductorWorkspace(group: Group): boolean {
	const projectRoot = group.projectRoot || '';
	return /-conductor(?:-integrate)?-[^\\/]+$/i.test(projectRoot);
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

function normalizeWorkspacePath(value: string | undefined): string {
	return (value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function buildSidebarThreadTargetId(prefix: string, threadId: string): string {
	return `${prefix}-${threadId}`;
}

function buildSidebarWorkspaceTargetId(workspaceId: string): string {
	return `workspace-${workspaceId}`;
}

function SessionListInner(props: SessionListProps) {
	// Store subscriptions
	const sessions = useSessionStore((s) => s.sessions);
	const groups = useSessionStore((s) => s.groups);
	const threads = useSessionStore((s) => s.threads);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen);
	const leftSidebarHidden = useUIStore((s) => s.leftSidebarHidden);
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
	const defaultSaveToHistory = useSettingsStore((s) => s.defaultSaveToHistory);
	const defaultShowThinking = useSettingsStore((s) => s.defaultShowThinking);
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
	const activeConductorView = useConductorStore((s) => s.activeConductorView);

	// Stable store actions
	const setActiveFocus = useUIStore.getState().setActiveFocus;
	const setLeftSidebarOpen = useUIStore.getState().setLeftSidebarOpen;
	const setLeftSidebarHidden = useUIStore.getState().setLeftSidebarHidden;
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
	const setEditingSessionId = useUIStore.getState().setEditingSessionId;
	const setSidebarThreadTargets = useUIStore.getState().setSidebarThreadTargets;
	const setSidebarNavTargets = useUIStore.getState().setSidebarNavTargets;
	const setSessions = useSessionStore.getState().setSessions;
	const setGroups = useSessionStore.getState().setGroups;
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
		isLiveMode,
		webInterfaceUrl,
		toggleGlobalLive,
		restartWebServer,
		toggleGroup,
		handleDragStart,
		finishRenamingGroup,
		startRenamingGroup,
		startRenamingSession,
		onCreateSession,
		onDeleteSession,
		onEditAgent,
		onNewAgentSession,
		onOpenCreatePR,
		onQuickCreateWorktree,
		onOpenWorktreeConfig,
		onDeleteWorktree,
		onDeleteWorktreeGroup,
		showSessionJumpNumbers = false,
		openWizard,
		startTour,
		sidebarContainerRef,
		onOpenGroupChat,
		onNewGroupChat,
		onEditGroupChat,
		onRenameGroupChat,
		onDeleteGroupChat,
		onArchiveGroupChat,
		onOpenConductor,
		onOpenConductorHome,
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
		threadId?: string;
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
		? contextMenu?.threadId
			? threads.find((thread) => thread.id === contextMenu.threadId) || null
			: threads.find(
					(thread) => getRuntimeIdForThread(thread) === getRuntimeIdForSession(contextMenuSession)
				) || null
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
	const [archiveExpanded, setArchiveExpanded] = useState(false);

	const toggleThreadPinned = useCallback(
		(thread: Thread) => {
			const nextPinned = !thread.pinned;
			const runtimeId = getRuntimeIdForThread(thread);
			const remainingPinnedSiblingExists = threads.some(
				(candidate) =>
					candidate.id !== thread.id &&
					getRuntimeIdForThread(candidate) === runtimeId &&
					candidate.pinned
			);
			const shouldBookmarkSession = nextPinned || remainingPinnedSiblingExists;
			setThreads((prev) =>
				prev.map((candidate) =>
					candidate.id === thread.id
						? {
								...candidate,
								pinned: nextPinned,
							}
						: candidate
				)
			);
			setSessions((prev) =>
				prev.map((s) =>
					getRuntimeIdForSession(s) === runtimeId ? { ...s, bookmarked: shouldBookmarkSession } : s
				)
			);
		},
		[setSessions, setThreads, threads]
	);

	// Context menu handlers - memoized to prevent SessionItem re-renders
	const handleContextMenu = useCallback(
		(e: React.MouseEvent, sessionId: string, threadId?: string) => {
			e.preventDefault();
			e.stopPropagation();
			setGroupContextMenu(null);
			setContextMenu({ x: e.clientX, y: e.clientY, sessionId, threadId });
		},
		[]
	);

	const handleGroupContextMenu = useCallback((e: React.MouseEvent, groupId: string) => {
		e.preventDefault();
		e.stopPropagation();
		setContextMenu(null);
		setGroupContextMenu({ x: e.clientX, y: e.clientY, groupId });
	}, []);

	const handleDeleteSession = useCallback(
		(sessionId: string) => {
			setThreads((prev) => prev.filter((thread) => getRuntimeIdForThread(thread) !== sessionId));
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

	const handleDeleteThread = useCallback(
		(thread: Thread) => {
			const owningSession =
				sessions.find(
					(session) => getRuntimeIdForSession(session) === getRuntimeIdForThread(thread)
				) || null;
			if (!owningSession) {
				setThreads((prev) => prev.filter((candidate) => candidate.id !== thread.id));
				setContextMenu(null);
				return;
			}

			const siblingThreads = threads.filter(
				(candidate) =>
					candidate.id !== thread.id &&
					getRuntimeIdForThread(candidate) === getRuntimeIdForSession(owningSession)
			);
			const resolvedTabId = getThreadTabId(thread, owningSession);

			if (!resolvedTabId || siblingThreads.length === 0) {
				handleDeleteSession(owningSession.id);
				return;
			}

			setThreads((prev) => prev.filter((candidate) => candidate.id !== thread.id));
			setSessions((prev) =>
				prev.map((session) => {
					if (session.id !== owningSession.id) {
						return session;
					}

					const result = closeTab(session, resolvedTabId, false, { skipHistory: true });
					return result?.session || session;
				})
			);
			setContextMenu(null);
		},
		[handleDeleteSession, sessions, setSessions, setThreads, threads]
	);

	const handleSelectThread = useCallback(
		(thread: Thread) => {
			const runtimeId = getRuntimeIdForThread(thread);
			const session = useSessionStore
				.getState()
				.sessions.find((candidate) => getRuntimeIdForSession(candidate) === runtimeId);
			useSessionStore.setState((state) => ({
				activeSessionId: runtimeId,
				cyclePosition: -1,
				sessions: state.sessions.map((candidate) =>
					candidate.id === session?.id
						? {
								...candidate,
								activeTabId: getThreadTabId(thread, candidate) || candidate.activeTabId,
							}
						: candidate
				),
			}));
			setActiveGroupChatId(null);
			useConductorStore.getState().setActiveConductorView(null);
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

	const finishRenamingThread = useCallback(
		(threadId: string, newName: string) => {
			const trimmedName = newName.trim();
			if (!trimmedName) {
				setEditingSessionId(null);
				return;
			}

			const thread = threads.find((candidate) => candidate.id === threadId);
			if (!thread) {
				setEditingSessionId(null);
				return;
			}

			setThreads((prev) =>
				prev.map((candidate) =>
					candidate.id === threadId ? { ...candidate, title: trimmedName } : candidate
				)
			);

			const owningSession =
				sessions.find(
					(candidate) => getRuntimeIdForSession(candidate) === getRuntimeIdForThread(thread)
				) || null;
			const resolvedTabId = owningSession ? getThreadTabId(thread, owningSession) : null;
			if (owningSession && resolvedTabId) {
				setSessions((prev) =>
					prev.map((candidate) =>
						candidate.id === owningSession.id
							? {
									...candidate,
									aiTabs: candidate.aiTabs.map((tab) =>
										tab.id === resolvedTabId ? { ...tab, name: trimmedName } : tab
									),
								}
							: candidate
					)
				);
			}

			setEditingSessionId(null);
		},
		[sessions, setEditingSessionId, setSessions, setThreads, threads]
	);

	const handleToggleWorkspaceArchived = useCallback(
		(workspaceId: string, archived: boolean) => {
			setGroups((prev) =>
				prev.map((group) =>
					group.id === workspaceId
						? {
								...group,
								archived,
								collapsed: archived ? true : false,
							}
						: group
				)
			);
			if (!archived) {
				setArchiveExpanded(true);
			}
		},
		[setGroups]
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
			const normalizedWorkingDir = normalizeWorkspacePath(workingDir);
			const reusableSession =
				provider !== 'terminal'
					? currentSessions
							.filter(
								(session) =>
									session.groupId === workspace.id &&
									session.toolType === provider &&
									!session.conductorMetadata?.isConductorSession
							)
							.sort((left, right) => {
								const leftPathMatch =
									normalizeWorkspacePath(left.projectRoot || left.cwd) === normalizedWorkingDir
										? 1
										: 0;
								const rightPathMatch =
									normalizeWorkspacePath(right.projectRoot || right.cwd) === normalizedWorkingDir
										? 1
										: 0;
								if (rightPathMatch !== leftPathMatch) {
									return rightPathMatch - leftPathMatch;
								}
								return getSessionLastActivity(right) - getSessionLastActivity(left);
							})[0] || null
					: null;

			if (reusableSession) {
				const result = createTab(reusableSession, {
					name: null,
					saveToHistory: defaultSaveToHistory,
					showThinking: defaultShowThinking,
				});
				if (result) {
					const newThread: Thread = {
						id: `thread-${generateId()}`,
						workspaceId: workspace.id,
						sessionId: reusableSession.id,
						runtimeId: getRuntimeIdForSession(reusableSession),
						tabId: result.tab.id,
						title: name,
						agentId: provider,
						projectRoot: workingDir,
						pinned: false,
						archived: false,
						isOpen: true,
						createdAt: Date.now(),
						lastUsedAt: Date.now(),
					};
					useSessionStore.setState((state) => ({
						activeSessionId: reusableSession.id,
						cyclePosition: -1,
						sessions: state.sessions.map((session) =>
							session.id === reusableSession.id ? result.session : session
						),
					}));
					setThreads((prev) => [
						...prev.map((thread) =>
							thread.sessionId === reusableSession.id
								? {
										...thread,
										workspaceId: workspace.id,
										projectRoot: workingDir,
										lastUsedAt: Date.now(),
									}
								: thread
						),
						newThread,
					]);
					setActiveGroupChatId(null);
					useConductorStore.getState().setActiveConductorView(null);
					setActiveFocus('main');
					return;
				}
			}

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
		[
			defaultShowThinking,
			defaultSaveToHistory,
			defaultThreadProvider,
			onCreateSession,
			setActiveFocus,
			setActiveGroupChatId,
			setThreads,
		]
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
		() =>
			sessions.filter(
				(session) => !session.parentSessionId && !session.conductorMetadata?.isConductorSession
			),
		[sessions]
	);

	const topLevelSessionsById = useMemo(
		() => new Map(topLevelSessions.map((session) => [session.id, session])),
		[topLevelSessions]
	);
	const topLevelSessionsByRuntimeId = useMemo(
		() => new Map(topLevelSessions.map((session) => [getRuntimeIdForSession(session), session])),
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

	const getThreadRecentTimestamp = useCallback(
		(thread: Thread) =>
			Math.max(
				thread.lastUsedAt,
				topLevelSessionActivityByRuntimeId.get(getRuntimeIdForThread(thread)) || 0
			),
		[topLevelSessionActivityByRuntimeId]
	);

	const archivedWorkspaceIds = useMemo(
		() => new Set(groups.filter((group) => group.archived).map((group) => group.id)),
		[groups]
	);

	const nonArchivedThreads = useMemo(
		() =>
			threads
				.filter(
					(thread) =>
						!thread.archived &&
						topLevelSessionsByRuntimeId.has(getRuntimeIdForThread(thread)) &&
						!archivedWorkspaceIds.has(thread.workspaceId)
				)
				.sort((a, b) => getThreadRecentTimestamp(b) - getThreadRecentTimestamp(a)),
		[threads, topLevelSessionsByRuntimeId, getThreadRecentTimestamp, archivedWorkspaceIds]
	);

	const pinnedThreads = useMemo(
		() => nonArchivedThreads.filter((thread) => thread.pinned),
		[nonArchivedThreads]
	);

	const pinnedThreadIds = useMemo(
		() => new Set(pinnedThreads.map((thread) => thread.id)),
		[pinnedThreads]
	);

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
			.filter((workspace) => !isHiddenConductorWorkspace(workspace))
			.filter(matchesWorkspace)
			.map((workspace) => {
				const workspaceThreads = threads
					.filter(
						(thread) =>
							thread.workspaceId === workspace.id &&
							topLevelSessionsByRuntimeId.has(getRuntimeIdForThread(thread))
					)
					.sort((a, b) => getThreadRecentTimestamp(b) - getThreadRecentTimestamp(a));
				const workspaceSessionIds = new Set(
					workspaceThreads.map((thread) => getRuntimeIdForThread(thread))
				);
				const workspaceSessions = topLevelSessions.filter((session) =>
					workspaceSessionIds.has(getRuntimeIdForSession(session))
				);
				const statusSession = workspaceSessions[0] || null;
				const unreadCount = workspaceSessions.reduce(
					(count, session) => count + (session.aiTabs?.some((tab) => tab.hasUnread) ? 1 : 0),
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
		topLevelSessionsByRuntimeId,
		sessionFilter,
		activeBatchSessionIds,
		workspaceSortMode,
		getThreadRecentTimestamp,
	]);

	const activeWorkspaceEntries = useMemo(
		() => filteredWorkspaces.filter((workspaceEntry) => !workspaceEntry.workspace.archived),
		[filteredWorkspaces]
	);

	const archivedWorkspaceEntries = useMemo(
		() => filteredWorkspaces.filter((workspaceEntry) => workspaceEntry.workspace.archived),
		[filteredWorkspaces]
	);

	const visibleSidebarThreadTargets = useMemo(() => {
		const targets: SidebarThreadTarget[] = [];
		const pushThread = (prefix: string, thread: Thread) => {
			targets.push({
				id: buildSidebarThreadTargetId(prefix, thread.id),
				threadId: thread.id,
				sessionId: thread.sessionId,
				runtimeId: getRuntimeIdForThread(thread),
				workspaceId: thread.workspaceId,
				tabId: thread.tabId || null,
			});
		};

		recentThreads.forEach((thread) => pushThread('recent', thread));
		pinnedThreads.forEach((thread) => pushThread('pinned', thread));

		const pushWorkspaceThreads = (workspaceEntry: (typeof filteredWorkspaces)[number]) => {
			const workspaceId = workspaceEntry.workspace.id;
			workspaceEntry.openThreads.forEach((thread) =>
				pushThread(`workspace-open-${workspaceId}`, thread)
			);
			workspaceEntry.recentThreads.forEach((thread) =>
				pushThread(`workspace-recent-${workspaceId}`, thread)
			);
			if (expandedOlderByWorkspace[workspaceId]) {
				workspaceEntry.olderThreads.forEach((thread) =>
					pushThread(`workspace-older-${workspaceId}`, thread)
				);
			}
			if (expandedArchivedByWorkspace[workspaceId]) {
				workspaceEntry.archivedThreads.forEach((thread) =>
					pushThread(`workspace-archived-${workspaceId}`, thread)
				);
			}
		};

		activeWorkspaceEntries.forEach(pushWorkspaceThreads);
		if (archiveExpanded) {
			archivedWorkspaceEntries.forEach(pushWorkspaceThreads);
		}

		return targets;
	}, [
		activeWorkspaceEntries,
		archiveExpanded,
		archivedWorkspaceEntries,
		expandedArchivedByWorkspace,
		expandedOlderByWorkspace,
		pinnedThreads,
		recentThreads,
	]);

	useEffect(() => {
		setSidebarThreadTargets(visibleSidebarThreadTargets);
	}, [setSidebarThreadTargets, visibleSidebarThreadTargets]);

	useEffect(
		() => () => {
			setSidebarThreadTargets([]);
			setSidebarNavTargets([]);
		},
		[setSidebarNavTargets, setSidebarThreadTargets]
	);

	const sidebarThreadTargetIndexById = useMemo(() => {
		const map = new Map<string, number>();
		visibleSidebarThreadTargets.forEach((target, index) => {
			map.set(target.id, index);
		});
		return map;
	}, [visibleSidebarThreadTargets]);

	const sidebarNavTargets = useMemo(() => {
		if (!leftSidebarOpen) {
			return visibleSidebarThreadTargets.map(
				(target): SidebarNavTarget => ({
					type: 'thread',
					id: target.id,
					thread: target,
				})
			);
		}

		const targets: SidebarNavTarget[] = [];
		recentThreads.forEach((thread) =>
			targets.push({
				type: 'thread',
				id: buildSidebarThreadTargetId('recent', thread.id),
				thread: {
					id: buildSidebarThreadTargetId('recent', thread.id),
					threadId: thread.id,
					sessionId: thread.sessionId,
					runtimeId: getRuntimeIdForThread(thread),
					workspaceId: thread.workspaceId,
					tabId: thread.tabId || null,
				},
			})
		);
		pinnedThreads.forEach((thread) =>
			targets.push({
				type: 'thread',
				id: buildSidebarThreadTargetId('pinned', thread.id),
				thread: {
					id: buildSidebarThreadTargetId('pinned', thread.id),
					threadId: thread.id,
					sessionId: thread.sessionId,
					runtimeId: getRuntimeIdForThread(thread),
					workspaceId: thread.workspaceId,
					tabId: thread.tabId || null,
				},
			})
		);

		const pushWorkspaceTargets = (workspaceEntry: (typeof filteredWorkspaces)[number]) => {
			const workspaceId = workspaceEntry.workspace.id;
			targets.push({
				type: 'workspace',
				id: buildSidebarWorkspaceTargetId(workspaceId),
				workspace: {
					id: buildSidebarWorkspaceTargetId(workspaceId),
					workspaceId,
				},
			});

			workspaceEntry.openThreads.forEach((thread) =>
				targets.push({
					type: 'thread',
					id: buildSidebarThreadTargetId(`workspace-open-${workspaceId}`, thread.id),
					thread: {
						id: buildSidebarThreadTargetId(`workspace-open-${workspaceId}`, thread.id),
						threadId: thread.id,
						sessionId: thread.sessionId,
						runtimeId: getRuntimeIdForThread(thread),
						workspaceId: thread.workspaceId,
						tabId: thread.tabId || null,
					},
				})
			);
			workspaceEntry.recentThreads.forEach((thread) =>
				targets.push({
					type: 'thread',
					id: buildSidebarThreadTargetId(`workspace-recent-${workspaceId}`, thread.id),
					thread: {
						id: buildSidebarThreadTargetId(`workspace-recent-${workspaceId}`, thread.id),
						threadId: thread.id,
						sessionId: thread.sessionId,
						runtimeId: getRuntimeIdForThread(thread),
						workspaceId: thread.workspaceId,
						tabId: thread.tabId || null,
					},
				})
			);
			if (expandedOlderByWorkspace[workspaceId]) {
				workspaceEntry.olderThreads.forEach((thread) =>
					targets.push({
						type: 'thread',
						id: buildSidebarThreadTargetId(`workspace-older-${workspaceId}`, thread.id),
						thread: {
							id: buildSidebarThreadTargetId(`workspace-older-${workspaceId}`, thread.id),
							threadId: thread.id,
							sessionId: thread.sessionId,
							runtimeId: getRuntimeIdForThread(thread),
							workspaceId: thread.workspaceId,
							tabId: thread.tabId || null,
						},
					})
				);
			}
			if (expandedArchivedByWorkspace[workspaceId]) {
				workspaceEntry.archivedThreads.forEach((thread) =>
					targets.push({
						type: 'thread',
						id: buildSidebarThreadTargetId(`workspace-archived-${workspaceId}`, thread.id),
						thread: {
							id: buildSidebarThreadTargetId(`workspace-archived-${workspaceId}`, thread.id),
							threadId: thread.id,
							sessionId: thread.sessionId,
							runtimeId: getRuntimeIdForThread(thread),
							workspaceId: thread.workspaceId,
							tabId: thread.tabId || null,
						},
					})
				);
			}
		};

		activeWorkspaceEntries.forEach(pushWorkspaceTargets);
		if (archiveExpanded) {
			archivedWorkspaceEntries.forEach(pushWorkspaceTargets);
		}

		return targets;
	}, [
		activeWorkspaceEntries,
		archiveExpanded,
		archivedWorkspaceEntries,
		expandedArchivedByWorkspace,
		expandedOlderByWorkspace,
		filteredWorkspaces,
		leftSidebarOpen,
		pinnedThreads,
		recentThreads,
		visibleSidebarThreadTargets,
	]);

	useEffect(() => {
		setSidebarNavTargets(sidebarNavTargets);
	}, [setSidebarNavTargets, sidebarNavTargets]);

	const sidebarNavTargetIndexById = useMemo(() => {
		const map = new Map<string, number>();
		sidebarNavTargets.forEach((target, index) => {
			map.set(target.id, index);
		});
		return map;
	}, [sidebarNavTargets]);

	const activeSidebarThreadTargetId = useMemo(() => {
		const activeSession = topLevelSessionsById.get(activeSessionId);
		if (!activeSession) return null;

		const activeThread =
			threads.find((thread) => isThreadActiveForSession(thread, activeSession)) ||
			threads.find(
				(thread) => getRuntimeIdForThread(thread) === getRuntimeIdForSession(activeSession)
			) ||
			null;
		if (!activeThread) return null;

		return (
			visibleSidebarThreadTargets.find(
				(target) =>
					target.threadId === activeThread.id &&
					target.sessionId === activeSession.id &&
					target.tabId === getThreadTabId(activeThread, activeSession)
			)?.id ||
			visibleSidebarThreadTargets.find(
				(target) => target.threadId === activeThread.id && target.sessionId === activeSession.id
			)?.id ||
			null
		);
	}, [activeSessionId, threads, topLevelSessionsById, visibleSidebarThreadTargets]);

	const skinnySidebarThreadItems = useMemo(() => {
		return visibleSidebarThreadTargets
			.map((target): SkinnySidebarThreadItem | null => {
				const session = topLevelSessionsByRuntimeId.get(target.runtimeId);
				const thread = threads.find((candidate) => candidate.id === target.threadId);
				if (!session || !thread) return null;

				return {
					target,
					thread,
					session,
					displayName: getThreadDisplayTitle(thread, session),
					groupName: groups.find((group) => group.id === thread.workspaceId)?.name,
				};
			})
			.filter((item): item is SkinnySidebarThreadItem => !!item);
	}, [groups, threads, topLevelSessionsByRuntimeId, visibleSidebarThreadTargets]);

	// Precomputed jump number map (1-9, 0=10th) for visible sidebar thread rows
	const jumpNumberMap = useMemo(() => {
		if (!showSessionJumpNumbers) return new Map<string, string>();
		const map = new Map<string, string>();
		for (let i = 0; i < Math.min(visibleSidebarThreadTargets.length, 10); i++) {
			map.set(visibleSidebarThreadTargets[i].id, i === 9 ? '0' : String(i + 1));
		}
		return map;
	}, [showSessionJumpNumbers, visibleSidebarThreadTargets]);

	const getThreadJumpNumber = (targetId: string): string | null => {
		return jumpNumberMap.get(targetId) ?? null;
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
			const session = topLevelSessionsByRuntimeId.get(runtimeId);
			if (!session) return null;
			const targetId = buildSidebarThreadTargetId(options.keyPrefix, thread.id);
			const displayName = getThreadDisplayTitle(thread, session);
			const targetIndex = sidebarNavTargetIndexById.get(targetId) ?? -1;
			const isKeyboardSelected = activeFocus === 'sidebar' && targetIndex === selectedSidebarIndex;
			return (
				<div key={`${options.keyPrefix}-${thread.id}`}>
					<SessionItem
						session={session}
						variant={variant}
						theme={theme}
						displayName={displayName}
						providerAgentId={thread.agentId}
						workspaceEmoji={options.group?.emoji}
						bookmarkState={thread.pinned}
						hasUnread={hasUnreadForThread(thread, session)}
						isActive={activeSessionId === session.id && isThreadActiveForSession(thread, session)}
						isKeyboardSelected={isKeyboardSelected}
						isDragging={draggingSessionId === session.id}
						isEditing={editingSessionId === `thread-${thread.id}`}
						leftSidebarOpen={leftSidebarOpen}
						isWorking={
							isThreadBusyForSession(thread, session) ||
							activeBatchSessionIds.includes(session.id) ||
							Boolean(session.cliActivity)
						}
						isInBatch={activeBatchSessionIds.includes(session.id)}
						jumpNumber={getThreadJumpNumber(targetId)}
						group={options.group}
						groupId={options.group?.id}
						onSelect={() => handleSelectThread(thread)}
						onDragStart={() => handleDragStart(session.id)}
						onContextMenu={(e) => handleContextMenu(e, session.id, thread.id)}
						onFinishRename={(newName) => finishRenamingThread(thread.id, newName)}
						onStartRename={() => startRenamingSession(`thread-${thread.id}`)}
						onToggleBookmark={() => toggleThreadPinned(thread)}
					/>
				</div>
			);
		},
		[
			activeBatchSessionIds,
			activeFocus,
			activeSessionId,
			draggingSessionId,
			editingSessionId,
			finishRenamingThread,
			handleContextMenu,
			handleDragStart,
			handleSelectThread,
			leftSidebarOpen,
			selectedSidebarIndex,
			sidebarNavTargetIndexById,
			startRenamingSession,
			theme,
			toggleThreadPinned,
			topLevelSessionsByRuntimeId,
		]
	);

	const openSkinnySidebarThread = useCallback(
		(target: SidebarThreadTarget) => {
			const thread = threads.find((candidate) => candidate.id === target.threadId);
			if (!thread) return;
			handleSelectThread(thread);
		},
		[handleSelectThread, threads]
	);

	const renderWorkspaceEntry = useCallback(
		(workspaceEntry: (typeof filteredWorkspaces)[number]) => {
			const { workspace, openThreads, recentThreads, olderThreads, archivedThreads } =
				workspaceEntry;
			const expandedOlder = !!expandedOlderByWorkspace[workspace.id];
			const expandedArchived = !!expandedArchivedByWorkspace[workspace.id];
			const workspaceTargetId = buildSidebarWorkspaceTargetId(workspace.id);
			const workspaceTargetIndex = sidebarNavTargetIndexById.get(workspaceTargetId) ?? -1;
			const isWorkspaceKeyboardSelected =
				activeFocus === 'sidebar' && workspaceTargetIndex === selectedSidebarIndex;
			const workspaceGitFileCount = workspaceEntry.statusSession
				? getFileCount(workspaceEntry.statusSession.id)
				: undefined;
			const collapsedPaletteThreads = workspaceEntry.threads
				.map((thread) => {
					const session = topLevelSessionsByRuntimeId.get(getRuntimeIdForThread(thread));
					if (!session) return null;
					return {
						thread,
						session,
						displayName: getThreadDisplayTitle(thread, session),
					};
				})
				.filter(
					(item): item is { thread: Thread; session: Session; displayName: string } => !!item
				);

			return (
				<div key={workspace.id} className="mb-2">
					<div
						className="px-3 py-1.5 flex items-center gap-2 group rounded-lg"
						onContextMenu={(e) => handleGroupContextMenu(e, workspace.id)}
						style={getSidebarHeaderButtonStyle(theme, {
							active:
								(activeConductorView?.scope === 'workspace' &&
									activeConductorView.groupId === workspace.id) ||
								isWorkspaceKeyboardSelected,
							tint: theme.colors.accent,
						})}
					>
						<button
							type="button"
							onClick={() => toggleGroup(workspace.id)}
							className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
							style={{ color: theme.colors.textDim }}
							title={workspace.collapsed ? 'Expand workspace' : 'Collapse workspace'}
						>
							{workspace.collapsed ? (
								<ChevronRight className="w-3 h-3 shrink-0" />
							) : (
								<ChevronDown className="w-3 h-3 shrink-0" />
							)}
						</button>
						<button
							type="button"
							onClick={() => onOpenConductor?.(workspace.id)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									onOpenConductor?.(workspace.id);
								}
							}}
							className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] min-w-0 flex-1 text-left rounded px-1 py-0.5 hover:bg-white/5 transition-colors"
							style={getSidebarWorkspaceTextStyle(theme)}
							title={`Open ${workspace.name} kanban`}
							aria-selected={isWorkspaceKeyboardSelected}
						>
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
												backgroundColor: workspaceEntry.statusSession.sessionSshRemoteConfig
													?.enabled
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
						</button>
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
									{expandedArchived ? 'Hide archived' : `Show archived (${archivedThreads.length})`}
								</button>
							)}
						</div>
					) : (
						<div
							className="ml-8 mr-3 mt-1 mb-2 flex gap-1 h-1.5 cursor-pointer"
							onClick={() => toggleGroup(workspace.id)}
						>
							{collapsedPaletteThreads.map(({ thread, session, displayName }) => (
								<CollapsedSessionPill
									key={`workspace-collapsed-${workspace.id}-${thread.id}`}
									thread={thread}
									session={session}
									keyPrefix={`workspace-collapsed-${workspace.id}`}
									theme={theme}
									activeBatchSessionIds={activeBatchSessionIds}
									leftSidebarWidth={leftSidebarWidthState}
									contextWarningYellowThreshold={contextWarningYellowThreshold}
									contextWarningRedThreshold={contextWarningRedThreshold}
									getFileCount={getFileCount}
									displayName={displayName}
									onSelect={() => handleSelectThread(thread)}
								/>
							))}
						</div>
					)}
				</div>
			);
		},
		[
			activeConductorView,
			activeFocus,
			activeBatchSessionIds,
			contextWarningRedThreshold,
			contextWarningYellowThreshold,
			createThreadForWorkspace,
			editingGroupId,
			expandedArchivedByWorkspace,
			expandedOlderByWorkspace,
			finishRenamingGroup,
			getFileCount,
			leftSidebarWidthState,
			renderThread,
			selectedSidebarIndex,
			sidebarNavTargetIndexById,
			startRenamingGroup,
			theme,
			toggleGroup,
			topLevelSessionsByRuntimeId,
		]
	);

	if (leftSidebarHidden) {
		return (
			<div
				ref={sidebarContainerRef}
				tabIndex={0}
				className="flex shrink-0 outline-none relative z-20"
				style={{ width: '14px', backgroundColor: theme.colors.bgSidebar } as React.CSSProperties}
				onClick={() => setActiveFocus('sidebar')}
				onFocus={() => setActiveFocus('sidebar')}
			>
				<button
					type="button"
					onClick={() => {
						setLeftSidebarHidden(false);
						setLeftSidebarOpen(true);
					}}
					className="absolute top-20 left-1/2 -translate-x-1/2 rounded-r-md border transition-colors hover:bg-white/5"
					style={{
						padding: '10px 4px',
						backgroundColor: theme.colors.bgSidebar,
						borderColor: theme.colors.border,
						color: theme.colors.textDim,
					}}
					title="Show Sidebar"
					aria-label="Show Sidebar"
				>
					<ChevronRight className="w-3.5 h-3.5" />
				</button>
			</div>
		);
	}

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
								src="./icon.png"
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
								src="./icon.png"
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
									onClick={() =>
										setWorkspaceSortMode(workspaceSortMode === 'recent' ? 'alpha' : 'recent')
									}
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
						{onOpenConductorHome && (
							<button
								type="button"
								onClick={onOpenConductorHome}
								className="mt-2 w-full flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-white/5"
								style={{
									borderColor:
										activeConductorView?.scope === 'home'
											? `${theme.colors.accent}40`
											: theme.colors.border,
									color: theme.colors.textMain,
									backgroundColor:
										activeConductorView?.scope === 'home'
											? `${theme.colors.accent}10`
											: 'transparent',
								}}
								title="Open Agent Review"
							>
								<span className="inline-flex items-center gap-2">
									<FolderKanban className="w-4 h-4" style={{ color: theme.colors.accent }} />
									<span>Agent Review</span>
								</span>
							</button>
						)}
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

					{activeWorkspaceEntries.map(renderWorkspaceEntry)}

					{archivedWorkspaceEntries.length > 0 && (
						<div className="mt-3">
							<button
								type="button"
								onClick={() => setArchiveExpanded((prev) => !prev)}
								className="mx-3 w-[calc(100%-24px)] px-3 py-1.5 flex items-center justify-between rounded-lg hover:bg-white/5 transition-colors"
								style={getSidebarHeaderButtonStyle(theme, {
									active: archiveExpanded,
									tint: theme.colors.textDim,
								})}
							>
								<div
									className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em]"
									style={getSidebarWorkspaceTextStyle(theme)}
								>
									{archiveExpanded ? (
										<ChevronDown className="w-3 h-3 shrink-0" />
									) : (
										<ChevronRight className="w-3 h-3 shrink-0" />
									)}
									<span>Archive</span>
								</div>
								<span
									className="px-1.5 py-0.5 rounded-full text-[9px] font-bold shrink-0"
									style={{
										backgroundColor: `${theme.colors.textDim}18`,
										color: theme.colors.textDim,
									}}
								>
									{archivedWorkspaceEntries.length}
								</span>
							</button>

							{archiveExpanded && (
								<div className="mt-2">{archivedWorkspaceEntries.map(renderWorkspaceEntry)}</div>
							)}
						</div>
					)}

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
					threadItems={skinnySidebarThreadItems}
					activeThreadTargetId={activeSidebarThreadTargetId}
					activeBatchSessionIds={activeBatchSessionIds}
					contextWarningYellowThreshold={contextWarningYellowThreshold}
					contextWarningRedThreshold={contextWarningRedThreshold}
					getFileCount={getFileCount}
					openThreadTarget={openSkinnySidebarThread}
					handleContextMenu={handleContextMenu}
				/>
			)}

			{/* SIDEBAR BOTTOM ACTIONS */}
			<SidebarActions
				theme={theme}
				leftSidebarOpen={leftSidebarOpen}
				leftSidebarHidden={leftSidebarHidden}
				hasNoSessions={sessions.length === 0}
				shortcuts={shortcuts}
				openWizard={openWizard}
				setLeftSidebarOpen={setLeftSidebarOpen}
				setLeftSidebarHidden={setLeftSidebarHidden}
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
							contextMenuThread
								? getThreadDisplayTitle(contextMenuThread, contextMenuSession)
								: contextMenuSession.name
						);
						if (contextMenuThread) {
							startRenamingSession(`thread-${contextMenuThread.id}`);
						} else {
							setRenameInstanceSessionId(contextMenuSession.id);
							setRenameInstanceModalOpen(true);
						}
					}}
					onEdit={() => onEditAgent(contextMenuSession)}
					onDuplicate={() => {
						setNewInstanceModalOpen(true);
						setNewInstanceMode('thread');
						setNewInstanceWorkspaceId(
							contextMenuThread?.workspaceId || contextMenuSession.workspaceId || null
						);
						setNewInstanceFixedWorkingDir(contextMenuSession.projectRoot || contextMenuSession.cwd);
						setNewInstanceDefaultAgentId(contextMenuSession.toolType);
						setDuplicatingSessionId(contextMenuSession.id);
						setContextMenu(null);
					}}
					onTogglePinned={() => contextMenuThread && toggleThreadPinned(contextMenuThread)}
					onCloseThread={() => contextMenuThread && handleCloseThread(contextMenuThread.id)}
					onToggleArchived={() => contextMenuThread && handleToggleArchived(contextMenuThread)}
					onDelete={() =>
						contextMenuThread
							? handleDeleteThread(contextMenuThread)
							: handleDeleteSession(contextMenuSession.id)
					}
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
					onToggleArchived={() =>
						handleToggleWorkspaceArchived(contextMenuGroup.id, !contextMenuGroup.archived)
					}
					onDelete={() => onDeleteWorktreeGroup(contextMenuGroup.id)}
					onDismiss={() => setGroupContextMenu(null)}
				/>
			)}
		</div>
	);
}

export const SessionList = memo(SessionListInner);
