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

import { CodexAppServerBridge } from '../../../main/process-manager/CodexAppServerBridge';
import type { ManagedProcess } from '../../../main/process-manager/types';

function createManagedProcess(overrides: Partial<ManagedProcess> = {}): ManagedProcess {
	return {
		sessionId: 'session-ai-tab-1',
		toolType: 'codex',
		cwd: '/tmp',
		pid: 123,
		isTerminal: false,
		isBatchMode: true,
		startTime: Date.now(),
		codexAppServerState: {
			nextClientRequestId: 1,
			agentMessagePhases: new Map(),
			toolItemNames: new Map(),
			currentTurnCorrectionCount: 0,
		},
		...overrides,
	} as ManagedProcess;
}

describe('CodexAppServerBridge', () => {
	let emitter: EventEmitter;
	let bridge: CodexAppServerBridge;

	beforeEach(() => {
		emitter = new EventEmitter();
		bridge = new CodexAppServerBridge(new Map(), emitter);
	});

	it('should stream final-answer deltas as assistant-stream append events', () => {
		const managedProcess = createManagedProcess();
		managedProcess.codexAppServerState?.agentMessagePhases.set('msg-1', 'final_answer');
		const assistantStreamSpy = vi.fn();
		emitter.on('assistant-stream', assistantStreamSpy);

		(bridge as any).handleAgentMessageDelta(managedProcess, {
			itemId: 'msg-1',
			delta: 'Hello',
		});

		expect(assistantStreamSpy).toHaveBeenCalledWith(managedProcess.sessionId, {
			mode: 'append',
			text: 'Hello',
		});
	});

	it('should replace and commit the final answer when no correction is needed', () => {
		const managedProcess = createManagedProcess();
		const assistantStreamSpy = vi.fn();
		emitter.on('assistant-stream', assistantStreamSpy);

		(bridge as any).handleItemCompleted(managedProcess, {
			item: {
				id: 'msg-1',
				type: 'agentMessage',
				phase: 'final_answer',
				text: 'All set.',
			},
		});

		expect(assistantStreamSpy).toHaveBeenNthCalledWith(1, managedProcess.sessionId, {
			mode: 'replace',
			text: 'All set.',
		});
		expect(assistantStreamSpy).toHaveBeenNthCalledWith(2, managedProcess.sessionId, {
			mode: 'commit',
		});
	});

	it('should discard streamed output when the final answer triggers chat-question correction', () => {
		const managedProcess = createManagedProcess();
		const assistantStreamSpy = vi.fn();
		emitter.on('assistant-stream', assistantStreamSpy);

		(bridge as any).handleItemCompleted(managedProcess, {
			item: {
				id: 'msg-1',
				type: 'agentMessage',
				phase: 'final_answer',
				text: 'Before I proceed, which option should I choose?',
			},
		});

		expect(assistantStreamSpy).toHaveBeenCalledWith(managedProcess.sessionId, {
			mode: 'discard',
		});
		expect(managedProcess.codexAppServerState?.pendingCorrectionPrompt).toContain(
			'Do not ask questions in chat'
		);
	});

	it('should emit thinking chunks for reasoning text deltas', () => {
		const managedProcess = createManagedProcess();
		const thinkingSpy = vi.fn();
		emitter.on('thinking-chunk', thinkingSpy);

		(bridge as any).handleWebSocketMessage(
			managedProcess,
			{} as never,
			JSON.stringify({
				method: 'item/reasoning/textDelta',
				params: {
					itemId: 'reasoning-1',
					delta: 'Inspecting the repository state.',
				},
			})
		);

		expect(thinkingSpy).toHaveBeenCalledWith(
			managedProcess.sessionId,
			'Inspecting the repository state.'
		);
	});

	it('should emit tool execution updates for command execution items', () => {
		const managedProcess = createManagedProcess();
		const toolSpy = vi.fn();
		const dataSpy = vi.fn();
		emitter.on('tool-execution', toolSpy);
		emitter.on('data', dataSpy);

		(bridge as any).handleItemStarted(managedProcess, {
			item: {
				type: 'commandExecution',
				id: 'cmd-1',
				command: '/bin/zsh -lc "rg CodexAppServerBridge src/main"',
				cwd: '/tmp',
				processId: '123',
				commandActions: [{ type: 'search', query: 'CodexAppServerBridge' }],
			},
		});

		(bridge as any).handleItemCompleted(managedProcess, {
			item: {
				type: 'commandExecution',
				id: 'cmd-1',
				command: '/bin/zsh -lc "rg CodexAppServerBridge src/main"',
				cwd: '/tmp',
				processId: '123',
				status: 'completed',
				commandActions: [{ type: 'search', query: 'CodexAppServerBridge' }],
				aggregatedOutput:
					'src/main/process-manager/CodexAppServerBridge.ts\n__MAESTRO_DEMO_EVENT__ {"type":"capture_completed","runId":"run-1"}',
				exitCode: 0,
				durationMs: 12,
			},
		});

		expect(toolSpy).toHaveBeenNthCalledWith(1, managedProcess.sessionId, {
			toolName: 'shell_command',
			state: {
				id: 'cmd-1',
				status: 'running',
				input: {
					command: '/bin/zsh -lc "rg CodexAppServerBridge src/main"',
					cwd: '/tmp',
					commandActions: [{ type: 'search', query: 'CodexAppServerBridge' }],
				},
				output: undefined,
				processId: '123',
				exitCode: undefined,
				durationMs: undefined,
			},
			timestamp: expect.any(Number),
		});
		expect(toolSpy).toHaveBeenNthCalledWith(2, managedProcess.sessionId, {
			toolName: 'shell_command',
			state: {
				id: 'cmd-1',
				status: 'completed',
				input: {
					command: '/bin/zsh -lc "rg CodexAppServerBridge src/main"',
					cwd: '/tmp',
					commandActions: [{ type: 'search', query: 'CodexAppServerBridge' }],
				},
				output:
					'src/main/process-manager/CodexAppServerBridge.ts\n__MAESTRO_DEMO_EVENT__ {"type":"capture_completed","runId":"run-1"}',
				processId: '123',
				exitCode: 0,
				durationMs: 12,
			},
			timestamp: expect.any(Number),
		});
		expect(dataSpy).toHaveBeenCalledWith(
			managedProcess.sessionId,
			'__MAESTRO_DEMO_EVENT__ {"type":"capture_completed","runId":"run-1"}\n'
		);
	});

	it('should emit usage from thread/tokenUsage/updated notifications', () => {
		const managedProcess = createManagedProcess({ contextWindow: 400000 });
		const usageSpy = vi.fn();
		emitter.on('usage', usageSpy);

		(bridge as any).handleWebSocketMessage(
			managedProcess,
			{} as never,
			JSON.stringify({
				method: 'thread/tokenUsage/updated',
				params: {
					threadId: 'thread-1',
					turnId: 'turn-1',
					tokenUsage: {
						last: {
							inputTokens: 100,
							outputTokens: 25,
							cachedInputTokens: 50,
							reasoningOutputTokens: 10,
						},
						modelContextWindow: 258400,
					},
				},
			})
		);

		expect(usageSpy).toHaveBeenCalledWith(managedProcess.sessionId, {
			inputTokens: 100,
			outputTokens: 25,
			cacheReadInputTokens: 50,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0,
			contextWindow: 258400,
			reasoningTokens: 10,
		});
	});

	it('should surface file change activity as tool execution updates', () => {
		const managedProcess = createManagedProcess();
		const toolSpy = vi.fn();
		emitter.on('tool-execution', toolSpy);

		(bridge as any).handleItemStarted(managedProcess, {
			item: {
				type: 'fileChange',
				id: 'patch-1',
				status: 'pending',
				changes: [{ path: 'src/main/process-manager/CodexAppServerBridge.ts' }],
			},
		});

		(bridge as any).handleWebSocketMessage(
			managedProcess,
			{} as never,
			JSON.stringify({
				method: 'item/fileChange/outputDelta',
				params: {
					itemId: 'patch-1',
					delta: 'Applying patch to Codex bridge',
				},
			})
		);

		(bridge as any).handleItemCompleted(managedProcess, {
			item: {
				type: 'fileChange',
				id: 'patch-1',
				status: 'applied',
				changes: [{ path: 'src/main/process-manager/CodexAppServerBridge.ts' }],
			},
		});

		expect(toolSpy).toHaveBeenNthCalledWith(1, managedProcess.sessionId, {
			toolName: 'apply_patch',
			state: {
				id: 'patch-1',
				status: 'running',
				input: {
					changes: [{ path: 'src/main/process-manager/CodexAppServerBridge.ts' }],
				},
			},
			timestamp: expect.any(Number),
		});
		expect(toolSpy).toHaveBeenNthCalledWith(2, managedProcess.sessionId, {
			toolName: 'apply_patch',
			state: {
				id: 'patch-1',
				status: 'running',
				output: 'Applying patch to Codex bridge',
			},
			timestamp: expect.any(Number),
		});
		expect(toolSpy).toHaveBeenNthCalledWith(3, managedProcess.sessionId, {
			toolName: 'apply_patch',
			state: {
				id: 'patch-1',
				status: 'completed',
				input: {
					changes: [{ path: 'src/main/process-manager/CodexAppServerBridge.ts' }],
				},
			},
			timestamp: expect.any(Number),
		});
	});

	it('should preserve mcp tool names for progress updates', () => {
		const managedProcess = createManagedProcess();
		const toolSpy = vi.fn();
		emitter.on('tool-execution', toolSpy);

		(bridge as any).handleItemStarted(managedProcess, {
			item: {
				type: 'mcpToolCall',
				id: 'mcp-1',
				server: 'maestro',
				tool: 'SearchMaestro',
				status: 'pending',
				arguments: { query: 'Codex live turn stalled' },
				result: null,
				error: null,
				durationMs: null,
			},
		});

		(bridge as any).handleWebSocketMessage(
			managedProcess,
			{} as never,
			JSON.stringify({
				method: 'item/mcpToolCall/progress',
				params: {
					itemId: 'mcp-1',
					message: 'Searching Maestro docs...',
				},
			})
		);

		expect(toolSpy).toHaveBeenNthCalledWith(1, managedProcess.sessionId, {
			toolName: 'SearchMaestro',
			state: {
				id: 'mcp-1',
				status: 'running',
				input: {
					server: 'maestro',
					arguments: { query: 'Codex live turn stalled' },
				},
				output: undefined,
				durationMs: undefined,
			},
			timestamp: expect.any(Number),
		});
		expect(toolSpy).toHaveBeenNthCalledWith(2, managedProcess.sessionId, {
			toolName: 'SearchMaestro',
			state: {
				id: 'mcp-1',
				status: 'running',
				output: 'Searching Maestro docs...',
			},
			timestamp: expect.any(Number),
		});
	});

	it('resets demo capture state for each live turn', () => {
		const processes = new Map<string, ManagedProcess>();
		bridge = new CodexAppServerBridge(processes, emitter);
		const managedProcess = createManagedProcess({
			conversationRuntime: 'live',
			demoCaptureEnabled: false,
			demoCaptureFinalized: true,
			demoCaptureArtifactSeen: true,
			demoCaptureFailed: true,
			codexAppServerState: {
				nextClientRequestId: 1,
				agentMessagePhases: new Map(),
				currentTurnCorrectionCount: 0,
				ws: {
					readyState: 1,
					send: vi.fn(),
				},
				threadId: 'thread-1',
			} as any,
		});
		processes.set(managedProcess.sessionId, managedProcess);

		const result = bridge.sendTurn({
			sessionId: managedProcess.sessionId,
			toolType: 'codex',
			cwd: '/tmp',
			command: 'codex',
			args: [],
			prompt: 'Show the fixed flow',
			conversationRuntime: 'live',
			demoCapture: { enabled: true },
		} as any);

		expect(result.success).toBe(true);
		expect(managedProcess.demoCaptureEnabled).toBe(true);
		expect(managedProcess.demoCaptureFinalized).toBe(false);
		expect(managedProcess.demoCaptureArtifactSeen).toBe(false);
		expect(managedProcess.demoCaptureFailed).toBe(false);
	});
});
