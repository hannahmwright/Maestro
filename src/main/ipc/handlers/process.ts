import { ipcMain, BrowserWindow } from 'electron';
import Store from 'electron-store';
import { ProcessManager } from '../../process-manager';
import { AgentDetector } from '../../agents';
import { logger } from '../../utils/logger';
import { addBreadcrumb } from '../../utils/sentry';
import {
	withIpcErrorLogging,
	requireProcessManager,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import {
	dispatchProcessSpawn,
	type AgentConfigsData,
	type SpawnDispatchRequest,
} from '../../process-manager/dispatchSpawn';
import { getSshRemoteConfig, createSshRemoteStoreAdapter } from '../../utils/ssh-remote-resolver';
import type { SshRemoteConfig } from '../../../shared/types';
import type { UserInputRequestId, UserInputResponse } from '../../../shared/user-input-requests';
import {
	isCoreUpgradesEnabled,
	coreUpgradeOrchestrator,
	DebugFixLoopEngine,
	RepoContextService,
	buildTaskDiagnostics,
} from '../../core-upgrades';
import type {
	LoopExecutionMemory,
	PlannedFilePatch,
	ProposedFileEdit,
	TaskContractInput,
	TaskLifecycleEvent,
} from '../../core-upgrades/types';
import { MaestroSettings } from './persistence';

const LOG_CONTEXT = '[ProcessManager]';
const debugFixLoopEngine = new DebugFixLoopEngine();
const repoContextService = new RepoContextService();

/**
 * Helper to create handler options with consistent context
 */
const handlerOpts = (
	operation: string,
	extra?: Partial<CreateHandlerOptions>
): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
	...extra,
});

/**
 * Dependencies required for process handler registration
 */
export interface ProcessHandlerDependencies {
	getProcessManager: () => ProcessManager | null;
	getAgentDetector: () => AgentDetector | null;
	agentConfigsStore: Store<AgentConfigsData>;
	settingsStore: Store<MaestroSettings>;
	getMainWindow: () => BrowserWindow | null;
	sessionsStore: Store<{ sessions: any[] }>;
}

/**
 * Register all Process-related IPC handlers.
 *
 * These handlers manage process lifecycle operations:
 * - spawn: Start a new process for a session
 * - write: Send input to a process
 * - interrupt: Send SIGINT to a process
 * - kill: Terminate a process
 * - resize: Resize PTY dimensions
 * - getActiveProcesses: List all running processes
 * - runCommand: Execute a single command and capture output
 */
export function registerProcessHandlers(deps: ProcessHandlerDependencies): void {
	const { getProcessManager, getAgentDetector, agentConfigsStore, settingsStore, getMainWindow } =
		deps;

	// Spawn a new process for a session
	// Supports agent-specific argument builders for batch mode, JSON output, resume, read-only mode, YOLO mode
	ipcMain.handle(
		'process:spawn',
		withIpcErrorLogging(
			handlerOpts('spawn'),
			async (config: SpawnDispatchRequest) => {
				const processManager = requireProcessManager(getProcessManager);
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');
				const spawnTaskContract =
					isCoreUpgradesEnabled() && config.toolType !== 'terminal'
						? coreUpgradeOrchestrator.createTaskContract({
								goal:
									config.taskContractInput?.goal || `Execute task for session ${config.sessionId}`,
								repo_root: config.taskContractInput?.repo_root || config.cwd,
								language_profile: config.taskContractInput?.language_profile || 'ts_js',
								risk_level: config.taskContractInput?.risk_level || 'medium',
								allowed_commands: config.taskContractInput?.allowed_commands || [
									config.command,
									'npm test',
									'npm run lint',
									'npm run build',
								],
								done_gate_profile: config.taskContractInput?.done_gate_profile,
								max_changed_files: config.taskContractInput?.max_changed_files,
								metadata: {
									session_id: config.sessionId,
									tool_type: config.toolType,
									...(config.taskContractInput?.metadata || {}),
								},
							})
						: undefined;
				return dispatchProcessSpawn(
					{
						processManager,
						agentDetector,
						agentConfigsStore,
						settingsStore,
						getMainWindow,
					},
					config,
					{
						logContext: LOG_CONTEXT,
						spawnConfigOverrides: {
							taskContractInput: config.taskContractInput,
							taskContract: spawnTaskContract,
						},
					}
				);
			}
		)
	);

	// Write data to a process
	ipcMain.handle(
		'process:write',
		withIpcErrorLogging(handlerOpts('write'), async (sessionId: string, data: string) => {
			const processManager = requireProcessManager(getProcessManager);
			logger.debug(`Writing to process: ${sessionId}`, LOG_CONTEXT, {
				sessionId,
				dataLength: data.length,
			});
			return processManager.write(sessionId, data);
		})
	);

	ipcMain.handle(
		'process:respond-user-input',
		withIpcErrorLogging(
			handlerOpts('respond-user-input'),
			async (sessionId: string, requestId: UserInputRequestId, response: UserInputResponse) => {
				const processManager = requireProcessManager(getProcessManager);
				return processManager.respondToUserInput(sessionId, requestId, response);
			}
		)
	);

	// Send SIGINT to a process
	ipcMain.handle(
		'process:interrupt',
		withIpcErrorLogging(handlerOpts('interrupt'), async (sessionId: string) => {
			const processManager = requireProcessManager(getProcessManager);
			logger.info(`Interrupting process: ${sessionId}`, LOG_CONTEXT, { sessionId });
			return processManager.interrupt(sessionId);
		})
	);

	// Kill a process
	ipcMain.handle(
		'process:kill',
		withIpcErrorLogging(handlerOpts('kill'), async (sessionId: string) => {
			const processManager = requireProcessManager(getProcessManager);
			logger.info(`Killing process: ${sessionId}`, LOG_CONTEXT, { sessionId });
			// Add breadcrumb for crash diagnostics (MAESTRO-5A/4Y)
			await addBreadcrumb('agent', `Kill: ${sessionId}`, { sessionId });
			return processManager.kill(sessionId);
		})
	);

	// Resize PTY dimensions
	ipcMain.handle(
		'process:resize',
		withIpcErrorLogging(
			handlerOpts('resize'),
			async (sessionId: string, cols: number, rows: number) => {
				const processManager = requireProcessManager(getProcessManager);
				return processManager.resize(sessionId, cols, rows);
			}
		)
	);

	// Get all active processes managed by the ProcessManager
	ipcMain.handle(
		'process:getActiveProcesses',
		withIpcErrorLogging(handlerOpts('getActiveProcesses'), async () => {
			const processManager = requireProcessManager(getProcessManager);
			const processes = processManager.getAll();
			// Return serializable process info (exclude non-serializable PTY/child process objects)
			return processes.map((p) => ({
				sessionId: p.sessionId,
				toolType: p.toolType,
				pid: p.pid,
				cwd: p.cwd,
				isTerminal: p.isTerminal,
				isBatchMode: p.isBatchMode || false,
				startTime: p.startTime,
				command: p.command,
				args: p.args,
			}));
		})
	);

	ipcMain.handle(
		'process:createTaskContract',
		withIpcErrorLogging(handlerOpts('createTaskContract'), async (input: TaskContractInput) => {
			return coreUpgradeOrchestrator.createTaskContract(input);
		})
	);

	ipcMain.handle(
		'orchestrator:createTaskContract',
		withIpcErrorLogging(
			handlerOpts('orchestratorCreateTaskContract'),
			async (input: TaskContractInput) => coreUpgradeOrchestrator.createTaskContract(input)
		)
	);

	ipcMain.handle(
		'process:getTaskContract',
		withIpcErrorLogging(handlerOpts('getTaskContract'), async (sessionId: string) => {
			const processManager = requireProcessManager(getProcessManager);
			return processManager.getTaskContract(sessionId) || null;
		})
	);

	// Run a single command and capture only stdout/stderr (no PTY echo/prompts)
	// Supports SSH remote execution when sessionSshRemoteConfig is provided
	// When taskContractInput is supplied and MAESTRO_CORE_UPGRADES!=off, this executes
	// through the strict debug/fix loop with triage/review/gate lifecycle events.
	ipcMain.handle(
		'process:runCommand',
		withIpcErrorLogging(
			handlerOpts('runCommand'),
			async (config: {
				sessionId: string;
				command: string;
				cwd: string;
				shell?: string;
				sessionSshRemoteConfig?: {
					enabled: boolean;
					remoteId: string | null;
					workingDirOverride?: string;
				};
				taskContractInput?: Partial<TaskContractInput>;
				proposedEdits?: ProposedFileEdit[];
				plannedPatches?: PlannedFilePatch[];
				relatedFiles?: string[];
				changedFiles?: string[];
				diffText?: string;
				fullSuiteCommand?: string;
			}) => {
				const processManager = requireProcessManager(getProcessManager);

				// Get the shell from settings if not provided.
				let shell = config.shell || settingsStore.get('defaultShell', 'zsh');
				const customShellPath = settingsStore.get('customShellPath', '');
				if (customShellPath && customShellPath.trim()) {
					shell = customShellPath.trim();
				}

				const shellEnvVars = settingsStore.get('shellEnvVars', {}) as Record<string, string>;

				// Resolve SSH remote config when provided.
				let sshRemoteConfig: SshRemoteConfig | null = null;
				if (config.sessionSshRemoteConfig?.enabled && config.sessionSshRemoteConfig?.remoteId) {
					const sshStoreAdapter = createSshRemoteStoreAdapter(settingsStore);
					const sshResult = getSshRemoteConfig(sshStoreAdapter, {
						sessionSshConfig: config.sessionSshRemoteConfig,
					});

					if (sshResult.config) {
						sshRemoteConfig = sshResult.config;
						logger.info(`Terminal command will execute via SSH`, LOG_CONTEXT, {
							sessionId: config.sessionId,
							remoteName: sshResult.config.name,
							remoteHost: sshResult.config.host,
							source: sshResult.source,
						});
					}
				}

				const runSingleCommand = (commandToRun: string) =>
					processManager.runCommand(
						config.sessionId,
						commandToRun,
						config.cwd,
						shell,
						shellEnvVars,
						sshRemoteConfig
					);

				logger.debug(`Running command: ${config.command}`, LOG_CONTEXT, {
					sessionId: config.sessionId,
					cwd: config.cwd,
					shell,
					hasCustomEnvVars: Object.keys(shellEnvVars).length > 0,
					sshRemote: sshRemoteConfig?.name || null,
					coreUpgrades: isCoreUpgradesEnabled(),
					hasTaskContractInput: !!config.taskContractInput,
				});

				if (isCoreUpgradesEnabled() && config.taskContractInput) {
					const taskContractInput = config.taskContractInput || {};
					const task = coreUpgradeOrchestrator.createTaskContract({
						goal: taskContractInput.goal || `Resolve command task: ${config.command}`,
						repo_root: taskContractInput.repo_root || config.cwd,
						language_profile: taskContractInput.language_profile || 'ts_js',
						risk_level: taskContractInput.risk_level || 'medium',
						allowed_commands: taskContractInput.allowed_commands || [
							config.command,
							'npm test',
							'npm run build',
							'npm run lint',
						],
						done_gate_profile: taskContractInput.done_gate_profile,
						max_changed_files: taskContractInput.max_changed_files,
						metadata: taskContractInput.metadata,
					});

					const retrievalMode =
						config.diffText && (config.changedFiles || []).length > 0
							? 'review_focused'
							: (config.proposedEdits || []).length > 0
								? 'edit_focused'
								: 'failure_focused';
					const sessionMemoryKey = `session:${config.sessionId}:strict-loop`;
					const projectStrategyMemoryKey = 'project:strict-loop-strategy';
					const lifecycleEvents: TaskLifecycleEvent[] = [];
					let contextPack: Awaited<ReturnType<typeof repoContextService.getContextPack>> | null =
						null;
					let priorLoopMemory: Partial<LoopExecutionMemory> | undefined;
					try {
						contextPack = await repoContextService.getContextPack({
							repoRoot: task.repo_root,
							mode: retrievalMode,
							seedFiles: config.relatedFiles || config.changedFiles || [],
							depth: 1,
							reason: 'initial',
							maxFiles: 6,
						});
						const memoryEntry = await repoContextService.getTaskMemory(
							task.repo_root,
							sessionMemoryKey
						);
						if (memoryEntry && typeof memoryEntry === 'object' && 'loop_memory' in memoryEntry) {
							priorLoopMemory = memoryEntry.loop_memory as Partial<LoopExecutionMemory>;
						}
						const projectMemoryEntry = await repoContextService.getTaskMemory(
							task.repo_root,
							projectStrategyMemoryKey
						);
						if (
							projectMemoryEntry &&
							typeof projectMemoryEntry === 'object' &&
							'loop_memory' in projectMemoryEntry
						) {
							priorLoopMemory = {
								...(projectMemoryEntry.loop_memory as Partial<LoopExecutionMemory>),
								...(priorLoopMemory || {}),
								failure_fingerprints: {
									...((projectMemoryEntry.loop_memory as Partial<LoopExecutionMemory>)
										.failure_fingerprints || {}),
									...(priorLoopMemory?.failure_fingerprints || {}),
								},
								module_area_memory: {
									...((projectMemoryEntry.loop_memory as Partial<LoopExecutionMemory>)
										.module_area_memory || {}),
									...(priorLoopMemory?.module_area_memory || {}),
								},
							};
						}
					} catch (error) {
						logger.warn('Failed to build context pack for task loop', LOG_CONTEXT, {
							sessionId: config.sessionId,
							error: String(error),
						});
					}

					const loopResult = await debugFixLoopEngine.run(
						{
							session_id: config.sessionId,
							task,
							cwd: config.cwd,
							initial_command: config.command,
							full_suite_command: config.fullSuiteCommand,
							proposed_edits: config.proposedEdits,
							planned_patches: config.plannedPatches,
							related_files: config.relatedFiles,
							changed_files: config.changedFiles,
							diff_text: config.diffText,
							prior_memory: priorLoopMemory,
						},
						{
							runCommand: runSingleCommand,
							getContextPack: async (request) => {
								const pack = await repoContextService.getContextPack({
									repoRoot: task.repo_root,
									mode: request.mode,
									seedFiles: request.seedFiles,
									seedSymbols: request.seedSymbols,
									depth: request.depth,
									reason: request.reason,
									maxFiles: request.maxFiles,
								});
								return {
									selectedFiles: pack.selectedFiles,
									impactedSymbols: pack.impactedSymbols,
									bridgeFiles: pack.bridgeFiles,
									bridgeSymbols: pack.bridgeSymbols,
									selection_narratives: pack.selectionNarratives.map((entry) => ({
										file_path: entry.filePath,
										reason: entry.reason,
										path: entry.path,
									})),
								};
							},
							getGraphScores: (request) =>
								repoContextService.scoreCandidates({
									repoRoot: task.repo_root,
									seedFiles: request.seedFiles,
									candidateFiles: request.candidateFiles,
									seedSymbols: request.seedSymbols,
									maxDepth: request.maxDepth,
								}),
							emitLifecycle: (event) => {
								lifecycleEvents.push(event);
								processManager.emit('task-lifecycle', config.sessionId, event);
							},
						}
					);
					const taskDiagnostics = buildTaskDiagnostics({
						task,
						result: loopResult,
						lifecycleEvents,
						retrievalMode,
						contextSelectedFiles: contextPack?.selectedFiles.length,
					});
					processManager.emit('task-status', config.sessionId, taskDiagnostics);

					const finalAttempt = loopResult.attempts[loopResult.attempts.length - 1];
					try {
						await repoContextService.updateTaskMemory(task.repo_root, task.task_id, {
							last_status: loopResult.status,
							last_reason: loopResult.reason || null,
							attempt_count: loopResult.attempts.length,
							diagnostics: taskDiagnostics,
							updated_at: Date.now(),
						});
						await repoContextService.updateTaskMemory(task.repo_root, sessionMemoryKey, {
							loop_memory: loopResult.memory_state || null,
							last_selected_hypothesis_id:
								loopResult.attempts[loopResult.attempts.length - 1]?.selected_hypothesis_id || null,
							updated_at: Date.now(),
						});
						await repoContextService.updateTaskMemory(task.repo_root, projectStrategyMemoryKey, {
							loop_memory: loopResult.memory_state || null,
							updated_at: Date.now(),
						});
					} catch (error) {
						logger.warn('Failed to persist task memory for strict loop', LOG_CONTEXT, {
							sessionId: config.sessionId,
							taskId: task.task_id,
							error: String(error),
						});
					}
					return {
						exitCode: loopResult.status === 'complete' ? 0 : (finalAttempt?.result.exit_code ?? 1),
						stdout: finalAttempt?.result.stdout,
						stderr: finalAttempt?.result.stderr,
						durationMs: finalAttempt?.result.duration_ms,
						taskResult: loopResult,
						contextPack,
						taskDiagnostics,
					};
				}

				return runSingleCommand(config.command);
			}
		)
	);
}
