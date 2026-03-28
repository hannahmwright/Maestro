import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SessionList } from '../../../renderer/components/SessionList';
import type { Group, Session, Theme, Thread } from '../../../renderer/types';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useConductorStore } from '../../../renderer/stores/conductorStore';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { useSettingsStore, DEFAULT_AUTO_RUN_STATS } from '../../../renderer/stores/settingsStore';

const mockModalActions = {
	setAboutModalOpen: vi.fn(),
	setRenameInstanceModalOpen: vi.fn(),
	setRenameInstanceValue: vi.fn(),
	setRenameInstanceSessionId: vi.fn(),
	setDuplicatingSessionId: vi.fn(),
	setNewInstanceModalOpen: vi.fn(),
	setNewInstanceMode: vi.fn(),
	setNewInstanceWorkspaceId: vi.fn(),
	setNewInstanceFixedWorkingDir: vi.fn(),
	setNewInstanceDefaultAgentId: vi.fn(),
};

vi.mock('../../../renderer/stores/modalStore', async (importActual) => {
	const actual = await importActual<typeof import('../../../renderer/stores/modalStore')>();
	return {
		...actual,
		getModalActions: () => mockModalActions,
	};
});

vi.mock('../../../renderer/contexts/GitStatusContext', () => ({
	useGitFileStatus: () => ({
		getFileCount: () => 0,
	}),
}));

vi.mock('../../../renderer/hooks', async (importActual) => {
	const actual = await importActual<typeof import('../../../renderer/hooks')>();
	return {
		...actual,
		useResizablePanel: () => ({
			panelRef: { current: null },
			isResizing: false,
			onResizeStart: vi.fn(),
			transitionClass: '',
		}),
		useLiveOverlay: () => ({
			liveOverlayOpen: false,
			setLiveOverlayOpen: vi.fn(),
			liveOverlayRef: { current: null },
			cloudflaredInstalled: true,
			cloudflaredChecked: true,
			tunnelStatus: 'off',
			tunnelUrl: null,
			tunnelError: null,
			activeUrlTab: 'local',
			setActiveUrlTab: vi.fn(),
			copyFlash: null,
			setCopyFlash: vi.fn(),
			handleTunnelToggle: vi.fn(),
		}),
	};
});

vi.mock('../../../renderer/components/SessionItem', () => ({
	SessionItem: ({ displayName, onSelect }: { displayName: string; onSelect: () => void }) => (
		<button type="button" data-testid="session-item" onClick={onSelect}>
			{displayName}
		</button>
	),
}));

vi.mock('../../../renderer/components/GroupChatList', () => ({
	GroupChatList: () => <div data-testid="group-chat-list">group chats</div>,
}));

vi.mock('../../../renderer/components/SessionList/SessionContextMenu', () => ({
	SessionContextMenu: () => null,
}));

vi.mock('../../../renderer/components/SessionList/GroupContextMenu', () => ({
	GroupContextMenu: () => null,
}));

vi.mock('../../../renderer/components/SessionList/HamburgerMenuContent', () => ({
	HamburgerMenuContent: () => <div data-testid="hamburger-menu-content" />,
}));

vi.mock('../../../renderer/components/SessionList/CollapsedSessionPill', () => ({
	CollapsedSessionPill: () => <div data-testid="collapsed-session-pill" />,
}));

vi.mock('../../../renderer/components/SessionList/LiveOverlayPanel', () => ({
	LiveOverlayPanel: () => <div data-testid="live-overlay-panel" />,
}));

vi.mock('../../../renderer/components/SessionList/SkinnySidebar', () => ({
	SkinnySidebar: ({ threadItems }: { threadItems: Array<unknown> }) => (
		<div data-testid="skinny-sidebar">{threadItems.length}</div>
	),
}));

const theme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentForeground: '#f8f8f2',
		border: '#44475a',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
		info: '#8be9fd',
	},
} as Theme;

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Alpha Agent',
		toolType: 'codex',
		state: 'idle',
		cwd: '/tmp/alpha',
		fullPath: '/tmp/alpha',
		projectRoot: '/tmp/alpha',
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
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [
			{
				id: 'tab-1',
				name: 'Thread One',
				logs: [],
				hasUnread: false,
				state: 'idle',
			},
		],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

function createWorkspace(overrides: Partial<Group> = {}): Group {
	return {
		id: 'workspace-1',
		name: 'Alpha Workspace',
		emoji: '📁',
		collapsed: false,
		archived: false,
		projectRoot: '/tmp/alpha',
		lastUsedAt: 0,
		...overrides,
	} as Group;
}

function createThread(overrides: Partial<Thread> = {}): Thread {
	return {
		id: 'thread-1',
		workspaceId: 'workspace-1',
		sessionId: 'session-1',
		runtimeId: 'session-1',
		tabId: 'tab-1',
		title: 'Thread One',
		agentId: 'codex',
		projectRoot: '/tmp/alpha',
		pinned: false,
		archived: false,
		isOpen: true,
		createdAt: 1,
		lastUsedAt: 1,
		...overrides,
	} as Thread;
}

function createProps(overrides: Partial<Parameters<typeof SessionList>[0]> = {}) {
	return {
		theme,
		isLiveMode: false,
		webInterfaceUrl: null,
		toggleGlobalLive: vi.fn().mockResolvedValue(undefined),
		restartWebServer: vi.fn().mockResolvedValue(null),
		toggleGroup: vi.fn(),
		handleDragStart: vi.fn(),
		finishRenamingGroup: vi.fn(),
		startRenamingGroup: vi.fn(),
		startRenamingSession: vi.fn(),
		createNewGroup: vi.fn(),
		addNewSession: vi.fn(),
		onCreateSession: vi.fn().mockResolvedValue(undefined),
		onEditAgent: vi.fn(),
		onNewAgentSession: vi.fn(),
		onOpenGroupChat: vi.fn(),
		onNewGroupChat: vi.fn(),
		onEditGroupChat: vi.fn(),
		onRenameGroupChat: vi.fn(),
		onDeleteGroupChat: vi.fn(),
		onArchiveGroupChat: vi.fn(),
		...overrides,
	};
}

describe('SessionList', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		useSessionStore.setState({
			sessions: [],
			groups: [],
			threads: [],
			activeSessionId: '',
			cyclePosition: -1,
		} as Partial<ReturnType<typeof useSessionStore.getState>>);

		useUIStore.setState({
			leftSidebarOpen: true,
			leftSidebarHidden: false,
			activeFocus: 'main',
			selectedSidebarIndex: -1,
			editingGroupId: null,
			editingSessionId: null,
			draggingSessionId: null,
			groupChatsExpanded: false,
			sessionFilterOpen: false,
			bookmarksCollapsed: false,
			sidebarThreadTargets: [],
			sidebarNavTargets: [],
		} as Partial<ReturnType<typeof useUIStore.getState>>);

		useGroupChatStore.setState({
			groupChats: [],
			activeGroupChatId: null,
			groupChatState: 'idle',
			participantStates: {},
			groupChatStates: {},
			allGroupChatParticipantStates: {},
		} as Partial<ReturnType<typeof useGroupChatStore.getState>>);

		useConductorStore.setState({
			activeConductorView: null,
		} as Partial<ReturnType<typeof useConductorStore.getState>>);

		useBatchStore.setState({
			batchRunStates: {},
		} as Partial<ReturnType<typeof useBatchStore.getState>>);

		useSettingsStore.setState({
			shortcuts: {
				toggleSidebar: { keys: ['meta', 'b'], description: 'Toggle sidebar' },
				openWizard: { keys: ['meta', 'shift', 'n'], description: 'New Project' },
			},
			leftSidebarWidth: 300,
			workspaceSortMode: 'recent',
			defaultThreadProvider: 'codex',
			defaultSaveToHistory: true,
			defaultShowThinking: 'sticky',
			webInterfaceUseCustomPort: false,
			webInterfaceCustomPort: 0,
			autoRunStats: { ...DEFAULT_AUTO_RUN_STATS },
			contextManagementSettings: {
				...useSettingsStore.getState().contextManagementSettings,
				contextWarningYellowThreshold: 75,
				contextWarningRedThreshold: 90,
			},
		} as Partial<ReturnType<typeof useSettingsStore.getState>>);
	});

	it('shows the empty workspace state when there are no workspaces', () => {
		render(<SessionList {...createProps()} />);

		expect(screen.getByText('Workspaces')).toBeInTheDocument();
		expect(screen.getByText('No workspaces yet.')).toBeInTheDocument();
	});

	it('opens the new workspace modal from the header action', () => {
		render(<SessionList {...createProps()} />);

		fireEvent.click(screen.getByTitle('New Workspace'));

		expect(mockModalActions.setNewInstanceModalOpen).toHaveBeenCalledWith(true);
		expect(mockModalActions.setNewInstanceMode).toHaveBeenCalledWith('workspace');
		expect(mockModalActions.setNewInstanceWorkspaceId).toHaveBeenCalledWith(null);
		expect(mockModalActions.setNewInstanceFixedWorkingDir).toHaveBeenCalledWith(null);
		expect(mockModalActions.setNewInstanceDefaultAgentId).toHaveBeenCalledWith(null);
		expect(mockModalActions.setDuplicatingSessionId).toHaveBeenCalledWith(null);
	});

	it('restores the sidebar when the hidden-sidebar affordance is clicked', () => {
		useUIStore.setState({
			leftSidebarHidden: true,
			leftSidebarOpen: false,
		} as Partial<ReturnType<typeof useUIStore.getState>>);

		render(<SessionList {...createProps()} />);

		fireEvent.click(screen.getByRole('button', { name: 'Show Sidebar' }));

		expect(useUIStore.getState().leftSidebarHidden).toBe(false);
		expect(useUIStore.getState().leftSidebarOpen).toBe(true);
	});

	it('renders workspaces and wires the workspace controls to current handlers', () => {
		const toggleGroup = vi.fn();
		const onOpenConductor = vi.fn();
		useSessionStore.setState({
			groups: [createWorkspace()],
		} as Partial<ReturnType<typeof useSessionStore.getState>>);

		render(
			<SessionList
				{...createProps({
					toggleGroup,
					onOpenConductor,
				})}
			/>
		);

		expect(screen.getByText('Alpha Workspace')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Collapse workspace'));
		expect(toggleGroup).toHaveBeenCalledWith('workspace-1');

		fireEvent.click(screen.getByTitle('Open Alpha Workspace kanban'));
		expect(onOpenConductor).toHaveBeenCalledWith('workspace-1');
	});

	it('creates a new thread for a workspace via onCreateSession when no reusable thread exists', async () => {
		const onCreateSession = vi.fn().mockResolvedValue(undefined);
		useSessionStore.setState({
			groups: [createWorkspace()],
		} as Partial<ReturnType<typeof useSessionStore.getState>>);

		render(<SessionList {...createProps({ onCreateSession })} />);

		fireEvent.click(screen.getByTitle('New Thread'));

		await waitFor(() => {
			expect(onCreateSession).toHaveBeenCalledWith(
				'codex',
				'/tmp/alpha',
				'Codex Thread',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				'workspace-1'
			);
		});
	});

	it('shows the group chat section once at least two AI sessions exist', () => {
		useSessionStore.setState({
			sessions: [
				createSession({ id: 'session-1', name: 'Alpha Agent' }),
				createSession({
					id: 'session-2',
					name: 'Beta Agent',
					activeTabId: 'tab-2',
					aiTabs: [
						{
							id: 'tab-2',
							name: 'Beta Thread',
							logs: [],
							hasUnread: false,
							state: 'idle',
						},
					],
				}),
			],
		} as Partial<ReturnType<typeof useSessionStore.getState>>);

		render(<SessionList {...createProps()} />);

		expect(screen.getByTestId('group-chat-list')).toBeInTheDocument();
	});

	it('renders skinny mode from visible thread targets when the sidebar is collapsed', () => {
		useUIStore.setState({
			leftSidebarOpen: false,
		} as Partial<ReturnType<typeof useUIStore.getState>>);
		useSessionStore.setState({
			groups: [createWorkspace()],
			sessions: [createSession()],
			threads: [createThread()],
			activeSessionId: 'session-1',
		} as Partial<ReturnType<typeof useSessionStore.getState>>);

		render(<SessionList {...createProps()} />);

		expect(screen.getByTestId('skinny-sidebar')).toHaveTextContent('2');
	});
});
