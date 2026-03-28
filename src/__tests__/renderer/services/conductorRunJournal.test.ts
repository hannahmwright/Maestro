import { describe, expect, it, vi } from 'vitest';
import type { ConductorRun } from '../../../shared/types';
import { createConductorRunJournal } from '../../../renderer/services/conductorRunJournal';

function buildRun(overrides: Partial<ConductorRun> = {}): ConductorRun {
	return {
		id: 'run-1',
		groupId: 'group-1',
		kind: 'execution',
		baseBranch: 'main',
		integrationBranch: '',
		status: 'running',
		summary: 'Working',
		taskIds: ['task-1'],
		events: [],
		startedAt: 1,
		...overrides,
	};
}

describe('createConductorRunJournal', () => {
	it('appends events and syncs run updates through the store', () => {
		const upsertRun = vi.fn();
		const updateRun = vi.fn();
		const journal = createConductorRunJournal(buildRun(), {
			upsertRun,
			updateRun,
		});

		const event = journal.appendEvent('task_started', 'Started task', 10);
		const syncedRun = journal.sync({ summary: 'Still working', endedAt: 20 });

		expect(upsertRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1' }));
		expect(event).toEqual(
			expect.objectContaining({
				runId: 'run-1',
				groupId: 'group-1',
				type: 'task_started',
				message: 'Started task',
				createdAt: 10,
			})
		);
		expect(updateRun).toHaveBeenNthCalledWith(1, 'run-1', {
			events: [expect.objectContaining({ type: 'task_started', message: 'Started task' })],
		});
		expect(updateRun).toHaveBeenNthCalledWith(2, 'run-1', {
			summary: 'Still working',
			endedAt: 20,
			events: [expect.objectContaining({ type: 'task_started', message: 'Started task' })],
		});
		expect(syncedRun).toEqual(
			expect.objectContaining({
				summary: 'Still working',
				endedAt: 20,
				events: [expect.objectContaining({ type: 'task_started', message: 'Started task' })],
			})
		);
	});

	it('ignores external event arrays and preserves the journal event stream', () => {
		const journal = createConductorRunJournal(buildRun(), {
			upsertRun: vi.fn(),
			updateRun: vi.fn(),
		});

		journal.appendEvent('execution_started', 'Execution started', 5);
		const run = journal.finalize({
			status: 'completed',
			events: [
				{
					id: 'external-event',
					runId: 'run-1',
					groupId: 'group-1',
					type: 'execution_failed',
					message: 'Should be ignored',
					createdAt: 99,
				},
			],
		});

		expect(run.status).toBe('completed');
		expect(run.events).toEqual([
			expect.objectContaining({
				type: 'execution_started',
				message: 'Execution started',
			}),
		]);
	});
});
