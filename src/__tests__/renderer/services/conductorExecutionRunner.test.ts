import { describe, expect, it, vi } from 'vitest';
import type { ConductorRun, ConductorTask, Session } from '../../../shared/types';
import { createConductorRunJournal } from '../../../renderer/services/conductorRunJournal';
import { createConductorTaskMirror } from '../../../renderer/services/conductorTaskMirror';
import { runConductorExecutionLane } from '../../../renderer/services/conductorExecutionRunner';

function buildTask(overrides: Partial<ConductorTask> = {}): ConductorTask {
	return {
		id: 'task-1',
		groupId: 'group-1',
		title: 'Visit Example',
		description: 'Visit the site',
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

function buildRun(overrides: Partial<ConductorRun> = {}): ConductorRun {
	return {
		id: 'run-1',
		groupId: 'group-1',
		kind: 'execution',
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

describe('runConductorExecutionLane', () => {
	it('runs a single worker task and moves it to review', async () => {
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
		const completedTaskIds = new Set<string>();
		const blockedTaskIds = new Set<string>();
		const runAgentTurn = vi.fn().mockImplementation(async (options) => {
			options.onSessionReady?.({
				id: 'worker-session-1',
				name: 'Worker',
				toolType: 'codex',
			} as Session);
			return {
				sessionId: 'worker-session-1',
				tabId: 'tab-1',
				toolType: 'codex',
				response: JSON.stringify({
					outcome: 'completed',
					summary: 'Done',
					changedPaths: ['output/result.txt'],
					evidence: [{ kind: 'file', label: 'Result', path: 'output/result.txt' }],
					followUpTasks: [],
				}),
			};
		});

		const result = await runConductorExecutionLane({
			groupId: 'group-1',
			groupName: 'Group',
			runId: 'run-1',
			selectedTemplate: buildSession(),
			repoRoot: '/tmp/work',
			maxWorkers: 1,
			taskMirror,
			runJournal,
			liveRuns: [],
			childTasksByParentId: new Map(),
			completedTaskIds,
			blockedTaskIds,
			getDependencyReadyTasks: () => {
				const liveTask = taskMirror.get('task-1');
				return liveTask?.status === 'ready' ? [liveTask] : [];
			},
			isPaused: () => false,
			userPausedMessage: 'Paused by you.',
			isCancelled: () => false,
			clearCancelled: vi.fn(),
			recordTaskAgentHistory: vi.fn(),
			buildTaskAttentionRequest: vi.fn((input) => ({
				id: 'attention-1',
				status: 'open',
				kind: input.kind,
				summary: input.summary,
				requestedAction: input.requestedAction,
				requestedByRole: input.requestedByRole,
				requestedBySessionId: input.requestedBySessionId,
				suggestedResponse: input.suggestedResponse,
				runId: input.runId,
				createdAt: 1,
				updatedAt: 1,
			})),
			buildClarificationPrompt: vi.fn(() => 'clarify'),
			isProviderLimitMessage: () => false,
			runAgentTurn,
			worktreeSetup: vi.fn().mockResolvedValue({ success: true }),
		});

		expect(runAgentTurn).toHaveBeenCalledTimes(1);
		expect(result.blockedMessage).toBeNull();
		expect(result.pausedByUser).toBe(false);
		expect(result.workerAgentSessionIds).toEqual(['worker-session-1']);
		expect(completedTaskIds.has('task-1')).toBe(true);
		expect(taskMirror.get('task-1')).toEqual(
			expect.objectContaining({
				status: 'needs_review',
				changedPaths: ['output/result.txt'],
			})
		);
	});

	it('retries once when the worker finishes without a readable final result', async () => {
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
		const completedTaskIds = new Set<string>();
		const blockedTaskIds = new Set<string>();
		const runAgentTurn = vi
			.fn()
			.mockImplementationOnce(async (options) => {
				options.onSessionReady?.({
					id: 'worker-session-1',
					name: 'Worker',
					toolType: 'claude-code',
				} as Session);
				return {
					sessionId: 'worker-session-1',
					tabId: 'tab-1',
					toolType: 'claude-code',
					response: 'Captured demo proof',
				};
			})
			.mockImplementationOnce(async (options) => {
				options.onSessionReady?.({
					id: 'worker-session-2',
					name: 'Worker Retry',
					toolType: 'claude-code',
				} as Session);
				return {
					sessionId: 'worker-session-2',
					tabId: 'tab-2',
					toolType: 'claude-code',
					response: JSON.stringify({
						outcome: 'completed',
						summary: 'Done after retry',
						changedPaths: ['output/result.txt'],
						evidence: [{ kind: 'file', label: 'Result', path: 'output/result.txt' }],
						followUpTasks: [],
					}),
				};
			});

		const result = await runConductorExecutionLane({
			groupId: 'group-1',
			groupName: 'Group',
			runId: 'run-1',
			selectedTemplate: buildSession(),
			repoRoot: '/tmp/work',
			maxWorkers: 1,
			taskMirror,
			runJournal,
			liveRuns: [],
			childTasksByParentId: new Map(),
			completedTaskIds,
			blockedTaskIds,
			getDependencyReadyTasks: () => {
				const liveTask = taskMirror.get('task-1');
				return liveTask?.status === 'ready' ? [liveTask] : [];
			},
			isPaused: () => false,
			userPausedMessage: 'Paused by you.',
			isCancelled: () => false,
			clearCancelled: vi.fn(),
			recordTaskAgentHistory: vi.fn(),
			buildTaskAttentionRequest: vi.fn((input) => ({
				id: 'attention-1',
				status: 'open',
				kind: input.kind,
				summary: input.summary,
				requestedAction: input.requestedAction,
				requestedByRole: input.requestedByRole,
				requestedBySessionId: input.requestedBySessionId,
				suggestedResponse: input.suggestedResponse,
				runId: input.runId,
				createdAt: 1,
				updatedAt: 1,
			})),
			buildClarificationPrompt: vi.fn(() => 'clarify'),
			isProviderLimitMessage: () => false,
			runAgentTurn,
			worktreeSetup: vi.fn().mockResolvedValue({ success: true }),
		});

		expect(runAgentTurn).toHaveBeenCalledTimes(2);
		expect(result.blockedMessage).toBeNull();
		expect(completedTaskIds.has('task-1')).toBe(true);
		expect(taskMirror.get('task-1')).toEqual(
			expect.objectContaining({
				status: 'needs_review',
			})
		);
	});

	it('adds worker follow-up tasks to the execution run journal', async () => {
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
		const completedTaskIds = new Set<string>();
		const blockedTaskIds = new Set<string>();
		const runAgentTurn = vi.fn().mockImplementation(async (options) => {
			options.onSessionReady?.({
				id: 'worker-session-1',
				name: 'Worker',
				toolType: 'codex',
			} as Session);
			return {
				sessionId: 'worker-session-1',
				tabId: 'tab-1',
				toolType: 'codex',
				response: JSON.stringify({
					outcome: 'completed',
					summary: 'Done',
					changedPaths: ['output/result.txt'],
					evidence: [{ kind: 'file', label: 'Result', path: 'output/result.txt' }],
					followUpTasks: [
						{
							title: 'Follow-up task',
							description: 'Keep going',
							priority: 'medium',
						},
					],
				}),
			};
		});

		await runConductorExecutionLane({
			groupId: 'group-1',
			groupName: 'Group',
			runId: 'run-1',
			selectedTemplate: buildSession(),
			repoRoot: '/tmp/work',
			maxWorkers: 1,
			taskMirror,
			runJournal,
			liveRuns: [],
			childTasksByParentId: new Map(),
			completedTaskIds,
			blockedTaskIds,
			getDependencyReadyTasks: () => {
				const liveTask = taskMirror.get('task-1');
				return liveTask?.status === 'ready' ? [liveTask] : [];
			},
			isPaused: () => false,
			userPausedMessage: 'Paused by you.',
			isCancelled: () => false,
			clearCancelled: vi.fn(),
			recordTaskAgentHistory: vi.fn(),
			buildTaskAttentionRequest: vi.fn((input) => ({
				id: 'attention-1',
				status: 'open',
				kind: input.kind,
				summary: input.summary,
				requestedAction: input.requestedAction,
				requestedByRole: input.requestedByRole,
				requestedBySessionId: input.requestedBySessionId,
				suggestedResponse: input.suggestedResponse,
				runId: input.runId,
				createdAt: 1,
				updatedAt: 1,
			})),
			buildClarificationPrompt: vi.fn(() => 'clarify'),
			isProviderLimitMessage: () => false,
			runAgentTurn,
			worktreeSetup: vi.fn().mockResolvedValue({ success: true }),
		});

		const followUpTask = taskMirror
			.values()
			.find((candidate) => candidate.title === 'Follow-up task');
		expect(followUpTask).toBeTruthy();
		expect(runJournal.getRun().taskIds).toContain('task-1');
		expect(runJournal.getRun().taskIds).toContain(followUpTask!.id);
	});
});
