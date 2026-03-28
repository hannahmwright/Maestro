import { describe, expect, it } from 'vitest';
import type { ConductorRun, ConductorTask, Session } from '../../../shared/types';
import type { DemoCard } from '../../../shared/demo-artifacts';
import {
	buildConductorProofCaptureFailurePatch,
	buildConductorProofCaptureStartPatch,
	buildConductorProofCaptureSuccessPatch,
	buildConductorTaskCancelledRunUpdate,
	getActiveConductorTaskSessionId,
	getConductorTaskProcessSessionIds,
	resolveConductorProofExecutionContext,
} from '../../../renderer/services/conductorTaskRuntime';

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

function buildDemoCard(overrides: Partial<DemoCard> = {}): DemoCard {
	return {
		demoId: 'demo-1',
		captureRunId: 'capture-1',
		title: 'Demo',
		status: 'completed',
		verificationStatus: 'verified',
		captureSource: 'agent',
		isSimulated: false,
		requirementSatisfied: true,
		createdAt: 1,
		updatedAt: 1,
		stepCount: 3,
		...overrides,
	};
}

describe('conductorTaskRuntime', () => {
	it('finds active task session ids by task status', () => {
		const reviewer = buildSession({ id: 'reviewer-1', state: 'busy' });
		const sessionById = new Map<string, Pick<Session, 'id' | 'state'>>([[reviewer.id, reviewer]]);

		expect(
			getActiveConductorTaskSessionId(
				buildTask({ status: 'planning', plannerSessionId: 'planner-1' }),
				sessionById
			)
		).toBe('planner-1');
		expect(
			getActiveConductorTaskSessionId(
				buildTask({ status: 'running', workerSessionId: 'worker-1' }),
				sessionById
			)
		).toBe('worker-1');
		expect(
			getActiveConductorTaskSessionId(
				buildTask({ status: 'needs_review', reviewerSessionId: 'reviewer-1' }),
				sessionById
			)
		).toBe('reviewer-1');
	});

	it('builds candidate process ids for an agent session', () => {
		const sessionById = new Map<string, Pick<Session, 'activeTabId'>>([
			['session-1', buildSession({ id: 'session-1', activeTabId: 'tab-9' })],
		]);

		expect(getConductorTaskProcessSessionIds('session-1', sessionById)).toEqual([
			'session-1-ai-tab-9',
			'session-1-ai',
		]);
	});

	it('resolves proof execution context using the first valid worktree path', async () => {
		const result = await resolveConductorProofExecutionContext({
			task: buildTask({ scopePaths: ['/fallback'] }),
			latestTaskExecution: buildRun({
				taskWorktreePaths: { 'task-1': '/tmp/worktree' },
				taskBranches: { 'task-1': 'worker-branch' },
			}),
			selectedTemplate: buildSession({ cwd: '/tmp/template' }),
			isDirectory: async (path) => path === '/tmp/worktree',
		});

		expect(result).toEqual({ cwd: '/tmp/worktree', branch: 'worker-branch' });
	});

	it('builds stop-run event updates and proof capture patches', () => {
		const runUpdate = buildConductorTaskCancelledRunUpdate({
			run: buildRun(),
			groupId: 'group-1',
			taskTitle: 'Ship it',
			createdAt: 10,
			generateEventId: () => 'event-1',
		});
		expect(runUpdate.events).toEqual([
			expect.objectContaining({
				id: 'event-1',
				type: 'task_cancelled',
				message: 'Manager stopped Ship it.',
			}),
		]);

		const startPatch = buildConductorProofCaptureStartPatch(buildTask(), 20);
		const successPatch = buildConductorProofCaptureSuccessPatch({
			task: buildTask(),
			demoCard: buildDemoCard(),
			now: 21,
		});
		const failurePatch = buildConductorProofCaptureFailurePatch({
			task: buildTask({
				completionProof: {
					status: 'capturing',
				},
			}),
			now: 22,
		});

		expect(startPatch).toEqual(
			expect.objectContaining({
				status: 'needs_proof',
				completionProof: expect.objectContaining({ status: 'capturing', requestedAt: 20 }),
			})
		);
		expect(successPatch).toEqual(
			expect.objectContaining({
				status: 'needs_proof',
				completionProof: expect.objectContaining({
					status: 'captured',
					demoId: 'demo-1',
					capturedAt: 21,
				}),
			})
		);
		expect(failurePatch).toEqual(
			expect.objectContaining({
				status: 'needs_proof',
				completionProof: expect.objectContaining({ status: 'missing', requestedAt: 22 }),
			})
		);
	});
});
