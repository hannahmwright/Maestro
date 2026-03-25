import { describe, expect, it } from 'vitest';

import type { ConductorTask } from '../../shared/types';
import { buildConductorOrchestratorReply } from '../../shared/conductorOrchestrator';

function buildTask(overrides: Partial<ConductorTask>): ConductorTask {
	return {
		id: 'task-default',
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

describe('buildConductorOrchestratorReply', () => {
	it('summarizes operator-needed work when asked what needs me', () => {
		const task = buildTask({
			id: 'task-1',
			title: 'Choose emoji placement',
			status: 'needs_input',
		});

		const reply = buildConductorOrchestratorReply({
			groupName: 'Mind-Loom',
			context: { scope: 'board' },
			question: 'What needs me?',
			conductor: null,
			tasksById: new Map([[task.id, task]]),
			childTasksByParentId: new Map(),
			runs: [],
			updates: [],
			team: [],
		});

		expect(reply.title).toBe('Tasks waiting on you');
		expect(reply.bullets).toContain('Choose emoji placement');
		expect(reply.actions).toEqual([
			{ type: 'open_task', label: 'Open first task', taskId: 'task-1' },
		]);
	});

	it('summarizes a task with its latest update', () => {
		const task = buildTask({
			id: 'task-1',
			title: 'Verify brace shape end-to-end',
			status: 'needs_review',
			priority: 'high',
		});

		const reply = buildConductorOrchestratorReply({
			groupName: 'Mind-Loom',
			context: { scope: 'task', taskId: task.id },
			conductor: null,
			tasksById: new Map([[task.id, task]]),
			childTasksByParentId: new Map(),
			runs: [],
			updates: [
				{
					id: 'update-1',
					tone: 'warning',
					badge: 'QA',
					summary: 'QA helper could not produce a clean review update.',
					taskId: task.id,
					taskTitle: task.title,
					createdAt: 5,
					isHistorical: false,
				},
			],
			team: [],
		});

		expect(reply.title).toBe('Task summary');
		expect(reply.body).toContain('sitting in QA');
		expect(reply.bullets).toContain('Latest update: QA helper could not produce a clean review update.');
		expect(reply.actions?.[0]).toEqual({
			type: 'open_task',
			label: 'Open task',
			taskId: 'task-1',
		});
		expect(reply.actions?.[1]).toEqual({
			type: 'prioritize_task',
			label: 'Mark critical',
			taskId: 'task-1',
			priority: 'critical',
		});
	});

	it('offers task controls for ready work', () => {
		const task = buildTask({
			id: 'task-2',
			title: 'Polish team cards',
			status: 'ready',
			priority: 'medium',
		});

		const reply = buildConductorOrchestratorReply({
			groupName: 'Mind-Loom',
			context: { scope: 'task', taskId: task.id },
			conductor: null,
			tasksById: new Map([[task.id, task]]),
			childTasksByParentId: new Map(),
			runs: [],
			updates: [],
			team: [],
		});

		expect(reply.actions).toEqual([
			{ type: 'open_task', label: 'Open task', taskId: 'task-2' },
			{ type: 'prioritize_task', label: 'Raise to high', taskId: 'task-2', priority: 'high' },
			{ type: 'pause_task', label: 'Pause this task', taskId: 'task-2' },
		]);
	});

	it('can rebalance priorities across matched workstreams', () => {
		const emojiTask = buildTask({
			id: 'task-emoji',
			title: 'Add board emoji to data layer',
			status: 'ready',
			priority: 'medium',
		});
		const braceTask = buildTask({
			id: 'task-brace',
			title: 'Verify brace shape end-to-end',
			status: 'needs_review',
			priority: 'high',
		});

		const reply = buildConductorOrchestratorReply({
			groupName: 'Mind-Loom',
			context: { scope: 'board' },
			question: 'Prioritize emoji work over brace work',
			conductor: null,
			tasksById: new Map([
				[emojiTask.id, emojiTask],
				[braceTask.id, braceTask],
			]),
			childTasksByParentId: new Map(),
			runs: [],
			updates: [],
			team: [],
		});

		expect(reply.title).toBe('Priority plan');
		expect(reply.actions).toEqual([
			{
				type: 'rebalance_task_groups',
				label: 'Prioritize emoji work over brace work',
				raiseTaskIds: ['task-emoji'],
				raisePriority: 'high',
				lowerTaskIds: ['task-brace'],
				lowerPriority: 'low',
				summary: 'Raised emoji work and lowered brace work.',
			},
		]);
	});
});
