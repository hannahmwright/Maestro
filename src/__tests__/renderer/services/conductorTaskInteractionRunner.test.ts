import { describe, expect, it, vi } from 'vitest';
import type {
	ConductorOrchestratorAction,
} from '../../../shared/conductorOrchestrator';
import type { ConductorRun, ConductorTask, Session } from '../../../shared/types';
import {
	applyConductorOrchestratorActionCommand,
	findLatestExecutionRunForTask,
	findLatestRunForTask,
	runConductorTaskProofCaptureAction,
} from '../../../renderer/services/conductorTaskInteractionRunner';

function buildTask(overrides: Partial<ConductorTask> = {}): ConductorTask {
	return {
		id: 'task-1',
		groupId: 'group-1',
		title: 'Task',
		description: '',
		acceptanceCriteria: [],
		priority: 'medium',
		status: 'needs_proof',
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
		status: 'completed',
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

describe('conductorTaskInteractionRunner', () => {
	it('finds the latest execution and generic run for a task', () => {
		const runs = [
			buildRun({ id: 'run-a', taskIds: ['task-9'] }),
			buildRun({
				id: 'run-b',
				taskIds: ['task-1'],
				taskBranches: { 'task-1': 'codex/task-1' },
			}),
		];

		expect(findLatestExecutionRunForTask(runs, 'task-1')?.id).toBe('run-b');
		expect(findLatestRunForTask(runs, 'task-9')?.id).toBe('run-a');
	});

	it('returns a proof-unavailable toast when no workspace lead exists', async () => {
		const result = await runConductorTaskProofCaptureAction({
			task: buildTask(),
			selectedTemplate: null,
			groupName: 'Questionaire',
			capturingProofTaskId: null,
			requiresCompletionProof: () => true,
			getLatestExecutionForTask: () => null,
			isDirectory: vi.fn(),
			satisfiesRequirement: vi.fn(),
			recordTaskAgentHistory: vi.fn(),
			patchTask: vi.fn(),
			getDemo: vi.fn(),
		});

		expect(result).toEqual(
			expect.objectContaining({
				status: 'done',
				toastType: 'error',
				toastTitle: 'Proof Capture Unavailable',
			})
		);
	});

	it('applies orchestrator task patches and pause toggles through callbacks', () => {
		const action: ConductorOrchestratorAction = {
			type: 'set_task_group_priority',
			label: 'Raise stream',
			taskIds: ['task-1'],
			priority: 'high',
			summary: 'Raised priority.',
		};
		const commitTaskSnapshots = vi.fn();

		const result = applyConductorOrchestratorActionCommand({
			action,
			tasksById: new Map([['task-1', buildTask({ priority: 'low', status: 'ready' })]]),
			isAutoplayPaused: false,
			setAutoplayPaused: vi.fn(),
			commitTaskSnapshots,
			moveTaskStatus: vi.fn(),
		});

		expect(result).toEqual(
			expect.objectContaining({
				handled: true,
				toastTitle: 'Workstream Reprioritized',
			})
		);
		expect(commitTaskSnapshots).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'task-1', priority: 'high' }),
		]);
	});
});
