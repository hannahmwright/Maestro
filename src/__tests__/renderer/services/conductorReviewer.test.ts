import { describe, expect, it } from 'vitest';
import {
	buildConductorReviewerPrompt,
	parseConductorReviewerResponse,
} from '../../../renderer/services/conductorReviewer';
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
		title: 'Implement review lane',
		description: 'Send finished work through QA.',
		acceptanceCriteria: ['Completed tasks require review before done.'],
		priority: 'high',
		status: 'needs_review',
		dependsOn: [],
		scopePaths: ['src/renderer/components/ConductorPanel.tsx'],
		changedPaths: ['src/renderer/components/ConductorPanel.tsx'],
		source: 'planner',
		createdAt: 1,
		updatedAt: 1,
	};
}

describe('conductorReviewer', () => {
	it('builds a reviewer prompt with acceptance criteria and changed paths', () => {
		const prompt = buildConductorReviewerPrompt('Maestro', createTemplateSession(), createTask());

		expect(prompt).toContain('Implement review lane');
		expect(prompt).toContain('Completed tasks require review before done.');
		expect(prompt).toContain('src/renderer/components/ConductorPanel.tsx');
	});

	it('parses approved reviewer output', () => {
		const parsed = parseConductorReviewerResponse(`
{
	"decision": "approved",
	"summary": "Looks good.",
	"followUpTasks": [],
	"reviewNotes": "Acceptance criteria are satisfied."
}
`);

		expect(parsed.decision).toBe('approved');
		expect(parsed.reviewNotes).toBe('Acceptance criteria are satisfied.');
	});

	it('parses reviewer change requests with follow-up subtasks', () => {
		const parsed = parseConductorReviewerResponse(`
{
	"decision": "changes_requested",
	"summary": "Needs one more pass.",
	"followUpTasks": [
		{
			"title": "Tighten the blocked-state copy",
			"description": "The review lane copy is still vague.",
			"priority": "medium"
		}
	]
}
`);

		expect(parsed.decision).toBe('changes_requested');
		expect(parsed.followUpTasks).toHaveLength(1);
		expect(parsed.followUpTasks[0].title).toBe('Tighten the blocked-state copy');
	});
});
