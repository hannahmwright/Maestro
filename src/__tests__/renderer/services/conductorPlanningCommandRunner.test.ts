import { describe, expect, it, vi } from 'vitest';
import type { ConductorRun, ConductorTask } from '../../../shared/types';
import {
	approveConductorPlanningRunCommand,
	deriveConductorPlanTitle,
	runConductorBoardPlanningCommand,
} from '../../../renderer/services/conductorPlanningCommandRunner';

function buildTask(overrides: Partial<ConductorTask> = {}): ConductorTask {
	return {
		id: 'task-1',
		groupId: 'group-1',
		title: 'Task',
		description: '',
		acceptanceCriteria: [],
		priority: 'medium',
		status: 'draft',
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
		kind: 'planning',
		baseBranch: 'main',
		integrationBranch: '',
		status: 'planning',
		taskIds: ['task-1'],
		events: [],
		startedAt: 1,
		agentSessionIds: ['planner-1'],
		...overrides,
	};
}

describe('conductorPlanningCommandRunner', () => {
	it('derives a concise title from the first request line', () => {
		expect(deriveConductorPlanTitle('Ship the new dashboard\nwith telemetry')).toBe(
			'Ship the new dashboard'
		);
		expect(deriveConductorPlanTitle('')).toBe('New Conductor request');
	});

	it('approves a planning run and marks draft planner tasks ready', () => {
		const commitTaskSnapshots = vi.fn();
		const updateRun = vi.fn();
		const result = approveConductorPlanningRunCommand({
			runId: 'run-1',
			groupId: 'group-1',
			runs: [buildRun()],
			tasks: [buildTask(), buildTask({ id: 'task-2', status: 'ready' })],
			commitTaskSnapshots,
			upsertRun: vi.fn(),
			updateRun,
			transitionConductor: vi.fn(),
			cleanupSessions: vi.fn(),
		});

		expect(result).toBe(true);
		expect(commitTaskSnapshots).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'task-1', status: 'ready' }),
		]);
		expect(updateRun).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({ approvedAt: expect.any(Number), status: 'completed' })
		);
	});

	it('returns a friendly error when board planning has no request or manual backlog', async () => {
		const result = await runConductorBoardPlanningCommand({
			groupId: 'group-1',
			groupName: 'Questionaire',
			selectedTemplate: {
				id: 'session-1',
				name: 'Lead',
				cwd: '/tmp/project',
				type: 'codex',
				state: 'idle',
				tabs: [],
				activeTabId: 'tab-1',
				gitBranches: ['main'],
				inputMode: 'ai',
				createdAt: 1,
				updatedAt: 1,
			} as any,
			operatorNotes: '   ',
			manualTasks: [],
			replacePlannerTasks: vi.fn(),
			upsertRun: vi.fn(),
			updateRun: vi.fn(),
			transitionConductor: vi.fn(),
			cleanupSessions: vi.fn(),
			isProviderLimitMessage: vi.fn().mockReturnValue(false),
		});

		expect(result).toEqual({
			errorMessage: 'Add a request before generating a plan.',
			requestConsumed: false,
			autoApproveRunId: null,
		});
	});
});
