import * as fs from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { runReplayCase, runReplaySuite } from '../../../main/core-upgrades';
import type { ReplayFixture } from '../../../main/core-upgrades';

const FIXTURE_DIR = path.resolve(process.cwd(), 'src/__tests__/fixtures/core-upgrades/replay');

async function loadFixtures(): Promise<ReplayFixture[]> {
	const files = (await fs.readdir(FIXTURE_DIR))
		.filter((name) => name.endsWith('.json') && name !== 'baseline.json')
		.sort();
	const fixtures: ReplayFixture[] = [];
	for (const fileName of files) {
		const raw = await fs.readFile(path.join(FIXTURE_DIR, fileName), 'utf8');
		fixtures.push(JSON.parse(raw) as ReplayFixture);
	}
	return fixtures;
}

describe('core-upgrades replay harness', () => {
	it('runs all fixtures and satisfies expectations', async () => {
		const fixtures = await loadFixtures();
		expect(fixtures.length).toBeGreaterThan(0);

		const summary = await runReplaySuite(fixtures);
		expect(summary.failed).toBe(0);
		expect(summary.passed).toBe(fixtures.length);
		expect(summary.metrics.first_attempt_solve_rate).toBeGreaterThanOrEqual(0);
		expect(summary.metrics.first_attempt_solve_rate).toBeLessThanOrEqual(1);
		expect(summary.metrics.average_attempt_count).toBeGreaterThan(0);
		expect(summary.metrics.non_progressing_failure_rate).toBeGreaterThanOrEqual(0);
	});

	it('produces a trace for each fixture run', async () => {
		const fixtures = await loadFixtures();
		for (const fixture of fixtures) {
			const result = await runReplayCase(fixture);
			expect(result.fixture_id).toBe(fixture.id);
			expect(result.executed_commands.length).toBeGreaterThan(0);
			expect(result.loop_result.attempts.length).toBeGreaterThan(0);
		}
	});
});
