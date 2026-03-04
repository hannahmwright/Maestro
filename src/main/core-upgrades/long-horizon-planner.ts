import type {
	FixHypothesis,
	FixHypothesisFamily,
	LoopExecutionMemory,
	LoopGraphQueryResult,
} from './types';

export interface LongHorizonPlanInput {
	attempt: number;
	hypotheses: FixHypothesis[];
	triageFiles: string[];
	contextFiles: string[];
	graphQuery?: LoopGraphQueryResult | null;
	memory: LoopExecutionMemory;
}

export interface LongHorizonPlan {
	focus_files: string[];
	bridge_files: string[];
	target_family_order: FixHypothesisFamily[];
	hypothesis_boosts: Record<string, number>;
	checkpoints: Array<{
		id: string;
		title: string;
		target_files: string[];
		exit_criteria: string;
	}>;
}

function normalizedFilePath(filePath: string): string {
	return filePath.replace(/\\/g, '/');
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function uniqueFiles(values: string[]): string[] {
	return [...new Set(values.map((value) => normalizedFilePath(value)))];
}

export class LongHorizonPlanner {
	plan(input: LongHorizonPlanInput): LongHorizonPlan {
		const graphScores = input.graphQuery?.scores || [];
		const topGraphFiles = graphScores
			.slice(0, 8)
			.map((score) => normalizedFilePath(score.file_path));
		const focusFiles = uniqueFiles([...input.triageFiles, ...topGraphFiles]).slice(0, 8);

		const bridgeFiles = graphScores
			.filter((score) => (score.distance || 0) >= 2 && (score.distance || 0) <= 4)
			.slice(0, 4)
			.map((score) => normalizedFilePath(score.file_path));

		const familyAttempts = input.memory.family_attempts || {};
		const sortedFamilies = [
			...new Set(input.hypotheses.map((hypothesis) => hypothesis.family)),
		].sort((left, right) => (familyAttempts[left] || 0) - (familyAttempts[right] || 0));

		const recentHistory = new Set(input.memory.selected_hypothesis_history.slice(-4));
		const focusSet = new Set(focusFiles);
		const bridgeSet = new Set(bridgeFiles);
		const contextTail = uniqueFiles(input.contextFiles).slice(0, 4);
		const boosts: Record<string, number> = {};
		for (const hypothesis of input.hypotheses) {
			const attemptedFamilyCount = familyAttempts[hypothesis.family] || 0;
			const hasFocusOverlap = hypothesis.likely_files.some((filePath) =>
				focusSet.has(normalizedFilePath(filePath))
			);
			const hasBridgeOverlap = hypothesis.likely_files.some((filePath) =>
				bridgeSet.has(normalizedFilePath(filePath))
			);

			let boost = 0;
			if (attemptedFamilyCount === 0) boost += 0.08;
			else boost -= Math.min(0.15, attemptedFamilyCount * 0.04);
			if (hasFocusOverlap) boost += 0.1;
			if (hasBridgeOverlap) boost += 0.06;
			if (recentHistory.has(hypothesis.id)) boost -= 0.12;
			if (input.memory.stagnation_count >= 2 && attemptedFamilyCount === 0) {
				boost += 0.07;
			}
			boosts[hypothesis.id] = clamp(boost, -0.2, 0.25);
		}

		const checkpoints: LongHorizonPlan['checkpoints'] = [];
		if (focusFiles.length > 0) {
			checkpoints.push({
				id: `attempt-${input.attempt}-focus`,
				title: 'Validate Core Focus Files',
				target_files: focusFiles.slice(0, 4),
				exit_criteria:
					'At least one targeted command succeeds with the selected hypothesis focused on these files.',
			});
		}
		if (bridgeFiles.length > 0) {
			checkpoints.push({
				id: `attempt-${input.attempt}-bridge`,
				title: 'Traverse Bridge Chain',
				target_files: bridgeFiles.slice(0, 3),
				exit_criteria: 'Probe or targeted check reduces uncertainty on one transitive bridge file.',
			});
		}
		if (sortedFamilies.length > 0) {
			checkpoints.push({
				id: `attempt-${input.attempt}-family`,
				title: `Explore ${sortedFamilies[0]} Family`,
				target_files: contextTail,
				exit_criteria:
					'Next hypothesis selection includes this family if prior family remained low-gain.',
			});
		}

		return {
			focus_files: focusFiles,
			bridge_files: bridgeFiles,
			target_family_order: sortedFamilies,
			hypothesis_boosts: boosts,
			checkpoints: checkpoints.slice(0, 3),
		};
	}
}
