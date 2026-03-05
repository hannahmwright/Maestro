import { DebugFixLoopEngine } from './debug-fix-loop';
import { RepoContextService } from './context-service';
import type { DebugFixLoopResult, TaskContract } from './types';

export interface ReplayCommandResponse {
	exitCode: number;
	stdout?: string;
	stderr?: string;
	durationMs?: number;
}

export interface ReplayCommandPlan {
	match: string;
	match_type?: 'exact' | 'includes' | 'regex';
	responses: ReplayCommandResponse[];
}

export interface ReplayExpectation {
	status?: 'complete' | 'failed';
	reason?: string;
	max_attempts?: number;
	min_strategy_switch_count?: number;
	require_selected_hypothesis?: boolean;
}

export interface ReplayFixtureMetadata {
	category?: string;
	difficulty?: 'easy' | 'medium' | 'hard' | 'extreme';
	tags?: string[];
	source?: 'dogfood' | 'curated' | 'synthetic';
}

export interface ReplayFixture {
	id: string;
	description: string;
	metadata?: ReplayFixtureMetadata;
	task: TaskContract;
	cwd: string;
	initial_command: string;
	full_suite_command?: string;
	changed_files?: string[];
	related_files?: string[];
	diff_text?: string;
	max_attempts?: number;
	command_plan: ReplayCommandPlan[];
	expectation?: ReplayExpectation;
}

export interface ReplayCaseResult {
	fixture_id: string;
	pass: boolean;
	errors: string[];
	executed_commands: string[];
	loop_result: DebugFixLoopResult;
	attempt_count: number;
	first_attempt_complete: boolean;
	non_progressing_failure: boolean;
}

export interface ReplayMetrics {
	first_attempt_solve_rate: number;
	average_attempt_count: number;
	non_progressing_failure_rate: number;
}

export interface ReplaySummary {
	passed: number;
	failed: number;
	results: ReplayCaseResult[];
	metrics: ReplayMetrics;
}

function matchesPlan(command: string, plan: ReplayCommandPlan): boolean {
	switch (plan.match_type || 'exact') {
		case 'exact':
			return command.trim() === plan.match.trim();
		case 'includes':
			return command.includes(plan.match);
		case 'regex':
			return new RegExp(plan.match).test(command);
		default:
			return false;
	}
}

function cloneCommandPlan(plan: ReplayCommandPlan[]): ReplayCommandPlan[] {
	return plan.map((entry) => ({
		...entry,
		responses: [...entry.responses],
	}));
}

interface ReplayCommandPlanState extends ReplayCommandPlan {
	fallback_response: ReplayCommandResponse;
}

const replayContextService = new RepoContextService();

function buildFallbackContextPack(input: {
	seedFiles: string[];
	seedSymbols?: string[];
	maxFiles?: number;
}) {
	const maxFiles = Math.max(1, Math.min(input.maxFiles || 6, 20));
	const selectedFiles = [...new Set(input.seedFiles)].slice(0, maxFiles);
	return {
		selectedFiles,
		impactedSymbols: [...new Set(input.seedSymbols || [])].slice(0, 50),
		bridgeFiles: [],
		bridgeSymbols: [],
		selection_narratives: selectedFiles.map((filePath) => ({
			file_path: filePath,
			reason: 'seed_file',
			path: [filePath],
		})),
	};
}

function buildFallbackGraphScores(input: { seedFiles: string[]; candidateFiles: string[] }) {
	const seedSet = new Set(input.seedFiles);
	const candidates = [...new Set(input.candidateFiles)];
	const scores = candidates.map((candidate) => {
		const reachable = seedSet.has(candidate);
		return {
			file_path: candidate,
			score: reachable ? 1 : 0.3,
			distance: reachable ? 0 : undefined,
			impact_score: 0,
			fanout: 0,
			explanation: reachable
				? 'Fallback replay graph: candidate is in seed set.'
				: 'Fallback replay graph: no local graph path available in fixture workspace.',
		};
	});
	const reachableCount = scores.filter((score) => typeof score.distance === 'number').length;
	return {
		scores,
		coverage: scores.length > 0 ? reachableCount / scores.length : 0,
		explored_nodes: new Set([...input.seedFiles, ...input.candidateFiles]).size,
	};
}

function assertExpectation(
	fixture: ReplayFixture,
	result: DebugFixLoopResult,
	executedCommands: string[]
): string[] {
	const expectation = fixture.expectation;
	if (!expectation) return [];
	const errors: string[] = [];
	if (expectation.status && result.status !== expectation.status) {
		errors.push(`Expected status "${expectation.status}" but got "${result.status}".`);
	}
	if (expectation.reason && result.reason !== expectation.reason) {
		errors.push(
			`Expected reason "${expectation.reason}" but got "${result.reason || 'undefined'}".`
		);
	}
	if (
		typeof expectation.max_attempts === 'number' &&
		result.attempts.length > expectation.max_attempts
	) {
		errors.push(
			`Expected <= ${expectation.max_attempts} attempts but got ${result.attempts.length}.`
		);
	}
	if (
		typeof expectation.min_strategy_switch_count === 'number' &&
		(result.memory_state?.strategy_switch_count || 0) < expectation.min_strategy_switch_count
	) {
		errors.push(
			`Expected strategy switches >= ${expectation.min_strategy_switch_count} but got ${result.memory_state?.strategy_switch_count || 0}.`
		);
	}
	if (expectation.require_selected_hypothesis) {
		const hasSelection = result.attempts.some((attempt) => Boolean(attempt.selected_hypothesis_id));
		if (!hasSelection) {
			errors.push('Expected at least one selected hypothesis in attempt trace.');
		}
	}
	if (executedCommands.length === 0) {
		errors.push('Expected at least one executed command in replay trace.');
	}
	return errors;
}

export async function runReplayCase(fixture: ReplayFixture): Promise<ReplayCaseResult> {
	const engine = new DebugFixLoopEngine();
	const plan: ReplayCommandPlanState[] = cloneCommandPlan(fixture.command_plan).map((entry) => ({
		...entry,
		fallback_response: entry.responses[entry.responses.length - 1] || {
			exitCode: 1,
			stderr: 'Replay command has no configured responses.',
			durationMs: 0,
		},
	}));
	const executedCommands: string[] = [];

	const loopResult = await engine.run(
		{
			session_id: `replay:${fixture.id}`,
			task: fixture.task,
			cwd: fixture.cwd,
			initial_command: fixture.initial_command,
			full_suite_command: fixture.full_suite_command,
			changed_files: fixture.changed_files,
			related_files: fixture.related_files,
			diff_text: fixture.diff_text,
			max_attempts: fixture.max_attempts,
		},
		{
			runCommand: async (command) => {
				executedCommands.push(command);
				const matchedPlan = plan.find((entry) => matchesPlan(command, entry));
				if (!matchedPlan) {
					return {
						exitCode: 1,
						stderr: `No replay response configured for command: ${command}`,
						durationMs: 0,
					};
				}

				const response = matchedPlan.responses.shift() || matchedPlan.fallback_response;
				return response;
			},
			getContextPack: async (request) => {
				try {
					const pack = await replayContextService.getContextPack({
						repoRoot: fixture.cwd,
						mode: request.mode,
						seedFiles: request.seedFiles,
						seedSymbols: request.seedSymbols,
						depth: request.depth,
						reason: request.reason,
						maxFiles: request.maxFiles,
					});
					return {
						selectedFiles: pack.selectedFiles,
						impactedSymbols: pack.impactedSymbols,
						bridgeFiles: pack.bridgeFiles,
						bridgeSymbols: pack.bridgeSymbols,
						selection_narratives: pack.selectionNarratives.map((entry) => ({
							file_path: entry.filePath,
							reason: entry.reason,
							path: entry.path,
						})),
					};
				} catch {
					return buildFallbackContextPack({
						seedFiles: request.seedFiles,
						seedSymbols: request.seedSymbols,
						maxFiles: request.maxFiles,
					});
				}
			},
			getGraphScores: async (request) => {
				try {
					return await replayContextService.scoreCandidates({
						repoRoot: fixture.cwd,
						seedFiles: request.seedFiles,
						candidateFiles: request.candidateFiles,
						seedSymbols: request.seedSymbols,
						maxDepth: request.maxDepth,
					});
				} catch {
					return buildFallbackGraphScores({
						seedFiles: request.seedFiles,
						candidateFiles: request.candidateFiles,
					});
				}
			},
		}
	);

	const errors = assertExpectation(fixture, loopResult, executedCommands);
	const attemptCount = loopResult.attempts.length;
	const firstAttemptComplete = loopResult.status === 'complete' && attemptCount === 1;
	const nonProgressingFailure =
		loopResult.status === 'failed' &&
		loopResult.failure?.code === 'non_progressing_hypothesis_loop';
	return {
		fixture_id: fixture.id,
		pass: errors.length === 0,
		errors,
		executed_commands: executedCommands,
		loop_result: loopResult,
		attempt_count: attemptCount,
		first_attempt_complete: firstAttemptComplete,
		non_progressing_failure: nonProgressingFailure,
	};
}

export async function runReplaySuite(fixtures: ReplayFixture[]): Promise<ReplaySummary> {
	const results: ReplayCaseResult[] = [];
	for (const fixture of fixtures) {
		results.push(await runReplayCase(fixture));
	}
	return {
		passed: results.filter((result) => result.pass).length,
		failed: results.filter((result) => !result.pass).length,
		results,
		metrics: {
			first_attempt_solve_rate:
				results.length === 0
					? 0
					: results.filter((result) => result.first_attempt_complete).length / results.length,
			average_attempt_count:
				results.length === 0
					? 0
					: results.reduce((sum, result) => sum + result.attempt_count, 0) / results.length,
			non_progressing_failure_rate:
				results.length === 0
					? 0
					: results.filter((result) => result.non_progressing_failure).length / results.length,
		},
	};
}
