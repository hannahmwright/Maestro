import { describe, expect, it, vi } from 'vitest';
import type { ConductorTask } from '../../../shared/types';
import { createConductorTaskMirror } from '../../../renderer/services/conductorTaskMirror';

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

describe('createConductorTaskMirror', () => {
	it('patches local and store-backed task state together', () => {
		const patchTaskFromSnapshot = vi.fn((task: ConductorTask, updates: Partial<ConductorTask>) => ({
			...task,
			...updates,
			updatedAt: 5,
		}));
		const mirror = createConductorTaskMirror([buildTask()], {
			commitTaskSnapshot: vi.fn((task) => task),
			commitTaskSnapshots: vi.fn((tasks) => tasks),
			patchTaskFromSnapshot,
		});

		const patched = mirror.patch('task-1', { status: 'ready' });

		expect(patchTaskFromSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'task-1', status: 'draft' }),
			{ status: 'ready' },
			undefined
		);
		expect(patched).toEqual(expect.objectContaining({ id: 'task-1', status: 'ready', updatedAt: 5 }));
		expect(mirror.get('task-1')).toEqual(patched);
	});

	it('appends committed tasks into the mirror map', () => {
		const commitTaskSnapshots = vi.fn((tasks: ConductorTask[]) => tasks);
		const mirror = createConductorTaskMirror([buildTask({ id: 'task-1' })], {
			commitTaskSnapshot: vi.fn((task) => task),
			commitTaskSnapshots,
			patchTaskFromSnapshot: vi.fn((task, updates) => ({ ...task, ...updates })),
		});

		mirror.append([buildTask({ id: 'task-2', title: 'Second task', status: 'ready' })]);

		expect(commitTaskSnapshots).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'task-2', title: 'Second task', status: 'ready' }),
		]);
		expect(mirror.values()).toEqual([
			expect.objectContaining({ id: 'task-1' }),
			expect.objectContaining({ id: 'task-2', title: 'Second task', status: 'ready' }),
		]);
	});
});
