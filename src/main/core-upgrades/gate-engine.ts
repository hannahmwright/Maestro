import type { CompletionDecision, GateEvaluationInput, ReviewFinding } from './types';

function isBlockingFinding(finding: ReviewFinding): boolean {
	return finding.blocking || finding.severity === 'critical' || finding.severity === 'high';
}

function shouldRequireFullSuite(input: GateEvaluationInput): boolean {
	if (input.task.done_gate_profile === 'high_risk') return true;
	if (input.task.done_gate_profile === 'standard' && input.cross_package_change) return true;
	if (input.task.risk_level === 'high') return true;
	return false;
}

export class DoneGateEngine {
	evaluate(input: GateEvaluationInput): CompletionDecision {
		const blockingReasons: string[] = [];
		const nextActions: string[] = [];
		const reviewFindings = input.review_findings || [];
		const blockingFindings = reviewFindings.filter(isBlockingFinding);
		const targetedFailures = input.targeted_checks.filter((check) => !check.pass);

		if (targetedFailures.length > 0) {
			blockingReasons.push('targeted_checks_failed');
			nextActions.push('Fix targeted check failures and rerun targeted validation.');
		}

		const requiresFullSuite = shouldRequireFullSuite(input);
		if (requiresFullSuite) {
			if (!input.full_suite_checks || input.full_suite_checks.length === 0) {
				blockingReasons.push('full_suite_required');
				nextActions.push('Run full build/test suite before marking task complete.');
			} else {
				const fullSuiteFailures = input.full_suite_checks.filter((check) => !check.pass);
				if (fullSuiteFailures.length > 0) {
					blockingReasons.push('full_suite_failed');
					nextActions.push('Resolve full-suite failures and rerun completion gate.');
				}
			}
		}

		if (blockingFindings.length > 0) {
			blockingReasons.push('blocking_review_findings');
			nextActions.push('Address high-severity review findings or explicitly waive them.');
		}

		if (blockingReasons.length === 0) {
			return {
				decision: 'complete',
				requires_full_suite: requiresFullSuite,
				blocking_reasons: [],
				blocking_findings: [],
				next_actions: ['Task passed all mandatory completion gates.'],
			};
		}

		const decision = blockingFindings.length > 0 ? 'blocked' : 'continue';
		return {
			decision,
			requires_full_suite: requiresFullSuite,
			blocking_reasons: blockingReasons,
			blocking_findings: blockingFindings,
			next_actions: nextActions,
		};
	}
}
