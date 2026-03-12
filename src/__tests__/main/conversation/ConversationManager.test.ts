import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationManager } from '../../../main/conversation/ConversationManager';
import type { AgentDetector } from '../../../main/agents';
import type { ProcessManager } from '../../../main/process-manager';

describe('ConversationManager', () => {
	let mockProcessManager: ProcessManager;
	let mockAgentDetector: AgentDetector;
	let dispatchSpawn: ReturnType<typeof vi.fn>;
	let manager: ConversationManager;
	let processEventHandlers: Record<string, Function>;

	beforeEach(() => {
		processEventHandlers = {};
		mockProcessManager = {
			on: vi.fn((event: string, handler: Function) => {
				processEventHandlers[event] = handler;
				return mockProcessManager;
			}),
			get: vi.fn(),
			sendClaudeLiveTurn: vi.fn().mockReturnValue({ pid: 42, success: true }),
			steerClaudeLiveTurn: vi.fn().mockReturnValue(true),
			interruptClaudeLiveTurn: vi.fn().mockReturnValue(true),
			interrupt: vi.fn().mockReturnValue(true),
			respondToUserInput: vi.fn().mockReturnValue(true),
		} as unknown as ProcessManager;
		mockAgentDetector = {
			getAgent: vi.fn().mockResolvedValue({
				id: 'claude-code',
				available: true,
			}),
		} as unknown as AgentDetector;

		dispatchSpawn = vi.fn(async (_request, options) => {
			if (options?.spawnStrategy) {
				return options.spawnStrategy({
					processManager: mockProcessManager,
					spawnConfig: {
						sessionId: 'session-1-ai-tab-1',
						toolType: 'claude-code',
					},
					sshRemoteUsed: null,
				});
			}
			return { pid: 7, success: true };
		});

		manager = new ConversationManager({
			processManager: mockProcessManager,
			agentDetector: mockAgentDetector,
			dispatchSpawn,
		});
	});

	it('should report live true-steer capabilities for local interactive Claude sessions', async () => {
		await expect(
			manager.getCapabilities({
				toolType: 'claude-code',
				querySource: 'user',
				sessionSshRemoteConfig: { enabled: false, remoteId: null },
			})
		).resolves.toEqual(
			expect.objectContaining({
				supportsLiveRuntime: true,
				supportsTrueSteer: true,
				defaultRuntimeKind: 'live',
				steerMode: 'true-steer',
			})
		);
	});

	it('should fall back to batch Claude capabilities after a live auth failure', async () => {
		(mockProcessManager.get as any).mockReturnValue({
			toolType: 'claude-code',
			conversationRuntime: 'live',
		});

		processEventHandlers['agent-error']?.('session-1-ai-tab-1', {
			type: 'auth_expired',
			message: 'Run "claude login" to re-authenticate.',
		});

		await expect(
			manager.getCapabilities({
				toolType: 'claude-code',
				querySource: 'user',
				sessionSshRemoteConfig: { enabled: false, remoteId: null },
			})
		).resolves.toEqual(
			expect.objectContaining({
				supportsLiveRuntime: false,
				supportsTrueSteer: false,
				defaultRuntimeKind: 'batch',
				steerMode: 'interrupt-fallback',
				fallbackReason: 'Run "claude login" to re-authenticate.',
			})
		);
	});

	it('should dispatch Claude turns through the live spawn strategy', async () => {
		const result = await manager.sendTurn({
			sessionId: 'session-1-ai-tab-1',
			toolType: 'claude-code',
			cwd: '/tmp/project',
			command: 'claude',
			args: ['--print'],
			prompt: 'Investigate the failing test',
		});

		expect(dispatchSpawn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'session-1-ai-tab-1',
				toolType: 'claude-code',
			}),
			expect.objectContaining({
				spawnConfigOverrides: { conversationRuntime: 'live' },
				spawnStrategy: expect.any(Function),
			})
		);
		expect((mockProcessManager as any).sendClaudeLiveTurn).toHaveBeenCalled();
		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				pid: 42,
				runtimeKind: 'live',
				steerMode: 'true-steer',
			})
		);
	});

	it('should steer Claude live turns through the Claude bridge', async () => {
		const result = await manager.steerTurn({
			sessionId: 'session-1-ai-tab-1',
			toolType: 'claude-code',
			text: 'Stop refactoring and patch only the failing assertion.',
		});

		expect((mockProcessManager as any).steerClaudeLiveTurn).toHaveBeenCalledWith(
			'session-1-ai-tab-1',
			{
				text: 'Stop refactoring and patch only the failing assertion.',
				images: undefined,
			}
		);
		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				runtimeKind: 'live',
				steerMode: 'true-steer',
			})
		);
	});
});
