import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import path from 'path';
import ts from 'typescript';
import type {
	ApplyPlanInput,
	ApplyResult,
	PlausibilityValidationError,
	SyntaxValidationError,
} from './types';

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const MERGE_CONFLICT_MARKER_PATTERN = /^(<{7}|={7}|>{7})/m;
const PLACEHOLDER_PATTERN = /\b(?:TODO|FIXME|XXX)\b|throw new Error\((['"`])TODO\1\)/gim;

function normalize(filePath: string, repoRoot: string): string {
	const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
	return path.normalize(absolutePath);
}

function validateSyntax(filePath: string, content: string): SyntaxValidationError[] {
	if (!TS_JS_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
		return [];
	}

	const result = ts.transpileModule(content, {
		fileName: filePath,
		reportDiagnostics: true,
		compilerOptions: {
			allowJs: true,
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			jsx: ts.JsxEmit.ReactJSX,
		},
	});

	return (result.diagnostics || [])
		.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
		.map((diagnostic) => ({
			file_path: filePath,
			message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
		}));
}

interface ParsedTsConfig {
	fileNames: string[];
	options: ts.CompilerOptions;
}

function parseTsConfig(repoRoot: string): ParsedTsConfig | null {
	const tsconfigPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.json');
	if (!tsconfigPath) return null;
	const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (configFile.error) return null;
	const parsedConfig = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		path.dirname(tsconfigPath)
	);
	return {
		fileNames: parsedConfig.fileNames,
		options: parsedConfig.options,
	};
}

function buildSemanticCompilerOptions(
	repoRoot: string,
	options: ts.CompilerOptions
): ts.CompilerOptions {
	const localTypeRoots = [
		path.join(repoRoot, 'node_modules', '@types'),
		path.join(repoRoot, '@types'),
	].filter((candidate) => existsSync(candidate));

	// Keep semantic validation scoped to the target repo so temp or sandbox repos do not
	// inherit ambient @types packages from Maestro's own workspace.
	if (!options.typeRoots && !options.types && localTypeRoots.length === 0) {
		return {
			...options,
			noEmit: true,
			skipLibCheck: true,
			types: [],
		};
	}

	if (!options.typeRoots && !options.types && localTypeRoots.length > 0) {
		return {
			...options,
			noEmit: true,
			skipLibCheck: true,
			typeRoots: localTypeRoots,
		};
	}

	return {
		...options,
		noEmit: true,
		skipLibCheck: true,
	};
}

function collectSemanticDiagnostics(repoRoot: string): SyntaxValidationError[] {
	const parsedConfig = parseTsConfig(repoRoot);
	if (!parsedConfig || parsedConfig.fileNames.length === 0) return [];
	const program = ts.createProgram(
		parsedConfig.fileNames,
		buildSemanticCompilerOptions(repoRoot, parsedConfig.options)
	);
	const diagnostics = ts
		.getPreEmitDiagnostics(program)
		.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
	return diagnostics
		.map((diagnostic) => {
			const fileName = diagnostic.file?.fileName;
			if (!fileName) return null;
			return {
				file_path: path.normalize(fileName),
				message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
			};
		})
		.filter((entry): entry is SyntaxValidationError => Boolean(entry));
}

function diagnosticFingerprint(diagnostic: SyntaxValidationError): string {
	return `${diagnostic.file_path}|${diagnostic.message}`;
}

function countMatches(value: string, pattern: RegExp): number {
	const globalPattern = new RegExp(
		pattern.source,
		pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
	);
	let matches = 0;
	while (globalPattern.exec(value)) {
		matches += 1;
	}
	return matches;
}

function validatePlausibility(input: {
	filePath: string;
	reason: string;
	previousContent: string | null;
	nextContent: string;
}): PlausibilityValidationError[] {
	const findings: PlausibilityValidationError[] = [];
	if (MERGE_CONFLICT_MARKER_PATTERN.test(input.nextContent)) {
		findings.push({
			file_path: input.filePath,
			code: 'merge_conflict_markers',
			message: 'Patch introduces unresolved merge-conflict markers.',
		});
	}

	const previousPlaceholders = countMatches(input.previousContent || '', PLACEHOLDER_PATTERN);
	const nextPlaceholders = countMatches(input.nextContent, PLACEHOLDER_PATTERN);
	if (nextPlaceholders > previousPlaceholders) {
		findings.push({
			file_path: input.filePath,
			code: 'new_placeholder_markers',
			message: 'Patch introduces new TODO/FIXME placeholder markers.',
		});
	}

	const previousNonEmpty = (input.previousContent || '').trim().length > 0;
	const nextEmpty = input.nextContent.trim().length === 0;
	const explicitTruncate = /\b(remove|delete|truncate|empty|stub)\b/i.test(input.reason);
	if (previousNonEmpty && nextEmpty && !explicitTruncate) {
		findings.push({
			file_path: input.filePath,
			code: 'empty_file_rewrite',
			message: 'Patch rewrites a non-empty file to empty content without explicit truncate intent.',
		});
	}

	return findings;
}

export class EditApplier {
	async applyPlan(input: ApplyPlanInput): Promise<ApplyResult> {
		if (!input.edit_plan.valid) {
			return {
				applied: false,
				applied_files: [],
				skipped_files: [],
				blocked_reasons: [...input.edit_plan.blocked_reasons],
				syntax_errors: [],
				plausibility_errors: [],
			};
		}

		if (!input.patches || input.patches.length === 0) {
			return {
				applied: false,
				applied_files: [],
				skipped_files: [],
				blocked_reasons: ['no_patches_provided'],
				syntax_errors: [],
				plausibility_errors: [],
			};
		}

		const allowedFilePlans = new Map(
			input.edit_plan.file_plans
				.filter((filePlan) => !filePlan.blocked)
				.map((filePlan) => [normalize(filePlan.file_path, input.task.repo_root), filePlan])
		);
		const allowUnrelated =
			input.allow_unrelated_files === true ||
			input.task.metadata?.allow_unrelated_file_edits === true;
		const blockedReasons: string[] = [];
		const syntaxErrors: SyntaxValidationError[] = [];
		const plausibilityErrors: PlausibilityValidationError[] = [];
		const normalizedPatchPaths = new Set<string>();
		const existingContentByPath = new Map<string, string | null>();

		for (const patch of input.patches) {
			const normalizedPath = normalize(patch.file_path, input.task.repo_root);
			normalizedPatchPaths.add(normalizedPath);

			if (!patch.reason?.trim()) {
				blockedReasons.push('missing_change_reason');
			}

			const filePlan = allowedFilePlans.get(normalizedPath);
			if (!filePlan) {
				blockedReasons.push('patch_not_in_edit_plan');
				continue;
			}
			if (!filePlan.related && !allowUnrelated) {
				blockedReasons.push('unrelated_file');
			}

			syntaxErrors.push(...validateSyntax(normalizedPath, patch.content));
			let existingContent: string | null = null;
			try {
				existingContent = await fs.readFile(normalizedPath, 'utf8');
			} catch (error) {
				const fileError = error as NodeJS.ErrnoException;
				if (fileError.code !== 'ENOENT') {
					throw error;
				}
			}
			existingContentByPath.set(normalizedPath, existingContent);
			plausibilityErrors.push(
				...validatePlausibility({
					filePath: normalizedPath,
					reason: patch.reason || '',
					previousContent: existingContent,
					nextContent: patch.content,
				})
			);
		}

		if (normalizedPatchPaths.size > input.task.max_changed_files) {
			blockedReasons.push('changed_file_budget_exceeded');
		}
		if (syntaxErrors.length > 0) {
			blockedReasons.push('syntax_validation_failed');
		}
		if (plausibilityErrors.length > 0) {
			blockedReasons.push('plausibility_validation_failed');
		}

		const uniqueBlockedReasons = [...new Set(blockedReasons)];
		if (uniqueBlockedReasons.length > 0) {
			return {
				applied: false,
				applied_files: [],
				skipped_files: [],
				blocked_reasons: uniqueBlockedReasons,
				syntax_errors: syntaxErrors,
				plausibility_errors: plausibilityErrors,
			};
		}

		const shouldRunSemanticValidation =
			input.task.language_profile === 'ts_js' &&
			input.task.metadata?.disable_semantic_validation !== true &&
			[...normalizedPatchPaths].some((filePath) =>
				TS_JS_EXTENSIONS.has(path.extname(filePath).toLowerCase())
			);
		const baselineSemanticDiagnostics = shouldRunSemanticValidation
			? collectSemanticDiagnostics(input.task.repo_root)
			: [];
		const baselineSemanticFingerprints = new Set(
			baselineSemanticDiagnostics.map(diagnosticFingerprint)
		);

		const appliedFiles: string[] = [];
		const skippedFiles: string[] = [];
		for (const patch of input.patches) {
			const normalizedPath = normalize(patch.file_path, input.task.repo_root);
			const existingContent =
				existingContentByPath.get(normalizedPath) === undefined
					? null
					: existingContentByPath.get(normalizedPath)!;

			// Keep file changes minimal by avoiding rewrites when content is unchanged.
			if (existingContent === patch.content) {
				skippedFiles.push(normalizedPath);
				continue;
			}

			await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
			await fs.writeFile(normalizedPath, patch.content, 'utf8');
			appliedFiles.push(normalizedPath);
		}

		if (shouldRunSemanticValidation) {
			const nextSemanticDiagnostics = collectSemanticDiagnostics(input.task.repo_root);
			const introducedDiagnostics = nextSemanticDiagnostics.filter(
				(diagnostic) => !baselineSemanticFingerprints.has(diagnosticFingerprint(diagnostic))
			);
			if (introducedDiagnostics.length > 0) {
				for (const normalizedPath of normalizedPatchPaths) {
					const previousContent = existingContentByPath.get(normalizedPath);
					if (typeof previousContent === 'string') {
						await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
						await fs.writeFile(normalizedPath, previousContent, 'utf8');
					} else {
						await fs.rm(normalizedPath, { force: true });
					}
				}
				return {
					applied: false,
					applied_files: [],
					skipped_files: [],
					blocked_reasons: ['semantic_validation_failed'],
					syntax_errors: introducedDiagnostics,
					plausibility_errors: [],
				};
			}
		}

		return {
			applied: true,
			applied_files: appliedFiles,
			skipped_files: skippedFiles,
			blocked_reasons: [],
			syntax_errors: [],
			plausibility_errors: [],
		};
	}
}
