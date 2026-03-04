import fs from 'fs';
import path from 'path';
import { EditPlanner } from './edit-planner';
import { EditApplier } from './edit-applier';
import { DoneGateEngine } from './gate-engine';
import { LongHorizonPlanner } from './long-horizon-planner';
import { ProbeEngine } from './probe-engine';
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
	DiagnosticProbeResult,
	FailureFingerprintMemory,
	FailureClassification,
	FixHypothesis,
	FixHypothesisFamily,
	HypothesisEvidenceLedgerEntry,
	HypothesisValidationResult,
	LoopContextPack,
	LoopContextRequest,
	LoopExecutionMemory,
	ModuleAreaMemory,
	LoopGraphQueryRequest,
	LoopGraphQueryResult,
	TaskLifecycleEvent,
} from './types';

export interface DebugFixLoopDependencies {
	runCommand: (command: string) => Promise<{
		exitCode: number;
		stdout?: string;
		stderr?: string;
		durationMs?: number;
	}>;
	getContextPack?: (request: LoopContextRequest) => Promise<LoopContextPack | null>;
	getGraphScores?: (request: LoopGraphQueryRequest) => Promise<LoopGraphQueryResult | null>;
	emitLifecycle?: (event: TaskLifecycleEvent) => void;
}

interface AttemptScoredHypothesis {
	hypothesis: FixHypothesis;
	score: number;
	base_score: number;
	probe_gain: number;
	probe_evidence_delta: number;
	context_coverage: number;
	graph_coverage: number;
	graph_penalty: number;
	memory_adjustment: number;
	planner_boost: number;
	validation_delta: number;
	command_feasible: boolean;
}

interface FixPathCandidate {
	hypothesis_id: string;
	command: string;
	score: number;
	feasible: boolean;
}

interface LoopGraphFileMetadata {
	score: number;
	path_strength?: number;
	symbol_path_distance?: number;
	package_crossings?: number;
	package_blast_radius?: number;
	bridge_file_count?: number;
	bridge_symbol_count?: number;
	bridge_symbol_overlap?: number;
	transitive_importer_fanout?: number;
}

interface LoopScoringWeights {
	probe_gain: number;
	probe_evidence_delta: number;
	context_coverage: number;
	graph_coverage: number;
	command_feasibility: number;
	graph_penalty: number;
	probe_pass_bonus: number;
}

interface AdaptiveLoopConfig {
	maxAttempts: number;
	maxBeamWidth: number;
	maxFixPathBranches: number;
	hardModeEnabled: boolean;
}

interface AmbiguitySignals {
	ambiguous: boolean;
	topScoreGap: number;
	scoreSpread: number;
}

const DEFAULT_LOOP_SCORING_WEIGHTS: LoopScoringWeights = {
	probe_gain: 0.6,
	probe_evidence_delta: 0.5,
	context_coverage: 0.25,
	graph_coverage: 0.35,
	command_feasibility: 1,
	graph_penalty: 1,
	probe_pass_bonus: 1,
};
const LOOP_WEIGHT_PROFILE_RELATIVE_PATH = path.join(
	'.maestro',
	'core-upgrades',
	'loop-weights.json'
);

function readWeightFromEnv(key: string, fallback: number): number {
	const raw = process.env[key];
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return fallback;
	return parsed;
}

function loadLoopWeightProfile(repoRoot: string): Partial<LoopScoringWeights> {
	const explicitProfilePath = process.env.MAESTRO_LOOP_WEIGHT_PROFILE_PATH?.trim();
	const profilePath = explicitProfilePath
		? path.resolve(explicitProfilePath)
		: path.resolve(repoRoot, LOOP_WEIGHT_PROFILE_RELATIVE_PATH);
	try {
		const raw = fs.readFileSync(profilePath, 'utf8');
		const parsed = JSON.parse(raw) as Partial<LoopScoringWeights>;
		if (!parsed || typeof parsed !== 'object') return {};
		return parsed;
	} catch {
		return {};
	}
}

function readWeightFromProfile(
	profile: Partial<LoopScoringWeights>,
	key: keyof LoopScoringWeights,
	fallback: number
): number {
	const value = profile[key];
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return value;
}

function loadLoopScoringWeights(repoRoot: string): LoopScoringWeights {
	const profileWeights = loadLoopWeightProfile(repoRoot);
	return {
		probe_gain: readWeightFromEnv(
			'MAESTRO_LOOP_WEIGHT_PROBE_GAIN',
			readWeightFromProfile(profileWeights, 'probe_gain', DEFAULT_LOOP_SCORING_WEIGHTS.probe_gain)
		),
		probe_evidence_delta: readWeightFromEnv(
			'MAESTRO_LOOP_WEIGHT_PROBE_EVIDENCE',
			readWeightFromProfile(
				profileWeights,
				'probe_evidence_delta',
				DEFAULT_LOOP_SCORING_WEIGHTS.probe_evidence_delta
			)
		),
		context_coverage: readWeightFromEnv(
			'MAESTRO_LOOP_WEIGHT_CONTEXT',
			readWeightFromProfile(
				profileWeights,
				'context_coverage',
				DEFAULT_LOOP_SCORING_WEIGHTS.context_coverage
			)
		),
		graph_coverage: readWeightFromEnv(
			'MAESTRO_LOOP_WEIGHT_GRAPH',
			readWeightFromProfile(
				profileWeights,
				'graph_coverage',
				DEFAULT_LOOP_SCORING_WEIGHTS.graph_coverage
			)
		),
		command_feasibility: readWeightFromEnv(
			'MAESTRO_LOOP_WEIGHT_COMMAND_FEASIBLE',
			readWeightFromProfile(
				profileWeights,
				'command_feasibility',
				DEFAULT_LOOP_SCORING_WEIGHTS.command_feasibility
			)
		),
		graph_penalty: readWeightFromEnv(
			'MAESTRO_LOOP_WEIGHT_GRAPH_PENALTY',
			readWeightFromProfile(
				profileWeights,
				'graph_penalty',
				DEFAULT_LOOP_SCORING_WEIGHTS.graph_penalty
			)
		),
		probe_pass_bonus: readWeightFromEnv(
			'MAESTRO_LOOP_WEIGHT_PROBE_PASS_BONUS',
			readWeightFromProfile(
				profileWeights,
				'probe_pass_bonus',
				DEFAULT_LOOP_SCORING_WEIGHTS.probe_pass_bonus
			)
		),
	};
}

function toCheckResult(
	command: string,
	result?: { exitCode: number; stdout?: string; stderr?: string; durationMs?: number }
): CommandCheckResult {
	const safeResult = result || {
		exitCode: 1,
		stdout: '',
		stderr: 'Command execution returned no result.',
		durationMs: 0,
	};
	return {
		command,
		exit_code: safeResult.exitCode,
		stdout: safeResult.stdout,
		stderr: safeResult.stderr,
		pass: safeResult.exitCode === 0,
		duration_ms: safeResult.durationMs || 0,
	};
}

function average(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function computeCoverage(likelyFiles: string[], contextFiles: Set<string>): number {
	if (likelyFiles.length === 0) return 0;
	const matched = likelyFiles.filter((filePath) => contextFiles.has(filePath)).length;
	return matched / likelyFiles.length;
}

function hasConflictingProbeOutcomes(probeResults: DiagnosticProbeResult[]): boolean {
	const nonSkipped = probeResults.filter((result) => !result.skipped);
	if (nonSkipped.length < 2) return false;
	const sawPass = nonSkipped.some((result) => result.pass);
	const sawFail = nonSkipped.some((result) => !result.pass);
	return sawPass && sawFail;
}

function likelyFilesDiverged(previousFiles: Set<string>, nextFiles: string[]): boolean {
	if (previousFiles.size === 0 || nextFiles.length === 0) return false;
	return nextFiles.every((filePath) => !previousFiles.has(filePath));
}

function normalizedPath(filePath: string): string {
	return filePath.replace(/\\/g, '/');
}

function deriveModuleAreaKey(filePath: string): string {
	const normalized = normalizedPath(filePath);
	const parts = normalized.split('/').filter(Boolean);
	const packagesIdx = parts.indexOf('packages');
	if (packagesIdx >= 0 && parts[packagesIdx + 1]) {
		return `packages/${parts[packagesIdx + 1]}`;
	}
	const srcIdx = parts.lastIndexOf('src');
	if (srcIdx >= 0 && parts[srcIdx + 1]) {
		return `src/${parts[srcIdx + 1]}`;
	}
	if (parts.length >= 2) {
		return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
	}
	return parts[0] || 'unknown';
}

function normalizeMemory(input?: Partial<LoopExecutionMemory>): LoopExecutionMemory {
	return {
		family_attempts: { ...(input?.family_attempts || {}) },
		command_attempts: { ...(input?.command_attempts || {}) },
		selected_hypothesis_history: [...(input?.selected_hypothesis_history || [])].slice(-20),
		stagnation_count: Math.max(0, input?.stagnation_count || 0),
		strategy_switch_count: Math.max(0, input?.strategy_switch_count || 0),
		graph_query_count: Math.max(0, input?.graph_query_count || 0),
		long_horizon_plan_count: Math.max(0, input?.long_horizon_plan_count || 0),
		failure_fingerprints: { ...(input?.failure_fingerprints || {}) },
		module_area_memory: { ...(input?.module_area_memory || {}) },
	};
}

export class DebugFixLoopEngine {
	private readonly triageEngine = new FailureTriageEngine();
	private readonly gateEngine = new DoneGateEngine();
	private readonly reviewEngine = new ReviewRigorEngine();
	private readonly editPlanner = new EditPlanner();
	private readonly editApplier = new EditApplier();
	private readonly longHorizonPlanner = new LongHorizonPlanner();
	private readonly probeEngine = new ProbeEngine();
	private static readonly DERIVED_COMMAND_BLOCKLIST = /(?:&&|\|\||;|\||`|\$\()/;
	private static readonly DEFAULT_MAX_ATTEMPTS = 3;
	private static readonly HARD_MODE_MAX_ATTEMPTS = 5;
	private static readonly DEFAULT_PROBE_BUDGET = 2;
	private static readonly DEFAULT_PROBE_TIMEOUT_MS = 20_000;
	private static readonly DEFAULT_FIX_PATH_CANDIDATES = 3;
	private static readonly DEFAULT_FIX_PATH_BRANCHES = 2;
	private static readonly CONTEXT_LOW_CONFIDENCE_THRESHOLD = 0.65;
	private static readonly AMBIGUITY_SCORE_GAP_THRESHOLD = 0.1;
	private static readonly LOW_GAIN_THRESHOLD = 0.4;
	private static readonly MAX_REPEAT_COMMAND_ATTEMPTS = 1;

	private normalizeCommand(command: string): string {
		return command.trim();
	}

	private failureFingerprintKey(input: {
		classification: FailureClassification;
		probableFiles: string[];
		probableSymbols: string[];
	}): string {
		const keyParts = [
			input.classification,
			...input.probableFiles.map((file) => normalizedPath(file)).slice(0, 3),
			...input.probableSymbols.slice(0, 3),
		];
		return keyParts.join('|') || input.classification;
	}

	private getOrInitFingerprint(memory: LoopExecutionMemory, key: string): FailureFingerprintMemory {
		const existing = memory.failure_fingerprints[key];
		if (existing) return existing;
		const created: FailureFingerprintMemory = {
			key,
			seen_count: 0,
			solved_count: 0,
			dead_end_count: 0,
			family_penalties: {},
			command_penalties: {},
			probe_purpose_memory: {},
			updated_at: Date.now(),
		};
		memory.failure_fingerprints[key] = created;
		return created;
	}

	private recordFingerprintSeen(
		memory: LoopExecutionMemory,
		key: string
	): FailureFingerprintMemory {
		const fingerprint = this.getOrInitFingerprint(memory, key);
		fingerprint.seen_count += 1;
		fingerprint.updated_at = Date.now();
		return fingerprint;
	}

	private recordDeadEndFingerprint(
		memory: LoopExecutionMemory,
		key: string,
		family: FixHypothesisFamily,
		command: string
	): void {
		const fingerprint = this.getOrInitFingerprint(memory, key);
		fingerprint.dead_end_count += 1;
		fingerprint.family_penalties[family] = (fingerprint.family_penalties[family] || 0) + 1;
		fingerprint.command_penalties[command] = (fingerprint.command_penalties[command] || 0) + 1;
		fingerprint.updated_at = Date.now();
	}

	private recordSolvedFingerprint(
		memory: LoopExecutionMemory,
		key: string,
		family: FixHypothesisFamily,
		command: string
	): void {
		const fingerprint = this.getOrInitFingerprint(memory, key);
		fingerprint.solved_count += 1;
		fingerprint.solved_family = family;
		fingerprint.solved_command = command;
		fingerprint.family_penalties[family] = Math.max(
			0,
			(fingerprint.family_penalties[family] || 0) - 1
		);
		fingerprint.command_penalties[command] = Math.max(
			0,
			(fingerprint.command_penalties[command] || 0) - 1
		);
		fingerprint.updated_at = Date.now();
	}

	private recordProbeOutcomeFingerprint(
		memory: LoopExecutionMemory,
		key: string,
		hypothesis: FixHypothesis,
		probeResults: DiagnosticProbeResult[]
	): void {
		if (probeResults.length === 0) return;
		const fingerprint = this.getOrInitFingerprint(memory, key);
		const purposeByProbeId = new Map(
			hypothesis.probe_candidates.map((probe) => [probe.id, probe.purpose] as const)
		);
		for (const result of probeResults) {
			if (result.skipped) continue;
			const purpose = purposeByProbeId.get(result.probe_id);
			if (!purpose) continue;
			const current = fingerprint.probe_purpose_memory[purpose] || {
				runs: 0,
				passes: 0,
				average_gain: 0,
			};
			const nextRuns = current.runs + 1;
			const nextPasses = current.passes + (result.pass ? 1 : 0);
			const nextAverageGain =
				(current.average_gain * current.runs + result.information_gain) / nextRuns;
			fingerprint.probe_purpose_memory[purpose] = {
				runs: nextRuns,
				passes: nextPasses,
				average_gain: Number(nextAverageGain.toFixed(4)),
			};
		}
		fingerprint.updated_at = Date.now();
	}

	private probeMemoryAdjustmentForHypothesis(
		hypothesis: FixHypothesis,
		fingerprint?: FailureFingerprintMemory
	): number {
		if (!fingerprint) return 0;
		const tracked = hypothesis.probe_candidates
			.map((probe) => fingerprint.probe_purpose_memory[probe.purpose])
			.filter((value): value is { runs: number; passes: number; average_gain: number } =>
				Boolean(value && value.runs > 0)
			);
		if (tracked.length === 0) return 0;
		const passRate =
			tracked.reduce((sum, value) => sum + value.passes / value.runs, 0) / tracked.length;
		const averageGain =
			tracked.reduce((sum, value) => sum + value.average_gain, 0) / tracked.length;
		return passRate * 0.05 + (averageGain - 0.5) * 0.08;
	}

	private sortProbeCandidatesByMemory(
		hypothesis: FixHypothesis,
		fingerprint?: FailureFingerprintMemory
	): FixHypothesis {
		if (!fingerprint || hypothesis.probe_candidates.length <= 1) return hypothesis;
		const scored = hypothesis.probe_candidates.map((probe) => {
			const memory = fingerprint.probe_purpose_memory[probe.purpose];
			const passRate = memory && memory.runs > 0 ? memory.passes / memory.runs : 0;
			const gain = memory?.average_gain || 0;
			const kindBias = probe.kind === 'disconfirm' ? 0.01 : 0.015;
			return {
				probe,
				score: passRate * 0.4 + gain * 0.5 + kindBias,
			};
		});
		const ordered = scored
			.sort((left, right) => right.score - left.score)
			.map((entry) => entry.probe);
		return {
			...hypothesis,
			probe_candidates: ordered,
		};
	}

	private isDerivedAllowed(baseCommand: string, candidateCommand: string): boolean {
		const base = this.normalizeCommand(baseCommand);
		const candidate = this.normalizeCommand(candidateCommand);
		if (candidate === base) return true;
		if (!candidate.startsWith(`${base} `)) return false;

		const suffix = candidate.slice(base.length).trim();
		if (!suffix) return true;
		return !DebugFixLoopEngine.DERIVED_COMMAND_BLOCKLIST.test(suffix);
	}

	private isExplicitlyAllowed(input: DebugFixLoopInput, command: string): boolean {
		const normalized = this.normalizeCommand(command);
		return input.task.allowed_commands.some(
			(allowedCommand) => this.normalizeCommand(allowedCommand) === normalized
		);
	}

	private isCommandAllowed(input: DebugFixLoopInput, command: string): boolean {
		const normalized = this.normalizeCommand(command);
		return input.task.allowed_commands.some((allowedCommand) =>
			this.isDerivedAllowed(allowedCommand, normalized)
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
		if (
			normalizedCurrent &&
			DebugFixLoopEngine.DERIVED_COMMAND_BLOCKLIST.test(normalizedCurrent) &&
			!this.isExplicitlyAllowed(input, normalizedCurrent)
		) {
			return null;
		}

		const firstCandidate = this.normalizeCommand(candidates[0] || '');
		if (
			firstCandidate &&
			firstCandidate === normalizedCurrent &&
			this.isCommandAllowed(input, normalizedCurrent)
		) {
			return normalizedCurrent;
		}

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

	private preferredCommandsForClassification(
		input: DebugFixLoopInput,
		classification: FailureClassification
	): string[] {
		const includeToken = (token: string) =>
			input.task.allowed_commands.filter((command) => command.toLowerCase().includes(token));

		switch (classification) {
			case 'lint_error':
				return includeToken('lint');
			case 'test_failure':
				return includeToken('test');
			case 'type_error':
			case 'module_not_found':
			case 'syntax_error':
			case 'runtime_error':
				return [...includeToken('test'), ...includeToken('build')];
			case 'permission_error':
			case 'command_not_found':
			case 'unknown':
				return [...includeToken('test'), ...includeToken('build'), ...includeToken('lint')];
		}
	}

	private contextReasonForAttempt(
		confidence: number,
		classification: FailureClassification,
		forceFamilySwitch: boolean
	): 'initial' | 'low_confidence' | 'strategy_switch' {
		if (forceFamilySwitch) return 'strategy_switch';
		if (
			confidence < DebugFixLoopEngine.CONTEXT_LOW_CONFIDENCE_THRESHOLD ||
			classification === 'unknown' ||
			classification === 'runtime_error'
		) {
			return 'low_confidence';
		}
		return 'initial';
	}

	private shouldExpandContext(input: {
		confidence: number;
		classification: FailureClassification;
		classificationChanged: boolean;
		likelyFilesDiverged: boolean;
		probeConflict: boolean;
		contextInitialized: boolean;
		forceFamilySwitch: boolean;
	}): {
		shouldExpand: boolean;
		depth: 1 | 2;
		reason: 'initial' | 'low_confidence' | 'strategy_switch';
	} {
		if (!input.contextInitialized) {
			return { shouldExpand: true, depth: 1, reason: 'initial' };
		}

		const lowConfidence =
			input.confidence < DebugFixLoopEngine.CONTEXT_LOW_CONFIDENCE_THRESHOLD ||
			input.classification === 'unknown' ||
			input.classification === 'runtime_error';
		if (
			lowConfidence ||
			input.classificationChanged ||
			input.likelyFilesDiverged ||
			input.probeConflict ||
			input.forceFamilySwitch
		) {
			return {
				shouldExpand: true,
				depth: 2,
				reason: this.contextReasonForAttempt(
					input.confidence,
					input.classification,
					input.forceFamilySwitch
				),
			};
		}

		return { shouldExpand: false, depth: 1, reason: 'initial' };
	}

	private computeAdaptiveLoopConfig(
		input: DebugFixLoopInput,
		memory: LoopExecutionMemory
	): AdaptiveLoopConfig {
		if (typeof input.max_attempts === 'number') {
			const constrained = Math.max(
				1,
				Math.min(input.max_attempts, DebugFixLoopEngine.HARD_MODE_MAX_ATTEMPTS)
			);
			return {
				maxAttempts: constrained,
				maxBeamWidth: constrained >= 4 ? 3 : 2,
				maxFixPathBranches: constrained >= 4 ? 3 : DebugFixLoopEngine.DEFAULT_FIX_PATH_BRANCHES,
				hardModeEnabled: constrained > DebugFixLoopEngine.DEFAULT_MAX_ATTEMPTS,
			};
		}

		const complexitySignals = [
			input.task.risk_level === 'high',
			input.task.done_gate_profile === 'high_risk',
			(input.changed_files || []).length >= 4,
			(input.related_files || []).length >= 8,
			memory.stagnation_count >= 2,
			Object.keys(memory.failure_fingerprints || {}).length >= 3,
		].filter(Boolean).length;
		const hardModeEnabled = complexitySignals >= 2;

		return {
			maxAttempts: hardModeEnabled ? 4 : DebugFixLoopEngine.DEFAULT_MAX_ATTEMPTS,
			maxBeamWidth: hardModeEnabled ? 3 : 2,
			maxFixPathBranches: hardModeEnabled ? 3 : DebugFixLoopEngine.DEFAULT_FIX_PATH_BRANCHES,
			hardModeEnabled,
		};
	}

	private computeBeamWidth(input: {
		triageBeamWidth: number;
		maxBeamWidth: number;
		confidence: number;
		classification: FailureClassification;
		stagnationCount: number;
		lowGainRounds: number;
		ambiguous: boolean;
	}): number {
		let width = Math.max(1, input.triageBeamWidth || 2);
		const needsExploration =
			input.confidence < DebugFixLoopEngine.CONTEXT_LOW_CONFIDENCE_THRESHOLD ||
			input.classification === 'unknown' ||
			input.classification === 'runtime_error' ||
			input.stagnationCount >= 1 ||
			input.lowGainRounds >= 1 ||
			input.ambiguous;
		if (needsExploration) {
			width += 1;
		}
		return Math.max(1, Math.min(width, input.maxBeamWidth));
	}

	private computeProbePolicy(input: {
		confidence: number;
		classification: FailureClassification;
		lowGainRounds: number;
		stagnationCount: number;
		candidateCount: number;
		hardModeEnabled: boolean;
		ambiguous: boolean;
	}): { budget: number; timeoutMs: number } {
		let budget = DebugFixLoopEngine.DEFAULT_PROBE_BUDGET;
		let timeoutMs = DebugFixLoopEngine.DEFAULT_PROBE_TIMEOUT_MS;
		if (
			input.confidence < DebugFixLoopEngine.CONTEXT_LOW_CONFIDENCE_THRESHOLD ||
			input.classification === 'unknown' ||
			input.classification === 'runtime_error'
		) {
			budget += 1;
			timeoutMs += 4_000;
		}
		if (input.hardModeEnabled) {
			budget += 1;
			timeoutMs += 2_000;
		}
		if (input.ambiguous) {
			budget += 1;
			timeoutMs += 2_000;
		}
		if (input.lowGainRounds >= 1 || input.stagnationCount >= 1) {
			budget += 1;
		}
		if (input.candidateCount <= 1) {
			budget = Math.min(budget, 2);
		}
		budget = Math.max(1, Math.min(budget, 4));
		timeoutMs = Math.max(10_000, Math.min(timeoutMs, 30_000));
		return { budget, timeoutMs };
	}

	private computeAmbiguitySignals(
		ranking: Array<{ hypothesis_id: string; score: number }>,
		confidence: number
	): AmbiguitySignals {
		if (ranking.length <= 1) {
			return {
				ambiguous: confidence < DebugFixLoopEngine.CONTEXT_LOW_CONFIDENCE_THRESHOLD,
				topScoreGap: 1,
				scoreSpread: 0,
			};
		}
		const [first, second] = ranking;
		const topScoreGap = Math.max(0, first.score - second.score);
		const scoreSpread = Math.max(0, first.score - ranking[ranking.length - 1].score);
		const ambiguous =
			topScoreGap < DebugFixLoopEngine.AMBIGUITY_SCORE_GAP_THRESHOLD ||
			confidence < DebugFixLoopEngine.CONTEXT_LOW_CONFIDENCE_THRESHOLD;
		return { ambiguous, topScoreGap, scoreSpread };
	}

	private scoreValidationAlignment(hypothesis: FixHypothesis, signal: string): number {
		const normalizedSignal = signal.toLowerCase();
		switch (hypothesis.family) {
			case 'dependency':
				return /cannot find module|module not found|err_module_not_found/.test(normalizedSignal)
					? 0.05
					: 0;
			case 'typing':
				return /ts\d+|cannot find name|not assignable/.test(normalizedSignal) ? 0.05 : 0;
			case 'test_logic':
				return /fail|assertionerror|expected:|received:/.test(normalizedSignal) ? 0.05 : 0;
			case 'runtime':
				return /referenceerror|typeerror:|rangeerror|unhandled/.test(normalizedSignal) ? 0.05 : 0;
			case 'lint':
				return /eslint|lint|prettier/.test(normalizedSignal) ? 0.05 : 0;
			case 'environment':
				return /command not found|permission denied|eacces|not recognized/.test(normalizedSignal)
					? 0.05
					: 0;
		}
	}

	private async runDualTrackValidation(
		input: DebugFixLoopInput,
		deps: DebugFixLoopDependencies,
		currentCommand: string,
		hypotheses: AttemptScoredHypothesis[],
		memory: LoopExecutionMemory
	): Promise<{ results: HypothesisValidationResult[]; scoreDeltas: Map<string, number> }> {
		const feasible = hypotheses
			.filter((item) => item.command_feasible)
			.slice(0, DebugFixLoopEngine.DEFAULT_FIX_PATH_CANDIDATES);
		if (feasible.length <= 1) {
			return {
				results: [],
				scoreDeltas: new Map(),
			};
		}

		const hypothesisCommands = feasible
			.map((item) => {
				const command = this.resolveNextCommand(
					input,
					currentCommand,
					item.hypothesis.suggested_commands
				);
				if (!command) return null;
				return { hypothesis: item.hypothesis, command };
			})
			.filter((value): value is { hypothesis: FixHypothesis; command: string } => Boolean(value));
		if (hypothesisCommands.length <= 1) {
			return {
				results: [],
				scoreDeltas: new Map(),
			};
		}

		const uniqueCommands = [...new Set(hypothesisCommands.map((item) => item.command))];
		const commandResults = new Map<
			string,
			{ exitCode: number; stdout?: string; stderr?: string; durationMs?: number }
		>();
		await Promise.all(
			uniqueCommands.map(async (command) => {
				const result = await deps.runCommand(command);
				memory.command_attempts[command] = (memory.command_attempts[command] || 0) + 1;
				commandResults.set(command, result || { exitCode: 1, stderr: 'No result', durationMs: 0 });
			})
		);

		const scoreDeltas = new Map<string, number>();
		const results: HypothesisValidationResult[] = [];
		for (const entry of hypothesisCommands) {
			const result = commandResults.get(entry.command) || {
				exitCode: 1,
				stdout: '',
				stderr: 'No validation result',
				durationMs: 0,
			};
			const pass = result.exitCode === 0;
			const signal = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
			const alignment = this.scoreValidationAlignment(entry.hypothesis, signal);
			const delta = (pass ? 0.12 : 0.02) + alignment;
			scoreDeltas.set(entry.hypothesis.id, delta);
			results.push({
				hypothesis_id: entry.hypothesis.id,
				command: entry.command,
				exit_code: result.exitCode,
				pass,
				duration_ms: result.durationMs || 0,
				signal_excerpt: signal.slice(0, 300),
			});
		}

		return { results, scoreDeltas };
	}

	private probeEvidenceDeltaForHypothesis(
		hypothesis: FixHypothesis,
		probeResults: DiagnosticProbeResult[]
	): number {
		if (probeResults.length === 0) return 0;
		const probeKindById = new Map(
			hypothesis.probe_candidates.map((probe) => [probe.id, probe.kind || 'confirm'] as const)
		);
		let delta = 0;
		for (const result of probeResults) {
			if (result.skipped) continue;
			const kind = probeKindById.get(result.probe_id) || 'confirm';
			const signedPass = result.pass ? 1 : -1;
			if (kind === 'disconfirm') {
				delta -= signedPass * 0.1;
			} else {
				delta += signedPass * 0.1;
			}
			delta += (result.information_gain - 0.5) * 0.2;
		}
		return delta;
	}

	private commandRepeatPenalty(
		command: string,
		memory: LoopExecutionMemory,
		allowRepeat: boolean
	): number {
		const attempts = memory.command_attempts[command] || 0;
		if (attempts === 0) return 0;
		if (!allowRepeat && attempts >= DebugFixLoopEngine.MAX_REPEAT_COMMAND_ATTEMPTS) {
			return -1.5;
		}
		return -Math.min(0.35, attempts * 0.08);
	}

	private buildFixPathCandidates(input: {
		taskInput: DebugFixLoopInput;
		triage: {
			classification: FailureClassification;
		};
		selectedHypothesis: FixHypothesis;
		scoredHypotheses: AttemptScoredHypothesis[];
		validationResults: HypothesisValidationResult[];
		currentCommand: string;
		memory: LoopExecutionMemory;
		allowRepeat: boolean;
		fingerprint?: FailureFingerprintMemory;
	}): FixPathCandidate[] {
		const seen = new Set<string>();
		const candidates: FixPathCandidate[] = [];
		const precheckByCommand = new Map<
			string,
			{ pass: boolean; durationMs: number; hypothesisId: string }
		>();
		for (const result of input.validationResults) {
			const existing = precheckByCommand.get(result.command);
			if (!existing || (result.pass && !existing.pass)) {
				precheckByCommand.set(result.command, {
					pass: result.pass,
					durationMs: result.duration_ms,
					hypothesisId: result.hypothesis_id,
				});
			}
		}
		const addCandidate = (
			hypothesis: FixHypothesis,
			baseScore: number,
			command: string | null | undefined
		) => {
			if (!command) return;
			const normalized = this.normalizeCommand(command);
			if (!normalized || seen.has(normalized)) return;
			seen.add(normalized);
			const repeatBlocked =
				!input.allowRepeat &&
				(input.memory.command_attempts[normalized] || 0) >=
					DebugFixLoopEngine.MAX_REPEAT_COMMAND_ATTEMPTS;
			const feasible = this.isCommandAllowed(input.taskInput, normalized) && !repeatBlocked;
			const repeatPenalty = this.commandRepeatPenalty(normalized, input.memory, input.allowRepeat);
			const fingerprintPenalty = input.fingerprint?.command_penalties?.[normalized] || 0;
			const precheck = precheckByCommand.get(normalized);
			const precheckScore = precheck ? (precheck.pass ? 0.18 : -0.08) : 0;
			const durationPenalty = precheck ? Math.min(0.06, precheck.durationMs / 5000) : 0;
			const finalScore =
				baseScore +
				(feasible ? 0.12 : -1) +
				repeatPenalty +
				precheckScore -
				durationPenalty -
				fingerprintPenalty * 0.1;
			candidates.push({
				hypothesis_id: hypothesis.id,
				command: normalized,
				score: finalScore,
				feasible,
			});
		};

		for (const item of input.scoredHypotheses.slice(
			0,
			DebugFixLoopEngine.DEFAULT_FIX_PATH_CANDIDATES
		)) {
			const hypothesis = item.hypothesis;
			for (const command of hypothesis.suggested_commands.slice(0, 3)) {
				addCandidate(hypothesis, item.score, command);
				if (candidates.length >= DebugFixLoopEngine.DEFAULT_FIX_PATH_CANDIDATES) break;
			}
			if (candidates.length >= DebugFixLoopEngine.DEFAULT_FIX_PATH_CANDIDATES) break;
		}

		for (const command of this.preferredCommandsForClassification(
			input.taskInput,
			input.triage.classification
		)) {
			addCandidate(input.selectedHypothesis, 0.2, command);
			if (candidates.length >= DebugFixLoopEngine.DEFAULT_FIX_PATH_CANDIDATES) break;
		}

		if (candidates.length === 0) {
			addCandidate(input.selectedHypothesis, 0.1, input.currentCommand);
		}
		return candidates.sort((left, right) => right.score - left.score);
	}

	private async precheckFixPathCandidates(input: {
		deps: DebugFixLoopDependencies;
		candidates: FixPathCandidate[];
		existingResults: HypothesisValidationResult[];
		memory: LoopExecutionMemory;
	}): Promise<HypothesisValidationResult[]> {
		const existingCommands = new Set(input.existingResults.map((result) => result.command));
		const extraResults: HypothesisValidationResult[] = [];
		let checked = 0;
		for (const candidate of input.candidates) {
			if (checked >= 2) break;
			if (!candidate.feasible) continue;
			if (existingCommands.has(candidate.command)) continue;
			const result = (await input.deps.runCommand(candidate.command)) || {
				exitCode: 1,
				stdout: '',
				stderr: 'No precheck result',
				durationMs: 0,
			};
			input.memory.command_attempts[candidate.command] =
				(input.memory.command_attempts[candidate.command] || 0) + 1;
			const pass = result.exitCode === 0;
			const precheckResult: HypothesisValidationResult = {
				hypothesis_id: candidate.hypothesis_id,
				command: candidate.command,
				exit_code: result.exitCode,
				pass,
				duration_ms: result.durationMs || 0,
				signal_excerpt: `${result.stderr || ''}\n${result.stdout || ''}`.trim().slice(0, 300),
			};
			extraResults.push(precheckResult);
			existingCommands.add(candidate.command);
			candidate.score += pass ? 0.16 : -0.09;
			checked += 1;
		}
		return extraResults;
	}

	private graphCoverageForHypothesis(
		hypothesis: FixHypothesis,
		graphScores: Map<string, LoopGraphFileMetadata>
	): number {
		if (hypothesis.likely_files.length === 0 || graphScores.size === 0) return 0;
		const metadata = hypothesis.likely_files
			.map((filePath) => graphScores.get(normalizedPath(filePath)))
			.filter((value): value is LoopGraphFileMetadata => Boolean(value));
		if (metadata.length === 0) return 0;
		const scoreCoverage = average(metadata.map((entry) => entry.score));
		const transitiveImporterBonus = average(
			metadata.map((entry) => Math.min(1, (entry.transitive_importer_fanout || 0) / 12))
		);
		const bridgeOverlapBonus = average(metadata.map((entry) => entry.bridge_symbol_overlap || 0));
		return scoreCoverage + transitiveImporterBonus * 0.1 + bridgeOverlapBonus * 0.08;
	}

	private graphPenaltyForHypothesis(
		hypothesis: FixHypothesis,
		graphScores: Map<string, LoopGraphFileMetadata>
	): number {
		if (hypothesis.likely_files.length === 0 || graphScores.size === 0) return 0;
		const metadata = hypothesis.likely_files
			.map((filePath) => graphScores.get(normalizedPath(filePath)))
			.filter((value): value is LoopGraphFileMetadata => Boolean(value));
		if (metadata.length === 0) return 0;
		const avgCrossings = average(metadata.map((entry) => entry.package_crossings || 0));
		const avgBlastRadius = average(metadata.map((entry) => entry.package_blast_radius || 0));
		const symbolPathBonus = average(
			metadata.map((entry) =>
				typeof entry.symbol_path_distance === 'number' ? 1 / (entry.symbol_path_distance + 1) : 0
			)
		);
		return symbolPathBonus * 0.08 - avgCrossings * 0.03 - Math.min(0.2, avgBlastRadius * 0.01);
	}

	private hypothesisAreaKeys(hypothesis: FixHypothesis): string[] {
		const areas = new Set<string>();
		for (const likelyFile of hypothesis.likely_files) {
			areas.add(deriveModuleAreaKey(likelyFile));
		}
		if (areas.size === 0) areas.add('unknown');
		return [...areas].slice(0, 4);
	}

	private moduleAreaAdjustmentForHypothesis(
		hypothesis: FixHypothesis,
		memory: LoopExecutionMemory
	): number {
		const areaKeys = this.hypothesisAreaKeys(hypothesis);
		const areaAdjustments = areaKeys
			.map((areaKey) => memory.module_area_memory[areaKey])
			.filter((entry): entry is ModuleAreaMemory => Boolean(entry))
			.filter((entry) => entry.attempts > 0)
			.map((entry) => {
				const successRate = entry.successes / Math.max(1, entry.attempts);
				const failureRate = entry.failures / Math.max(1, entry.attempts);
				const trend = successRate - failureRate;
				const probeSignal = entry.average_probe_gain - 0.5;
				return trend * 0.08 + probeSignal * 0.06;
			});
		if (areaAdjustments.length === 0) return 0;
		const averageAdjustment =
			areaAdjustments.reduce((sum, value) => sum + value, 0) / areaAdjustments.length;
		return Math.max(-0.12, Math.min(0.12, averageAdjustment));
	}

	private updateModuleAreaMemory(input: {
		memory: LoopExecutionMemory;
		hypothesis: FixHypothesis;
		probeGain: number;
		outcome: 'attempt' | 'solved' | 'failed';
	}): void {
		const areaKeys = this.hypothesisAreaKeys(input.hypothesis);
		for (const areaKey of areaKeys) {
			const current = input.memory.module_area_memory[areaKey] || {
				area_key: areaKey,
				attempts: 0,
				successes: 0,
				failures: 0,
				average_probe_gain: 0,
				updated_at: Date.now(),
			};
			let nextAttempts = current.attempts;
			let nextSuccesses = current.successes;
			let nextFailures = current.failures;
			if (input.outcome === 'attempt') {
				nextAttempts += 1;
			} else if (input.outcome === 'solved') {
				nextSuccesses += 1;
			} else if (input.outcome === 'failed') {
				nextFailures += 1;
			}
			const gainSampleCount = Math.max(1, nextAttempts);
			const nextAverageProbeGain =
				input.outcome === 'attempt'
					? (current.average_probe_gain * current.attempts + input.probeGain) / gainSampleCount
					: current.average_probe_gain;
			input.memory.module_area_memory[areaKey] = {
				...current,
				attempts: nextAttempts,
				successes: nextSuccesses,
				failures: nextFailures,
				average_probe_gain: Number(nextAverageProbeGain.toFixed(4)),
				last_family: input.hypothesis.family,
				updated_at: Date.now(),
			};
		}
	}

	private memoryAdjustmentForHypothesis(
		hypothesis: FixHypothesis,
		memory: LoopExecutionMemory,
		plannerBoost: number,
		fingerprint?: FailureFingerprintMemory
	): number {
		const familyAttempts = memory.family_attempts[hypothesis.family] || 0;
		const familyPenalty = Math.min(0.2, familyAttempts * 0.05);
		const wasRecentlySelected = memory.selected_hypothesis_history
			.slice(-5)
			.includes(hypothesis.id);
		const recencyPenalty = wasRecentlySelected ? 0.08 : 0;
		const stagnationExplorationBoost =
			memory.stagnation_count >= 2 && familyAttempts === 0 ? 0.08 : 0;
		const fingerprintPenalty = (fingerprint?.family_penalties[hypothesis.family] || 0) * 0.08;
		const solvedBias = fingerprint?.solved_family === hypothesis.family ? 0.05 : 0;
		const moduleAreaAdjustment = this.moduleAreaAdjustmentForHypothesis(hypothesis, memory);
		return (
			plannerBoost +
			stagnationExplorationBoost +
			solvedBias -
			familyPenalty -
			recencyPenalty -
			fingerprintPenalty +
			moduleAreaAdjustment
		);
	}

	private rankHypothesesForAttempt(
		input: DebugFixLoopInput,
		hypotheses: FixHypothesis[],
		triageRanking: Array<{ hypothesis_id: string; score: number }>,
		probeResultsByHypothesis: Record<string, DiagnosticProbeResult[]>,
		contextFiles: Set<string>,
		graphScores: Map<string, LoopGraphFileMetadata>,
		memory: LoopExecutionMemory,
		plannerBoosts: Record<string, number>,
		fingerprint: FailureFingerprintMemory | undefined,
		weights: LoopScoringWeights
	): AttemptScoredHypothesis[] {
		const rankingLookup = new Map(
			triageRanking.map((entry) => [entry.hypothesis_id, entry.score] as const)
		);
		return hypotheses
			.map((hypothesis) => {
				const probeResults = probeResultsByHypothesis[hypothesis.id] || [];
				const probeGain = average(probeResults.map((result) => result.information_gain));
				const probeEvidenceDelta = this.probeEvidenceDeltaForHypothesis(hypothesis, probeResults);
				const probePassBonus = probeResults.some((result) => result.pass) ? 0.08 : 0;
				const contextCoverage = computeCoverage(hypothesis.likely_files, contextFiles);
				const graphCoverage = this.graphCoverageForHypothesis(hypothesis, graphScores);
				const graphPenalty = this.graphPenaltyForHypothesis(hypothesis, graphScores);
				const hasFeasibleCommand = hypothesis.suggested_commands.some((command) =>
					this.isCommandAllowed(input, command)
				);
				const commandFeasibilityScore = hasFeasibleCommand
					? 0.15 * weights.command_feasibility
					: -1;
				const baseScore = rankingLookup.get(hypothesis.id) || hypothesis.confidence;
				const plannerBoost = plannerBoosts[hypothesis.id] || 0;
				const memoryAdjustment =
					this.memoryAdjustmentForHypothesis(hypothesis, memory, plannerBoost, fingerprint) +
					this.probeMemoryAdjustmentForHypothesis(hypothesis, fingerprint);

				return {
					hypothesis,
					score:
						baseScore +
						probeGain * weights.probe_gain +
						probeEvidenceDelta * weights.probe_evidence_delta +
						contextCoverage * weights.context_coverage +
						graphCoverage * weights.graph_coverage +
						graphPenalty * weights.graph_penalty +
						commandFeasibilityScore +
						memoryAdjustment +
						probePassBonus * weights.probe_pass_bonus,
					base_score: baseScore,
					probe_gain: probeGain,
					probe_evidence_delta: probeEvidenceDelta,
					context_coverage: contextCoverage,
					graph_coverage: graphCoverage,
					graph_penalty: graphPenalty,
					memory_adjustment: memoryAdjustment,
					planner_boost: plannerBoost,
					validation_delta: 0,
					command_feasible: hasFeasibleCommand,
				};
			})
			.sort((left, right) => right.score - left.score);
	}

	private buildEvidenceLedger(
		scoredHypotheses: AttemptScoredHypothesis[],
		validationDeltas: Map<string, number>
	): HypothesisEvidenceLedgerEntry[] {
		return scoredHypotheses
			.map((item) => {
				const validationDelta = validationDeltas.get(item.hypothesis.id) || 0;
				const supportingReasons: string[] = [];
				const contradictingReasons: string[] = [];

				if (item.probe_gain >= 0.55) supportingReasons.push('high_probe_gain');
				if (item.probe_evidence_delta > 0.02) supportingReasons.push('probe_evidence_support');
				if (item.context_coverage >= 0.5) supportingReasons.push('context_alignment');
				if (item.graph_coverage >= 0.45) supportingReasons.push('graph_alignment');
				if (item.graph_penalty > 0.02) supportingReasons.push('graph_path_bonus');
				if (item.memory_adjustment > 0.02) supportingReasons.push('strategy_memory_support');
				if (validationDelta > 0.02) supportingReasons.push('validation_precheck_support');
				if (item.command_feasible) supportingReasons.push('command_feasible');

				if (item.probe_gain < 0.35) contradictingReasons.push('low_probe_gain');
				if (item.probe_evidence_delta < -0.02) contradictingReasons.push('probe_conflict');
				if (item.context_coverage < 0.2) contradictingReasons.push('weak_context_alignment');
				if (item.graph_coverage < 0.2) contradictingReasons.push('weak_graph_alignment');
				if (item.graph_penalty < -0.02) contradictingReasons.push('graph_risk_penalty');
				if (item.memory_adjustment < -0.02) contradictingReasons.push('strategy_memory_penalty');
				if (validationDelta < -0.02) contradictingReasons.push('validation_precheck_penalty');
				if (!item.command_feasible) contradictingReasons.push('no_feasible_command');

				if (supportingReasons.length === 0) {
					supportingReasons.push('base_rank_signal');
				}

				return {
					hypothesis_id: item.hypothesis.id,
					family: item.hypothesis.family,
					base_score: Number(item.base_score.toFixed(4)),
					probe_gain: Number(item.probe_gain.toFixed(4)),
					probe_evidence_delta: Number(item.probe_evidence_delta.toFixed(4)),
					context_coverage: Number(item.context_coverage.toFixed(4)),
					graph_coverage: Number(item.graph_coverage.toFixed(4)),
					graph_penalty: Number(item.graph_penalty.toFixed(4)),
					command_feasible: item.command_feasible,
					memory_adjustment: Number(item.memory_adjustment.toFixed(4)),
					planner_boost: Number(item.planner_boost.toFixed(4)),
					validation_delta: Number(validationDelta.toFixed(4)),
					final_score: Number(item.score.toFixed(4)),
					supporting_reasons: supportingReasons.slice(0, 5),
					contradicting_reasons: contradictingReasons.slice(0, 5),
				};
			})
			.sort((left, right) => right.final_score - left.final_score);
	}

	private buildFailureResult(
		attempts: DebugFixLoopAttempt[],
		code: DebugFixFailureCode,
		message: string,
		extras?: Omit<DebugFixLoopFailure, 'code' | 'message'>,
		memoryState?: LoopExecutionMemory
	): DebugFixLoopResult {
		return {
			status: 'failed',
			reason: code,
			attempts,
			memory_state: memoryState,
			failure: {
				code,
				message,
				...extras,
			},
		};
	}

	async run(input: DebugFixLoopInput, deps: DebugFixLoopDependencies): Promise<DebugFixLoopResult> {
		const memoryState = normalizeMemory(input.prior_memory);
		const adaptiveConfig = this.computeAdaptiveLoopConfig(input, memoryState);
		let maxAttempts = adaptiveConfig.maxAttempts;
		const scoringWeights = loadLoopScoringWeights(input.task.repo_root);
		const attempts: DebugFixLoopAttempt[] = [];
		let currentCommand = input.initial_command;
		let previousHypothesisSignature: string | null = null;
		let previousTopMetadataHash: string | null = null;
		let effectiveChangedFiles = [...(input.changed_files || [])];
		let previousClassification: FailureClassification | null = null;
		let previousLikelyFiles = new Set<string>();
		let contextFiles = new Set<string>(
			[...(input.related_files || []), ...(input.changed_files || [])].map((filePath) =>
				filePath.replace(/\\/g, '/')
			)
		);
		let contextInitialized = contextFiles.size > 0;
		let previousRankingSignature: string | null = null;
		let previousAverageProbeGain = 0;
		let lowGainRounds = 0;
		let forceFamilySwitchNextAttempt = false;
		let previousSelectedFamily: FixHypothesisFamily | undefined;
		let previousSelectedCommand: string | undefined;
		let previousSelectedHypothesis: FixHypothesis | undefined;
		let previousSelectedProbeGain = 0;
		let previousFailureFingerprintKey: string | undefined;

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
					},
					memoryState
				);
			}
			currentCommand = executableCommand;
			memoryState.command_attempts[currentCommand] =
				(memoryState.command_attempts[currentCommand] || 0) + 1;

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
						},
						memoryState
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
								plausibility_errors: applyResult.plausibility_errors,
							},
							memoryState
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
					context_fallback_files: [...contextFiles].slice(0, 20),
				});
				attempts[attempts.length - 1].triage = triage;
				deps.emitLifecycle?.({ type: 'hypothesis-generated', attempt, triage });

				if (triage.hypotheses.length === 0) {
					return this.buildFailureResult(
						attempts,
						'no_hypothesis_generated',
						'Triage did not produce any fix hypothesis.',
						{ attempt },
						memoryState
					);
				}
				const ambiguitySignals = this.computeAmbiguitySignals(triage.ranking, triage.confidence);
				const failureFingerprintKey = this.failureFingerprintKey({
					classification: triage.classification,
					probableFiles: triage.probable_files,
					probableSymbols: triage.probable_symbols,
				});
				const activeFingerprint = this.recordFingerprintSeen(memoryState, failureFingerprintKey);

				const classificationChanged =
					previousClassification !== null && previousClassification !== triage.classification;
				const filesDiverged = likelyFilesDiverged(previousLikelyFiles, triage.probable_files);
				const forceContextExpansion =
					forceFamilySwitchNextAttempt || (ambiguitySignals.ambiguous && attempt <= 2);
				const baseExpansionDecision = this.shouldExpandContext({
					confidence: triage.confidence,
					classification: triage.classification,
					classificationChanged,
					likelyFilesDiverged: filesDiverged,
					probeConflict: false,
					contextInitialized,
					forceFamilySwitch: forceContextExpansion,
				});
				const expansionDecision =
					ambiguitySignals.ambiguous && baseExpansionDecision.depth === 1 && attempt <= 2
						? {
								...baseExpansionDecision,
								shouldExpand: true as const,
								depth: 2 as const,
								reason: 'low_confidence' as const,
							}
						: baseExpansionDecision;

				if (expansionDecision.shouldExpand && deps.getContextPack) {
					try {
						const contextPack = await deps.getContextPack({
							mode: 'failure_focused',
							seedFiles: [...new Set([...triage.probable_files, ...contextFiles])],
							seedSymbols: triage.probable_symbols,
							depth: expansionDecision.depth,
							reason: expansionDecision.reason,
							maxFiles:
								expansionDecision.depth === 2
									? ambiguitySignals.ambiguous || adaptiveConfig.hardModeEnabled
										? 24
										: 20
									: 6,
						});
						if (contextPack && contextPack.selectedFiles.length > 0) {
							contextFiles = new Set(
								[...contextFiles, ...contextPack.selectedFiles].map((filePath) =>
									filePath.replace(/\\/g, '/')
								)
							);
							contextInitialized = true;
							attempts[attempts.length - 1].context_expanded = true;
							attempts[attempts.length - 1].context_selected_files = contextPack.selectedFiles;
							attempts[attempts.length - 1].context_selection_narratives =
								contextPack.selection_narratives;
							deps.emitLifecycle?.({
								type: 'context-expanded',
								attempt,
								reason: expansionDecision.reason,
								depth: expansionDecision.depth,
								selected_files: contextPack.selectedFiles,
								impacted_symbols: contextPack.impactedSymbols,
							});
						}
					} catch {
						// Context expansion is best effort; strict loop continues without it.
					}
				}

				const attemptBeamWidth = this.computeBeamWidth({
					triageBeamWidth: triage.beam_width || 2,
					maxBeamWidth: adaptiveConfig.maxBeamWidth,
					confidence: triage.confidence,
					classification: triage.classification,
					stagnationCount: memoryState.stagnation_count,
					lowGainRounds,
					ambiguous: ambiguitySignals.ambiguous,
				});
				let candidateHypotheses = triage.hypotheses.slice(
					0,
					Math.max(1, Math.min(attemptBeamWidth, triage.hypotheses.length))
				);
				if (forceFamilySwitchNextAttempt && previousSelectedFamily) {
					const filtered = candidateHypotheses.filter(
						(hypothesis) => hypothesis.family !== previousSelectedFamily
					);
					if (filtered.length > 0) {
						candidateHypotheses = filtered;
					}
				}
				candidateHypotheses = candidateHypotheses.map((hypothesis) =>
					this.sortProbeCandidatesByMemory(hypothesis, activeFingerprint)
				);

				const probePolicy = this.computeProbePolicy({
					confidence: triage.confidence,
					classification: triage.classification,
					lowGainRounds,
					stagnationCount: memoryState.stagnation_count,
					candidateCount: candidateHypotheses.length,
					hardModeEnabled: adaptiveConfig.hardModeEnabled,
					ambiguous: ambiguitySignals.ambiguous,
				});
				const probeExecution = await this.probeEngine.execute(
					{
						hypotheses: candidateHypotheses,
						probeBudget: probePolicy.budget,
						defaultTimeoutMs: probePolicy.timeoutMs,
						baselineSignal: triage.raw_signal_excerpt,
					},
					{
						runCommand: deps.runCommand,
						isCommandAllowed: (command) => this.isCommandAllowed(input, command),
					}
				);
				for (const hypothesis of candidateHypotheses) {
					this.recordProbeOutcomeFingerprint(
						memoryState,
						failureFingerprintKey,
						hypothesis,
						probeExecution.results_by_hypothesis[hypothesis.id] || []
					);
				}

				for (const entry of probeExecution.entries) {
					const hypothesis = candidateHypotheses.find((item) => item.id === entry.hypothesis_id);
					if (!hypothesis) continue;
					const probe = hypothesis.probe_candidates.find((item) => item.id === entry.probe_id);
					if (!probe) continue;
					deps.emitLifecycle?.({
						type: 'probe-started',
						attempt,
						hypothesis_id: entry.hypothesis_id,
						probe,
					});
					deps.emitLifecycle?.({
						type: 'probe-finished',
						attempt,
						hypothesis_id: entry.hypothesis_id,
						probe_result: entry.result,
					});
				}
				attempts[attempts.length - 1].probe_results = probeExecution.entries.map(
					(entry) => entry.result
				);

				let graphScoreLookup = new Map<string, LoopGraphFileMetadata>();
				let graphQueryResult: LoopGraphQueryResult | null = null;
				if (deps.getGraphScores) {
					try {
						const graphResult = await deps.getGraphScores({
							seedFiles: [...new Set([...contextFiles, ...triage.probable_files])],
							candidateFiles: [
								...new Set(candidateHypotheses.flatMap((hypothesis) => hypothesis.likely_files)),
							],
							seedSymbols: triage.probable_symbols,
							maxDepth:
								memoryState.stagnation_count >= 1 ||
								adaptiveConfig.hardModeEnabled ||
								ambiguitySignals.ambiguous
									? 10
									: 6,
						});
						if (graphResult) {
							graphQueryResult = graphResult;
							graphScoreLookup = new Map(
								graphResult.scores.map((score) => [
									normalizedPath(score.file_path),
									{
										score: score.score,
										path_strength: score.path_strength,
										symbol_path_distance: score.symbol_path_distance,
										package_crossings: score.package_crossings,
										package_blast_radius: score.package_blast_radius,
										bridge_file_count: score.bridge_file_count,
										bridge_symbol_count: score.bridge_symbol_count,
										bridge_symbol_overlap: score.bridge_symbol_overlap,
										transitive_importer_fanout: score.transitive_importer_fanout,
									},
								])
							);
							attempts[attempts.length - 1].graph_query_coverage = graphResult.coverage;
							attempts[attempts.length - 1].graph_query_explored_nodes = graphResult.explored_nodes;
							memoryState.graph_query_count += 1;
							attempts[attempts.length - 1].graph_explanations = graphResult.scores
								.filter(
									(score) =>
										Boolean(score.explanation) ||
										(Boolean(score.explanation_path) && (score.explanation_path?.length || 0) > 0)
								)
								.slice(0, 10)
								.map((score) => ({
									file_path: score.file_path,
									explanation_path: score.explanation_path,
									explanation: score.explanation,
								}));
						}
					} catch {
						// Graph scoring is best effort and should not fail strict-loop execution.
					}
				}

				const longHorizonPlan = this.longHorizonPlanner.plan({
					attempt,
					hypotheses: candidateHypotheses,
					triageFiles: triage.probable_files,
					contextFiles: [...contextFiles],
					graphQuery: graphQueryResult,
					memory: memoryState,
				});
				memoryState.long_horizon_plan_count += 1;
				attempts[attempts.length - 1].long_horizon_focus_files = longHorizonPlan.focus_files;
				attempts[attempts.length - 1].long_horizon_checkpoints = longHorizonPlan.checkpoints;

				const scoredHypotheses = this.rankHypothesesForAttempt(
					input,
					candidateHypotheses,
					triage.ranking,
					probeExecution.results_by_hypothesis,
					contextFiles,
					graphScoreLookup,
					memoryState,
					longHorizonPlan.hypothesis_boosts,
					activeFingerprint,
					scoringWeights
				);
				const dualTrackValidation = await this.runDualTrackValidation(
					input,
					deps,
					currentCommand,
					scoredHypotheses,
					memoryState
				);
				if (dualTrackValidation.results.length > 0) {
					attempts[attempts.length - 1].dual_track_results = dualTrackValidation.results;
				}
				const adjustedScoredHypotheses = scoredHypotheses
					.map((item) => ({
						...item,
						validation_delta: dualTrackValidation.scoreDeltas.get(item.hypothesis.id) || 0,
						score: item.score + (dualTrackValidation.scoreDeltas.get(item.hypothesis.id) || 0),
					}))
					.sort((left, right) => right.score - left.score);
				attempts[attempts.length - 1].evidence_ledger = this.buildEvidenceLedger(
					adjustedScoredHypotheses,
					dualTrackValidation.scoreDeltas
				);
				const selected =
					adjustedScoredHypotheses.find((item) => item.command_feasible) ||
					adjustedScoredHypotheses[0];
				if (!selected) {
					return this.buildFailureResult(
						attempts,
						'command_not_allowed',
						'Triage produced commands outside task allowlist.',
						{
							attempt,
							blocking_reasons: ['triage_command_not_allowed'],
						},
						memoryState
					);
				}

				attempts[attempts.length - 1].selected_hypothesis_id = selected.hypothesis.id;
				const previousSelectedHypothesisId =
					memoryState.selected_hypothesis_history[
						memoryState.selected_hypothesis_history.length - 1
					];
				const rankingSignature = adjustedScoredHypotheses
					.map((item) => item.hypothesis.id)
					.join('|');
				const rankingStable =
					previousRankingSignature !== null && previousRankingSignature === rankingSignature;
				const averageProbeGain = probeExecution.average_information_gain;
				const metadataChanged =
					previousTopMetadataHash !== null &&
					previousTopMetadataHash !== selected.hypothesis.metadata_hash;
				const allowRepeatCommand =
					metadataChanged || previousFailureFingerprintKey !== failureFingerprintKey;
				const fixPathCandidates = this.buildFixPathCandidates({
					taskInput: input,
					triage: { classification: triage.classification },
					selectedHypothesis: selected.hypothesis,
					scoredHypotheses: adjustedScoredHypotheses,
					validationResults: dualTrackValidation.results,
					currentCommand,
					memory: memoryState,
					allowRepeat: allowRepeatCommand,
					fingerprint: activeFingerprint,
				});
				const extraPrechecks = await this.precheckFixPathCandidates({
					deps,
					candidates: fixPathCandidates,
					existingResults: dualTrackValidation.results,
					memory: memoryState,
				});
				if (extraPrechecks.length > 0) {
					attempts[attempts.length - 1].dual_track_results = [
						...(attempts[attempts.length - 1].dual_track_results || []),
						...extraPrechecks,
					];
					fixPathCandidates.sort((left, right) => right.score - left.score);
				}
				const branchCount = Math.max(
					1,
					Math.min(
						adaptiveConfig.maxFixPathBranches + (ambiguitySignals.ambiguous ? 1 : 0),
						fixPathCandidates.length
					)
				);
				const branchedFixPathCandidates = fixPathCandidates.slice(0, branchCount);
				attempts[attempts.length - 1].hypothesis_branch_count = branchedFixPathCandidates.length;
				attempts[attempts.length - 1].fix_path_candidates = branchedFixPathCandidates;
				const selectedFixPath =
					branchedFixPathCandidates.find((candidate) => candidate.feasible) ||
					branchedFixPathCandidates[0];
				if (!selectedFixPath) {
					this.recordDeadEndFingerprint(
						memoryState,
						failureFingerprintKey,
						selected.hypothesis.family,
						currentCommand
					);
					return this.buildFailureResult(
						attempts,
						'command_not_allowed',
						'Triage produced commands outside task allowlist.',
						{
							attempt,
							blocking_reasons: ['triage_command_not_allowed'],
						},
						memoryState
					);
				}
				attempts[attempts.length - 1].selected_command = selectedFixPath.command;
				const selectedProbeResults =
					probeExecution.results_by_hypothesis[selected.hypothesis.id] || [];
				const probeConflict = hasConflictingProbeOutcomes(selectedProbeResults);
				memoryState.family_attempts[selected.hypothesis.family] =
					(memoryState.family_attempts[selected.hypothesis.family] || 0) + 1;
				memoryState.selected_hypothesis_history = [
					...memoryState.selected_hypothesis_history,
					selected.hypothesis.id,
				].slice(-20);
				this.updateModuleAreaMemory({
					memory: memoryState,
					hypothesis: selected.hypothesis,
					probeGain: averageProbeGain,
					outcome: 'attempt',
				});

				if (averageProbeGain < DebugFixLoopEngine.LOW_GAIN_THRESHOLD) {
					if (metadataChanged) {
						lowGainRounds = 0;
					} else {
						lowGainRounds += 1;
					}
				} else {
					lowGainRounds = 0;
					forceFamilySwitchNextAttempt = false;
				}
				if (
					previousSelectedHypothesisId === selected.hypothesis.id &&
					averageProbeGain < DebugFixLoopEngine.LOW_GAIN_THRESHOLD
				) {
					memoryState.stagnation_count += 1;
				} else if (averageProbeGain >= DebugFixLoopEngine.LOW_GAIN_THRESHOLD) {
					memoryState.stagnation_count = Math.max(0, memoryState.stagnation_count - 1);
				}
				attempts[attempts.length - 1].stagnation_count = memoryState.stagnation_count;

				const noProgressDetected =
					lowGainRounds >= 2 || (memoryState.stagnation_count >= 3 && rankingStable);
				const canExtendAttempts =
					input.max_attempts === undefined &&
					attempt === maxAttempts &&
					maxAttempts < DebugFixLoopEngine.HARD_MODE_MAX_ATTEMPTS &&
					!noProgressDetected &&
					(ambiguitySignals.ambiguous || memoryState.stagnation_count >= 1) &&
					averageProbeGain >= DebugFixLoopEngine.LOW_GAIN_THRESHOLD * 0.75;
				if (canExtendAttempts) {
					maxAttempts += 1;
				}
				if (noProgressDetected) {
					this.recordDeadEndFingerprint(
						memoryState,
						failureFingerprintKey,
						selected.hypothesis.family,
						selectedFixPath.command
					);
					this.updateModuleAreaMemory({
						memory: memoryState,
						hypothesis: selected.hypothesis,
						probeGain: averageProbeGain,
						outcome: 'failed',
					});
					return this.buildFailureResult(
						attempts,
						'non_progressing_hypothesis_loop',
						'Hypothesis ranking and probe gain did not improve across retries.',
						{
							attempt,
							hypothesis: {
								previous_signature: previousHypothesisSignature || undefined,
								current_signature: rankingSignature,
								previous_top_metadata_hash: previousTopMetadataHash || undefined,
								current_top_metadata_hash: selected.hypothesis.metadata_hash,
							},
							probe_deltas: {
								previous_average_gain: previousAverageProbeGain,
								current_average_gain: averageProbeGain,
								ranking_stable: rankingStable,
							},
						},
						memoryState
					);
				}

				if (lowGainRounds >= 1 || memoryState.stagnation_count >= 2) {
					const alternateFamily = adjustedScoredHypotheses.find(
						(item) => item.hypothesis.family !== selected.hypothesis.family
					)?.hypothesis.family;
					const switchReason =
						memoryState.stagnation_count >= 2 ? 'memory_stagnation' : 'low_probe_information_gain';
					deps.emitLifecycle?.({
						type: 'strategy-switched',
						attempt,
						from_family: selected.hypothesis.family,
						to_family: alternateFamily,
						reason: switchReason,
					});
					memoryState.strategy_switch_count += 1;
					forceFamilySwitchNextAttempt = true;
				}

				previousHypothesisSignature = rankingSignature;
				previousTopMetadataHash = selected.hypothesis.metadata_hash;
				previousClassification = triage.classification;
				previousLikelyFiles = new Set(triage.probable_files);
				previousRankingSignature = rankingSignature;
				previousAverageProbeGain = averageProbeGain;
				previousSelectedFamily = selected.hypothesis.family;
				previousSelectedCommand = selectedFixPath.command;
				previousSelectedHypothesis = selected.hypothesis;
				previousSelectedProbeGain = averageProbeGain;
				previousFailureFingerprintKey = failureFingerprintKey;

				if (probeConflict && deps.getContextPack) {
					try {
						const conflictPack = await deps.getContextPack({
							mode: 'failure_focused',
							seedFiles: [...new Set([...triage.probable_files, ...contextFiles])],
							seedSymbols: triage.probable_symbols,
							depth: 2,
							reason: 'strategy_switch',
							maxFiles: 20,
						});
						if (conflictPack && conflictPack.selectedFiles.length > 0) {
							contextFiles = new Set(
								[...contextFiles, ...conflictPack.selectedFiles].map((filePath) =>
									filePath.replace(/\\/g, '/')
								)
							);
							attempts[attempts.length - 1].context_expanded = true;
							attempts[attempts.length - 1].context_selected_files = conflictPack.selectedFiles;
							attempts[attempts.length - 1].context_selection_narratives =
								conflictPack.selection_narratives;
							deps.emitLifecycle?.({
								type: 'context-expanded',
								attempt,
								reason: 'strategy_switch',
								depth: 2,
								selected_files: conflictPack.selectedFiles,
								impacted_symbols: conflictPack.impactedSymbols,
							});
						}
					} catch {
						// Continue without additional context if expansion fails.
					}
				}

				currentCommand = selectedFixPath.command;
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
				if (
					previousFailureFingerprintKey &&
					previousSelectedFamily &&
					previousSelectedCommand &&
					previousSelectedHypothesis
				) {
					this.recordSolvedFingerprint(
						memoryState,
						previousFailureFingerprintKey,
						previousSelectedFamily,
						previousSelectedCommand
					);
					this.updateModuleAreaMemory({
						memory: memoryState,
						hypothesis: previousSelectedHypothesis,
						probeGain: previousSelectedProbeGain,
						outcome: 'solved',
					});
				}
				return {
					status: 'complete',
					attempts,
					decision,
					review_findings: reviewFindings,
					memory_state: memoryState,
				};
			}

			if (
				previousFailureFingerprintKey &&
				previousSelectedFamily &&
				previousSelectedCommand &&
				previousSelectedHypothesis
			) {
				this.recordDeadEndFingerprint(
					memoryState,
					previousFailureFingerprintKey,
					previousSelectedFamily,
					previousSelectedCommand
				);
				this.updateModuleAreaMemory({
					memory: memoryState,
					hypothesis: previousSelectedHypothesis,
					probeGain: previousSelectedProbeGain,
					outcome: 'failed',
				});
			}
			return {
				status: 'failed',
				reason: decision.blocking_reasons.join(',') || 'gate_blocked',
				attempts,
				decision,
				review_findings: reviewFindings,
				memory_state: memoryState,
				failure: {
					code: 'gate_blocked',
					message: 'Gate engine blocked completion.',
					attempt,
					blocking_reasons: decision.blocking_reasons,
				},
			};
		}

		if (
			previousFailureFingerprintKey &&
			previousSelectedFamily &&
			previousSelectedCommand &&
			previousSelectedHypothesis
		) {
			this.recordDeadEndFingerprint(
				memoryState,
				previousFailureFingerprintKey,
				previousSelectedFamily,
				previousSelectedCommand
			);
			this.updateModuleAreaMemory({
				memory: memoryState,
				hypothesis: previousSelectedHypothesis,
				probeGain: previousSelectedProbeGain,
				outcome: 'failed',
			});
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
				probe_deltas: {
					previous_average_gain: previousAverageProbeGain,
				},
			},
			memoryState
		);
	}
}
