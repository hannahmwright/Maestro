import { describe, expect, it } from 'vitest';
import type { Session, Thread } from '../../../renderer/types';
import { reconcileThreadsWithSessions } from '../../../renderer/utils/workspaceThreads';

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		runtimeId: 'session-1',
		name: 'General Agent',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
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
		aiTabs: [
			{
				id: 'tab-1',
				agentSessionId: null,
				name: 'First task',
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				createdAt: 100,
				state: 'idle',
			},
			{
				id: 'tab-2',
				agentSessionId: null,
				name: 'Second task',
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				createdAt: 200,
				state: 'idle',
			},
		],
		activeTabId: 'tab-2',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		workspaceId: 'workspace-1',
		groupId: 'workspace-1',
		...overrides,
	} as Session;
}

function createMockThread(overrides: Partial<Thread> = {}): Thread {
	return {
		id: 'thread-1',
		workspaceId: 'workspace-1',
		sessionId: 'session-1',
		runtimeId: 'session-1',
		tabId: 'tab-1',
		title: 'First task',
		agentId: 'claude-code',
		projectRoot: '/test/project',
		pinned: false,
		archived: false,
		isOpen: false,
		createdAt: 100,
		lastUsedAt: 100,
		...overrides,
	};
}

describe('workspaceThreads reconcileThreadsWithSessions', () => {
	it('drops orphaned rows whose saved tab no longer exists', () => {
		const session = createMockSession();
		const threads = [
			createMockThread({ id: 'thread-valid', tabId: 'tab-1', title: 'First task' }),
			createMockThread({ id: 'thread-orphan', tabId: 'missing-tab', title: 'Old ghost row' }),
		];

		const result = reconcileThreadsWithSessions(threads, [session]);

		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe('thread-valid');
		expect(result[0]?.tabId).toBe('tab-1');
	});

	it('collapses duplicate rows for the same session and tab', () => {
		const session = createMockSession();
		const threads = [
			createMockThread({
				id: 'thread-stale',
				tabId: 'tab-1',
				title: 'Old title',
				lastUsedAt: 50,
				createdAt: 50,
			}),
			createMockThread({
				id: 'thread-keeper',
				tabId: 'tab-1',
				title: 'Pinned title',
				pinned: true,
				isOpen: true,
				lastUsedAt: 250,
				createdAt: 250,
			}),
		];

		const result = reconcileThreadsWithSessions(threads, [session]);

		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe('thread-keeper');
		expect(result[0]?.tabId).toBe('tab-1');
	});
});
