import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetStateAction } from 'react';
import type { Session, AITab } from '../../../renderer/types';
import { maybeStartAutomaticTabNaming } from '../../../renderer/utils/autoTabNaming';

function createMockTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle',
		...overrides,
	};
}

function createMockSession(overrides: Partial<Session> = {}): Session {
	const tab = createMockTab();
	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [tab],
		activeTabId: tab.id,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	};
}

function createSetSessionsHarness(initialSessions: Session[]) {
	let sessions = initialSessions;
	const setSessions = vi.fn((updater: SetStateAction<Session[]>) => {
		sessions = typeof updater === 'function' ? updater(sessions) : updater;
	});

	return {
		setSessions,
		getSessions: () => sessions,
	};
}

describe('autoTabNaming', () => {
	const generateTabName = vi.fn();
	const loggerLog = vi.fn();
	const claudeUpdateSessionName = vi.fn();
	const historyUpdateSessionName = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		generateTabName.mockReset();
		loggerLog.mockReset();
		claudeUpdateSessionName.mockReset().mockResolvedValue(undefined);
		historyUpdateSessionName.mockReset().mockResolvedValue(0);

		vi.stubGlobal('window', {
			maestro: {
				tabNaming: {
					generateTabName,
				},
				logger: {
					log: loggerLog,
				},
				claude: {
					updateSessionName: claudeUpdateSessionName,
				},
				agentSessions: {
					setSessionName: vi.fn().mockResolvedValue(undefined),
				},
				history: {
					updateSessionName: historyUpdateSessionName,
				},
			},
		});
	});

	it('does nothing when automatic naming is disabled', () => {
		const session = createMockSession();
		const harness = createSetSessionsHarness([session]);

		maybeStartAutomaticTabNaming({
			session,
			tabId: 'tab-1',
			userMessage: 'Review this bug',
			setSessions: harness.setSessions,
			getSessions: harness.getSessions,
			automaticTabNamingEnabled: false,
		});

		expect(generateTabName).not.toHaveBeenCalled();
		expect(harness.setSessions).not.toHaveBeenCalled();
	});

	it('applies a quick name immediately', () => {
		const session = createMockSession();
		const harness = createSetSessionsHarness([session]);

		maybeStartAutomaticTabNaming({
			session,
			tabId: 'tab-1',
			userMessage: 'Fix PR #123 for me',
			setSessions: harness.setSessions,
			getSessions: harness.getSessions,
			automaticTabNamingEnabled: true,
		});

		expect(harness.getSessions()[0].aiTabs[0].name).toBe('PR #123');
		expect(generateTabName).not.toHaveBeenCalled();
	});

	it('persists a generated name when the tab has an agent session id by resolution time', async () => {
		let resolveName: ((value: string | null) => void) | null = null;
		generateTabName.mockImplementation(
			() =>
				new Promise<string | null>((resolve) => {
					resolveName = resolve;
				})
		);

		const session = createMockSession();
		const harness = createSetSessionsHarness([session]);

		maybeStartAutomaticTabNaming({
			session,
			tabId: 'tab-1',
			userMessage: 'Investigate the websocket reconnection issue',
			setSessions: harness.setSessions,
			getSessions: harness.getSessions,
			automaticTabNamingEnabled: true,
		});

		harness.setSessions((prev) =>
			prev.map((candidate) =>
				candidate.id === session.id
					? {
							...candidate,
							aiTabs: candidate.aiTabs.map((tab) =>
								tab.id === 'tab-1' ? { ...tab, agentSessionId: 'agent-session-1' } : tab
							),
						}
					: candidate
			)
		);

		resolveName?.('Reconnect investigation');
		await Promise.resolve();
		await Promise.resolve();

		expect(harness.getSessions()[0].aiTabs[0].name).toBe('Reconnect investigation');
		expect(claudeUpdateSessionName).toHaveBeenCalledWith(
			'/test',
			'agent-session-1',
			'Reconnect investigation'
		);
		expect(historyUpdateSessionName).toHaveBeenCalledWith(
			'agent-session-1',
			'Reconnect investigation'
		);
	});

	it('does not overwrite a tab that was renamed before async naming completed', async () => {
		let resolveName: ((value: string | null) => void) | null = null;
		generateTabName.mockImplementation(
			() =>
				new Promise<string | null>((resolve) => {
					resolveName = resolve;
				})
		);

		const session = createMockSession();
		const harness = createSetSessionsHarness([session]);

		maybeStartAutomaticTabNaming({
			session,
			tabId: 'tab-1',
			userMessage: 'Investigate the websocket reconnection issue',
			setSessions: harness.setSessions,
			getSessions: harness.getSessions,
			automaticTabNamingEnabled: true,
		});

		harness.setSessions((prev) =>
			prev.map((candidate) =>
				candidate.id === session.id
					? {
							...candidate,
							aiTabs: candidate.aiTabs.map((tab) =>
								tab.id === 'tab-1' ? { ...tab, name: 'Manual name' } : tab
							),
						}
					: candidate
			)
		);

		resolveName?.('Reconnect investigation');
		await Promise.resolve();
		await Promise.resolve();

		expect(harness.getSessions()[0].aiTabs[0].name).toBe('Manual name');
		expect(claudeUpdateSessionName).not.toHaveBeenCalled();
	});
});
