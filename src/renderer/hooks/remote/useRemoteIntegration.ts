import { useEffect, useRef } from 'react';
import type { Session, ThinkingMode } from '../../types';
import { createTab, closeTab } from '../../utils/tabHelpers';
import { buildDefaultThreadName } from '../../utils/sessionValidation';
import { useSessionStore } from '../../stores/sessionStore';
import { useConductorStore } from '../../stores/conductorStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { buildConductorBoardTaskStatusPatch } from '../../services/conductorBoardControls';
import { WEB_APP_BASE_PATH, type ResponseCompletedEvent } from '../../../shared/remote-web';
import type { DemoCaptureRequest } from '../../../shared/demo-artifacts';

function buildResponseCompletedEvent(session: Session): ResponseCompletedEvent | null {
	const activeTab =
		session.aiTabs?.find((tab) => tab.id === session.activeTabId) || session.aiTabs?.[0];
	if (!activeTab) return null;

	const lastAiLog = [...activeTab.logs]
		.reverse()
		.find((log) => log.source === 'stdout' || log.source === 'stderr' || log.source === 'ai');
	if (!lastAiLog?.text) return null;

	const lines = lastAiLog.text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('```') && line !== '---');
	const body = (lines[0] || 'AI response completed').slice(0, 140);
	const deepLinkUrl = `${WEB_APP_BASE_PATH}/session/${encodeURIComponent(session.id)}${
		activeTab.id ? `?tabId=${encodeURIComponent(activeTab.id)}` : ''
	}`;
	const completedAt = lastAiLog.timestamp || Date.now();

	return {
		eventId: `response:${session.id}:${activeTab.id}:${completedAt}`,
		sessionId: session.id,
		tabId: activeTab.id,
		sessionName: session.name,
		toolType: session.toolType,
		completedAt,
		title: `${session.name} - Response Ready`,
		body,
		deepLinkUrl,
	};
}

/**
 * Dependencies for the useRemoteIntegration hook.
 * Uses refs for values that change frequently to avoid re-attaching listeners.
 */
export interface UseRemoteIntegrationDeps {
	/** Current active session ID */
	activeSessionId: string;
	/** Whether live mode is enabled (web interface) */
	isLiveMode: boolean;
	/** Ref to current sessions array (avoids stale closures) */
	sessionsRef: React.MutableRefObject<Session[]>;
	/** Ref to current active session ID (avoids stale closures) */
	activeSessionIdRef: React.MutableRefObject<string>;
	/** Session state setter */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	/** Active session ID setter */
	setActiveSessionId: (id: string) => void;
	/** Default value for saveToHistory on new tabs */
	defaultSaveToHistory: boolean;
	/** Default value for showThinking on new tabs */
	defaultShowThinking: ThinkingMode;
	/** Delete an agent/session using the shared desktop lifecycle */
	performDeleteSession: (session: Session, eraseWorkingDirectory: boolean) => Promise<void>;
	/** Create a new thread/session using the shared desktop creation flow */
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
	/** Shared interrupt handler ref so web interrupts use the same queue-aware path */
	interruptCurrentTurnRef: React.MutableRefObject<((sessionId?: string) => Promise<void>) | null>;
}

/**
 * Return type for useRemoteIntegration hook.
 * Currently empty as all functionality is side effects.
 */
export interface UseRemoteIntegrationReturn {
	// No return values - all functionality is via side effects
}

/**
 * Hook for handling web interface communication.
 *
 * Sets up listeners for remote commands from the web interface:
 * - Active session broadcast to web clients
 * - Remote command listener (dispatches event for App.tsx to handle)
 * - Remote mode switching
 * - Remote interrupt handling
 * - Remote session/tab selection
 * - Remote tab creation and closing
 * - Tab change broadcasting to web clients
 *
 * All effects have explicit cleanup functions to prevent memory leaks.
 *
 * @param deps - Hook dependencies
 * @returns Empty object (all functionality via side effects)
 */
export function useRemoteIntegration(deps: UseRemoteIntegrationDeps): UseRemoteIntegrationReturn {
	const {
		activeSessionId,
		isLiveMode,
		sessionsRef,
		activeSessionIdRef,
		setSessions,
		setActiveSessionId,
		defaultSaveToHistory,
		defaultShowThinking,
		performDeleteSession,
		createNewSession,
		interruptCurrentTurnRef,
	} = deps;
	const groups = useSessionStore((s) => s.groups);
	const pendingConductorWorkspaceOpenRef = useRef<string | null>(null);

	const openConductorWorkspace = (groupId: string): boolean => {
		const nextView = {
			scope: 'workspace' as const,
			groupId,
		};
		useGroupChatStore.getState().setActiveGroupChatId(null);
		const availableGroups = useSessionStore.getState().groups;
		if (!availableGroups.some((group) => group.id === groupId)) {
			pendingConductorWorkspaceOpenRef.current = groupId;
			return false;
		}

		pendingConductorWorkspaceOpenRef.current = null;
		const conductorStore = useConductorStore.getState();
		const currentView = conductorStore.activeConductorView;
		const isSameWorkspaceView =
			currentView?.scope === 'workspace' && currentView.groupId === groupId;

		if (isSameWorkspaceView) {
			conductorStore.setActiveConductorView(null);
			queueMicrotask(() => {
				useConductorStore.getState().setActiveConductorView(nextView);
			});
		} else {
			conductorStore.setActiveConductorView(nextView);
		}

		return true;
	};

	// Broadcast active session change to web clients
	useEffect(() => {
		if (activeSessionId && isLiveMode) {
			window.maestro.live.broadcastActiveSession(activeSessionId);
		}
	}, [activeSessionId, isLiveMode]);

	useEffect(() => {
		const pendingGroupId = pendingConductorWorkspaceOpenRef.current;
		if (!pendingGroupId) {
			return;
		}

		void groups;
		openConductorWorkspace(pendingGroupId);
	}, [groups]);

	// Handle remote commands from web interface
	// This allows web commands to go through the exact same code path as desktop commands
	useEffect(() => {
		console.log('[useRemoteIntegration] Setting up onRemoteCommand listener');
		const unsubscribeRemote = window.maestro.process.onRemoteCommand(
			(
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				commandAction?: 'default' | 'queue',
				images?: string[],
				textAttachments?: Array<{
					id?: string;
					name: string;
					content: string;
					mimeType?: string;
					size?: number;
				}>,
				attachments?: Array<{
					id?: string;
					kind: 'image' | 'file';
					name: string;
					mimeType?: string;
					size?: number;
				}>,
				demoCapture?: DemoCaptureRequest
			) => {
				console.log('[useRemoteIntegration] onRemoteCommand callback invoked:', {
					sessionId,
					command: command?.substring(0, 50),
					inputMode,
					commandAction,
					imageCount: images?.length ?? 0,
					textAttachmentCount: textAttachments?.length ?? 0,
					demoCaptureEnabled: demoCapture?.enabled ?? false,
				});

				// Verify the session exists
				const targetSession = sessionsRef.current.find((s) => s.id === sessionId);
				console.log('[useRemoteIntegration] Target session lookup:', {
					found: !!targetSession,
					sessionCount: sessionsRef.current.length,
					availableIds: sessionsRef.current.map((s) => s.id),
				});

				if (!targetSession) {
					console.warn('[useRemoteIntegration] Session not found, dropping command');
					return;
				}

				// If web provided an inputMode, sync the session state before executing
				// This ensures the renderer uses the same mode the web intended
				if (inputMode && targetSession.inputMode !== inputMode) {
					setSessions((prev) =>
						prev.map((s) =>
							s.id === sessionId
								? {
										...s,
										inputMode,
										...(inputMode === 'terminal' && { activeFileTabId: null }),
									}
								: s
						)
					);
				}

				// Switch to the target session (for visual feedback)
				setActiveSessionId(sessionId);
				console.log('[useRemoteIntegration] Switched active session to:', sessionId);

				// Dispatch event directly - handleRemoteCommand handles all the logic
				// Don't set inputValue - we don't want command text to appear in the input bar
				// Pass the inputMode from web so handleRemoteCommand uses it
				console.log('[useRemoteIntegration] Dispatching maestro:remoteCommand event:', {
					sessionId,
					command: command?.substring(0, 50),
					inputMode,
				});
				window.dispatchEvent(
					new CustomEvent('maestro:remoteCommand', {
						detail: {
							sessionId,
							command,
							inputMode,
							commandAction,
							images,
							textAttachments,
							attachments,
							demoCapture,
						},
					})
				);
				console.log('[useRemoteIntegration] Event dispatched successfully');
			}
		);

		return () => {
			unsubscribeRemote();
		};
	}, [sessionsRef, setSessions, setActiveSessionId]);

	// Handle remote mode switches from web interface
	// This allows web mode switches to go through the same code path as desktop
	useEffect(() => {
		const unsubscribeSwitchMode = window.maestro.process.onRemoteSwitchMode(
			(sessionId: string, mode: 'ai' | 'terminal') => {
				// Find the session and update its mode
				setSessions((prev) => {
					const session = prev.find((s) => s.id === sessionId);
					if (!session) {
						return prev;
					}

					// Only switch if mode is different
					if (session.inputMode === mode) {
						return prev;
					}

					return prev.map((s) => {
						if (s.id !== sessionId) return s;
						// Clear activeFileTabId when switching to terminal mode to prevent
						// orphaned file preview without tab bar
						return {
							...s,
							inputMode: mode,
							...(mode === 'terminal' && { activeFileTabId: null }),
						};
					});
				});
			}
		);

		return () => {
			unsubscribeSwitchMode();
		};
	}, [setSessions]);

	// Handle remote interrupts from web interface
	// This allows web interrupts to go through the same code path as desktop (handleInterrupt)
	useEffect(() => {
		const unsubscribeInterrupt = window.maestro.process.onRemoteInterrupt(
			async (sessionId: string) => {
				// Find the session
				const session = sessionsRef.current.find((s) => s.id === sessionId);
				if (!session) {
					return;
				}

				interruptCurrentTurnRef.current?.(sessionId).catch((error) => {
					console.error('[Remote] Failed to interrupt session:', error);
				});
			}
		);

		return () => {
			unsubscribeInterrupt();
		};
	}, [interruptCurrentTurnRef, sessionsRef]);

	// Handle remote session selection from web interface
	// This allows web clients to switch the active session in the desktop app
	// If tabId is provided, also switches to that tab within the session
	useEffect(() => {
		const unsubscribeSelectSession = window.maestro.process.onRemoteSelectSession(
			(sessionId: string, tabId?: string) => {
				// Check if session exists
				const session = sessionsRef.current.find((s) => s.id === sessionId);
				if (!session) {
					return;
				}

				// Switch to the session (same as clicking in SessionList)
				setActiveSessionId(sessionId);

				// If tabId provided, also switch to that tab
				if (tabId) {
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							// Check if tab exists
							if (!s.aiTabs.some((t) => t.id === tabId)) {
								return s;
							}
							return { ...s, activeTabId: tabId };
						})
					);
				}
			}
		);

		// Handle remote tab selection from web interface
		// This also switches to the session if not already active
		const unsubscribeSelectTab = window.maestro.process.onRemoteSelectTab(
			(sessionId: string, tabId: string) => {
				// First, switch to the session if not already active
				const currentActiveId = activeSessionIdRef.current;
				if (currentActiveId !== sessionId) {
					setActiveSessionId(sessionId);
				}

				// Then update the active tab within the session
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						// Check if tab exists
						if (!s.aiTabs.some((t) => t.id === tabId)) {
							return s;
						}
						return { ...s, activeTabId: tabId };
					})
				);
			}
		);

		const unsubscribeSetSessionModel =
			window.maestro.process.onRemoteSetSessionModel?.(
				(sessionId: string, model: string | null) => {
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							return {
								...s,
								customModel: model?.trim() ? model.trim() : undefined,
							};
						})
					);
				}
			) || (() => {});

		// Handle remote new tab from web interface
		const unsubscribeNewTab =
			window.maestro.process.onRemoteNewTab?.((sessionId: string, responseChannel: string) => {
				let newTabId: string | null = null;

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;

						// Use createTab helper
						const result = createTab(s, {
							saveToHistory: defaultSaveToHistory,
							showThinking: defaultShowThinking,
						});
						if (!result) return s;
						newTabId = result.tab.id;
						return result.session;
					})
				);

				// Send response back with the new tab ID
				if (newTabId) {
					window.maestro.process.sendRemoteNewTabResponse(responseChannel, { tabId: newTabId });
				} else {
					window.maestro.process.sendRemoteNewTabResponse(responseChannel, null);
				}
			}) || (() => {});

		const unsubscribeNewThread =
			window.maestro.process.onRemoteNewThread?.(
				(
					sessionId: string,
					options: { toolType?: string; model?: string | null },
					responseChannel: string
				) => {
					const sourceSession = sessionsRef.current.find((session) => session.id === sessionId);
					if (!sourceSession) {
						window.maestro.process.sendRemoteNewThreadResponse(responseChannel, {
							success: false,
						});
						return;
					}

					const currentSessionCount = useSessionStore.getState().sessions.length;
					const activeTab =
						sourceSession.aiTabs?.find((tab) => tab.id === sourceSession.activeTabId) ||
						sourceSession.aiTabs?.[0];
					const nextToolType =
						(options.toolType as typeof sourceSession.toolType) || sourceSession.toolType;
					const nextModel =
						options.model === undefined
							? sourceSession.customModel || activeTab?.currentModel || undefined
							: options.model || undefined;
					const nextName = buildDefaultThreadName(nextToolType, sessionsRef.current);
					const workingDir = sourceSession.projectRoot || sourceSession.cwd;
					const workspaceId = sourceSession.workspaceId || sourceSession.groupId || undefined;
					const reusingProviderConfig = nextToolType === sourceSession.toolType;

					void createNewSession(
						nextToolType,
						workingDir,
						nextName,
						undefined,
						reusingProviderConfig ? sourceSession.customPath : undefined,
						reusingProviderConfig ? sourceSession.customArgs : undefined,
						reusingProviderConfig ? sourceSession.customEnvVars : undefined,
						nextModel,
						reusingProviderConfig ? sourceSession.customContextWindow : undefined,
						reusingProviderConfig ? sourceSession.customProviderPath : undefined,
						sourceSession.sessionSshRemoteConfig,
						workspaceId
					)
						.then(() => {
							const updatedSessions = useSessionStore.getState().sessions;
							const updatedSessionCount = useSessionStore.getState().sessions.length;
							const createdSession =
								updatedSessions.find(
									(session) => !sessionsRef.current.some((candidate) => candidate.id === session.id)
								) || null;
							window.maestro.process.sendRemoteNewThreadResponse(
								responseChannel,
								createdSession
									? {
											success: true,
											sessionId: createdSession.id,
										}
									: {
											success: updatedSessionCount > currentSessionCount,
										}
							);
						})
						.catch((error) => {
							console.error('[Remote] Failed to create thread:', error);
							window.maestro.process.sendRemoteNewThreadResponse(responseChannel, {
								success: false,
							});
						});
				}
			) || (() => {});

		const unsubscribeDeleteSession =
			window.maestro.process.onRemoteDeleteSession?.(
				(sessionId: string, responseChannel: string) => {
					const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
					if (!session) {
						window.maestro.process.sendRemoteDeleteSessionResponse(responseChannel, false);
						return;
					}

					void performDeleteSession(session, false)
						.then(() => {
							window.maestro.process.sendRemoteDeleteSessionResponse(responseChannel, true);
						})
						.catch((error) => {
							console.error('[Remote] Failed to delete session:', error);
							window.maestro.process.sendRemoteDeleteSessionResponse(responseChannel, false);
						});
				}
			) || (() => {});

		// Handle remote close tab from web interface
		const unsubscribeCloseTab =
			window.maestro.process.onRemoteCloseTab?.((sessionId: string, tabId: string) => {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;

						// Use closeTab helper (handles last tab by creating a fresh one)
						const result = closeTab(s, tabId);
						return result?.session ?? s;
					})
				);
			}) || (() => {});

		// Handle remote rename tab from web interface
		const unsubscribeRenameTab =
			window.maestro.process.onRemoteRenameTab?.(
				(sessionId: string, tabId: string, newName: string) => {
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;

							// Find the tab to get its agentSessionId for persistence
							const tab = s.aiTabs.find((t) => t.id === tabId);
							if (!tab) {
								return s;
							}

							// Persist name to agent session metadata (async, fire and forget)
							// Use projectRoot (not cwd) for consistent session storage access
							if (tab.agentSessionId) {
								const agentId = s.toolType || 'claude-code';
								if (agentId === 'claude-code') {
									window.maestro.claude
										.updateSessionName(s.projectRoot, tab.agentSessionId, newName || '')
										.catch((err) => console.error('Failed to persist tab name:', err));
								} else {
									window.maestro.agentSessions
										.setSessionName(agentId, s.projectRoot, tab.agentSessionId, newName || null)
										.catch((err) => console.error('Failed to persist tab name:', err));
								}
								// Also update past history entries with this agentSessionId
								window.maestro.history
									.updateSessionName(tab.agentSessionId, newName || '')
									.catch((err) => console.error('Failed to update history session names:', err));
							}

							return {
								...s,
								aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, name: newName || null } : t)),
							};
						})
					);
				}
			) || (() => {});

		// Handle remote star tab from web interface
		const unsubscribeStarTab =
			window.maestro.process.onRemoteStarTab?.(
				(sessionId: string, tabId: string, starred: boolean) => {
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;

							const tab = s.aiTabs.find((t) => t.id === tabId);
							if (!tab?.agentSessionId) return s;

							// Persist starred state (same logic as desktop handleTabStar)
							const agentId = s.toolType || 'claude-code';
							if (agentId === 'claude-code') {
								window.maestro.claude
									.updateSessionStarred(s.projectRoot, tab.agentSessionId, starred)
									.catch((err) => console.error('Failed to persist tab starred:', err));
							} else {
								window.maestro.agentSessions
									.setSessionStarred(agentId, s.projectRoot, tab.agentSessionId, starred)
									.catch((err) => console.error('Failed to persist tab starred:', err));
							}

							return {
								...s,
								aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, starred } : t)),
							};
						})
					);
				}
			) || (() => {});

		// Handle remote reorder tab from web interface
		const unsubscribeReorderTab =
			window.maestro.process.onRemoteReorderTab?.(
				(sessionId: string, fromIndex: number, toIndex: number) => {
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId || !s.aiTabs) return s;
							const tabs = [...s.aiTabs];
							const [movedTab] = tabs.splice(fromIndex, 1);
							tabs.splice(toIndex, 0, movedTab);
							return { ...s, aiTabs: tabs };
						})
					);
				}
			) || (() => {});

		// Handle remote bookmark toggle from web interface
		const unsubscribeToggleBookmark =
			window.maestro.process.onRemoteToggleBookmark?.((sessionId: string) => {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						return { ...s, bookmarked: !s.bookmarked };
					})
				);
			}) || (() => {});

		const unsubscribeCreateConductorTask =
			window.maestro.process.onRemoteCreateConductorTask?.((input, responseChannel) => {
				try {
					const conductorStore = useConductorStore.getState();
					const existingTaskIds = new Set(conductorStore.tasks.map((task) => task.id));
					conductorStore.addTask(input.groupId, {
						title: input.title,
						description: input.description,
						priority: input.priority,
						status: input.status,
					});
					const snapshot = useConductorStore.getState();
					const createdTask = snapshot.tasks.find((task) => !existingTaskIds.has(task.id));
					if (!createdTask) {
						window.maestro.process.sendRemoteCreateConductorTaskResponse(responseChannel, false);
						return;
					}
					void Promise.resolve(
						window.maestro.conductors?.setAll({
							conductors: snapshot.conductors,
							tasks: snapshot.tasks,
							runs: snapshot.runs,
						})
					)
						.then((result) => {
							window.maestro.process.sendRemoteCreateConductorTaskResponse(
								responseChannel,
								result !== false
							);
						})
						.catch(() => {
							window.maestro.process.sendRemoteCreateConductorTaskResponse(responseChannel, false);
						});
				} catch (error) {
					console.error('[Remote] Failed to create conductor task:', error);
					window.maestro.process.sendRemoteCreateConductorTaskResponse(responseChannel, false);
				}
			}) || (() => {});

		const unsubscribeUpdateConductorTask =
			window.maestro.process.onRemoteUpdateConductorTask?.(
				(taskId: string, updates, responseChannel: string) => {
					try {
						const conductorStore = useConductorStore.getState();
						const existingTask = conductorStore.tasks.find((task) => task.id === taskId);
						if (!existingTask) {
							window.maestro.process.sendRemoteUpdateConductorTaskResponse(responseChannel, false);
							return;
						}

						const nextUpdates = updates.status
							? {
									...buildConductorBoardTaskStatusPatch({
										task: existingTask,
										nextStatus: updates.status,
										currentAttention: updates.attentionRequest ?? existingTask.attentionRequest ?? null,
									}),
									...updates,
								}
							: updates;

						conductorStore.updateTask(taskId, nextUpdates);
						const snapshot = useConductorStore.getState();
						void Promise.resolve(
							window.maestro.conductors?.setAll({
								conductors: snapshot.conductors,
								tasks: snapshot.tasks,
								runs: snapshot.runs,
							})
						)
							.then((result) => {
								window.maestro.process.sendRemoteUpdateConductorTaskResponse(
									responseChannel,
									result !== false
								);
							})
							.catch(() => {
								window.maestro.process.sendRemoteUpdateConductorTaskResponse(
									responseChannel,
									false
								);
							});
					} catch (error) {
						console.error('[Remote] Failed to update conductor task:', error);
						window.maestro.process.sendRemoteUpdateConductorTaskResponse(responseChannel, false);
					}
				}
			) || (() => {});

		const unsubscribeDeleteConductorTask =
			window.maestro.process.onRemoteDeleteConductorTask?.(
				(taskId: string, responseChannel: string) => {
					try {
						const conductorStore = useConductorStore.getState();
						const existingTask = conductorStore.tasks.find((task) => task.id === taskId);
						if (!existingTask) {
							window.maestro.process.sendRemoteDeleteConductorTaskResponse(responseChannel, false);
							return;
						}

						conductorStore.deleteTask(taskId);
						const snapshot = useConductorStore.getState();
						void Promise.resolve(
							window.maestro.conductors?.setAll({
								conductors: snapshot.conductors,
								tasks: snapshot.tasks,
								runs: snapshot.runs,
							})
						)
							.then((result) => {
								window.maestro.process.sendRemoteDeleteConductorTaskResponse(
									responseChannel,
									result !== false
								);
							})
							.catch(() => {
								window.maestro.process.sendRemoteDeleteConductorTaskResponse(
									responseChannel,
									false
								);
							});
					} catch (error) {
						console.error('[Remote] Failed to delete conductor task:', error);
						window.maestro.process.sendRemoteDeleteConductorTaskResponse(responseChannel, false);
					}
				}
			) || (() => {});

		const unsubscribeOpenConductorWorkspace =
			window.maestro.process.onRemoteOpenConductorWorkspace?.(
				(groupId: string, responseChannel: string) => {
					try {
						openConductorWorkspace(groupId);
						window.maestro.process.sendRemoteOpenConductorWorkspaceResponse(
							responseChannel,
							true
						);
					} catch (error) {
						console.error('[Remote] Failed to open conductor workspace:', error);
						window.maestro.process.sendRemoteOpenConductorWorkspaceResponse(
							responseChannel,
							false
						);
					}
				}
			) || (() => {});

		return () => {
			unsubscribeSelectSession();
			unsubscribeSelectTab();
			unsubscribeSetSessionModel();
			unsubscribeNewTab();
			unsubscribeNewThread();
			unsubscribeDeleteSession();
			unsubscribeCloseTab();
			unsubscribeRenameTab();
			unsubscribeStarTab();
			unsubscribeReorderTab();
			unsubscribeToggleBookmark();
			unsubscribeCreateConductorTask();
			unsubscribeUpdateConductorTask();
			unsubscribeDeleteConductorTask();
			unsubscribeOpenConductorWorkspace();
		};
	}, [
		sessionsRef,
		activeSessionIdRef,
		setSessions,
		setActiveSessionId,
		defaultSaveToHistory,
		defaultShowThinking,
		performDeleteSession,
		createNewSession,
	]);

	// Broadcast tab changes to web clients when tabs, activeTabId, or tab properties change
	// PERFORMANCE FIX: This effect was previously missing its dependency array, causing it to
	// run on EVERY render (including every keystroke). Now it only runs when isLiveMode changes,
	// and uses the sessionsRef to avoid reacting to every session state change.
	// The internal comparison logic ensures broadcasts only happen when actually needed.
	const prevTabsRef = useRef<
		Map<string, { tabCount: number; activeTabId: string; tabsHash: string }>
	>(new Map());

	// Track previous session states for broadcasting state changes to web clients
	// This is separate from tab changes because session state (busy/idle) changes need
	// to be broadcast immediately for proper UI feedback on the web interface
	const prevSessionStatesRef = useRef<Map<string, string>>(new Map());
	const prevContextUsageRef = useRef<Map<string, number | null>>(new Map());
	const prevResponseEventIdsRef = useRef<Map<string, string>>(new Map());

	// Only set up the interval when live mode is active
	useEffect(() => {
		// Skip entirely if not in live mode - no web clients to broadcast to
		if (!isLiveMode) return;

		// Use an interval to periodically check for changes instead of running on every render
		// This dramatically reduces CPU usage during normal typing
		const intervalId = setInterval(() => {
			const sessions = sessionsRef.current;

			sessions.forEach((session) => {
				// Broadcast session state changes (busy/idle) to web clients
				// This bypasses the debounced persistence which resets state to 'idle' before saving
				const prevState = prevSessionStatesRef.current.get(session.id);
				const currentContextUsage =
					typeof session.contextUsage === 'number' ? session.contextUsage : null;
				const activeTab =
					session.aiTabs?.find((tab) => tab.id === session.activeTabId) ?? session.aiTabs?.[0];
				const effectiveContextWindow =
					typeof session.customContextWindow === 'number' && session.customContextWindow > 0
						? session.customContextWindow
						: typeof activeTab?.usageStats?.contextWindow === 'number' &&
							  activeTab.usageStats.contextWindow > 0
							? activeTab.usageStats.contextWindow
							: null;
				const prevContextUsage = prevContextUsageRef.current.get(session.id) ?? null;
				if (prevState !== session.state || prevContextUsage !== currentContextUsage) {
					window.maestro.web.broadcastSessionState(session.id, session.state, {
						name: session.name,
						toolType: session.toolType,
						inputMode: session.inputMode,
						cwd: session.cwd,
						contextUsage: session.contextUsage,
						effectiveContextWindow,
					});

					if (prevState === 'busy' && session.state === 'idle') {
						const responseCompletedEvent = buildResponseCompletedEvent(session);
						const previousEventId = prevResponseEventIdsRef.current.get(session.id);
						if (responseCompletedEvent && responseCompletedEvent.eventId !== previousEventId) {
							window.maestro.web.broadcastResponseCompleted(responseCompletedEvent);
							prevResponseEventIdsRef.current.set(session.id, responseCompletedEvent.eventId);
						}
					}
					prevSessionStatesRef.current.set(session.id, session.state);
					prevContextUsageRef.current.set(session.id, currentContextUsage);
				}

				if (!session.aiTabs || session.aiTabs.length === 0) return;

				// Create a hash of tab properties that should trigger a broadcast when changed
				const tabsHash = session.aiTabs
					.map(
						(t) =>
							`${t.id}:${t.name || ''}:${t.starred}:${t.hasUnread ? 1 : 0}:${t.state}:${t.currentModel || ''}:${t.runtimeKind || 'batch'}:${t.steerMode || 'none'}:${t.activeTurnId || ''}:${t.pendingSteer?.logEntryId || ''}:${t.pendingSteer?.deliveryState || ''}:${t.steerStatus || 'idle'}:${t.lastCheckpointAt || 0}:${t.usageStats?.inputTokens || 0}:${t.usageStats?.outputTokens || 0}:${t.usageStats?.cacheReadInputTokens || 0}:${t.usageStats?.cacheCreationInputTokens || 0}:${t.usageStats?.contextWindow || 0}:${t.usageStats?.reasoningTokens || 0}`
					)
					.join('|');

				const prev = prevTabsRef.current.get(session.id);
				const current = {
					tabCount: session.aiTabs.length,
					activeTabId: session.activeTabId || session.aiTabs[0]?.id || '',
					tabsHash,
				};

				// Check if anything changed
				if (
					!prev ||
					prev.tabCount !== current.tabCount ||
					prev.activeTabId !== current.activeTabId ||
					prev.tabsHash !== current.tabsHash
				) {
					const tabsForBroadcast = session.aiTabs.map((tab) => ({
						id: tab.id,
						agentSessionId: tab.agentSessionId,
						name: tab.name,
						starred: tab.starred,
						hasUnread: tab.hasUnread,
						inputValue: tab.inputValue,
						usageStats: tab.usageStats,
						createdAt: tab.createdAt,
						state: tab.state,
						thinkingStartTime: tab.thinkingStartTime,
						currentModel: tab.currentModel || null,
						runtimeKind: tab.runtimeKind || 'batch',
						steerMode: tab.steerMode || 'none',
						activeTurnId: tab.activeTurnId || null,
						pendingSteer: tab.pendingSteer || null,
						steerStatus: tab.steerStatus || 'idle',
						lastCheckpointAt: tab.lastCheckpointAt || null,
					}));

					window.maestro.web.broadcastTabsChange(session.id, tabsForBroadcast, current.activeTabId);

					prevTabsRef.current.set(session.id, current);
				}
			});
		}, 500); // Check every 500ms - fast enough for good UX, slow enough to not impact typing

		return () => clearInterval(intervalId);
	}, [isLiveMode, sessionsRef]);

	return {};
}
