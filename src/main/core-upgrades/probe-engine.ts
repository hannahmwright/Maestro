import crypto from 'crypto';
import type { DiagnosticProbeResult, FixHypothesis } from './types';

interface ProbeRunResult {
	exitCode: number;
	stdout?: string;
	stderr?: string;
	durationMs?: number;
}

export interface ProbeExecutionInput {
	hypotheses: FixHypothesis[];
	probeBudget: number;
	defaultTimeoutMs: number;
	baselineSignal?: string;
}

export interface ProbeExecutionDependencies {
	runCommand: (command: string) => Promise<ProbeRunResult>;
	isCommandAllowed: (command: string) => boolean;
}

export interface ProbeExecutionEntry {
	hypothesis_id: string;
	probe_id: string;
	probe_command: string;
	result: DiagnosticProbeResult;
}

export interface ProbeExecutionResult {
	entries: ProbeExecutionEntry[];
	results_by_hypothesis: Record<string, DiagnosticProbeResult[]>;
	average_information_gain: number;
}

function tokenize(value: string): Set<string> {
	return new Set(
		value
			.toLowerCase()
			.replace(/[^a-z0-9_\-/\s]/g, ' ')
			.split(/\s+/)
			.filter((token) => token.length > 2)
	);
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let intersection = 0;
	for (const token of left) {
		if (right.has(token)) intersection++;
	}
	const union = left.size + right.size - intersection;
	if (union === 0) return 0;
	return intersection / union;
}

function computeInformationGain(
	baselineSignal: string,
	resultSignal: string,
	pass: boolean,
	durationMs: number,
	timeoutMs: number
): number {
	const baselineTokens = tokenize(baselineSignal);
	const resultTokens = tokenize(resultSignal);
	const similarity = jaccardSimilarity(baselineTokens, resultTokens);

	let score = pass ? 0.72 : 0.34;
	if (similarity < 0.25) score += 0.15;
	else if (similarity < 0.5) score += 0.08;
	if (durationMs > timeoutMs) score -= 0.15;

	return Math.max(0, Math.min(1, score));
}

export class ProbeEngine {
	async execute(
		input: ProbeExecutionInput,
		deps: ProbeExecutionDependencies
	): Promise<ProbeExecutionResult> {
		const maxProbeBudget = Math.max(0, input.probeBudget);
		if (maxProbeBudget === 0 || input.hypotheses.length === 0) {
			return {
				entries: [],
				results_by_hypothesis: {},
				average_information_gain: 0,
			};
		}

		const entries: ProbeExecutionEntry[] = [];
		const resultsByHypothesis: Record<string, DiagnosticProbeResult[]> = {};
		const commandCache = new Map<string, DiagnosticProbeResult>();
		const baseline = input.baselineSignal || '';
		let executed = 0;

		for (const hypothesis of input.hypotheses) {
			if (!resultsByHypothesis[hypothesis.id]) {
				resultsByHypothesis[hypothesis.id] = [];
			}
			for (const probe of hypothesis.probe_candidates) {
				if (executed >= maxProbeBudget) break;

				const probeCommand = probe.command.trim();
				const timeoutMs = probe.timeout_ms || input.defaultTimeoutMs;
				const probeHash = crypto
					.createHash('sha1')
					.update(`${probeCommand}:${timeoutMs}`)
					.digest('hex')
					.slice(0, 12);

				let probeResult = commandCache.get(probeHash);
				if (!probeResult) {
					if (!deps.isCommandAllowed(probeCommand)) {
						probeResult = {
							probe_id: probe.id,
							exit_code: 126,
							pass: false,
							signal_excerpt: '',
							duration_ms: 0,
							information_gain: 0,
							skipped: true,
							skip_reason: 'command_not_allowed',
						};
					} else {
						const runResult = await deps.runCommand(probeCommand);
						const safeResult = runResult || {
							exitCode: 1,
							stdout: '',
							stderr: 'Probe command returned no result.',
							durationMs: 0,
						};
						const pass = safeResult.exitCode === 0;
						const duration = safeResult.durationMs || 0;
						const signal = `${safeResult.stderr || ''}\n${safeResult.stdout || ''}`.trim();
						probeResult = {
							probe_id: probe.id,
							exit_code: safeResult.exitCode,
							pass,
							signal_excerpt: signal.slice(0, 900),
							duration_ms: duration,
							information_gain: computeInformationGain(baseline, signal, pass, duration, timeoutMs),
							skipped: false,
						};
					}

					commandCache.set(probeHash, probeResult);
					executed++;
				}

				const hypothesisProbeResult: DiagnosticProbeResult = {
					...probeResult,
					probe_id: probe.id,
				};
				resultsByHypothesis[hypothesis.id].push(hypothesisProbeResult);
				entries.push({
					hypothesis_id: hypothesis.id,
					probe_id: probe.id,
					probe_command: probeCommand,
					result: hypothesisProbeResult,
				});
			}
		}

		const nonSkippedResults = entries
			.map((entry) => entry.result)
			.filter((result) => !result.skipped);
		const averageInformationGain =
			nonSkippedResults.length === 0
				? 0
				: nonSkippedResults.reduce((sum, result) => sum + result.information_gain, 0) /
					nonSkippedResults.length;

		return {
			entries,
			results_by_hypothesis: resultsByHypothesis,
			average_information_gain: averageInformationGain,
		};
	}
}
