import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputArea } from '../../../renderer/components/InputArea';
import type { Session, Theme } from '../../../renderer/types';

const { mockUpdateSession } = vi.hoisted(() => ({
	mockUpdateSession: vi.fn(),
}));

vi.mock('../../../renderer/hooks', () => ({
	useAgentCapabilities: () => ({
		hasCapability: (capability: string) =>
			capability === 'supportsReadOnlyMode' ||
			capability === 'supportsReasoningEffort' ||
			capability === 'supportsImageInput',
		capabilities: {
			supportsReadOnlyMode: true,
			supportsReasoningEffort: true,
			supportsModelSelection: false,
		},
	}),
	useScrollIntoView: () => ({
		scrollTargetRef: { current: null },
		scrollIntoView: vi.fn(),
	}),
	useAvailableAgents: () => ({
		agents: [],
	}),
}));

vi.mock('../../../renderer/stores/sessionStore', () => ({
	useSessionStore: (
		selector: (state: {
			updateSession: typeof mockUpdateSession;
			updateThread: ReturnType<typeof vi.fn>;
			sessions: unknown[];
			threads: unknown[];
		}) => unknown
	) =>
		selector({
			updateSession: mockUpdateSession,
			updateThread: vi.fn(),
			sessions: [],
			threads: [],
		}),
}));

vi.mock('../../../renderer/components/ThinkingStatusPill', () => ({
	ThinkingStatusPill: () => null,
}));
vi.mock('../../../renderer/components/MergeProgressOverlay', () => ({
	MergeProgressOverlay: () => null,
}));
vi.mock('../../../renderer/components/ExecutionQueueIndicator', () => ({
	ExecutionQueueIndicator: () => null,
}));
vi.mock('../../../renderer/components/ContextWarningSash', () => ({
	ContextWarningSash: () => null,
}));
vi.mock('../../../renderer/components/SummarizeProgressOverlay', () => ({
	SummarizeProgressOverlay: () => null,
}));
vi.mock('../../../renderer/components/InlineWizard', () => ({
	WizardInputPanel: () => null,
}));

const theme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#111',
		bgSidebar: '#222',
		bgActivity: '#333',
		textMain: '#fff',
		textDim: '#999',
		accent: '#0af',
		accentForeground: '#000',
		border: '#444',
		success: '#0f0',
		error: '#f00',
		warning: '#ff0',
		info: '#0ff',
	},
};

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Session',
		toolType: 'codex',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/tmp/project',
		projectRoot: '/tmp/project',
		aiPid: 0,
		terminalPid: 0,
		aiTabs: [
			{
				id: 'tab-1',
				logs: [],
				agentSessionId: null,
				lastActivityAt: 0,
				scrollTop: 0,
				busyStartTime: null,
				statusMessage: null,
				contextUsage: null,
				isStarred: false,
				name: null,
				readOnlyMode: false,
				draftInput: '',
				saveToHistory: false,
				demoCaptureRequested: false,
			},
		],
		activeTabId: 'tab-1',
		shellLogs: [],
		usageStats: null,
		agentSessionId: null,
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		messageQueue: [],
		shellCommandHistory: [],
		aiCommandHistory: [],
		closedTabHistory: [],
		shellCwd: '/tmp/project',
		busySource: null,
		...overrides,
	};
}

function createProps(session: Session): React.ComponentProps<typeof InputArea> {
	return {
		session,
		theme,
		inputValue: '',
		setInputValue: vi.fn(),
		enterToSend: true,
		setEnterToSend: vi.fn(),
		stagedImages: [],
		setStagedImages: vi.fn(),
		setLightboxImage: vi.fn(),
		commandHistoryOpen: false,
		setCommandHistoryOpen: vi.fn(),
		commandHistoryFilter: '',
		setCommandHistoryFilter: vi.fn(),
		commandHistorySelectedIndex: 0,
		setCommandHistorySelectedIndex: vi.fn(),
		slashCommandOpen: false,
		setSlashCommandOpen: vi.fn(),
		slashCommands: [],
		selectedSlashCommandIndex: 0,
		setSelectedSlashCommandIndex: vi.fn(),
		inputRef: { current: null } as React.RefObject<HTMLTextAreaElement>,
		handleInputKeyDown: vi.fn(),
		handlePaste: vi.fn(),
		handleDrop: vi.fn(),
		toggleInputMode: vi.fn(),
		processInput: vi.fn(),
		queueInput: vi.fn(),
		handleInterrupt: vi.fn(),
		onInputFocus: vi.fn(),
		onInputBlur: vi.fn(),
		thinkingItems: [],
	};
}

describe('InputArea demo capture toggle', () => {
	it('toggles demo capture on the active AI tab', () => {
		mockUpdateSession.mockClear();
		render(<InputArea {...createProps(createSession())} />);

		fireEvent.click(screen.getByRole('button', { name: /demo/i }));

		expect(mockUpdateSession).toHaveBeenCalledWith('session-1', {
			aiTabs: [
				expect.objectContaining({
					id: 'tab-1',
					demoCaptureRequested: true,
				}),
			],
		});
	});

	it('does not show the demo toggle in terminal mode', () => {
		render(<InputArea {...createProps(createSession({ inputMode: 'terminal' }))} />);
		expect(screen.queryByRole('button', { name: /demo/i })).toBeNull();
	});
});
