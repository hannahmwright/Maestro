/**
 * useSessionRestoration — extracted from App.tsx (Phase 2E)
 *
 * Owns session loading, restoration, migration, and corruption recovery.
 * Reads from Zustand stores directly — no parameters needed.
 *
 * Functions:
 *   - restoreSession: migrates legacy fields, recovers corrupted data, resets runtime state
 *   - fetchGitInfoInBackground: async git info fetch for SSH remote sessions
 *
 * Effects:
 *   - Session & group loading on mount (with React Strict Mode guard)
 *   - Sets initialLoadComplete + sessionsLoaded flags for splash coordination
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Session, SessionState, ToolType, LogEntry } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useConductorStore } from '../../stores/conductorStore';
import { gitService } from '../../services/git';
import { generateId } from '../../utils/ids';
import { AUTO_RUN_FOLDER_NAME } from '../../components/Wizard';
import {
	migrateWorkspacesAndThreads,
	recoverMissingProviderThreads,
} from '../../utils/workspaceThreads';

// ============================================================================
// Return type
// ============================================================================

export interface SessionRestorationReturn {
	/** Proxy ref that bridges .current API to sessionStore boolean */
	initialLoadComplete: React.MutableRefObject<boolean>;
	/** Restore a persisted session (migration + corruption recovery + runtime reset) */
	restoreSession: (session: Session) => Promise<Session>;
	/** Fetch git info in background for SSH remote sessions */
	fetchGitInfoInBackground: (
		sessionId: string,
		cwd: string,
		sshRemoteId: string | undefined
	) => Promise<void>;
}

// ============================================================================
// Hook
// ============================================================================

export function useSessionRestoration(): SessionRestorationReturn {
	// --- Store actions (stable, non-reactive) ---
	// Extract action references once via useMemo so they can be called inside
	// useCallback/useEffect without appearing in dependency arrays. Zustand
	// store actions returned by getState() are stable singletons that never
	// change, so the empty deps array is intentional.
	const { setSessions, setGroups, setThreads, setActiveSessionId, setSessionsLoaded } = useMemo(
		() => useSessionStore.getState(),
		[]
	);
	const { setGroupChats } = useMemo(() => useGroupChatStore.getState(), []);
	const { setConductors, setTasks, setRuns, syncWithGroups } = useMemo(
		() => useConductorStore.getState(),
		[]
	);

	// --- initialLoadComplete proxy ref ---
	// Bridges ref API (.current = true) to store boolean so both ref-style
	// and store-style consumers stay in sync.
	const initialLoadComplete = useMemo(() => {
		const ref = { current: useSessionStore.getState().initialLoadComplete };
		return new Proxy(ref, {
			set(_target, prop, value) {
				if (prop === 'current') {
					ref.current = value;
					useSessionStore.getState().setInitialLoadComplete(value);
					return true;
				}
				return false;
			},
			get(target, prop) {
				if (prop === 'current') {
					return useSessionStore.getState().initialLoadComplete;
				}
				return (target as Record<string | symbol, unknown>)[prop];
			},
		});
	}, []) as React.MutableRefObject<boolean>;

	// --- fetchGitInfoInBackground ---
	const fetchGitInfoInBackground = useCallback(
		async (sessionId: string, cwd: string, sshRemoteId: string | undefined) => {
			try {
				const isGitRepo = await gitService.isRepo(cwd, sshRemoteId);

				let gitBranches: string[] | undefined;
				let gitTags: string[] | undefined;
				let gitRefsCacheTime: number | undefined;
				if (isGitRepo) {
					[gitBranches, gitTags] = await Promise.all([
						gitService.getBranches(cwd, sshRemoteId),
						gitService.getTags(cwd, sshRemoteId),
					]);
					gitRefsCacheTime = Date.now();
				}

				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? {
									...s,
									isGitRepo,
									gitBranches,
									gitTags,
									gitRefsCacheTime,
									sshConnectionFailed: false,
								}
							: s
					)
				);
			} catch (error) {
				console.warn(
					`[fetchGitInfoInBackground] Failed to fetch git info for session ${sessionId}:`,
					error
				);
				setSessions((prev) =>
					prev.map((s) => (s.id === sessionId ? { ...s, sshConnectionFailed: true } : s))
				);
			}
		},
		[]
	);

	// --- restoreSession ---
	const restoreSession = useCallback(async (session: Session): Promise<Session> => {
		try {
			// Migration: ensure projectRoot is set (for sessions created before this field was added)
			if (!session.projectRoot) {
				session = { ...session, projectRoot: session.cwd };
			}

			// Migration: default autoRunFolderPath for sessions that don't have one
			if (!session.autoRunFolderPath && session.projectRoot) {
				session = {
					...session,
					autoRunFolderPath: `${session.projectRoot}/${AUTO_RUN_FOLDER_NAME}`,
				};
			}

			// Migration: ensure fileTreeAutoRefreshInterval is set (default 180s for legacy sessions)
			if (session.fileTreeAutoRefreshInterval == null) {
				console.warn(
					`[restoreSession] Session missing fileTreeAutoRefreshInterval, defaulting to 180s`
				);
				session = { ...session, fileTreeAutoRefreshInterval: 180 };
			}

			// Sessions must have aiTabs - if missing, this is a data corruption issue
			// Create a default tab to prevent crashes when code calls .find() on aiTabs
			if (!session.aiTabs || session.aiTabs.length === 0) {
				console.error(
					'[restoreSession] Session has no aiTabs - data corruption, creating default tab:',
					session.id
				);
				const defaultTabId = generateId();
				return {
					...session,
					aiPid: -1,
					terminalPid: 0,
					state: 'error' as SessionState,
					isLive: false,
					liveUrl: undefined,
					aiTabs: [
						{
							id: defaultTabId,
							agentSessionId: null,
							name: null,
							state: 'idle' as const,
							logs: [
								{
									id: generateId(),
									timestamp: Date.now(),
									source: 'system' as const,
									text: '⚠️ Session data was corrupted and has been recovered with a new tab.',
								},
							],
							starred: false,
							inputValue: '',
							stagedImages: [],
							createdAt: Date.now(),
						},
					],
					activeTabId: defaultTabId,
					filePreviewTabs: [],
					activeFileTabId: null,
					unifiedTabOrder: [{ type: 'ai' as const, id: defaultTabId }],
					unifiedClosedTabHistory: [],
				};
			}

			// Fix inconsistency: activeFileTabId should only be set in AI mode.
			// If inputMode is 'terminal' but a file tab is still active, clear it to prevent
			// rendering a file preview without a tab bar (orphaned file preview bug).
			if (session.inputMode !== 'ai' && session.activeFileTabId) {
				console.warn(
					`[restoreSession] Session has activeFileTabId='${session.activeFileTabId}' but inputMode='${session.inputMode}' — clearing orphaned file tab reference`
				);
				session = { ...session, activeFileTabId: null };
			}

			// Detect and fix inputMode/toolType mismatch
			let correctedSession = { ...session };
			let aiAgentType = correctedSession.toolType;

			// If toolType is 'terminal', migrate to claude-code
			if (aiAgentType === 'terminal') {
				console.warn(`[restoreSession] Session has toolType='terminal', migrating to claude-code`);
				aiAgentType = 'claude-code' as ToolType;
				correctedSession = {
					...correctedSession,
					toolType: 'claude-code' as ToolType,
				};

				const warningLog: LogEntry = {
					id: generateId(),
					timestamp: Date.now(),
					source: 'system',
					text: '⚠️ Session migrated to use Claude Code agent.',
				};
				const activeTabIndex = correctedSession.aiTabs.findIndex(
					(tab) => tab.id === correctedSession.activeTabId
				);
				if (activeTabIndex >= 0) {
					correctedSession.aiTabs = correctedSession.aiTabs.map((tab, i) =>
						i === activeTabIndex ? { ...tab, logs: [...tab.logs, warningLog] } : tab
					);
				}
			}

			// Get agent definitions for both processes
			const agent = await window.maestro.agents.get(aiAgentType);
			if (!agent) {
				console.error(`Agent not found for toolType: ${correctedSession.toolType}`);
				return {
					...correctedSession,
					aiPid: -1,
					terminalPid: 0,
					state: 'error' as SessionState,
					isLive: false,
					liveUrl: undefined,
				};
			}

			// Deferred spawn: AI processes are NOT started during session restore.
			// - Batch mode agents spawn per message in useInputProcessing
			// - Terminal uses runCommand (fresh shells per command)
			// aiPid stays at 0 until the user sends their first message.

			// Get SSH remote ID for remote git operations
			const sshRemoteId =
				correctedSession.sshRemoteId ||
				(correctedSession.sessionSshRemoteConfig?.enabled
					? correctedSession.sessionSshRemoteConfig.remoteId
					: undefined) ||
				undefined;

			const isRemoteSession = !!sshRemoteId;

			// For local sessions, check git status synchronously (fast, sub-100ms)
			// For remote sessions, use persisted value or default, then update in background
			let isGitRepo = correctedSession.isGitRepo ?? false;
			let gitBranches = correctedSession.gitBranches;
			let gitTags = correctedSession.gitTags;
			let gitRefsCacheTime = correctedSession.gitRefsCacheTime;

			if (!isRemoteSession) {
				isGitRepo = await gitService.isRepo(correctedSession.cwd, undefined);
				if (isGitRepo) {
					[gitBranches, gitTags] = await Promise.all([
						gitService.getBranches(correctedSession.cwd, undefined),
						gitService.getTags(correctedSession.cwd, undefined),
					]);
					gitRefsCacheTime = Date.now();
				}
			}

			// Reset all tab states to idle - processes don't survive app restart
			const resetAiTabs = correctedSession.aiTabs.map((tab) => ({
				...tab,
				state: 'idle' as const,
				thinkingStartTime: undefined,
				awaitingSessionId: false,
				pendingUserInputRequest: null,
				activeTurnId: null,
				pendingSteer: null,
				steerStatus: 'idle' as const,
				lastCheckpointAt: null,
			}));

			return {
				...correctedSession,
				aiPid: 0,
				terminalPid: 0,
				state: 'idle' as SessionState,
				busySource: undefined,
				thinkingStartTime: undefined,
				currentCycleTokens: undefined,
				currentCycleBytes: undefined,
				statusMessage: undefined,
				isGitRepo,
				gitBranches,
				gitTags,
				gitRefsCacheTime,
				isLive: false,
				liveUrl: undefined,
				aiLogs: [],
				aiTabs: resetAiTabs,
				shellLogs: correctedSession.shellLogs,
				executionQueue: correctedSession.executionQueue || [],
				activeTimeMs: correctedSession.activeTimeMs || 0,
				agentError: undefined,
				agentErrorPaused: false,
				closedTabHistory: [],
				filePreviewTabs: correctedSession.filePreviewTabs || [],
				activeFileTabId: correctedSession.activeFileTabId ?? null,
				unifiedTabOrder: correctedSession.unifiedTabOrder || [
					...resetAiTabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
					...(correctedSession.filePreviewTabs || []).map((tab) => ({
						type: 'file' as const,
						id: tab.id,
					})),
				],
			};
		} catch (error) {
			console.error(`Error restoring session ${session.id}:`, error);
			return {
				...session,
				aiPid: -1,
				terminalPid: 0,
				state: 'error' as SessionState,
				isLive: false,
				liveUrl: undefined,
			};
		}
	}, []);

	// --- Session & group loading effect ---
	// Use a ref to prevent duplicate execution in React Strict Mode
	const sessionLoadStarted = useRef(false);
	useEffect(() => {
		if (sessionLoadStarted.current) {
			return;
		}
		sessionLoadStarted.current = true;

		const loadSessionsAndGroups = async () => {
			try {
				const savedSessions = await window.maestro.sessions.getAll();
				const savedGroups = await window.maestro.groups.getAll();
				const savedThreads = await window.maestro.threads.getAll();
				const savedConductors = window.maestro.conductors
					? await window.maestro.conductors.getAll()
					: { conductors: [], tasks: [], runs: [] };

				let restoredSessions: Session[] = [];
				let nextGroups = savedGroups || [];
				let nextThreads = savedThreads || [];

				// Handle sessions
				if (savedSessions && savedSessions.length > 0) {
					restoredSessions = await Promise.all(savedSessions.map((s) => restoreSession(s)));

					const needsWorkspaceThreadMigration =
						!Array.isArray(savedThreads) ||
						savedThreads.length === 0 ||
						restoredSessions.some(
							(session) =>
								(!session.parentSessionId && (!session.threadId || !session.workspaceId)) ||
								!session.groupId
						) ||
						(savedGroups || []).some((group: { projectRoot?: string }) => !group.projectRoot);

					if (needsWorkspaceThreadMigration) {
						const migration = migrateWorkspacesAndThreads(
							restoredSessions,
							savedGroups || [],
							useSessionStore.getState().activeSessionId
						);
						restoredSessions = migration.sessions;
						nextGroups = migration.groups;
						nextThreads = migration.threads;
					} else {
						const threadIdBySessionId = new Map(
							(savedThreads || []).map((thread: { sessionId: string; id: string }) => [
								thread.sessionId,
								thread.id,
							])
						);
						nextThreads = (savedThreads || []).map((thread) => ({
							...thread,
							runtimeId: thread.runtimeId || thread.sessionId,
						}));
						restoredSessions = restoredSessions.map((session) => ({
							...session,
							runtimeId: session.runtimeId || session.id,
							workspaceId: session.workspaceId || session.groupId,
							threadId:
								session.threadId ||
								(!session.parentSessionId ? threadIdBySessionId.get(session.id) : undefined),
						}));
					}
				}

				const recovery = await recoverMissingProviderThreads(
					restoredSessions,
					nextGroups,
					nextThreads
				);
				restoredSessions = recovery.sessions;
				nextGroups = recovery.groups;
				nextThreads = recovery.threads;

				if (recovery.recoveredCount > 0) {
					window.maestro.sessions.setAll(restoredSessions);
					window.maestro.groups.setAll(nextGroups);
					window.maestro.threads.setAll(nextThreads);
				}

				setSessions(restoredSessions);
				setGroups(nextGroups);
				setThreads(nextThreads);

				const activeSessionId = useSessionStore.getState().activeSessionId;
				if (
					restoredSessions.length > 0 &&
					!restoredSessions.find((s) => s.id === activeSessionId)
				) {
					setActiveSessionId(restoredSessions[0].id);
				}

				for (const session of restoredSessions) {
					const sshRemoteId =
						session.sshRemoteId ||
						(session.sessionSshRemoteConfig?.enabled
							? session.sessionSshRemoteConfig.remoteId
							: undefined);
					if (sshRemoteId) {
						fetchGitInfoInBackground(session.id, session.cwd, sshRemoteId);
					}
				}

				setConductors(savedConductors?.conductors || []);
				setTasks(savedConductors?.tasks || []);
				setRuns(savedConductors?.runs || []);
				syncWithGroups(useSessionStore.getState().groups || []);

				// Load group chats
				try {
					const savedGroupChats = await window.maestro.groupChat.list();
					setGroupChats(savedGroupChats || []);
				} catch (gcError) {
					console.error('Failed to load group chats:', gcError);
					setGroupChats([]);
				}
			} catch (e) {
				console.error('Failed to load sessions/groups:', e);
				setSessions([]);
				setGroups([]);
				setThreads([]);
				setConductors([]);
				setTasks([]);
				setRuns([]);
				syncWithGroups([]);
			} finally {
				// Mark initial load as complete to enable persistence
				initialLoadComplete.current = true;

				// Mark sessions as loaded for splash screen coordination
				setSessionsLoaded(true);
			}
		};
		loadSessionsAndGroups();
	}, []);

	return {
		initialLoadComplete,
		restoreSession,
		fetchGitInfoInBackground,
	};
}
