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
});
