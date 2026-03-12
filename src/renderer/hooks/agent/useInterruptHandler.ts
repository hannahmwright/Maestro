/**
 * useInterruptHandler — extracted from App.tsx
 *
 * Handles interrupting/stopping running AI processes:
 *   - Sends SIGINT to active process (AI or terminal mode)
 *   - Cancels pending synopsis before interrupting
 *   - Cleans up thinking/tool logs from interrupted tabs
 *   - Processes execution queue after interruption
 *   - Falls back to force-kill if graceful interrupt fails
 *
 * Reads from: sessionStore (activeSession, sessions)
 */

import { useCallback } from 'react';
import type { Session, LogEntry, QueuedItem, SessionState } from '../../types';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { generateId } from '../../utils/ids';
import { getActiveTab } from '../../utils/tabHelpers';
import { conversationService } from '../../services/conversation';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseInterruptHandlerDeps {
	/** Ref to latest sessions array (avoids stale closure) */
	sessionsRef: React.RefObject<Session[]>;
	/** Cancel any pending synopsis processes for a session */
	cancelPendingSynopsis: (sessionId: string) => Promise<void>;
	/** Process next queued execution item */
	processQueuedItem: (sessionId: string, item: QueuedItem) => Promise<void>;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseInterruptHandlerReturn {
	/** Interrupt a running process, defaulting to the active session */
	handleInterrupt: (sessionId?: string) => Promise<void>;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useInterruptHandler(deps: UseInterruptHandlerDeps): UseInterruptHandlerReturn {
	const { sessionsRef, cancelPendingSynopsis, processQueuedItem } = deps;

	// --- Reactive subscriptions ---
	const activeSession = useSessionStore(selectActiveSession);

	// --- Store actions (stable via getState) ---
	const { setSessions } = useSessionStore.getState();

	const markInterruptedUserTurn = useCallback((logs: LogEntry[]): LogEntry[] => {
		for (let index = logs.length - 1; index >= 0; index -= 1) {
			const log = logs[index];
			if (log.source !== 'user') {
				continue;
			}

			return logs.map((entry, entryIndex) =>
				entryIndex === index
					? {
							...entry,
							interactionKind: entry.interactionKind || ('turn' as const),
							deliveryState: 'canceled' as const,
							delivered: false,
						}
					: entry
			);
		}

		return logs;
	}, []);

	// ========================================================================
	// handleInterrupt — interrupt the active process
	// ========================================================================
	const handleInterrupt = useCallback(async (sessionId?: string) => {
		const targetSession =
			(sessionId ? sessionsRef.current?.find((session) => session.id === sessionId) : null) ||
			activeSession;
		if (!targetSession) return;

		const currentMode = targetSession.inputMode;
		const activeTab = getActiveTab(targetSession);
		const targetSessionId =
			currentMode === 'ai'
				? `${targetSession.id}-ai-${activeTab?.id || 'default'}`
				: `${targetSession.id}-terminal`;

		// Cancel any pending synopsis processes (non-critical, shouldn't block interrupt)
		try {
			await cancelPendingSynopsis(targetSession.id);
		} catch (synopsisErr) {
			console.warn('[useInterruptHandler] Failed to cancel pending synopsis:', synopsisErr);
		}

		try {
			// Send interrupt signal (Ctrl+C)
			await conversationService.interruptTurn(targetSessionId, targetSession.toolType);

			// Check if there are queued items to process after interrupt
			const currentSession = sessionsRef.current?.find((s) => s.id === targetSession.id);
			let queuedItemToProcess: {
				sessionId: string;
				item: QueuedItem;
			} | null = null;
			let pendingSteerToProcess:
				| {
						tabId: string;
						logEntryId: string;
						text: string;
						images?: string[];
				  }
				| null = null;

			const currentActiveTab = currentSession ? getActiveTab(currentSession) : null;
			if (
				currentActiveTab?.pendingSteer &&
				currentActiveTab.pendingSteer.deliveryState === 'fallback_interrupt'
			) {
				pendingSteerToProcess = {
					tabId: currentActiveTab.id,
					logEntryId: currentActiveTab.pendingSteer.logEntryId,
					text: currentActiveTab.pendingSteer.text,
					images: currentActiveTab.pendingSteer.images,
				};
				queuedItemToProcess = {
					sessionId: targetSession.id,
					item: {
						id: generateId(),
						timestamp: Date.now(),
						tabId: currentActiveTab.id,
						type: 'message',
						text: currentActiveTab.pendingSteer.text,
						images: currentActiveTab.pendingSteer.images,
						readOnlyMode: currentActiveTab.readOnlyMode,
					},
				};
			} else if (currentSession && currentSession.executionQueue.length > 0) {
				queuedItemToProcess = {
					sessionId: targetSession.id,
					item: currentSession.executionQueue[0],
				};
			}

			// Create canceled log entry for AI mode interrupts
			const canceledLog: LogEntry | null =
				currentMode === 'ai'
					? {
							id: generateId(),
							timestamp: Date.now(),
							source: 'system',
							text: 'Canceled by user',
						}
					: null;

			// Set state to idle with full cleanup, or process next queued item
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== targetSession.id) return s;

					// If there are queued items or a pending fallback steer, start processing the next one
					if (queuedItemToProcess) {
						const nextItem = queuedItemToProcess.item;
						const remainingQueue =
							pendingSteerToProcess && s.executionQueue.length > 0
								? s.executionQueue
								: s.executionQueue.slice(1);
						const targetTab = s.aiTabs.find((tab) => tab.id === nextItem.tabId) || getActiveTab(s);

						if (!targetTab) {
							return {
								...s,
								state: 'busy' as SessionState,
								busySource: 'ai',
								executionQueue: remainingQueue,
								thinkingStartTime: Date.now(),
								currentCycleTokens: 0,
								currentCycleBytes: 0,
							};
						}

						// Set the interrupted tab to idle, and the target tab for queued item to busy
						// Also add the canceled log to the interrupted tab
						let updatedAiTabs = s.aiTabs.map((tab) => {
							if (tab.id === targetTab.id) {
								const logsWithFallbackSteerDelivered = pendingSteerToProcess
									? tab.logs.map((log) =>
											log.id === pendingSteerToProcess!.logEntryId
												? {
														...log,
														delivered: true,
														deliveryState: 'fallback_interrupt' as const,
													}
												: log
										)
									: tab.logs;
								return {
									...tab,
									state: 'busy' as const,
									thinkingStartTime: Date.now(),
									logs: logsWithFallbackSteerDelivered,
									pendingSteer: null,
									steerStatus: 'idle' as const,
								};
							}
							// Set any other busy tabs to idle (they were interrupted) and add canceled log
							// Also clear any thinking/tool logs since the process was interrupted
							if (tab.state === 'busy') {
								const logsWithoutThinkingOrTools = tab.logs.filter(
									(log) => log.source !== 'thinking' && log.source !== 'tool'
								);
								const logsWithCanceledTurn = markInterruptedUserTurn(logsWithoutThinkingOrTools);
								const updatedLogs = canceledLog
									? [...logsWithCanceledTurn, canceledLog]
									: logsWithCanceledTurn;
								return {
									...tab,
									state: 'idle' as const,
									thinkingStartTime: undefined,
									logs: updatedLogs,
									pendingSteer: null,
									steerStatus: 'idle' as const,
								};
							}
							return tab;
						});

						// For message items, add a log entry to the target tab
						if (nextItem.type === 'message' && nextItem.text && !pendingSteerToProcess) {
							const logEntry: LogEntry = {
								id: generateId(),
								timestamp: Date.now(),
								source: 'user',
								text: nextItem.text,
								images: nextItem.images,
							};
							updatedAiTabs = updatedAiTabs.map((tab) =>
								tab.id === targetTab.id ? { ...tab, logs: [...tab.logs, logEntry] } : tab
							);
						}

						return {
							...s,
							state: 'busy' as SessionState,
								busySource: 'ai',
								aiTabs: updatedAiTabs,
								executionQueue: remainingQueue,
								thinkingStartTime: Date.now(),
							currentCycleTokens: 0,
							currentCycleBytes: 0,
						};
					}

					// No queued items, just go to idle and add canceled log to the active tab
					// Also clear any thinking/tool logs since the process was interrupted
					const activeTabForCancel = getActiveTab(s);
					const updatedAiTabsForIdle = s.aiTabs.map((tab) => {
						if (tab.id === activeTabForCancel?.id || tab.state === 'busy') {
							const logsWithoutThinkingOrTools = tab.logs.filter(
								(log) => log.source !== 'thinking' && log.source !== 'tool'
							);
							const logsWithCanceledTurn = markInterruptedUserTurn(logsWithoutThinkingOrTools);
							return {
								...tab,
								state: 'idle' as const,
								thinkingStartTime: undefined,
								logs:
									canceledLog && tab.id === activeTabForCancel?.id
										? [...logsWithCanceledTurn, canceledLog]
										: logsWithCanceledTurn,
								pendingSteer: null,
								steerStatus: 'idle' as const,
							};
						}
						return tab;
					});

					return {
						...s,
						state: 'idle',
						busySource: undefined,
						thinkingStartTime: undefined,
						aiTabs: updatedAiTabsForIdle,
					};
				})
			);

			// Process the queued item after state update
			if (queuedItemToProcess) {
				setTimeout(() => {
					processQueuedItem(queuedItemToProcess!.sessionId, queuedItemToProcess!.item).catch(
						(err) => console.error('[useInterruptHandler] Failed to process queued item:', err)
					);
				}, 0);
			}
		} catch (error) {
			console.error('Failed to interrupt process:', error);

			// If interrupt fails, offer to kill the process
			const shouldKill = confirm(
				'Failed to interrupt the process gracefully. Would you like to force kill it?\n\n' +
					'Warning: This may cause data loss or leave the process in an inconsistent state.'
			);

			if (shouldKill) {
				try {
					await (window as any).maestro.process.kill(targetSessionId);

					const killLog: LogEntry = {
						id: generateId(),
						timestamp: Date.now(),
						source: 'system',
						text: 'Process forcefully terminated',
					};

					// Check if there are queued items to process after kill
					const currentSessionForKill = sessionsRef.current?.find((s) => s.id === targetSession.id);
					let queuedItemAfterKill: {
						sessionId: string;
						item: QueuedItem;
					} | null = null;
					let pendingSteerAfterKill:
						| {
								tabId: string;
								logEntryId: string;
						  }
						| null = null;

					const currentActiveTabForKill = currentSessionForKill
						? getActiveTab(currentSessionForKill)
						: null;
					if (
						currentActiveTabForKill?.pendingSteer &&
						currentActiveTabForKill.pendingSteer.deliveryState === 'fallback_interrupt'
					) {
						pendingSteerAfterKill = {
							tabId: currentActiveTabForKill.id,
							logEntryId: currentActiveTabForKill.pendingSteer.logEntryId,
						};
						queuedItemAfterKill = {
							sessionId: targetSession.id,
							item: {
								id: generateId(),
								timestamp: Date.now(),
								tabId: currentActiveTabForKill.id,
								type: 'message',
								text: currentActiveTabForKill.pendingSteer.text,
								images: currentActiveTabForKill.pendingSteer.images,
								readOnlyMode: currentActiveTabForKill.readOnlyMode,
							},
						};
					} else if (currentSessionForKill && currentSessionForKill.executionQueue.length > 0) {
						queuedItemAfterKill = {
							sessionId: targetSession.id,
							item: currentSessionForKill.executionQueue[0],
						};
					}

					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== targetSession.id) return s;

							// Add kill log to the appropriate place and clear thinking/tool logs
							const updatedSession = { ...s };
							if (currentMode === 'ai') {
								const tab = getActiveTab(s);
								if (tab) {
									updatedSession.aiTabs = s.aiTabs.map((t) => {
										if (t.id === tab.id) {
											const logsWithoutThinkingOrTools = t.logs.filter(
												(log) => log.source !== 'thinking' && log.source !== 'tool'
											);
											return {
												...t,
												logs: [...logsWithoutThinkingOrTools, killLog],
											};
										}
										return t;
									});
								}
							} else {
								updatedSession.shellLogs = [...s.shellLogs, killLog];
							}

							// If there are queued items or a fallback steer replacement, start the next one
							if (queuedItemAfterKill) {
								const nextItem = queuedItemAfterKill.item;
								const remainingQueue = pendingSteerAfterKill
									? s.executionQueue
									: s.executionQueue.slice(1);
								const targetTab =
									s.aiTabs.find((tab) => tab.id === nextItem.tabId) || getActiveTab(s);

								if (!targetTab) {
									return {
										...updatedSession,
										state: 'busy' as SessionState,
										busySource: 'ai',
										executionQueue: remainingQueue,
										thinkingStartTime: Date.now(),
										currentCycleTokens: 0,
										currentCycleBytes: 0,
									};
								}

								// Set tabs appropriately and clear thinking/tool logs from interrupted tabs
								let updatedAiTabs = updatedSession.aiTabs.map((tab) => {
									if (tab.id === targetTab.id) {
										const logsWithFallbackSteerDelivered = pendingSteerAfterKill
											? tab.logs.map((log) =>
													log.id === pendingSteerAfterKill!.logEntryId
														? {
																...log,
																delivered: true,
																deliveryState: 'fallback_interrupt' as const,
															}
														: log
												)
											: tab.logs;
										return {
											...tab,
											state: 'busy' as const,
											thinkingStartTime: Date.now(),
											logs: logsWithFallbackSteerDelivered,
											pendingSteer: null,
											steerStatus: 'idle' as const,
										};
									}
										if (tab.state === 'busy') {
											const logsWithoutThinkingOrTools = tab.logs.filter(
												(log) => log.source !== 'thinking' && log.source !== 'tool'
											);
											const logsWithCanceledTurn =
												markInterruptedUserTurn(logsWithoutThinkingOrTools);
											return {
												...tab,
												state: 'idle' as const,
												thinkingStartTime: undefined,
												logs: logsWithCanceledTurn,
												pendingSteer: null,
												steerStatus: 'idle' as const,
											};
									}
									return tab;
								});

								// For message items, add a log entry to the target tab
								if (nextItem.type === 'message' && nextItem.text && !pendingSteerAfterKill) {
									const logEntry: LogEntry = {
										id: generateId(),
										timestamp: Date.now(),
										source: 'user',
										text: nextItem.text,
										images: nextItem.images,
									};
									updatedAiTabs = updatedAiTabs.map((tab) =>
										tab.id === targetTab.id ? { ...tab, logs: [...tab.logs, logEntry] } : tab
									);
								}

								return {
									...updatedSession,
									state: 'busy' as SessionState,
									busySource: 'ai',
									aiTabs: updatedAiTabs,
									executionQueue: remainingQueue,
									thinkingStartTime: Date.now(),
									currentCycleTokens: 0,
									currentCycleBytes: 0,
								};
							}

							// No queued items, just go to idle and clear thinking logs
							if (currentMode === 'ai') {
								return {
									...updatedSession,
									state: 'idle',
									busySource: undefined,
									thinkingStartTime: undefined,
									aiTabs: updatedSession.aiTabs.map((t) => {
										if (t.state === 'busy') {
											const logsWithoutThinkingOrTools = t.logs.filter(
												(log) => log.source !== 'thinking' && log.source !== 'tool'
											);
											return {
												...t,
												state: 'idle' as const,
												thinkingStartTime: undefined,
												logs: logsWithoutThinkingOrTools,
												pendingSteer: null,
												steerStatus: 'idle' as const,
											};
										}
										return t;
									}),
								};
							}
							return {
								...updatedSession,
								state: 'idle',
								busySource: undefined,
								thinkingStartTime: undefined,
							};
						})
					);

					// Process the queued item after state update
					if (queuedItemAfterKill) {
						setTimeout(() => {
							processQueuedItem(queuedItemAfterKill!.sessionId, queuedItemAfterKill!.item).catch(
								(err) =>
									console.error(
										'[useInterruptHandler] Failed to process queued item after kill:',
										err
									)
							);
						}, 0);
					}
				} catch (killError: unknown) {
					console.error('Failed to kill process:', killError);
					const killErrorMessage =
						killError instanceof Error ? killError.message : String(killError);
					const errorLog: LogEntry = {
						id: generateId(),
						timestamp: Date.now(),
						source: 'system',
						text: `Error: Failed to terminate process - ${killErrorMessage}`,
					};
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== targetSession.id) return s;
							if (currentMode === 'ai') {
								const activeTabForError = getActiveTab(s);
								return {
									...s,
									state: 'idle',
									busySource: undefined,
									thinkingStartTime: undefined,
									aiTabs: s.aiTabs.map((t) => {
										if (t.id === activeTabForError?.id || t.state === 'busy') {
											const logsWithoutThinkingOrTools = t.logs.filter(
												(log) => log.source !== 'thinking' && log.source !== 'tool'
											);
											return {
												...t,
												state: 'idle' as const,
												thinkingStartTime: undefined,
												logs:
													t.id === activeTabForError?.id
														? [...logsWithoutThinkingOrTools, errorLog]
														: logsWithoutThinkingOrTools,
											};
										}
										return t;
									}),
								};
							}
							return {
								...s,
								shellLogs: [...s.shellLogs, errorLog],
								state: 'idle',
								busySource: undefined,
								thinkingStartTime: undefined,
							};
						})
					);
				}
			}
		}
	}, [activeSession, setSessions, cancelPendingSynopsis, sessionsRef, processQueuedItem]);

	return { handleInterrupt };
}
