/**
 * Persistence IPC Handlers
 *
 * This module handles IPC calls for:
 * - Settings: get/set/getAll
 * - Sessions: getAll/setAll
 * - Groups: getAll/setAll
 * - Conductors: getAll/setAll
 * - CLI activity: getActivity
 *
 * Extracted from main/index.ts to improve code organization.
 */

import { ipcMain, app } from 'electron';
import Store from 'electron-store';
import * as path from 'path';
import * as fs from 'fs/promises';
import { logger } from '../../utils/logger';
import { getThemeById } from '../../themes';
import { WebServer } from '../../web-server';

// Re-export types from canonical source so existing imports from './persistence' still work
export type {
	MaestroSettings,
	SessionsData,
	GroupsData,
	ThreadsData,
	ConductorsData,
} from '../../stores/types';
import type {
	MaestroSettings,
	SessionsData,
	GroupsData,
	ThreadsData,
	ConductorsData,
	StoredSession,
} from '../../stores/types';
import type { Group, Thread, Conductor, ConductorTask, ConductorRun } from '../../../shared/types';

/**
 * Dependencies required for persistence handlers
 */
export interface PersistenceHandlerDependencies {
	settingsStore: Store<MaestroSettings>;
	sessionsStore: Store<SessionsData>;
	groupsStore: Store<GroupsData>;
	threadsStore: Store<ThreadsData>;
	conductorsStore: Store<ConductorsData>;
	getWebServer: () => WebServer | null;
}

/**
 * Register all persistence-related IPC handlers.
 */
export function registerPersistenceHandlers(deps: PersistenceHandlerDependencies): void {
	const { settingsStore, sessionsStore, groupsStore, threadsStore, conductorsStore, getWebServer } =
		deps;

	// Settings management
	ipcMain.handle('settings:get', async (_, key: string) => {
		const value = settingsStore.get(key);
		logger.debug(`Settings read: ${key}`, 'Settings', { key, value });
		return value;
	});

	ipcMain.handle('settings:set', async (_, key: string, value: any) => {
		try {
			settingsStore.set(key, value);
		} catch (err) {
			// ENOSPC / ENFILE errors are transient disk issues — log and return false
			// so the renderer doesn't see an unhandled rejection.
			const code = (err as NodeJS.ErrnoException).code;
			logger.warn(
				`Failed to persist setting '${key}': ${code || (err as Error).message}`,
				'Settings'
			);
			return false;
		}
		logger.info(`Settings updated: ${key}`, 'Settings', { key, value });

		const webServer = getWebServer();
		// Broadcast theme changes to connected web clients
		if (key === 'activeThemeId' && webServer && webServer.getWebClientCount() > 0) {
			const theme = getThemeById(value);
			if (theme) {
				webServer.broadcastThemeChange(theme);
				logger.info(`Broadcasted theme change to web clients: ${value}`, 'WebServer');
			}
		}

		// Broadcast custom commands changes to connected web clients
		if (key === 'customAICommands' && webServer && webServer.getWebClientCount() > 0) {
			webServer.broadcastCustomCommands(value);
			logger.info(
				`Broadcasted custom commands change to web clients: ${value.length} commands`,
				'WebServer'
			);
		}

		return true;
	});

	ipcMain.handle('settings:getAll', async () => {
		const settings = settingsStore.store;
		logger.debug('All settings retrieved', 'Settings', { count: Object.keys(settings).length });
		return settings;
	});

	// Sessions persistence
	ipcMain.handle('sessions:getAll', async () => {
		const sessions = sessionsStore.get('sessions', []);
		logger.debug(`Loaded ${sessions.length} sessions from store`, 'Sessions');
		return sessions;
	});

	ipcMain.handle('sessions:setAll', async (_, sessions: StoredSession[]) => {
		// Get previous sessions to detect changes
		const previousSessions = sessionsStore.get('sessions', []);
		const previousSessionMap = new Map(previousSessions.map((s) => [s.id, s]));
		const currentSessionMap = new Map(sessions.map((s) => [s.id, s]));

		// Log session lifecycle events at DEBUG level
		for (const session of sessions) {
			const prevSession = previousSessionMap.get(session.id);
			if (!prevSession) {
				// New session created
				logger.debug('Session created', 'Sessions', {
					sessionId: session.id,
					name: session.name,
					toolType: session.toolType,
					cwd: session.cwd,
				});
			}
		}
		for (const prevSession of previousSessions) {
			if (!currentSessionMap.has(prevSession.id)) {
				// Session destroyed
				logger.debug('Session destroyed', 'Sessions', {
					sessionId: prevSession.id,
					name: prevSession.name,
				});
			}
		}

		const webServer = getWebServer();
		// Detect and broadcast changes to web clients
		if (webServer && webServer.getWebClientCount() > 0) {
			// Check for state changes in existing sessions
			for (const session of sessions) {
				const prevSession = previousSessionMap.get(session.id);
				if (prevSession) {
					// Session exists - check if state or other tracked properties changed
					if (
						prevSession.state !== session.state ||
						prevSession.inputMode !== session.inputMode ||
						prevSession.name !== session.name ||
						prevSession.cwd !== session.cwd ||
						JSON.stringify(prevSession.cliActivity) !== JSON.stringify(session.cliActivity)
					) {
						webServer.broadcastSessionStateChange(session.id, session.state, {
							name: session.name,
							toolType: session.toolType,
							inputMode: session.inputMode,
							cwd: session.cwd,
							cliActivity: session.cliActivity,
						});
					}
				} else {
					// New session added
					webServer.broadcastSessionAdded({
						id: session.id,
						name: session.name,
						toolType: session.toolType,
						state: session.state,
						inputMode: session.inputMode,
						cwd: session.cwd,
						groupId: session.groupId || null,
						groupName: session.groupName || null,
						groupEmoji: session.groupEmoji || null,
						aiTabs:
							session.aiTabs?.map((tab: StoredSession['aiTabs'][number]) => ({
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
								runtimeKind: tab.runtimeKind || 'batch',
								steerMode: tab.steerMode || 'none',
								activeTurnId: tab.activeTurnId || null,
								pendingSteer: tab.pendingSteer || null,
								steerStatus: tab.steerStatus || 'idle',
								lastCheckpointAt: tab.lastCheckpointAt || null,
							})) || [],
						activeTabId: session.activeTabId || session.aiTabs?.[0]?.id,
						parentSessionId: session.parentSessionId || null,
						worktreeBranch: session.worktreeBranch || null,
					});
				}
			}

			// Check for removed sessions
			for (const prevSession of previousSessions) {
				if (!currentSessionMap.has(prevSession.id)) {
					webServer.broadcastSessionRemoved(prevSession.id);
				}
			}
		}

		try {
			sessionsStore.set('sessions', sessions);
		} catch (err) {
			// ENOSPC, ENFILE, or JSON serialization failures are recoverable —
			// the next debounced write will succeed when conditions improve.
			// Log but don't throw so the renderer doesn't see an unhandled rejection.
			const code = (err as NodeJS.ErrnoException).code;
			logger.warn(`Failed to persist sessions: ${code || (err as Error).message}`, 'Sessions');
			return false;
		}

		return true;
	});

	// Groups persistence
	ipcMain.handle('groups:getAll', async () => {
		return groupsStore.get('groups', []);
	});

	ipcMain.handle('groups:setAll', async (_, groups: Group[]) => {
		try {
			groupsStore.set('groups', groups);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			logger.warn(`Failed to persist groups: ${code || (err as Error).message}`, 'Groups');
			return false;
		}
		return true;
	});

	ipcMain.handle('threads:getAll', async () => {
		return threadsStore.get('threads', []);
	});

	ipcMain.handle('threads:setAll', async (_, threads: Thread[]) => {
		try {
			threadsStore.set('threads', threads);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			logger.warn(`Failed to persist threads: ${code || (err as Error).message}`, 'Threads');
			return false;
		}
		return true;
	});

	// Conductors persistence
	ipcMain.handle('conductors:getAll', async () => {
		return {
			conductors: conductorsStore.get('conductors', []),
			tasks: conductorsStore.get('tasks', []),
			runs: conductorsStore.get('runs', []),
		};
	});

	ipcMain.handle(
		'conductors:setAll',
		async (
			_,
			data: {
				conductors: Conductor[];
				tasks: ConductorTask[];
				runs: ConductorRun[];
			}
		) => {
			try {
				conductorsStore.set('conductors', data.conductors);
				conductorsStore.set('tasks', data.tasks);
				conductorsStore.set('runs', data.runs);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				logger.warn(
					`Failed to persist conductors: ${code || (err as Error).message}`,
					'Conductors'
				);
				return false;
			}
			return true;
		}
	);

	// CLI activity (for detecting when CLI is running playbooks)
	ipcMain.handle('cli:getActivity', async () => {
		try {
			const cliActivityPath = path.join(app.getPath('userData'), 'cli-activity.json');
			const content = await fs.readFile(cliActivityPath, 'utf-8');
			const data = JSON.parse(content);
			return data.activities || [];
		} catch {
			// File doesn't exist or is invalid - return empty array
			return [];
		}
	});
}
