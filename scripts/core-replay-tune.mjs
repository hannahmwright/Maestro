#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.resolve(root, 'src/__tests__/fixtures/core-upgrades/replay');
const modulePath = path.resolve(root, 'dist/main/core-upgrades/index.js');
const weightProfilePath = path.resolve(root, '.maestro/core-upgrades/loop-weights.json');
const writeProfile = !process.argv.includes('--no-write-profile');

const CANDIDATE_WEIGHTS = [
	{
		MAESTRO_LOOP_WEIGHT_PROBE_GAIN: '0.55',
		MAESTRO_LOOP_WEIGHT_PROBE_EVIDENCE: '0.55',
		MAESTRO_LOOP_WEIGHT_CONTEXT: '0.25',
		MAESTRO_LOOP_WEIGHT_GRAPH: '0.35',
		MAESTRO_LOOP_WEIGHT_COMMAND_FEASIBLE: '1.0',
		MAESTRO_LOOP_WEIGHT_GRAPH_PENALTY: '1.0',
		MAESTRO_LOOP_WEIGHT_PROBE_PASS_BONUS: '1.0',
	},
	{
		MAESTRO_LOOP_WEIGHT_PROBE_GAIN: '0.65',
		MAESTRO_LOOP_WEIGHT_PROBE_EVIDENCE: '0.45',
		MAESTRO_LOOP_WEIGHT_CONTEXT: '0.2',
		MAESTRO_LOOP_WEIGHT_GRAPH: '0.4',
		MAESTRO_LOOP_WEIGHT_COMMAND_FEASIBLE: '1.1',
		MAESTRO_LOOP_WEIGHT_GRAPH_PENALTY: '1.1',
		MAESTRO_LOOP_WEIGHT_PROBE_PASS_BONUS: '1.0',
	},
	{
		MAESTRO_LOOP_WEIGHT_PROBE_GAIN: '0.5',
		MAESTRO_LOOP_WEIGHT_PROBE_EVIDENCE: '0.6',
		MAESTRO_LOOP_WEIGHT_CONTEXT: '0.3',
		MAESTRO_LOOP_WEIGHT_GRAPH: '0.3',
		MAESTRO_LOOP_WEIGHT_COMMAND_FEASIBLE: '1.0',
		MAESTRO_LOOP_WEIGHT_GRAPH_PENALTY: '1.2',
		MAESTRO_LOOP_WEIGHT_PROBE_PASS_BONUS: '1.1',
	},
	{
		MAESTRO_LOOP_WEIGHT_PROBE_GAIN: '0.6',
		MAESTRO_LOOP_WEIGHT_PROBE_EVIDENCE: '0.5',
		MAESTRO_LOOP_WEIGHT_CONTEXT: '0.22',
		MAESTRO_LOOP_WEIGHT_GRAPH: '0.42',
		MAESTRO_LOOP_WEIGHT_COMMAND_FEASIBLE: '1.05',
		MAESTRO_LOOP_WEIGHT_GRAPH_PENALTY: '1.2',
		MAESTRO_LOOP_WEIGHT_PROBE_PASS_BONUS: '1.0',
	},
];

async function loadFixtures() {
	const names = (await fs.readdir(fixturesDir))
		.filter((name) => name.endsWith('.json') && name !== 'baseline.json')
		.sort();
	const fixtures = [];
	for (const name of names) {
		const raw = await fs.readFile(path.join(fixturesDir, name), 'utf8');
		fixtures.push(JSON.parse(raw));
	}
	return fixtures;
}

function scoreSummary(summary) {
	const fixtureCount = Math.max(1, summary.results.length);
	const passRate = summary.passed / fixtureCount;
	return (
		passRate * 3 +
		summary.metrics.first_attempt_solve_rate * 2 -
		summary.metrics.average_attempt_count * 0.6 -
		summary.metrics.non_progressing_failure_rate
	);
}

function toWeightProfile(envWeights) {
	return {
		probe_gain: Number(envWeights.MAESTRO_LOOP_WEIGHT_PROBE_GAIN),
		probe_evidence_delta: Number(envWeights.MAESTRO_LOOP_WEIGHT_PROBE_EVIDENCE),
		context_coverage: Number(envWeights.MAESTRO_LOOP_WEIGHT_CONTEXT),
		graph_coverage: Number(envWeights.MAESTRO_LOOP_WEIGHT_GRAPH),
		command_feasibility: Number(envWeights.MAESTRO_LOOP_WEIGHT_COMMAND_FEASIBLE),
		graph_penalty: Number(envWeights.MAESTRO_LOOP_WEIGHT_GRAPH_PENALTY),
		probe_pass_bonus: Number(envWeights.MAESTRO_LOOP_WEIGHT_PROBE_PASS_BONUS),
	};
}

async function main() {
	const mod = await import(pathToFileURL(modulePath).href);
	const fixtures = await loadFixtures();
	const originalEnv = new Map();
	for (const key of Object.keys(CANDIDATE_WEIGHTS[0])) {
		originalEnv.set(key, process.env[key]);
	}

	const ranked = [];
	for (const weights of CANDIDATE_WEIGHTS) {
		for (const [key, value] of Object.entries(weights)) {
			process.env[key] = value;
		}
		const summary = await mod.runReplaySuite(fixtures);
		ranked.push({
			weights,
			score: scoreSummary(summary),
			summary,
		});
	}

	for (const [key, value] of originalEnv.entries()) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}

	ranked.sort((a, b) => b.score - a.score);
	const best = ranked[0];

	console.log('Replay tuning complete.');
	console.log(`Fixtures: ${fixtures.length}`);
	console.log(`Best score: ${best.score.toFixed(4)}`);
	console.log(`Best weights: ${JSON.stringify(best.weights)}`);
	console.log(
		`Best metrics: pass=${best.summary.passed}/${fixtures.length}, first_attempt_solve_rate=${best.summary.metrics.first_attempt_solve_rate.toFixed(3)}, average_attempt_count=${best.summary.metrics.average_attempt_count.toFixed(3)}, non_progressing_failure_rate=${best.summary.metrics.non_progressing_failure_rate.toFixed(3)}`
	);
	if (writeProfile) {
		const profile = {
			...toWeightProfile(best.weights),
			generated_at: new Date().toISOString(),
			fixture_count: fixtures.length,
			source: 'replay-tune',
		};
		await fs.mkdir(path.dirname(weightProfilePath), { recursive: true });
		await fs.writeFile(weightProfilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
		console.log(`Saved weight profile: ${weightProfilePath}`);
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
