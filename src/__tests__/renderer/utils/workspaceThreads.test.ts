import { describe, expect, it, vi } from 'vitest';
import type { Session, Thread } from '../../../renderer/types';
import {
	buildRecoveredProviderStubLogs,
	pruneDormantConductorSessions,
	pruneOrphanConductorArtifacts,
	pruneStartupPassiveSessions,
	recoverMissingProviderThreads,
	reconcileThreadsWithSessions,
} from '../../../renderer/utils/workspaceThreads';

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

function createMockGroup(overrides: Partial<{ id: string; name: string; projectRoot: string }> = {}) {
	return {
		id: 'workspace-1',
		name: 'Workspace',
		emoji: '📁',
		collapsed: false,
		archived: false,
		projectRoot: '/test/project',
		lastUsedAt: 0,
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

	it('does not invent fresh activity timestamps for idle sessions with no logs', () => {
		const session = createMockSession({
			aiTabs: [
				{
					id: 'tab-1',
					agentSessionId: null,
					name: 'Idle task',
					starred: false,
					logs: [],
					inputValue: '',
					stagedImages: [],
					createdAt: 100,
					state: 'idle',
				},
			],
			activeTabId: 'tab-1',
			shellLogs: [],
		});

		const firstPass = reconcileThreadsWithSessions([], [session]);
		const secondPass = reconcileThreadsWithSessions(firstPass, [session]);

		expect(firstPass).toHaveLength(1);
		expect(secondPass).toEqual(firstPass);
		expect(secondPass[0]?.lastUsedAt).toBe(100);
	});

	it('uses only the latest tab and shell timestamps when reconciling activity', () => {
		const session = createMockSession({
			aiTabs: [
				{
					id: 'tab-1',
					agentSessionId: null,
					name: 'Busy task',
					starred: false,
					logs: [
						{ id: 'log-1', timestamp: 10, source: 'user', text: 'hi' },
						{ id: 'log-2', timestamp: 50, source: 'stdout', text: 'done' },
					],
					inputValue: '',
					stagedImages: [],
					createdAt: 5,
					state: 'idle',
				},
				{
					id: 'tab-2',
					agentSessionId: null,
					name: 'Older tab',
					starred: false,
					logs: [{ id: 'log-3', timestamp: 20, source: 'stdout', text: 'older' }],
					inputValue: '',
					stagedImages: [],
					createdAt: 15,
					state: 'idle',
				},
			],
			activeTabId: 'tab-1',
			shellLogs: [
				{ id: 'shell-1', timestamp: 40, source: 'stdout', text: 'shell' },
				{ id: 'shell-2', timestamp: 60, source: 'stdout', text: 'latest shell' },
			],
		});

		const result = reconcileThreadsWithSessions([], [session]);

		expect(result).toHaveLength(1);
		expect(result[0]?.lastUsedAt).toBe(60);
	});

	it('prunes excess passive top-level sessions at startup while keeping recent ones', () => {
		const sessions = Array.from({ length: 4 }, (_, index) =>
			createMockSession({
				id: `session-${index + 1}`,
				runtimeId: `session-${index + 1}`,
				name: `Session ${index + 1}`,
				groupId: 'workspace-1',
				workspaceId: 'workspace-1',
				state: 'idle',
				isLive: false,
				aiPid: 0,
				terminalPid: 0,
				aiTabs: [
					{
						id: `tab-${index + 1}`,
						agentSessionId: null,
						name: `Tab ${index + 1}`,
						starred: false,
						logs: [{ id: `log-${index + 1}`, timestamp: (index + 1) * 10, source: 'stdout', text: 'ok' }],
						inputValue: '',
						stagedImages: [],
						createdAt: (index + 1) * 10,
						state: 'idle',
					},
				],
				activeTabId: `tab-${index + 1}`,
			})
		);
		const threads = sessions.map((session, index) =>
			createMockThread({
				id: `thread-${index + 1}`,
				sessionId: session.id,
				runtimeId: session.runtimeId,
				tabId: session.activeTabId,
				lastUsedAt: (index + 1) * 10,
				createdAt: (index + 1) * 10,
			})
		);

		const result = pruneStartupPassiveSessions({
			sessions,
			threads,
			groups: [createMockGroup()],
			maxPassiveTopLevelSessions: 2,
		});

		expect(result.prunedCount).toBe(2);
		expect(result.sessions.map((session) => session.id)).toEqual(['session-3', 'session-4']);
		expect(result.threads.map((thread) => thread.sessionId)).toEqual(['session-3', 'session-4']);
	});

	it('keeps starred and active sessions even when pruning passive startup sessions', () => {
		const starred = createMockSession({
			id: 'starred',
			runtimeId: 'starred',
			bookmarked: true,
			aiTabs: [
				{
					id: 'starred-tab',
					agentSessionId: null,
					name: 'Starred',
					starred: true,
					logs: [{ id: 'starred-log', timestamp: 5, source: 'stdout', text: 'starred' }],
					inputValue: '',
					stagedImages: [],
					createdAt: 5,
					state: 'idle',
				},
			],
			activeTabId: 'starred-tab',
		});
		const active = createMockSession({
			id: 'active',
			runtimeId: 'active',
			aiTabs: [
				{
					id: 'active-tab',
					agentSessionId: null,
					name: 'Active',
					starred: false,
					logs: [{ id: 'active-log', timestamp: 10, source: 'stdout', text: 'active' }],
					inputValue: '',
					stagedImages: [],
					createdAt: 10,
					state: 'idle',
				},
			],
			activeTabId: 'active-tab',
		});
		const oldPassive = createMockSession({
			id: 'old-passive',
			runtimeId: 'old-passive',
			aiTabs: [
				{
					id: 'old-tab',
					agentSessionId: null,
					name: 'Old passive',
					starred: false,
					logs: [{ id: 'old-log', timestamp: 1, source: 'stdout', text: 'old' }],
					inputValue: '',
					stagedImages: [],
					createdAt: 1,
					state: 'idle',
				},
			],
			activeTabId: 'old-tab',
		});

		const result = pruneStartupPassiveSessions({
			sessions: [oldPassive, starred, active],
			threads: [
				createMockThread({ id: 'old-thread', sessionId: 'old-passive', runtimeId: 'old-passive', tabId: 'old-tab', lastUsedAt: 1, createdAt: 1 }),
				createMockThread({ id: 'starred-thread', sessionId: 'starred', runtimeId: 'starred', tabId: 'starred-tab', lastUsedAt: 5, createdAt: 5 }),
				createMockThread({ id: 'active-thread', sessionId: 'active', runtimeId: 'active', tabId: 'active-tab', lastUsedAt: 10, createdAt: 10 }),
			],
			groups: [createMockGroup()],
			activeSessionId: 'active',
			maxPassiveTopLevelSessions: 0,
		});

		expect(result.sessions.map((session) => session.id)).toEqual(['starred', 'active']);
		expect(result.threads.map((thread) => thread.sessionId)).toEqual(['starred', 'active']);
	});

	it('builds lightweight stub logs for recovered provider threads', () => {
		const logs = buildRecoveredProviderStubLogs({
			firstMessage: 'Please help me debug this issue',
			modifiedAt: '2026-03-26T20:00:00.000Z',
		});

		expect(logs).toHaveLength(2);
		expect(logs[0]?.source).toBe('system');
		expect(logs[0]?.text).toContain('Recovered provider history will load');
		expect(logs[1]?.source).toBe('user');
		expect(logs[1]?.text).toBe('Please help me debug this issue');
	});

	it('prunes orphaned conductor worktree artifacts before startup restore', () => {
		const orphanGroup = createMockGroup({
			id: 'workspace-orphan',
			name: 'Mind Loom-conductor-mind-loom-6383cca4',
			projectRoot: '/tmp/Mind Loom-conductor-mind-loom-6383cca4',
		});
		const realGroup = createMockGroup({
			id: 'workspace-real',
			name: 'Real Workspace',
			projectRoot: '/tmp/real-workspace',
		});
		const orphanSession = createMockSession({
			id: 'orphan-session',
			runtimeId: 'orphan-session',
			groupId: 'workspace-orphan',
			workspaceId: 'workspace-orphan',
			cwd: '/tmp/Mind Loom-conductor-mind-loom-6383cca4',
			projectRoot: '/tmp/Mind Loom-conductor-mind-loom-6383cca4',
			autoRunFolderPath: '/tmp/Mind Loom-conductor-mind-loom-6383cca4/Auto Run Docs',
		});
		const realSession = createMockSession({
			id: 'real-session',
			runtimeId: 'real-session',
			groupId: 'workspace-real',
			workspaceId: 'workspace-real',
			cwd: '/tmp/real-workspace',
			projectRoot: '/tmp/real-workspace',
		});
		const realThread = createMockThread({
			id: 'thread-real',
			sessionId: 'real-session',
			runtimeId: 'real-session',
			workspaceId: 'workspace-real',
			projectRoot: '/tmp/real-workspace',
		});

		const result = pruneOrphanConductorArtifacts({
			sessions: [orphanSession, realSession],
			threads: [realThread],
			groups: [orphanGroup, realGroup],
			conductors: [
				{
					groupId: 'workspace-orphan',
					status: 'needs_setup',
					resourceProfile: 'aggressive',
					createdAt: 1,
					updatedAt: 1,
				},
			],
			tasks: [],
			runs: [],
		});

		expect(result.prunedGroupIds).toEqual(['workspace-orphan']);
		expect(result.prunedSessionIds).toEqual(['orphan-session']);
		expect(result.groups.map((group) => group.id)).toEqual(['workspace-real']);
		expect(result.sessions.map((session) => session.id)).toEqual(['real-session']);
		expect(result.threads.map((thread) => thread.id)).toEqual(['thread-real']);
	});

	it('prunes dormant conductor helper sessions when helper retention is disabled', () => {
		const helperSession = createMockSession({
			id: 'helper-session',
			runtimeId: 'helper-session',
			name: "You are Conductor's discovery planner for the Maestro workspace",
			groupId: 'workspace-1',
			workspaceId: 'workspace-1',
			threadId: 'helper-thread',
			state: 'idle',
			isLive: false,
			conductorMetadata: {
				isConductorSession: true,
				groupId: 'workspace-1',
				role: 'planner',
				runId: 'run-old',
				createdAt: 1,
			},
		});
		const userSession = createMockSession({
			id: 'user-session',
			runtimeId: 'user-session',
			name: 'Regular Agent',
			groupId: 'workspace-1',
			workspaceId: 'workspace-1',
			threadId: 'user-thread',
		});
		const result = pruneDormantConductorSessions({
			sessions: [helperSession, userSession],
			threads: [
				createMockThread({
					id: 'helper-thread',
					sessionId: 'helper-session',
					runtimeId: 'helper-session',
				}),
				createMockThread({
					id: 'user-thread',
					sessionId: 'user-session',
					runtimeId: 'user-session',
				}),
			],
			conductors: [
				{
					groupId: 'workspace-1',
					status: 'idle',
					resourceProfile: 'aggressive',
					keepConductorAgentSessions: false,
					createdAt: 1,
					updatedAt: 1,
				},
			],
			runs: [],
		});

		expect(result.prunedSessionIds).toEqual(['helper-session']);
		expect(result.sessions.map((session) => session.id)).toEqual(['user-session']);
		expect(result.threads.map((thread) => thread.id)).toEqual(['user-thread']);
	});

	it('prunes stale conductor worktree groups even when saved threads still exist', () => {
		const staleWorktreeGroup = createMockGroup({
			id: 'workspace-conductor-stale',
			name: 'Questionaire-conductor-questionaire-a1f9fa08',
			projectRoot: '/tmp/Questionaire-conductor-questionaire-a1f9fa08',
		});
		const realGroup = createMockGroup({
			id: 'workspace-real',
			name: 'Questionaire',
			projectRoot: '/tmp/Questionaire',
		});
		const staleWorktreeSession = createMockSession({
			id: 'stale-worktree-session',
			runtimeId: 'stale-worktree-session',
			name: '# Maestro System Context\n\nYou are **Lina · Claude · Visit Example**',
			groupId: 'workspace-conductor-stale',
			workspaceId: 'workspace-conductor-stale',
			cwd: '/tmp/Questionaire-conductor-questionaire-a1f9fa08',
			projectRoot: '/tmp/Questionaire-conductor-questionaire-a1f9fa08',
			state: 'idle',
			isLive: false,
		});
		const realSession = createMockSession({
			id: 'real-session',
			runtimeId: 'real-session',
			groupId: 'workspace-real',
			workspaceId: 'workspace-real',
			cwd: '/tmp/Questionaire',
			projectRoot: '/tmp/Questionaire',
		});
		const staleWorktreeThread = createMockThread({
			id: 'stale-thread',
			sessionId: 'stale-worktree-session',
			runtimeId: 'stale-worktree-session',
			workspaceId: 'workspace-conductor-stale',
			projectRoot: '/tmp/Questionaire-conductor-questionaire-a1f9fa08',
		});
		const realThread = createMockThread({
			id: 'real-thread',
			sessionId: 'real-session',
			runtimeId: 'real-session',
			workspaceId: 'workspace-real',
			projectRoot: '/tmp/Questionaire',
		});

		const result = pruneOrphanConductorArtifacts({
			sessions: [staleWorktreeSession, realSession],
			threads: [staleWorktreeThread, realThread],
			groups: [staleWorktreeGroup, realGroup],
			conductors: [
				{
					groupId: 'workspace-conductor-stale',
					status: 'needs_setup',
					resourceProfile: 'aggressive',
					createdAt: 1,
					updatedAt: 1,
				},
			],
			tasks: [],
			runs: [],
		});

		expect(result.prunedGroupIds).toEqual(['workspace-conductor-stale']);
		expect(result.prunedSessionIds).toEqual(['stale-worktree-session']);
		expect(result.groups.map((group) => group.id)).toEqual(['workspace-real']);
		expect(result.sessions.map((session) => session.id)).toEqual(['real-session']);
		expect(result.threads.map((thread) => thread.id)).toEqual(['real-thread']);
	});

	it('prunes truncated discovery planner helper names', () => {
		const truncatedHelperSession = createMockSession({
			id: 'helper-session',
			runtimeId: 'helper-session',
			name: "You are Conductor's discovery planner for the Maestro worksp",
			groupId: 'workspace-1',
			workspaceId: 'workspace-1',
			state: 'idle',
			isLive: false,
		});
		const userSession = createMockSession({
			id: 'user-session',
			runtimeId: 'user-session',
			name: 'Regular Agent',
			groupId: 'workspace-1',
			workspaceId: 'workspace-1',
		});

		const result = pruneDormantConductorSessions({
			sessions: [truncatedHelperSession, userSession],
			threads: [
				createMockThread({
					id: 'helper-thread',
					sessionId: 'helper-session',
					runtimeId: 'helper-session',
				}),
				createMockThread({
					id: 'user-thread',
					sessionId: 'user-session',
					runtimeId: 'user-session',
				}),
			],
			conductors: [
				{
					groupId: 'workspace-1',
					status: 'idle',
					resourceProfile: 'aggressive',
					keepConductorAgentSessions: false,
					createdAt: 1,
					updatedAt: 1,
				},
			],
			runs: [],
		});

		expect(result.prunedSessionIds).toEqual(['helper-session']);
		expect(result.sessions.map((session) => session.id)).toEqual(['user-session']);
	});

	it('does not recover provider history for conductor worktree projects', async () => {
		const discoverRecoverable = vi.mocked(window.maestro.agentSessions.discoverRecoverable);
		discoverRecoverable.mockResolvedValueOnce([
			{
				agentId: 'claude-code',
				sessionId: 'provider-session-1',
				projectPath: '/tmp/Questionaire-conductor-questionaire-a1f9fa08',
				timestamp: '2026-03-27T03:00:00.000Z',
				modifiedAt: '2026-03-27T03:05:00.000Z',
				firstMessage: 'Open WRAL and categorize headlines',
			},
		]);

		const result = await recoverMissingProviderThreads(
			[],
			[],
			[]
		);

		expect(result.recoveredCount).toBe(0);
		expect(result.sessions).toEqual([]);
		expect(result.groups).toEqual([]);
		expect(result.threads).toEqual([]);
	});
});
