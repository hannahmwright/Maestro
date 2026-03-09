import { describe, expect, it } from 'vitest';
import { maestroSystemPrompt } from '../../../prompts';
import {
	CODEX_MINIMAL_SYSTEM_PROMPT,
	getAgentSystemPromptTemplate,
} from '../../../renderer/utils/agentSystemPrompt';

describe('getAgentSystemPromptTemplate', () => {
	it('returns the reduced prompt for Codex', () => {
		const prompt = getAgentSystemPromptTemplate('codex');

		expect(prompt).toBe(CODEX_MINIMAL_SYSTEM_PROMPT);
		expect(prompt).toContain('Write files only inside');
		expect(prompt).not.toContain('## About Maestro');
		expect(prompt).not.toContain('## Auto-run Documents');
	});

	it('preserves the existing prompt for non-Codex agents', () => {
		expect(getAgentSystemPromptTemplate('claude-code')).toBe(maestroSystemPrompt);
		expect(getAgentSystemPromptTemplate('opencode')).toBe(maestroSystemPrompt);
	});
});
