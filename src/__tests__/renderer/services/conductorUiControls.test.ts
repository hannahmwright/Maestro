import { describe, expect, it } from 'vitest';
import type { Session } from '../../../shared/types';
import {
	collectIdleConductorAgentSessionIds,
	findConductorTeamMemberByName,
	resolveConductorAgentSessionSelection,
	resolveConductorTeamMemberOpen,
	resolveConductorThreadNavigation,
	resolveConductorWorktreeStorageOpen,
} from '../../../renderer/services/conductorUiControls';

function buildSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Session',
		cwd: '/tmp/project',
		type: 'codex',
		state: 'idle',
		tabs: [],
		activeTabId: 'tab-1',
		gitBranches: [],
		inputMode: 'ai',
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	} as Session;
}

describe('conductorUiControls', () => {
	it('selects an agent session only when it exists', () => {
		const sessionById = new Map([['session-1', {}]]);

		expect(resolveConductorAgentSessionSelection(sessionById, 'session-1')).toBe('session-1');
		expect(resolveConductorAgentSessionSelection(sessionById, 'missing')).toBeNull();
	});

	it('returns a session patch when thread navigation must switch tabs', () => {
		const navigation = resolveConductorThreadNavigation({
			sessionById: new Map([['session-1', buildSession({ activeTabId: 'tab-a' })]]),
			sessionId: 'session-1',
			tabId: 'tab-b',
		});

		expect(navigation).toEqual({
			sessionId: 'session-1',
			sessionPatch: {
				activeTabId: 'tab-b',
				activeFileTabId: null,
				inputMode: 'ai',
			},
		});
	});

	it('resolves team-member open behavior based on thread count', () => {
		expect(
			resolveConductorTeamMemberOpen({
				sessionId: 'session-1',
				name: 'Rory',
				threadTargets: [{ sessionId: 'session-2', tabId: 'tab-2' }],
			})
		).toEqual({
			kind: 'navigate',
			sessionId: 'session-2',
			tabId: 'tab-2',
		});

		expect(
			resolveConductorTeamMemberOpen({
				sessionId: 'session-1',
				name: 'Rory',
				threadTargets: [
					{ sessionId: 'session-2', tabId: 'tab-2' },
					{ sessionId: 'session-3', tabId: 'tab-3' },
				],
			})
		).toEqual({ kind: 'select_member' });
	});

	it('builds worktree-storage actions and idle-session cleanup lists', () => {
		expect(resolveConductorWorktreeStorageOpen(null)).toEqual(
			expect.objectContaining({ kind: 'missing_template' })
		);
		expect(resolveConductorWorktreeStorageOpen({ id: 'session-9' })).toEqual({
			kind: 'open_modal',
			activeSessionId: 'session-9',
		});

		expect(
			collectIdleConductorAgentSessionIds([
				buildSession({ id: 'idle-1', state: 'idle' }),
				buildSession({ id: 'busy-1', state: 'busy' }),
				buildSession({ id: 'waiting-1', state: 'waiting' }),
			])
		).toEqual(['idle-1', 'waiting-1']);
	});

	it('finds team members by name', () => {
		expect(
			findConductorTeamMemberByName(
				[
					{ sessionId: 'a', name: 'Rory', threadTargets: [] },
					{ sessionId: 'b', name: 'Celine', threadTargets: [] },
				],
				'Celine'
			)
		).toEqual({ sessionId: 'b', name: 'Celine', threadTargets: [] });
		expect(findConductorTeamMemberByName([], 'Celine')).toBeNull();
	});
});
