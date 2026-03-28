import { describe, expect, it, vi } from 'vitest';
import type { ConductorRun, ConductorTask, Session } from '../../../shared/types';
import { createConductorRunJournal } from '../../../renderer/services/conductorRunJournal';
import { createConductorTaskMirror } from '../../../renderer/services/conductorTaskMirror';
import { runConductorReviewLane } from '../../../renderer/services/conductorReviewRunner';

function buildTask(overrides: Partial<ConductorTask> = {}): ConductorTask {
	return {
		id: 'task-1',
		groupId: 'group-1',
		title: 'Task',
		description: 'Do a thing',
		acceptanceCriteria: [],
		priority: 'medium',
		status: 'needs_review',
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

function buildRun(overrides: Partial<ConductorRun> = {}): ConductorRun {
	return {
		id: 'run-1',
		groupId: 'group-1',
		kind: 'review',
		baseBranch: 'main',
		integrationBranch: '',
		status: 'running',
		taskIds: ['task-1'],
		events: [],
		startedAt: 1,
		...overrides,
	};
}

function buildSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Lead',
		toolType: 'codex',
		cwd: '/tmp/work',
		projectRoot: '/tmp/work',
		archived: false,
		history: [],
		tabs: [],
		checkpointCounter: 0,
		hasCheckpointing: false,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	} as Session;
}

describe('runConductorReviewLane', () => {
	it('retries malformed reviewer output and completes the task', async () => {
		const task = buildTask();
		const taskMirror = createConductorTaskMirror([task], {
			commitTaskSnapshot: vi.fn((nextTask) => nextTask),
			commitTaskSnapshots: vi.fn((nextTasks) => nextTasks),
			patchTaskFromSnapshot: vi.fn((currentTask, updates) => ({
				...currentTask,
				...updates,
				updatedAt: 10,
			})),
		});
		const runJournal = createConductorRunJournal(buildRun(), {
			upsertRun: vi.fn(),
			updateRun: vi.fn(),
		});
		const runAgentTurn = vi
			.fn()
			.mockResolvedValueOnce({
				sessionId: 'session-2',
				tabId: 'tab-1',
				toolType: 'codex',
				response: 'not json',
			})
			.mockResolvedValueOnce({
				sessionId: 'session-2',
				tabId: 'tab-1',
				toolType: 'codex',
				response: JSON.stringify({
					decision: 'approved',
					summary: 'Looks good',
					followUpTasks: [],
				}),
			});

		const result = await runConductorReviewLane({
			groupId: 'group-1',
			groupName: 'Group',
			runId: 'run-1',
			selectedTemplate: buildSession(),
			reviewReadyTasks: [task],
			taskMirror,
			runJournal,
			isPaused: () => false,
			isCancelled: () => false,
			clearCancelled: vi.fn(),
			recordTaskAgentHistory: vi.fn(),
			getLatestExecutionForTask: () => undefined,
			runAgentTurn,
		});

		expect(runAgentTurn).toHaveBeenCalledTimes(2);
		expect(result.changesRequested).toBe(0);
		expect(result.malformedResponses).toBe(0);
		expect(taskMirror.get('task-1')).toEqual(expect.objectContaining({ status: 'done' }));
	});
});
