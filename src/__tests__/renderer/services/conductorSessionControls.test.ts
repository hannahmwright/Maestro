import { describe, expect, it } from 'vitest';
import type {
	ConductorTask,
	Session,
	Thread,
} from '../../../shared/types';
import {
	buildConductorTaskAgentBadges,
	buildConductorTaskAttentionRequest,
	cleanupConductorAgentSessionState,
} from '../../../renderer/services/conductorSessionControls';

function buildSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Session',
		cwd: '/tmp/project',
		type: 'claude-code',
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

function buildThread(overrides: Partial<Thread> = {}): Thread {
	return {
		id: 'thread-1',
		sessionId: 'session-1',
		runtimeId: 'session-1',
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	} as Thread;
}

function buildTask(overrides: Partial<ConductorTask> = {}): ConductorTask {
	return {
		id: 'task-1',
		groupId: 'group-1',
		title: 'Task',
		description: '',
		acceptanceCriteria: [],
		priority: 'medium',
		status: 'ready',
		dependsOn: [],
		scopePaths: [],
		source: 'planner',
		attentionRequest: null,
		agentHistory: [],
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe('conductorSessionControls', () => {
	it('builds open attention requests with generated ids', () => {
		const request = buildConductorTaskAttentionRequest({
			kind: 'clarification',
			summary: 'Need more info',
			requestedAction: 'Clarify env',
			requestedByRole: 'worker',
			generateId: () => '123',
			now: 10,
		});

		expect(request).toEqual(
			expect.objectContaining({
				id: 'conductor-task-attention-123',
				status: 'open',
				createdAt: 10,
				updatedAt: 10,
			})
		);
	});

	it('cleans up helper sessions and falls back active session safely', () => {
		const cleaned = cleanupConductorAgentSessionState({
			sessionIds: ['session-1'],
			threads: [buildThread()],
			sessions: [buildSession(), buildSession({ id: 'session-2' })],
			activeSessionId: 'session-1',
			selectedTemplateId: 'session-2',
			isPaused: false,
		});

		expect(cleaned).toEqual({
			threads: [],
			sessions: [expect.objectContaining({ id: 'session-2' })],
			activeSessionId: 'session-2',
		});
	});

	it('builds unique task agent badges from session refs and history', () => {
		const badges = buildConductorTaskAgentBadges({
			task: buildTask({
				workerSessionId: 'worker-1',
				workerSessionName: 'Rowan',
				agentHistory: [
					{
						id: 'agent-1',
						role: 'worker',
						sessionId: 'worker-1',
						sessionName: 'Rowan',
						createdAt: 1,
					},
				],
			}),
			sessionById: new Map([['worker-1', buildSession({ id: 'worker-1', state: 'busy' })]]),
			sessionNameById: new Map(),
			formatRoleLabel: (role) => role.toUpperCase(),
		});

		expect(badges).toEqual([
			expect.objectContaining({
				sessionId: 'worker-1',
				label: 'WORKER: Rowan',
				tone: 'accent',
			}),
		]);
	});
});
