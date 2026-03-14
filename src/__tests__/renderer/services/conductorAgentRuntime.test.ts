import { describe, expect, it } from 'vitest';
import {
	detectConductorProviderRoute,
	extractConductorAgentResponse,
} from '../../../renderer/services/conductorAgentRuntime';

describe('conductorAgentRuntime', () => {
	it('extracts Claude-style result payloads', () => {
		const response = extractConductorAgentResponse(
			'claude-code',
			'{"type":"result","result":"planner summary"}\n'
		);

		expect(response).toBe('planner summary');
	});

	it('extracts Codex agent_message content', () => {
		const response = extractConductorAgentResponse(
			'codex',
			'{"type":"agent_message","content":[{"type":"text","text":"worker "},{"type":"text","text":"complete"}]}\n'
		);

		expect(response).toBe('worker complete');
	});

	it('extracts OpenCode text parts', () => {
		const response = extractConductorAgentResponse(
			'opencode',
			'{"type":"text","part":{"text":"qa approved"}}\n'
		);

		expect(response).toBe('qa approved');
	});

	it('extracts Factory Droid completion payloads', () => {
		const response = extractConductorAgentResponse(
			'factory-droid',
			'{"type":"completion","finalText":"done and reviewed"}\n'
		);

		expect(response).toBe('done and reviewed');
	});

	it('routes obvious UI work to the UI provider preference', () => {
		expect(
			detectConductorProviderRoute({
				taskTitle: 'Polish the settings modal layout',
				taskDescription: 'Improve React component spacing and CSS states for the page',
			})
		).toBe('ui');
	});

	it('routes obvious backend work to the backend provider preference', () => {
		expect(
			detectConductorProviderRoute({
				taskTitle: 'Add API auth handler',
				taskDescription: 'Update the server route and database schema for token validation',
			})
		).toBe('backend');
	});
});
