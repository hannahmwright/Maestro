import { EditPlanner } from './edit-planner';
import { DoneGateEngine } from './gate-engine';
import { ReviewRigorEngine } from './review-engine';
import { FailureTriageEngine } from './triage-engine';
import type {
	CommandCheckResult,
	CompletionDecision,
	DebugFixLoopAttempt,
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

	async run(input: DebugFixLoopInput, deps: DebugFixLoopDependencies): Promise<DebugFixLoopResult> {
		const maxAttempts = Math.max(1, Math.min(input.max_attempts || 3, 3));
		const attempts: DebugFixLoopAttempt[] = [];
		let currentCommand = input.initial_command;
		let previousMetadataHash: string | null = null;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			if (input.proposed_edits && input.proposed_edits.length > 0) {
				const editPlan = this.editPlanner.planEdits({
					task: input.task,
					proposed_edits: input.proposed_edits,
					related_files: input.related_files,
				});
				deps.emitLifecycle?.({ type: 'edit-plan-applied', attempt, edit_plan: editPlan });
				if (!editPlan.valid) {
					return {
						status: 'failed',
						reason: `edit_plan_blocked:${editPlan.blocked_reasons.join(',')}`,
						attempts,
					};
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
					return {
						status: 'failed',
						reason: 'no_hypothesis_generated',
						attempts,
					};
				}

				if (previousMetadataHash === topHypothesis.metadata_hash) {
					return {
						status: 'failed',
						reason: 'non_progressing_hypothesis_loop',
						attempts,
					};
				}
				previousMetadataHash = topHypothesis.metadata_hash;

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
			let decision: CompletionDecision = this.gateEngine.evaluate({
				task: input.task,
				targeted_checks: targetedChecks,
				review_findings: reviewFindings,
				cross_package_change: (input.changed_files || []).some((filePath) =>
					filePath.includes('/packages/')
				),
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
			};
		}

		return {
			status: 'failed',
			reason: 'max_attempts_reached',
			attempts,
		};
	}
}
