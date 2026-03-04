import { describe, expect, it, vi } from 'vitest';
import { ProbeEngine } from '../../../main/core-upgrades';
import type { DiagnosticProbe, FixHypothesis } from '../../../main/core-upgrades/types';

function buildHypothesis(
	id: string,
	probes: DiagnosticProbe[],
	overrides?: Partial<FixHypothesis>
): FixHypothesis {
	return {
		id,
		classification: 'test_failure',
		family: 'test_logic',
		title: `Hypothesis ${id}`,
		rationale: 'Probe candidate test',
		confidence: 0.7,
		likely_files: ['src/math.ts'],
		likely_symbols: ['add'],
		evidence: {
			confirming_signals: ['test'],
			disconfirming_signals: [],
			uncertainty_note: 'low',
			evidence_score: 0.7,
		},
		suggested_commands: ['npm test'],
		probe_candidates: probes,
		metadata_hash: `${id}-hash`,
		...overrides,
	};
}

function buildProbe(id: string, command: string): DiagnosticProbe {
	return {
		id,
		purpose: `probe-${id}`,
		command,
		target_files: ['src/math.ts'],
		timeout_ms: 20_000,
	};
}

describe('ProbeEngine', () => {
	it('skips disallowed probes without invoking command runner', async () => {
		const engine = new ProbeEngine();
		const runCommand = vi.fn().mockResolvedValue({
			exitCode: 0,
			stdout: 'PASS',
			stderr: '',
			durationMs: 14,
		});

		const result = await engine.execute(
			{
				hypotheses: [
					buildHypothesis('h1', [
						buildProbe('p-allowed', 'npm test -- src/math.test.ts'),
						buildProbe('p-blocked', 'npm run lint -- src/math.ts'),
					]),
				],
				probeBudget: 2,
				defaultTimeoutMs: 20_000,
			},
			{
				runCommand,
				isCommandAllowed: (command) => command.includes('npm test'),
			}
		);

		expect(runCommand).toHaveBeenCalledTimes(1);
		expect(result.entries).toHaveLength(2);
		const blocked = result.entries.find((entry) => entry.probe_id === 'p-blocked');
		expect(blocked?.result.skipped).toBe(true);
		expect(blocked?.result.skip_reason).toBe('command_not_allowed');
		expect(blocked?.result.exit_code).toBe(126);
	});

	it('reuses cached command results across hypotheses', async () => {
		const engine = new ProbeEngine();
		const runCommand = vi.fn().mockResolvedValue({
			exitCode: 1,
			stdout: '',
			stderr: 'Expected 3 received 2',
			durationMs: 18,
		});

		const sharedCommand = 'npm test -- src/math.test.ts';
		const result = await engine.execute(
			{
				hypotheses: [
					buildHypothesis('h1', [buildProbe('p1', sharedCommand)]),
					buildHypothesis('h2', [buildProbe('p2', sharedCommand)]),
				],
				probeBudget: 2,
				defaultTimeoutMs: 20_000,
				baselineSignal: 'FAIL src/math.test.ts',
			},
			{
				runCommand,
				isCommandAllowed: () => true,
			}
		);

		expect(runCommand).toHaveBeenCalledTimes(1);
		expect(result.entries).toHaveLength(2);
		expect(result.results_by_hypothesis.h1).toHaveLength(1);
		expect(result.results_by_hypothesis.h2).toHaveLength(1);
	});

	it('computes average information gain from non-skipped probes only', async () => {
		const engine = new ProbeEngine();
		const runCommand = vi
			.fn()
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'PASS src/math.test.ts',
				stderr: '',
				durationMs: 11,
			})
			.mockResolvedValueOnce({
				exitCode: 1,
				stdout: '',
				stderr: 'ReferenceError: foo is not defined',
				durationMs: 9,
			});

		const result = await engine.execute(
			{
				hypotheses: [
					buildHypothesis('h1', [
						buildProbe('p1', 'npm test -- src/math.test.ts'),
						buildProbe('p2', 'npm run build'),
						buildProbe('p3', 'npm run lint'),
					]),
				],
				probeBudget: 3,
				defaultTimeoutMs: 20_000,
				baselineSignal: 'FAIL src/math.test.ts\nExpected: 3\nReceived: 2',
			},
			{
				runCommand,
				isCommandAllowed: (command) => command !== 'npm run lint',
			}
		);

		expect(result.entries).toHaveLength(3);
		expect(result.average_information_gain).toBeGreaterThan(0);
		expect(result.average_information_gain).toBeLessThanOrEqual(1);
		const skippedCount = result.entries.filter((entry) => entry.result.skipped).length;
		expect(skippedCount).toBe(1);
	});
});
