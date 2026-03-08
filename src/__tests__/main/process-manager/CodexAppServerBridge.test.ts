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
});
