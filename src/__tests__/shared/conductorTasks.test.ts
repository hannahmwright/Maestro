import { describe, expect, it } from 'vitest';
import type { ConductorRun, ConductorTask } from '../../shared/types';
import {
	canConductorTaskAutoApproveCompletionProof,
	getEffectiveConductorTaskAttentionRequest,
	getConductorTaskVisibleAttention,
	hasConductorTaskConcreteEvidence,
	repairLegacyConductorTasks,
	requiresConductorTaskExplicitEvidence,
} from '../../shared/conductorTasks';

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

function buildRun(overrides: Partial<ConductorRun>): ConductorRun {
	return {
		id: 'run-1',
		groupId: 'group-1',
		kind: 'review',
		baseBranch: 'main',
		integrationBranch: '',
		status: 'attention_required',
		taskIds: [],
		events: [],
		startedAt: 1,
		...overrides,
	};
}

describe('repairLegacyConductorTasks', () => {
	it('reclassifies legacy child needs_input tasks as agent revision work', () => {
		const parent = buildTask({
			id: 'parent',
			title: 'Parent task',
			status: 'done',
		});
		const child = buildTask({
			id: 'child',
			parentTaskId: 'parent',
			title: 'Legacy child task',
			status: 'needs_input',
			source: 'planner',
		});

		const repaired = repairLegacyConductorTasks([parent, child], []);

		expect(repaired.find((task) => task.id === 'child')?.status).toBe('needs_revision');
	});

	it('keeps real operator-needed tasks in needs_input when a blocking event exists', () => {
		const child = buildTask({
			id: 'child',
			parentTaskId: 'parent',
			title: 'Real question',
			status: 'needs_input',
			source: 'planner',
		});
		const run = buildRun({
			taskIds: ['child'],
			events: [
				{
					id: 'event-1',
					runId: 'run-1',
					groupId: 'group-1',
					type: 'task_needs_input',
					message: 'Task needs input: Real question. Which API key should we use?',
					createdAt: 2,
				},
			],
		});

		const repaired = repairLegacyConductorTasks([child], [run]);

		expect(repaired[0].status).toBe('needs_input');
	});

	it('reclassifies follow-up child tasks that were stranded in needs_input without attention', () => {
		const child = buildTask({
			id: 'child',
			parentTaskId: 'parent',
			title: 'Reviewer follow-up',
			status: 'needs_input',
			source: 'reviewer_followup',
		});

		const repaired = repairLegacyConductorTasks([child], []);

		expect(repaired[0].status).toBe('needs_revision');
	});

	it('returns orphaned planner needs_input tasks to ready when no ask was ever recorded', () => {
		const task = buildTask({
			id: 'task-1',
			title: 'Orphaned planner task',
			status: 'needs_input',
			source: 'planner',
		});

		const repaired = repairLegacyConductorTasks([task], []);

		expect(repaired[0].status).toBe('ready');
	});

	it('reclassifies review-requested legacy needs_input tasks as needs_revision', () => {
		const child = buildTask({
			id: 'child',
			parentTaskId: 'parent',
			title: 'Review fix',
			status: 'needs_input',
			source: 'planner',
		});
		const run = buildRun({
			taskIds: ['child'],
			events: [
				{
					id: 'event-1',
					runId: 'run-1',
					groupId: 'group-1',
					type: 'task_needs_input',
					message: 'Review requested changes for Review fix. 3 follow-up subtasks added.',
					createdAt: 2,
				},
			],
		});

		const repaired = repairLegacyConductorTasks([child], [run]);

		expect(repaired[0].status).toBe('needs_revision');
	});
});

describe('Conductor evidence helpers', () => {
	it('requires explicit evidence for browser-style tasks', () => {
		const task = buildTask({
			title: 'Open WRAL homepage',
			description: 'Launch a browser session and navigate to https://www.wral.com.',
			acceptanceCriteria: ['The browser loads the WRAL homepage.'],
		});

		expect(requiresConductorTaskExplicitEvidence(task)).toBe(true);
	});

	it('does not require explicit evidence for ordinary code tasks by default', () => {
		const task = buildTask({
			title: 'Refactor reducer',
			description: 'Simplify the reducer state transitions.',
			acceptanceCriteria: ['Tests still pass.'],
		});

		expect(requiresConductorTaskExplicitEvidence(task)).toBe(false);
	});

	it('recognizes concrete evidence from demo, file, or url items', () => {
		const task = buildTask({
			evidence: [
				{
					kind: 'demo',
					label: 'Captured WRAL navigation',
					demoId: 'demo-1',
					captureRunId: 'capture-1',
					url: 'https://www.wral.com',
				},
			],
		});

		expect(hasConductorTaskConcreteEvidence(task)).toBe(true);
	});

	it('allows captured proof to be auto-approved on the happy path', () => {
		const task = buildTask({
			completionProofRequirement: {
				required: true,
				requireVideo: true,
				minScreenshots: 1,
			},
			completionProof: {
				status: 'captured',
				demoId: 'demo-1',
				captureRunId: 'capture-1',
				screenshotCount: 2,
				videoArtifactId: 'video-1',
			},
		});

		expect(canConductorTaskAutoApproveCompletionProof(task)).toBe(true);
	});
});

describe('Conductor live attention resolution', () => {
	it('preserves legacy fallback by default for older blocked tasks', () => {
		const task = buildTask({
			id: 'task-legacy',
			status: 'blocked',
		});
		const run = buildRun({
			taskIds: ['task-legacy'],
			summary: 'Need the staging API key before this can continue.',
		});

		expect(getEffectiveConductorTaskAttentionRequest(task, [run])?.requestedAction).toContain(
			'Need the staging API key'
		);
	});

	it('lets live views opt out of reconstructed legacy attention', () => {
		const task = buildTask({
			id: 'task-legacy',
			status: 'blocked',
		});
		const run = buildRun({
			taskIds: ['task-legacy'],
			summary: 'Need the staging API key before this can continue.',
		});

		expect(
			getEffectiveConductorTaskAttentionRequest(task, [run], {
				allowLegacyFallback: false,
			})
		).toBeNull();
		expect(
			getConductorTaskVisibleAttention(
				task,
				new Map(),
				[run],
				{ allowLegacyFallback: false }
			)
		).toBeNull();
	});
});
