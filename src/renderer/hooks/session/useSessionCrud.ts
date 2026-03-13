/**
 * useSessionCrud — extracted from App.tsx
 *
 * Handles session create/read/update/delete operations:
 *   - addNewSession (opens modal)
 *   - createNewSession (core creation logic)
 *   - deleteSession (opens confirmation modal)
 *   - deleteWorktreeGroup (removes group + all agents)
 *   - startRenamingSession / finishRenamingSession
 *   - toggleBookmark
 *   - handleDragStart / handleDragOver
 *   - handleCreateGroupAndMove / handleGroupCreated
 *
 * Reads from: sessionStore, settingsStore, uiStore, modalStore
 */

import { useCallback, useState } from 'react';
import type { ToolType, Session, AITab } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { getModalActions } from '../../stores/modalStore';
import { notifyToast } from '../../stores/notificationStore';
import { generateId } from '../../utils/ids';
import { validateNewSession } from '../../utils/sessionValidation';
import { gitService } from '../../services/git';
import { AUTO_RUN_FOLDER_NAME } from '../../components/Wizard';
import { getWorkspaceDisplayName } from '../../utils/workspaceThreads';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseSessionCrudDeps {
	/** Flush session persistence immediately (from useDebouncedPersistence) */
	flushSessionPersistence: () => void;
	/** Track removed worktree paths to prevent re-discovery */
	setRemovedWorktreePaths: React.Dispatch<React.SetStateAction<Set<string>>>;
	/** Show confirmation dialog before destructive operations (from useSessionLifecycle) */
	showConfirmation: (message: string, onConfirm: () => void) => void;
	/** Ref to main input element (for auto-focus after session creation) */
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	/** Open the create-group modal (from group modal state) */
	setCreateGroupModalOpen: (open: boolean) => void;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseSessionCrudReturn {
	/** Opens the new instance modal */
	addNewSession: () => void;
	/** Core session creation logic */
		createNewSession: (
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
	/** Opens the delete agent confirmation modal */
	deleteSession: (id: string) => void;
	/** Deletes entire worktree group and all its agents */
	deleteWorktreeGroup: (groupId: string) => void;
	/** Opens rename UI for a session */
	startRenamingSession: (editKey: string) => void;
	/** Completes session rename */
	finishRenamingSession: (sessId: string, newName: string) => void;
	/** Toggles bookmarked state on a session */
	toggleBookmark: (sessionId: string) => void;
	/** Initiates drag for a session */
	handleDragStart: (sessionId: string) => void;
	/** Allows drop */
	handleDragOver: (e: React.DragEvent) => void;
	/** Opens create group modal with pending session to move */
	handleCreateGroupAndMove: (sessionId: string) => void;
	/** Callback when a group is created — moves pending session to it */
	handleGroupCreated: (groupId: string) => void;
	/** The session ID pending move to a newly created group */
	pendingMoveToGroupSessionId: string | null;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useSessionCrud(deps: UseSessionCrudDeps): UseSessionCrudReturn {
	const {
		flushSessionPersistence,
		setRemovedWorktreePaths,
		showConfirmation,
		inputRef,
		setCreateGroupModalOpen,
	} = deps;

	// --- Store actions (stable via getState) ---
	const { setSessions, setActiveSessionId, setGroups, setThreads } = useSessionStore.getState();
	const { setEditingSessionId, setDraggingSessionId, setActiveFocus } = useUIStore.getState();
	const { setNewInstanceModalOpen, setDeleteAgentSession } = getModalActions();

	// --- Local state ---
	const [pendingMoveToGroupSessionId, setPendingMoveToGroupSessionId] = useState<string | null>(
		null
	);

	// ========================================================================
	// addNewSession — opens the new instance modal
	// ========================================================================
	const addNewSession = useCallback(() => {
		setNewInstanceModalOpen(true);
	}, [setNewInstanceModalOpen]);

	// ========================================================================
	// createNewSession — core session creation logic
	// ========================================================================
	const createNewSession = useCallback(
		async (
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
		) => {
			try {
				// Get agent definition to get correct command
				const agent = await (window as any).maestro.agents.get(agentId);
				if (!agent) {
					console.error(`Agent not found: ${agentId}`);
					return;
				}
				const currentSessions = useSessionStore.getState().sessions;
				const validation = validateNewSession(
					name,
					workingDir,
					agentId as ToolType,
					currentSessions
				);
				if (!validation.valid) {
					console.error(`Session validation failed: ${validation.error}`);
					notifyToast({
						type: 'error',
						title: 'Thread Creation Failed',
						message: validation.error || 'Cannot create duplicate thread',
					});
					return;
				}

				const newId = generateId();
				const aiPid = 0;

				// For SSH sessions, defer git check until onSshRemote fires
				const isRemoteSession = sessionSshRemoteConfig?.enabled && sessionSshRemoteConfig.remoteId;
				let isGitRepo = false;
				let gitBranches: string[] | undefined;
				let gitTags: string[] | undefined;
				let gitRefsCacheTime: number | undefined;

				if (!isRemoteSession) {
					isGitRepo = await gitService.isRepo(workingDir);
					if (isGitRepo) {
						[gitBranches, gitTags] = await Promise.all([
							gitService.getBranches(workingDir),
							gitService.getTags(workingDir),
						]);
						gitRefsCacheTime = Date.now();
					}
				}

				const currentDefaults = useSettingsStore.getState();
				const normalizedWorkingDir = workingDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
				const existingWorkspace = useSessionStore
					.getState()
					.groups.find(
						(group) =>
							group.id === workspaceId ||
							(group.projectRoot || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
								normalizedWorkingDir
					);
				const resolvedWorkspace =
					existingWorkspace ||
					({
						id: workspaceId || `workspace-${generateId()}`,
						name: getWorkspaceDisplayName(workingDir),
						emoji: '📁',
						collapsed: false,
						projectRoot: workingDir,
						lastUsedAt: Date.now(),
					} as const);
				const initialTabId = generateId();
				const threadId = `thread-${generateId()}`;
				const initialTab: AITab = {
					id: initialTabId,
					agentSessionId: null,
					name: null,
					starred: false,
					logs: [],
					inputValue: '',
					stagedImages: [],
					createdAt: Date.now(),
					state: 'idle',
					saveToHistory: currentDefaults.defaultSaveToHistory,
					showThinking: currentDefaults.defaultShowThinking,
				};

				const newSession: Session = {
					id: newId,
					runtimeId: newId,
					groupId: resolvedWorkspace.id,
					workspaceId: resolvedWorkspace.id,
					threadId,
					name,
					toolType: agentId as ToolType,
					state: 'idle',
					cwd: workingDir,
					fullPath: workingDir,
					projectRoot: workingDir,
					isGitRepo,
					gitBranches,
					gitTags,
					gitRefsCacheTime,
					aiLogs: [],
					shellLogs: [
						{
							id: generateId(),
							timestamp: Date.now(),
							source: 'system',
							text: 'Shell Session Ready.',
						},
					],
					workLog: [],
					contextUsage: 0,
					inputMode: agentId === 'terminal' ? 'terminal' : 'ai',
					aiPid,
					terminalPid: 0,
					port: 3000 + Math.floor(Math.random() * 100),
					isLive: false,
					changedFiles: [],
					fileTree: [],
					fileExplorerExpanded: [],
					fileExplorerScrollPos: 0,
					fileTreeAutoRefreshInterval: 180,
					shellCwd: workingDir,
					aiCommandHistory: [],
					shellCommandHistory: [],
					executionQueue: [],
					activeTimeMs: 0,
					aiTabs: [initialTab],
					activeTabId: initialTabId,
					closedTabHistory: [],
					filePreviewTabs: [],
					activeFileTabId: null,
					unifiedTabOrder: [{ type: 'ai' as const, id: initialTabId }],
					unifiedClosedTabHistory: [],
					nudgeMessage,
					customPath,
					customArgs,
					customEnvVars,
					customModel,
					customContextWindow,
					customProviderPath,
					sessionSshRemoteConfig,
					autoRunFolderPath: `${workingDir}/${AUTO_RUN_FOLDER_NAME}`,
				};
				const newThread = {
					id: threadId,
					workspaceId: resolvedWorkspace.id,
					sessionId: newId,
					runtimeId: newId,
					title: name,
					agentId: agentId as ToolType,
					projectRoot: workingDir,
					pinned: false,
					archived: false,
					isOpen: true,
					createdAt: Date.now(),
					lastUsedAt: Date.now(),
				};

				setGroups((prev) => {
					if (prev.some((group) => group.id === resolvedWorkspace.id)) {
						return prev.map((group) =>
							group.id === resolvedWorkspace.id
								? { ...group, projectRoot: workingDir, lastUsedAt: Date.now() }
								: group
						);
					}
					return [...prev, resolvedWorkspace];
				});
				setSessions((prev) => [...prev, newSession]);
				setThreads((prev) => [...prev, newThread]);
				setActiveSessionId(newId);
				const webInitialTab = {
					id: initialTab.id,
					agentSessionId: initialTab.agentSessionId || null,
					name: initialTab.name || null,
					starred: initialTab.starred || false,
					hasUnread: !!initialTab.hasUnread,
					inputValue: initialTab.inputValue || '',
					usageStats: initialTab.usageStats || null,
					createdAt: initialTab.createdAt,
					state: initialTab.state || 'idle',
					thinkingStartTime: initialTab.thinkingStartTime || null,
					currentModel: initialTab.currentModel || null,
					runtimeKind: initialTab.runtimeKind || 'batch',
					steerMode: initialTab.steerMode || 'none',
					activeTurnId: initialTab.activeTurnId || null,
					pendingSteer: initialTab.pendingSteer || null,
					steerStatus: initialTab.steerStatus || 'idle',
					lastCheckpointAt: initialTab.lastCheckpointAt || null,
				};
				void window.maestro.web?.broadcastSessionAdded?.({
					id: newSession.id,
					name: newSession.name,
					toolType: newSession.toolType,
					state: newSession.state,
					inputMode: newSession.inputMode,
					cwd: newSession.cwd,
					groupId: newSession.groupId || null,
					groupName: null,
					groupEmoji: null,
					effectiveContextWindow:
						typeof newSession.customContextWindow === 'number' && newSession.customContextWindow > 0
							? newSession.customContextWindow
							: null,
					aiTabs: [webInitialTab],
					activeTabId: initialTabId,
					isGitRepo: newSession.isGitRepo,
					parentSessionId: newSession.parentSessionId || null,
					worktreeBranch: newSession.worktreeBranch || null,
				});
				void window.maestro.live?.broadcastActiveSession?.(newId);
				setTimeout(() => flushSessionPersistence(), 0);
				(window as any).maestro.stats.recordSessionCreated({
					sessionId: newId,
					agentType: agentId,
					projectPath: workingDir,
					createdAt: Date.now(),
					isRemote: !!isRemoteSession,
				});

				setActiveFocus('main');
				setTimeout(() => inputRef.current?.focus(), 50);
			} catch (error) {
				console.error('Failed to create session:', error);
			}
		},
		[setSessions, setActiveSessionId, setGroups, setThreads, setActiveFocus, inputRef]
	);

	// ========================================================================
	// deleteSession — opens the delete agent confirmation modal
	// ========================================================================
	const deleteSession = useCallback(
		(id: string) => {
			const session = useSessionStore.getState().sessions.find((s) => s.id === id);
			if (!session) return;
			setDeleteAgentSession(session);
		},
		[setDeleteAgentSession]
	);

	// ========================================================================
	// deleteWorktreeGroup — removes group + all agents
	// ========================================================================
	const deleteWorktreeGroup = useCallback(
		(groupId: string) => {
			const currentGroups = useSessionStore.getState().groups;
			const currentSessions = useSessionStore.getState().sessions;
			const group = currentGroups.find((g) => g.id === groupId);
			if (!group) return;

			const groupSessions = currentSessions.filter((s) => s.groupId === groupId);
			const sessionCount = groupSessions.length;

			showConfirmation(
				`Are you sure you want to remove the workspace "${group.name}" and all ${sessionCount} agent${
					sessionCount !== 1 ? 's' : ''
				} in it? This action cannot be undone.`,
				async () => {
					for (const session of groupSessions) {
						try {
							await (window as any).maestro.process.kill(`${session.id}-ai`);
						} catch (error) {
							console.error('Failed to kill AI process:', error);
						}
						try {
							await (window as any).maestro.process.kill(`${session.id}-terminal`);
						} catch (error) {
							console.error('Failed to kill terminal process:', error);
						}
						try {
							await (window as any).maestro.playbooks.deleteAll(session.id);
						} catch (error) {
							console.error('Failed to delete playbooks:', error);
						}
					}

					const pathsToTrack = groupSessions
						.filter((s) => s.worktreeParentPath && s.cwd)
						.map((s) => s.cwd);

					if (pathsToTrack.length > 0) {
						setRemovedWorktreePaths((prev) => new Set([...prev, ...pathsToTrack]));
					}

					const sessionIdsToRemove = new Set(groupSessions.map((s) => s.id));
					const latestSessions = useSessionStore.getState().sessions;
					const newSessions = latestSessions.filter((s) => !sessionIdsToRemove.has(s.id));
					setThreads((prev) => prev.filter((thread) => thread.workspaceId !== groupId));
					setSessions(newSessions);
					setGroups((prev) => prev.filter((g) => g.id !== groupId));

					setTimeout(() => flushSessionPersistence(), 0);

					const latestActiveId = useSessionStore.getState().activeSessionId;
					if (sessionIdsToRemove.has(latestActiveId) && newSessions.length > 0) {
						setActiveSessionId(newSessions[0].id);
					} else if (newSessions.length === 0) {
						setActiveSessionId('');
					}

					notifyToast({
						type: 'success',
						title: 'Workspace Removed',
						message: `Removed "${group.name}" and ${sessionCount} agent${
							sessionCount !== 1 ? 's' : ''
						}`,
					});
				}
			);
		},
		[
			showConfirmation,
			setSessions,
			setGroups,
			setThreads,
			setActiveSessionId,
			setRemovedWorktreePaths,
			flushSessionPersistence,
		]
	);

	// ========================================================================
	// startRenamingSession / finishRenamingSession
	// ========================================================================
	const startRenamingSession = useCallback(
		(editKey: string) => {
			setEditingSessionId(editKey);
		},
		[setEditingSessionId]
	);

	const finishRenamingSession = useCallback(
		(sessId: string, newName: string) => {
			const trimmedName = newName.trim();
			if (!trimmedName) {
				setEditingSessionId(null);
				return;
			}
			const currentThreadId = useSessionStore
				.getState()
				.sessions.find((session) => session.id === sessId)?.threadId;
			if (currentThreadId) {
				setThreads((prev) =>
					prev.map((thread) =>
						thread.id === currentThreadId ? { ...thread, title: trimmedName } : thread
					)
				);
			}
			setSessions((prev) => {
				const updated = prev.map((s) => (s.id === sessId ? { ...s, name: trimmedName } : s));
				const session = updated.find((s) => s.id === sessId);
				// Derive provider session ID: prefer session-level (legacy), fall back to active/first aiTab
				const providerSessionId =
					session?.agentSessionId ||
					session?.aiTabs?.find((t) => t.id === session.activeTabId)?.agentSessionId ||
					session?.aiTabs?.[0]?.agentSessionId;
				if (providerSessionId && session?.projectRoot) {
					const agentId = session.toolType || 'claude-code';
					if (agentId === 'claude-code') {
						(window as any).maestro.claude
							.updateSessionName(session.projectRoot, providerSessionId, trimmedName)
							.catch((err: Error) =>
								console.warn('[finishRenamingSession] Failed to sync session name:', err)
							);
					} else {
						(window as any).maestro.agentSessions
							.setSessionName(agentId, session.projectRoot, providerSessionId, trimmedName)
							.catch((err: Error) =>
								console.warn('[finishRenamingSession] Failed to sync session name:', err)
							);
					}
				}
				return updated;
			});
			setEditingSessionId(null);
		},
		[setSessions, setThreads, setEditingSessionId]
	);

	// ========================================================================
	// toggleBookmark
	// ========================================================================
	const toggleBookmark = useCallback((sessionId: string) => {
		useSessionStore
			.getState()
			.setSessions((prev) =>
				prev.map((s) => (s.id === sessionId ? { ...s, bookmarked: !s.bookmarked } : s))
			);
	}, []);

	// ========================================================================
	// Drag and drop handlers
	// ========================================================================
	const handleDragStart = useCallback(
		(sessionId: string) => {
			setDraggingSessionId(sessionId);
		},
		[setDraggingSessionId]
	);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
	}, []);

	// ========================================================================
	// Group + move handlers
	// ========================================================================
	const handleCreateGroupAndMove = useCallback(
		(sessionId: string) => {
			setPendingMoveToGroupSessionId(sessionId);
			setCreateGroupModalOpen(true);
		},
		[setCreateGroupModalOpen]
	);

	const handleGroupCreated = useCallback(
		(groupId: string) => {
			if (pendingMoveToGroupSessionId) {
				setSessions((prev) =>
					prev.map((s) => (s.id === pendingMoveToGroupSessionId ? { ...s, groupId } : s))
				);
				setPendingMoveToGroupSessionId(null);
			}
		},
		[pendingMoveToGroupSessionId, setSessions]
	);

	return {
		addNewSession,
		createNewSession,
		deleteSession,
		deleteWorktreeGroup,
		startRenamingSession,
		finishRenamingSession,
		toggleBookmark,
		handleDragStart,
		handleDragOver,
		handleCreateGroupAndMove,
		handleGroupCreated,
		pendingMoveToGroupSessionId,
	};
}
