/**
 * Tests for error listener.
 * Handles agent errors (auth expired, token exhaustion, rate limits, etc.).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupErrorListener } from '../../../main/process-listeners/error-listener';
import type { ProcessManager } from '../../../main/process-manager';
import type { SafeSendFn } from '../../../main/utils/safe-send';
import type { AgentError } from '../../../shared/types';
import type { ProcessListenerDependencies } from '../../../main/process-listeners/types';

describe('Error Listener', () => {
	let mockProcessManager: ProcessManager;
	let mockSafeSend: SafeSendFn;
	let mockLogger: ProcessListenerDependencies['logger'];
	let mockGetWebServer: ProcessListenerDependencies['getWebServer'];
	let eventHandlers: Map<string, (...args: unknown[]) => void>;

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();

		mockSafeSend = vi.fn();
		mockGetWebServer = vi.fn(() => null);
		mockLogger = {
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		};

		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
		} as unknown as ProcessManager;
	});

	it('should register the agent-error event listener', () => {
		setupErrorListener(mockProcessManager, {
			safeSend: mockSafeSend,
			logger: mockLogger,
			getWebServer: mockGetWebServer,
		});

		expect(mockProcessManager.on).toHaveBeenCalledWith('agent-error', expect.any(Function));
	});

	it('should log agent error and forward to renderer', () => {
		setupErrorListener(mockProcessManager, {
			safeSend: mockSafeSend,
			logger: mockLogger,
			getWebServer: mockGetWebServer,
		});

		const handler = eventHandlers.get('agent-error');
		const testSessionId = 'test-session-123';
		const testAgentError: AgentError = {
			type: 'auth_expired',
			agentId: 'claude-code',
			message: 'Authentication token has expired',
			recoverable: true,
			timestamp: Date.now(),
		};

		handler?.(testSessionId, testAgentError);

		expect(mockLogger.info).toHaveBeenCalledWith(
			'Agent error detected: auth_expired',
			'AgentError',
			expect.objectContaining({
				sessionId: testSessionId,
				agentId: 'claude-code',
				errorType: 'auth_expired',
				message: 'Authentication token has expired',
				recoverable: true,
			})
		);

		expect(mockSafeSend).toHaveBeenCalledWith('agent:error', testSessionId, testAgentError);
	});

	it('should handle token exhaustion errors', () => {
		setupErrorListener(mockProcessManager, {
			safeSend: mockSafeSend,
			logger: mockLogger,
			getWebServer: mockGetWebServer,
		});

		const handler = eventHandlers.get('agent-error');
		const testSessionId = 'session-456';
		const testAgentError: AgentError = {
			type: 'token_exhaustion',
			agentId: 'codex',
			message: 'Token limit exceeded',
			recoverable: false,
			timestamp: Date.now(),
		};

		handler?.(testSessionId, testAgentError);

		expect(mockSafeSend).toHaveBeenCalledWith('agent:error', testSessionId, testAgentError);
	});

	it('should handle rate limit errors', () => {
		setupErrorListener(mockProcessManager, {
			safeSend: mockSafeSend,
			logger: mockLogger,
			getWebServer: mockGetWebServer,
		});

		const handler = eventHandlers.get('agent-error');
		const testSessionId = 'session-789';
		const testAgentError: AgentError = {
			type: 'rate_limited',
			agentId: 'opencode',
			message: 'Rate limit exceeded, retry after 60 seconds',
			recoverable: true,
			timestamp: Date.now(),
		};

		handler?.(testSessionId, testAgentError);

		expect(mockLogger.info).toHaveBeenCalledWith(
			'Agent error detected: rate_limited',
			'AgentError',
			expect.objectContaining({
				sessionId: testSessionId,
				errorType: 'rate_limited',
			})
		);

		expect(mockSafeSend).toHaveBeenCalledWith('agent:error', testSessionId, testAgentError);
	});

	it('broadcasts agent errors to web clients as session logs and error state', () => {
		const mockWebServer = {
			broadcastSessionLogEntry: vi.fn(),
			broadcastSessionStateChange: vi.fn(),
		};
		mockGetWebServer = vi.fn(() => mockWebServer as any);

		setupErrorListener(mockProcessManager, {
			safeSend: mockSafeSend,
			logger: mockLogger,
			getWebServer: mockGetWebServer,
		});

		const handler = eventHandlers.get('agent-error');
		const timestamp = Date.now();
		const testAgentError: AgentError = {
			type: 'unknown',
			agentId: 'codex',
			message: 'Demo capture was requested, but no artifacts were produced.',
			recoverable: false,
			timestamp,
		};

		handler?.('session-1-ai-tab-9', testAgentError);

		expect(mockWebServer.broadcastSessionLogEntry).toHaveBeenCalledWith(
			'session-1',
			'tab-9',
			'ai',
			expect.objectContaining({
				id: `agent-error-${timestamp}-unknown`,
				source: 'error',
				text: testAgentError.message,
			})
		);
		expect(mockWebServer.broadcastSessionStateChange).toHaveBeenCalledWith('session-1', 'error');
	});

	it('does not force error state for session_not_found events on the web', () => {
		const mockWebServer = {
			broadcastSessionLogEntry: vi.fn(),
			broadcastSessionStateChange: vi.fn(),
		};
		mockGetWebServer = vi.fn(() => mockWebServer as any);

		setupErrorListener(mockProcessManager, {
			safeSend: mockSafeSend,
			logger: mockLogger,
			getWebServer: mockGetWebServer,
		});

		const handler = eventHandlers.get('agent-error');
		const testAgentError: AgentError = {
			type: 'session_not_found',
			agentId: 'claude-code',
			message: 'Session was not found',
			recoverable: true,
			timestamp: Date.now(),
		};

		handler?.('session-2-ai-tab-1', testAgentError);

		expect(mockWebServer.broadcastSessionLogEntry).toHaveBeenCalledWith(
			'session-2',
			'tab-1',
			'ai',
			expect.objectContaining({
				source: 'system',
				text: testAgentError.message,
			})
		);
		expect(mockWebServer.broadcastSessionStateChange).not.toHaveBeenCalled();
	});
});
