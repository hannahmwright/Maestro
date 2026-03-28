import type { SVGProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CollapsedSessionPill } from '../../../../renderer/components/SessionList/CollapsedSessionPill';
import type { Session, Theme, Thread } from '../../../../renderer/types';

vi.mock('lucide-react', () => ({
	Loader2: (props: SVGProps<SVGSVGElement>) => <svg data-testid="loader2" {...props} />,
	Folder: () => <svg data-testid="folder-icon" />,
	GitBranch: () => <svg data-testid="git-icon" />,
	Bot: () => <svg data-testid="bot-icon" />,
	Clock: () => <svg data-testid="clock-icon" />,
	Server: () => <svg data-testid="server-icon" />,
}));

const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e0e0e0',
		textDim: '#888888',
		accent: '#e94560',
		accentForeground: '#ffffff',
		border: '#333333',
		error: '#ff4444',
		success: '#00cc66',
		warning: '#ffaa00',
	},
} as Theme;

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		runtimeId: 'runtime-1',
		name: 'Session 1',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/tmp/project',
		fullPath: '/tmp/project',
		projectRoot: '/tmp/project',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		activeTimeMs: 0,
		aiTabs: [
			{
				id: 'tab-1',
				name: null,
				logs: [],
				state: 'idle',
				hasUnread: false,
			} as any,
		],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		...overrides,
	} as Session;
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
	return {
		id: 'thread-1',
		workspaceId: 'workspace-1',
		sessionId: 'session-1',
		runtimeId: 'runtime-1',
		tabId: 'tab-1',
		title: 'Main Thread',
		agentId: 'claude-code',
		projectRoot: '/tmp/project',
		pinned: false,
		archived: false,
		isOpen: true,
		createdAt: 1,
		lastUsedAt: 1,
		...overrides,
	};
}

function createDefaultProps(
	overrides: Partial<React.ComponentProps<typeof CollapsedSessionPill>> = {}
) {
	return {
		thread: makeThread(),
		session: makeSession(),
		keyPrefix: 'test',
		theme: mockTheme,
		activeBatchSessionIds: [] as string[],
		leftSidebarWidth: 300,
		contextWarningYellowThreshold: 70,
		contextWarningRedThreshold: 90,
		getFileCount: vi.fn(() => 0),
		displayName: 'Main Thread',
		onSelect: vi.fn(),
		...overrides,
	};
}

describe('CollapsedSessionPill', () => {
	it('renders a selectable segment and tooltip content', () => {
		const props = createDefaultProps();
		render(<CollapsedSessionPill {...props} />);

		expect(screen.getByRole('button', { name: 'Switch to Main Thread' })).toBeInTheDocument();
		expect(screen.getByText('Main Thread')).toBeInTheDocument();
	});

	it('calls onSelect and stops propagation on click', () => {
		const parentClick = vi.fn();
		const props = createDefaultProps();
		render(
			<div onClick={parentClick}>
				<CollapsedSessionPill {...props} />
			</div>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Switch to Main Thread' }));

		expect(props.onSelect).toHaveBeenCalledTimes(1);
		expect(parentClick).not.toHaveBeenCalled();
	});

	it('shows the awaiting-input indicator when the thread tab has unread content', () => {
		const session = makeSession({
			aiTabs: [{ id: 'tab-1', logs: [], state: 'idle', hasUnread: true } as any],
		});
		const props = createDefaultProps({ session });
		render(<CollapsedSessionPill {...props} />);

		expect(screen.getByTitle('Awaiting your input')).toBeInTheDocument();
	});

	it('falls back to the active tab when the thread has no tabId', () => {
		const session = makeSession({
			activeTabId: 'tab-2',
			aiTabs: [
				{ id: 'tab-1', logs: [], state: 'idle', hasUnread: false } as any,
				{ id: 'tab-2', logs: [], state: 'idle', hasUnread: true } as any,
			],
		});
		const thread = makeThread({ tabId: undefined });
		const props = createDefaultProps({ session, thread });
		render(<CollapsedSessionPill {...props} />);

		expect(screen.getByTitle('Awaiting your input')).toBeInTheDocument();
	});

	it('shows a spinner when the target thread tab is busy', () => {
		const session = makeSession({
			aiTabs: [{ id: 'tab-1', logs: [], state: 'busy', hasUnread: false } as any],
		});
		const props = createDefaultProps({ session });
		render(<CollapsedSessionPill {...props} />);

		expect(screen.getByTitle('Agent is working')).toBeInTheDocument();
		expect(screen.getByTestId('loader2')).toHaveClass('animate-spin');
	});

	it('shows a spinner when the session is in an active batch', () => {
		const props = createDefaultProps({ activeBatchSessionIds: ['session-1'] });
		render(<CollapsedSessionPill {...props} />);

		expect(screen.getByTitle('Agent is working')).toBeInTheDocument();
	});
});
