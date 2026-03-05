#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.resolve(root, 'src/__tests__/fixtures/core-upgrades/replay');
const modulePath = path.resolve(root, 'dist/main/core-upgrades/index.js');
const baselinePath = path.resolve(fixturesDir, 'baseline.json');
const updateBaseline = process.argv.includes('--update-baseline');
const tolerance = Number(process.env.MAESTRO_REPLAY_GATE_TOLERANCE || '0.0001');
const minFixtures = Number(process.env.MAESTRO_REPLAY_MIN_FIXTURES || '8');

async function loadFixtures() {
	const names = (await fs.readdir(fixturesDir))
		.filter((name) => name.endsWith('.json') && name !== 'baseline.json')
		.sort();
	const fixtures = [];
	for (const name of names) {
		const raw = await fs.readFile(path.join(fixturesDir, name), 'utf8');
		fixtures.push({ name, fixture: JSON.parse(raw) });
	}
	return fixtures;
}

async function readBaseline() {
	try {
		const raw = await fs.readFile(baselinePath, 'utf8');
		return JSON.parse(raw);
	} catch (error) {
		const fileError = error;
		if (fileError && typeof fileError === 'object' && fileError.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

async function writeBaseline(payload) {
	await fs.writeFile(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function formatDelta(value) {
	const signed = value >= 0 ? `+${value.toFixed(4)}` : value.toFixed(4);
	return signed;
}

async function main() {
	const mod = await import(pathToFileURL(modulePath).href);
	const loaded = await loadFixtures();
	const fixtures = loaded.map((entry) => entry.fixture);
	if (fixtures.length === 0) {
		console.error('No replay fixtures found.');
		process.exitCode = 1;
		return;
	}
	if (fixtures.length < minFixtures) {
		console.error(`Replay fixtures ${fixtures.length} below minimum ${minFixtures}.`);
		process.exitCode = 1;
		return;
	}
	const hardCount = fixtures.filter(
		(fixture) =>
			fixture?.metadata?.difficulty === 'hard' || fixture?.metadata?.difficulty === 'extreme'
	).length;
	if (hardCount === 0) {
		console.error('Replay gate requires at least one hard/extreme fixture.');
		process.exitCode = 1;
		return;
	}

	const summary = await mod.runReplaySuite(fixtures);
	const current = {
		fixture_count: fixtures.length,
		failed: summary.failed,
		metrics: {
			first_attempt_solve_rate: summary.metrics.first_attempt_solve_rate,
			average_attempt_count: summary.metrics.average_attempt_count,
			non_progressing_failure_rate: summary.metrics.non_progressing_failure_rate,
		},
		generated_at: new Date().toISOString(),
	};

	const baseline = await readBaseline();
	if (!baseline || updateBaseline) {
		await writeBaseline(current);
		console.log('Replay baseline written.');
		console.log(`Fixtures: ${current.fixture_count}`);
		console.log(
			`Metrics: first_attempt_solve_rate=${current.metrics.first_attempt_solve_rate.toFixed(3)}, average_attempt_count=${current.metrics.average_attempt_count.toFixed(3)}, non_progressing_failure_rate=${current.metrics.non_progressing_failure_rate.toFixed(3)}`
		);
		return;
	}

	const failures = [];
	for (const entry of loaded) {
		if (!entry.fixture?.metadata?.difficulty || !Array.isArray(entry.fixture?.metadata?.tags)) {
			failures.push(`Fixture ${entry.name} missing required metadata.difficulty/tags.`);
		}
	}
	if (summary.failed > 0) {
		failures.push(`Replay suite has ${summary.failed} failing fixture(s).`);
	}
	if (current.fixture_count !== baseline.fixture_count) {
		failures.push(
			`Fixture count changed (baseline=${baseline.fixture_count}, current=${current.fixture_count}); refresh baseline if intentional.`
		);
	}

	const firstAttemptDelta =
		current.metrics.first_attempt_solve_rate - baseline.metrics.first_attempt_solve_rate;
	const avgAttemptDelta =
		current.metrics.average_attempt_count - baseline.metrics.average_attempt_count;
	const nonProgressDelta =
		current.metrics.non_progressing_failure_rate - baseline.metrics.non_progressing_failure_rate;

	if (firstAttemptDelta < -tolerance) {
		failures.push(
			`first_attempt_solve_rate regressed by ${Math.abs(firstAttemptDelta).toFixed(4)} (baseline=${baseline.metrics.first_attempt_solve_rate.toFixed(3)}, current=${current.metrics.first_attempt_solve_rate.toFixed(3)}).`
		);
	}
	if (avgAttemptDelta > tolerance) {
		failures.push(
			`average_attempt_count regressed by +${avgAttemptDelta.toFixed(4)} (baseline=${baseline.metrics.average_attempt_count.toFixed(3)}, current=${current.metrics.average_attempt_count.toFixed(3)}).`
		);
	}
	if (nonProgressDelta > tolerance) {
		failures.push(
			`non_progressing_failure_rate regressed by +${nonProgressDelta.toFixed(4)} (baseline=${baseline.metrics.non_progressing_failure_rate.toFixed(3)}, current=${current.metrics.non_progressing_failure_rate.toFixed(3)}).`
		);
	}

	console.log(`Replay fixtures: ${current.fixture_count}`);
	console.log(`Baseline generated: ${baseline.generated_at}`);
	console.log(`first_attempt_solve_rate delta: ${formatDelta(firstAttemptDelta)}`);
	console.log(`average_attempt_count delta: ${formatDelta(avgAttemptDelta)}`);
	console.log(`non_progressing_failure_rate delta: ${formatDelta(nonProgressDelta)}`);

	if (failures.length > 0) {
		for (const failure of failures) {
			console.error(`- ${failure}`);
		}
		process.exitCode = 1;
		return;
	}

	console.log('Replay gate passed.');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
