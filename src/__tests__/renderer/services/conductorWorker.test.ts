import { describe, expect, it } from 'vitest';
import {
	buildConductorWorkerPrompt,
	parseConductorWorkerSubmission,
	parseConductorWorkerResponse,
} from '../../../renderer/services/conductorWorker';
import type { ConductorTask, Session } from '../../../renderer/types';

function createTemplateSession(): Session {
	return {
		id: 'session-1',
		groupId: 'group-1',
		name: 'Template Agent',
		toolType: 'codex',
		state: 'idle',
		cwd: '/tmp/project',
		fullPath: '/tmp/project',
		projectRoot: '/tmp/project',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
	};
}

function createTask(): ConductorTask {
	return {
		id: 'task-1',
		groupId: 'group-1',
		title: 'Implement execution lane',
		description: 'Run tasks sequentially after approval.',
		acceptanceCriteria: ['Approved tasks can be executed.'],
		priority: 'high',
		status: 'ready',
		dependsOn: [],
		scopePaths: ['src/renderer/components/ConductorPanel.tsx'],
		source: 'planner',
		createdAt: 1,
		updatedAt: 1,
	};
}

describe('conductorWorker', () => {
	it('builds a worker prompt with task details', () => {
		const prompt = buildConductorWorkerPrompt('Maestro', createTemplateSession(), createTask(), [
			'Approve planning run',
		]);

		expect(prompt).toContain('Implement execution lane');
		expect(prompt).toContain('Approve planning run');
		expect(prompt).toContain('src/renderer/components/ConductorPanel.tsx');
		expect(prompt).toContain('submit_conductor_work');
	});

	it('parses completed worker output with follow-up tasks', () => {
		const parsed = parseConductorWorkerResponse(`
{
	"outcome": "completed",
	"summary": "Execution lane added.",
	"changedPaths": ["src/renderer/components/ConductorPanel.tsx"],
	"followUpTasks": [
		{
			"title": "Add worktree isolation",
			"description": "Move execution off the main checkout.",
			"priority": "critical"
		}
	]
}
`);

		expect(parsed.outcome).toBe('completed');
		expect(parsed.followUpTasks).toHaveLength(1);
		expect(parsed.followUpTasks[0]).toMatchObject({
			title: 'Add worktree isolation',
			priority: 'critical',
		});
	});

	it('parses blocked worker output', () => {
		const parsed = parseConductorWorkerResponse(`
	{
	"outcome": "blocked",
	"summary": "Need npm credentials.",
	"changedPaths": [],
	"followUpTasks": [],
	"blockedReason": "Missing auth token."
}
`);

		expect(parsed.outcome).toBe('blocked');
		expect(parsed.blockedReason).toBe('Missing auth token.');
	});

	it('caps worker follow-up tasks to keep execution from snowballing', () => {
		const parsed = parseConductorWorkerResponse(`
	{
		"outcome": "completed",
		"summary": "Execution lane added.",
		"changedPaths": [],
		"followUpTasks": [
			{ "title": "Follow-up 1", "description": "One", "priority": "medium" },
			{ "title": "Follow-up 2", "description": "Two", "priority": "medium" },
			{ "title": "Follow-up 3", "description": "Three", "priority": "medium" }
		]
	}
	`);

		expect(parsed.followUpTasks).toHaveLength(2);
		expect(parsed.followUpTasks.map((task) => task.title)).toEqual(['Follow-up 1', 'Follow-up 2']);
	});

	it('parses structured worker submissions from native tool calls', () => {
		const parsed = parseConductorWorkerSubmission({
			outcome: 'completed',
			summary: 'Structured worker result.',
			changedPaths: ['src/renderer/services/conductorWorker.ts'],
			followUpTasks: [],
		});

		expect(parsed.outcome).toBe('completed');
		expect(parsed.changedPaths).toEqual(['src/renderer/services/conductorWorker.ts']);
	});
});
