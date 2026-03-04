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
		probe_started: 0,
		probe_finished: 0,
		context_expanded: 0,
		strategy_switched: 0,
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
			case 'probe-started':
				counts.probe_started++;
				break;
			case 'probe-finished':
				counts.probe_finished++;
				break;
			case 'context-expanded':
				counts.context_expanded++;
				break;
			case 'strategy-switched':
				counts.strategy_switched++;
				break;
		}
	}

	return counts;
}

export function buildTaskDiagnostics(input: BuildTaskDiagnosticsInput): TaskDiagnosticsSummary {
	const lifecycleCounts = countLifecycleEvents(input.lifecycleEvents);
	const finalAttempt = input.result.attempts[input.result.attempts.length - 1];
	const probeResults = input.result.attempts.flatMap((attempt) => attempt.probe_results || []);
	const evidenceLedgerCount = input.result.attempts.reduce(
		(sum, attempt) => sum + (attempt.evidence_ledger?.length || 0),
		0
	);
	const branchCounts = input.result.attempts
		.map((attempt) => attempt.hypothesis_branch_count)
		.filter((count): count is number => typeof count === 'number');
	const averageHypothesisBranches =
		branchCounts.length === 0
			? 0
			: branchCounts.reduce((sum, count) => sum + count, 0) / branchCounts.length;
	const explanationPathCount = input.result.attempts.reduce(
		(sum, attempt) =>
			sum +
			(attempt.graph_explanations?.filter((explanation) =>
				Boolean(explanation.explanation_path?.length)
			).length || 0),
		0
	);
	const nonSkippedProbeResults = probeResults.filter((result) => !result.skipped);
	const averageProbeGain =
		nonSkippedProbeResults.length === 0
			? undefined
			: nonSkippedProbeResults.reduce((sum, result) => sum + result.information_gain, 0) /
				nonSkippedProbeResults.length;
	const graphCoverages = input.result.attempts
		.map((attempt) => attempt.graph_query_coverage)
		.filter((value): value is number => typeof value === 'number');
	const averageGraphCoverage =
		graphCoverages.length === 0
			? undefined
			: graphCoverages.reduce((sum, value) => sum + value, 0) / graphCoverages.length;

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
		probe_count: probeResults.length,
		strategy_switch_count: lifecycleCounts.strategy_switched,
		context_expansion_count: lifecycleCounts.context_expanded,
		average_probe_gain: averageProbeGain,
		graph_query_count: input.result.memory_state?.graph_query_count || 0,
		average_graph_coverage: averageGraphCoverage,
		long_horizon_plan_count: input.result.memory_state?.long_horizon_plan_count || 0,
		memory_stagnation_final: input.result.memory_state?.stagnation_count,
		failure_fingerprint_count: Object.keys(input.result.memory_state?.failure_fingerprints || {})
			.length,
		strict_runtime_path: true,
		evidence_ledger_count: evidenceLedgerCount,
		average_hypothesis_branches: Number(averageHypothesisBranches.toFixed(4)),
		explanation_path_count: explanationPathCount,
		generated_at: Date.now(),
	};
}
