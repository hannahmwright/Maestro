/**
 * Tests for useMobileSessionManagement hook
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useMobileSessionManagement,
	type UseMobileSessionManagementDeps,
} from '../../../web/hooks/useMobileSessionManagement';
import type { Session } from '../../../web/hooks/useSessions';

const baseDeps: UseMobileSessionManagementDeps = {
	savedActiveSessionId: null,
	savedActiveTabId: null,
	isOffline: true,
	sendRef: { current: null },
	triggerHaptic: vi.fn(),
	hapticTapPattern: 10,
};

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Session 1',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/tmp',
		aiTabs: [
			{
				id: 'tab-1',
				agentSessionId: null,
				name: 'Tab 1',
				starred: false,
				inputValue: '',
				createdAt: Date.now(),
				state: 'idle',
			},
		],
		activeTabId: 'tab-1',
		...overrides,
	} as Session;
}

function createFetchResponse(sessionOverrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		json: vi.fn().mockResolvedValue({
			session: {
				aiLogs: [],
				shellLogs: [],
				...sessionOverrides,
			},
		}),
	};
}

describe('useMobileSessionManagement', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({
					session: {
						aiLogs: [],
						shellLogs: [],
					},
					sessions: [],
				}),
			} as any)
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('selects a session and syncs active tab', () => {
		const sendSpy = vi.fn();
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				sendRef: { current: sendSpy },
			})
		);

		const session: Session = {
			id: 'session-1',
			name: 'Session 1',
			toolType: 'claude-code',
			state: 'idle',
			inputMode: 'ai',
			cwd: '/tmp',
			aiTabs: [],
			activeTabId: 'tab-1',
		} as Session;

		act(() => {
			result.current.setSessions([session]);
		});

		act(() => {
			result.current.handleSelectSession('session-1');
		});

		expect(result.current.activeSessionId).toBe('session-1');
		expect(result.current.activeTabId).toBe('tab-1');
		expect(sendSpy).toHaveBeenCalledWith({
			type: 'select_session',
			sessionId: 'session-1',
			tabId: 'tab-1',
		});
	});

	it('clears activeTabId when the active session is removed', () => {
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);

		act(() => {
			result.current.sessionsHandlers.onSessionRemoved('session-1');
		});

		expect(result.current.activeSessionId).toBeNull();
		expect(result.current.activeTabId).toBeNull();
	});

	it('adds output logs for the active session and tab', async () => {
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);

		// Refs should be initialized immediately with saved values (no race condition)
		expect(result.current.activeSessionIdRef.current).toBe('session-1');

		act(() => {
			result.current.sessionsHandlers.onSessionOutput('session-1', 'hello', 'ai', 'tab-1');
		});

		expect(result.current.sessionLogs.aiLogs).toHaveLength(1);
		expect(result.current.sessionLogs.aiLogs[0].text).toBe('hello');
	});

	it('keeps background log refreshes non-blocking after the initial load', async () => {
		vi.useFakeTimers();
		const fetchMock = vi.mocked(fetch);
		const backgroundResponse = Promise.withResolvers<any>();

		fetchMock
			.mockResolvedValueOnce(
				createFetchResponse({
					aiLogs: [{ id: 'log-1', timestamp: 1, text: 'hello', source: 'stdout' }],
				}) as any
			)
			.mockImplementationOnce(() => backgroundResponse.promise);

		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				isOffline: false,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);

		act(() => {
			result.current.setSessions([createSession({ state: 'busy' })]);
		});

		expect(result.current.isLoadingLogs).toBe(true);

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(result.current.isLoadingLogs).toBe(false);
		expect(result.current.sessionLogs.aiLogs).toHaveLength(1);

		await act(async () => {
			vi.advanceTimersByTime(20000);
			await Promise.resolve();
		});

		expect(
			fetchMock.mock.calls.filter(([url]) => String(url).includes('/session/session-1')).length
		).toBe(2);
		expect(result.current.isLoadingLogs).toBe(false);
		expect(result.current.sessionLogs.aiLogs[0].text).toBe('hello');

		await act(async () => {
			backgroundResponse.resolve(
				createFetchResponse({
					aiLogs: [{ id: 'log-2', timestamp: 2, text: 'hello again', source: 'stdout' }],
				}) as any
			);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(result.current.isLoadingLogs).toBe(false);
		expect(result.current.sessionLogs.aiLogs[0].text).toBe('hello again');
	});

	it('ignores stale log responses after switching sessions', async () => {
		const fetchMock = vi.mocked(fetch);
		const firstResponse = Promise.withResolvers<any>();
		const secondResponse = Promise.withResolvers<any>();

		fetchMock
			.mockImplementationOnce(() => firstResponse.promise)
			.mockImplementationOnce(() => secondResponse.promise);

		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				isOffline: false,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);

		act(() => {
			result.current.setSessions([
				createSession(),
				createSession({
					id: 'session-2',
					name: 'Session 2',
					activeTabId: 'tab-2',
					aiTabs: [
						{
							id: 'tab-2',
							agentSessionId: null,
							name: 'Tab 2',
							starred: false,
							inputValue: '',
							createdAt: Date.now(),
							state: 'idle',
						},
					],
				}),
			]);
		});

		act(() => {
			result.current.handleSelectSession('session-2');
		});

		await act(async () => {
			secondResponse.resolve(
				createFetchResponse({
					aiLogs: [{ id: 'session-2-log', timestamp: 2, text: 'session two', source: 'stdout' }],
				}) as any
			);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(result.current.activeSessionId).toBe('session-2');
		expect(result.current.sessionLogs.aiLogs[0].text).toBe('session two');

		await act(async () => {
			firstResponse.resolve(
				createFetchResponse({
					aiLogs: [{ id: 'session-1-log', timestamp: 1, text: 'session one', source: 'stdout' }],
				}) as any
			);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(result.current.activeSessionId).toBe('session-2');
		expect(result.current.sessionLogs.aiLogs[0].text).toBe('session two');
	});

	it('does not fetch logs for optimistic pending tabs', async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValue(createFetchResponse() as any);

		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				isOffline: false,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);

		act(() => {
			result.current.setSessions([createSession()]);
			result.current.handleSelectSession('session-1');
		});

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		fetchMock.mockClear();

		act(() => {
			result.current.setSessions([
				createSession({
					aiTabs: [
						{
							id: 'tab-1',
							agentSessionId: null,
							name: 'Tab 1',
							starred: false,
							inputValue: '',
							createdAt: Date.now(),
							state: 'idle',
						},
						{
							id: 'pending-tab-1',
							agentSessionId: null,
							name: null,
							starred: false,
							inputValue: '',
							createdAt: Date.now(),
							state: 'idle',
						},
					],
					activeTabId: 'pending-tab-1',
				}),
			]);
			result.current.handleSelectSessionTab('session-1', 'pending-tab-1');
		});

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(result.current.activeTabId).toMatch(/^pending-tab-/);
		expect(result.current.sessionLogs.aiLogs).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('streams assistant output without disturbing tool logs', () => {
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);

		act(() => {
			result.current.setSessions([createSession()]);
			result.current.handleSelectSession('session-1');
		});

		act(() => {
			result.current.sessionsHandlers.onSessionLogEntry('session-1', 'tab-1', 'ai', {
				id: 'tool-1',
				timestamp: Date.now(),
				source: 'tool',
				text: 'Running tool',
			});
		});

		act(() => {
			result.current.sessionsHandlers.onAssistantStream('session-1', 'tab-1', {
				mode: 'append',
				text: 'Hello',
			});
			result.current.sessionsHandlers.onAssistantStream('session-1', 'tab-1', {
				mode: 'append',
				text: ' world',
			});
			result.current.sessionsHandlers.onAssistantStream('session-1', 'tab-1', {
				mode: 'commit',
			});
		});

		expect(result.current.sessionLogs.aiLogs).toHaveLength(2);
		expect(result.current.sessionLogs.aiLogs[0]).toMatchObject({
			id: 'tool-1',
			source: 'tool',
			text: 'Running tool',
		});
		expect(result.current.sessionLogs.aiLogs[1]).toMatchObject({
			source: 'ai',
			text: 'Hello world',
		});

		act(() => {
			result.current.sessionsHandlers.onAssistantStream('session-1', 'tab-1', {
				mode: 'append',
				text: 'Second reply',
			});
		});

		expect(result.current.sessionLogs.aiLogs).toHaveLength(3);
		expect(result.current.sessionLogs.aiLogs[2]).toMatchObject({
			source: 'ai',
			text: 'Second reply',
		});
	});

	it('discards provisional assistant output cleanly', () => {
		const { result } = renderHook(() =>
			useMobileSessionManagement({
				...baseDeps,
				savedActiveSessionId: 'session-1',
				savedActiveTabId: 'tab-1',
			})
		);

		act(() => {
			result.current.setSessions([createSession()]);
		});

		act(() => {
			result.current.sessionsHandlers.onAssistantStream('session-1', 'tab-1', {
				mode: 'append',
				text: 'Temporary reply',
			});
		});

		expect(result.current.sessionLogs.aiLogs).toHaveLength(1);
		expect(result.current.sessionLogs.aiLogs[0]).toMatchObject({
			source: 'ai',
			text: 'Temporary reply',
		});

		act(() => {
			result.current.sessionsHandlers.onAssistantStream('session-1', 'tab-1', {
				mode: 'discard',
			});
		});

		expect(result.current.sessionLogs.aiLogs).toEqual([]);
	});
});
