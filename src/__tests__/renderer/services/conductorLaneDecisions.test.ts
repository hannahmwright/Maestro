import { describe, expect, it } from 'vitest';
import type {
	ConductorTask,
	ConductorTaskCompletionProof,
	ConductorTaskEvidenceItem,
} from '../../../shared/types';
import type { ConductorReviewerResult } from '../../../renderer/services/conductorReviewer';
import type { ConductorWorkerResult } from '../../../renderer/services/conductorWorker';
import {
	buildConductorWorkerBlockedDecision,
	buildConductorWorkerCompletedDecision,
	mergeConductorTaskEvidence,
	resolveConductorReviewerDecision,
} from '../../../renderer/services/conductorLaneDecisions';

function buildTask(overrides: Partial<ConductorTask> = {}): ConductorTask {
	return {
		id: 'task-1',
		groupId: 'group-1',
		title: 'Visit Example',
		description: 'Do a thing',
		acceptanceCriteria: [],
		priority: 'medium',
		status: 'running',
		dependsOn: [],
		scopePaths: ['src'],
		source: 'planner',
		attentionRequest: null,
		agentHistory: [],
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe('conductorLaneDecisions', () => {
	it('deduplicates merged evidence entries', () => {
		const item: ConductorTaskEvidenceItem = {
			kind: 'url',
			label: 'Example',
			url: 'https://example.com',
		};

		expect(mergeConductorTaskEvidence([item], [item])).toEqual([item]);
	});

	it('routes operator-facing worker blocks to needs_input', () => {
		const result: ConductorWorkerResult = {
			outcome: 'blocked',
			summary: 'Need approval',
			blockedReason: 'Need user approval before publishing',
			changedPaths: ['a.ts'],
			evidence: [],
			followUpTasks: [],
		};

		const decision = buildConductorWorkerBlockedDecision({
			task: buildTask(),
			result,
			combinedEvidence: [],
			runId: 'run-1',
			workerSessionId: 'worker-1',
			finishedAt: 10,
		});

		expect(decision.taskUpdates.status).toBe('needs_input');
		expect(decision.eventType).toBe('task_needs_input');
		expect(decision.blocksExecution).toBe(true);
	});

	it('routes clarified worker blocks to needs_revision', () => {
		const result: ConductorWorkerResult = {
			outcome: 'blocked',
			summary: 'Need clarification',
			blockedReason: 'Unsure which local helper to use',
			changedPaths: ['a.ts'],
			evidence: [],
			followUpTasks: [],
		};

		const decision = buildConductorWorkerBlockedDecision({
			task: buildTask(),
			result,
			combinedEvidence: [],
			runId: 'run-1',
			clarificationGuidance: 'Use the existing helper in src/utils.ts.',
			clarificationSessionId: 'planner-1',
			finishedAt: 10,
		});

		expect(decision.taskUpdates.status).toBe('needs_revision');
		expect(decision.eventType).toBe('task_needs_revision');
		expect(decision.blocksExecution).toBeUndefined();
	});

	it('blocks worker completion when explicit evidence is missing', () => {
		const result: ConductorWorkerResult = {
			outcome: 'completed',
			summary: 'Done',
			changedPaths: ['a.ts'],
			evidence: [],
			followUpTasks: [],
		};

		const decision = buildConductorWorkerCompletedDecision({
			task: buildTask({
				title: 'Visit website',
				completionProofRequirement: { required: true, requireVideo: false, minScreenshots: 1 },
			}),
			groupId: 'group-1',
			result,
			combinedEvidence: [],
			runId: 'run-1',
			workerSessionId: 'worker-1',
			finishedAt: 10,
		});

		expect(decision.taskUpdates.status).toBe('blocked');
		expect(decision.eventType).toBe('task_blocked');
		expect(decision.blocksExecution).toBe(true);
	});

	it('approves review automatically when proof is already captured', () => {
		const result: ConductorReviewerResult = {
			decision: 'approved',
			summary: 'Looks good',
			followUpTasks: [],
		};
		const proof: ConductorTaskCompletionProof = {
			status: 'captured',
			demoId: 'demo-1',
			captureRunId: 'capture-1',
			screenshotCount: 2,
			requestedAt: 5,
			capturedAt: 6,
		};

		const decision = resolveConductorReviewerDecision({
			task: buildTask({
				status: 'needs_review',
				completionProofRequirement: { required: true, requireVideo: false, minScreenshots: 1 },
				completionProof: proof,
				evidence: [{ kind: 'demo', label: 'Demo', demoId: 'demo-1', captureRunId: 'capture-1' }],
			}),
			groupId: 'group-1',
			result,
			runId: 'run-1',
			reviewerSessionId: 'reviewer-1',
			reviewedAt: 20,
		});

		expect(decision.taskUpdates.status).toBe('done');
		expect(decision.taskUpdates.completionProof).toEqual(
			expect.objectContaining({ status: 'approved', approvedAt: 20 })
		);
		expect(decision.eventType).toBe('review_passed');
	});

	it('creates follow-up tasks when review requests changes', () => {
		const result: ConductorReviewerResult = {
			decision: 'changes_requested',
			summary: 'Split the work',
			reviewNotes: 'Address the remaining issues.',
			followUpTasks: [
				{
					title: 'Fix issue',
					description: 'Need a follow-up',
					priority: 'high',
				},
			],
		};

		const decision = resolveConductorReviewerDecision({
			task: buildTask({ status: 'needs_review' }),
			groupId: 'group-1',
			result,
			runId: 'run-1',
			reviewerSessionId: 'reviewer-1',
			reviewedAt: 20,
		});

		expect(decision.taskUpdates.status).toBe('needs_revision');
		expect(decision.followUpTasks).toEqual([
			expect.objectContaining({
				parentTaskId: 'task-1',
				title: 'Fix issue',
				source: 'reviewer_followup',
				status: 'ready',
			}),
		]);
		expect(decision.eventType).toBe('task_needs_revision');
	});
});
