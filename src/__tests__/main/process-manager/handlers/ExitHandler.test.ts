/**
 * Tests for src/main/process-manager/handlers/ExitHandler.ts
 *
 * Covers the ExitHandler class, specifically:
 * - Processing remaining jsonBuffer in stream-json mode at exit
 * - Final data buffer flush before emitting exit event
 * - Emitting accumulated streamedText when no result was emitted
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../../main/parsers/error-patterns', () => ({
	matchSshErrorPattern: vi.fn(() => null),
}));

vi.mock('../../../../main/parsers/usage-aggregator', () => ({
	aggregateModelUsage: vi.fn(() => ({
		inputTokens: 100,
		outputTokens: 50,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0.01,
		contextWindow: 200000,
	})),
}));

vi.mock('../../../../main/process-manager/utils/imageUtils', () => ({
	cleanupTempFiles: vi.fn(),
}));

const mockGetTurnRequirementOutcome = vi.fn(() => ({ satisfied: true }));

vi.mock('../../../../main/artifacts', () => ({
	getDemoArtifactService: () => ({
		getTurnRequirementOutcome: mockGetTurnRequirementOutcome,
	}),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { ExitHandler } from '../../../../main/process-manager/handlers/ExitHandler';
import { DataBufferManager } from '../../../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess } from '../../../../main/process-manager/types';
import type { AgentOutputParser, ParsedEvent } from '../../../../main/parsers';

// ── Helpers ────────────────────────────────────────────────────────────────

function createMockProcess(overrides: Partial<ManagedProcess> = {}): ManagedProcess {
	return {
		sessionId: 'test-session',
		toolType: 'claude-code',
		cwd: '/tmp',
		pid: 1234,
		isTerminal: false,
		startTime: Date.now(),
		isStreamJsonMode: false,
		isBatchMode: false,
		jsonBuffer: '',
		stdoutBuffer: '',
		stderrBuffer: '',
		contextWindow: 200000,
		lastUsageTotals: undefined,
		usageIsCumulative: undefined,
		sessionIdEmitted: false,
		resultEmitted: false,
		errorEmitted: false,
		outputParser: undefined,
		sshRemoteId: undefined,
		sshRemoteHost: undefined,
		streamedText: '',
		demoCaptureEnabled: false,
		demoCaptureFinalized: false,
		demoCaptureArtifactSeen: false,
		demoCaptureFailed: false,
		...overrides,
	} as ManagedProcess;
}

function createMockOutputParser(overrides: Partial<AgentOutputParser> = {}): AgentOutputParser {
	return {
		agentId: 'claude-code',
		parseJsonLine: vi.fn(() => null),
		extractUsage: vi.fn(() => null),
		extractSessionId: vi.fn(() => null),
		extractSlashCommands: vi.fn(() => null),
		isResultMessage: vi.fn(() => false),
		detectErrorFromLine: vi.fn(() => null),
		detectErrorFromExit: vi.fn(() => null),
		...overrides,
	} as unknown as AgentOutputParser;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ExitHandler', () => {
	let processes: Map<string, ManagedProcess>;
	let emitter: EventEmitter;
	let bufferManager: DataBufferManager;
	let exitHandler: ExitHandler;

	beforeEach(() => {
		mockGetTurnRequirementOutcome.mockReset();
		mockGetTurnRequirementOutcome.mockReturnValue({ satisfied: true });
		processes = new Map();
		emitter = new EventEmitter();
		bufferManager = new DataBufferManager(processes, emitter);
		exitHandler = new ExitHandler({ processes, emitter, bufferManager });
	});

	describe('stream-json jsonBuffer processing at exit', () => {
		it('should process remaining jsonBuffer content as a result message', () => {
			const resultJson = '{"type":"result","result":"Auth Bug Fix","session_id":"abc"}';
			const mockParser = createMockOutputParser({
				parseJsonLine: vi.fn(() => ({
					type: 'result',
					text: 'Auth Bug Fix',
					sessionId: 'abc',
				})) as unknown as AgentOutputParser['parseJsonLine'],
				isResultMessage: vi.fn(() => true) as unknown as AgentOutputParser['isResultMessage'],
			});

			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				jsonBuffer: resultJson,
				outputParser: mockParser,
			});
			processes.set('test-session', proc);

			const dataEvents: string[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));

			exitHandler.handleExit('test-session', 0);

			expect(mockParser.parseJsonLine).toHaveBeenCalledWith(resultJson);
			expect(mockParser.isResultMessage).toHaveBeenCalled();
			expect(dataEvents).toContain('Auth Bug Fix');
		});

		it('should not process jsonBuffer if already empty', () => {
			const mockParser = createMockOutputParser();

			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				jsonBuffer: '',
				outputParser: mockParser,
			});
			processes.set('test-session', proc);

			exitHandler.handleExit('test-session', 0);

			expect(mockParser.parseJsonLine).not.toHaveBeenCalled();
		});

		it('should not process jsonBuffer if resultEmitted is already true', () => {
			const resultJson = '{"type":"result","result":"Tab Name"}';
			const mockParser = createMockOutputParser({
				parseJsonLine: vi.fn(() => ({
					type: 'result',
					text: 'Tab Name',
				})) as unknown as AgentOutputParser['parseJsonLine'],
				isResultMessage: vi.fn(() => true) as unknown as AgentOutputParser['isResultMessage'],
			});

			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				jsonBuffer: resultJson,
				outputParser: mockParser,
				resultEmitted: true, // Already emitted during stdout processing
			});
			processes.set('test-session', proc);

			const dataEvents: string[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));

			exitHandler.handleExit('test-session', 0);

			// parseJsonLine is called, but data should NOT be emitted again
			expect(dataEvents).not.toContain('Tab Name');
		});

		it('should emit raw line as data when JSON parsing fails', () => {
			const invalidJson = 'not valid json at all';
			const mockParser = createMockOutputParser({
				parseJsonLine: vi.fn(() => {
					throw new Error('JSON parse error');
				}) as unknown as AgentOutputParser['parseJsonLine'],
			});

			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				jsonBuffer: invalidJson,
				outputParser: mockParser,
			});
			processes.set('test-session', proc);

			const dataEvents: string[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));

			exitHandler.handleExit('test-session', 0);

			expect(dataEvents).toContain(invalidJson);
		});

		it('should use streamedText as fallback when result event has no text', () => {
			const resultJson = '{"type":"result"}';
			const mockParser = createMockOutputParser({
				parseJsonLine: vi.fn(() => ({
					type: 'result',
					text: '', // Empty text
				})) as unknown as AgentOutputParser['parseJsonLine'],
				isResultMessage: vi.fn(() => true) as unknown as AgentOutputParser['isResultMessage'],
			});

			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				jsonBuffer: resultJson,
				outputParser: mockParser,
				streamedText: 'Accumulated streaming text',
			});
			processes.set('test-session', proc);

			const dataEvents: string[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));

			exitHandler.handleExit('test-session', 0);

			expect(dataEvents).toContain('Accumulated streaming text');
		});

		it('waits for pending demo capture ingestion before checking required demo outcome', async () => {
			let resolvePending: (() => void) | null = null;
			const pending = new Promise<void>((resolve) => {
				resolvePending = resolve;
			});

			const proc = createMockProcess({
				demoCaptureEnabled: true,
				demoCaptureContext: {
					sessionId: 'test-session',
					tabId: null,
					captureRunId: 'capture-1',
					externalRunId: 'run-1',
					turnId: 'turn-1',
					turnToken: 'token-1',
					provider: 'claude-code',
					model: 'claude-opus-4-6',
					requestedTarget: { url: 'https://example.com', domain: 'example.com' },
					contextFilePath: '/tmp/context.json',
					stateFilePath: '/tmp/state.json',
					outputDir: 'output/playwright',
				},
				demoCapturePending: pending,
			});
			processes.set('test-session', proc);

			const exitPromise = exitHandler.handleExit('test-session', 0);
			expect(mockGetTurnRequirementOutcome).not.toHaveBeenCalled();

			resolvePending?.();
			await exitPromise;

			expect(mockGetTurnRequirementOutcome).toHaveBeenCalledWith({
				sessionId: 'test-session',
				tabId: null,
				turnId: 'turn-1',
				captureRunId: 'capture-1',
			});
		});
	});

	describe('final data buffer flush', () => {
		it('should flush data buffer before emitting exit event', () => {
			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				// Simulate data that was buffered during exit processing
				dataBuffer: 'buffered data',
			});
			processes.set('test-session', proc);

			const events: string[] = [];
			emitter.on('data', () => events.push('data'));
			emitter.on('exit', () => events.push('exit'));

			exitHandler.handleExit('test-session', 0);

			// Data should come before exit
			const dataIdx = events.indexOf('data');
			const exitIdx = events.indexOf('exit');
			expect(dataIdx).toBeLessThan(exitIdx);
		});

		it('should emit exit event even with no buffered data', () => {
			const proc = createMockProcess();
			processes.set('test-session', proc);

			const exitEvents: Array<{ sessionId: string; code: number }> = [];
			emitter.on('exit', (sid: string, code: number) => exitEvents.push({ sessionId: sid, code }));

			exitHandler.handleExit('test-session', 0);

			expect(exitEvents).toEqual([{ sessionId: 'test-session', code: 0 }]);
		});
	});

	describe('streamedText fallback', () => {
		it('should emit streamedText when no result was emitted in stream-json mode', () => {
			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				resultEmitted: false,
				streamedText: 'Partial response text',
			});
			processes.set('test-session', proc);

			const dataEvents: string[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));

			exitHandler.handleExit('test-session', 0);

			expect(dataEvents).toContain('Partial response text');
		});

		it('should not emit streamedText when result was already emitted', () => {
			const proc = createMockProcess({
				isStreamJsonMode: true,
				isBatchMode: true,
				resultEmitted: true,
				streamedText: 'Should not be emitted',
			});
			processes.set('test-session', proc);

			const dataEvents: string[] = [];
			emitter.on('data', (_sid: string, data: string) => dataEvents.push(data));

			exitHandler.handleExit('test-session', 0);

			expect(dataEvents).not.toContain('Should not be emitted');
		});
	});

	describe('process cleanup', () => {
		it('should emit an agent error when demo capture was requested but never finalized', () => {
			const proc = createMockProcess({
				isBatchMode: true,
				demoCaptureEnabled: true,
				demoCaptureFinalized: false,
			});
			processes.set('test-session', proc);

			const agentErrors: Array<{ sessionId: string; message: string }> = [];
			emitter.on('agent-error', (sid: string, error: { message: string }) =>
				agentErrors.push({ sessionId: sid, message: error.message })
			);

			exitHandler.handleExit('test-session', 0);

			expect(agentErrors).toEqual([
				{
					sessionId: 'test-session',
					message:
						'Demo capture was requested for this run, but the agent exited without finalizing any demo artifacts.',
				},
			]);
		});

		it('should not emit a demo-capture error when demo capture was finalized', () => {
			const proc = createMockProcess({
				isBatchMode: true,
				demoCaptureEnabled: true,
				demoCaptureFinalized: true,
				demoCaptureArtifactSeen: true,
			});
			processes.set('test-session', proc);

			const agentErrors: Array<{ sessionId: string; message: string }> = [];
			emitter.on('agent-error', (sid: string, error: { message: string }) =>
				agentErrors.push({ sessionId: sid, message: error.message })
			);

			exitHandler.handleExit('test-session', 0);

			expect(agentErrors).toEqual([]);
		});

		it('should emit an agent error when demo capture finalized without artifacts', () => {
			const proc = createMockProcess({
				isBatchMode: true,
				demoCaptureEnabled: true,
				demoCaptureFinalized: true,
				demoCaptureArtifactSeen: false,
			});
			processes.set('test-session', proc);

			const agentErrors: Array<{ sessionId: string; message: string }> = [];
			emitter.on('agent-error', (sid: string, error: { message: string }) =>
				agentErrors.push({ sessionId: sid, message: error.message })
			);

			exitHandler.handleExit('test-session', 0);

			expect(agentErrors).toEqual([
				{
					sessionId: 'test-session',
					message:
						'Demo capture was requested for this run, but no screenshot or video artifacts were produced.',
				},
			]);
		});

		it('should emit an agent error when demo capture emits a failure event', () => {
			const proc = createMockProcess({
				isBatchMode: true,
				demoCaptureEnabled: true,
				demoCaptureFinalized: true,
				demoCaptureFailed: true,
			});
			processes.set('test-session', proc);

			const agentErrors: Array<{ sessionId: string; message: string }> = [];
			emitter.on('agent-error', (sid: string, error: { message: string }) =>
				agentErrors.push({ sessionId: sid, message: error.message })
			);

			exitHandler.handleExit('test-session', 0);

			expect(agentErrors).toEqual([
				{
					sessionId: 'test-session',
					message: 'Demo capture failed for this run.',
				},
			]);
		});

		it('should remove process from map after exit', () => {
			const proc = createMockProcess();
			processes.set('test-session', proc);

			exitHandler.handleExit('test-session', 0);

			expect(processes.has('test-session')).toBe(false);
		});

		it('should emit exit event for unknown sessions', () => {
			const exitEvents: Array<{ sessionId: string; code: number }> = [];
			emitter.on('exit', (sid: string, code: number) => exitEvents.push({ sessionId: sid, code }));

			exitHandler.handleExit('unknown-session', 1);

			expect(exitEvents).toEqual([{ sessionId: 'unknown-session', code: 1 }]);
		});
	});
});
