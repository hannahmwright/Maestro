#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const fixturesDir = path.resolve(root, 'src/__tests__/fixtures/core-upgrades/replay');
const minFixtures = Number(process.env.MAESTRO_REPLAY_MIN_FIXTURES || '8');

function isNonEmptyString(value) {
	return typeof value === 'string' && value.trim().length > 0;
}

function isValidDifficulty(value) {
	return value === 'easy' || value === 'medium' || value === 'hard' || value === 'extreme';
}

function validateFixture(fixture) {
	const errors = [];
	if (!isNonEmptyString(fixture.id)) errors.push('missing id');
	if (!isNonEmptyString(fixture.description)) errors.push('missing description');
	if (!fixture.task || typeof fixture.task !== 'object') errors.push('missing task');
	if (!Array.isArray(fixture.command_plan) || fixture.command_plan.length === 0) {
		errors.push('missing command_plan');
	}
	if (!fixture.expectation || typeof fixture.expectation !== 'object') {
		errors.push('missing expectation');
	}

	const metadata = fixture.metadata;
	if (!metadata || typeof metadata !== 'object') {
		errors.push('missing metadata');
	} else {
		if (!isValidDifficulty(metadata.difficulty)) {
			errors.push('metadata.difficulty must be one of easy|medium|hard|extreme');
		}
		if (!Array.isArray(metadata.tags) || metadata.tags.length === 0) {
			errors.push('metadata.tags must be a non-empty array');
		}
	}

	return errors;
}

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

async function main() {
	const loaded = await loadFixtures();
	if (loaded.length < minFixtures) {
		console.error(`Replay fixture count ${loaded.length} is below minimum ${minFixtures}.`);
		process.exitCode = 1;
		return;
	}

	let hasErrors = false;
	const difficultyCounts = { easy: 0, medium: 0, hard: 0, extreme: 0 };
	for (const { name, fixture } of loaded) {
		const errors = validateFixture(fixture);
		if (errors.length > 0) {
			hasErrors = true;
			console.error(`- ${name}: ${errors.join('; ')}`);
		}
		if (
			fixture?.metadata?.difficulty &&
			difficultyCounts[fixture.metadata.difficulty] !== undefined
		) {
			difficultyCounts[fixture.metadata.difficulty] += 1;
		}
	}

	console.log(`Replay fixtures validated: ${loaded.length}`);
	console.log(
		`Difficulty distribution: easy=${difficultyCounts.easy}, medium=${difficultyCounts.medium}, hard=${difficultyCounts.hard}, extreme=${difficultyCounts.extreme}`
	);

	if (difficultyCounts.hard + difficultyCounts.extreme === 0) {
		console.error('Replay corpus must include at least one hard/extreme fixture.');
		process.exitCode = 1;
		return;
	}

	if (hasErrors) {
		process.exitCode = 1;
		return;
	}

	console.log('Replay fixture schema check passed.');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
