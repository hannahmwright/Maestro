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

function extractProbableFiles(signal: string): string[] {
	const files = new Set<string>();
	let match: RegExpExecArray | null;
	while ((match = FILE_PATH_REGEX.exec(signal))) {
		const filePath = match[1];
		if (filePath && !filePath.includes('node_modules')) {
			files.add(filePath.replace(/\\/g, '/'));
		}
	}
	return [...files].slice(0, 8);
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
	files: string[],
	symbols: string[]
): string {
	return crypto
		.createHash('sha1')
		.update(
			JSON.stringify({ classification, files: files.slice(0, 5), symbols: symbols.slice(0, 5) })
		)
		.digest('hex');
}

function buildHypotheses(
	classification: FailureClassification,
	confidence: number,
	likelyFiles: string[],
	likelySymbols: string[]
): FixHypothesis[] {
	const baseCommand = classification === 'lint_error' ? 'npm run lint' : 'npm test -- --runInBand';
	const primary: FixHypothesis = {
		id: `hyp-${classification}-1`,
		classification,
		title: `Address ${classification.replace(/_/g, ' ')}`,
		rationale: `Primary hypothesis inferred from failure signature (${classification}).`,
		confidence,
		likely_files: likelyFiles,
		likely_symbols: likelySymbols,
		suggested_commands: [baseCommand],
		metadata_hash: buildMetadataHash(classification, likelyFiles, likelySymbols),
	};

	const fallback: FixHypothesis = {
		id: `hyp-${classification}-2`,
		classification,
		title: 'Validate failing scope and dependencies',
		rationale: 'Fallback hypothesis when file-local fix is insufficient.',
		confidence: Math.max(0.25, confidence - 0.2),
		likely_files: likelyFiles.slice(0, 3),
		likely_symbols: likelySymbols.slice(0, 3),
		suggested_commands: ['npm test', 'npm run build'],
		metadata_hash: buildMetadataHash(
			classification,
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
		const probableFiles = extractProbableFiles(combinedSignal);
		const probableSymbols = extractProbableSymbols(combinedSignal);
		const hypotheses = buildHypotheses(classification, confidence, probableFiles, probableSymbols);

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
