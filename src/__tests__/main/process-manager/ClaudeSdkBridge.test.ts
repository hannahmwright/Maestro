import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { ClaudeSdkBridge } from '../../../main/process-manager/ClaudeSdkBridge';
import type { ManagedProcess } from '../../../main/process-manager/types';

function createManagedProcess(overrides: Partial<ManagedProcess> = {}): ManagedProcess {
	return {
		sessionId: 'session-ai-tab-1',
		toolType: 'claude-code',
		cwd: '/tmp',
		pid: 123,
		isTerminal: false,
		isBatchMode: true,
		startTime: Date.now(),
		conversationRuntime: 'live',
		claudeSdkState: {
			sdkSessionId: 'claude-session-1',
			activeTurnId: 'claude-turn-1',
			nextTurnSequence: 2,
		},
		...overrides,
	} as ManagedProcess;
}

describe('ClaudeSdkBridge', () => {
	let emitter: EventEmitter;
	let bridge: ClaudeSdkBridge;
	let processes: Map<string, ManagedProcess>;

	beforeEach(() => {
		emitter = new EventEmitter();
		processes = new Map();
		bridge = new ClaudeSdkBridge(processes, emitter);
	});

	it('should stream text deltas as assistant-stream append events', () => {
		const managedProcess = createManagedProcess();
		const assistantStreamSpy = vi.fn();
		emitter.on('assistant-stream', assistantStreamSpy);

		(bridge as any).handleStreamEvent(managedProcess, {
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				delta: {
					type: 'text_delta',
					text: 'Hello',
				},
			},
		});

		expect(assistantStreamSpy).toHaveBeenCalledWith(managedProcess.sessionId, {
			mode: 'append',
			text: 'Hello',
		});
	});

	it('should replace and commit final assistant text from SDK assistant messages', () => {
		const managedProcess = createManagedProcess();
		const assistantStreamSpy = vi.fn();
		emitter.on('assistant-stream', assistantStreamSpy);

		(bridge as any).handleAssistantMessage(managedProcess, {
			type: 'assistant',
			message: {
				content: [
					{ type: 'text', text: 'All set.' },
					{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a.ts' } },
				],
			},
			parent_tool_use_id: null,
			uuid: 'assistant-1',
			session_id: 'claude-session-1',
		});

		expect(assistantStreamSpy).toHaveBeenNthCalledWith(1, managedProcess.sessionId, {
			mode: 'replace',
			text: 'All set.',
		});
		expect(assistantStreamSpy).toHaveBeenNthCalledWith(2, managedProcess.sessionId, {
			mode: 'commit',
		});
	});

	it('should emit usage and a completed turn event for successful results', () => {
		const managedProcess = createManagedProcess({
			claudeSdkState: {
				sdkSessionId: 'claude-session-1',
				activeTurnId: 'claude-turn-1',
				nextTurnSequence: 2,
				currentTurnStartedAt: Date.now() - 50,
			},
		});
		const usageSpy = vi.fn();
		const conversationSpy = vi.fn();
		emitter.on('usage', usageSpy);
		emitter.on('conversation-event', conversationSpy);

		(bridge as any).handleResultMessage(managedProcess, {
			type: 'result',
			subtype: 'success',
			is_error: false,
			duration_ms: 50,
			duration_api_ms: 25,
			num_turns: 1,
			result: 'Finished.',
			stop_reason: null,
			total_cost_usd: 0.01,
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				server_tool_use: null,
				service_tier: 'standard',
				cache_creation: null,
			},
			modelUsage: {
				'claude-sonnet-4-5': {
					inputTokens: 10,
					outputTokens: 5,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
				},
			},
			permission_denials: [],
			uuid: 'result-1',
			session_id: 'claude-session-1',
		});

		expect(usageSpy).toHaveBeenCalled();
		expect(conversationSpy).toHaveBeenCalledWith(
			managedProcess.sessionId,
			expect.objectContaining({
				type: 'turn_completed',
				status: 'completed',
				threadId: 'claude-session-1',
				turnId: 'claude-turn-1',
			})
		);
	});

	it('should map Claude elicitation requests into Maestro user-input requests', async () => {
		const managedProcess = createManagedProcess();
		processes.set(managedProcess.sessionId, managedProcess);
		const userInputSpy = vi.fn();
		emitter.on('user-input-request', userInputSpy);

		const controller = new AbortController();
		const elicitationPromise = (bridge as any).handleElicitation(
			managedProcess,
			{
				serverName: 'github-auth',
				message: 'Choose a repository visibility setting.',
				mode: 'form',
				requestedSchema: {
					type: 'object',
					properties: {
						visibility: {
							type: 'string',
							title: 'Visibility',
							enum: ['private', 'public'],
						},
					},
				},
			},
			controller.signal
		);

		expect(userInputSpy).toHaveBeenCalledWith(
			managedProcess.sessionId,
			expect.objectContaining({
				threadId: 'claude-session-1',
				turnId: 'claude-turn-1',
				questions: [
					expect.objectContaining({
						id: 'visibility',
						header: 'Visibility',
						options: [
							{ label: 'private', description: '' },
							{ label: 'public', description: '' },
						],
					}),
				],
			})
		);

		const request = userInputSpy.mock.calls[0][1];
		await expect(
			bridge.respondToUserInput(managedProcess.sessionId, request.requestId, {
				answers: {
					visibility: { answers: ['private'] },
				},
			})
		).resolves.toBe(true);
		await expect(elicitationPromise).resolves.toEqual({
			action: 'accept',
			content: {
				visibility: 'private',
			},
		});
	});

	it('should cancel pending elicitation requests when the signal aborts', async () => {
		const managedProcess = createManagedProcess();
		processes.set(managedProcess.sessionId, managedProcess);

		const controller = new AbortController();
		const elicitationPromise = (bridge as any).handleElicitation(
			managedProcess,
			{
				serverName: 'oauth-flow',
				message: 'Complete sign-in in your browser.',
				mode: 'url',
				url: 'https://example.com/auth',
			},
			controller.signal
		);

		controller.abort();

		await expect(elicitationPromise).resolves.toEqual({
			action: 'cancel',
		});
	});
});
