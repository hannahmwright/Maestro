#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const fixturesDir = path.resolve(root, 'src/__tests__/fixtures/core-upgrades/replay');
const modulePath = path.resolve(root, 'dist/main/core-upgrades/index.js');

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

async function main() {
	const mod = await import(pathToFileURL(modulePath).href);
	const fixtures = await loadFixtures();
	const summary = await mod.runReplaySuite(fixtures);
	const difficultyCounts = fixtures.reduce(
		(counts, fixture) => {
			const difficulty = fixture?.metadata?.difficulty;
			if (difficulty && counts[difficulty] !== undefined) counts[difficulty] += 1;
			return counts;
		},
		{ easy: 0, medium: 0, hard: 0, extreme: 0 }
	);
	const wantsJson = process.argv.includes('--json');

	if (wantsJson) {
		console.log(
			JSON.stringify(
				{
					...summary,
					fixture_distribution: difficultyCounts,
				},
				null,
				2
			)
		);
	} else {
		console.log(`Replay fixtures: ${fixtures.length}`);
		console.log(
			`Fixture distribution: easy=${difficultyCounts.easy}, medium=${difficultyCounts.medium}, hard=${difficultyCounts.hard}, extreme=${difficultyCounts.extreme}`
		);
		console.log(`Passed: ${summary.passed}`);
		console.log(`Failed: ${summary.failed}`);
		console.log(
			`Metrics: first_attempt_solve_rate=${summary.metrics.first_attempt_solve_rate.toFixed(3)}, average_attempt_count=${summary.metrics.average_attempt_count.toFixed(3)}, non_progressing_failure_rate=${summary.metrics.non_progressing_failure_rate.toFixed(3)}`
		);
		if (summary.failed > 0) {
			for (const result of summary.results.filter((entry) => !entry.pass)) {
				console.log(`- ${result.fixture_id}: ${result.errors.join('; ')}`);
			}
		}
	}

	if (summary.failed > 0) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
