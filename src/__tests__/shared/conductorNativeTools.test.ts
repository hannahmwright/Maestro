import { describe, expect, it } from 'vitest';
import {
	CONDUCTOR_PLAN_RESULT_TOOL_NAME,
	CONDUCTOR_REVIEW_RESULT_TOOL_NAME,
	CONDUCTOR_WORK_RESULT_TOOL_NAME,
	parseConductorStructuredSubmissionFromToolExecution,
} from '../../shared/conductorNativeTools';

describe('conductorNativeTools', () => {
	it('parses Claude-style direct tool input payloads', () => {
		const parsed = parseConductorStructuredSubmissionFromToolExecution(
			CONDUCTOR_WORK_RESULT_TOOL_NAME,
			{
				status: 'running',
				input: {
					outcome: 'completed',
					summary: 'Done.',
					changedPaths: ['src/example.ts'],
					followUpTasks: [],
				},
			}
		);

		expect(parsed).toMatchObject({
			kind: 'worker',
			payload: {
				outcome: 'completed',
				changedPaths: ['src/example.ts'],
			},
		});
	});

	it('parses Codex MCP argument payloads', () => {
		const parsed = parseConductorStructuredSubmissionFromToolExecution(
			CONDUCTOR_REVIEW_RESULT_TOOL_NAME,
			{
				status: 'completed',
				input: {
					server: 'maestro_conductor_results',
					arguments: {
						decision: 'approved',
						summary: 'Looks good.',
						followUpTasks: [],
					},
				},
			}
		);

		expect(parsed).toMatchObject({
			kind: 'reviewer',
			payload: {
				decision: 'approved',
				summary: 'Looks good.',
			},
		});
	});

	it('returns null when a tool event does not match the expected schema', () => {
		const parsed = parseConductorStructuredSubmissionFromToolExecution(
			CONDUCTOR_PLAN_RESULT_TOOL_NAME,
			{
				status: 'running',
				input: {
					tasks: [],
				},
			}
		);

		expect(parsed).toBeNull();
	});
});
