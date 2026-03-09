import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageHistory } from '../../../web/mobile/MessageHistory';

const mockColors = {
	accent: '#7c3aed',
	border: '#333333',
	bgMain: '#111111',
	bgSidebar: '#1f2937',
	textMain: '#ffffff',
	textDim: '#888888',
	success: '#22c55e',
	warning: '#f59e0b',
	error: '#ef4444',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('../../../web/mobile/MobileMarkdownRenderer', () => ({
	MobileMarkdownRenderer: ({ content }: { content: string }) => (
		<div data-testid="markdown-renderer">{content}</div>
	),
}));

vi.mock('../../../web/mobile/ToolActivityBlock', () => ({
	ToolActivityBlock: ({ log }: { log: { text?: string } }) => (
		<div data-testid="tool-activity-block">{log.text}</div>
	),
}));

vi.mock('../../../web/mobile/ToolActivityPanel', () => ({
	ToolActivityPanel: ({ logs }: { logs: Array<{ text?: string }> }) => (
		<div data-testid="tool-activity-panel">{logs.map((log) => log.text).join(', ')}</div>
	),
}));

vi.mock('../../../web/utils/config', () => ({
	buildApiUrl: (path: string) => `http://localhost:3000${path}`,
}));

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
});

function createLogEntry(overrides: Record<string, unknown> = {}) {
	return {
		id: `log-${Math.random().toString(36).slice(2, 8)}`,
		timestamp: Date.now(),
		source: 'stdout',
		text: 'Hello world',
		...overrides,
	};
}

describe('MessageHistory', () => {
	it('renders the empty state when there are no logs', () => {
		render(<MessageHistory logs={[]} inputMode="ai" />);

		expect(screen.getByText('No messages yet')).toBeInTheDocument();
	});

	it('renders assistant responses through the markdown renderer', () => {
		render(
			<MessageHistory
				logs={[createLogEntry({ source: 'stdout', text: 'Assistant reply' })]}
				inputMode="ai"
			/>
		);

		expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('Assistant reply');
	});

	it('renders user messages as monospace bubbles aligned to the right', () => {
		render(
			<MessageHistory
				logs={[createLogEntry({ source: 'user', text: 'User prompt' })]}
				inputMode="ai"
			/>
		);

		expect(screen.getByText('User prompt')).toBeInTheDocument();
		expect(
			screen.getByText('User prompt').closest('[style*="align-self: flex-end"]')
		).not.toBeNull();
	});

	it('renders terminal output and stderr labels', () => {
		render(
			<MessageHistory
				logs={[
					createLogEntry({ source: 'stdout', text: 'ls -la output' }),
					createLogEntry({ source: 'stderr', text: 'Permission denied' }),
				]}
				inputMode="terminal"
			/>
		);

		expect(screen.getByText('Output')).toBeInTheDocument();
		expect(screen.getByText('Error')).toBeInTheDocument();
		expect(screen.getByText('Permission denied')).toBeInTheDocument();
	});

	it('strips ANSI escape codes from rendered text', () => {
		render(
			<MessageHistory
				logs={[createLogEntry({ source: 'stdout', text: '\u001b[31mRed text\u001b[0m' })]}
				inputMode="terminal"
			/>
		);

		expect(screen.getByText('Red text')).toBeInTheDocument();
		expect(screen.queryByText(/\u001b\[31m/)).not.toBeInTheDocument();
	});

	it('truncates long non-assistant messages and expands them on tap', () => {
		const longText = 'x'.repeat(520);
		render(
			<MessageHistory
				logs={[createLogEntry({ source: 'stdout', text: longText })]}
				inputMode="terminal"
			/>
		);

		expect(screen.getByText('▶ expand')).toBeInTheDocument();
		expect(screen.getByText(/\.\.\. \(tap to expand\)/)).toBeInTheDocument();

		fireEvent.click(screen.getByText(/\.\.\. \(tap to expand\)/));

		expect(screen.getByText('▼ collapse')).toBeInTheDocument();
	});

	it('calls onMessageTap when a message is clicked', () => {
		const onMessageTap = vi.fn();
		render(
			<MessageHistory
				logs={[createLogEntry({ source: 'user', text: 'Tap me' })]}
				inputMode="ai"
				onMessageTap={onMessageTap}
			/>
		);

		fireEvent.click(screen.getByText('Tap me'));

		expect(onMessageTap).toHaveBeenCalledTimes(1);
	});

	it('renders attachment chips for file attachments', () => {
		render(
			<MessageHistory
				logs={[
					createLogEntry({
						source: 'user',
						text: 'See attachment',
						attachments: [{ id: 'a1', kind: 'file', name: 'notes.md' }],
					}),
				]}
				inputMode="ai"
			/>
		);

		expect(screen.getByText('notes.md')).toBeInTheDocument();
	});

	it('renders tool activity blocks and panels when tool data is present', () => {
		render(
			<MessageHistory
				logs={[
					createLogEntry({ source: 'user', text: 'Build this' }),
					createLogEntry({ source: 'tool', text: 'Running formatter' }),
					createLogEntry({ source: 'stdout', text: 'Done' }),
				]}
				toolLogs={[createLogEntry({ source: 'tool', text: 'Tool output' })]}
				inputMode="ai"
				isSessionBusy={true}
			/>
		);

		expect(screen.getByTestId('tool-activity-block')).toHaveTextContent('Running formatter');
		expect(screen.getByTestId('tool-activity-panel')).toHaveTextContent('Tool output');
	});

	it('shows the pending assistant indicator when busy after the latest user turn', () => {
		render(
			<MessageHistory
				logs={[createLogEntry({ source: 'user', text: 'Waiting...' })]}
				inputMode="ai"
				isSessionBusy={true}
			/>
		);

		expect(screen.getByLabelText('Assistant is thinking')).toBeInTheDocument();
	});

	it('renders reasoning entries with the reasoning label', () => {
		render(
			<MessageHistory
				logs={[createLogEntry({ source: 'thinking', text: 'Planning next step' })]}
				inputMode="ai"
			/>
		);

		expect(screen.getByText('Reasoning')).toBeInTheDocument();
		expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('Planning next step');
	});

	it('uses flex layout when maxHeight is none', () => {
		const { container } = render(
			<MessageHistory
				logs={[createLogEntry({ source: 'stdout', text: 'One line' })]}
				inputMode="ai"
				maxHeight="none"
			/>
		);

		expect(container.firstChild).toHaveStyle({
			display: 'flex',
			flexDirection: 'column',
			flex: '1 1 0%',
		});
	});
});
