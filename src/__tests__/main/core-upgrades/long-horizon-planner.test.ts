import { describe, expect, it } from 'vitest';
import { LongHorizonPlanner } from '../../../main/core-upgrades';
import type {
	FixHypothesis,
	FixHypothesisFamily,
	LoopExecutionMemory,
	LoopGraphQueryResult,
} from '../../../main/core-upgrades/types';

function buildHypothesis(id: string, family: FixHypothesisFamily, files: string[]): FixHypothesis {
	return {
		id,
		classification: 'test_failure',
		family,
		title: `Hypothesis ${id}`,
		rationale: 'test',
		confidence: 0.7,
		likely_files: files,
		likely_symbols: [],
		evidence: {
			confirming_signals: ['signal'],
			disconfirming_signals: [],
			uncertainty_note: 'low',
			evidence_score: 0.65,
		},
		suggested_commands: ['npm test'],
		probe_candidates: [],
		metadata_hash: `${id}-hash`,
	};
}

const emptyMemory: LoopExecutionMemory = {
	family_attempts: {},
	command_attempts: {},
	selected_hypothesis_history: [],
	stagnation_count: 0,
	strategy_switch_count: 0,
	graph_query_count: 0,
	long_horizon_plan_count: 0,
	failure_fingerprints: {},
	module_area_memory: {},
};

describe('LongHorizonPlanner', () => {
	it('prioritizes bridge files and boosts underexplored families', () => {
		const planner = new LongHorizonPlanner();
		const graphQuery: LoopGraphQueryResult = {
			scores: [
				{ file_path: 'src/chain/c.ts', score: 0.92, distance: 2, impact_score: 2.4, fanout: 2 },
				{ file_path: 'src/chain/d.ts', score: 0.77, distance: 3, impact_score: 1.8, fanout: 1 },
			],
			coverage: 1,
			explored_nodes: 6,
		};

		const plan = planner.plan({
			attempt: 2,
			hypotheses: [
				buildHypothesis('h1', 'test_logic', ['src/chain/leaf.ts']),
				buildHypothesis('h2', 'typing', ['src/typing/types.ts']),
			],
			triageFiles: ['src/chain/a.ts'],
			contextFiles: ['src/chain/a.ts', 'src/chain/b.ts'],
			graphQuery,
			memory: {
				...emptyMemory,
				family_attempts: { test_logic: 2 },
			},
		});

		expect(plan.bridge_files).toContain('src/chain/c.ts');
		expect(plan.target_family_order[0]).toBe('typing');
		expect(plan.hypothesis_boosts.h2).toBeGreaterThan(plan.hypothesis_boosts.h1);
		expect(plan.checkpoints.length).toBeGreaterThan(0);
		expect(plan.checkpoints[0].target_files.length).toBeGreaterThan(0);
	});

	it('penalizes hypotheses selected repeatedly during stagnation', () => {
		const planner = new LongHorizonPlanner();
		const plan = planner.plan({
			attempt: 3,
			hypotheses: [
				buildHypothesis('repeat', 'runtime', ['src/runtime/a.ts']),
				buildHypothesis('fresh', 'dependency', ['src/runtime/b.ts']),
			],
			triageFiles: ['src/runtime/a.ts'],
			contextFiles: ['src/runtime/a.ts'],
			graphQuery: null,
			memory: {
				...emptyMemory,
				stagnation_count: 3,
				selected_hypothesis_history: ['repeat', 'repeat', 'repeat'],
			},
		});

		expect(plan.hypothesis_boosts.repeat).toBeLessThan(plan.hypothesis_boosts.fresh);
	});
});
