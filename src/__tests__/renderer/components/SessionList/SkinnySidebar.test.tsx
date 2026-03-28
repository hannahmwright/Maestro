import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	SkinnySidebar,
	type SkinnySidebarThreadItem,
} from '../../../../renderer/components/SessionList/SkinnySidebar';
import type { Session, Theme, Thread } from '../../../../renderer/types';

const theme: Theme = {
	name: 'test',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgInput: '#0f3460',
		textMain: '#e0e0e0',
		textDim: '#888888',
		accent: '#e94560',
		border: '#333333',
		error: '#ff4444',
		success: '#00cc66',
		warning: '#ffaa00',
	},
} as Theme;

const createSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'session-1',
		name: 'Workspace Agent',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/tmp',
		projectRoot: '/tmp',
		inputMode: 'ai',
		aiTabs: [{ id: 'tab-1', name: 'Main', logs: [], hasUnread: false }],
		activeTabId: 'tab-1',
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		...overrides,
	}) as Session;

const createThread = (overrides: Partial<Thread> = {}): Thread =>
	({
		id: 'thread-1',
		title: 'Thread One',
		sessionId: 'session-1',
		workspaceId: 'workspace-1',
		tabId: 'tab-1',
		updatedAt: Date.now(),
		...overrides,
	}) as Thread;

const createThreadItem = (
	overrides: Partial<SkinnySidebarThreadItem> = {}
): SkinnySidebarThreadItem => {
	const session = overrides.session || createSession();
	const thread = overrides.thread || createThread({ sessionId: session.id });
	return {
		target: {
			id: 'target-1',
			threadId: thread.id,
			sessionId: session.id,
			runtimeId: `runtime-${session.id}`,
			workspaceId: 'workspace-1',
			tabId: 'tab-1',
		},
		thread,
		session,
		displayName: 'Workspace Agent',
		...overrides,
	};
};

const renderSidebar = (props: Partial<React.ComponentProps<typeof SkinnySidebar>> = {}) =>
	render(
		<SkinnySidebar
			theme={theme}
			threadItems={[]}
			activeThreadTargetId={null}
			activeBatchSessionIds={[]}
			contextWarningYellowThreshold={70}
			contextWarningRedThreshold={90}
			getFileCount={() => 0}
			openThreadTarget={vi.fn()}
			handleContextMenu={vi.fn()}
			{...props}
		/>
	);

describe('SkinnySidebar', () => {
	it('renders nothing when there are no thread items', () => {
		const { container } = renderSidebar();
		expect(container.firstElementChild?.children.length).toBe(0);
	});

	it('renders one switch target per thread item', () => {
		renderSidebar({
			threadItems: [
				createThreadItem(),
				createThreadItem({
					target: { ...createThreadItem().target, id: 'target-2', threadId: 'thread-2' },
					thread: createThread({ id: 'thread-2' }),
				}),
			],
		});

		expect(screen.getAllByRole('button')).toHaveLength(2);
	});

	it('opens the selected thread target when clicked', () => {
		const openThreadTarget = vi.fn();
		const item = createThreadItem();
		renderSidebar({
			threadItems: [item],
			openThreadTarget,
		});

		fireEvent.click(screen.getByRole('button', { name: 'Switch to Workspace Agent' }));
		expect(openThreadTarget).toHaveBeenCalledWith(item.target);
	});

	it('forwards the context menu with session and thread ids', () => {
		const handleContextMenu = vi.fn();
		const item = createThreadItem();
		renderSidebar({
			threadItems: [item],
			handleContextMenu,
		});

		fireEvent.contextMenu(screen.getByRole('button', { name: 'Switch to Workspace Agent' }));
		expect(handleContextMenu).toHaveBeenCalled();
		expect(handleContextMenu.mock.calls[0][1]).toBe(item.session.id);
		expect(handleContextMenu.mock.calls[0][2]).toBe(item.target.threadId);
	});

	it('shows a working spinner for active batch thread items', () => {
		const item = createThreadItem();
		renderSidebar({
			threadItems: [item],
			activeBatchSessionIds: [item.session.id],
		});

		expect(screen.getByTitle('Agent is working')).toBeInTheDocument();
	});

	it('shows an unread indicator when the thread has unread tab state', () => {
		renderSidebar({
			threadItems: [
				createThreadItem({
					session: createSession({
						aiTabs: [{ id: 'tab-1', name: 'Main', logs: [], hasUnread: true }],
						activeTabId: 'tab-1',
					}),
				}),
			],
		});

		expect(screen.getByTitle('Awaiting your input')).toBeInTheDocument();
	});
});
