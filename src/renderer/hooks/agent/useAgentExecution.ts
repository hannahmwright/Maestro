import { useCallback, useRef } from 'react';
import type {
	Session,
	SessionState,
	UsageStats,
	QueuedItem,
	LogEntry,
	ToolType,
} from '../../types';
import { getActiveTab } from '../../utils/tabHelpers';
import { getStdinFlags } from '../../utils/spawnHelpers';
import { generateId } from '../../utils/ids';
import { gitService } from '../../services/git';

/**
 * Result from agent spawn operations.
 */
export interface AgentSpawnResult {
	success: boolean;
	response?: string;
	agentSessionId?: string;
	usageStats?: UsageStats;
	failureKind?: 'strict_gate';
}

export interface AutoRunTaskContext {
	documentName: string;
	folderPath: string;
	loopIteration: number;
	effectiveCwd: string;
}

export interface SpawnAgentOptions {
	autoRunTask?: AutoRunTaskContext;
}

/**
 * Dependencies for the useAgentExecution hook.
 */
export interface UseAgentExecutionDeps {
	/** Current active session (null if none selected) */
	activeSession: Session | null;
	/** Ref to sessions for accessing latest state without re-renders */
	sessionsRef: React.MutableRefObject<Session[]>;
	/** Session state setter */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	/** Ref to processQueuedItem function for processing queue after agent exit */
	processQueuedItemRef: React.MutableRefObject<
		((sessionId: string, item: QueuedItem) => Promise<void>) | null
	>;
	/** Flash notification setter (bottom-right) */
	setFlashNotification: (message: string | null) => void;
	/** Success flash notification setter (center screen) */
	setSuccessFlashNotification: (message: string | null) => void;
}

/**
 * Return type for useAgentExecution hook.
 */
export interface UseAgentExecutionReturn {
	/** Spawn an agent for a specific session and wait for completion */
	spawnAgentForSession: (
		sessionId: string,
		prompt: string,
		cwdOverride?: string,
		options?: SpawnAgentOptions
	) => Promise<AgentSpawnResult>;
	/** Spawn an agent with a prompt for the active session */
	spawnAgentWithPrompt: (prompt: string) => Promise<AgentSpawnResult>;
	/** Spawn a background synopsis agent (resumes an old agent session) */
	spawnBackgroundSynopsis: (
		sessionId: string,
		cwd: string,
		resumeAgentSessionId: string,
		prompt: string,
		toolType?: ToolType,
		sessionConfig?: {
			customPath?: string;
			customArgs?: string;
			customEnvVars?: Record<string, string>;
			customModel?: string;
			customContextWindow?: number;
			sessionSshRemoteConfig?: {
				enabled: boolean;
				remoteId: string | null;
				workingDirOverride?: string;
			};
		}
	) => Promise<AgentSpawnResult>;
	/** Ref to spawnBackgroundSynopsis for use in callbacks that need latest version */
	spawnBackgroundSynopsisRef: React.MutableRefObject<
		| ((
				sessionId: string,
				cwd: string,
				resumeAgentSessionId: string,
				prompt: string,
				toolType?: ToolType,
				sessionConfig?: {
					customPath?: string;
					customArgs?: string;
					customEnvVars?: Record<string, string>;
					customModel?: string;
					customContextWindow?: number;
					sessionSshRemoteConfig?: {
						enabled: boolean;
						remoteId: string | null;
						workingDirOverride?: string;
					};
				}
		  ) => Promise<AgentSpawnResult>)
		| null
	>;
	/** Ref to spawnAgentWithPrompt for use in callbacks that need latest version */
	spawnAgentWithPromptRef: React.MutableRefObject<
		((prompt: string) => Promise<AgentSpawnResult>) | null
	>;
	/** Show flash notification (auto-dismisses after 2 seconds) */
	showFlashNotification: (message: string) => void;
	/** Show success flash notification (center screen, auto-dismisses after 2 seconds) */
	showSuccessFlash: (message: string) => void;
	/** Cancel all pending synopsis processes for a given maestro session ID */
	cancelPendingSynopsis: (maestroSessionId: string) => Promise<void>;
}

/**
 * Hook for agent execution and spawning operations.
 *
 * Handles:
 * - Spawning agents for batch processing
 * - Spawning agents with prompts
 * - Background synopsis generation (resuming old sessions)
 * - Flash notifications for user feedback
 *
 * @param deps - Hook dependencies
 * @returns Agent execution functions and refs
 */
export function useAgentExecution(deps: UseAgentExecutionDeps): UseAgentExecutionReturn {
	const {
		activeSession,
		sessionsRef,
		setSessions,
		processQueuedItemRef,
		setFlashNotification,
		setSuccessFlashNotification,
	} = deps;

	// Refs for functions that need to be accessed from other callbacks
	const spawnBackgroundSynopsisRef = useRef<
		UseAgentExecutionReturn['spawnBackgroundSynopsis'] | null
	>(null);
	const spawnAgentWithPromptRef = useRef<((prompt: string) => Promise<AgentSpawnResult>) | null>(
		null
	);

	// Track active synopsis session IDs for cancellation
	// Map: maestroSessionId -> Set of active synopsis process session IDs
	const activeSynopsisSessionsRef = useRef<Map<string, Set<string>>>(new Map());
	const accumulateUsageStats = useCallback(
		(current: UsageStats | undefined, usageStats: UsageStats): UsageStats => ({
			...usageStats,
			inputTokens: (current?.inputTokens || 0) + usageStats.inputTokens,
			outputTokens: (current?.outputTokens || 0) + usageStats.outputTokens,
			cacheReadInputTokens: (current?.cacheReadInputTokens || 0) + usageStats.cacheReadInputTokens,
			cacheCreationInputTokens:
				(current?.cacheCreationInputTokens || 0) + usageStats.cacheCreationInputTokens,
			totalCostUsd: (current?.totalCostUsd || 0) + usageStats.totalCostUsd,
			reasoningTokens:
				current?.reasoningTokens || usageStats.reasoningTokens
					? (current?.reasoningTokens || 0) + (usageStats.reasoningTokens || 0)
					: undefined,
		}),
		[]
	);

	const detectPackageManager = useCallback(
		async (cwd: string, sshRemoteId?: string): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> => {
			const lockfiles: Array<{ fileName: string; manager: 'npm' | 'pnpm' | 'yarn' | 'bun' }> = [
				{ fileName: 'pnpm-lock.yaml', manager: 'pnpm' },
				{ fileName: 'yarn.lock', manager: 'yarn' },
				{ fileName: 'bun.lockb', manager: 'bun' },
				{ fileName: 'package-lock.json', manager: 'npm' },
			];

			for (const lockfile of lockfiles) {
				try {
					const stat = await window.maestro.fs.stat(`${cwd}/${lockfile.fileName}`, sshRemoteId);
					if (stat?.isFile) return lockfile.manager;
				} catch {
					// Ignore missing lockfiles.
				}
			}

			return 'npm';
		},
		[]
	);

	const buildScriptCommand = useCallback(
		(manager: 'npm' | 'pnpm' | 'yarn' | 'bun', script: string): string => {
			if (manager === 'yarn') return `yarn ${script}`;
			if (manager === 'bun') return `bun run ${script}`;
			if (manager === 'npm' && script === 'test') return 'npm test';
			if (manager === 'pnpm' && script === 'test') return 'pnpm test';
			return `${manager} run ${script}`;
		},
		[]
	);

	const resolveValidationCommands = useCallback(
		async (
			cwd: string,
			sshRemoteId?: string
		): Promise<{
			targetedCommand: string;
			fullSuiteCommand?: string;
			allowedCommands: string[];
		}> => {
			const fallback = {
				targetedCommand: 'git diff --name-only',
				fullSuiteCommand: undefined,
				allowedCommands: ['git diff --name-only'],
			};

			let scripts: Record<string, string> = {};
			try {
				const packageJson = await window.maestro.fs.readFile(`${cwd}/package.json`, sshRemoteId);
				if (packageJson) {
					const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
					scripts = parsed.scripts || {};
				}
			} catch {
				return fallback;
			}

			const manager = await detectPackageManager(cwd, sshRemoteId);
			let targetedCommand = fallback.targetedCommand;
			if (scripts.lint) targetedCommand = buildScriptCommand(manager, 'lint');
			else if (scripts.test) targetedCommand = buildScriptCommand(manager, 'test');
			else if (scripts.build) targetedCommand = buildScriptCommand(manager, 'build');

			let fullSuiteCommand: string | undefined;
			if (scripts.build) fullSuiteCommand = buildScriptCommand(manager, 'build');
			else if (scripts.test) fullSuiteCommand = buildScriptCommand(manager, 'test');

			const allowedCommands = [targetedCommand, fullSuiteCommand, 'git diff --name-only'].filter(
				(value): value is string => Boolean(value)
			);

			return { targetedCommand, fullSuiteCommand, allowedCommands };
		},
		[buildScriptCommand, detectPackageManager]
	);

	const runAutoRunTaskLoopValidation = useCallback(
		async (
			session: Session,
			targetSessionId: string,
			prompt: string,
			effectiveCwd: string,
			autoRunTask: AutoRunTaskContext
		): Promise<{ success: boolean; reason?: string }> => {
			const sshRemoteId =
				session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
			const { targetedCommand, fullSuiteCommand, allowedCommands } =
				await resolveValidationCommands(effectiveCwd, sshRemoteId);

			let changedFiles: string[] = [];
			let diffText = '';
			try {
				if (session.isGitRepo) {
					const status = await gitService.getStatus(effectiveCwd, sshRemoteId);
					changedFiles = status.files.map((file) => file.path).slice(0, 50);
					if (changedFiles.length > 0) {
						const diff = await gitService.getDiff(
							effectiveCwd,
							changedFiles.slice(0, 10),
							sshRemoteId
						);
						diffText = diff.diff;
					}
				}
			} catch (error) {
				console.warn('[AutoRunTaskLoop] Failed to collect git context', error);
			}

			const riskLevel =
				changedFiles.length > 5 ? 'high' : changedFiles.length > 2 ? 'medium' : 'low';

			const gateResult = await window.maestro.process.runCommand({
				sessionId: targetSessionId,
				command: targetedCommand,
				cwd: effectiveCwd,
				sessionSshRemoteConfig: session.sessionSshRemoteConfig,
				taskContractInput: {
					goal: `Auto Run strict validation for ${autoRunTask.documentName}`,
					repo_root: effectiveCwd,
					language_profile: 'ts_js',
					risk_level: riskLevel,
					done_gate_profile: riskLevel === 'high' ? 'high_risk' : 'standard',
					allowed_commands: allowedCommands,
					metadata: {
						source: 'auto_run',
						documentName: autoRunTask.documentName,
						folderPath: autoRunTask.folderPath,
						loopIteration: autoRunTask.loopIteration,
						promptPreview: prompt.slice(0, 120),
					},
				},
				relatedFiles: [`${autoRunTask.folderPath}/${autoRunTask.documentName}.md`],
				changedFiles,
				diffText,
				fullSuiteCommand,
			});

			if (gateResult.exitCode !== 0) {
				const normalizeDiagnostic = (value: string, maxLength = 220): string =>
					value
						.replace(/\x1B\[[0-9;]*m/g, '')
						.replace(/\s+/g, ' ')
						.trim()
						.slice(0, maxLength);

				const taskResult = (gateResult.taskResult || {}) as {
					reason?: string;
					decision?: { blocking_reasons?: unknown };
					attempts?: Array<{
						command?: string;
						result?: { stderr?: string };
					}>;
				};
				const taskDiagnostics = gateResult.taskDiagnostics;
				const blockingReasons = Array.isArray(taskResult.decision?.blocking_reasons)
					? taskResult.decision?.blocking_reasons
							.filter(
								(value): value is string => typeof value === 'string' && value.trim().length > 0
							)
							.slice(0, 2)
					: [];
				const lastAttempt = Array.isArray(taskResult.attempts)
					? taskResult.attempts[taskResult.attempts.length - 1]
					: undefined;
				const failedCommand = lastAttempt?.command || targetedCommand;
				const stderrSnippet = gateResult.stderr || lastAttempt?.result?.stderr;
				const diagnostics = [
					`strict_completion_gate_failed: command "${failedCommand}" exited with code ${gateResult.exitCode}`,
					taskResult.reason ? `loop: ${normalizeDiagnostic(taskResult.reason, 160)}` : undefined,
					taskDiagnostics
						? `diag: attempts=${taskDiagnostics.attempt_count}, status=${taskDiagnostics.status}, fullSuite=${taskDiagnostics.full_suite_required}`
						: undefined,
					blockingReasons.length > 0
						? `blocked: ${blockingReasons.map((reason) => normalizeDiagnostic(reason, 120)).join('; ')}`
						: undefined,
					stderrSnippet ? `stderr: ${normalizeDiagnostic(stderrSnippet)}` : undefined,
				]
					.filter((value): value is string => Boolean(value))
					.join(' | ');

				return {
					success: false,
					reason: diagnostics || 'strict_completion_gate_failed',
				};
			}

			return { success: true };
		},
		[resolveValidationCommands]
	);

	/**
	 * Spawn a Claude agent for a specific session and wait for completion.
	 * Used for batch processing where we need to track the agent's output.
	 *
	 * @param sessionId - The session ID to spawn the agent for
	 * @param prompt - The prompt to send to the agent
	 * @param cwdOverride - Optional override for working directory (e.g., for worktree mode)
	 * @param options - Optional spawn options for Auto Run task-loop validation
	 */
	const spawnAgentForSession = useCallback(
		async (
			sessionId: string,
			prompt: string,
			cwdOverride?: string,
			options?: SpawnAgentOptions
		): Promise<AgentSpawnResult> => {
			// Use sessionsRef to get latest sessions (fixes stale closure when called right after session creation)
			const session = sessionsRef.current.find((s) => s.id === sessionId);
			if (!session) return { success: false };

			// Use override cwd if provided (worktree mode), otherwise use session's cwd
			const effectiveCwd = cwdOverride || session.cwd;

			// This spawns a new agent session and waits for completion
			// Use session's toolType for multi-provider support
			try {
				const agent = await window.maestro.agents.get(session.toolType);
				if (!agent) {
					console.error(`[spawnAgentForSession] Agent not found for toolType: ${session.toolType}`);
					return { success: false };
				}

				// For batch processing, use a unique session ID per task run to avoid contaminating the main AI terminal
				// This prevents batch output from appearing in the interactive AI terminal
				const targetSessionId = `${sessionId}-batch-${Date.now()}`;

				// Note: We intentionally do NOT set the session or tab state to 'busy' here.
				// Batch operations run in isolation and should not affect the main UI state.
				// The batch progress is tracked separately via BatchRunState in useBatchProcessor.

				// Create a promise that resolves when the agent completes
				return new Promise((resolve) => {
					let agentSessionId: string | undefined;
					let responseText = '';
					let taskUsageStats: UsageStats | undefined;
					const queryStartTime = Date.now(); // Track start time for stats

					// Array to collect cleanup functions as listeners are registered
					const cleanupFns: (() => void)[] = [];

					const cleanup = () => {
						cleanupFns.forEach((fn) => fn());
					};

					// Set up listeners for this specific agent run
					cleanupFns.push(
						window.maestro.process.onData((sid: string, data: string) => {
							if (sid === targetSessionId) {
								responseText += data;
							}
						})
					);

					cleanupFns.push(
						window.maestro.process.onSessionId((sid: string, capturedId: string) => {
							if (sid === targetSessionId) {
								agentSessionId = capturedId;
							}
						})
					);

					// Capture usage stats for this specific task
					cleanupFns.push(
						window.maestro.process.onUsage((sid: string, usageStats) => {
							if (sid === targetSessionId) {
								// Accumulate usage stats for this task (there may be multiple usage events per task)
								taskUsageStats = accumulateUsageStats(taskUsageStats, usageStats);
							}
						})
					);

					cleanupFns.push(
						window.maestro.process.onExit((sid: string) => {
							if (sid === targetSessionId) {
								// Clean up listeners
								cleanup();

								const resolveSuccess = () =>
									resolve({
										success: true,
										response: responseText,
										agentSessionId,
										usageStats: taskUsageStats,
									});

								const resolveFailure = (
									reason?: string,
									failureKind?: AgentSpawnResult['failureKind']
								) =>
									resolve({
										success: false,
										response: reason || responseText,
										agentSessionId,
										usageStats: taskUsageStats,
										failureKind,
									});

								const finalizeResolve = async () => {
									if (!options?.autoRunTask) {
										resolveSuccess();
										return;
									}

									try {
										const validationResult = await runAutoRunTaskLoopValidation(
											session,
											targetSessionId,
											prompt,
											effectiveCwd,
											options.autoRunTask
										);

										if (!validationResult.success) {
											resolveFailure(validationResult.reason, 'strict_gate');
											return;
										}

										resolveSuccess();
									} catch (error) {
										console.error('[AutoRunTaskLoop] Validation failed unexpectedly:', error);
										resolveFailure('strict_completion_gate_failed', 'strict_gate');
									}
								};

								// Record query stats for Auto Run queries
								const queryDuration = Date.now() - queryStartTime;
								const activeTab = getActiveTab(session);
								window.maestro.stats
									.recordQuery({
										sessionId: sessionId, // Use the original session ID, not the batch ID
										agentType: session.toolType,
										source: 'auto', // Auto Run queries are always 'auto'
										startTime: queryStartTime,
										duration: queryDuration,
										projectPath: effectiveCwd,
										tabId: activeTab?.id,
										isRemote: session.sessionSshRemoteConfig?.enabled ?? false,
									})
									.catch((err) => {
										// Don't fail the batch flow if stats recording fails
										console.warn('[spawnAgentForSession] Failed to record query stats:', err);
									});

								// Check for queued items BEFORE updating state (using sessionsRef for latest state)
								const currentSession = sessionsRef.current.find((s) => s.id === sessionId);
								let queuedItemToProcess: { sessionId: string; item: QueuedItem } | null = null;
								const hasQueuedItems = currentSession && currentSession.executionQueue.length > 0;

								if (hasQueuedItems) {
									queuedItemToProcess = {
										sessionId: sessionId,
										item: currentSession!.executionQueue[0],
									};
								}

								// Update state - if there are queued items, keep busy and process next
								setSessions((prev) =>
									prev.map((s) => {
										if (s.id !== sessionId) return s;

										if (s.executionQueue.length > 0) {
											const [nextItem, ...remainingQueue] = s.executionQueue;
											const targetTab =
												s.aiTabs.find((tab) => tab.id === nextItem.tabId) || getActiveTab(s);

											if (!targetTab) {
												// Fallback: no tabs exist
												return {
													...s,
													state: 'busy' as SessionState,
													busySource: 'ai',
													executionQueue: remainingQueue,
													thinkingStartTime: Date.now(),
													currentCycleTokens: 0,
													currentCycleBytes: 0,
													pendingAICommandForSynopsis: undefined,
												};
											}

											// For message items, add a log entry to the target tab
											let updatedAiTabs = s.aiTabs;
											if (nextItem.type === 'message' && nextItem.text) {
												const logEntry: LogEntry = {
													id: generateId(),
													timestamp: Date.now(),
													source: 'user',
													text: nextItem.text,
													images: nextItem.images,
												};
												updatedAiTabs = s.aiTabs.map((tab) =>
													tab.id === targetTab.id ? { ...tab, logs: [...tab.logs, logEntry] } : tab
												);
											}

											return {
												...s,
												state: 'busy' as SessionState,
												busySource: 'ai',
												aiTabs: updatedAiTabs,
												activeTabId: targetTab.id,
												executionQueue: remainingQueue,
												thinkingStartTime: Date.now(),
												currentCycleTokens: 0,
												currentCycleBytes: 0,
												pendingAICommandForSynopsis: undefined,
											};
										}

										// No queued items - set to idle
										// Set ALL busy tabs to 'idle' for write-mode tracking
										const updatedAiTabs =
											s.aiTabs?.length > 0
												? s.aiTabs.map((tab) =>
														tab.state === 'busy'
															? { ...tab, state: 'idle' as const, thinkingStartTime: undefined }
															: tab
													)
												: s.aiTabs;

										return {
											...s,
											state: 'idle' as SessionState,
											busySource: undefined,
											thinkingStartTime: undefined,
											pendingAICommandForSynopsis: undefined,
											aiTabs: updatedAiTabs,
										};
									})
								);

								// Process queued item AFTER state update
								if (queuedItemToProcess && processQueuedItemRef.current) {
									setTimeout(() => {
										processQueuedItemRef.current!(
											queuedItemToProcess!.sessionId,
											queuedItemToProcess!.item
										);
									}, 0);
								}

								// For batch processing (Auto Run): if there are queued items from manual writes,
								// wait for the queue to drain before resolving. This ensures batch tasks don't
								// race with queued manual writes. Worktree mode can skip this since it operates
								// in a separate directory with no file conflicts.
								// Note: cwdOverride is set when worktree is enabled
								if (hasQueuedItems && !cwdOverride) {
									// Wait for queue to drain by polling session state
									// The queue is processed sequentially, so we wait until session becomes idle
									const waitForQueueDrain = () => {
										const checkSession = sessionsRef.current.find((s) => s.id === sessionId);
										if (
											!checkSession ||
											checkSession.state === 'idle' ||
											checkSession.executionQueue.length === 0
										) {
											// Queue drained or session idle - safe to continue batch
											void finalizeResolve();
										} else {
											// Queue still processing - check again
											setTimeout(waitForQueueDrain, 100);
										}
									};
									// Start polling after a short delay to let state update propagate
									setTimeout(waitForQueueDrain, 50);
								} else {
									// No queued items or worktree mode - resolve immediately
									void finalizeResolve();
								}
							}
						})
					);

					// Spawn the agent for batch processing
					// Use effectiveCwd which may be a worktree path for parallel execution
					const commandToUse = agent.path || agent.command;
					const { sendPromptViaStdin, sendPromptViaStdinRaw } = getStdinFlags({
						isSshSession: !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled,
						supportsStreamJsonInput: agent.capabilities?.supportsStreamJsonInput ?? false,
					});
					// Batch processing (Auto Run) should NOT use read-only mode - it needs to make changes
					window.maestro.process
						.spawn({
							sessionId: targetSessionId,
							toolType: session.toolType,
							cwd: effectiveCwd,
							command: commandToUse,
							args: agent.args || [],
							prompt,
							readOnlyMode: false, // Auto Run needs to make changes, not plan
							// Per-session config overrides (if set)
							sessionCustomPath: session.customPath,
							sessionCustomArgs: session.customArgs,
							sessionCustomEnvVars: session.customEnvVars,
							sessionCustomModel: session.customModel,
							sessionCustomContextWindow: session.customContextWindow,
							// Per-session SSH remote config (takes precedence over agent-level SSH config)
							sessionSshRemoteConfig: session.sessionSshRemoteConfig,
							sendPromptViaStdin,
							sendPromptViaStdinRaw,
						})
						.catch(() => {
							cleanup();
							resolve({ success: false });
						});
				});
			} catch (error) {
				console.error('Error spawning agent:', error);
				return { success: false };
			}
		},
		[
			accumulateUsageStats,
			processQueuedItemRef,
			runAutoRunTaskLoopValidation,
			sessionsRef,
			setSessions,
		]
	); // Uses sessionsRef for latest sessions

	/**
	 * Wrapper for slash commands that need to spawn an agent with just a prompt.
	 * Uses the active session's ID and working directory.
	 */
	const spawnAgentWithPrompt = useCallback(
		async (prompt: string): Promise<AgentSpawnResult> => {
			if (!activeSession) return { success: false };
			return spawnAgentForSession(activeSession.id, prompt);
		},
		[activeSession, spawnAgentForSession]
	);

	/**
	 * Spawn a background synopsis agent that resumes an old agent session.
	 * Used for generating summaries without affecting main session state.
	 *
	 * @param sessionId - The Maestro session ID (for logging/tracking)
	 * @param cwd - Working directory for the agent
	 * @param resumeAgentSessionId - The agent session ID to resume
	 * @param prompt - The prompt to send to the resumed session
	 * @param toolType - The agent type (defaults to claude-code for backwards compatibility)
	 */
	const spawnBackgroundSynopsis = useCallback(
		async (
			sessionId: string,
			cwd: string,
			resumeAgentSessionId: string,
			prompt: string,
			toolType: ToolType = 'claude-code',
			sessionConfig?: {
				customPath?: string;
				customArgs?: string;
				customEnvVars?: Record<string, string>;
				customModel?: string;
				customContextWindow?: number;
				sessionSshRemoteConfig?: {
					enabled: boolean;
					remoteId: string | null;
					workingDirOverride?: string;
				};
			}
		): Promise<AgentSpawnResult> => {
			try {
				const agent = await window.maestro.agents.get(toolType);
				if (!agent) {
					console.error(`[spawnBackgroundSynopsis] Agent not found for toolType: ${toolType}`);
					return { success: false };
				}

				// Use a unique target ID for background synopsis
				const targetSessionId = `${sessionId}-synopsis-${Date.now()}`;

				// Track this synopsis session for potential cancellation
				if (!activeSynopsisSessionsRef.current.has(sessionId)) {
					activeSynopsisSessionsRef.current.set(sessionId, new Set());
				}
				activeSynopsisSessionsRef.current.get(sessionId)!.add(targetSessionId);

				return new Promise((resolve) => {
					let agentSessionId: string | undefined;
					let responseText = '';
					let synopsisUsageStats: UsageStats | undefined;

					// Array to collect cleanup functions as listeners are registered
					const cleanupFns: (() => void)[] = [];

					const cleanup = () => {
						cleanupFns.forEach((fn) => fn());
						// Remove from tracking
						activeSynopsisSessionsRef.current.get(sessionId)?.delete(targetSessionId);
					};

					cleanupFns.push(
						window.maestro.process.onData((sid: string, data: string) => {
							if (sid === targetSessionId) {
								responseText += data;
							}
						})
					);

					cleanupFns.push(
						window.maestro.process.onSessionId((sid: string, capturedId: string) => {
							if (sid === targetSessionId) {
								agentSessionId = capturedId;
							}
						})
					);

					// Capture usage stats for this synopsis request
					cleanupFns.push(
						window.maestro.process.onUsage((sid: string, usageStats) => {
							if (sid === targetSessionId) {
								// Accumulate usage stats (there may be multiple events)
								synopsisUsageStats = accumulateUsageStats(synopsisUsageStats, usageStats);
							}
						})
					);

					cleanupFns.push(
						window.maestro.process.onExit((sid: string) => {
							if (sid === targetSessionId) {
								cleanup();
								resolve({
									success: true,
									response: responseText,
									agentSessionId,
									usageStats: synopsisUsageStats,
								});
							}
						})
					);

					// Spawn with session resume - the IPC handler will use the agent's resumeArgs builder
					// If no sessionConfig or no sessionSshRemoteConfig, try to get it from the main session (by sessionId)
					let effectiveSessionSshRemoteConfig = sessionConfig?.sessionSshRemoteConfig;
					if (!effectiveSessionSshRemoteConfig) {
						// Try to find the main session and use its SSH config
						const mainSession = sessionsRef.current.find((s) => s.id === sessionId);
						if (mainSession && mainSession.sessionSshRemoteConfig) {
							effectiveSessionSshRemoteConfig = mainSession.sessionSshRemoteConfig;
						}
					}
					const commandToUse = sessionConfig?.customPath || agent.path || agent.command;
					const { sendPromptViaStdin, sendPromptViaStdinRaw } = getStdinFlags({
						isSshSession: !!effectiveSessionSshRemoteConfig?.enabled,
						supportsStreamJsonInput: agent.capabilities?.supportsStreamJsonInput ?? false,
					});
					window.maestro.process
						.spawn({
							sessionId: targetSessionId,
							toolType,
							cwd,
							command: commandToUse,
							args: agent.args || [],
							prompt,
							agentSessionId: resumeAgentSessionId, // This triggers the agent's resume mechanism
							// Per-session config overrides (if set)
							sessionCustomPath: sessionConfig?.customPath,
							sessionCustomArgs: sessionConfig?.customArgs,
							sessionCustomEnvVars: sessionConfig?.customEnvVars,
							sessionCustomModel: sessionConfig?.customModel,
							sessionCustomContextWindow: sessionConfig?.customContextWindow,
							// Always use effective SSH remote config if available
							sessionSshRemoteConfig: effectiveSessionSshRemoteConfig,
							sendPromptViaStdin,
							sendPromptViaStdinRaw,
						})
						.catch(() => {
							cleanup();
							resolve({ success: false });
						});
				});
			} catch (error) {
				console.error('Error spawning background synopsis:', error);
				return { success: false };
			}
		},
		[accumulateUsageStats, sessionsRef]
	);

	/**
	 * Cancel all pending synopsis processes for a given maestro session ID.
	 * Called when user clicks Stop to prevent synopsis from running after interruption.
	 */
	const cancelPendingSynopsis = useCallback(async (maestroSessionId: string): Promise<void> => {
		const synopsisSessions = activeSynopsisSessionsRef.current.get(maestroSessionId);
		if (!synopsisSessions || synopsisSessions.size === 0) {
			return;
		}

		console.log('[cancelPendingSynopsis] Cancelling synopsis sessions for', maestroSessionId, {
			count: synopsisSessions.size,
			sessionIds: Array.from(synopsisSessions),
		});

		// Kill all active synopsis processes for this session
		const killPromises = Array.from(synopsisSessions).map(async (synopsisSessionId) => {
			try {
				await window.maestro.process.kill(synopsisSessionId);
				console.log('[cancelPendingSynopsis] Killed synopsis session:', synopsisSessionId);
			} catch (error) {
				// Process may have already exited
				console.warn(
					'[cancelPendingSynopsis] Failed to kill synopsis session:',
					synopsisSessionId,
					error
				);
			}
		});

		await Promise.all(killPromises);

		// Clear the tracking set
		activeSynopsisSessionsRef.current.delete(maestroSessionId);
	}, []);

	/**
	 * Show flash notification (bottom-right, auto-dismisses after 2 seconds).
	 */
	const showFlashNotification = useCallback(
		(message: string) => {
			setFlashNotification(message);
			setTimeout(() => setFlashNotification(null), 2000);
		},
		[setFlashNotification]
	);

	/**
	 * Show success flash notification (center screen, auto-dismisses after 2 seconds).
	 */
	const showSuccessFlash = useCallback(
		(message: string) => {
			setSuccessFlashNotification(message);
			setTimeout(() => setSuccessFlashNotification(null), 2000);
		},
		[setSuccessFlashNotification]
	);

	// Update refs for functions that need to be accessed from other callbacks
	spawnBackgroundSynopsisRef.current = spawnBackgroundSynopsis;
	spawnAgentWithPromptRef.current = spawnAgentWithPrompt;

	return {
		spawnAgentForSession,
		spawnAgentWithPrompt,
		spawnBackgroundSynopsis,
		spawnBackgroundSynopsisRef,
		spawnAgentWithPromptRef,
		showFlashNotification,
		showSuccessFlash,
		cancelPendingSynopsis,
	};
}
