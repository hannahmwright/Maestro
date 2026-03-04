import type {
	DebugFixLoopResult,
	TaskContract,
	TaskDiagnosticsLifecycleCounts,
	TaskDiagnosticsSummary,
	TaskLifecycleEvent,
} from './types';

interface BuildTaskDiagnosticsInput {
	task: TaskContract;
	result: DebugFixLoopResult;
	lifecycleEvents: TaskLifecycleEvent[];
	retrievalMode?: 'failure_focused' | 'edit_focused' | 'review_focused';
	contextSelectedFiles?: number;
}

function countLifecycleEvents(events: TaskLifecycleEvent[]): TaskDiagnosticsLifecycleCounts {
	const counts: TaskDiagnosticsLifecycleCounts = {
		triage_started: 0,
		hypothesis_generated: 0,
		edit_plan_applied: 0,
		review_findings: 0,
		gate_result: 0,
	};

	for (const event of events) {
		switch (event.type) {
			case 'triage-started':
				counts.triage_started++;
				break;
			case 'hypothesis-generated':
				counts.hypothesis_generated++;
				break;
			case 'edit-plan-applied':
				counts.edit_plan_applied++;
				break;
			case 'review-findings':
				counts.review_findings++;
				break;
			case 'gate-result':
				counts.gate_result++;
				break;
		}
	}

	return counts;
}

export function buildTaskDiagnostics(input: BuildTaskDiagnosticsInput): TaskDiagnosticsSummary {
	const lifecycleCounts = countLifecycleEvents(input.lifecycleEvents);
	const finalAttempt = input.result.attempts[input.result.attempts.length - 1];

	return {
		task_id: input.task.task_id,
		status: input.result.status,
		attempt_count: input.result.attempts.length,
		final_decision: input.result.decision?.decision,
		failure_code: input.result.failure?.code,
		blocking_reasons: input.result.decision?.blocking_reasons || [],
		full_suite_required: input.result.decision?.requires_full_suite || false,
		lifecycle_counts: lifecycleCounts,
		last_command: finalAttempt?.command,
		last_exit_code: finalAttempt?.result.exit_code,
		retrieval_mode: input.retrievalMode,
		context_selected_files: input.contextSelectedFiles,
		generated_at: Date.now(),
	};
}
