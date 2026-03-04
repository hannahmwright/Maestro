import * as fs from 'fs/promises';
import path from 'path';
import ts from 'typescript';
import type { ApplyPlanInput, ApplyResult, SyntaxValidationError } from './types';

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

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

export class EditApplier {
	async applyPlan(input: ApplyPlanInput): Promise<ApplyResult> {
		if (!input.edit_plan.valid) {
			return {
				applied: false,
				applied_files: [],
				skipped_files: [],
				blocked_reasons: [...input.edit_plan.blocked_reasons],
				syntax_errors: [],
			};
		}

		if (!input.patches || input.patches.length === 0) {
			return {
				applied: false,
				applied_files: [],
				skipped_files: [],
				blocked_reasons: ['no_patches_provided'],
				syntax_errors: [],
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
		const normalizedPatchPaths = new Set<string>();

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
		}

		if (normalizedPatchPaths.size > input.task.max_changed_files) {
			blockedReasons.push('changed_file_budget_exceeded');
		}
		if (syntaxErrors.length > 0) {
			blockedReasons.push('syntax_validation_failed');
		}

		const uniqueBlockedReasons = [...new Set(blockedReasons)];
		if (uniqueBlockedReasons.length > 0) {
			return {
				applied: false,
				applied_files: [],
				skipped_files: [],
				blocked_reasons: uniqueBlockedReasons,
				syntax_errors: syntaxErrors,
			};
		}

		const appliedFiles: string[] = [];
		const skippedFiles: string[] = [];
		for (const patch of input.patches) {
			const normalizedPath = normalize(patch.file_path, input.task.repo_root);
			let existingContent: string | null = null;
			try {
				existingContent = await fs.readFile(normalizedPath, 'utf8');
			} catch (error) {
				const fileError = error as NodeJS.ErrnoException;
				if (fileError.code !== 'ENOENT') {
					throw error;
				}
			}

			// Keep file changes minimal by avoiding rewrites when content is unchanged.
			if (existingContent === patch.content) {
				skippedFiles.push(normalizedPath);
				continue;
			}

			await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
			await fs.writeFile(normalizedPath, patch.content, 'utf8');
			appliedFiles.push(normalizedPath);
		}

		return {
			applied: true,
			applied_files: appliedFiles,
			skipped_files: skippedFiles,
			blocked_reasons: [],
			syntax_errors: [],
		};
	}
}
