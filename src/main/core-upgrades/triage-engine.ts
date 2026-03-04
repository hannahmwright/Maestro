import crypto from 'crypto';
import type {
	DiagnosticProbe,
	FailureClassification,
	FailureSignal,
	FixHypothesis,
	FixHypothesisFamily,
	HypothesisEvidence,
	TriageResult,
} from './types';

interface FailurePattern {
	classification: FailureClassification;
	regex: RegExp;
	confidence: number;
}

const FAILURE_PATTERNS: FailurePattern[] = [
	{
		classification: 'module_not_found',
		regex: /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/i,
		confidence: 0.9,
	},
	{
		classification: 'type_error',
		regex: /TS\d+|Type\s+'.+'\s+is\s+not\s+assignable|Cannot find name/i,
		confidence: 0.88,
	},
	{
		classification: 'syntax_error',
		regex: /SyntaxError|Unexpected token|Parsing error/i,
		confidence: 0.86,
	},
	{
		classification: 'test_failure',
		regex: /(FAIL|failing|AssertionError|Expected:|Received:)/i,
		confidence: 0.8,
	},
	{ classification: 'lint_error', regex: /(eslint|prettier|lint)/i, confidence: 0.74 },
	{
		classification: 'permission_error',
		regex: /(EACCES|permission denied|operation not permitted)/i,
		confidence: 0.84,
	},
	{
		classification: 'command_not_found',
		regex: /(command not found|is not recognized as an internal or external command)/i,
		confidence: 0.92,
	},
	{
		classification: 'runtime_error',
		regex: /(Unhandled|ReferenceError|RangeError|TypeError:)/i,
		confidence: 0.7,
	},
];

const FILE_PATH_REGEX = /(?:^|\s|\()([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs))(?:[:(]\d+)?/g;
const SYMBOL_REGEX = /(Cannot find name|Property)\s+'([A-Za-z_$][\w$]*)'/g;
const TEST_FILE_REGEX = /(?:^|\/)(__tests__|test|tests)\/|(?:\.test|\.spec)\.[jt]sx?$/i;
const PACKAGE_SEGMENT_REGEX = /(^|\/)(packages\/[^/]+)/;
const BEAM_WIDTH = 2;
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

const FAMILY_CONFIRMING_PATTERNS: Record<FixHypothesisFamily, RegExp[]> = {
	dependency: [/Cannot find module|ERR_MODULE_NOT_FOUND|Module not found/i],
	typing: [/TS\d+|Type\s+'.+'\s+is\s+not\s+assignable|Cannot find name/i],
	test_logic: [/FAIL|AssertionError|Expected:|Received:/i],
	runtime: [/ReferenceError|TypeError:|RangeError|Unhandled/i],
	lint: [/eslint|prettier|lint/i],
	environment: [/command not found|permission denied|EACCES|not recognized/i],
};

const FAMILY_DISCONFIRMING_PATTERNS: Record<FixHypothesisFamily, RegExp[]> = {
	dependency: [/AssertionError|Expected:|Received:/i],
	typing: [/command not found|permission denied|EACCES/i],
	test_logic: [/TS\d+|Cannot find module|ERR_MODULE_NOT_FOUND/i],
	runtime: [/eslint|prettier|lint/i],
	lint: [/ReferenceError|TypeError:|AssertionError/i],
	environment: [/src\/|\.test\.[jt]sx?|TS\d+/i],
};

function classifyFailure(signal: string): {
	classification: FailureClassification;
	confidence: number;
} {
	for (const pattern of FAILURE_PATTERNS) {
		if (pattern.regex.test(signal)) {
			return { classification: pattern.classification, confidence: pattern.confidence };
		}
	}
	return { classification: 'unknown', confidence: 0.35 };
}

function rankFileCandidates(files: string[], classification: FailureClassification): string[] {
	const unique = [...new Set(files.map((filePath) => filePath.replace(/\\/g, '/')))];
	const score = (filePath: string): number => {
		const isTestFile = TEST_FILE_REGEX.test(filePath);
		switch (classification) {
			case 'test_failure':
				return (isTestFile ? 4 : 0) + (filePath.includes('__tests__') ? 2 : 0);
			case 'lint_error':
			case 'type_error':
			case 'module_not_found':
			case 'syntax_error':
				return (isTestFile ? 0 : 3) + (filePath.includes('/src/') ? 1 : 0);
			default:
				return isTestFile ? 1 : 2;
		}
	};

	return unique.sort((a, b) => score(b) - score(a));
}

function normalizeContextFallbackFiles(files: string[]): string[] {
	return files
		.map((filePath) => filePath.trim())
		.filter(Boolean)
		.filter((filePath) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(filePath))
		.map((filePath) => filePath.replace(/\\/g, '/'))
		.filter((filePath) => !filePath.includes('node_modules'));
}

function extractProbableFiles(
	signal: string,
	classification: FailureClassification,
	contextFallbackFiles: string[] = []
): string[] {
	const files: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = FILE_PATH_REGEX.exec(signal))) {
		const filePath = match[1];
		if (filePath && !filePath.includes('node_modules')) {
			files.push(filePath.replace(/\\/g, '/'));
		}
	}

	const combined = [...files, ...normalizeContextFallbackFiles(contextFallbackFiles)];
	return rankFileCandidates(combined, classification).slice(0, 8);
}

function extractProbableSymbols(signal: string): string[] {
	const symbols = new Set<string>();
	let match: RegExpExecArray | null;
	while ((match = SYMBOL_REGEX.exec(signal))) {
		if (match[2]) symbols.add(match[2]);
	}
	return [...symbols].slice(0, 8);
}

function buildMetadataHash(
	classification: FailureClassification,
	command: string,
	files: string[],
	symbols: string[]
): string {
	return crypto
		.createHash('sha1')
		.update(
			JSON.stringify({
				classification,
				command,
				files: files.slice(0, 5),
				symbols: symbols.slice(0, 5),
			})
		)
		.digest('hex');
}

function familyForClassification(classification: FailureClassification): FixHypothesisFamily {
	switch (classification) {
		case 'module_not_found':
			return 'dependency';
		case 'type_error':
		case 'syntax_error':
			return 'typing';
		case 'test_failure':
			return 'test_logic';
		case 'runtime_error':
			return 'runtime';
		case 'lint_error':
			return 'lint';
		case 'permission_error':
		case 'command_not_found':
			return 'environment';
		case 'unknown':
			return 'runtime';
	}
}

function secondaryFamily(classification: FailureClassification): FixHypothesisFamily {
	switch (classification) {
		case 'test_failure':
			return 'typing';
		case 'type_error':
		case 'module_not_found':
		case 'syntax_error':
			return 'dependency';
		case 'lint_error':
			return 'typing';
		case 'runtime_error':
		case 'unknown':
			return 'test_logic';
		case 'permission_error':
		case 'command_not_found':
			return 'runtime';
	}
}

function buildTargetedCommands(
	classification: FailureClassification,
	likelyFiles: string[],
	family: FixHypothesisFamily
): string[] {
	const commands: string[] = [];
	const normalizedFiles = likelyFiles.map((filePath) => filePath.replace(/\\/g, '/'));
	const testFile = normalizedFiles.find((filePath) => TEST_FILE_REGEX.test(filePath));
	const sourceFile = normalizedFiles.find((filePath) => !TEST_FILE_REGEX.test(filePath));
	const packageScope = normalizedFiles
		.map((filePath) => filePath.match(PACKAGE_SEGMENT_REGEX)?.[2])
		.find((scope): scope is string => Boolean(scope));

	if (classification === 'lint_error' || family === 'lint') {
		if (sourceFile) commands.push(`npm run lint -- ${sourceFile}`);
		if (packageScope) commands.push(`npm run lint -- ${packageScope}`);
		commands.push('npm run lint');
		return commands;
	}

	if (family === 'environment') {
		commands.push('npm test', 'npm run build');
		return commands;
	}

	if (testFile) commands.push(`npm test -- ${testFile}`);
	if (
		sourceFile &&
		classification !== 'command_not_found' &&
		classification !== 'permission_error'
	) {
		commands.push(`npm test -- ${sourceFile}`);
	}
	if (packageScope) commands.push(`npm test -- ${packageScope}`);
	commands.push('npm test -- --runInBand');
	if (family === 'dependency' || family === 'typing' || family === 'runtime') {
		commands.push('npm run build');
	}
	commands.push('npm test');

	return commands;
}

function uniqueCommands(commands: string[]): string[] {
	return [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function buildEvidence(
	signal: string,
	classification: FailureClassification,
	family: FixHypothesisFamily,
	likelyFiles: string[],
	likelySymbols: string[]
): HypothesisEvidence {
	const confirmingSignals: string[] = [];
	const disconfirmingSignals: string[] = [];

	for (const pattern of FAMILY_CONFIRMING_PATTERNS[family]) {
		if (pattern.test(signal)) {
			confirmingSignals.push(`Matched ${family} indicator: ${pattern.source}`);
		}
	}
	for (const pattern of FAMILY_DISCONFIRMING_PATTERNS[family]) {
		if (pattern.test(signal)) {
			disconfirmingSignals.push(`Matched conflicting indicator: ${pattern.source}`);
		}
	}
	if (likelyFiles.length > 0) {
		confirmingSignals.push(`Likely files: ${likelyFiles.slice(0, 2).join(', ')}`);
	}
	if (likelySymbols.length > 0) {
		confirmingSignals.push(`Likely symbols: ${likelySymbols.slice(0, 2).join(', ')}`);
	}
	if (classification === 'unknown' && family !== 'runtime') {
		disconfirmingSignals.push('Failure classification is unknown for this family.');
	}

	const rawScore = 0.45 + confirmingSignals.length * 0.11 - disconfirmingSignals.length * 0.16;
	const evidenceScore = clamp(rawScore, 0.05, 0.98);
	let uncertaintyNote = 'Evidence and signal are aligned.';
	if (disconfirmingSignals.length > confirmingSignals.length) {
		uncertaintyNote = 'Conflicting indicators exceed confirming signals; treat with caution.';
	} else if (disconfirmingSignals.length > 0) {
		uncertaintyNote = 'Some conflicting indicators exist; verify with probes.';
	} else if (confirmingSignals.length <= 1) {
		uncertaintyNote = 'Sparse evidence; confidence depends on probe outcomes.';
	}

	return {
		confirming_signals: confirmingSignals.slice(0, 5),
		disconfirming_signals: disconfirmingSignals.slice(0, 5),
		uncertainty_note: uncertaintyNote,
		evidence_score: Number(evidenceScore.toFixed(3)),
	};
}

function buildProbe(
	hypothesisId: string,
	kind: 'confirm' | 'disconfirm',
	purpose: string,
	command: string,
	targetFiles: string[]
): DiagnosticProbe {
	const idSeed = `${hypothesisId}:${purpose}:${command}`;
	return {
		id: `probe-${crypto.createHash('sha1').update(idSeed).digest('hex').slice(0, 10)}`,
		purpose,
		kind,
		command,
		target_files: targetFiles.slice(0, 3),
		timeout_ms: DEFAULT_PROBE_TIMEOUT_MS,
	};
}

function buildProbeCandidates(
	hypothesisId: string,
	family: FixHypothesisFamily,
	commands: string[],
	likelyFiles: string[]
): DiagnosticProbe[] {
	const probes: DiagnosticProbe[] = [];
	const usedCommands = new Set<string>();
	const targetFiles = likelyFiles.slice(0, 3);

	const addProbeIfCommand = (
		kind: 'confirm' | 'disconfirm',
		purpose: string,
		command: string | undefined
	) => {
		if (!command) return;
		const normalized = command.trim();
		if (!normalized || usedCommands.has(normalized)) return;
		usedCommands.add(normalized);
		probes.push(buildProbe(hypothesisId, kind, purpose, normalized, targetFiles));
	};

	const firstUnusedCommand = () => commands.find((command) => !usedCommands.has(command.trim()));
	const firstUnusedMatching = (tokens: string[]) =>
		commands.find(
			(command) =>
				tokens.some((token) => command.toLowerCase().includes(token)) &&
				!usedCommands.has(command.trim())
		);

	switch (family) {
		case 'lint':
			addProbeIfCommand('confirm', 'lint_scope_check', firstUnusedMatching(['lint']));
			addProbeIfCommand(
				'disconfirm',
				'lint_disconfirm_build',
				firstUnusedMatching(['build', 'test --'])
			);
			break;
		case 'typing':
			addProbeIfCommand('confirm', 'build_type_check', firstUnusedMatching(['build', 'tsc']));
			addProbeIfCommand(
				'disconfirm',
				'typing_disconfirm_targeted_test',
				firstUnusedMatching(['test --', 'lint'])
			);
			break;
		case 'dependency':
			addProbeIfCommand('confirm', 'dependency_resolution_probe', firstUnusedMatching(['build']));
			addProbeIfCommand(
				'disconfirm',
				'dependency_disconfirm_lint',
				firstUnusedMatching(['lint', 'test --'])
			);
			break;
		case 'test_logic':
			addProbeIfCommand('confirm', 'targeted_test_probe', firstUnusedMatching(['test --']));
			addProbeIfCommand(
				'disconfirm',
				'test_logic_disconfirm_build',
				firstUnusedMatching(['build', 'lint'])
			);
			break;
		case 'runtime':
			addProbeIfCommand('confirm', 'runtime_repro_probe', firstUnusedMatching(['test']));
			addProbeIfCommand(
				'disconfirm',
				'runtime_disconfirm_lint',
				firstUnusedMatching(['lint', 'build'])
			);
			break;
		case 'environment':
			addProbeIfCommand(
				'confirm',
				'environment_baseline_probe',
				firstUnusedMatching(['test', 'build'])
			);
			addProbeIfCommand(
				'disconfirm',
				'environment_disconfirm_targeted',
				firstUnusedMatching(['test --', 'lint'])
			);
			break;
	}

	// Always include both confirm and disconfirm probes when possible.
	if (!probes.some((probe) => probe.kind === 'confirm')) {
		const fallbackConfirm = firstUnusedCommand() || commands[0];
		if (fallbackConfirm) {
			probes.push(
				buildProbe(hypothesisId, 'confirm', 'fallback_confirm_probe', fallbackConfirm, targetFiles)
			);
		}
	}
	if (!probes.some((probe) => probe.kind === 'disconfirm')) {
		const fallbackDisconfirm = firstUnusedCommand() || commands[0];
		if (fallbackDisconfirm) {
			probes.push(
				buildProbe(
					hypothesisId,
					'disconfirm',
					'fallback_disconfirm_probe',
					fallbackDisconfirm,
					targetFiles
				)
			);
		}
	}

	return probes.slice(0, 3);
}

function scoreHypothesis(
	hypothesis: FixHypothesis,
	classification: FailureClassification,
	baseConfidence: number
): number {
	const familyBias: Record<FixHypothesisFamily, number> = {
		dependency: classification === 'module_not_found' ? 0.14 : 0.05,
		typing: classification === 'type_error' || classification === 'syntax_error' ? 0.14 : 0.05,
		test_logic: classification === 'test_failure' ? 0.14 : 0.05,
		runtime: classification === 'runtime_error' || classification === 'unknown' ? 0.1 : 0.04,
		lint: classification === 'lint_error' ? 0.14 : 0.03,
		environment:
			classification === 'command_not_found' || classification === 'permission_error' ? 0.14 : 0.03,
	};

	return (
		baseConfidence +
		familyBias[hypothesis.family] +
		Math.min(0.08, hypothesis.likely_files.length * 0.01) +
		Math.min(0.05, hypothesis.likely_symbols.length * 0.01) +
		hypothesis.evidence.evidence_score * 0.2 -
		(hypothesis.evidence.evidence_score < 0.45 ? 0.16 : 0)
	);
}

function buildHypothesis(
	id: string,
	classification: FailureClassification,
	family: FixHypothesisFamily,
	confidence: number,
	likelyFiles: string[],
	likelySymbols: string[],
	command: string,
	signal: string,
	rationale: string
): FixHypothesis {
	const suggestedCommands = uniqueCommands(
		buildTargetedCommands(classification, likelyFiles, family)
	);
	const evidence = buildEvidence(signal, classification, family, likelyFiles, likelySymbols);
	return {
		id,
		classification,
		family,
		title: `Address ${family.replace(/_/g, ' ')}`,
		rationale,
		confidence,
		likely_files: likelyFiles,
		likely_symbols: likelySymbols,
		evidence,
		suggested_commands: suggestedCommands,
		probe_candidates: buildProbeCandidates(id, family, suggestedCommands, likelyFiles),
		metadata_hash: buildMetadataHash(classification, command, likelyFiles, likelySymbols),
	};
}

function buildHypotheses(
	classification: FailureClassification,
	command: string,
	signal: string,
	confidence: number,
	likelyFiles: string[],
	likelySymbols: string[]
): FixHypothesis[] {
	const primaryFamily = familyForClassification(classification);
	const alternateFamily = secondaryFamily(classification);

	const primary = buildHypothesis(
		`hyp-${classification}-1`,
		classification,
		primaryFamily,
		confidence,
		likelyFiles,
		likelySymbols,
		command,
		signal,
		`Primary hypothesis inferred from failure signature (${classification}).`
	);

	const alternate = buildHypothesis(
		`hyp-${classification}-2`,
		classification,
		alternateFamily,
		Math.max(0.2, confidence - 0.12),
		likelyFiles.slice(0, 5),
		likelySymbols.slice(0, 5),
		command,
		signal,
		'Secondary hypothesis explores a distinct failure family to disambiguate root cause.'
	);

	const environmentFallback = buildHypothesis(
		`hyp-${classification}-3`,
		classification,
		'environment',
		Math.max(0.15, confidence - 0.2),
		likelyFiles.slice(0, 3),
		likelySymbols.slice(0, 3),
		command,
		signal,
		'Fallback hypothesis validates environment/tooling causes when code-local probes are inconclusive.'
	);

	return [primary, alternate, environmentFallback];
}

export class FailureTriageEngine {
	analyzeFailure(signal: FailureSignal): TriageResult {
		const combinedSignal = `${signal.stderr || ''}\n${signal.stdout || ''}`.trim();
		const excerpt = combinedSignal.slice(0, 1200);
		const { classification, confidence } = classifyFailure(combinedSignal);
		const probableFiles = extractProbableFiles(
			combinedSignal,
			classification,
			signal.context_fallback_files || []
		);
		const probableSymbols = extractProbableSymbols(combinedSignal);
		const hypotheses = buildHypotheses(
			classification,
			signal.command,
			combinedSignal,
			confidence,
			probableFiles,
			probableSymbols
		);

		const ranked = hypotheses
			.map((hypothesis) => ({
				hypothesis_id: hypothesis.id,
				score: scoreHypothesis(hypothesis, classification, confidence),
			}))
			.sort((a, b) => b.score - a.score);
		const sortedHypotheses = ranked
			.map((rank) => hypotheses.find((hypothesis) => hypothesis.id === rank.hypothesis_id)!)
			.filter(Boolean);
		const beamWidth = Math.min(BEAM_WIDTH, sortedHypotheses.length);

		return {
			classification,
			confidence,
			probable_files: probableFiles,
			probable_symbols: probableSymbols,
			hypotheses: sortedHypotheses,
			beam_width: beamWidth,
			selected_hypothesis_id: ranked[0]?.hypothesis_id,
			ranking: ranked,
			raw_signal_excerpt: excerpt,
		};
	}
}
