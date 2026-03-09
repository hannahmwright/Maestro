import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabSearchModal } from '../../../web/mobile/TabSearchModal';

const mockColors = {
	bgMain: '#1a1a1a',
	bgSidebar: '#111111',
	textMain: '#ffffff',
	textDim: '#888888',
	border: '#333333',
	accent: '#007acc',
	warning: '#f5a623',
	error: '#f44336',
	success: '#4caf50',
};

const mockTriggerHaptic = vi.fn();

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: (...args: unknown[]) => mockTriggerHaptic(...args),
	HAPTIC_PATTERNS: {
		tap: [10],
	},
}));

function createSession(overrides: Record<string, unknown> = {}) {
	return {
		id: 'session-1',
		name: 'Primary Agent',
		toolType: 'claude-code',
		groupName: '',
		aiTabs: [
			{
				id: 'tab-1',
				name: 'Plan work',
				agentSessionId: 'claude-1234-abcd',
				state: 'idle',
				hasUnread: false,
				createdAt: 100,
			},
		],
		...overrides,
	};
}

describe('TabSearchModal', () => {
	const onSelectTarget = vi.fn();
	const onClose = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('focuses the search input and shows the default placeholder', () => {
		render(
			<TabSearchModal
				sessions={[createSession() as any]}
				activeSessionId="session-1"
				activeTabId="tab-1"
				recentTargets={[]}
				onSelectTarget={onSelectTarget}
				onClose={onClose}
			/>
		);

		const input = screen.getByPlaceholderText('Search all chats');
		expect(input).toHaveFocus();
	});

	it('shows grouped busy, unread, and recent sections when there is no query', () => {
		render(
			<TabSearchModal
				sessions={[
					createSession({
						aiTabs: [
							{
								id: 'tab-1',
								name: 'Busy chat',
								agentSessionId: 'claude-busy-1',
								state: 'busy',
								hasUnread: false,
								createdAt: 100,
							},
							{
								id: 'tab-2',
								name: 'Unread chat',
								agentSessionId: 'claude-unread-1',
								state: 'idle',
								hasUnread: true,
								createdAt: 200,
							},
						],
					}) as any,
				]}
				activeSessionId="session-1"
				activeTabId="tab-1"
				recentTargets={[{ sessionId: 'session-1', tabId: 'tab-2', viewedAt: 999 } as any]}
				onSelectTarget={onSelectTarget}
				onClose={onClose}
			/>
		);

		expect(screen.getByText('Busy')).toBeInTheDocument();
		expect(screen.getByText('Unread')).toBeInTheDocument();
		expect(screen.getByText('Recent')).toBeInTheDocument();
		expect(screen.getByText('Busy chat')).toBeInTheDocument();
		expect(screen.getAllByText('Unread chat').length).toBeGreaterThan(0);
	});

	it('falls back to Untitled chat when a tab has no name', () => {
		render(
			<TabSearchModal
				sessions={[
					createSession({
						aiTabs: [
							{
								id: 'tab-1',
								name: '   ',
								agentSessionId: '',
								state: 'idle',
								hasUnread: false,
								createdAt: 100,
							},
						],
					}) as any,
				]}
				activeSessionId="session-1"
				activeTabId="tab-1"
				recentTargets={[{ sessionId: 'session-1', tabId: 'tab-1', viewedAt: 500 } as any]}
				onSelectTarget={onSelectTarget}
				onClose={onClose}
			/>
		);

		expect(screen.getByText('Untitled chat')).toBeInTheDocument();
	});

	it('searches across session and tab data', () => {
		render(
			<TabSearchModal
				sessions={[
					createSession({
						id: 'session-1',
						name: 'Alpha Team',
						aiTabs: [
							{
								id: 'tab-1',
								name: 'Release prep',
								agentSessionId: 'claude-alpha-1',
								state: 'idle',
								hasUnread: false,
								createdAt: 100,
							},
						],
					}) as any,
					createSession({
						id: 'session-2',
						name: 'Beta Team',
						toolType: 'codex',
						aiTabs: [
							{
								id: 'tab-2',
								name: 'Docs',
								agentSessionId: 'codex-beta-2',
								state: 'idle',
								hasUnread: false,
								createdAt: 200,
							},
						],
					}) as any,
				]}
				activeSessionId="session-1"
				activeTabId="tab-1"
				recentTargets={[]}
				onSelectTarget={onSelectTarget}
				onClose={onClose}
			/>
		);

		fireEvent.change(screen.getByPlaceholderText('Search all chats'), {
			target: { value: 'beta' },
		});

		expect(screen.getByText('Search Results')).toBeInTheDocument();
		expect(screen.getByText('Docs')).toBeInTheDocument();
		expect(screen.queryByText('Release prep')).not.toBeInTheDocument();
	});

	it('shows a no-results state for unmatched queries', () => {
		render(
			<TabSearchModal
				sessions={[createSession() as any]}
				activeSessionId="session-1"
				activeTabId="tab-1"
				recentTargets={[]}
				onSelectTarget={onSelectTarget}
				onClose={onClose}
			/>
		);

		fireEvent.change(screen.getByPlaceholderText('Search all chats'), {
			target: { value: 'missing' },
		});

		expect(screen.getByText('No chats match "missing"')).toBeInTheDocument();
	});

	it('selects a target and closes the modal', () => {
		render(
			<TabSearchModal
				sessions={[createSession() as any]}
				activeSessionId="session-1"
				activeTabId="tab-1"
				recentTargets={[]}
				onSelectTarget={onSelectTarget}
				onClose={onClose}
			/>
		);

		fireEvent.change(screen.getByPlaceholderText('Search all chats'), {
			target: { value: 'plan' },
		});
		fireEvent.click(screen.getByText('Plan work'));

		expect(mockTriggerHaptic).toHaveBeenCalledWith([10]);
		expect(onSelectTarget).toHaveBeenCalledWith('session-1', 'tab-1');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('clears the query and closes from the chrome buttons', () => {
		render(
			<TabSearchModal
				sessions={[createSession() as any]}
				activeSessionId="session-1"
				activeTabId="tab-1"
				recentTargets={[]}
				onSelectTarget={onSelectTarget}
				onClose={onClose}
			/>
		);

		fireEvent.change(screen.getByPlaceholderText('Search all chats'), {
			target: { value: 'plan' },
		});
		fireEvent.click(screen.getByRole('button', { name: '×' }));
		expect(screen.getByDisplayValue('')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Close'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('closes on Escape', () => {
		render(
			<TabSearchModal
				sessions={[createSession() as any]}
				activeSessionId="session-1"
				activeTabId="tab-1"
				recentTargets={[]}
				onSelectTarget={onSelectTarget}
				onClose={onClose}
			/>
		);

		fireEvent.keyDown(window, { key: 'Escape' });

		expect(mockTriggerHaptic).toHaveBeenCalledWith([10]);
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
