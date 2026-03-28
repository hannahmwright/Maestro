import { beforeEach, describe, expect, it } from 'vitest';
import type { Conductor, ConductorRun, ConductorTask } from '../../../shared/types';
import { useConductorStore } from '../../../renderer/stores/conductorStore';

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
		taskIds: [],
		events: [],
		startedAt: 1,
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

describe('conductorStore current run pointers', () => {
	beforeEach(() => {
		useConductorStore.setState({
			conductors: [buildConductor()],
			tasks: [],
			runs: [],
			activeConductorView: null,
		} as any);
	});

	it('tracks the current planning run from run state', () => {
		useConductorStore.getState().upsertRun(
			buildRun({
				id: 'plan-1',
				kind: 'planning',
				status: 'planning',
				startedAt: 10,
			})
		);

		expect(useConductorStore.getState().conductors[0].currentPlanningRunId).toBe('plan-1');
	});

	it('clears current planning when the run is no longer active', () => {
		useConductorStore.getState().upsertRun(
			buildRun({
				id: 'plan-1',
				kind: 'planning',
				status: 'awaiting_approval',
				startedAt: 10,
			})
		);

		useConductorStore.getState().updateRun('plan-1', {
			status: 'completed',
			endedAt: 20,
		});

		expect(useConductorStore.getState().conductors[0].currentPlanningRunId).toBeNull();
	});

	it('keeps the most recent active execution run for the workspace', () => {
		useConductorStore.getState().setRuns([
			buildRun({
				id: 'exec-1',
				kind: 'execution',
				status: 'attention_required',
				startedAt: 10,
				endedAt: 11,
			}),
			buildRun({
				id: 'exec-2',
				kind: 'execution',
				status: 'running',
				startedAt: 20,
			}),
		]);

		expect(useConductorStore.getState().conductors[0].currentExecutionRunId).toBe('exec-2');
	});

	it('clears a blocked execution pointer once its task is explicitly updated afterward', () => {
		useConductorStore.setState({
			conductors: [buildConductor()],
			tasks: [buildTask({ id: 'task-1', status: 'ready', updatedAt: 100 })],
			runs: [
				buildRun({
					id: 'exec-1',
					kind: 'execution',
					status: 'blocked',
					taskIds: ['task-1'],
					startedAt: 10,
					endedAt: 20,
				}),
			],
			activeConductorView: null,
		} as any);

		useConductorStore.getState().setRuns(useConductorStore.getState().runs);
		expect(useConductorStore.getState().conductors[0].currentExecutionRunId).toBeNull();
	});

	it('tracks integration attention as the current integration run', () => {
		useConductorStore.getState().upsertRun(
			buildRun({
				id: 'integration-1',
				kind: 'integration',
				status: 'attention_required',
				startedAt: 30,
			})
		);

		expect(useConductorStore.getState().conductors[0].currentIntegrationRunId).toBe(
			'integration-1'
		);
	});

	it('transitions conductor workspace state through the shared machine action', () => {
		useConductorStore.getState().transitionConductor('group-1', { type: 'PLANNING_STARTED' });
		expect(useConductorStore.getState().conductors[0]).toEqual(
			expect.objectContaining({
				groupId: 'group-1',
				status: 'planning',
				isPaused: false,
				holdReason: null,
			})
		);

		useConductorStore
			.getState()
			.transitionConductor('group-1', { type: 'PLANNING_FAILED', pause: true, holdReason: 'Near limit' });
		expect(useConductorStore.getState().conductors[0]).toEqual(
			expect.objectContaining({
				groupId: 'group-1',
				status: 'attention_required',
				isPaused: true,
				holdReason: 'Near limit',
			})
		);
	});

	it('ignores no-op conductor transitions that would only touch updatedAt', () => {
		const original = buildConductor({
			status: 'idle',
			holdReason: null,
			updatedAt: 10,
		});
		useConductorStore.setState({
			conductors: [original],
			tasks: [],
			runs: [],
			activeConductorView: null,
		} as any);

		useConductorStore.getState().transitionConductor('group-1', { type: 'RESET_TO_IDLE' });

		expect(useConductorStore.getState().conductors[0]).toBe(original);
	});

	it('ignores no-op conductor patches that do not change workspace state', () => {
		const original = buildConductor({
			status: 'idle',
			holdReason: null,
			updatedAt: 10,
		});
		useConductorStore.setState({
			conductors: [original],
			tasks: [],
			runs: [],
			activeConductorView: null,
		} as any);

		useConductorStore.getState().setConductor('group-1', {
			status: 'idle',
			holdReason: null,
		});

		expect(useConductorStore.getState().conductors[0]).toBe(original);
	});

	it('upserts task snapshots without duplicating ids', () => {
		useConductorStore.setState((state) => ({
			...state,
			tasks: [buildTask({ id: 'task-1', status: 'draft' })],
		}));

		useConductorStore.getState().upsertTasks([
			buildTask({ id: 'task-1', status: 'running', updatedAt: 5 }),
			buildTask({ id: 'task-2', title: 'Second task', status: 'ready', updatedAt: 6 }),
		]);

		expect(useConductorStore.getState().tasks).toEqual([
			expect.objectContaining({ id: 'task-1', status: 'running', updatedAt: 5 }),
			expect.objectContaining({ id: 'task-2', title: 'Second task', status: 'ready', updatedAt: 6 }),
		]);
	});

	it('patches task snapshots through the extracted store transition API', () => {
		useConductorStore.setState((state) => ({
			...state,
			tasks: [buildTask({ id: 'task-1', status: 'draft', title: 'Original' })],
		}));

		const patched = useConductorStore
			.getState()
			.patchTaskFromSnapshot(buildTask({ id: 'task-1', status: 'draft', title: 'Original' }), {
				status: 'ready',
				title: 'Patched',
			}, 9);

		expect(patched).toEqual(
			expect.objectContaining({
				id: 'task-1',
				status: 'ready',
				title: 'Patched',
				updatedAt: 9,
			})
		);
		expect(useConductorStore.getState().tasks[0]).toEqual(patched);
	});

	it('patchTaskById preserves newer task fields that arrived after an older snapshot', () => {
		useConductorStore.setState((state) => ({
			...state,
			tasks: [
				buildTask({
					id: 'task-1',
					status: 'planning',
					plannerSessionId: 'planner-1',
					plannerSessionName: 'Planner',
				}),
			],
		}));

		const patched = useConductorStore.getState().patchTaskById(
			'task-1',
			{ status: 'needs_input' },
			12
		);

		expect(patched).toEqual(
			expect.objectContaining({
				id: 'task-1',
				status: 'needs_input',
				plannerSessionId: 'planner-1',
				plannerSessionName: 'Planner',
				updatedAt: 12,
			})
		);
	});

	it('recovers stale planning and running tasks through the store action', () => {
		useConductorStore.setState((state) => ({
			...state,
			tasks: [
				buildTask({
					id: 'planning-task',
					status: 'planning',
					plannerSessionId: 'planner-1',
					plannerSessionName: 'Planner',
				}),
				buildTask({
					id: 'running-task',
					status: 'running',
					workerSessionId: 'worker-1',
					workerSessionName: 'Worker',
				}),
			],
		}));

		useConductorStore.getState().recoverStaleTasks(['planning-task', 'running-task'], 12);

		expect(useConductorStore.getState().tasks).toEqual([
			expect.objectContaining({
				id: 'planning-task',
				status: 'ready',
				plannerSessionId: undefined,
				plannerSessionName: undefined,
				updatedAt: 12,
			}),
			expect.objectContaining({
				id: 'running-task',
				status: 'ready',
				workerSessionId: undefined,
				workerSessionName: undefined,
				updatedAt: 12,
			}),
		]);
	});

	it('appends task agent history once per unique role/session/run tuple', () => {
		useConductorStore.setState((state) => ({
			...state,
			tasks: [buildTask({ id: 'task-1', agentHistory: [] })],
		}));

		useConductorStore.getState().appendTaskAgentHistory('task-1', {
			role: 'worker',
			sessionId: 'session-1',
			sessionName: 'Rowan',
			runId: 'run-1',
		});
		useConductorStore.getState().appendTaskAgentHistory('task-1', {
			role: 'worker',
			sessionId: 'session-1',
			sessionName: 'Rowan',
			runId: 'run-1',
		});

		expect(useConductorStore.getState().tasks[0].agentHistory).toHaveLength(1);
		expect(useConductorStore.getState().tasks[0].agentHistory?.[0]).toEqual(
			expect.objectContaining({
				role: 'worker',
				sessionId: 'session-1',
				sessionName: 'Rowan',
				runId: 'run-1',
			})
		);
	});

	it('replaces a scoped set of tasks atomically', () => {
		useConductorStore.setState((state) => ({
			...state,
			tasks: [
				buildTask({ id: 'keep-me', title: 'Keep me' }),
				buildTask({ id: 'replace-me', title: 'Replace me' }),
			],
		}));

		useConductorStore.getState().replaceTasksByIds(['replace-me'], [
			buildTask({ id: 'replace-me', title: 'Replacement anchor', status: 'ready' }),
			buildTask({ id: 'new-child', title: 'New child', status: 'ready', parentTaskId: 'replace-me' }),
		]);

		expect(useConductorStore.getState().tasks).toEqual([
			expect.objectContaining({ id: 'keep-me', title: 'Keep me' }),
			expect.objectContaining({ id: 'replace-me', title: 'Replacement anchor', status: 'ready' }),
			expect.objectContaining({ id: 'new-child', title: 'New child', parentTaskId: 'replace-me' }),
		]);
	});

	it('ignores no-op active conductor view updates for the same workspace target', () => {
		const originalView = { scope: 'workspace' as const, groupId: 'group-1' };
		useConductorStore.setState((state) => ({
			...state,
			activeConductorView: originalView,
		}));

		useConductorStore.getState().setActiveConductorView({
			scope: 'workspace',
			groupId: 'group-1',
		});

		expect(useConductorStore.getState().activeConductorView).toBe(originalView);
	});

	it('preserves an active workspace conductor view while groups are still loading', () => {
		const originalView = { scope: 'workspace' as const, groupId: 'group-1' };
		useConductorStore.setState((state) => ({
			...state,
			activeConductorView: originalView,
		}));

		useConductorStore.getState().syncWithGroups([]);

		expect(useConductorStore.getState().activeConductorView).toBe(originalView);
	});
});
