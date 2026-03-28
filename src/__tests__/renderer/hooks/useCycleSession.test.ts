import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCycleSession } from '../../../renderer/hooks/session/useCycleSession';
import type { Session, SidebarThreadTarget, Thread, GroupChat } from '../../../renderer/types';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useUIStore } from '../../../renderer/stores/uiStore';

vi.mock('../../../renderer/hooks/session/useSortedSessions', () => ({
	compareNamesIgnoringEmojis: (left: string, right: string) => left.localeCompare(right),
}));

function createSession(overrides: Partial<Session> & { id: string; name: string }): Session {
	return {
		id: overrides.id,
		name: overrides.name,
		toolType: 'codex',
		state: 'idle',
		cwd: '/tmp',
		fullPath: '/tmp',
		projectRoot: '/tmp',
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
				name: `${overrides.name} Tab`,
				logs: [],
				hasUnread: false,
				state: 'idle',
			},
		],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

function createThread(overrides: Partial<Thread> & { id: string; sessionId: string }): Thread {
	return {
		id: overrides.id,
		workspaceId: 'workspace-1',
		sessionId: overrides.sessionId,
		runtimeId: overrides.sessionId,
		tabId: 'tab-1',
		title: `${overrides.id} title`,
		agentId: 'codex',
		projectRoot: '/tmp',
		pinned: false,
		archived: false,
		isOpen: true,
		createdAt: 1,
		lastUsedAt: 1,
		...overrides,
	} as Thread;
}

function createTarget(
	thread: Thread,
	session: Session,
	overrides: Partial<SidebarThreadTarget> = {}
): SidebarThreadTarget {
	return {
		id: `target-${thread.id}`,
		threadId: thread.id,
		sessionId: session.id,
		runtimeId: session.runtimeId || session.id,
		workspaceId: thread.workspaceId,
		tabId: thread.tabId || null,
		...overrides,
	};
}

function createGroupChat(id: string, name: string, archived = false): GroupChat {
	return {
		id,
		name,
		archived,
		participants: [],
		createdAt: 1,
		updatedAt: 1,
	} as GroupChat;
}

describe('useCycleSession', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		useSessionStore.setState({
			sessions: [],
			groups: [],
			threads: [],
			activeSessionId: '',
			cyclePosition: -1,
		} as Partial<ReturnType<typeof useSessionStore.getState>>);

		useGroupChatStore.setState({
			groupChats: [],
			activeGroupChatId: null,
		} as Partial<ReturnType<typeof useGroupChatStore.getState>>);

		useUIStore.setState({
			leftSidebarOpen: true,
			groupChatsExpanded: true,
		} as Partial<ReturnType<typeof useUIStore.getState>>);
	});

	it('returns a cycleSession function', () => {
		const { result } = renderHook(() =>
			useCycleSession({
				sortedSessions: [],
				sidebarThreadTargets: [],
				handleOpenGroupChat: vi.fn(),
			})
		);

		expect(typeof result.current.cycleSession).toBe('function');
	});

	it('is a no-op when there are no sessions, thread targets, or group chats', () => {
		const handleOpenGroupChat = vi.fn();
		const { result } = renderHook(() =>
			useCycleSession({
				sortedSessions: [],
				sidebarThreadTargets: [],
				handleOpenGroupChat,
			})
		);

		act(() => {
			result.current.cycleSession('next');
		});

		expect(useSessionStore.getState().activeSessionId).toBe('');
		expect(handleOpenGroupChat).not.toHaveBeenCalled();
	});

	it('selects the first visible thread target when nothing is currently active', () => {
		const session = createSession({
			id: 'session-1',
			name: 'Alpha',
			aiTabs: [{ id: 'tab-1', name: 'Alpha Tab', logs: [], hasUnread: false, state: 'idle' }],
			activeTabId: 'tab-1',
		});
		const thread = createThread({ id: 'thread-1', sessionId: session.id });
		const target = createTarget(thread, session);

		useSessionStore.setState({
			sessions: [session],
			threads: [thread],
			activeSessionId: '',
		} as Partial<ReturnType<typeof useSessionStore.getState>>);

		const { result } = renderHook(() =>
			useCycleSession({
				sortedSessions: [session],
				sidebarThreadTargets: [target],
				handleOpenGroupChat: vi.fn(),
			})
		);

		act(() => {
			result.current.cycleSession('next');
		});

		expect(useSessionStore.getState().activeSessionId).toBe('session-1');
		expect(useSessionStore.getState().cyclePosition).toBe(0);
		expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
	});

	it('cycles to the next visible thread target and updates the active tab', () => {
		const sessionOne = createSession({
			id: 'session-1',
			name: 'Alpha',
			aiTabs: [{ id: 'tab-1', name: 'Alpha Tab', logs: [], hasUnread: false, state: 'idle' }],
			activeTabId: 'tab-1',
		});
		const sessionTwo = createSession({
			id: 'session-2',
			name: 'Beta',
			aiTabs: [{ id: 'tab-2', name: 'Beta Tab', logs: [], hasUnread: false, state: 'idle' }],
			activeTabId: 'tab-2',
		});
		const threadOne = createThread({ id: 'thread-1', sessionId: sessionOne.id, tabId: 'tab-1' });
		const threadTwo = createThread({ id: 'thread-2', sessionId: sessionTwo.id, tabId: 'tab-2' });
		const targetOne = createTarget(threadOne, sessionOne);
		const targetTwo = createTarget(threadTwo, sessionTwo);

		useSessionStore.setState({
			sessions: [sessionOne, sessionTwo],
			threads: [threadOne, threadTwo],
			activeSessionId: 'session-1',
			cyclePosition: -1,
		} as Partial<ReturnType<typeof useSessionStore.getState>>);

		const { result } = renderHook(() =>
			useCycleSession({
				sortedSessions: [sessionOne, sessionTwo],
				sidebarThreadTargets: [targetOne, targetTwo],
				handleOpenGroupChat: vi.fn(),
			})
		);

		act(() => {
			result.current.cycleSession('next');
		});

		const state = useSessionStore.getState();
		expect(state.activeSessionId).toBe('session-2');
		expect(state.cyclePosition).toBe(1);
		expect(state.sessions.find((session) => session.id === 'session-2')?.activeTabId).toBe('tab-2');
	});

	it('wraps to the previous visible thread target when cycling backward from the first item', () => {
		const sessionOne = createSession({ id: 'session-1', name: 'Alpha' });
		const sessionTwo = createSession({
			id: 'session-2',
			name: 'Beta',
			aiTabs: [{ id: 'tab-2', name: 'Beta Tab', logs: [], hasUnread: false, state: 'idle' }],
			activeTabId: 'tab-2',
		});
		const threadOne = createThread({ id: 'thread-1', sessionId: sessionOne.id });
		const threadTwo = createThread({ id: 'thread-2', sessionId: sessionTwo.id, tabId: 'tab-2' });

		useSessionStore.setState({
			sessions: [sessionOne, sessionTwo],
			threads: [threadOne, threadTwo],
			activeSessionId: 'session-1',
			cyclePosition: 0,
		} as Partial<ReturnType<typeof useSessionStore.getState>>);

		const { result } = renderHook(() =>
			useCycleSession({
				sortedSessions: [sessionOne, sessionTwo],
				sidebarThreadTargets: [
					createTarget(threadOne, sessionOne),
					createTarget(threadTwo, sessionTwo),
				],
				handleOpenGroupChat: vi.fn(),
			})
		);

		act(() => {
			result.current.cycleSession('prev');
		});

		expect(useSessionStore.getState().activeSessionId).toBe('session-2');
		expect(useSessionStore.getState().cyclePosition).toBe(1);
	});

	it('cycles from visible thread targets into non-archived group chats when the list is expanded', () => {
		const session = createSession({ id: 'session-1', name: 'Alpha' });
		const thread = createThread({ id: 'thread-1', sessionId: session.id });
		const handleOpenGroupChat = vi.fn();

		useSessionStore.setState({
			sessions: [session],
			threads: [thread],
			activeSessionId: 'session-1',
		} as Partial<ReturnType<typeof useSessionStore.getState>>);
		useGroupChatStore.setState({
			groupChats: [
				createGroupChat('chat-b', 'Beta Chat'),
				createGroupChat('chat-a', 'Alpha Chat'),
				createGroupChat('chat-archived', 'Archived Chat', true),
			],
		} as Partial<ReturnType<typeof useGroupChatStore.getState>>);

		const { result } = renderHook(() =>
			useCycleSession({
				sortedSessions: [session],
				sidebarThreadTargets: [createTarget(thread, session)],
				handleOpenGroupChat,
			})
		);

		act(() => {
			result.current.cycleSession('next');
		});

		expect(handleOpenGroupChat).toHaveBeenCalledWith('chat-a');
	});

	it('falls back to sorted sessions when the sidebar is collapsed', () => {
		const sessionOne = createSession({ id: 'session-1', name: 'Alpha' });
		const sessionTwo = createSession({ id: 'session-2', name: 'Beta' });
		useUIStore.setState({
			leftSidebarOpen: false,
		} as Partial<ReturnType<typeof useUIStore.getState>>);
		useSessionStore.setState({
			sessions: [sessionOne, sessionTwo],
			activeSessionId: 'session-1',
		} as Partial<ReturnType<typeof useSessionStore.getState>>);

		const { result } = renderHook(() =>
			useCycleSession({
				sortedSessions: [sessionOne, sessionTwo],
				sidebarThreadTargets: [],
				handleOpenGroupChat: vi.fn(),
			})
		);

		act(() => {
			result.current.cycleSession('next');
		});

		expect(useSessionStore.getState().activeSessionId).toBe('session-2');
		expect(useSessionStore.getState().cyclePosition).toBe(1);
	});

	it('clears the active group chat when cycling back into a thread target', () => {
		const session = createSession({ id: 'session-1', name: 'Alpha' });
		const thread = createThread({ id: 'thread-1', sessionId: session.id });

		useSessionStore.setState({
			sessions: [session],
			threads: [thread],
			activeSessionId: '',
		} as Partial<ReturnType<typeof useSessionStore.getState>>);
		useGroupChatStore.setState({
			activeGroupChatId: 'chat-1',
		} as Partial<ReturnType<typeof useGroupChatStore.getState>>);

		const { result } = renderHook(() =>
			useCycleSession({
				sortedSessions: [session],
				sidebarThreadTargets: [createTarget(thread, session)],
				handleOpenGroupChat: vi.fn(),
			})
		);

		act(() => {
			result.current.cycleSession('next');
		});

		expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
		expect(useSessionStore.getState().activeSessionId).toBe('session-1');
	});
});
