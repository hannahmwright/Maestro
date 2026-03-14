import { describe, expect, it } from 'vitest';
import type { Group, ConductorTask } from '../../../shared/types';
import {
	buildConductorMetrics,
	buildWorkspaceSummaries,
	groupTasksByStatus,
	MOBILE_CONDUCTOR_STATUS_LABELS,
} from '../../../web/mobile/conductorUtils';

const groups: Group[] = [
	{
		id: 'workspace-a',
		name: 'Workspace A',
		emoji: '🛰️',
		projectRoot: '/tmp/a',
		collapsed: false,
		archived: false,
	},
	{
		id: 'workspace-b',
		name: 'Workspace B',
		emoji: '🧪',
		projectRoot: '/tmp/b',
		collapsed: false,
		archived: false,
	},
];

const tasks: ConductorTask[] = [
	{
		id: 'task-1',
		groupId: 'workspace-a',
		title: 'Ship mobile board',
		description: '',
		acceptanceCriteria: [],
		priority: 'critical',
		status: 'running',
		dependsOn: [],
		scopePaths: [],
		source: 'manual',
		createdAt: 10,
		updatedAt: 40,
	},
	{
		id: 'task-2',
		groupId: 'workspace-a',
		title: 'Tighten copy',
		description: '',
		acceptanceCriteria: [],
		priority: 'low',
		status: 'done',
		dependsOn: [],
		scopePaths: [],
		source: 'manual',
		createdAt: 10,
		updatedAt: 20,
	},
	{
		id: 'task-3',
		groupId: 'workspace-b',
		title: 'Review regressions',
		description: '',
		acceptanceCriteria: [],
		priority: 'high',
		status: 'needs_review',
		dependsOn: [],
		scopePaths: [],
		source: 'manual',
		createdAt: 10,
		updatedAt: 30,
	},
];

describe('conductorUtils', () => {
	it('groups tasks by status and sorts higher priority work first', () => {
		const grouped = groupTasksByStatus(tasks);

		expect(grouped.running.map((task) => task.id)).toEqual(['task-1']);
		expect(grouped.needs_review.map((task) => task.id)).toEqual(['task-3']);
		expect(grouped.done.map((task) => task.id)).toEqual(['task-2']);
		expect(MOBILE_CONDUCTOR_STATUS_LABELS.running).toBe('In progress');
	});

	it('builds metrics and workspace summaries for the mobile board', () => {
		const metrics = buildConductorMetrics(tasks);
		const summaries = buildWorkspaceSummaries(groups, tasks);

		expect(metrics).toEqual({
			total: 3,
			open: 2,
			running: 1,
			attention: 1,
			done: 1,
		});
		expect(summaries.map((summary) => [summary.group.id, summary.openCount, summary.doneCount])).toEqual([
			['workspace-a', 1, 1],
			['workspace-b', 1, 0],
		]);
	});
});
