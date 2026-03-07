/**
 * useMobileSessionManagement - Mobile session state management hook
 *
 * Manages session state for the mobile web interface:
 * - Session and tab selection state
 * - Session logs fetching and state
 * - Session selection handlers (select session, tab, new tab, close tab)
 * - Auto-selection of first session
 * - Sync activeTabId when sessions update
 *
 * Extracted from mobile App.tsx for code organization.
 *
 * @example
 * ```tsx
 * const {
 *   sessions,
 *   activeSessionId,
 *   activeSession,
 *   sessionLogs,
 *   isLoadingLogs,
 *   handleSelectSession,
 *   handleSelectTab,
 *   handleNewTab,
 *   handleCloseTab,
 *   sessionsHandlers,
 * } = useMobileSessionManagement({
 *   savedActiveSessionId: loadedState.activeSessionId,
 *   savedActiveTabId: loadedState.activeTabId,
 *   isOffline,
 *   send,
 *   triggerHaptic,
 * });
 * ```
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type {
	ResponseCompletedEvent,
	WebAttachmentSummary,
	WebRemoteLogEntry,
} from '../../shared/remote-web';
import type { Session } from './useSessions';
import type { WebSocketState, AITabData, AutoRunState, CustomCommand } from './useWebSocket';
import { buildApiUrl, getMaestroConfig, updateUrlForSessionTab } from '../utils/config';
import { webLogger } from '../utils/logger';
import type { Theme } from '../../shared/theme-types';

export type LogEntry = WebRemoteLogEntry;

/**
 * Session logs state structure
 */
export interface SessionLogsState {
	aiLogs: LogEntry[];
	shellLogs: LogEntry[];
}

/**
 * Haptic pattern type (single number or array of numbers for vibration patterns)
 */
export type HapticPattern = number | readonly number[];

/**
 * Dependencies for useMobileSessionManagement
 */
export interface UseMobileSessionManagementDeps {
	/** Saved active session ID from view state */
	savedActiveSessionId: string | null;
	/** Saved active tab ID from view state */
	savedActiveTabId: string | null;
	/** Whether the device is offline */
	isOffline: boolean;
	/** Ref to WebSocket send function (updated after useWebSocket is initialized) */
	sendRef: React.RefObject<((message: Record<string, unknown>) => boolean) | null>;
	/** Haptic feedback trigger function */
	triggerHaptic: (pattern?: HapticPattern) => void;
	/** Haptic pattern for tap */
	hapticTapPattern: HapticPattern;
	/** Callback when session response completes (for notifications) */
	onResponseComplete?: (session: Session, response?: unknown) => void;
	/** Callback when a canonical response-completed event is received */
	onResponseCompletedEvent?: (event: ResponseCompletedEvent) => void;
	/** Callback when theme updates from server */
	onThemeUpdate?: (theme: Theme) => void;
	/** Callback when custom commands are received */
	onCustomCommands?: (commands: CustomCommand[]) => void;
	/** Callback when AutoRun state changes */
	onAutoRunStateChange?: (sessionId: string, state: AutoRunState | null) => void;
}

/**
 * WebSocket handlers for session state updates
 * These should be passed to useWebSocket's handlers option
 */
export interface MobileSessionHandlers {
	onConnectionChange: (newState: WebSocketState) => void;
	onError: (err: string) => void;
	onSessionsUpdate: (newSessions: Session[]) => void;
	onSessionStateChange: (
		sessionId: string,
		state: string,
		additionalData?: Partial<Session>
	) => void;
	onSessionAdded: (session: Session) => void;
	onSessionRemoved: (sessionId: string) => void;
	onActiveSessionChanged: (sessionId: string) => void;
	onSessionOutput: (
		sessionId: string,
		data: string,
		source: 'ai' | 'terminal',
		tabId?: string
	) => void;
	onSessionExit: (sessionId: string, exitCode: number) => void;
	onUserInput: (
		sessionId: string,
		command: string,
		inputMode: 'ai' | 'terminal',
		images?: string[],
		attachments?: WebAttachmentSummary[]
	) => void;
	onThemeUpdate: (theme: Theme) => void;
	onCustomCommands: (commands: CustomCommand[]) => void;
	onAutoRunStateChange: (sessionId: string, state: AutoRunState | null) => void;
	onTabsChanged: (sessionId: string, aiTabs: AITabData[], newActiveTabId: string) => void;
	onNewTabResult: (sessionId: string, success: boolean, tabId?: string) => void;
	onDeleteSessionResult: (sessionId: string, success: boolean) => void;
	onSessionLogEntry: (
		sessionId: string,
		tabId: string | null,
		inputMode: 'ai' | 'terminal',
		logEntry: LogEntry
	) => void;
	onResponseCompleted: (event: ResponseCompletedEvent) => void;
}

/**
 * Return type for useMobileSessionManagement
 */
export interface UseMobileSessionManagementReturn {
	/** All sessions */
	sessions: Session[];
	/** Set sessions state directly */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	/** Currently active session ID */
	activeSessionId: string | null;
	/** Set active session ID directly */
	setActiveSessionId: React.Dispatch<React.SetStateAction<string | null>>;
	/** Currently active tab ID */
	activeTabId: string | null;
	/** Set active tab ID directly */
	setActiveTabId: React.Dispatch<React.SetStateAction<string | null>>;
	/** Currently active session object */
	activeSession: Session | undefined;
	/** Session logs for the active session */
	sessionLogs: SessionLogsState;
	/** Whether logs are currently loading */
	isLoadingLogs: boolean;
	/** Whether logs are refreshing in the background */
	isSyncingLogs: boolean;
	/** Ref tracking active session ID for callbacks */
	activeSessionIdRef: React.RefObject<string | null>;
	/** Handler to select a session (also notifies desktop) */
	handleSelectSession: (sessionId: string) => void;
	/** Handler to select an exact session/tab target */
	handleSelectSessionTab: (sessionId: string, tabId: string | null) => void;
	/** Handler to select a tab within the active session */
	handleSelectTab: (tabId: string) => void;
	/** Handler to create a new tab in the active session */
	handleNewTab: () => void;
	/** Handler to delete a session/agent */
	handleDeleteSession: (sessionId: string) => void;
	/** Handler to close a tab in the active session */
	handleCloseTab: (tabId: string) => void;
	/** Handler to rename a tab in the active session */
	handleRenameTab: (tabId: string, newName: string) => void;
	/** Handler to star/unstar a tab in the active session */
	handleStarTab: (tabId: string, starred: boolean) => void;
	/** Handler to reorder a tab in the active session */
	handleReorderTab: (fromIndex: number, toIndex: number) => void;
	/** Handler to toggle bookmark on a session */
	handleToggleBookmark: (sessionId: string) => void;
	/** Add a user input log entry to session logs */
	addUserLogEntry: (
		text: string,
		inputMode: 'ai' | 'terminal',
		images?: string[],
		attachments?: WebAttachmentSummary[]
	) => void;
	/** WebSocket handlers for session state updates */
	sessionsHandlers: MobileSessionHandlers;
}

function getLogsTargetKey(sessionId: string, tabId: string | null): string {
	return `${sessionId}::${tabId || ''}`;
}

/**
 * Hook for managing session state in the mobile web interface
 *
 * Handles:
 * - Session list state management
 * - Active session/tab selection
 * - Session logs fetching
 * - WebSocket event handlers for session updates
 * - URL synchronization for shareable links
 *
 * @param deps - Dependencies including saved state, network status, and callbacks
 * @returns Session state and handlers
 */
export function useMobileSessionManagement(
	deps: UseMobileSessionManagementDeps
): UseMobileSessionManagementReturn {
	const {
		savedActiveSessionId,
		savedActiveTabId,
		isOffline,
		sendRef,
		triggerHaptic,
		hapticTapPattern,
		onResponseComplete,
		onResponseCompletedEvent,
		onThemeUpdate,
		onCustomCommands,
		onAutoRunStateChange,
	} = deps;

	// Get URL-based session/tab from config (takes precedence over localStorage)
	const config = getMaestroConfig();
	const urlSessionId = config.sessionId;
	const urlTabId = config.tabId;

	// Session state - URL takes precedence over saved state
	const [sessions, setSessions] = useState<Session[]>([]);
	const [activeSessionId, setActiveSessionId] = useState<string | null>(
		urlSessionId || savedActiveSessionId
	);
	const [activeTabId, setActiveTabId] = useState<string | null>(urlTabId || savedActiveTabId);
	const sessionsRef = useRef<Session[]>([]);

	// Session logs state
	const [sessionLogs, setSessionLogs] = useState<SessionLogsState>({
		aiLogs: [],
		shellLogs: [],
	});
	const [isLoadingLogs, setIsLoadingLogs] = useState(false);
	const [isSyncingLogs, setIsSyncingLogs] = useState(false);

	// Track previous session states for detecting busy -> idle transitions
	const previousSessionStatesRef = useRef<Map<string, string>>(new Map());
	const pendingMinimumTabCountRef = useRef<Map<string, number>>(new Map());
	const pendingNewTabIdRef = useRef<Map<string, string>>(new Map());
	const pendingClosedTabIdsRef = useRef<Map<string, Map<string, number>>>(new Map());
	const pendingAddedSessionIdsRef = useRef<Map<string, number>>(new Map());
	const recentlyRemovedSessionIdsRef = useRef<Map<string, number>>(new Map());

	// Ref to track activeSessionId for use in callbacks (avoids stale closure issues)
	// Initialize with same value as state to avoid race condition where WebSocket
	// messages arrive before useEffect syncs the ref
	const activeSessionIdRef = useRef<string | null>(urlSessionId || savedActiveSessionId);
	// Ref to track activeTabId for use in callbacks (avoids stale closure issues)
	const activeTabIdRef = useRef<string | null>(urlTabId || savedActiveTabId);
	// Track recent websocket/user activity so polling only fills realtime gaps
	const lastRealtimeActivityAtRef = useRef(0);
	const loadedLogsTargetKeyRef = useRef<string | null>(null);
	const latestLogsRequestIdRef = useRef(0);
	const backgroundLogsRequestCountRef = useRef(0);

	const resetDisplayedLogs = useCallback(() => {
		lastRealtimeActivityAtRef.current = 0;
		loadedLogsTargetKeyRef.current = null;
		latestLogsRequestIdRef.current += 1;
		backgroundLogsRequestCountRef.current = 0;
		setIsLoadingLogs(false);
		setIsSyncingLogs(false);
		setSessionLogs({ aiLogs: [], shellLogs: [] });
	}, []);

	const switchActiveTarget = useCallback(
		(
			sessionId: string | null,
			tabId: string | null,
			options?: {
				resetLogs?: boolean;
			}
		) => {
			const targetChanged =
				activeSessionIdRef.current !== sessionId || activeTabIdRef.current !== tabId;

			if (options?.resetLogs && targetChanged) {
				resetDisplayedLogs();
			}

			activeSessionIdRef.current = sessionId;
			activeTabIdRef.current = tabId;
			setActiveSessionId(sessionId);
			setActiveTabId(tabId);
		},
		[resetDisplayedLogs]
	);

	// Keep activeSessionIdRef in sync with state
	useEffect(() => {
		activeSessionIdRef.current = activeSessionId;
	}, [activeSessionId]);

	// Keep activeTabIdRef in sync with state
	useEffect(() => {
		activeTabIdRef.current = activeTabId;
	}, [activeTabId]);

	useEffect(() => {
		sessionsRef.current = sessions;
	}, [sessions]);

	// Update URL to reflect current session and tab (for shareable links)
	// Only update if we're in session mode (not dashboard)
	useEffect(() => {
		if (activeSessionId) {
			updateUrlForSessionTab(activeSessionId, activeTabId);
		}
	}, [activeSessionId, activeTabId]);

	// Get active session object
	const activeSession = useMemo(() => {
		return sessions.find((s) => s.id === activeSessionId);
	}, [sessions, activeSessionId]);

	const displayedSessionLogs = useMemo(() => {
		if (!activeSessionId) {
			return { aiLogs: [], shellLogs: [] };
		}

		const activeTargetKey = getLogsTargetKey(activeSessionId, activeTabId);
		if (loadedLogsTargetKeyRef.current !== activeTargetKey) {
			return { aiLogs: [], shellLogs: [] };
		}

		return sessionLogs;
	}, [activeSessionId, activeTabId, sessionLogs]);

	const fetchSessionLogs = useCallback(
		async (
			sessionId: string,
			tabId: string | null,
			options?: {
				background?: boolean;
			}
		) => {
			const targetKey = getLogsTargetKey(sessionId, tabId);
			const requestId = ++latestLogsRequestIdRef.current;
			const shouldBlock = !options?.background && loadedLogsTargetKeyRef.current !== targetKey;

			if (shouldBlock) {
				setIsLoadingLogs(true);
			}
			if (options?.background) {
				backgroundLogsRequestCountRef.current += 1;
				setIsSyncingLogs(true);
			}

			try {
				const tabParam = tabId ? `?tabId=${tabId}` : '';
				const apiUrl = buildApiUrl(`/session/${sessionId}${tabParam}`);
				const response = await fetch(apiUrl, { cache: 'no-store' });
				if (response.ok) {
					const data = await response.json();
					const session = data.session;

					// Ignore stale responses when the user changed session/tab mid-request.
					if (latestLogsRequestIdRef.current !== requestId) {
						return;
					}

					const activeTargetKey = activeSessionIdRef.current
						? getLogsTargetKey(activeSessionIdRef.current, activeTabIdRef.current)
						: null;
					if (activeTargetKey !== targetKey) {
						webLogger.debug('Ignoring stale session logs response', 'Mobile', {
							sessionId,
							tabId,
							targetKey,
							activeTargetKey,
						});
						return;
					}

					setSessionLogs({
						aiLogs: session?.aiLogs || [],
						shellLogs: session?.shellLogs || [],
					});
					loadedLogsTargetKeyRef.current = targetKey;
					lastRealtimeActivityAtRef.current = Date.now();
					webLogger.debug('Fetched session logs:', 'Mobile', {
						aiLogs: session?.aiLogs?.length || 0,
						shellLogs: session?.shellLogs?.length || 0,
						requestedTabId: tabId,
						returnedTabId: session?.activeTabId,
					});
				}
			} catch (err) {
				webLogger.error('Failed to fetch session logs', 'Mobile', err);
			} finally {
				if (options?.background) {
					backgroundLogsRequestCountRef.current = Math.max(
						0,
						backgroundLogsRequestCountRef.current - 1
					);
					if (backgroundLogsRequestCountRef.current === 0) {
						setIsSyncingLogs(false);
					}
				}
				if (shouldBlock && latestLogsRequestIdRef.current === requestId) {
					setIsLoadingLogs(false);
				}
			}
		},
		[]
	);

	const applySessionsSnapshot = useCallback((newSessions: Session[]) => {
		const currentSessions = sessionsRef.current;
		const now = Date.now();
		const normalizedSessions: Session[] = newSessions
			.filter((session) => {
				const removedAt = recentlyRemovedSessionIdsRef.current.get(session.id);
				if (removedAt && now - removedAt < 10000) {
					webLogger.debug(`Ignoring recently removed session snapshot for ${session.id}`, 'Mobile');
					return false;
				}
				return true;
			})
			.map((session) => {
				const pendingMinimum = pendingMinimumTabCountRef.current.get(session.id);
				const currentSession = currentSessions.find((candidate) => candidate.id === session.id);
				const pendingClosedTabs = pendingClosedTabIdsRef.current.get(session.id);
				const filteredAiTabs = session.aiTabs?.filter((tab) => {
					const closedAt = pendingClosedTabs?.get(tab.id);
					return !closedAt || now - closedAt >= 10000;
				});
				const resolvedActiveTabId = filteredAiTabs?.some((tab) => tab.id === session.activeTabId)
					? session.activeTabId
					: filteredAiTabs?.[filteredAiTabs.length - 1]?.id;

				if (
					pendingMinimum !== undefined &&
					currentSession &&
					(filteredAiTabs?.length || 0) < pendingMinimum
				) {
					webLogger.debug(
						`Ignoring stale session snapshot for ${session.id}: received ${filteredAiTabs?.length || 0}, waiting for at least ${pendingMinimum}`,
						'Mobile'
					);
					return {
						...session,
						aiTabs: currentSession.aiTabs,
						activeTabId: currentSession.activeTabId,
					};
				}

				if (pendingClosedTabs && filteredAiTabs) {
					const nextPendingClosedTabs = new Map(pendingClosedTabs);
					for (const [closedTabId, closedAt] of nextPendingClosedTabs.entries()) {
						const isExpired = now - closedAt >= 10000;
						const tabIsGone = !filteredAiTabs.some((tab) => tab.id === closedTabId);
						if (isExpired || tabIsGone) {
							nextPendingClosedTabs.delete(closedTabId);
						}
					}
					if (nextPendingClosedTabs.size === 0) {
						pendingClosedTabIdsRef.current.delete(session.id);
					} else {
						pendingClosedTabIdsRef.current.set(session.id, nextPendingClosedTabs);
					}
				}

				return {
					...session,
					aiTabs: filteredAiTabs,
					activeTabId: resolvedActiveTabId,
				};
			});

		const normalizedSessionIds = new Set(normalizedSessions.map((session) => session.id));
		const mergedSessions: Session[] = [...normalizedSessions];
		for (const existingSession of currentSessions) {
			const addedAt = pendingAddedSessionIdsRef.current.get(existingSession.id);
			if (addedAt && now - addedAt < 10000 && !normalizedSessionIds.has(existingSession.id)) {
				webLogger.debug(
					`Preserving recently added session ${existingSession.id} while waiting for persisted snapshot`,
					'Mobile'
				);
				mergedSessions.push(existingSession);
			}
		}

		webLogger.debug(`Sessions updated: ${mergedSessions.length}`, 'Mobile');

		mergedSessions.forEach((session) => {
			previousSessionStatesRef.current.set(session.id, session.state);
			const pendingMinimum = pendingMinimumTabCountRef.current.get(session.id);
			if (pendingMinimum !== undefined && (session.aiTabs?.length || 0) >= pendingMinimum) {
				pendingMinimumTabCountRef.current.delete(session.id);
			}
			if (pendingAddedSessionIdsRef.current.has(session.id)) {
				pendingAddedSessionIdsRef.current.delete(session.id);
			}
		});

		sessionsRef.current = mergedSessions;
		setSessions(mergedSessions);

		const currentActiveId = activeSessionIdRef.current;
		if (!currentActiveId && mergedSessions.length > 0) {
			const firstSession = mergedSessions[0];
			activeSessionIdRef.current = firstSession.id;
			activeTabIdRef.current = firstSession.activeTabId || null;
			setActiveSessionId(firstSession.id);
			setActiveTabId(firstSession.activeTabId || null);
			return;
		}

		if (currentActiveId) {
			const currentSession = mergedSessions.find((session) => session.id === currentActiveId);
			if (currentSession) {
				activeTabIdRef.current = currentSession.activeTabId || null;
				setActiveTabId(currentSession.activeTabId || null);
			}
		}
	}, []);

	const refreshSessionsList = useCallback(
		async (preferredSessionId?: string, preferredTabId?: string | null) => {
			try {
				const response = await fetch(buildApiUrl('/sessions'), { cache: 'no-store' });
				if (!response.ok) {
					throw new Error(`Failed to refresh sessions list (${response.status})`);
				}

				const data = (await response.json()) as { sessions?: Session[] };
				const refreshedSessions = Array.isArray(data.sessions) ? data.sessions : [];
				applySessionsSnapshot(refreshedSessions);

				if (preferredSessionId) {
					const preferredSession = refreshedSessions.find(
						(session) => session.id === preferredSessionId
					);
					if (preferredSession) {
						const resolvedTabId =
							preferredTabId && preferredSession.aiTabs?.some((tab) => tab.id === preferredTabId)
								? preferredTabId
								: preferredSession.activeTabId || null;
						activeSessionIdRef.current = preferredSession.id;
						activeTabIdRef.current = resolvedTabId;
						setActiveSessionId(preferredSession.id);
						setActiveTabId(resolvedTabId);
					}
				}
			} catch (error) {
				webLogger.error('Failed to refresh sessions list', 'Mobile', error);
			}
		},
		[applySessionsSnapshot]
	);

	const scheduleSessionRefresh = useCallback(
		(
			preferredSessionId?: string,
			preferredTabId?: string | null,
			delays: number[] = [150, 700, 1800]
		) => {
			delays.forEach((delay) => {
				window.setTimeout(() => {
					void refreshSessionsList(preferredSessionId, preferredTabId);
				}, delay);
			});
		},
		[refreshSessionsList]
	);

	// Fetch session logs when active session or active tab changes
	useEffect(() => {
		if (!activeSessionId || isOffline) {
			lastRealtimeActivityAtRef.current = 0;
			loadedLogsTargetKeyRef.current = null;
			latestLogsRequestIdRef.current += 1;
			backgroundLogsRequestCountRef.current = 0;
			setIsLoadingLogs(false);
			setIsSyncingLogs(false);
			setSessionLogs({ aiLogs: [], shellLogs: [] });
			return;
		}

		lastRealtimeActivityAtRef.current = Date.now();
		void fetchSessionLogs(activeSessionId, activeTabId);
	}, [activeSessionId, activeTabId, fetchSessionLogs, isOffline]);

	useEffect(() => {
		if (
			!activeSessionId ||
			!activeSession ||
			isOffline ||
			activeSession.inputMode !== 'ai' ||
			activeSession.state !== 'busy'
		) {
			return;
		}

		const interval = window.setInterval(() => {
			const now = Date.now();
			if (now - lastRealtimeActivityAtRef.current < 12000) {
				return;
			}

			void fetchSessionLogs(activeSessionIdRef.current || activeSessionId, activeTabIdRef.current, {
				background: true,
			});
		}, 10000);

		return () => window.clearInterval(interval);
	}, [activeSession, activeSessionId, fetchSessionLogs, isOffline]);

	// Handle session selection - also notifies desktop to switch
	const handleSelectSession = useCallback(
		(sessionId: string) => {
			// Find the session to get its activeTabId
			const session = sessions.find((s) => s.id === sessionId);
			switchActiveTarget(sessionId, session?.activeTabId || null, { resetLogs: true });
			triggerHaptic(hapticTapPattern);
			// Notify desktop to switch to this session (include activeTabId if available)
			sendRef.current?.({
				type: 'select_session',
				sessionId,
				tabId: session?.activeTabId || undefined,
			});
		},
		[sessions, sendRef, triggerHaptic, hapticTapPattern]
	);

	const handleSelectSessionTab = useCallback(
		(sessionId: string, tabId: string | null) => {
			const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
			const resolvedTabId = tabId || session?.activeTabId || null;

			switchActiveTarget(sessionId, resolvedTabId, { resetLogs: true });
			triggerHaptic(hapticTapPattern);
			sendRef.current?.({
				type: 'select_session',
				sessionId,
				tabId: resolvedTabId || undefined,
			});
			setSessions((prev) =>
				prev.map((candidate) =>
					candidate.id === sessionId
						? {
								...candidate,
								activeTabId: resolvedTabId || candidate.activeTabId,
							}
						: candidate
				)
			);
		},
		[sendRef, switchActiveTarget, triggerHaptic, hapticTapPattern]
	);

	// Handle selecting a tab within a session
	const handleSelectTab = useCallback(
		(tabId: string) => {
			if (!activeSessionId) return;
			triggerHaptic(hapticTapPattern);
			// Notify desktop to switch to this tab
			sendRef.current?.({ type: 'select_tab', sessionId: activeSessionId, tabId });
			// Update ref synchronously to avoid race conditions with WebSocket messages
			switchActiveTarget(activeSessionId, tabId, { resetLogs: true });
			// Also update sessions state for UI consistency
			setSessions((prev) =>
				prev.map((s) => (s.id === activeSessionId ? { ...s, activeTabId: tabId } : s))
			);
		},
		[activeSessionId, sendRef, switchActiveTarget, triggerHaptic, hapticTapPattern]
	);

	// Handle creating a new tab
	const handleNewTab = useCallback(() => {
		if (!activeSessionId) return;
		triggerHaptic(hapticTapPattern);
		const currentSession = sessionsRef.current.find((session) => session.id === activeSessionId);
		const currentTabCount = currentSession?.aiTabs?.length || 0;
		const optimisticTabId = `pending-tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		pendingNewTabIdRef.current.set(activeSessionId, optimisticTabId);
		pendingMinimumTabCountRef.current.set(activeSessionId, currentTabCount + 1);

		activeTabIdRef.current = optimisticTabId;
		setActiveTabId(optimisticTabId);
		setSessionLogs({ aiLogs: [], shellLogs: [] });
		setSessions((prev) =>
			prev.map((session) => {
				if (session.id !== activeSessionId) {
					return session;
				}

				const optimisticTabs = [
					...(session.aiTabs || []),
					{
						id: optimisticTabId,
						agentSessionId: null,
						name: null,
						starred: false,
						inputValue: '',
						createdAt: Date.now(),
						state: 'idle' as const,
					},
				];

				return {
					...session,
					aiTabs: optimisticTabs,
					activeTabId: optimisticTabId,
				};
			})
		);

		// Notify desktop to create a new tab
		sendRef.current?.({ type: 'new_tab', sessionId: activeSessionId });
	}, [activeSessionId, hapticTapPattern, sendRef, triggerHaptic]);

	const handleDeleteSession = useCallback(
		(sessionId: string) => {
			const currentSessions = sessionsRef.current;
			const nextSessions = currentSessions.filter((session) => session.id !== sessionId);
			const fallbackSession =
				activeSessionIdRef.current === sessionId ? nextSessions[0] || null : null;

			recentlyRemovedSessionIdsRef.current.set(sessionId, Date.now());
			previousSessionStatesRef.current.delete(sessionId);
			pendingMinimumTabCountRef.current.delete(sessionId);
			pendingNewTabIdRef.current.delete(sessionId);

			setSessions(nextSessions);

			if (activeSessionIdRef.current === sessionId) {
				switchActiveTarget(fallbackSession?.id || null, fallbackSession?.activeTabId || null, {
					resetLogs: true,
				});
				if (!fallbackSession) {
					resetDisplayedLogs();
				}
			}

			sendRef.current?.({ type: 'delete_session', sessionId });

			scheduleSessionRefresh(fallbackSession?.id, fallbackSession?.activeTabId || null);
		},
		[resetDisplayedLogs, scheduleSessionRefresh, sendRef, switchActiveTarget]
	);

	// Handle closing a tab
	const handleCloseTab = useCallback(
		(tabId: string) => {
			if (!activeSessionId) return;
			triggerHaptic(hapticTapPattern);
			const currentSession = sessionsRef.current.find((session) => session.id === activeSessionId);
			const currentTabs = currentSession?.aiTabs || [];
			const remainingTabs = currentTabs.filter((tab) => tab.id !== tabId);
			const nextActiveTabId =
				currentSession?.activeTabId === tabId
					? remainingTabs[remainingTabs.length - 1]?.id || null
					: currentSession?.activeTabId || null;
			const now = Date.now();
			setSessions((prev) =>
				prev.map((session) => {
					if (session.id !== activeSessionId) {
						return session;
					}

					return {
						...session,
						aiTabs: remainingTabs,
						activeTabId: nextActiveTabId || undefined,
					};
				})
			);
			if (activeTabIdRef.current === tabId) {
				switchActiveTarget(activeSessionId, nextActiveTabId, { resetLogs: true });
				void fetchSessionLogs(activeSessionId, nextActiveTabId);
			}
			const sessionPendingClosedTabs = new Map(
				pendingClosedTabIdsRef.current.get(activeSessionId) || []
			);
			sessionPendingClosedTabs.set(tabId, now);
			pendingClosedTabIdsRef.current.set(activeSessionId, sessionPendingClosedTabs);
			// Notify desktop to close this tab
			sendRef.current?.({ type: 'close_tab', sessionId: activeSessionId, tabId });
		},
		[
			activeSessionId,
			fetchSessionLogs,
			sendRef,
			switchActiveTarget,
			triggerHaptic,
			hapticTapPattern,
		]
	);

	// Handle renaming a tab
	const handleRenameTab = useCallback(
		(tabId: string, newName: string) => {
			if (!activeSessionId) return;
			sendRef.current?.({ type: 'rename_tab', sessionId: activeSessionId, tabId, newName });
		},
		[activeSessionId, sendRef]
	);

	// Handle starring/unstarring a tab
	const handleStarTab = useCallback(
		(tabId: string, starred: boolean) => {
			if (!activeSessionId) return;
			sendRef.current?.({ type: 'star_tab', sessionId: activeSessionId, tabId, starred });
			// Optimistically update local state
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSessionId) return s;
					return {
						...s,
						aiTabs: s.aiTabs?.map((t: any) => (t.id === tabId ? { ...t, starred } : t)),
					};
				})
			);
		},
		[activeSessionId, sendRef, setSessions]
	);

	// Handle reordering a tab
	const handleReorderTab = useCallback(
		(fromIndex: number, toIndex: number) => {
			if (!activeSessionId) return;
			sendRef.current?.({ type: 'reorder_tab', sessionId: activeSessionId, fromIndex, toIndex });
			// Optimistically update local state
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSessionId || !s.aiTabs) return s;
					const tabs = [...s.aiTabs];
					const [movedTab] = tabs.splice(fromIndex, 1);
					tabs.splice(toIndex, 0, movedTab);
					return { ...s, aiTabs: tabs };
				})
			);
		},
		[activeSessionId, sendRef, setSessions]
	);

	// Handle toggling bookmark on a session
	const handleToggleBookmark = useCallback(
		(sessionId: string) => {
			sendRef.current?.({ type: 'toggle_bookmark', sessionId });
			// Optimistically update local state
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					return { ...s, bookmarked: !s.bookmarked };
				})
			);
		},
		[sendRef, setSessions]
	);

	// Add a user input log entry to session logs
	const addUserLogEntry = useCallback(
		(
			text: string,
			inputMode: 'ai' | 'terminal',
			images?: string[],
			attachments?: WebAttachmentSummary[]
		) => {
			const userLogEntry: LogEntry = {
				id: `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
				timestamp: Date.now(),
				text,
				source: 'user',
				images,
				attachments,
			};
			setSessionLogs((prev) => {
				const logKey = inputMode === 'ai' ? 'aiLogs' : 'shellLogs';
				return { ...prev, [logKey]: [...prev[logKey], userLogEntry] };
			});
		},
		[]
	);

	const upsertSessionLogEntry = useCallback(
		(sessionId: string, tabId: string | null, inputMode: 'ai' | 'terminal', logEntry: LogEntry) => {
			const currentActiveId = activeSessionIdRef.current;
			const currentActiveTabId = activeTabIdRef.current;

			if (currentActiveId !== sessionId) {
				return;
			}

			if (inputMode === 'ai' && tabId && currentActiveTabId && tabId !== currentActiveTabId) {
				return;
			}

			lastRealtimeActivityAtRef.current = Date.now();
			loadedLogsTargetKeyRef.current = getLogsTargetKey(
				currentActiveId,
				inputMode === 'ai' ? currentActiveTabId : null
			);
			setSessionLogs((prev) => {
				const logKey = inputMode === 'terminal' ? 'shellLogs' : 'aiLogs';
				const existingLogs = prev[logKey];
				const existingIndex = logEntry.id
					? existingLogs.findIndex((entry) => entry.id === logEntry.id)
					: -1;

				if (existingIndex >= 0) {
					const updatedLogs = [...existingLogs];
					updatedLogs[existingIndex] = {
						...updatedLogs[existingIndex],
						...logEntry,
					};
					return { ...prev, [logKey]: updatedLogs };
				}

				return { ...prev, [logKey]: [...existingLogs, logEntry] };
			});
		},
		[]
	);

	// WebSocket handlers for session updates
	const sessionsHandlers = useMemo(
		(): MobileSessionHandlers => ({
			onConnectionChange: (newState: WebSocketState) => {
				webLogger.debug(`Connection state: ${newState}`, 'Mobile');
				if (isOffline) {
					return;
				}
				if (newState === 'connected' || newState === 'authenticated') {
					void refreshSessionsList(activeSessionIdRef.current || undefined, activeTabIdRef.current);
					if (activeSessionIdRef.current) {
						void fetchSessionLogs(activeSessionIdRef.current, activeTabIdRef.current, {
							background:
								loadedLogsTargetKeyRef.current ===
								getLogsTargetKey(activeSessionIdRef.current, activeTabIdRef.current),
						});
					}
				}
			},
			onError: (err: string) => {
				webLogger.error(`WebSocket error: ${err}`, 'Mobile');
			},
			onSessionsUpdate: (newSessions: Session[]) => {
				applySessionsSnapshot(newSessions);
			},
			onSessionStateChange: (
				sessionId: string,
				state: string,
				additionalData?: Partial<Session>
			) => {
				// Check if this is a busy -> idle transition (AI response completed)
				const previousState = previousSessionStatesRef.current.get(sessionId);
				const isResponseComplete = previousState === 'busy' && state === 'idle';

				// Update the previous state
				previousSessionStatesRef.current.set(sessionId, state);

				setSessions((prev) => {
					const updatedSessions = prev.map((s) =>
						s.id === sessionId ? { ...s, state, ...additionalData } : s
					);

					// Show notification if response completed and app is backgrounded
					if (isResponseComplete && onResponseComplete) {
						const session = updatedSessions.find((s) => s.id === sessionId);
						if (session) {
							// Get the response from additionalData or the updated session

							const response =
								(additionalData as any)?.lastResponse || (session as any).lastResponse;
							onResponseComplete(session, response);
						}
					}

					return updatedSessions;
				});
			},
			onSessionAdded: (session: Session) => {
				// Track state for new session
				previousSessionStatesRef.current.set(session.id, session.state);
				pendingAddedSessionIdsRef.current.set(session.id, Date.now());
				recentlyRemovedSessionIdsRef.current.delete(session.id);

				setSessions((prev) => {
					if (prev.some((s) => s.id === session.id)) return prev;
					return [...prev, session];
				});

				if (activeSessionIdRef.current === session.id) {
					switchActiveTarget(session.id, session.activeTabId || null, { resetLogs: true });
					if (session.activeTabId) {
						void fetchSessionLogs(session.id, session.activeTabId);
					}
				}
			},
			onSessionRemoved: (sessionId: string) => {
				// Clean up state tracking
				previousSessionStatesRef.current.delete(sessionId);
				pendingMinimumTabCountRef.current.delete(sessionId);
				pendingNewTabIdRef.current.delete(sessionId);
				pendingAddedSessionIdsRef.current.delete(sessionId);
				recentlyRemovedSessionIdsRef.current.set(sessionId, Date.now());

				const fallbackSession =
					activeSessionIdRef.current === sessionId
						? sessionsRef.current.find((session) => session.id !== sessionId) || null
						: null;

				setSessions((prev) => prev.filter((s) => s.id !== sessionId));
				// Update refs synchronously if the removed session was active
				if (activeSessionIdRef.current === sessionId) {
					switchActiveTarget(fallbackSession?.id || null, fallbackSession?.activeTabId || null, {
						resetLogs: true,
					});
					if (!fallbackSession) {
						resetDisplayedLogs();
					}
				}

				window.setTimeout(() => {
					void refreshSessionsList(fallbackSession?.id, fallbackSession?.activeTabId || null);
				}, 0);
			},
			onActiveSessionChanged: (sessionId: string) => {
				// Desktop app switched to a different session - sync with web
				webLogger.debug(`Desktop active session changed: ${sessionId}`, 'Mobile');
				switchActiveTarget(sessionId, null, { resetLogs: true });
				if (!sessionsRef.current.some((session) => session.id === sessionId)) {
					void refreshSessionsList(sessionId);
					return;
				}
			},
			onSessionOutput: (
				sessionId: string,
				data: string,
				source: 'ai' | 'terminal',
				tabId?: string
			) => {
				// Real-time output from AI or terminal - append to session logs
				const currentActiveId = activeSessionIdRef.current;
				const currentActiveTabId = activeTabIdRef.current;
				webLogger.debug(`Session output: ${sessionId} (${source}) ${data.length} chars`, 'Mobile');
				webLogger.debug('Session output detail', 'Mobile', {
					sessionId,
					activeSessionId: currentActiveId,
					tabId: tabId || 'none',
					activeTabId: currentActiveTabId || 'none',
					source,
					dataLen: data?.length || 0,
				});

				// Only update if this is the active session
				if (currentActiveId !== sessionId) {
					webLogger.debug('Skipping output - not active session', 'Mobile', {
						sessionId,
						activeSessionId: currentActiveId,
					});
					return;
				}

				// For AI output with tabId, only update if this is the active tab
				// This prevents output from newly created tabs appearing in the wrong tab's logs
				if (source === 'ai' && tabId && currentActiveTabId && tabId !== currentActiveTabId) {
					webLogger.debug('Skipping output - not active tab', 'Mobile', {
						sessionId,
						outputTabId: tabId,
						activeTabId: currentActiveTabId,
					});
					return;
				}

				lastRealtimeActivityAtRef.current = Date.now();
				loadedLogsTargetKeyRef.current = getLogsTargetKey(currentActiveId, currentActiveTabId);
				setSessionLogs((prev) => {
					const logKey = source === 'ai' ? 'aiLogs' : 'shellLogs';
					const existingLogs = prev[logKey] || [];

					// Check if the last entry is a streaming entry we should append to
					const lastLog = existingLogs[existingLogs.length - 1];
					const isStreamingAppend =
						lastLog && lastLog.source === 'stdout' && Date.now() - lastLog.timestamp < 5000; // Within 5 seconds

					if (isStreamingAppend) {
						// Append to existing entry
						const updatedLogs = [...existingLogs];
						updatedLogs[updatedLogs.length - 1] = {
							...lastLog,
							text: lastLog.text + data,
						};
						webLogger.debug('Appended to existing log entry', 'Mobile', {
							sessionId,
							source,
							newLength: updatedLogs[updatedLogs.length - 1]?.text?.length ?? 0,
						});
						return { ...prev, [logKey]: updatedLogs };
					} else {
						// Create new entry
						const newEntry: LogEntry = {
							id: `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
							timestamp: Date.now(),
							source: 'stdout',
							text: data,
						};
						webLogger.debug('Created new log entry', 'Mobile', {
							sessionId,
							source,
							dataLength: data.length,
						});
						return { ...prev, [logKey]: [...existingLogs, newEntry] };
					}
				});
			},
			onSessionExit: (sessionId: string, exitCode: number) => {
				webLogger.debug(`Session exit: ${sessionId} code=${exitCode}`, 'Mobile');
				// Update session state to idle when process exits
				setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, state: 'idle' } : s)));
			},
			onUserInput: (
				sessionId: string,
				command: string,
				inputMode: 'ai' | 'terminal',
				images?: string[],
				attachments?: WebAttachmentSummary[]
			) => {
				// User input from desktop app - add to session logs so web interface stays in sync
				const currentActiveId = activeSessionIdRef.current;
				webLogger.debug(
					`User input from desktop: ${sessionId} (${inputMode}) ${command.substring(0, 50)}`,
					'Mobile',
					{
						sessionId,
						activeSessionId: currentActiveId,
						inputMode,
						commandLength: command.length,
						isActiveSession: currentActiveId === sessionId,
					}
				);

				// Only add if this is the active session
				if (currentActiveId !== sessionId) {
					webLogger.debug('Skipping user input - not active session', 'Mobile', {
						sessionId,
						activeSessionId: currentActiveId,
					});
					return;
				}

				lastRealtimeActivityAtRef.current = Date.now();
				const userLogEntry: LogEntry = {
					id: `user-desktop-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
					timestamp: Date.now(),
					text: command,
					source: 'user',
					images,
					attachments,
				};
				setSessionLogs((prev) => {
					const logKey = inputMode === 'ai' ? 'aiLogs' : 'shellLogs';
					return { ...prev, [logKey]: [...prev[logKey], userLogEntry] };
				});
			},
			onThemeUpdate: (theme: Theme) => {
				// Sync theme from desktop app by updating the React context
				webLogger.debug(`Theme update received: ${theme.name} (${theme.mode})`, 'Mobile');
				onThemeUpdate?.(theme);
			},
			onCustomCommands: (commands: CustomCommand[]) => {
				// Custom slash commands from desktop app
				webLogger.debug(`Custom commands received: ${commands.length}`, 'Mobile');
				onCustomCommands?.(commands);
			},
			onAutoRunStateChange: (sessionId: string, state: AutoRunState | null) => {
				// AutoRun (batch processing) state from desktop app
				webLogger.debug(
					`AutoRun state change: ${sessionId} - ${state ? `running (${state.completedTasks}/${state.totalTasks})` : 'stopped'}`,
					'Mobile'
				);
				onAutoRunStateChange?.(sessionId, state);
			},
			onTabsChanged: (sessionId: string, aiTabs: AITabData[], newActiveTabId: string) => {
				// Tab state changed on desktop - update session
				webLogger.debug(
					`Tabs changed: ${sessionId} - ${aiTabs.length} tabs, active: ${newActiveTabId}`,
					'Mobile'
				);
				const now = Date.now();
				const pendingMinimum = pendingMinimumTabCountRef.current.get(sessionId);
				const pendingClosedTabs = pendingClosedTabIdsRef.current.get(sessionId);
				const filteredAiTabs = aiTabs.filter((tab) => {
					const closedAt = pendingClosedTabs?.get(tab.id);
					return !closedAt || now - closedAt >= 10000;
				});
				const resolvedActiveTabId = filteredAiTabs.some((tab) => tab.id === newActiveTabId)
					? newActiveTabId
					: filteredAiTabs[filteredAiTabs.length - 1]?.id || '';
				if (pendingMinimum !== undefined && filteredAiTabs.length < pendingMinimum) {
					webLogger.debug(
						`Ignoring stale tabs update for ${sessionId}: received ${filteredAiTabs.length}, waiting for at least ${pendingMinimum}`,
						'Mobile'
					);
					return;
				}
				if (pendingMinimum !== undefined && filteredAiTabs.length >= pendingMinimum) {
					pendingMinimumTabCountRef.current.delete(sessionId);
				}
				if (pendingClosedTabs) {
					const nextPendingClosedTabs = new Map(pendingClosedTabs);
					for (const [closedTabId, closedAt] of nextPendingClosedTabs.entries()) {
						const isExpired = now - closedAt >= 10000;
						const tabIsGone = !filteredAiTabs.some((tab) => tab.id === closedTabId);
						if (isExpired || tabIsGone) {
							nextPendingClosedTabs.delete(closedTabId);
						}
					}
					if (nextPendingClosedTabs.size === 0) {
						pendingClosedTabIdsRef.current.delete(sessionId);
					} else {
						pendingClosedTabIdsRef.current.set(sessionId, nextPendingClosedTabs);
					}
				}
				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? { ...s, aiTabs: filteredAiTabs, activeTabId: resolvedActiveTabId }
							: s
					)
				);
				// Also update activeTabId ref and state if this is the current session
				const currentSessionId = activeSessionIdRef.current;
				if (currentSessionId === sessionId) {
					switchActiveTarget(sessionId, resolvedActiveTabId || null, {
						resetLogs:
							getLogsTargetKey(sessionId, activeTabIdRef.current) !==
							getLogsTargetKey(sessionId, resolvedActiveTabId || null),
					});
				}
			},
			onNewTabResult: (sessionId: string, success: boolean, tabId?: string) => {
				const pendingTabId = pendingNewTabIdRef.current.get(sessionId);
				if (!success || !tabId) {
					pendingMinimumTabCountRef.current.delete(sessionId);
					pendingNewTabIdRef.current.delete(sessionId);
					if (pendingTabId) {
						setSessions((prev) =>
							prev.map((session) => {
								if (session.id !== sessionId) {
									return session;
								}
								const remainingTabs =
									session.aiTabs?.filter((tab) => tab.id !== pendingTabId) || [];
								return {
									...session,
									aiTabs: remainingTabs,
									activeTabId:
										session.activeTabId === pendingTabId
											? remainingTabs[remainingTabs.length - 1]?.id
											: session.activeTabId,
								};
							})
						);
					}
					return;
				}

				pendingNewTabIdRef.current.delete(sessionId);
				setSessions((prev) =>
					prev.map((session) => {
						if (session.id !== sessionId) {
							return session;
						}

						const currentTabs = session.aiTabs || [];
						const replacedTabs = pendingTabId
							? currentTabs.map((tab) => (tab.id === pendingTabId ? { ...tab, id: tabId } : tab))
							: currentTabs;
						const nextTabs = replacedTabs.some((tab) => tab.id === tabId)
							? replacedTabs
							: [
									...replacedTabs,
									{
										id: tabId,
										agentSessionId: null,
										name: null,
										starred: false,
										inputValue: '',
										createdAt: Date.now(),
										state: 'idle' as const,
									},
								];

						return {
							...session,
							aiTabs: nextTabs,
							activeTabId: tabId,
						};
					})
				);

				if (activeSessionIdRef.current === sessionId) {
					switchActiveTarget(sessionId, tabId, { resetLogs: true });
					setSessions((prev) =>
						prev.map((session) =>
							session.id === sessionId ? { ...session, activeTabId: tabId } : session
						)
					);
					void fetchSessionLogs(sessionId, tabId);
				}
			},
			onDeleteSessionResult: (sessionId: string, success: boolean) => {
				if (success) {
					return;
				}

				recentlyRemovedSessionIdsRef.current.delete(sessionId);
				void refreshSessionsList(activeSessionIdRef.current || undefined, activeTabIdRef.current);
			},
			onSessionLogEntry: (
				sessionId: string,
				tabId: string | null,
				inputMode: 'ai' | 'terminal',
				logEntry: LogEntry
			) => {
				upsertSessionLogEntry(sessionId, tabId, inputMode, logEntry);
			},
			onResponseCompleted: (event: ResponseCompletedEvent) => {
				webLogger.debug(`Response completed event received: ${event.eventId}`, 'Mobile');
				onResponseCompletedEvent?.(event);
			},
		}),
		[
			applySessionsSnapshot,
			onResponseComplete,
			onResponseCompletedEvent,
			onThemeUpdate,
			onCustomCommands,
			onAutoRunStateChange,
			upsertSessionLogEntry,
			fetchSessionLogs,
			refreshSessionsList,
			isOffline,
			resetDisplayedLogs,
			switchActiveTarget,
		]
	);

	return {
		// State
		sessions,
		setSessions,
		activeSessionId,
		setActiveSessionId,
		activeTabId,
		setActiveTabId,
		activeSession,
		sessionLogs: displayedSessionLogs,
		isLoadingLogs,
		isSyncingLogs,
		activeSessionIdRef,
		// Handlers
		handleSelectSession,
		handleSelectSessionTab,
		handleSelectTab,
		handleNewTab,
		handleDeleteSession,
		handleCloseTab,
		handleRenameTab,
		handleStarTab,
		handleReorderTab,
		handleToggleBookmark,
		addUserLogEntry,
		sessionsHandlers,
	};
}

export default useMobileSessionManagement;
