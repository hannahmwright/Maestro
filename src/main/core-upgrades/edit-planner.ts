import path from 'path';
import type { EditPlan, EditPlanInput, EditPlanFile, TaskContract } from './types';

const WILDCARD_PATTERN = /[*?{}\[\]]/;

function normalize(inputPath: string, repoRoot: string): string {
	const absolutePath = path.isAbsolute(inputPath) ? inputPath : path.resolve(repoRoot, inputPath);
	return path.normalize(absolutePath);
}

function isUnrelatedEditAllowed(task: TaskContract, normalizedPath: string): boolean {
	const allowUnrelated = task.metadata?.allow_unrelated_file_edits;
	if (allowUnrelated === true) return true;
	if (Array.isArray(allowUnrelated)) {
		return allowUnrelated.some((allowedPath) => {
			if (typeof allowedPath !== 'string' || !allowedPath.trim()) return false;
			return normalize(allowedPath, task.repo_root) === normalizedPath;
		});
	}
	return false;
}

export class EditPlanner {
	planEdits(input: EditPlanInput): EditPlan {
		const relatedSet = new Set(
			(input.related_files || []).map((filePath) => normalize(filePath, input.task.repo_root))
		);

		const filePlans: EditPlanFile[] = input.proposed_edits.map((edit) => {
			const normalizedPath = normalize(edit.file_path, input.task.repo_root);
			const blockedReasons: string[] = [];
			const reason = edit.reason?.trim() || '';

			if (WILDCARD_PATTERN.test(edit.file_path)) {
				blockedReasons.push('wildcard_paths_not_allowed');
			}
			if (!normalizedPath.startsWith(path.normalize(input.task.repo_root))) {
				blockedReasons.push('path_outside_repo_root');
			}
			if (!reason) {
				blockedReasons.push('missing_change_reason');
			}

			const related = relatedSet.size === 0 || relatedSet.has(normalizedPath);
			if (!related && !isUnrelatedEditAllowed(input.task, normalizedPath)) {
				blockedReasons.push('unrelated_file');
			}

			return {
				file_path: normalizedPath,
				reason,
				related,
				blocked: blockedReasons.length > 0,
				block_reason: blockedReasons.join(','),
			};
		});

		const blockedReasons: string[] = [];
		const uniqueRequested = new Set(filePlans.map((plan) => plan.file_path));

		if (uniqueRequested.size > input.task.max_changed_files) {
			blockedReasons.push('changed_file_budget_exceeded');
		}
		if (filePlans.some((plan) => plan.blocked)) {
			blockedReasons.push('contains_blocked_file_changes');
		}

		return {
			valid: blockedReasons.length === 0,
			blocked: blockedReasons.length > 0,
			blocked_reasons: blockedReasons,
			file_plans: filePlans,
			changed_file_budget: input.task.max_changed_files,
			requested_file_count: uniqueRequested.size,
		};
	}
}
