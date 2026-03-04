#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const reportDir = path.resolve(root, 'reports');
const now = Date.now();
const days = process.argv.includes('--weekly') ? 7 : 30;
const windowStart = now - days * 24 * 60 * 60 * 1000;
const modulePath = path.resolve(root, 'dist/main/core-upgrades/index.js');
const fixturesDir = path.resolve(root, 'src/__tests__/fixtures/core-upgrades/replay');
const cacheRoot = path.resolve(os.homedir(), '.maestro/core-upgrades/context-cache');

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

async function readJsonIfExists(filePath) {
	try {
		const raw = await fs.readFile(filePath, 'utf8');
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function collectDiagnosticsRows() {
	let cacheDirs = [];
	try {
		cacheDirs = await fs.readdir(cacheRoot);
	} catch {
		return [];
	}

	const rows = [];
	for (const dir of cacheDirs) {
		const memoryPath = path.join(cacheRoot, dir, 'task-memory.json');
		const memory = await readJsonIfExists(memoryPath);
		if (!memory || typeof memory !== 'object') continue;
		for (const entry of Object.values(memory)) {
			const data = entry?.data;
			const updatedAt = Number(data?.updated_at || 0);
			if (!updatedAt || updatedAt < windowStart) continue;
			const diagnostics = data?.diagnostics;
			if (!diagnostics || typeof diagnostics !== 'object') continue;
			rows.push(diagnostics);
		}
	}
	return rows;
}

function ratio(part, total) {
	if (!total) return 0;
	return part / total;
}

function avg(values) {
	if (!values.length) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fmtPct(value) {
	return `${(value * 100).toFixed(1)}%`;
}

async function main() {
	const mod = await import(pathToFileURL(modulePath).href);
	const fixtures = await loadFixtures();
	const replaySummary = await mod.runReplaySuite(fixtures);
	const diagnosticsRows = await collectDiagnosticsRows();

	const completeCount = diagnosticsRows.filter((row) => row.status === 'complete').length;
	const nonProgressCount = diagnosticsRows.filter(
		(row) => row.failure_code === 'non_progressing_hypothesis_loop'
	).length;
	const attemptCounts = diagnosticsRows
		.map((row) => Number(row.attempt_count || 0))
		.filter(Boolean);
	const strategySwitchCounts = diagnosticsRows
		.map((row) => Number(row.strategy_switch_count || 0))
		.filter((value) => Number.isFinite(value));
	const contextExpansionCounts = diagnosticsRows
		.map((row) => Number(row.context_expansion_count || 0))
		.filter((value) => Number.isFinite(value));

	const reportLines = [
		'# Maestro Core Dogfood Report',
		'',
		`Window: last ${days} days`,
		`Generated: ${new Date(now).toISOString()}`,
		'',
		'## Replay Metrics',
		`- Fixture count: ${fixtures.length}`,
		`- Pass count: ${replaySummary.passed}/${fixtures.length}`,
		`- First-attempt solve rate: ${fmtPct(replaySummary.metrics.first_attempt_solve_rate)}`,
		`- Average attempt count: ${replaySummary.metrics.average_attempt_count.toFixed(3)}`,
		`- Non-progressing failure rate: ${fmtPct(replaySummary.metrics.non_progressing_failure_rate)}`,
		'',
		'## Dogfood Task Metrics',
		`- Tasks with diagnostics in window: ${diagnosticsRows.length}`,
		`- Completion rate: ${fmtPct(ratio(completeCount, diagnosticsRows.length))}`,
		`- Non-progress loop rate: ${fmtPct(ratio(nonProgressCount, diagnosticsRows.length))}`,
		`- Average attempt count: ${avg(attemptCounts).toFixed(3)}`,
		`- Average strategy switches: ${avg(strategySwitchCounts).toFixed(3)}`,
		`- Average context expansions: ${avg(contextExpansionCounts).toFixed(3)}`,
		'',
		'## Priorities',
		'- Increase hard/extreme replay fixtures with ambiguous dependency chains.',
		'- Reduce non-progress loops by improving branch discrimination probes.',
		'- Focus on areas with high attempts and low completion in latest dogfood window.',
		'',
	];

	await fs.mkdir(reportDir, { recursive: true });
	const fileName = `core-dogfood-report-${new Date(now).toISOString().slice(0, 10)}.md`;
	const reportPath = path.join(reportDir, fileName);
	await fs.writeFile(reportPath, `${reportLines.join('\n')}\n`, 'utf8');

	console.log(`Dogfood report written: ${reportPath}`);
	console.log(`Tasks analyzed: ${diagnosticsRows.length}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
