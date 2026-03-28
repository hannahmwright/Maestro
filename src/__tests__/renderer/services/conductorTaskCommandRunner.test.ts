import { describe, expect, it, vi } from 'vitest';
import type { ConductorRun, ConductorTask, Session } from '../../../shared/types';
import type { DemoCard, DemoDetail } from '../../../shared/demo-artifacts';
import {
	captureConductorTaskProofCommand,
	stopConductorTaskCommand,
} from '../../../renderer/services/conductorTaskCommandRunner';

function buildTask(overrides: Partial<ConductorTask> = {}): ConductorTask {
	return {
		id: 'task-1',
		groupId: 'group-1',
		title: 'Task',
		description: '',
		acceptanceCriteria: [],
		priority: 'medium',
		status: 'running',
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

function buildDemoDetail(overrides: Partial<DemoDetail> = {}): DemoDetail {
	return {
		...buildDemoCard(),
		sessionId: 'session-1',
		tabId: 'tab-1',
		steps: [],
		...overrides,
	};
}

describe('conductorTaskCommandRunner', () => {
	it('stops a running task and records a cancellation event', async () => {
		const cancelTask = vi.fn();
		const updateRun = vi.fn();
		const result = await stopConductorTaskCommand({
			task: buildTask({ workerSessionId: 'worker-1' }),
			groupId: 'group-1',
			sessionById: new Map([
				['worker-1', buildSession({ id: 'worker-1', activeTabId: 'tab-9' })],
			]),
			cancelTask,
			getLatestRunForTask: () => buildRun(),
			updateRun,
			killProcess: vi.fn().mockResolvedValueOnce(true),
			generateEventId: () => 'event-1',
		});

		expect(cancelTask).toHaveBeenCalledWith('task-1');
		expect(updateRun).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({
				events: [expect.objectContaining({ id: 'event-1', type: 'task_cancelled' })],
			})
		);
		expect(result).toEqual(
			expect.objectContaining({ toastType: 'success', toastTitle: 'Task Stopped' })
		);
	});

	it('captures proof and returns the persisted demo detail on success', async () => {
		const patchTask = vi.fn();
		const result = await captureConductorTaskProofCommand({
			task: buildTask({
				status: 'needs_proof',
				completionProofRequirement: { required: true, requireVideo: false, minScreenshots: 1 },
			}),
			selectedTemplate: buildSession(),
			getLatestExecutionForTask: () => null,
			isDirectory: vi.fn().mockResolvedValue(true),
			satisfiesRequirement: () => true,
			runProofTurn: vi.fn().mockResolvedValue({ demoCard: buildDemoCard() }),
			getDemo: vi.fn().mockResolvedValue(buildDemoDetail()),
			patchTask,
		});

		expect(patchTask).toHaveBeenCalledTimes(2);
		expect(result).toEqual(
			expect.objectContaining({ status: 'success', toastTitle: 'Proof Captured' })
		);
	});
});
