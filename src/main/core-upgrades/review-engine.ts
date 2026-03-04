import crypto from 'crypto';
import path from 'path';
import type { ReviewFinding, ReviewInput } from './types';

function createFinding(input: Omit<ReviewFinding, 'id'>): ReviewFinding {
	return {
		id: crypto
			.createHash('sha1')
			.update(`${input.severity}:${input.message}`)
			.digest('hex')
			.slice(0, 12),
		...input,
	};
}

function includesTestFile(changedFiles: string[]): boolean {
	return changedFiles.some(
		(filePath) =>
			/(^|\/)(__tests__|test|tests)\//.test(filePath) || /\.(test|spec)\.[jt]sx?$/.test(filePath)
	);
}

function inferSurface(filePath: string): string {
	const normalized = filePath.replace(/\\/g, '/');
	if (normalized.includes('/renderer/')) return 'renderer';
	if (normalized.includes('/main/')) return 'main-process';
	if (normalized.includes('/web/')) return 'web';
	return path.basename(filePath);
}

export class ReviewRigorEngine {
	analyzePatch(input: ReviewInput): ReviewFinding[] {
		const findings: ReviewFinding[] = [];
		const normalizedFiles = input.changed_files.map((filePath) => filePath.replace(/\\/g, '/'));
		const hasTests = includesTestFile(normalizedFiles);
		const affectedSurfaces = [...new Set(normalizedFiles.map(inferSurface))];

		if (normalizedFiles.length > input.task.max_changed_files) {
			findings.push(
				createFinding({
					severity: 'high',
					confidence: 0.9,
					regression_risk: 'high',
					message: `Patch exceeds changed-file budget (${normalizedFiles.length}/${input.task.max_changed_files}).`,
					missing_tests: false,
					affected_surfaces: affectedSurfaces,
					blocking: true,
				})
			);
		}

		if (!hasTests && (input.task.risk_level === 'high' || normalizedFiles.length > 3)) {
			findings.push(
				createFinding({
					severity: 'high',
					confidence: 0.82,
					regression_risk: 'high',
					message: 'High-risk patch has no corresponding test changes.',
					missing_tests: true,
					affected_surfaces: affectedSurfaces,
					blocking: true,
				})
			);
		}

		if (input.diff_text) {
			if (/\+.*\b(TODO|FIXME|HACK)\b/i.test(input.diff_text)) {
				findings.push(
					createFinding({
						severity: 'medium',
						confidence: 0.7,
						regression_risk: 'medium',
						message: 'Patch introduces TODO/FIXME/HACK markers that can hide incomplete work.',
						missing_tests: false,
						affected_surfaces: affectedSurfaces,
						blocking: false,
					})
				);
			}

			if (/\+.*\bany\b/.test(input.diff_text)) {
				findings.push(
					createFinding({
						severity: 'low',
						confidence: 0.64,
						regression_risk: 'low',
						message: 'Patch adds `any`-typed values; verify type safety is still acceptable.',
						missing_tests: false,
						affected_surfaces: affectedSurfaces,
						blocking: false,
					})
				);
			}
		}

		return findings;
	}
}
