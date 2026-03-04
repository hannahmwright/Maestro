import { EditPlanner } from './edit-planner';
import { EditApplier } from './edit-applier';
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
	private readonly editApplier = new EditApplier();

	private normalizeCommand(command: string): string {
		return command.trim();
	}

	private isCommandAllowed(input: DebugFixLoopInput, command: string): boolean {
		const normalized = this.normalizeCommand(command);
		return input.task.allowed_commands.some(
			(allowedCommand) => this.normalizeCommand(allowedCommand) === normalized
		);
	}

	private selectBestAllowedFallback(input: DebugFixLoopInput): string | null {
		const preferred = ['test', 'lint', 'build'];
		for (const token of preferred) {
			const command = input.task.allowed_commands.find((candidate) =>
				candidate.toLowerCase().includes(token)
			);
			if (command) return this.normalizeCommand(command);
		}
		const firstAllowed = input.task.allowed_commands[0];
		return firstAllowed ? this.normalizeCommand(firstAllowed) : null;
	}

	private resolveNextCommand(
		input: DebugFixLoopInput,
		currentCommand: string,
		candidates: string[]
	): string | null {
		const normalizedCurrent = this.normalizeCommand(currentCommand);
		for (const candidate of candidates) {
			const normalizedCandidate = this.normalizeCommand(candidate);
			if (!normalizedCandidate || normalizedCandidate === normalizedCurrent) continue;
			if (!this.isCommandAllowed(input, normalizedCandidate)) continue;
			return normalizedCandidate;
		}
		if (this.isCommandAllowed(input, normalizedCurrent)) {
			return normalizedCurrent;
		}
		return this.selectBestAllowedFallback(input);
	}

	private resolveFullSuiteCommand(input: DebugFixLoopInput): string | null {
		const candidates: string[] = [];
		if (input.full_suite_command?.trim()) {
			candidates.push(input.full_suite_command);
		}
		candidates.push(
			'npm test',
			'pnpm test',
			'yarn test',
			'bun test',
			'npm run build',
			'pnpm run build',
			'yarn build',
			'bun run build'
		);
		return this.resolveNextCommand(input, '', candidates);
	}

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
		let effectiveChangedFiles = [...(input.changed_files || [])];

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const executableCommand = this.resolveNextCommand(input, currentCommand, [currentCommand]);
			if (!executableCommand) {
				return this.buildFailureResult(
					attempts,
					'command_not_allowed',
					'No runnable command is allowed by task contract.',
					{
						attempt,
						blocking_reasons: ['allowed_commands_empty_or_mismatched'],
					}
				);
			}
			currentCommand = executableCommand;

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

				if (input.planned_patches && input.planned_patches.length > 0) {
					const applyResult = await this.editApplier.applyPlan({
						task: input.task,
						edit_plan: editPlan,
						patches: input.planned_patches,
					});
					if (!applyResult.applied) {
						return this.buildFailureResult(
							attempts,
							'edit_apply_blocked',
							`Edit apply blocked: ${applyResult.blocked_reasons.join(',') || 'unknown'}`,
							{
								attempt,
								blocking_reasons: applyResult.blocked_reasons,
								syntax_errors: applyResult.syntax_errors,
							}
						);
					}
					if (applyResult.applied_files.length > 0) {
						effectiveChangedFiles = [
							...new Set([...effectiveChangedFiles, ...applyResult.applied_files]),
						];
					}
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

				const suggestedNext = this.resolveNextCommand(
					input,
					currentCommand,
					topHypothesis.suggested_commands
				);
				if (!suggestedNext) {
					return this.buildFailureResult(
						attempts,
						'command_not_allowed',
						'Triage produced commands outside task allowlist.',
						{
							attempt,
							blocking_reasons: ['triage_command_not_allowed'],
						}
					);
				}
				currentCommand = suggestedNext;
				continue;
			}

			const reviewFindings = this.reviewEngine.analyzePatch({
				task: input.task,
				changed_files: effectiveChangedFiles,
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
				cross_package_change: effectiveChangedFiles.some((filePath) =>
					filePath.includes('/packages/')
				),
				high_risk_edit: highRiskEdit,
			});

			// Escalate to full-suite checks only when required by the gate policy.
			if (
				decision.requires_full_suite &&
				decision.blocking_reasons.includes('full_suite_required')
			) {
				const fullSuiteCommand = this.resolveFullSuiteCommand(input);
				if (fullSuiteCommand) {
					const fullSuiteResult = await deps.runCommand(fullSuiteCommand);
					const fullSuiteChecks = [toCheckResult(fullSuiteCommand, fullSuiteResult)];
					decision = this.gateEngine.evaluate({
						task: input.task,
						targeted_checks: targetedChecks,
						full_suite_checks: fullSuiteChecks,
						review_findings: reviewFindings,
						cross_package_change: effectiveChangedFiles.some((filePath) =>
							filePath.includes('/packages/')
						),
						high_risk_edit: highRiskEdit,
					});
				}
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
