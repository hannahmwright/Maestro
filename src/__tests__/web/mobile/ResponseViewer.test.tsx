import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ResponseViewer } from '../../../web/mobile/ResponseViewer';

const mockColors = {
	bgMain: '#1e1e1e',
	bgSidebar: '#252526',
	bgActivity: '#333333',
	textMain: '#ffffff',
	textDim: '#888888',
	border: '#404040',
	accent: '#7c3aed',
	success: '#22c55e',
	warning: '#f59e0b',
	error: '#ef4444',
};

let mockIsDark = false;
const mockTriggerHaptic = vi.fn();

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
	useTheme: () => ({ isDark: mockIsDark }),
}));

vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: (...args: unknown[]) => mockTriggerHaptic(...args),
	HAPTIC_PATTERNS: {
		success: [30],
		error: [50],
		tap: [10],
	},
}));

vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		error: vi.fn(),
	},
}));

vi.mock('../../../web/mobile/prismLight', () => ({
	normalizeMobileCodeLanguage: (language?: string) => {
		const normalized = (language || '').toLowerCase();
		if (normalized === 'ts') return 'typescript';
		if (normalized === 'sh' || normalized === 'shell' || normalized === 'zsh') return 'bash';
		return normalized || 'text';
	},
	SyntaxHighlighter: ({ language, children }: { language: string; children: React.ReactNode }) => (
		<pre data-testid="syntax-highlighter" data-language={language}>
			{children}
		</pre>
	),
}));

function createResponse(overrides: Record<string, unknown> = {}) {
	return {
		text: 'Response text',
		timestamp: new Date('2025-11-30T19:00:00Z').getTime(),
		fullLength: 13,
		...overrides,
	};
}

describe('ResponseViewer', () => {
	const originalClipboard = navigator.clipboard;

	beforeEach(() => {
		vi.clearAllMocks();
		mockIsDark = false;
		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn(async () => undefined),
			},
		});
	});

	afterEach(() => {
		Object.assign(navigator, { clipboard: originalClipboard });
	});

	it('returns null when closed', () => {
		const { container } = render(
			<ResponseViewer isOpen={false} response={createResponse()} onClose={vi.fn()} />
		);

		expect(container.firstChild).toBeNull();
	});

	it('renders the response text and session name when open', () => {
		render(
			<ResponseViewer
				isOpen={true}
				response={createResponse({ text: 'Hello from Maestro' })}
				sessionName="Session Alpha"
				onClose={vi.fn()}
			/>
		);

		expect(screen.getByRole('dialog', { name: 'Full response viewer' })).toBeInTheDocument();
		expect(screen.getByText('Hello from Maestro')).toBeInTheDocument();
		expect(screen.getByText('Session Alpha')).toBeInTheDocument();
	});

	it('renders code blocks with normalized language labels', () => {
		render(
			<ResponseViewer
				isOpen={true}
				response={createResponse({
					text: 'Before\n```ts\nconst value = 1;\n```\nAfter',
				})}
				onClose={vi.fn()}
			/>
		);

		expect(screen.getByText('typescript')).toBeInTheDocument();
		expect(screen.getByTestId('syntax-highlighter')).toHaveAttribute('data-language', 'typescript');
		expect(screen.getByTestId('syntax-highlighter')).toHaveTextContent('const value = 1;');
	});

	it('falls back to code for unlabeled code fences', () => {
		render(
			<ResponseViewer
				isOpen={true}
				response={createResponse({
					text: '```\nplain text\n```',
				})}
				onClose={vi.fn()}
			/>
		);

		expect(screen.getByText('code')).toBeInTheDocument();
		expect(screen.getByTestId('syntax-highlighter')).toHaveAttribute('data-language', 'text');
	});

	it('copies code blocks to the clipboard and shows copied feedback', async () => {
		render(
			<ResponseViewer
				isOpen={true}
				response={createResponse({
					text: '```ts\nconst answer = 42;\n```',
				})}
				onClose={vi.fn()}
			/>
		);

		fireEvent.click(screen.getByLabelText('Copy code'));

		await waitFor(() => {
			expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const answer = 42;');
		});
		expect(mockTriggerHaptic).toHaveBeenCalledWith([30]);
		expect(screen.getByLabelText('Copied!')).toBeInTheDocument();
	});

	it('closes from the close button and the Escape key', () => {
		const onClose = vi.fn();
		render(<ResponseViewer isOpen={true} response={createResponse()} onClose={onClose} />);

		fireEvent.click(screen.getByLabelText('Close response viewer'));
		fireEvent.keyDown(document, { key: 'Escape' });

		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it('navigates with arrow keys when multiple responses are available', () => {
		const onNavigate = vi.fn();
		render(
			<ResponseViewer
				isOpen={true}
				response={createResponse()}
				allResponses={[
					{ response: createResponse({ text: 'First' }), sessionId: 's1', sessionName: 'One' },
					{ response: createResponse({ text: 'Second' }), sessionId: 's2', sessionName: 'Two' },
					{ response: createResponse({ text: 'Third' }), sessionId: 's3', sessionName: 'Three' },
				]}
				currentIndex={1}
				onNavigate={onNavigate}
				onClose={vi.fn()}
			/>
		);

		fireEvent.keyDown(document, { key: 'ArrowLeft' });
		fireEvent.keyDown(document, { key: 'ArrowRight' });

		expect(onNavigate).toHaveBeenNthCalledWith(1, 0);
		expect(onNavigate).toHaveBeenNthCalledWith(2, 2);
	});

	it('renders pagination dots and navigates when a dot is clicked', () => {
		const onNavigate = vi.fn();
		render(
			<ResponseViewer
				isOpen={true}
				response={createResponse()}
				allResponses={[
					{ response: createResponse({ text: 'First' }), sessionId: 's1', sessionName: 'One' },
					{ response: createResponse({ text: 'Second' }), sessionId: 's2', sessionName: 'Two' },
				]}
				currentIndex={0}
				onNavigate={onNavigate}
				onClose={vi.fn()}
			/>
		);

		expect(screen.getByLabelText('Response 1 of 2')).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText('Go to response 2'));

		expect(onNavigate).toHaveBeenCalledWith(1);
	});

	it('shows the truncation notice when only preview text is available', () => {
		render(
			<ResponseViewer
				isOpen={true}
				response={createResponse({
					text: 'Short preview',
					fullLength: 200,
				})}
				onClose={vi.fn()}
			/>
		);

		expect(screen.getByText(/Showing preview/)).toBeInTheDocument();
		expect(screen.getByText(/Full response loading not available/)).toBeInTheDocument();
	});

	it('uses fullText when it is provided', () => {
		render(
			<ResponseViewer
				isOpen={true}
				response={createResponse({ text: 'Preview only', fullLength: 200 })}
				fullText="This is the full response"
				onClose={vi.fn()}
			/>
		);

		expect(screen.getByText('This is the full response')).toBeInTheDocument();
		expect(screen.queryByText(/Showing preview/)).not.toBeInTheDocument();
	});

	it('uses the dark theme syntax style when the theme is dark', () => {
		mockIsDark = true;

		render(
			<ResponseViewer
				isOpen={true}
				response={createResponse({
					text: '```sh\necho hi\n```',
				})}
				onClose={vi.fn()}
			/>
		);

		expect(screen.getByText('bash')).toBeInTheDocument();
		expect(screen.getByTestId('syntax-highlighter')).toHaveAttribute('data-language', 'bash');
	});
});
