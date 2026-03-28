import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../../renderer/types';
import {
	appendConductorHelperText,
	capConductorHelperLogs,
	compactConductorHelperSession,
	isConductorHelperSession,
	sanitizeConductorToolStateForLog,
	truncateConductorHelperText,
} from '../../../renderer/services/conductorSessionLogPolicy';

describe('conductorSessionLogPolicy', () => {
	it('identifies conductor helper sessions', () => {
		expect(isConductorHelperSession(null)).toBe(false);
		expect(isConductorHelperSession({ conductorMetadata: undefined })).toBe(false);
		expect(
			isConductorHelperSession({
				conductorMetadata: { isConductorSession: true } as never,
			})
		).toBe(true);
		expect(
			isConductorHelperSession({
				conductorMetadata: undefined,
				name: "You are Conductor's discovery planner for the Maestro worksp",
				aiTabs: [],
			} as never)
		).toBe(true);
	});

	it('truncates long helper text to a bounded tail', () => {
		const text = 'a'.repeat(13_500);
		const truncated = truncateConductorHelperText(text);

		expect(truncated.length).toBeLessThan(text.length);
		expect(truncated.startsWith('[truncated ')).toBe(true);
		expect(truncated.endsWith('a'.repeat(12_000))).toBe(true);
	});

	it('caps helper log arrays to the latest entries', () => {
		const logs = Array.from({ length: 100 }, (_, index) => ({
			id: String(index),
			timestamp: index,
			source: 'ai',
			text: `log ${index}`,
		})) as LogEntry[];

		const capped = capConductorHelperLogs(logs);
		expect(capped).toHaveLength(80);
		expect(capped[0]?.id).toBe('20');
		expect(capped.at(-1)?.id).toBe('99');
	});

	it('summarizes verbose tool state payloads', () => {
		const sanitized = sanitizeConductorToolStateForLog({
			id: 'tool-1',
			status: 'running',
			input: {
				url: 'https://example.com',
				html: 'x'.repeat(5_000),
			},
			output: {
				body: 'y'.repeat(5_000),
			},
			searches: [
				{
					query: 'one',
					output: 'z'.repeat(2_000),
				},
			],
		});

		expect(sanitized.id).toBe('tool-1');
		expect(sanitized.status).toBe('running');
		expect(sanitized.inputPreview).toBeTruthy();
		expect(sanitized.outputPreview).toBeTruthy();
		expect(sanitized.searches).toBeTruthy();
		expect(JSON.stringify(sanitized)).not.toContain('x'.repeat(500));
	});

	it('applies bounded append windows for helper text', () => {
		const appended = appendConductorHelperText('b'.repeat(11_500), 'c'.repeat(1_500));
		expect(appended.startsWith('[truncated ')).toBe(true);
		expect(appended).toContain('c'.repeat(1_500));
	});

	it('compacts conductor helper sessions to lightweight snapshots', () => {
		const session = compactConductorHelperSession({
			aiTabs: [
				{
					id: 'tab-1',
					logs: [{ id: '1', timestamp: 1, source: 'ai', text: 'hello' }],
					inputValue: 'draft',
					stagedImages: ['image'],
				},
			] as never,
			aiLogs: [{ id: '2', timestamp: 2, source: 'ai', text: 'hi' }] as never,
			shellLogs: [{ id: '3', timestamp: 3, source: 'stdout', text: 'shell' }] as never,
			workLog: [
				{ id: '4', title: 'work', description: 'desc', timestamp: 4 },
			] as never,
			executionQueue: [{ id: '5' }] as never,
			conductorMetadata: { isConductorSession: true } as never,
		});

		expect(session.aiTabs[0].logs).toEqual([]);
		expect(session.aiTabs[0].inputValue).toBe('');
		expect(session.aiTabs[0].stagedImages).toEqual([]);
		expect(session.aiLogs).toEqual([]);
		expect(session.shellLogs).toEqual([]);
		expect(session.workLog).toEqual([]);
		expect(session.executionQueue).toEqual([]);
	});

	it('compacts helper-like sessions even when metadata is missing', () => {
		const session = compactConductorHelperSession({
			name: "You are Conductor's discovery planner for the Maestro worksp",
			aiTabs: [
				{
					id: 'tab-1',
					name: "You are Conductor's discovery planner for the Maestro worksp",
					logs: [{ id: '1', timestamp: 1, source: 'ai', text: 'hello' }],
					inputValue: 'draft',
					stagedImages: ['image'],
				},
			] as never,
			aiLogs: [{ id: '2', timestamp: 2, source: 'ai', text: 'hi' }] as never,
			shellLogs: [{ id: '3', timestamp: 3, source: 'stdout', text: 'shell' }] as never,
			workLog: [{ id: '4', title: 'work', description: 'desc', timestamp: 4 }] as never,
			executionQueue: [{ id: '5' }] as never,
			conductorMetadata: undefined,
		} as never);

		expect(session.aiTabs[0].logs).toEqual([]);
		expect(session.aiLogs).toEqual([]);
		expect(session.shellLogs).toEqual([]);
		expect(session.workLog).toEqual([]);
		expect(session.executionQueue).toEqual([]);
	});
});
