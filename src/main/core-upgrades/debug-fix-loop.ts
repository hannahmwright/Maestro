import { EditPlanner } from './edit-planner';
import { DoneGateEngine } from './gate-engine';
import { ReviewRigorEngine } from './review-engine';
import { FailureTriageEngine } from './triage-engine';
import type {
	CommandCheckResult,
	CompletionDecision,
	DebugFixLoopAttempt,
	DebugFixLoopFailure,
	DebugFixFailureCode,
	DebugFixLoopInput,
	DebugFixLoopResult,
	TaskLifecycleEvent,
} from './types';

export interface DebugFixLoopDependencies {
	runCommand: (command: string) => Promise<{
		exitCode: number;
		stdout?: string;
		stderr?: string;
		durationMs?: number;
	}>;
	emitLifecycle?: (event: TaskLifecycleEvent) => void;
}

function toCheckResult(
	command: string,
	result: { exitCode: number; stdout?: string; stderr?: string; durationMs?: number }
): CommandCheckResult {
	return {
		command,
		exit_code: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		pass: result.exitCode === 0,
		duration_ms: result.durationMs || 0,
	};
}

export class DebugFixLoopEngine {
	private readonly triageEngine = new FailureTriageEngine();
	private readonly gateEngine = new DoneGateEngine();
	private readonly reviewEngine = new ReviewRigorEngine();
	private readonly editPlanner = new EditPlanner();

	private buildFailureResult(
		attempts: DebugFixLoopAttempt[],
		code: DebugFixFailureCode,
		message: string,
		extras?: Omit<DebugFixLoopFailure, 'code' | 'message'>
	): DebugFixLoopResult {
		return {
			status: 'failed',
			reason: code,
			attempts,
			failure: {
				code,
				message,
				...extras,
			},
		};
	}

	async run(input: DebugFixLoopInput, deps: DebugFixLoopDependencies): Promise<DebugFixLoopResult> {
		const maxAttempts = Math.max(1, Math.min(input.max_attempts || 3, 3));
		const attempts: DebugFixLoopAttempt[] = [];
		let currentCommand = input.initial_command;
		let previousHypothesisSignature: string | null = null;
		let previousTopMetadataHash: string | null = null;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			if (input.proposed_edits && input.proposed_edits.length > 0) {
				const editPlan = this.editPlanner.planEdits({
					task: input.task,
					proposed_edits: input.proposed_edits,
					related_files: input.related_files,
				});
				deps.emitLifecycle?.({ type: 'edit-plan-applied', attempt, edit_plan: editPlan });
				if (!editPlan.valid) {
					return this.buildFailureResult(
						attempts,
						'edit_plan_blocked',
						`Edit plan blocked: ${editPlan.blocked_reasons.join(',') || 'unknown'}`,
						{
							attempt,
							blocking_reasons: editPlan.blocked_reasons,
						}
					);
				}
			}

			const result = await deps.runCommand(currentCommand);
			const check = toCheckResult(currentCommand, result);
			attempts.push({ attempt, command: currentCommand, result: check });

			if (!check.pass) {
				deps.emitLifecycle?.({
					type: 'triage-started',
					attempt,
					signal_excerpt: `${check.stderr || ''}\n${check.stdout || ''}`.slice(0, 900),
				});

				const triage = this.triageEngine.analyzeFailure({
					session_id: input.session_id,
					command: currentCommand,
					cwd: input.cwd,
					exit_code: check.exit_code,
					stdout: check.stdout,
					stderr: check.stderr,
				});
				attempts[attempts.length - 1].triage = triage;
				deps.emitLifecycle?.({ type: 'hypothesis-generated', attempt, triage });

				const topHypothesis = triage.hypotheses[0];
				if (!topHypothesis) {
					return this.buildFailureResult(
						attempts,
						'no_hypothesis_generated',
						'Triage did not produce any fix hypothesis.',
						{ attempt }
					);
				}

				const hypothesisSignature = triage.hypotheses
					.map((hypothesis) => hypothesis.metadata_hash)
					.join('|');
				if (
					previousHypothesisSignature !== null &&
					hypothesisSignature === previousHypothesisSignature
				) {
					return this.buildFailureResult(
						attempts,
						'non_progressing_hypothesis_loop',
						'Hypothesis metadata did not change across retries.',
						{
							attempt,
							hypothesis: {
								previous_signature: previousHypothesisSignature,
								current_signature: hypothesisSignature,
								previous_top_metadata_hash: previousTopMetadataHash || undefined,
								current_top_metadata_hash: topHypothesis.metadata_hash,
							},
						}
					);
				}
				previousHypothesisSignature = hypothesisSignature;
				previousTopMetadataHash = topHypothesis.metadata_hash;

				const suggestedNext = topHypothesis.suggested_commands.find(
					(candidate) => candidate !== currentCommand
				);
				currentCommand = suggestedNext || currentCommand;
				continue;
			}

			const reviewFindings = this.reviewEngine.analyzePatch({
				task: input.task,
				changed_files: input.changed_files || [],
				diff_text: input.diff_text,
			});
			deps.emitLifecycle?.({
				type: 'review-findings',
				attempt,
				findings: reviewFindings,
			});

			const targetedChecks = [check];
			const highRiskEdit =
				input.task.risk_level === 'high' ||
				reviewFindings.some(
					(finding) =>
						finding.regression_risk === 'high' ||
						finding.severity === 'critical' ||
						finding.severity === 'high' ||
						finding.missing_tests
				);
			let decision: CompletionDecision = this.gateEngine.evaluate({
				task: input.task,
				targeted_checks: targetedChecks,
				review_findings: reviewFindings,
				cross_package_change: (input.changed_files || []).some((filePath) =>
					filePath.includes('/packages/')
				),
				high_risk_edit: highRiskEdit,
			});

			// Escalate to full-suite checks only when required by the gate policy.
			if (
				input.full_suite_command &&
				decision.requires_full_suite &&
				decision.blocking_reasons.includes('full_suite_required')
			) {
				const fullSuiteResult = await deps.runCommand(input.full_suite_command);
				const fullSuiteChecks = [toCheckResult(input.full_suite_command, fullSuiteResult)];
				decision = this.gateEngine.evaluate({
					task: input.task,
					targeted_checks: targetedChecks,
					full_suite_checks: fullSuiteChecks,
					review_findings: reviewFindings,
					cross_package_change: (input.changed_files || []).some((filePath) =>
						filePath.includes('/packages/')
					),
					high_risk_edit: highRiskEdit,
				});
			}
			deps.emitLifecycle?.({ type: 'gate-result', attempt, decision });

			if (decision.decision === 'complete') {
				return {
					status: 'complete',
					attempts,
					decision,
					review_findings: reviewFindings,
				};
			}

			return {
				status: 'failed',
				reason: decision.blocking_reasons.join(',') || 'gate_blocked',
				attempts,
				decision,
				review_findings: reviewFindings,
				failure: {
					code: 'gate_blocked',
					message: 'Gate engine blocked completion.',
					attempt,
					blocking_reasons: decision.blocking_reasons,
				},
			};
		}

		return this.buildFailureResult(
			attempts,
			'max_attempts_reached',
			`Reached maximum retry loops (${maxAttempts}) without a passing gate.`,
			{
				attempt: maxAttempts,
				hypothesis: {
					previous_signature: previousHypothesisSignature || undefined,
					previous_top_metadata_hash: previousTopMetadataHash || undefined,
				},
			}
		);
	}
}
