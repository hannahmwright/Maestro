import { describe, it, expect } from 'vitest';
import { FailureTriageEngine } from '../../../main/core-upgrades';

describe('FailureTriageEngine', () => {
	it('classifies module not found failures', () => {
		const engine = new FailureTriageEngine();
		const result = engine.analyzeFailure({
			session_id: 'session-1',
			command: 'npm test',
			cwd: '/tmp/project',
			exit_code: 1,
			stderr: "Error: Cannot find module './missing' in src/main/index.ts:12",
		});

		expect(result.classification).toBe('module_not_found');
		expect(result.probable_files[0]).toContain('src/main/index.ts');
		expect(result.hypotheses.length).toBeGreaterThan(0);
	});

	it('falls back to unknown when no pattern matches', () => {
		const engine = new FailureTriageEngine();
		const result = engine.analyzeFailure({
			session_id: 'session-2',
			command: 'custom',
			cwd: '/tmp/project',
			exit_code: 1,
			stderr: 'non-standard output',
		});

		expect(result.classification).toBe('unknown');
		expect(result.confidence).toBeLessThan(0.5);
	});

	it('generates targeted test commands when failure references a test file', () => {
		const engine = new FailureTriageEngine();
		const result = engine.analyzeFailure({
			session_id: 'session-3',
			command: 'npm test',
			cwd: '/tmp/project',
			exit_code: 1,
			stderr: 'FAIL src/math.test.ts\nExpected: 2\nReceived: 1',
		});

		expect(result.hypotheses[0]?.suggested_commands).toContain('npm test -- src/math.test.ts');
		const probeKinds = new Set(result.hypotheses[0]?.probe_candidates.map((probe) => probe.kind));
		expect(probeKinds.has('confirm')).toBe(true);
		expect(probeKinds.has('disconfirm')).toBe(true);
	});

	it('uses context fallback files when stderr does not include file paths', () => {
		const engine = new FailureTriageEngine();
		const result = engine.analyzeFailure({
			session_id: 'session-4',
			command: 'npm test',
			cwd: '/tmp/project',
			exit_code: 1,
			stderr: 'FAIL unit tests',
			context_fallback_files: ['src/math.test.ts', 'src/math.ts'],
		});

		expect(result.probable_files).toContain('src/math.test.ts');
		expect(result.probable_files).toContain('src/math.ts');
	});

	it('changes hypothesis metadata hash when command changes for same failure', () => {
		const engine = new FailureTriageEngine();
		const sharedFailure = "Error: Cannot find module './missing' in src/main/index.ts:12";
		const first = engine.analyzeFailure({
			session_id: 'session-5',
			command: 'npm test',
			cwd: '/tmp/project',
			exit_code: 1,
			stderr: sharedFailure,
		});
		const second = engine.analyzeFailure({
			session_id: 'session-5',
			command: 'npm run build',
			cwd: '/tmp/project',
			exit_code: 1,
			stderr: sharedFailure,
		});

		expect(first.hypotheses[0]?.metadata_hash).not.toBe(second.hypotheses[0]?.metadata_hash);
	});
});
