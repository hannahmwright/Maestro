import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	appendConductorTurnOutput,
	buildConductorCallsign,
	buildConductorSpawnBaseArgs,
	detectConductorProviderRoute,
	extractConductorAgentResponse,
	runConductorAgentTurn,
} from '../../../renderer/services/conductorAgentRuntime';
import { conversationService } from '../../../renderer/services/conversation';
import {
	CONDUCTOR_WORK_RESULT_TOOL_NAME,
} from '../../../shared/conductorNativeTools';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useConductorStore } from '../../../renderer/stores/conductorStore';

const conversationListeners: Array<(sessionId: string, event: unknown) => void> = [];

vi.mock('../../../renderer/services/conversation', () => ({
	conversationService: {
		onEvent: vi.fn((callback: (sessionId: string, event: unknown) => void) => {
			conversationListeners.push(callback);
			return () => removeListener(conversationListeners, callback);
		}),
		sendTurn: vi.fn(),
	},
}));

type ProcessListenerMap = {
	data: Array<(sessionId: string, data: string) => void>;
	assistantStream: Array<
		(
			sessionId: string,
			event: { mode: 'append' | 'replace' | 'commit' | 'discard'; text?: string }
		) => void
	>;
	sessionId: Array<(sessionId: string, agentSessionId: string) => void>;
	usage: Array<(sessionId: string, usage: unknown) => void>;
	toolExecution: Array<(sessionId: string, event: unknown) => void>;
	agentError: Array<(sessionId: string, error: unknown) => void>;
	queryComplete: Array<(sessionId: string, event: unknown) => void>;
	exit: Array<(sessionId: string, exitCode: number) => void>;
};

function removeListener<T>(listeners: T[], callback: T) {
	const index = listeners.indexOf(callback);
	if (index >= 0) {
		listeners.splice(index, 1);
	}
}

describe('conductorAgentRuntime', () => {
	let listeners: ProcessListenerMap;
	let originalMaestro: unknown;
	let spawnBehavior: (targetSessionId: string) => void | Promise<void>;

	beforeEach(() => {
		vi.useFakeTimers();
		originalMaestro = (window as unknown as { maestro?: unknown }).maestro;
		conversationListeners.length = 0;
		listeners = {
			data: [],
			assistantStream: [],
			sessionId: [],
			usage: [],
			toolExecution: [],
			agentError: [],
			queryComplete: [],
			exit: [],
		};

		useSessionStore.setState({
			sessions: [],
			groups: [],
			threads: [],
			activeSessionId: '',
			sessionsLoaded: true,
			initialLoadComplete: true,
			removedWorktreePaths: new Set(),
			cyclePosition: -1,
		} as any);
		useSettingsStore.setState({
			settingsLoaded: true,
			defaultSaveToHistory: false,
			defaultShowThinking: 'sticky',
			conductorProfile: '',
		} as any);
		useConductorStore.setState({
			conductors: [],
			tasks: [],
			runs: [],
			activeConductorView: null,
		} as any);
		spawnBehavior = (sessionId: string) => {
			const match = sessionId.match(/^(.*)-ai-(.*)$/);
			if (!match) {
				throw new Error(`Unexpected target session ID: ${sessionId}`);
			}

			const [, childSessionId, tabId] = match;
			const childSession = useSessionStore
				.getState()
				.sessions.find((candidate) => candidate.id === childSessionId);
			const childTab = childSession?.aiTabs.find((candidate) => candidate.id === tabId);
			if (!childSession || !childTab) {
				throw new Error('Expected Conductor child session to exist before spawn.');
			}

			// Reproduce the worker/session drift we saw live: the session is already idle by the
			// time output arrives, but no store transition fires to announce it.
			childSession.state = 'idle';
			childTab.state = 'idle';
			listeners.data.forEach((callback) =>
				callback(
					sessionId,
					'{"type":"agent_message","content":[{"type":"text","text":"done"}]}\n'
				)
			);
		};

		(window as unknown as { maestro?: unknown }).maestro = {
			agents: {
				get: vi.fn(async (toolType: string) => ({
					available: true,
					path: `/mock/${toolType}`,
					args: [],
					capabilities: { supportsStreamJsonInput: false },
				})),
				getProviderUsage: vi.fn(async () => null),
			},
			git: {
				status: vi.fn(async () => ({ stdout: '' })),
				branch: vi.fn(async () => ({ stdout: 'main\n' })),
				branches: vi.fn(async () => ({ branches: ['main'] })),
				tags: vi.fn(async () => ({ tags: [] })),
			},
			artifacts: {
				listSessionDemos: vi.fn(async () => []),
			},
			process: {
				onData: vi.fn((callback: (sessionId: string, data: string) => void) => {
					listeners.data.push(callback);
					return () => removeListener(listeners.data, callback);
				}),
				onAssistantStream: vi.fn(
					(
						callback: (
							sessionId: string,
							event: { mode: 'append' | 'replace' | 'commit' | 'discard'; text?: string }
						) => void
					) => {
						listeners.assistantStream.push(callback);
						return () => removeListener(listeners.assistantStream, callback);
					}
				),
				onSessionId: vi.fn((callback: (sessionId: string, agentSessionId: string) => void) => {
					listeners.sessionId.push(callback);
					return () => removeListener(listeners.sessionId, callback);
				}),
				onUsage: vi.fn((callback: (sessionId: string, usage: unknown) => void) => {
					listeners.usage.push(callback);
					return () => removeListener(listeners.usage, callback);
				}),
				onToolExecution: vi.fn((callback: (sessionId: string, event: unknown) => void) => {
					listeners.toolExecution.push(callback);
					return () => removeListener(listeners.toolExecution, callback);
				}),
				onAgentError: vi.fn((callback: (sessionId: string, error: unknown) => void) => {
					listeners.agentError.push(callback);
					return () => removeListener(listeners.agentError, callback);
				}),
				onQueryComplete: vi.fn((callback: (sessionId: string, event: unknown) => void) => {
					listeners.queryComplete.push(callback);
					return () => removeListener(listeners.queryComplete, callback);
				}),
				onExit: vi.fn((callback: (sessionId: string, exitCode: number) => void) => {
					listeners.exit.push(callback);
					return () => removeListener(listeners.exit, callback);
				}),
				spawn: vi.fn(async ({ sessionId }: { sessionId: string }) => {
					await spawnBehavior(sessionId);
				}),
			},
		};
		vi.mocked(conversationService.sendTurn).mockReset();
		vi.mocked(conversationService.sendTurn).mockImplementation(async () => ({
			runtimeKind: 'conversation',
		}) as any);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		conversationListeners.length = 0;
		(window as unknown as { maestro?: unknown }).maestro = originalMaestro;
		useSessionStore.setState({
			sessions: [],
			groups: [],
			threads: [],
			activeSessionId: '',
			sessionsLoaded: false,
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
			cyclePosition: -1,
		} as any);
		useConductorStore.setState({
			conductors: [],
			tasks: [],
			runs: [],
			activeConductorView: null,
		} as any);
	});

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

	it('keeps only the trailing raw output needed for fallback parsing', () => {
		const output = appendConductorTurnOutput('', '12345', 4);
		const appended = appendConductorTurnOutput(output, '6789', 6);

		expect(output).toBe('2345');
		expect(appended).toBe('456789');
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

	it('uses approved single-name Claude conductor names', () => {
		expect(buildConductorCallsign('claude-code', 'mind-loom:worker:claude:brace')).toMatch(
			/^(Vera|Mira|Evie|Lina|Selah|Talia|Ines|Kaia|Noemi|Leona|Eliza|Celine|Nadia|Clara|Maeve)$/
		);
	});

	it('uses approved single-name Codex conductor names', () => {
		expect(buildConductorCallsign('codex', 'mind-loom:worker:codex:backend')).toMatch(
			/^(Jupiter|Kairo|Eli|Dorian|Cillian|Arden|Niko|Jonas|Theo|Lucian|Rowan|Ivo|Matteo|Adrian|Luca)$/
		);
	});

	it('finalizes when output arrives after the child session is already idle', async () => {
		const parentSession = {
			id: 'parent-session',
			groupId: 'workspace-1',
			workspaceId: 'workspace-1',
			name: 'Lead Codex',
			toolType: 'codex',
			state: 'idle',
			cwd: '/repo',
			fullPath: '/repo',
			projectRoot: '/repo',
			inputMode: 'ai',
			isGitRepo: true,
			aiTabs: [],
			filePreviewTabs: [],
			unifiedTabOrder: [],
			shellLogs: [],
			workLog: [],
			aiLogs: [],
		} as any;

		const runPromise = runConductorAgentTurn({
			parentSession,
			role: 'planner',
			providerOverride: 'codex',
			prompt: 'Return a quick test plan.',
			cwd: '/repo',
		});

		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(800);

		await expect(runPromise).resolves.toMatchObject({
			toolType: 'codex',
			response: 'done',
		});
	});

	it('routes codex worker turns through spawn instead of the native conversation runtime', async () => {
		const parentSession = {
			id: 'parent-session',
			groupId: 'workspace-1',
			workspaceId: 'workspace-1',
			name: 'Lead Codex',
			toolType: 'codex',
			state: 'idle',
			cwd: '/repo',
			fullPath: '/repo',
			projectRoot: '/repo',
			inputMode: 'ai',
			isGitRepo: true,
			aiTabs: [],
			filePreviewTabs: [],
			unifiedTabOrder: [],
			shellLogs: [],
			workLog: [],
			aiLogs: [],
		} as any;

		const runPromise = runConductorAgentTurn({
			parentSession,
			role: 'worker',
			providerOverride: 'codex',
			prompt: 'Do the task and submit the structured result.',
			taskTitle: 'Smoke test worker',
			cwd: '/repo',
			expectedSubmissionKind: 'worker',
		});

		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(800);

		await expect(runPromise).resolves.toMatchObject({
			toolType: 'codex',
			response: 'done',
		});
		expect(window.maestro.process.spawn).toHaveBeenCalled();
		expect(conversationService.sendTurn).not.toHaveBeenCalled();
	});

	it('fails fast when the child session goes idle while a tool is still running', async () => {
		spawnBehavior = (sessionId: string) => {
			const match = sessionId.match(/^(.*)-ai-(.*)$/);
			if (!match) {
				throw new Error(`Unexpected target session ID: ${sessionId}`);
			}

			const [, childSessionId, tabId] = match;
			const childSession = useSessionStore
				.getState()
				.sessions.find((candidate) => candidate.id === childSessionId);
			const childTab = childSession?.aiTabs.find((candidate) => candidate.id === tabId);
			if (!childSession || !childTab) {
				throw new Error('Expected Conductor child session to exist before spawn.');
			}

			childSession.state = 'idle';
			childTab.state = 'idle';
			listeners.toolExecution.forEach((callback) =>
				callback(sessionId, {
					toolName: 'browser_navigate',
					state: {
						id: 'tool-1',
						status: 'running',
					},
				})
			);
		};

		const parentSession = {
			id: 'parent-session',
			groupId: 'workspace-1',
			workspaceId: 'workspace-1',
			name: 'Lead Codex',
			toolType: 'codex',
			state: 'idle',
			cwd: '/repo',
			fullPath: '/repo',
			projectRoot: '/repo',
			inputMode: 'ai',
			isGitRepo: true,
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
			},
			aiTabs: [],
			filePreviewTabs: [],
			unifiedTabOrder: [],
			shellLogs: [],
			workLog: [],
			aiLogs: [],
		} as any;

		const runPromise = runConductorAgentTurn({
			parentSession,
			role: 'worker',
			providerOverride: 'codex',
			prompt: 'Visit example.com.',
			taskTitle: 'Visit Example.com',
			cwd: '/repo',
		});
		const rejection = expect(runPromise).rejects.toThrow(
			/became idle while browser_navigate was still running/i
		);

		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(2000);

		await rejection;
	});

	it('fails fast when a running tool is only reflected in session logs', async () => {
		spawnBehavior = (sessionId: string) => {
			const match = sessionId.match(/^(.*)-ai-(.*)$/);
			if (!match) {
				throw new Error(`Unexpected target session ID: ${sessionId}`);
			}

			const [, childSessionId, tabId] = match;
			const childSession = useSessionStore
				.getState()
				.sessions.find((candidate) => candidate.id === childSessionId);
			const childTab = childSession?.aiTabs.find((candidate) => candidate.id === tabId);
			if (!childSession || !childTab) {
				throw new Error('Expected Conductor child session to exist before spawn.');
			}

			childTab.logs = [
				...childTab.logs,
				{
					id: 'tool-log-1',
					timestamp: Date.now(),
					source: 'tool',
					text: 'browser_navigate',
					metadata: {
						toolState: {
							id: 'tool-1',
							status: 'running',
						},
					},
				},
			] as any;
			childSession.state = 'idle';
			childTab.state = 'idle';
			useSessionStore.setState((state) => ({
				...state,
				sessions: [...state.sessions],
			}));
		};

		const parentSession = {
			id: 'parent-session',
			groupId: 'workspace-1',
			workspaceId: 'workspace-1',
			name: 'Lead Codex',
			toolType: 'codex',
			state: 'idle',
			cwd: '/repo',
			fullPath: '/repo',
			projectRoot: '/repo',
			inputMode: 'ai',
			isGitRepo: true,
			aiTabs: [],
			filePreviewTabs: [],
			unifiedTabOrder: [],
			shellLogs: [],
			workLog: [],
			aiLogs: [],
		} as any;

		const runPromise = runConductorAgentTurn({
			parentSession,
			role: 'worker',
			providerOverride: 'codex',
			prompt: 'Visit example.com.',
			taskTitle: 'Visit Example.com',
			cwd: '/repo',
		});
		const rejection = expect(runPromise).rejects.toThrow(
			/became idle while browser_navigate was still running/i
		);

		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(2000);

		await rejection;
	});

	it('falls back to the latest ai tab when the original tab lookup misses', async () => {
		spawnBehavior = (sessionId: string) => {
			const match = sessionId.match(/^(.*)-ai-(.*)$/);
			if (!match) {
				throw new Error(`Unexpected target session ID: ${sessionId}`);
			}

			const [, childSessionId, tabId] = match;
			const childSession = useSessionStore
				.getState()
				.sessions.find((candidate) => candidate.id === childSessionId);
			if (!childSession) {
				throw new Error('Expected Conductor child session to exist before spawn.');
			}

			const originalTabIndex = childSession.aiTabs.findIndex((candidate) => candidate.id === tabId);
			if (originalTabIndex === -1) {
				throw new Error('Expected Conductor child tab to exist before spawn.');
			}

			childSession.aiTabs.splice(originalTabIndex, 1);
			childSession.aiTabs.push({
				id: 'replacement-tab',
				agentSessionId: 'agent-session-2',
				logs: [
					{
						id: 'tool-log-replacement',
						timestamp: Date.now(),
						source: 'tool',
						text: 'browser_navigate',
						metadata: {
							toolState: {
								id: 'tool-1',
								status: 'running',
							},
						},
					},
				],
				state: 'idle',
				inputValue: '',
				stagedImages: [],
				createdAt: Date.now(),
				saveToHistory: false,
			} as any);
			childSession.state = 'idle';
			useSessionStore.setState((state) => ({
				...state,
				sessions: [...state.sessions],
			}));
		};

		const parentSession = {
			id: 'parent-session',
			groupId: 'workspace-1',
			workspaceId: 'workspace-1',
			name: 'Lead Codex',
			toolType: 'codex',
			state: 'idle',
			cwd: '/repo',
			fullPath: '/repo',
			projectRoot: '/repo',
			inputMode: 'ai',
			isGitRepo: true,
			aiTabs: [],
			filePreviewTabs: [],
			unifiedTabOrder: [],
			shellLogs: [],
			workLog: [],
			aiLogs: [],
		} as any;

		const runPromise = runConductorAgentTurn({
			parentSession,
			role: 'worker',
			providerOverride: 'codex',
			prompt: 'Visit example.com.',
			taskTitle: 'Visit Example.com',
			cwd: '/repo',
		});
		const rejection = expect(runPromise).rejects.toThrow(
			/became idle while browser_navigate was still running/i
		);

		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(2000);

		await rejection;
	});

	it('routes planner turns through spawn and accepts JSON fallback output', async () => {
		spawnBehavior = (sessionId: string) => {
			const match = sessionId.match(/^(.*)-ai-(.*)$/);
			if (!match) {
				throw new Error(`Unexpected target session ID: ${sessionId}`);
			}

			const [, childSessionId, tabId] = match;
			const childSession = useSessionStore
				.getState()
				.sessions.find((candidate) => candidate.id === childSessionId);
			const childTab = childSession?.aiTabs.find((candidate) => candidate.id === tabId);
			if (!childSession || !childTab) {
				throw new Error('Expected Conductor child session to exist before spawn.');
			}

			childSession.state = 'idle';
			childTab.state = 'idle';
			listeners.data.forEach((callback) =>
				callback(
					sessionId,
					'{"type":"result","result":"{\\"summary\\":\\"Quick test plan.\\",\\"tasks\\":[{\\"title\\":\\"Do the thing\\",\\"description\\":\\"Test task\\",\\"priority\\":\\"medium\\",\\"acceptanceCriteria\\":[\\"It works\\"],\\"dependsOn\\":[],\\"scopePaths\\":[]}]}"}\n'
				)
			);
		};

		const parentSession = {
			id: 'parent-session',
			groupId: 'workspace-1',
			workspaceId: 'workspace-1',
			name: 'Lead Claude',
			toolType: 'claude-code',
			state: 'idle',
			cwd: '/repo',
			fullPath: '/repo',
			projectRoot: '/repo',
			inputMode: 'ai',
			isGitRepo: true,
			aiTabs: [],
			filePreviewTabs: [],
			unifiedTabOrder: [],
			shellLogs: [],
			workLog: [],
			aiLogs: [],
		} as any;

		const runPromise = runConductorAgentTurn({
			parentSession,
			role: 'planner',
			providerOverride: 'claude-code',
			prompt: 'Return a quick test plan.',
			expectedSubmissionKind: 'planner',
			cwd: '/repo',
		});

		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(800);

		await expect(runPromise).resolves.toMatchObject({
			toolType: 'claude-code',
			runtimeKind: undefined,
			structuredSubmission: undefined,
			response:
				'{"summary":"Quick test plan.","tasks":[{"title":"Do the thing","description":"Test task","priority":"medium","acceptanceCriteria":["It works"],"dependsOn":[],"scopePaths":[]}]}',
		});
		expect(conversationService.sendTurn).not.toHaveBeenCalled();
	});

	it('uses assistant-stream text for spawned codex worker turns that emit no onData output', async () => {
		spawnBehavior = (sessionId: string) => {
			const match = sessionId.match(/^(.*)-ai-(.*)$/);
			if (!match) {
				throw new Error(`Unexpected target session ID: ${sessionId}`);
			}

			const [, childSessionId, tabId] = match;
			const childSession = useSessionStore
				.getState()
				.sessions.find((candidate) => candidate.id === childSessionId);
			const childTab = childSession?.aiTabs.find((candidate) => candidate.id === tabId);
			if (!childSession || !childTab) {
				throw new Error('Expected Conductor child session to exist before spawn.');
			}

			childSession.state = 'idle';
			childTab.state = 'idle';
			listeners.assistantStream.forEach((callback) =>
				callback(sessionId, {
					mode: 'replace',
					text: '{"outcome":"completed","summary":"Done.","changedPaths":[],"evidence":[],"followUpTasks":[]}',
				})
			);
			listeners.assistantStream.forEach((callback) =>
				callback(sessionId, {
					mode: 'commit',
				})
			);
		};

		const parentSession = {
			id: 'parent-session',
			groupId: 'workspace-1',
			workspaceId: 'workspace-1',
			name: 'Lead Codex',
			toolType: 'codex',
			state: 'idle',
			cwd: '/repo',
			fullPath: '/repo',
			projectRoot: '/repo',
			inputMode: 'ai',
			isGitRepo: true,
			aiTabs: [],
			filePreviewTabs: [],
			unifiedTabOrder: [],
			shellLogs: [],
			workLog: [],
			aiLogs: [],
		} as any;

		const runPromise = runConductorAgentTurn({
			parentSession,
			role: 'worker',
			providerOverride: 'codex',
			prompt: 'Do the task and submit the structured result.',
			taskTitle: 'Smoke test worker',
			cwd: '/repo',
			expectedSubmissionKind: 'worker',
		});

		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(800);

		await expect(runPromise).resolves.toMatchObject({
			toolType: 'codex',
			response:
				'{"outcome":"completed","summary":"Done.","changedPaths":[],"evidence":[],"followUpTasks":[]}',
		});
	});

	it('constrains Claude planner turns to read-only discovery tools', () => {
		const spawnArgs = buildConductorSpawnBaseArgs({
			agentArgs: [
				'--print',
				'--verbose',
				'--output-format',
				'stream-json',
				'--dangerously-skip-permissions',
			],
			toolType: 'claude-code',
			readOnlyMode: true,
			expectedSubmissionKind: 'planner',
		});

		expect(spawnArgs).toEqual(
			expect.arrayContaining([
				'--print',
				'--verbose',
				'--output-format',
				'stream-json',
				'--allowedTools',
				'Read',
				'Glob',
				'Grep',
				'LS',
			])
		);
		expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
	});

	it('does not discard a usable spawn response just because demo capture verification failed', async () => {
		spawnBehavior = (sessionId: string) => {
			const match = sessionId.match(/^(.*)-ai-(.*)$/);
			if (!match) {
				throw new Error(`Unexpected target session ID: ${sessionId}`);
			}

			const [, childSessionId, tabId] = match;
			const childSession = useSessionStore
				.getState()
				.sessions.find((candidate) => candidate.id === childSessionId);
			const childTab = childSession?.aiTabs.find((candidate) => candidate.id === tabId);
			if (!childSession || !childTab) {
				throw new Error('Expected Conductor child session to exist before spawn.');
			}

			childSession.state = 'idle';
			childTab.state = 'idle';
			listeners.data.forEach((callback) =>
				callback(
					sessionId,
					'{"type":"agent_message","content":[{"type":"text","text":"{\\"outcome\\":\\"completed\\",\\"summary\\":\\"Done.\\",\\"changedPaths\\":[],\\"evidence\\":[],\\"followUpTasks\\":[]}"}]}\n'
				)
			);
			listeners.agentError.forEach((callback) =>
				callback(sessionId, {
					type: 'demo_capture_failed',
					message: 'Demo capture completed, but the captured page did not match the requested target.',
				})
			);
		};

		const parentSession = {
			id: 'parent-session',
			groupId: 'workspace-1',
			workspaceId: 'workspace-1',
			name: 'Lead Codex',
			toolType: 'codex',
			state: 'idle',
			cwd: '/repo',
			fullPath: '/repo',
			projectRoot: '/repo',
			inputMode: 'ai',
			isGitRepo: true,
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
			},
			aiTabs: [],
			filePreviewTabs: [],
			unifiedTabOrder: [],
			shellLogs: [],
			workLog: [],
			aiLogs: [],
		} as any;

		const runPromise = runConductorAgentTurn({
			parentSession,
			role: 'worker',
			taskTitle: 'Visit Example.com',
			prompt: 'Complete the task.',
			expectedSubmissionKind: 'worker',
			cwd: '/repo',
		});

		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(800);

		await expect(runPromise).resolves.toMatchObject({
			toolType: 'codex',
			response:
				'{"outcome":"completed","summary":"Done.","changedPaths":[],"evidence":[],"followUpTasks":[]}',
		});
	});

	it('routes Claude worker turns through spawn and accepts JSON fallback output', async () => {
		spawnBehavior = (sessionId: string) => {
			const match = sessionId.match(/^(.*)-ai-(.*)$/);
			if (!match) {
				throw new Error(`Unexpected target session ID: ${sessionId}`);
			}

			const [, childSessionId, tabId] = match;
			const childSession = useSessionStore
				.getState()
				.sessions.find((candidate) => candidate.id === childSessionId);
			const childTab = childSession?.aiTabs.find((candidate) => candidate.id === tabId);
			if (!childSession || !childTab) {
				throw new Error('Expected Conductor child session to exist before spawn.');
			}

			childSession.state = 'idle';
			childTab.state = 'idle';
			listeners.data.forEach((callback) =>
				callback(
					sessionId,
					'{"type":"result","result":"{\\"outcome\\":\\"completed\\",\\"summary\\":\\"Done.\\",\\"changedPaths\\":[],\\"evidence\\":[],\\"followUpTasks\\":[]}"}\n'
				)
			);
			listeners.exit.forEach((callback) => callback(sessionId, 0));
		};
		const parentSession = {
			id: 'parent-session',
			groupId: 'workspace-1',
			workspaceId: 'workspace-1',
			name: 'Lead Claude',
			toolType: 'claude-code',
			state: 'idle',
			cwd: '/repo',
			fullPath: '/repo',
			projectRoot: '/repo',
			inputMode: 'ai',
			isGitRepo: true,
			aiTabs: [],
			filePreviewTabs: [],
			unifiedTabOrder: [],
			shellLogs: [],
			workLog: [],
			aiLogs: [],
		} as any;

		const runPromise = runConductorAgentTurn({
			parentSession,
			role: 'worker',
			providerOverride: 'claude-code',
			prompt: 'Complete the task.',
			expectedSubmissionKind: 'worker',
			cwd: '/repo',
		});

		await expect(runPromise).resolves.toMatchObject({
			toolType: 'claude-code',
			runtimeKind: undefined,
			structuredSubmission: undefined,
			response:
				'{"outcome":"completed","summary":"Done.","changedPaths":[],"evidence":[],"followUpTasks":[]}',
		});
		expect(window.maestro.process.spawn).toHaveBeenCalled();
		expect(conversationService.sendTurn).not.toHaveBeenCalled();
	});
});
