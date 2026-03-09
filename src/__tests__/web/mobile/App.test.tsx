import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const mockColors = {
	accent: '#8b5cf6',
	border: '#374151',
	bgMain: '#1f2937',
	bgSidebar: '#111827',
	textMain: '#f3f4f6',
	textDim: '#9ca3af',
	success: '#22c55e',
	warning: '#f59e0b',
	error: '#ef4444',
};

const mockIsOffline = vi.fn(() => false);
const mockSetDesktopTheme = vi.fn();
const mockConnect = vi.fn();
const mockSend = vi.fn(() => true);
const mockDisconnect = vi.fn();
const mockShowNotification = vi.fn();
const mockAddUnread = vi.fn();
const mockMarkAllRead = vi.fn();
const mockQueueCommand = vi.fn(() => true);
const mockRemoveCommand = vi.fn();
const mockClearQueue = vi.fn();
const mockProcessQueue = vi.fn();
const mockTriggerHaptic = vi.fn();
const mockPersistViewState = vi.fn();
const mockPersistHistoryState = vi.fn();
const mockPersistSessionSelection = vi.fn();
const mockShowLocalServiceWorkerNotification = vi.fn(async () => false);

let mockWebSocketState:
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'authenticating'
	| 'authenticated' = 'connected';
let mockWebSocketError: string | null = null;
let mockReconnectAttempts = 0;
let mockHandlers: Record<string, (...args: unknown[]) => void> = {};
let mockNotificationPermission: NotificationPermission = 'default';
let mockUnreadCount = 0;
let mockQueue: unknown[] = [];
let mockQueueLength = 0;
let mockQueueStatus = 'idle';
let mockSavedState = {
	showAllSessions: false,
	showHistoryPanel: false,
	showTabSearch: false,
	historyFilter: 'all' as const,
	historySearchQuery: '',
	historySearchOpen: false,
	activeSessionId: null as string | null,
	activeTabId: null as string | null,
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('../../../web/main', () => ({
	useOfflineStatus: () => mockIsOffline(),
	useDesktopTheme: () => ({
		desktopTheme: null,
		setDesktopTheme: mockSetDesktopTheme,
	}),
}));

vi.mock('../../../web/hooks/useWebSocket', () => ({
	useWebSocket: ({ handlers }: { handlers: Record<string, (...args: unknown[]) => void> }) => {
		mockHandlers = Object.fromEntries(
			Object.entries(handlers).map(([key, handler]) => [
				key,
				(...args: unknown[]) => act(() => handler(...args)),
			])
		);

		return {
			state: mockWebSocketState,
			connect: mockConnect,
			send: mockSend,
			disconnect: mockDisconnect,
			error: mockWebSocketError,
			reconnectAttempts: mockReconnectAttempts,
		};
	},
}));

vi.mock('../../../web/hooks/useNotifications', () => ({
	useNotifications: () => ({
		permission: mockNotificationPermission,
		showNotification: mockShowNotification,
		requestPermission: vi.fn(async () => mockNotificationPermission),
		declineNotifications: vi.fn(),
		hasPrompted: false,
		hasDeclined: false,
	}),
}));

vi.mock('../../../web/hooks/useUnreadBadge', () => ({
	useUnreadBadge: () => ({
		addUnread: mockAddUnread,
		markRead: vi.fn(),
		markAllRead: mockMarkAllRead,
		clearBadge: vi.fn(),
		unreadCount: mockUnreadCount,
		unreadIds: [],
	}),
}));

vi.mock('../../../web/hooks/useOfflineQueue', () => ({
	useOfflineQueue: () => ({
		queue: mockQueue,
		queueLength: mockQueueLength,
		status: mockQueueStatus,
		queueCommand: mockQueueCommand,
		removeCommand: mockRemoveCommand,
		clearQueue: mockClearQueue,
		processQueue: mockProcessQueue,
	}),
}));

vi.mock('../../../web/hooks/useInstallPrompt', () => ({
	useInstallPrompt: () => ({
		canInstall: false,
		isInstalled: true,
		install: vi.fn(async () => false),
	}),
}));

vi.mock('../../../web/hooks/usePushSubscription', () => ({
	usePushSubscription: () => ({
		isSupported: false,
		isConfigured: false,
		isSubscribed: false,
		isLoading: false,
		error: null,
		subscribe: vi.fn(async () => false),
		unsubscribe: vi.fn(async () => false),
		refresh: vi.fn(async () => undefined),
		sendTestNotification: vi.fn(async () => false),
	}),
}));

vi.mock('../../../web/hooks/useMobileViewState', () => ({
	useMobileViewState: () => ({
		isSmallScreen: false,
		savedState: mockSavedState,
		savedScrollState: {},
		persistViewState: mockPersistViewState,
		persistHistoryState: mockPersistHistoryState,
		persistSessionSelection: mockPersistSessionSelection,
	}),
}));

vi.mock('../../../web/utils/config', () => ({
	buildApiUrl: (endpoint: string) => `http://localhost:3000${endpoint}`,
	getCurrentDemoId: vi.fn(() => null),
	getMaestroConfig: () => ({
		basePath: '/app',
		sessionId: null,
		tabId: null,
		apiBase: '/app/api',
		wsUrl: '/app/ws',
		authMode: 'none',
		clientInstanceId: 'test-instance',
		webPush: { enabled: false },
	}),
	updateUrlForDemo: vi.fn(),
	updateUrlForSessionTab: vi.fn(),
}));

vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: (pattern: number[]) => mockTriggerHaptic(pattern),
	HAPTIC_PATTERNS: {
		tap: [10],
		send: [15],
		interrupt: [20],
		success: [30],
		error: [50],
	},
}));

vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../web/utils/serviceWorker', () => ({
	showLocalServiceWorkerNotification: (...args: unknown[]) =>
		mockShowLocalServiceWorkerNotification(...args),
}));

vi.mock('../../../web/mobile/MobileNavigationDrawer', () => ({
	MobileNavigationDrawer: ({
		isOpen,
		sessions,
		onClose,
		onSelectSession,
		onOpenControls,
		onOpenTabSearch,
		canOpenTabSearch,
	}: {
		isOpen: boolean;
		sessions: Array<{ id: string; name: string }>;
		onClose: () => void;
		onSelectSession: (sessionId: string) => void;
		onOpenControls?: () => void;
		onOpenTabSearch?: () => void;
		canOpenTabSearch: boolean;
	}) =>
		isOpen ? (
			<div data-testid="mobile-navigation-drawer">
				<button data-testid="close-drawer" onClick={onClose}>
					Close
				</button>
				{onOpenControls && (
					<button data-testid="open-controls" onClick={onOpenControls}>
						Controls
					</button>
				)}
				{canOpenTabSearch && onOpenTabSearch && (
					<button data-testid="open-tab-search" onClick={onOpenTabSearch}>
						Chats
					</button>
				)}
				{sessions.map((session) => (
					<button
						key={session.id}
						data-testid={`drawer-session-${session.id}`}
						onClick={() => onSelectSession(session.id)}
					>
						{session.name}
					</button>
				))}
			</div>
		) : null,
}));

vi.mock('../../../web/mobile/ConnectionStatusIndicator', () => ({
	ConnectionStatusIndicator: ({
		connectionState,
		reconnectAttempts,
		error,
		onRetry,
	}: {
		connectionState: string;
		reconnectAttempts: number;
		error?: string | null;
		onRetry: () => void;
	}) => {
		if (connectionState === 'connected' || connectionState === 'authenticated') {
			return null;
		}

		const title =
			connectionState === 'connecting'
				? 'Connecting...'
				: connectionState === 'authenticating'
					? 'Authenticating...'
					: 'Disconnected';

		return (
			<div data-testid="connection-status">
				<div>{title}</div>
				{reconnectAttempts > 0 && <div>{`Attempt ${reconnectAttempts}`}</div>}
				{error && <div>{error}</div>}
				{connectionState === 'disconnected' && <button onClick={onRetry}>Retry</button>}
			</div>
		);
	},
}));

vi.mock('../../../web/mobile/CommandInputBar', () => ({
	CommandInputBar: ({
		isOffline,
		isConnected,
		value,
		onChange,
		onSubmit,
		placeholder,
		disabled,
		inputMode,
		isSessionBusy,
		onInterrupt,
	}: {
		isOffline: boolean;
		isConnected: boolean;
		value: string;
		onChange: (value: string) => void;
		onSubmit: (value: string) => void;
		placeholder: string;
		disabled: boolean;
		inputMode: string;
		isSessionBusy: boolean;
		onInterrupt?: () => void;
	}) => (
		<div data-testid="command-input-bar">
			<input
				data-testid="command-input"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				disabled={disabled}
			/>
			<button data-testid="submit-command" onClick={() => onSubmit(value)}>
				Send
			</button>
			{isSessionBusy && (
				<button data-testid="interrupt-button" onClick={onInterrupt}>
					Interrupt
				</button>
			)}
			<span data-testid="input-mode">{inputMode}</span>
			<span data-testid="is-offline">{isOffline ? 'offline' : 'online'}</span>
			<span data-testid="is-connected">{isConnected ? 'connected' : 'disconnected'}</span>
		</div>
	),
}));

vi.mock('../../../web/mobile/MessageHistory', () => ({
	MessageHistory: ({
		logs,
		inputMode,
	}: {
		logs: Array<{ text?: string; content?: string }>;
		inputMode: string;
	}) => (
		<div data-testid="message-history">
			<span data-testid="logs-count">{logs.length}</span>
			<span data-testid="history-mode">{inputMode}</span>
			<div data-testid="history-text">
				{logs.map((log, index) => (
					<span key={index}>{log.text || log.content || ''}</span>
				))}
			</div>
		</div>
	),
}));

vi.mock('../../../web/mobile/OfflineQueueBanner', () => ({
	OfflineQueueBanner: ({
		queue,
		onClearQueue,
		onProcessQueue,
	}: {
		queue: unknown[];
		onClearQueue: () => void;
		onProcessQueue: () => void;
	}) => (
		<div data-testid="offline-queue-banner">
			<span data-testid="queue-count">{queue.length}</span>
			<button data-testid="clear-queue" onClick={onClearQueue}>
				Clear
			</button>
			<button data-testid="process-queue" onClick={onProcessQueue}>
				Process
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/AutoRunIndicator', () => ({
	AutoRunIndicator: ({ sessionName }: { sessionName?: string }) => (
		<div data-testid="autorun-indicator">{sessionName}</div>
	),
}));

vi.mock('../../../web/mobile/TabBar', () => ({
	TabBar: ({
		tabs,
		activeTabId,
		onSelectTab,
		onNewTab,
		onCloseTab,
	}: {
		tabs: Array<{ id: string; name: string }>;
		activeTabId: string;
		onSelectTab: (tabId: string) => void;
		onNewTab: () => void;
		onCloseTab: (tabId: string) => void;
	}) => (
		<div data-testid="tab-bar">
			{tabs.map((tab) => (
				<button key={tab.id} data-testid={`tab-${tab.id}`} onClick={() => onSelectTab(tab.id)}>
					{tab.name}
				</button>
			))}
			<button data-testid="new-tab" onClick={onNewTab}>
				New
			</button>
			<button data-testid="close-tab" onClick={() => onCloseTab(activeTabId)}>
				Close
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/TabSearchModal', () => ({
	TabSearchModal: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="tab-search-modal">
			<button data-testid="close-tab-search" onClick={onClose}>
				Close
			</button>
		</div>
	),
}));

vi.mock('../../../web/mobile/ResponseViewer', () => ({
	ResponseViewer: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
		isOpen ? (
			<div data-testid="response-viewer">
				<button data-testid="close-response-viewer" onClick={onClose}>
					Close
				</button>
			</div>
		) : null,
}));

import MobileApp from '../../../web/mobile/App';
import type { Session } from '../../../web/hooks/useSessions';

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Session',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/Users/test/project',
		toolType: 'claude-code',
		bookmarked: false,
		groupId: null,
		groupName: null,
		groupEmoji: null,
		aiTabs: undefined,
		activeTabId: undefined,
		agentSessionId: undefined,
		usageStats: undefined,
		supportsModelSelection: false,
		...overrides,
	} as Session;
}

async function pushSessions(sessions: Session[]) {
	await act(async () => {
		mockHandlers.onSessionsUpdate?.(sessions);
	});
}

function setVisibilityState(value: DocumentVisibilityState) {
	Object.defineProperty(document, 'visibilityState', {
		value,
		configurable: true,
	});
}

describe('MobileApp', () => {
	let originalFetch: typeof global.fetch;
	let originalVisibilityState: PropertyDescriptor | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		mockIsOffline.mockReturnValue(false);

		mockWebSocketState = 'connected';
		mockWebSocketError = null;
		mockReconnectAttempts = 0;
		mockHandlers = {};
		mockNotificationPermission = 'default';
		mockUnreadCount = 0;
		mockQueue = [];
		mockQueueLength = 0;
		mockQueueStatus = 'idle';
		mockSavedState = {
			showAllSessions: false,
			showHistoryPanel: false,
			showTabSearch: false,
			historyFilter: 'all',
			historySearchQuery: '',
			historySearchOpen: false,
			activeSessionId: null,
			activeTabId: null,
		};

		originalFetch = global.fetch;
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ session: { aiLogs: [], shellLogs: [] } }),
		} as Response);

		originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
		setVisibilityState('visible');
		window.localStorage?.clear?.();
	});

	afterEach(() => {
		global.fetch = originalFetch;

		if (originalVisibilityState !== undefined) {
			Object.defineProperty(document, 'visibilityState', originalVisibilityState);
		}
	});

	it('exports the mobile app component', () => {
		expect(MobileApp).toBeTypeOf('function');
	});

	it('renders the container and connects on mount', () => {
		const { container } = render(<MobileApp />);

		expect(container.firstChild).toHaveStyle({ display: 'flex', flexDirection: 'column' });
		expect(mockConnect).toHaveBeenCalledTimes(1);
	});

	it('shows the offline state when the device is offline', () => {
		mockIsOffline.mockReturnValue(true);
		mockWebSocketState = 'disconnected';

		render(<MobileApp />);

		expect(screen.getByText("You're Offline")).toBeInTheDocument();
		expect(screen.getByText(/No internet connection/)).toBeInTheDocument();
	});

	it('shows the bootstrapping state before sessions load', () => {
		mockWebSocketState = 'connecting';

		render(<MobileApp />);

		expect(screen.getByText('Syncing with Maestro…')).toBeInTheDocument();
	});

	it('shows the choose-agent prompt when connected without an active session', () => {
		mockWebSocketState = 'authenticated';

		render(<MobileApp />);

		expect(screen.getByText('Choose an agent')).toBeInTheDocument();
		expect(screen.getByText(/Open the navigation drawer/)).toBeInTheDocument();
	});

	it('shows connection details and retries when disconnected', () => {
		mockWebSocketState = 'disconnected';
		mockWebSocketError = 'Connection refused';
		mockReconnectAttempts = 3;

		render(<MobileApp />);

		expect(screen.getByTestId('connection-status')).toHaveTextContent('Disconnected');
		expect(screen.getByTestId('connection-status')).toHaveTextContent('Attempt 3');
		expect(screen.getByTestId('connection-status')).toHaveTextContent('Connection refused');

		fireEvent.click(screen.getByText('Retry'));

		expect(mockConnect).toHaveBeenCalledTimes(2);
	});

	it('opens the navigation drawer and selects a session', async () => {
		render(<MobileApp />);

		await pushSessions([
			createMockSession({ id: 'session-1', name: 'Session 1' }),
			createMockSession({ id: 'session-2', name: 'Session 2' }),
		]);

		fireEvent.click(screen.getByLabelText('Open navigation'));
		expect(await screen.findByTestId('mobile-navigation-drawer')).toBeInTheDocument();

		mockSend.mockClear();
		fireEvent.click(screen.getByTestId('drawer-session-session-2'));

		expect(mockSend).toHaveBeenCalledWith({
			type: 'select_session',
			sessionId: 'session-2',
			tabId: undefined,
		});
	});

	it('submits a command over the websocket when connected', async () => {
		render(<MobileApp />);
		await pushSessions([createMockSession({ id: 'session-1', inputMode: 'ai' })]);

		mockSend.mockClear();
		fireEvent.change(screen.getByTestId('command-input'), {
			target: { value: 'Hello Claude' },
		});
		fireEvent.click(screen.getByTestId('submit-command'));

		expect(mockTriggerHaptic).toHaveBeenCalledWith([15]);
		expect(mockSend).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: 'send_command',
				sessionId: 'session-1',
				command: 'Hello Claude',
				inputMode: 'ai',
			})
		);
	});

	it('queues a command while offline', async () => {
		mockIsOffline.mockReturnValue(true);

		render(<MobileApp />);
		await pushSessions([createMockSession({ id: 'session-1', inputMode: 'ai' })]);

		fireEvent.change(screen.getByTestId('command-input'), {
			target: { value: 'Hello offline' },
		});
		fireEvent.click(screen.getByTestId('submit-command'));

		expect(mockQueueCommand.mock.calls[0]?.slice(0, 3)).toEqual([
			'session-1',
			'Hello offline',
			'ai',
		]);
	});

	it('does not send or queue an empty command', async () => {
		render(<MobileApp />);
		await pushSessions([createMockSession({ id: 'session-1', inputMode: 'ai' })]);

		mockSend.mockClear();
		fireEvent.click(screen.getByTestId('submit-command'));

		expect(mockSend.mock.calls.some((call) => call[0]?.type === 'send_command')).toBe(false);
		expect(mockQueueCommand).not.toHaveBeenCalled();
	});

	it('interrupts a busy session through the API', async () => {
		render(<MobileApp />);
		await pushSessions([createMockSession({ id: 'session-1', state: 'busy' })]);

		(global.fetch as ReturnType<typeof vi.fn>).mockClear();
		fireEvent.click(screen.getByTestId('interrupt-button'));

		await waitFor(() => {
			expect(global.fetch).toHaveBeenCalledWith(
				'http://localhost:3000/session/session-1/interrupt',
				expect.objectContaining({ method: 'POST' })
			);
		});
	});

	it('renders the tab bar and forwards tab actions', async () => {
		render(<MobileApp />);
		await pushSessions([
			createMockSession({
				id: 'session-1',
				inputMode: 'ai',
				aiTabs: [
					{ id: 'tab-1', name: 'Tab 1', state: 'idle' },
					{ id: 'tab-2', name: 'Tab 2', state: 'idle' },
				],
				activeTabId: 'tab-1',
			}),
		]);

		mockSend.mockClear();
		fireEvent.click(screen.getByTestId('tab-tab-2'));
		fireEvent.click(screen.getByTestId('new-tab'));
		fireEvent.click(screen.getByTestId('close-tab'));

		expect(mockSend.mock.calls).toEqual(
			expect.arrayContaining([
				[{ type: 'select_tab', sessionId: 'session-1', tabId: 'tab-2' }],
				[{ type: 'new_tab', sessionId: 'session-1' }],
				[
					expect.objectContaining({
						type: 'close_tab',
						sessionId: 'session-1',
						tabId: expect.stringMatching(/^pending-tab-/),
					}),
				],
			])
		);
	});

	it('opens and closes the tab search modal from the drawer', async () => {
		render(<MobileApp />);
		await pushSessions([
			createMockSession({
				id: 'session-1',
				inputMode: 'ai',
				aiTabs: [
					{ id: 'tab-1', name: 'Tab 1', state: 'idle' },
					{ id: 'tab-2', name: 'Tab 2', state: 'idle' },
				],
				activeTabId: 'tab-1',
			}),
		]);

		fireEvent.click(screen.getByLabelText('Open navigation'));
		fireEvent.click(await screen.findByTestId('open-tab-search'));

		expect(await screen.findByTestId('tab-search-modal')).toBeInTheDocument();
		fireEvent.click(screen.getByTestId('close-tab-search'));
		await waitFor(() => {
			expect(screen.queryByTestId('tab-search-modal')).not.toBeInTheDocument();
		});
	});

	it('renders message history when session output arrives', async () => {
		render(<MobileApp />);
		await pushSessions([createMockSession({ id: 'session-1', inputMode: 'ai' })]);

		await act(async () => {
			mockHandlers.onSessionOutput?.('session-1', 'Hello from AI', 'ai');
		});

		expect(screen.getByTestId('message-history')).toBeInTheDocument();
		expect(screen.getByTestId('history-text')).toHaveTextContent('Hello from AI');
	});

	it('renders the offline queue banner when commands are queued', async () => {
		mockQueue = [{ id: 'queued-1', command: 'echo hi' }];
		mockQueueLength = 1;

		render(<MobileApp />);
		await pushSessions([createMockSession({ id: 'session-1', inputMode: 'ai' })]);

		expect(screen.getByTestId('offline-queue-banner')).toBeInTheDocument();
		expect(screen.getByTestId('queue-count')).toHaveTextContent('1');
	});

	it('shows a notification for a completed response when the page is hidden', async () => {
		mockNotificationPermission = 'granted';
		setVisibilityState('hidden');

		render(<MobileApp />);

		await act(async () => {
			mockHandlers.onResponseCompleted?.({
				eventId: 'evt-1',
				sessionId: 'session-1',
				tabId: 'tab-1',
				sessionName: 'Session 1',
				toolType: 'claude-code',
				completedAt: Date.now(),
				title: 'Response ready',
				body: 'The build finished.',
				deepLinkUrl: '/app/session-1/tab-1',
			});
		});

		await waitFor(() => {
			expect(mockAddUnread).toHaveBeenCalledWith('evt-1');
			expect(mockShowNotification).toHaveBeenCalledWith(
				'Response ready',
				expect.objectContaining({
					body: 'The build finished.',
					tag: 'maestro-response-evt-1',
				})
			);
		});
	});

	it('does not show a notification when the page is visible', async () => {
		mockNotificationPermission = 'granted';

		render(<MobileApp />);

		await act(async () => {
			mockHandlers.onResponseCompleted?.({
				eventId: 'evt-2',
				sessionId: 'session-1',
				tabId: null,
				sessionName: 'Session 1',
				toolType: 'claude-code',
				completedAt: Date.now(),
				title: 'Response ready',
				body: 'Visible page should skip notifications.',
				deepLinkUrl: '/app/session-1',
			});
		});

		expect(mockShowNotification).not.toHaveBeenCalled();
	});

	it('navigates tabs with keyboard shortcuts', async () => {
		render(<MobileApp />);
		await pushSessions([
			createMockSession({
				id: 'session-1',
				inputMode: 'ai',
				aiTabs: [
					{ id: 'tab-1', name: 'Tab 1', state: 'idle' },
					{ id: 'tab-2', name: 'Tab 2', state: 'idle' },
					{ id: 'tab-3', name: 'Tab 3', state: 'idle' },
				],
				activeTabId: 'tab-2',
			}),
		]);

		mockSend.mockClear();
		fireEvent.keyDown(document, { key: '[', metaKey: true });
		fireEvent.keyDown(document, { key: ']', metaKey: true });

		expect(mockSend.mock.calls).toEqual(
			expect.arrayContaining([
				[{ type: 'select_tab', sessionId: 'session-1', tabId: 'tab-1' }],
				[{ type: 'select_tab', sessionId: 'session-1', tabId: 'tab-2' }],
			])
		);
	});

	it('fetches logs for the active session and tab', async () => {
		render(<MobileApp />);

		await pushSessions([
			createMockSession({
				id: 'session-1',
				inputMode: 'ai',
				aiTabs: [{ id: 'tab-1', name: 'Tab 1', state: 'idle' }],
				activeTabId: 'tab-1',
			}),
		]);

		await waitFor(() => {
			expect(global.fetch).toHaveBeenCalledWith(
				'http://localhost:3000/session/session-1?tabId=tab-1',
				expect.objectContaining({ cache: 'no-store' })
			);
		});
	});

	it('persists session selection when the active session changes', async () => {
		render(<MobileApp />);

		await pushSessions([
			createMockSession({ id: 'session-1', name: 'Session 1' }),
			createMockSession({ id: 'session-2', name: 'Session 2' }),
		]);

		fireEvent.click(screen.getByLabelText('Open navigation'));
		fireEvent.click(await screen.findByTestId('drawer-session-session-2'));

		expect(mockPersistSessionSelection).toHaveBeenCalledWith({
			activeSessionId: 'session-2',
			activeTabId: null,
		});
	});
});
