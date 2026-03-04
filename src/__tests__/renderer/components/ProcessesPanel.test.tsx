import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ProcessesPanel } from '../../../renderer/components/ProcessesPanel';
import type { Session, Theme } from '../../../renderer/types';

interface ActiveProcessInfo {
	sessionId: string;
	toolType: string;
	pid: number;
	cwd: string;
	isTerminal: boolean;
	isBatchMode: boolean;
	startTime?: number;
	command?: string;
	args?: string[];
}

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#1e1f29',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: 'rgba(189, 147, 249, 0.2)',
		accentText: '#bd93f9',
		accentForeground: '#f8f8f2',
		success: '#50fa7b',
		warning: '#f1fa8c',
		error: '#ff5555',
	},
};

const createSession = (overrides: Partial<Session> = {}): Session => {
	const baseTab = {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 1700000000000,
		state: 'idle' as const,
		saveToHistory: true,
		showThinking: 'sticky' as const,
	};

	return {
		id: 'session-1',
		name: 'Main Session',
		toolType: 'codex',
		state: 'idle',
		cwd: '/repo/main',
		fullPath: '/repo/main',
		projectRoot: '/repo/main',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 101,
		terminalPid: 201,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		aiTabs: [baseTab],
		activeTabId: baseTab.id,
		closedTabHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		...overrides,
	} as Session;
};

describe('ProcessesPanel', () => {
	const onNavigateToSession = vi.fn();
	const getActiveProcessesMock = vi.fn<() => Promise<ActiveProcessInfo[]>>();
	const killMock = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();

		window.maestro = {
			...window.maestro,
			process: {
				...window.maestro.process,
				getActiveProcesses: getActiveProcessesMock,
				kill: killMock,
			},
		} as typeof window.maestro;
	});
	it('groups parallel runs under a single session card', async () => {
		const now = Date.now();
		getActiveProcessesMock.mockResolvedValue([
			{
				sessionId: 'session-1-ai-tab-1',
				toolType: 'codex',
				pid: 3001,
				cwd: '/repo/main',
				isTerminal: false,
				isBatchMode: true,
				startTime: now - 30_000,
				command: 'codex',
				args: ['exec'],
			},
			{
				sessionId: 'session-1-ai-tab-2',
				toolType: 'codex',
				pid: 3002,
				cwd: '/repo/main',
				isTerminal: false,
				isBatchMode: true,
				startTime: now - 20_000,
				command: 'codex',
				args: ['exec'],
			},
		]);

		const session = createSession({
			aiTabs: [
				{
					id: 'tab-1',
					agentSessionId: null,
					name: 'Research',
					starred: false,
					logs: [],
					inputValue: '',
					stagedImages: [],
					createdAt: 1700000000000,
					state: 'idle',
					saveToHistory: true,
					showThinking: 'sticky',
				},
				{
					id: 'tab-2',
					agentSessionId: null,
					name: 'Follow-up',
					starred: false,
					logs: [],
					inputValue: '',
					stagedImages: [],
					createdAt: 1700000001000,
					state: 'idle',
					saveToHistory: true,
					showThinking: 'sticky',
				},
			],
			activeTabId: 'tab-1',
		});

		render(
			<ProcessesPanel
				theme={mockTheme}
				activeSession={session}
				sessions={[session]}
				onNavigateToSession={onNavigateToSession}
			/>
		);

		await waitFor(() => {
			expect(screen.getByText('Main Session')).toBeInTheDocument();
		});

		expect(screen.getByText('2 runs')).toBeInTheDocument();
		expect(screen.getByText('AI Tab · Research')).toBeInTheDocument();
		expect(screen.getByText('AI Tab · Follow-up')).toBeInTheDocument();
		expect(screen.getAllByText('Open Run')).toHaveLength(2);
	});

	it('shows same-agent sessions when scope switches to All agent', async () => {
		getActiveProcessesMock.mockResolvedValue([
			{
				sessionId: 'session-1-ai-tab-1',
				toolType: 'codex',
				pid: 3101,
				cwd: '/repo/main',
				isTerminal: false,
				isBatchMode: true,
				startTime: Date.now() - 15_000,
				command: 'codex',
			},
			{
				sessionId: 'session-2-ai-tab-2',
				toolType: 'codex',
				pid: 3201,
				cwd: '/repo/other',
				isTerminal: false,
				isBatchMode: true,
				startTime: Date.now() - 10_000,
				command: 'codex',
			},
		]);

		const session1 = createSession({
			id: 'session-1',
			name: 'Main Session',
		});
		const session2 = createSession({
			id: 'session-2',
			name: 'Other Session',
			cwd: '/repo/other',
			fullPath: '/repo/other',
			projectRoot: '/repo/other',
		});

		render(
			<ProcessesPanel
				theme={mockTheme}
				activeSession={session1}
				sessions={[session1, session2]}
				onNavigateToSession={onNavigateToSession}
			/>
		);

		await waitFor(() => {
			expect(screen.getByText('Main Session')).toBeInTheDocument();
		});
		expect(screen.queryByText('Other Session')).not.toBeInTheDocument();

		fireEvent.click(screen.getByText('All CODEX'));

		await waitFor(() => {
			expect(screen.getByText('Other Session')).toBeInTheDocument();
		});
	});

	it('kills a selected run from its nested card', async () => {
		getActiveProcessesMock.mockResolvedValue([
			{
				sessionId: 'session-1-ai-tab-1',
				toolType: 'codex',
				pid: 3301,
				cwd: '/repo/main',
				isTerminal: false,
				isBatchMode: true,
				startTime: Date.now() - 5_000,
				command: 'codex',
			},
		]);
		killMock.mockResolvedValue(undefined);

		const session = createSession();

		render(
			<ProcessesPanel
				theme={mockTheme}
				activeSession={session}
				sessions={[session]}
				onNavigateToSession={onNavigateToSession}
			/>
		);

		await waitFor(() => {
			expect(screen.getByText('Open Run')).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTitle('Stop this process'));

		await waitFor(() => {
			expect(killMock).toHaveBeenCalledWith('session-1-ai-tab-1');
		});
		expect(getActiveProcessesMock).toHaveBeenCalledTimes(2);
	});
});
