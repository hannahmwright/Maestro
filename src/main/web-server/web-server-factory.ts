/**
 * Web server factory for creating and configuring the web server.
 * Extracted from main/index.ts for better modularity.
 */

import { BrowserWindow, ipcMain } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebServer } from './WebServer';
import { getAgentCapabilities, type AgentDetector } from '../agents';
import { getThemeById } from '../themes';
import { getHistoryManager } from '../history-manager';
import { logger } from '../utils/logger';
import { isWebContentsAvailable } from '../utils/safe-send';
import { execFileNoThrow } from '../utils/execFile';
import { execGit } from '../utils/remote-git';
import {
	parseCodexModelFromToml,
	readLocalCodexModel,
	readRemoteCodexModel,
} from '../utils/codex-config';
import type { ProcessManager } from '../process-manager';
import type { StoredSession } from '../stores/types';
import { CODEX_DEFAULT_FONT_STACK } from '../../shared/fonts';
import type { Theme } from '../../shared/theme-types';
import type { Group } from '../../shared/types';
import type { SshRemoteConfig } from '../../shared/types';
import { countUncommittedChanges } from '../../shared/gitUtils';
import { VoiceTranscriptionManager } from '../voice-transcription-manager';
import { getDemoArtifactService } from '../artifacts';

/** Store interface for settings */
interface SettingsStore {
	get<T>(key: string, defaultValue?: T): T;
}

/** Store interface for sessions */
interface SessionsStore {
	get<T>(key: string, defaultValue?: T): T;
}

/** Store interface for groups */
interface GroupsStore {
	get<T>(key: string, defaultValue?: T): T;
}

/** Dependencies required for creating the web server */
export interface WebServerFactoryDependencies {
	/** Settings store for reading web interface configuration */
	settingsStore: SettingsStore;
	/** Sessions store for reading session data */
	sessionsStore: SessionsStore;
	/** Groups store for reading group data */
	groupsStore: GroupsStore;
	/** Function to get the main window reference */
	getMainWindow: () => BrowserWindow | null;
	/** Function to get the process manager reference */
	getProcessManager: () => ProcessManager | null;
	/** Function to get the agent detector reference */
	getAgentDetector: () => AgentDetector | null;
	/** Function to get the merged config for an agent */
	getAgentConfig: (agentId: string) => Record<string, any>;
	/** Function to get the current userData path */
	getUserDataPath: () => string;
}

/**
 * Creates a factory function for creating web servers with the given dependencies.
 * This allows dependency injection and makes the code more testable.
 */
export function createWebServerFactory(deps: WebServerFactoryDependencies) {
	const {
		settingsStore,
		sessionsStore,
		groupsStore,
		getMainWindow,
		getProcessManager,
		getAgentDetector,
		getAgentConfig,
		getUserDataPath,
	} = deps;
	const gitFileCountCache = new Map<string, { count: number; updatedAt: number }>();
	const GIT_FILE_COUNT_TTL_MS = 15000;
	const effectiveModelCache = new Map<string, { model: string | null; updatedAt: number }>();
	const EFFECTIVE_MODEL_TTL_MS = 30000;
	const voiceTranscriptionManager = new VoiceTranscriptionManager(getUserDataPath());

	function inferHomeFromPath(candidate: unknown): string | null {
		if (typeof candidate !== 'string' || !candidate.startsWith('/')) {
			return null;
		}

		const segments = candidate.split('/').filter(Boolean);
		if (segments.length >= 2 && (segments[0] === 'Users' || segments[0] === 'home')) {
			return `/${segments[0]}/${segments[1]}`;
		}

		return null;
	}

	function getLocalHomeCandidates(session: StoredSession): string[] {
		const homeCandidates = new Set<string>();
		const envHome = process.env.HOME?.trim();
		if (envHome) {
			homeCandidates.add(envHome);
		}

		const osHome = os.homedir().trim();
		if (osHome) {
			homeCandidates.add(osHome);
		}

		for (const inferredHome of [
			inferHomeFromPath(session.cwd),
			inferHomeFromPath(session.projectRoot),
		]) {
			if (inferredHome) {
				homeCandidates.add(inferredHome);
			}
		}

		return Array.from(homeCandidates);
	}

	function readCodexModelFromCandidateHomes(session: StoredSession): string | null {
		for (const home of getLocalHomeCandidates(session)) {
			try {
				const configPath = path.join(home, '.codex', 'config.toml');
				if (!fs.existsSync(configPath)) {
					continue;
				}

				const content = fs.readFileSync(configPath, 'utf8');
				const model = parseCodexModelFromToml(content);
				if (model) {
					return model;
				}
			} catch (error) {
				logger.debug('Failed to read local Codex model from candidate home', 'WebServerFactory', {
					home,
					error,
				});
			}
		}

		return readLocalCodexModel();
	}

	async function readCodexModelFromLocalShell(session: StoredSession): Promise<string | null> {
		for (const home of getLocalHomeCandidates(session)) {
			const configPath = path.join(home, '.codex', 'config.toml');
			const escapedPath = configPath.replace(/'/g, `'\\''`);

			try {
				const result = await execFileNoThrow('sh', [
					'-lc',
					`if [ -f '${escapedPath}' ]; then cat '${escapedPath}'; fi`,
				]);
				if (result.exitCode !== 0 || !result.stdout.trim()) {
					continue;
				}
				const model = parseCodexModelFromToml(result.stdout);
				if (model) {
					return model;
				}
			} catch (error) {
				logger.debug('Failed to read local Codex model via shell fallback', 'WebServerFactory', {
					home,
					error,
				});
			}
		}

		return null;
	}

	function getSshRemoteConfig(session: StoredSession): SshRemoteConfig | null {
		if (!session.sessionSshRemoteConfig?.enabled || !session.sessionSshRemoteConfig.remoteId) {
			return null;
		}

		const sshRemotes = settingsStore.get<SshRemoteConfig[]>('sshRemotes', []);
		return (
			sshRemotes.find(
				(remote) => remote.id === session.sessionSshRemoteConfig.remoteId && remote.enabled
			) || null
		);
	}

	async function getGitFileCount(session: StoredSession): Promise<number> {
		if (!session.isGitRepo) {
			return 0;
		}

		const cached = gitFileCountCache.get(session.id);
		if (cached && Date.now() - cached.updatedAt < GIT_FILE_COUNT_TTL_MS) {
			return cached.count;
		}

		try {
			const sshRemote = getSshRemoteConfig(session);
			const remoteCwd =
				session.sessionSshRemoteConfig?.workingDirOverride || session.remoteCwd || session.cwd;
			const result = await execGit(
				['status', '--porcelain'],
				session.cwd,
				sshRemote,
				sshRemote ? remoteCwd : undefined
			);
			const count = result.exitCode === 0 ? countUncommittedChanges(result.stdout || '') : 0;
			gitFileCountCache.set(session.id, { count, updatedAt: Date.now() });
			return count;
		} catch (error) {
			logger.warn(`Failed to fetch git file count for session ${session.id}`, 'WebServerFactory', {
				error,
			});
			return cached?.count ?? 0;
		}
	}

	async function getEffectiveModelLabel(
		session: StoredSession,
		activeTabCurrentModel?: string | null
	): Promise<string | null> {
		if (typeof activeTabCurrentModel === 'string' && activeTabCurrentModel.trim()) {
			return activeTabCurrentModel.trim();
		}

		if (typeof session.customModel === 'string' && session.customModel.trim()) {
			return session.customModel.trim();
		}

		if (session.toolType !== 'codex') {
			return null;
		}

		const cached = effectiveModelCache.get(session.id);
		if (cached && Date.now() - cached.updatedAt < EFFECTIVE_MODEL_TTL_MS) {
			return cached.model;
		}

		try {
			const sshRemote = getSshRemoteConfig(session);
			const model = sshRemote
				? await readRemoteCodexModel(sshRemote)
				: readCodexModelFromCandidateHomes(session) ||
					(await readCodexModelFromLocalShell(session));
			effectiveModelCache.set(session.id, { model, updatedAt: Date.now() });
			return model;
		} catch (error) {
			logger.debug(
				`Failed to resolve effective model for session ${session.id}`,
				'WebServerFactory',
				{
					error,
				}
			);
			return cached?.model ?? null;
		}
	}

	function getEffectiveContextWindow(
		session: StoredSession,
		activeTabContextWindow?: number | null
	): number | null {
		if (typeof session.customContextWindow === 'number' && session.customContextWindow > 0) {
			return session.customContextWindow;
		}

		const agentConfig = getAgentConfig(session.toolType);
		if (typeof agentConfig?.contextWindow === 'number' && agentConfig.contextWindow > 0) {
			return agentConfig.contextWindow;
		}

		if (typeof activeTabContextWindow === 'number' && activeTabContextWindow > 0) {
			return activeTabContextWindow;
		}

		if (
			typeof session.usageStats?.contextWindow === 'number' &&
			session.usageStats.contextWindow > 0
		) {
			return session.usageStats.contextWindow;
		}

		return null;
	}

	/**
	 * Create and configure the web server with all necessary callbacks.
	 * Called when user enables the web interface.
	 */
	return function createWebServer(): WebServer {
		// Use custom port if enabled, otherwise 0 for random port assignment
		const useCustomPort = settingsStore.get('webInterfaceUseCustomPort', false);
		const customPort = settingsStore.get('webInterfaceCustomPort', 8080);
		const port = useCustomPort ? customPort : 0;
		const server = new WebServer(port); // Custom or random port with auto-generated security token

		// Set up callback for web server to fetch sessions list
		server.setGetSessionsCallback(async () => {
			const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
			const groups = groupsStore.get<Group[]>('groups', []);
			return Promise.all(
				sessions.map(async (s) => {
					// Find the group for this session
					const group = s.groupId ? groups.find((g) => g.id === s.groupId) : null;
					const gitFileCount = await getGitFileCount(s);

					// Extract last AI response for mobile preview (first 3 lines, max 500 chars)
					// Use active tab's logs as the source of truth
					let lastResponse = null;
					const activeTab = s.aiTabs?.find((t: any) => t.id === s.activeTabId) || s.aiTabs?.[0];
					const tabLogs = activeTab?.logs || [];
					if (tabLogs.length > 0) {
						// Find the last stdout/stderr entry from the AI (not user messages)
						// Note: 'thinking' logs are already excluded since they have a distinct source type
						const lastAiLog = [...tabLogs]
							.reverse()
							.find(
								(log: any) =>
									log.source === 'stdout' || log.source === 'stderr' || log.source === 'ai'
							);
						if (lastAiLog && lastAiLog.text) {
							const fullText = lastAiLog.text;
							// Get first 3 lines or 500 chars, whichever is shorter
							const lines = fullText.split('\n').slice(0, 3);
							let previewText = lines.join('\n');
							if (previewText.length > 500) {
								previewText = previewText.slice(0, 497) + '...';
							} else if (fullText.length > previewText.length) {
								previewText = previewText + '...';
							}
							lastResponse = {
								text: previewText,
								timestamp: lastAiLog.timestamp,
								source: lastAiLog.source,
								fullLength: fullText.length,
							};
						}
					}

					// Map aiTabs to web-safe format (strip logs to reduce payload)
					const aiTabs =
						s.aiTabs?.map((tab: any) => ({
							id: tab.id,
							agentSessionId: tab.agentSessionId || null,
							name: tab.name || null,
							starred: tab.starred || false,
							hasUnread: !!tab.hasUnread,
							inputValue: tab.inputValue || '',
							usageStats: tab.usageStats || null,
							createdAt: tab.createdAt,
							state: tab.state || 'idle',
							thinkingStartTime: tab.thinkingStartTime || null,
							currentModel: tab.currentModel || null,
						})) || [];
					const activeTabId = s.activeTabId || (aiTabs.length > 0 ? aiTabs[0].id : undefined);
					const activeTabSummary = activeTabId
						? aiTabs.find((tab: { id: string }) => tab.id === activeTabId)
						: null;
					const effectiveModelLabel = await getEffectiveModelLabel(
						s,
						activeTabSummary?.currentModel || null
					);
					const effectiveContextWindow = getEffectiveContextWindow(
						s,
						activeTabSummary?.usageStats?.contextWindow ?? null
					);

					return {
						id: s.id,
						name: s.name,
						toolType: s.toolType,
						state: s.state,
						inputMode: s.inputMode,
						cwd: s.cwd,
						groupId: s.groupId || null,
						groupName: group?.name || null,
						groupEmoji: group?.emoji || null,
						contextUsage: s.contextUsage,
						effectiveContextWindow,
						usageStats: s.usageStats || null,
						lastResponse,
						agentSessionId: s.agentSessionId || null,
						thinkingStartTime: s.thinkingStartTime || null,
						aiTabs,
						activeTabId,
						isGitRepo: s.isGitRepo || false,
						gitFileCount,
						customModel: s.customModel || null,
						effectiveModelLabel,
						supportsModelSelection: getAgentCapabilities(s.toolType).supportsModelSelection,
						bookmarked: s.bookmarked || false,
						// Worktree subagent support
						parentSessionId: s.parentSessionId || null,
						worktreeBranch: s.worktreeBranch || null,
					};
				})
			);
		});

		// Set up callback for web server to fetch single session details
		// Optional tabId param allows fetching logs for a specific tab (avoids race conditions)
		server.setGetSessionDetailCallback((sessionId: string, tabId?: string) => {
			const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
			const session = sessions.find((s) => s.id === sessionId);
			if (!session) return null;

			// Get the requested tab's logs (or active tab if no tabId provided)
			// Tabs are the source of truth for AI conversation history
			let aiLogs: any[] = [];
			let resolvedTabId = tabId || session.activeTabId;
			if (session.aiTabs && session.aiTabs.length > 0) {
				const requestedTab = tabId ? session.aiTabs.find((t: any) => t.id === tabId) : null;
				const targetTab =
					requestedTab ||
					session.aiTabs.find((t: any) => t.id === session.activeTabId) ||
					session.aiTabs[0];

				// If the caller asked for a specific tab that does not exist yet
				// (for example, an optimistic pending tab on mobile), don't leak a
				// different tab's history into the response.
				aiLogs = tabId && !requestedTab ? [] : targetTab?.logs || [];
				resolvedTabId = targetTab?.id || resolvedTabId;
			}

			return {
				id: session.id,
				name: session.name,
				toolType: session.toolType,
				state: session.state,
				inputMode: session.inputMode,
				cwd: session.cwd,
				aiLogs,
				shellLogs: session.shellLogs || [],
				usageStats: session.usageStats,
				agentSessionId: session.agentSessionId,
				isGitRepo: session.isGitRepo,
				activeTabId: resolvedTabId,
				customModel: session.customModel || null,
				supportsModelSelection: getAgentCapabilities(session.toolType).supportsModelSelection,
			};
		});

		server.setGetSessionModelsCallback(async (sessionId: string, forceRefresh?: boolean) => {
			const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
			const session = sessions.find((s) => s.id === sessionId);
			if (!session) {
				return [];
			}

			if (!getAgentCapabilities(session.toolType).supportsModelSelection) {
				return [];
			}

			const agentDetector = getAgentDetector();
			if (!agentDetector) {
				logger.warn('agentDetector is null for getSessionModels', 'WebServer');
				return [];
			}

			return agentDetector.discoverModels(session.toolType, forceRefresh ?? false);
		});

		server.setSetSessionModelCallback(async (sessionId: string, model: string | null) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for setSessionModel', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for setSessionModel', 'WebServer');
				return false;
			}

			mainWindow.webContents.send('remote:setSessionModel', sessionId, model);
			return true;
		});

		server.setTranscribeAudioCallback(async (request) =>
			voiceTranscriptionManager.transcribeAudio(request)
		);
		server.setGetVoiceTranscriptionStatusCallback(() => voiceTranscriptionManager.getStatus());
		server.setPrewarmVoiceTranscriptionCallback(() => voiceTranscriptionManager.prewarm());

		// Set up callback for web server to fetch current theme
		server.setGetThemeCallback((): Theme | null => {
			const themeId = settingsStore.get('activeThemeId', 'dracula');
			const theme = getThemeById(themeId);
			if (!theme) {
				return null;
			}
			return {
				...theme,
				fontFamily: settingsStore.get('fontFamily', CODEX_DEFAULT_FONT_STACK),
			};
		});

		// Set up callback for web server to fetch custom AI commands
		server.setGetCustomCommandsCallback(() => {
			const customCommands = settingsStore.get('customAICommands', []) as Array<{
				id: string;
				command: string;
				description: string;
				prompt: string;
			}>;
			return customCommands;
		});

		// Set up callback for web server to fetch history entries
		// Uses HistoryManager for per-session storage
		server.setGetHistoryCallback((projectPath?: string, sessionId?: string) => {
			const historyManager = getHistoryManager();

			if (sessionId) {
				// Get entries for specific session
				const entries = historyManager.getEntries(sessionId);
				// Sort by timestamp descending
				entries.sort((a, b) => b.timestamp - a.timestamp);
				return entries;
			}

			if (projectPath) {
				// Get all entries for sessions in this project
				return historyManager.getEntriesByProjectPath(projectPath);
			}

			// Return all entries (for global view)
			return historyManager.getAllEntries();
		});

		// Set up callback for web server to write commands to sessions
		// Note: Process IDs have -ai or -terminal suffix based on session's inputMode
		server.setWriteToSessionCallback((sessionId: string, data: string) => {
			const processManager = getProcessManager();
			if (!processManager) {
				logger.warn('processManager is null for writeToSession', 'WebServer');
				return false;
			}

			// Get the session's current inputMode to determine which process to write to
			const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
			const session = sessions.find((s) => s.id === sessionId);
			if (!session) {
				logger.warn(`Session ${sessionId} not found for writeToSession`, 'WebServer');
				return false;
			}

			// Append -ai or -terminal suffix based on inputMode
			const targetSessionId =
				session.inputMode === 'ai' ? `${sessionId}-ai` : `${sessionId}-terminal`;
			logger.debug(`Writing to ${targetSessionId} (inputMode=${session.inputMode})`, 'WebServer');

			const result = processManager.write(targetSessionId, data);
			logger.debug(`Write result: ${result}`, 'WebServer');
			return result;
		});

		// Set up callback for web server to execute commands through the desktop
		// This forwards AI commands to the renderer, ensuring single source of truth
		// The renderer handles all spawn logic, state management, and broadcasts
		server.setExecuteCommandCallback(
			async (
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
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
				demoCapture?: import('../../shared/demo-artifacts').DemoCaptureRequest
			) => {
				const mainWindow = getMainWindow();
				if (!mainWindow) {
					logger.warn('mainWindow is null for executeCommand', 'WebServer');
					return false;
				}

				// Look up the session to get Claude session ID for logging
				const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
				const session = sessions.find((s) => s.id === sessionId);
				const agentSessionId = session?.agentSessionId || 'none';

				// Forward to renderer - it will handle spawn, state, and everything else
				// This ensures web commands go through exact same code path as desktop commands
				// Pass inputMode so renderer uses the web's intended mode (avoids sync issues)
				logger.info(
					`[Web → Renderer] Forwarding command | Maestro: ${sessionId} | Claude: ${agentSessionId} | Mode: ${inputMode || 'auto'} | Command: ${command.substring(0, 100)}`,
					'WebServer'
				);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for executeCommand', 'WebServer');
					return false;
				}
				mainWindow.webContents.send(
					'remote:executeCommand',
					sessionId,
					command,
					inputMode,
					images,
					textAttachments,
					attachments,
					demoCapture
				);
				return true;
			}
		);
		server.setGetSessionDemosCallback((sessionId: string, tabId?: string | null) =>
			getDemoArtifactService().listSessionDemos(sessionId, tabId)
		);
		server.setGetDemoDetailCallback((demoId: string) => getDemoArtifactService().getDemo(demoId));
		server.setGetArtifactContentCallback((artifactId: string) => {
			const artifact = getDemoArtifactService().getArtifactRecord(artifactId);
			if (!artifact) {
				return null;
			}
			return {
				path: artifact.storedPath,
				mimeType: artifact.mimeType,
				filename: artifact.filename,
			};
		});

		// Set up callback for web server to interrupt sessions through the desktop
		// This forwards to the renderer which handles state updates and broadcasts
		server.setInterruptSessionCallback(async (sessionId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for interrupt', 'WebServer');
				return false;
			}

			// Forward to renderer - it will handle interrupt, state update, and broadcasts
			// This ensures web interrupts go through exact same code path as desktop interrupts
			logger.debug(`Forwarding interrupt to renderer for session ${sessionId}`, 'WebServer');
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for interrupt', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:interrupt', sessionId);
			return true;
		});

		// Set up callback for web server to switch session mode through the desktop
		// This forwards to the renderer which handles state updates and broadcasts
		server.setSwitchModeCallback(async (sessionId: string, mode: 'ai' | 'terminal') => {
			logger.info(
				`[Web→Desktop] Mode switch callback invoked: session=${sessionId}, mode=${mode}`,
				'WebServer'
			);
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for switchMode', 'WebServer');
				return false;
			}

			// Forward to renderer - it will handle mode switch and broadcasts
			// This ensures web mode switches go through exact same code path as desktop
			logger.info(`[Web→Desktop] Sending IPC remote:switchMode to renderer`, 'WebServer');
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for switchMode', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:switchMode', sessionId, mode);
			return true;
		});

		// Set up callback for web server to select/switch to a session in the desktop
		// This forwards to the renderer which handles state updates and broadcasts
		// If tabId is provided, also switches to that tab within the session
		server.setSelectSessionCallback(async (sessionId: string, tabId?: string) => {
			logger.info(
				`[Web→Desktop] Session select callback invoked: session=${sessionId}, tab=${tabId || 'none'}`,
				'WebServer'
			);
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for selectSession', 'WebServer');
				return false;
			}

			// Forward to renderer - it will handle session selection and broadcasts
			logger.info(`[Web→Desktop] Sending IPC remote:selectSession to renderer`, 'WebServer');
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for selectSession', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:selectSession', sessionId, tabId);
			return true;
		});

		// Tab operation callbacks
		server.setSelectTabCallback(async (sessionId: string, tabId: string) => {
			logger.info(
				`[Web→Desktop] Tab select callback invoked: session=${sessionId}, tab=${tabId}`,
				'WebServer'
			);
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for selectTab', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for selectTab', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:selectTab', sessionId, tabId);
			return true;
		});

		server.setNewTabCallback(async (sessionId: string) => {
			logger.info(`[Web→Desktop] New tab callback invoked: session=${sessionId}`, 'WebServer');
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for newTab', 'WebServer');
				return null;
			}

			// Use invoke for synchronous response with tab ID
			return new Promise((resolve) => {
				const responseChannel = `remote:newTab:response:${Date.now()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for newTab', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(null);
					return;
				}
				mainWindow.webContents.send('remote:newTab', sessionId, responseChannel);

				// Timeout after 5 seconds - clean up the listener to prevent memory leak
				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`newTab callback timed out for session ${sessionId}`, 'WebServer');
					resolve(null);
				}, 5000);
			});
		});

		server.setDeleteSessionCallback(async (sessionId: string) => {
			logger.info(
				`[Web→Desktop] Delete session callback invoked: session=${sessionId}`,
				'WebServer'
			);
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for deleteSession', 'WebServer');
				return false;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:deleteSession:response:${Date.now()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, success: boolean) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(!!success);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for deleteSession', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(false);
					return;
				}
				mainWindow.webContents.send('remote:deleteSession', sessionId, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`deleteSession callback timed out for session ${sessionId}`, 'WebServer');
					resolve(false);
				}, 5000);
			});
		});

		server.setCloseTabCallback(async (sessionId: string, tabId: string) => {
			logger.info(
				`[Web→Desktop] Close tab callback invoked: session=${sessionId}, tab=${tabId}`,
				'WebServer'
			);
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for closeTab', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for closeTab', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:closeTab', sessionId, tabId);
			return true;
		});

		server.setRenameTabCallback(async (sessionId: string, tabId: string, newName: string) => {
			logger.info(
				`[Web→Desktop] Rename tab callback invoked: session=${sessionId}, tab=${tabId}, newName=${newName}`,
				'WebServer'
			);
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for renameTab', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for renameTab', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:renameTab', sessionId, tabId, newName);
			return true;
		});

		server.setStarTabCallback(async (sessionId: string, tabId: string, starred: boolean) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for starTab', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for starTab', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:starTab', sessionId, tabId, starred);
			return true;
		});

		server.setReorderTabCallback(async (sessionId: string, fromIndex: number, toIndex: number) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for reorderTab', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for reorderTab', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:reorderTab', sessionId, fromIndex, toIndex);
			return true;
		});

		server.setToggleBookmarkCallback(async (sessionId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for toggleBookmark', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for toggleBookmark', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:toggleBookmark', sessionId);
			return true;
		});

		return server;
	};
}
