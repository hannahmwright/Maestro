import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';
import {
	createWebServerFactory,
	type WebServerFactoryDependencies,
} from '../../../main/web-server/web-server-factory';
import { WebServer } from '../../../main/web-server/WebServer';

vi.mock('electron', () => ({
	ipcMain: {
		once: vi.fn(),
	},
}));

vi.mock('../../../main/web-server/WebServer', () => ({
	WebServer: class MockWebServer {
		port: number;
		setGetSessionsCallback = vi.fn((cb) => {
			(this as any).getSessionsCallback = cb;
		});
		setGetSessionDetailCallback = vi.fn();
		setGetSessionModelsCallback = vi.fn();
		setGetSessionModelCatalogCallback = vi.fn();
		setGetSessionProviderUsageCallback = vi.fn();
		setGetConductorSnapshotCallback = vi.fn();
		setSetSessionModelCallback = vi.fn();
		setTranscribeAudioCallback = vi.fn();
		setGetVoiceTranscriptionStatusCallback = vi.fn();
		setPrewarmVoiceTranscriptionCallback = vi.fn();
		setGetThemeCallback = vi.fn();
		setGetCustomCommandsCallback = vi.fn();
		setGetHistoryCallback = vi.fn();
		setGetSessionDemosCallback = vi.fn();
		setGetDemoDetailCallback = vi.fn();
		setGetArtifactContentCallback = vi.fn();
		setGetSessionLocalFileCallback = vi.fn();
		setWriteToSessionCallback = vi.fn();
		setExecuteCommandCallback = vi.fn();
		setInterruptSessionCallback = vi.fn();
		setSwitchModeCallback = vi.fn();
		setSelectSessionCallback = vi.fn();
		setSelectTabCallback = vi.fn();
		setNewTabCallback = vi.fn();
		setNewThreadCallback = vi.fn();
		setForkThreadCallback = vi.fn();
		setDeleteSessionCallback = vi.fn();
		setCloseTabCallback = vi.fn();
		setRenameTabCallback = vi.fn();
		setStarTabCallback = vi.fn();
		setReorderTabCallback = vi.fn();
		setToggleBookmarkCallback = vi.fn();
		setCreateConductorTaskCallback = vi.fn();
		setUpdateConductorTaskCallback = vi.fn();
		setDeleteConductorTaskCallback = vi.fn();

		constructor(port: number) {
			this.port = port;
		}
	},
}));

vi.mock('../../../main/themes', () => ({
	getThemeById: vi.fn().mockReturnValue({ id: 'dracula', name: 'Dracula' }),
}));

vi.mock('../../../main/history-manager', () => ({
	getHistoryManager: vi.fn().mockReturnValue({
		getEntries: vi.fn().mockReturnValue([]),
		getEntriesByProjectPath: vi.fn().mockReturnValue([]),
		getAllEntries: vi.fn().mockReturnValue([]),
	}),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

describe('web-server-factory', () => {
	let deps: WebServerFactoryDependencies;
	let mockSettingsStore: WebServerFactoryDependencies['settingsStore'];

	beforeEach(() => {
		vi.clearAllMocks();

		const mockWebContents: Partial<WebContents> = {
			send: vi.fn(),
			isDestroyed: vi.fn().mockReturnValue(false),
		};
		const mockMainWindow: Partial<BrowserWindow> = {
			isDestroyed: vi.fn().mockReturnValue(false),
			webContents: mockWebContents as WebContents,
		};

		mockSettingsStore = {
			get: vi.fn((key: string, defaultValue?: unknown) => {
				const values: Record<string, unknown> = {
					webInterfaceUseCustomPort: false,
					webInterfaceCustomPort: 8080,
					activeThemeId: 'dracula',
					customAICommands: [],
				};
				return values[key] ?? defaultValue;
			}),
		};

		deps = {
			settingsStore: mockSettingsStore,
			sessionsStore: {
				get: vi.fn((key: string, defaultValue?: unknown) => {
					if (key !== 'sessions') return defaultValue;
					return [
						{
							id: 'session-1',
							name: 'Test Session',
							toolType: 'claude-code',
							state: 'idle',
							inputMode: 'ai',
							cwd: '/test/path',
							projectRoot: '/test/path',
							groupId: 'group-1',
							aiTabs: [],
							activeTabId: null,
						},
					];
				}),
			},
			groupsStore: {
				get: vi.fn((key: string, defaultValue?: unknown) => {
					if (key !== 'groups') return defaultValue;
					return [{ id: 'group-1', name: 'Team One', emoji: 'T' }];
				}),
			},
			threadsStore: {
				get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
			},
			conductorsStore: {
				get: vi.fn((key: string, defaultValue?: unknown) => {
					if (key === 'conductors' || key === 'tasks' || key === 'runs') {
						return [];
					}
					return defaultValue;
				}),
			},
			getMainWindow: vi.fn().mockReturnValue(mockMainWindow as BrowserWindow),
			getProcessManager: vi.fn().mockReturnValue({
				write: vi.fn().mockReturnValue(true),
			} as any),
			getAgentDetector: vi.fn().mockReturnValue(null),
			getAgentConfig: vi.fn().mockReturnValue({}),
			getUserDataPath: vi.fn().mockReturnValue('/tmp/maestro-tests'),
		};
	});

	it('creates a WebServer with a random port by default', () => {
		const createWebServer = createWebServerFactory(deps);
		const server = createWebServer();

		expect(typeof createWebServer).toBe('function');
		expect(server).toBeInstanceOf(WebServer);
		expect((server as any).port).toBe(0);
	});

	it('uses the configured custom port when enabled', () => {
		vi.mocked(mockSettingsStore.get).mockImplementation((key: string, defaultValue?: unknown) => {
			if (key === 'webInterfaceUseCustomPort') return true;
			if (key === 'webInterfaceCustomPort') return 9999;
			return defaultValue;
		});

		const server = createWebServerFactory(deps)();
		expect((server as any).port).toBe(9999);
	});

	it('registers the current callback surface on the WebServer', () => {
		const server = createWebServerFactory(deps)() as any;

		expect(server.setGetSessionsCallback).toHaveBeenCalled();
		expect(server.setGetSessionDetailCallback).toHaveBeenCalled();
		expect(server.setGetConductorSnapshotCallback).toHaveBeenCalled();
		expect(server.setGetThemeCallback).toHaveBeenCalled();
		expect(server.setGetHistoryCallback).toHaveBeenCalled();
		expect(server.setGetSessionLocalFileCallback).toHaveBeenCalled();
		expect(server.setExecuteCommandCallback).toHaveBeenCalled();
		expect(server.setSelectSessionCallback).toHaveBeenCalled();
		expect(server.setRenameTabCallback).toHaveBeenCalled();
		expect(server.setCreateConductorTaskCallback).toHaveBeenCalled();
		expect(server.setUpdateConductorTaskCallback).toHaveBeenCalled();
		expect(server.setDeleteConductorTaskCallback).toHaveBeenCalled();
	});

	it('maps stored sessions to web session data with group metadata', async () => {
		const server = createWebServerFactory(deps)() as any;
		const sessions = await server.getSessionsCallback();

		expect(sessions).toEqual([
			expect.objectContaining({
				id: 'session-1',
				name: 'Test Session',
				groupId: 'group-1',
				groupName: 'Team One',
				groupEmoji: 'T',
				cwd: '/test/path',
			}),
		]);
	});
});
