import { describe, expect, it } from 'vitest';
import { appendDemoCaptureInstructions } from '../../../renderer/utils/demoCapturePrompt';

describe('appendDemoCaptureInstructions', () => {
	it('returns the original prompt when demo capture is disabled', () => {
		expect(appendDemoCaptureInstructions('Ship the feature', false)).toBe('Ship the feature');
	});

	it('adds hard-requirement instructions for explicit demo capture requests', () => {
		const prompt = appendDemoCaptureInstructions('Ship the feature', true);

		expect(prompt).toContain('explicitly requested a demo or screenshots');
		expect(prompt).toContain('hard requirement');
		expect(prompt).toContain('MAESTRO_DEMO_CONTEXT_FILE');
		expect(prompt).toContain('maestro-demo');
		expect(prompt).toContain('Do not silently skip demo capture');
		expect(prompt).toContain('Maestro will treat the run as failed');
		expect(prompt).toContain('require artifacts');
		expect(prompt).toContain('at least one screenshot step or the automatic video');
		expect(prompt).not.toContain('.codex/skills/playwright');
	});
});
