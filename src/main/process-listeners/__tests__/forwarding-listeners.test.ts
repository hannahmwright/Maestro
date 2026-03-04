/**
 * Tests for forwarding listeners.
 * These listeners simply forward process events to the renderer via IPC.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupForwardingListeners } from '../forwarding-listeners';
import type { ProcessManager } from '../../process-manager';
import type { SafeSendFn } from '../../utils/safe-send';

describe('Forwarding Listeners', () => {
	let mockProcessManager: ProcessManager;
	let mockSafeSend: SafeSendFn;
	let eventHandlers: Map<string, (...args: unknown[]) => void>;

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();

		mockSafeSend = vi.fn();

		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
		} as unknown as ProcessManager;
	});

	it('should register all forwarding event listeners', () => {
		setupForwardingListeners(mockProcessManager, { safeSend: mockSafeSend });

		expect(mockProcessManager.on).toHaveBeenCalledWith('slash-commands', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('thinking-chunk', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('tool-execution', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('stderr', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('command-exit', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('task-lifecycle', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('task-status', expect.any(Function));
	});

	it('should forward slash-commands events to renderer', () => {
		setupForwardingListeners(mockProcessManager, { safeSend: mockSafeSend });

		const handler = eventHandlers.get('slash-commands');
		const testSessionId = 'test-session-123';
		const testCommands = ['/help', '/clear'];

		handler?.(testSessionId, testCommands);

		expect(mockSafeSend).toHaveBeenCalledWith(
			'process:slash-commands',
			testSessionId,
			testCommands
		);
	});

	it('should forward thinking-chunk events to renderer', () => {
		setupForwardingListeners(mockProcessManager, { safeSend: mockSafeSend });

		const handler = eventHandlers.get('thinking-chunk');
		const testSessionId = 'test-session-123';
		const testChunk = { content: 'thinking...' };

		handler?.(testSessionId, testChunk);

		expect(mockSafeSend).toHaveBeenCalledWith('process:thinking-chunk', testSessionId, testChunk);
	});

	it('should forward tool-execution events to renderer', () => {
		setupForwardingListeners(mockProcessManager, { safeSend: mockSafeSend });

		const handler = eventHandlers.get('tool-execution');
		const testSessionId = 'test-session-123';
		const testToolExecution = { tool: 'read_file', status: 'completed' };

		handler?.(testSessionId, testToolExecution);

		expect(mockSafeSend).toHaveBeenCalledWith(
			'process:tool-execution',
			testSessionId,
			testToolExecution
		);
	});

	it('should forward stderr events to renderer', () => {
		setupForwardingListeners(mockProcessManager, { safeSend: mockSafeSend });

		const handler = eventHandlers.get('stderr');
		const testSessionId = 'test-session-123';
		const testStderr = 'Error: something went wrong';

		handler?.(testSessionId, testStderr);

		expect(mockSafeSend).toHaveBeenCalledWith('process:stderr', testSessionId, testStderr);
	});

	it('should forward command-exit events to renderer', () => {
		setupForwardingListeners(mockProcessManager, { safeSend: mockSafeSend });

		const handler = eventHandlers.get('command-exit');
		const testSessionId = 'test-session-123';
		const testExitCode = 0;

		handler?.(testSessionId, testExitCode);

		expect(mockSafeSend).toHaveBeenCalledWith('process:command-exit', testSessionId, testExitCode);
	});

	it('should forward task lifecycle events to renderer channels', () => {
		setupForwardingListeners(mockProcessManager, { safeSend: mockSafeSend });

		const handler = eventHandlers.get('task-lifecycle');
		const testSessionId = 'task-session-123';

		handler?.(testSessionId, { type: 'triage-started', attempt: 1, signal_excerpt: 'fail' });
		handler?.(testSessionId, {
			type: 'hypothesis-generated',
			attempt: 1,
			triage: {
				classification: 'test_failure',
				confidence: 0.8,
				probable_files: [],
				probable_symbols: [],
				hypotheses: [],
				raw_signal_excerpt: '',
			},
		});
		handler?.(testSessionId, {
			type: 'edit-plan-applied',
			attempt: 1,
			edit_plan: {
				valid: true,
				blocked: false,
				blocked_reasons: [],
				file_plans: [],
				changed_file_budget: 3,
				requested_file_count: 1,
			},
		});
		handler?.(testSessionId, { type: 'review-findings', attempt: 1, findings: [] });
		handler?.(testSessionId, {
			type: 'gate-result',
			attempt: 1,
			decision: {
				decision: 'complete',
				requires_full_suite: false,
				blocking_reasons: [],
				blocking_findings: [],
				next_actions: [],
			},
		});

		expect(mockSafeSend).toHaveBeenCalledWith(
			'task:triage-started',
			testSessionId,
			expect.objectContaining({ type: 'triage-started' })
		);
		expect(mockSafeSend).toHaveBeenCalledWith(
			'task:hypothesis-generated',
			testSessionId,
			expect.objectContaining({ type: 'hypothesis-generated' })
		);
		expect(mockSafeSend).toHaveBeenCalledWith(
			'task:edit-plan-applied',
			testSessionId,
			expect.objectContaining({ type: 'edit-plan-applied' })
		);
		expect(mockSafeSend).toHaveBeenCalledWith(
			'task:review-findings',
			testSessionId,
			expect.objectContaining({ type: 'review-findings' })
		);
		expect(mockSafeSend).toHaveBeenCalledWith(
			'task:gate-result',
			testSessionId,
			expect.objectContaining({ type: 'gate-result' })
		);
	});

	it('should forward aggregated task status events', () => {
		setupForwardingListeners(mockProcessManager, { safeSend: mockSafeSend });

		const handler = eventHandlers.get('task-status');
		const testSessionId = 'task-session-123';
		const testStatus = {
			task_id: 'task-1',
			status: 'failed',
			attempt_count: 2,
			blocking_reasons: ['full_suite_failed'],
			full_suite_required: true,
			lifecycle_counts: {
				triage_started: 1,
				hypothesis_generated: 1,
				edit_plan_applied: 0,
				review_findings: 1,
				gate_result: 1,
			},
			generated_at: Date.now(),
		};

		handler?.(testSessionId, testStatus);

		expect(mockSafeSend).toHaveBeenCalledWith('task:status', testSessionId, testStatus);
	});
});
