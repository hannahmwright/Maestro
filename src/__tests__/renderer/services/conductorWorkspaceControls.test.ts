import { describe, expect, it } from 'vitest';
import type { Conductor, ConductorTask } from '../../../shared/types';
import {
	buildConductorWorkspaceSettingsPatch,
	resolveConductorWorkspaceOrchestratorEffect,
} from '../../../renderer/services/conductorWorkspaceControls';

function buildConductor(overrides: Partial<Conductor> = {}): Conductor {
	return {
		groupId: 'group-1',
		status: 'idle',
		resourceProfile: 'balanced',
		currentPlanningRunId: null,
		currentExecutionRunId: null,
		currentReviewRunId: null,
		currentIntegrationRunId: null,
		autoExecuteOnPlanCreation: true,
		isPaused: false,
		holdReason: null,
		keepConductorAgentSessions: false,
		publishPolicy: 'manual_pr',
		deleteWorkerBranchesOnSuccess: false,
		providerRouting: {
			default: { primary: 'workspace-lead', fallback: null },
			ui: { primary: 'claude-code', fallback: 'codex' },
			backend: { primary: 'codex', fallback: 'claude-code' },
			pauseNearLimit: true,
			nearLimitPercent: 88,
		},
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
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

describe('conductorWorkspaceControls', () => {
	it('builds nested provider routing patches safely', () => {
		const patch = buildConductorWorkspaceSettingsPatch(buildConductor(), {
			type: 'set_provider_primary',
			routeKey: 'backend',
			value: 'claude-code',
		});

		expect(patch).toEqual({
			providerRouting: expect.objectContaining({
				backend: expect.objectContaining({ primary: 'claude-code', fallback: 'claude-code' }),
			}),
		});
	});

	it('clamps near-limit percent updates', () => {
		const patch = buildConductorWorkspaceSettingsPatch(buildConductor(), {
			type: 'set_near_limit_percent',
			value: 120,
		});

		expect(patch).toEqual({
			providerRouting: expect.objectContaining({ nearLimitPercent: 99 }),
		});
	});

	it('resolves reprioritization into patchable task snapshots', () => {
		const tasksById = new Map([
			['task-1', buildTask({ id: 'task-1', title: 'Alpha', priority: 'low' })],
			['task-2', buildTask({ id: 'task-2', title: 'Beta', priority: 'low' })],
		]);

		const effect = resolveConductorWorkspaceOrchestratorEffect({
			action: {
				type: 'set_task_group_priority',
				label: 'Raise',
				taskIds: ['task-1', 'task-2'],
				priority: 'high',
				summary: 'Raised the stream.',
			},
			tasksById,
		});

		expect(effect).toEqual(
			expect.objectContaining({
				kind: 'patch_tasks',
				toastTitle: 'Workstream Reprioritized',
			})
		);
		if (effect.kind !== 'patch_tasks') {
			throw new Error('Expected patch_tasks effect');
		}
		expect(effect.tasks.map((task) => task.priority)).toEqual(['high', 'high']);
	});

	it('resolves board pause/resume as explicit controller effects', () => {
		const pause = resolveConductorWorkspaceOrchestratorEffect({
			action: { type: 'pause_board', label: 'Pause board' },
			tasksById: new Map(),
		});
		const resume = resolveConductorWorkspaceOrchestratorEffect({
			action: { type: 'resume_board', label: 'Resume board' },
			tasksById: new Map(),
		});

		expect(pause).toEqual(expect.objectContaining({ kind: 'pause_board' }));
		expect(resume).toEqual(expect.objectContaining({ kind: 'resume_board' }));
	});
});
