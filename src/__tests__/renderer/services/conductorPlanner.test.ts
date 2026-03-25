import { describe, expect, it } from 'vitest';
import {
	buildConductorPlannerPrompt,
	parseConductorPlannerSubmission,
	parseConductorPlannerResponse,
} from '../../../renderer/services/conductorPlanner';
import type { Session } from '../../../renderer/types';

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

describe('conductorPlanner', () => {
	it('builds a planner prompt with backlog and operator notes', () => {
		const prompt = buildConductorPlannerPrompt({
			groupName: 'Maestro',
			templateSession: createTemplateSession(),
			manualTasks: [
				{
					title: 'Polish conductor board',
					description: 'Improve planning UX',
					priority: 'high',
					status: 'ready',
				},
			],
			operatorNotes: 'Keep the plan incremental.',
		});

		expect(prompt).toContain('Maestro');
		expect(prompt).toContain('Polish conductor board');
		expect(prompt).toContain('Keep the plan incremental.');
		expect(prompt).toContain('submit_conductor_plan');
	});

	it('parses JSON fenced planner output', () => {
		const parsed = parseConductorPlannerResponse(`
\`\`\`json
{
	"summary": "Plan ready for review.",
	"tasks": [
		{
			"title": "Add planner composer",
			"description": "Create the notes entry UI.",
			"priority": "high",
			"acceptanceCriteria": ["Notes can be entered before generation."],
			"dependsOn": [],
			"scopePaths": ["src/renderer/components/ConductorPanel.tsx"]
		}
	]
}
\`\`\`
`);

		expect(parsed.summary).toBe('Plan ready for review.');
		expect(parsed.tasks).toHaveLength(1);
		expect(parsed.tasks[0]).toMatchObject({
			title: 'Add planner composer',
			priority: 'high',
			scopePaths: ['src/renderer/components/ConductorPanel.tsx'],
		});
	});

	it('flattens subtasks while preserving parent titles', () => {
		const parsed = parseConductorPlannerResponse(`
{
	"summary": "Plan ready for review.",
	"tasks": [
		{
			"title": "Ship kanban workflow",
			"description": "Add the staged workflow foundation.",
			"priority": "high",
			"acceptanceCriteria": ["Workflow exists."],
			"dependsOn": [],
			"scopePaths": ["src/renderer/components/ConductorPanel.tsx"],
			"subtasks": [
				{
					"title": "Add reviewer lane",
					"description": "Introduce a QA stage.",
					"priority": "medium",
					"acceptanceCriteria": ["Reviewer exists."],
					"dependsOn": [],
					"scopePaths": ["src/renderer/services/conductorReviewer.ts"]
				}
			]
		}
	]
}
`);

		expect(parsed.tasks).toHaveLength(2);
		expect(parsed.tasks[1]).toMatchObject({
			title: 'Add reviewer lane',
			parentTitle: 'Ship kanban workflow',
		});
	});

	it('throws when planner returns no usable tasks', () => {
		expect(() =>
			parseConductorPlannerResponse(JSON.stringify({ summary: 'Nothing', tasks: [] }))
		).toThrow('Planner returned no usable tasks.');
	});

	it('caps oversized plans to keep the backlog bounded', () => {
		const tasks = Array.from({ length: 20 }, (_, index) => ({
			title: `Task ${index + 1}`,
			description: 'Planned work',
			priority: 'medium',
			acceptanceCriteria: [],
			dependsOn: [],
			scopePaths: [],
		}));
		const parsed = parseConductorPlannerResponse(
			JSON.stringify({
				summary: 'Very large plan.',
				tasks,
			})
		);

		expect(parsed.tasks).toHaveLength(12);
		expect(parsed.tasks[0].title).toBe('Task 1');
		expect(parsed.tasks[11].title).toBe('Task 12');
	});

	it('parses structured planner submissions from native tool calls', () => {
		const parsed = parseConductorPlannerSubmission({
			summary: 'Structured plan ready.',
			tasks: [
				{
					title: 'Add native result capture',
					description: 'Use tool calls instead of scraped JSON.',
					priority: 'high',
					acceptanceCriteria: ['Planner uses native structured submission.'],
					dependsOn: [],
					scopePaths: ['src/shared/conductorNativeTools.ts'],
					subtasks: [],
				},
			],
		});

		expect(parsed.summary).toBe('Structured plan ready.');
		expect(parsed.tasks[0].title).toBe('Add native result capture');
	});
});
