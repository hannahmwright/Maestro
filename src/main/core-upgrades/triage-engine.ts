import crypto from 'crypto';
import type { FailureClassification, FailureSignal, FixHypothesis, TriageResult } from './types';

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

function buildTargetedCommands(
	classification: FailureClassification,
	likelyFiles: string[]
): string[] {
	const commands: string[] = [];
	const normalizedFiles = likelyFiles.map((filePath) => filePath.replace(/\\/g, '/'));
	const testFile = normalizedFiles.find((filePath) => TEST_FILE_REGEX.test(filePath));
	const sourceFile = normalizedFiles.find((filePath) => !TEST_FILE_REGEX.test(filePath));
	const packageScope = normalizedFiles
		.map((filePath) => filePath.match(PACKAGE_SEGMENT_REGEX)?.[2])
		.find((scope): scope is string => Boolean(scope));

	if (classification === 'lint_error') {
		if (sourceFile) {
			commands.push(`npm run lint -- ${sourceFile}`);
		}
		if (packageScope) {
			commands.push(`npm run lint -- ${packageScope}`);
		}
		return commands;
	}

	if (testFile) {
		commands.push(`npm test -- ${testFile}`);
	}
	if (
		sourceFile &&
		classification !== 'command_not_found' &&
		classification !== 'permission_error'
	) {
		commands.push(`npm test -- ${sourceFile}`);
	}
	if (packageScope) {
		commands.push(`npm test -- ${packageScope}`);
	}

	return commands;
}

function uniqueCommands(commands: string[]): string[] {
	return [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
}

function buildHypotheses(
	classification: FailureClassification,
	command: string,
	confidence: number,
	likelyFiles: string[],
	likelySymbols: string[]
): FixHypothesis[] {
	const baseCommand = classification === 'lint_error' ? 'npm run lint' : 'npm test -- --runInBand';
	const targetedCommands = buildTargetedCommands(classification, likelyFiles);
	const primary: FixHypothesis = {
		id: `hyp-${classification}-1`,
		classification,
		title: `Address ${classification.replace(/_/g, ' ')}`,
		rationale: `Primary hypothesis inferred from failure signature (${classification}).`,
		confidence,
		likely_files: likelyFiles,
		likely_symbols: likelySymbols,
		suggested_commands: uniqueCommands([...targetedCommands, baseCommand]),
		metadata_hash: buildMetadataHash(classification, command, likelyFiles, likelySymbols),
	};

	const fallback: FixHypothesis = {
		id: `hyp-${classification}-2`,
		classification,
		title: 'Validate failing scope and dependencies',
		rationale: 'Fallback hypothesis when file-local fix is insufficient.',
		confidence: Math.max(0.25, confidence - 0.2),
		likely_files: likelyFiles.slice(0, 3),
		likely_symbols: likelySymbols.slice(0, 3),
		suggested_commands: uniqueCommands([targetedCommands[0] || '', 'npm test', 'npm run build']),
		metadata_hash: buildMetadataHash(
			classification,
			command,
			likelyFiles.slice(0, 3),
			likelySymbols.slice(0, 3)
		),
	};

	return [primary, fallback];
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
			confidence,
			probableFiles,
			probableSymbols
		);

		return {
			classification,
			confidence,
			probable_files: probableFiles,
			probable_symbols: probableSymbols,
			hypotheses,
			raw_signal_excerpt: excerpt,
		};
	}
}
