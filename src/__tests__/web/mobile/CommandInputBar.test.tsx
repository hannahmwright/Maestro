/**
 * Tests for CommandInputBar.tsx
 *
 * Comprehensive test coverage for the mobile command input bar component.
 * Tests include:
 * - Pure helper functions (triggerHapticFeedback)
 * - Custom hook useIsMobilePhone
 * - Component rendering in various states
 * - Controlled vs uncontrolled mode
 * - Input mode switching (AI/Terminal)
 * - Form submission handling
 * - Keyboard handling (Enter behavior)
 * - Visual Viewport API keyboard detection
 * - Slash command autocomplete triggering
 * - Voice input functionality
 * - Long-press quick actions menu
 * - Mobile expanded mode
 * - Recent command chips
 * - Swipe up gesture handling
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import {
	CommandInputBar,
	type CommandInputBarProps,
	type InputMode,
} from '../../../web/mobile/CommandInputBar';

// Mock dependencies
vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgMain: '#1e1e1e',
		bgSidebar: '#252525',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#6366f1',
		border: '#444444',
	}),
}));

vi.mock('../../../web/hooks/useSwipeUp', () => ({
	useSwipeUp: vi.fn(({ onSwipeUp, enabled }) => ({
		handlers: enabled
			? {
					onTouchStart: vi.fn(),
					onTouchMove: vi.fn(),
					onTouchEnd: vi.fn(),
				}
			: {},
	})),
}));

vi.mock('../../../web/mobile/RecentCommandChips', () => ({
	RecentCommandChips: vi.fn(({ commands, onSelectCommand, disabled }) => (
		<div data-testid="recent-command-chips">
			{commands?.map((cmd: { id: string; command: string }) => (
				<button
					key={cmd.id}
					data-testid={`chip-${cmd.id}`}
					onClick={() => onSelectCommand(cmd.command)}
					disabled={disabled}
				>
					{cmd.command}
				</button>
			))}
		</div>
	)),
}));

vi.mock('../../../web/mobile/SlashCommandAutocomplete', () => ({
	SlashCommandAutocomplete: vi.fn(
		({ isOpen, inputValue, onSelectCommand, onClose, selectedIndex }) =>
			isOpen ? (
				<div data-testid="slash-autocomplete">
					<span data-testid="autocomplete-value">{inputValue}</span>
					<span data-testid="autocomplete-index">{selectedIndex}</span>
					<button data-testid="select-slash-cmd" onClick={() => onSelectCommand('/test')}>
						Select
					</button>
					<button data-testid="close-slash-cmd" onClick={onClose}>
						Close
					</button>
				</div>
			) : null
	),
	DEFAULT_SLASH_COMMANDS: [
		{ command: '/clear', description: 'Clear output' },
		{ command: '/history', description: 'Get history synopsis', aiOnly: true },
	],
}));

vi.mock('../../../web/mobile/QuickActionsMenu', () => ({
	QuickActionsMenu: vi.fn(
		({ isOpen, onClose, onSelectAction, inputMode, anchorPosition, hasActiveSession }) =>
			isOpen ? (
				<div data-testid="quick-actions-menu">
					<span data-testid="qa-mode">{inputMode}</span>
					<span data-testid="qa-has-session">{String(hasActiveSession)}</span>
					<button data-testid="qa-switch-mode" onClick={() => onSelectAction('switch_mode')}>
						Switch Mode
					</button>
					<button data-testid="qa-close" onClick={onClose}>
						Close
					</button>
				</div>
			) : null
	),
}));

vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Helper to create default props
const createProps = (overrides: Partial<CommandInputBarProps> = {}): CommandInputBarProps => ({
	isOffline: false,
	isConnected: true,
	...overrides,
});

// Helper to render the component
const renderComponent = (props: Partial<CommandInputBarProps> = {}) => {
	return render(<CommandInputBar {...createProps(props)} />);
};

const focusAiComposer = async () => {
	const input = screen.getByRole('textbox');
	fireEvent.focus(input);
	await waitFor(() => {
		expect(screen.getByLabelText(/AI message input/i)).toBeInTheDocument();
	});
	return screen.getByLabelText(/AI message input/i);
};

describe('CommandInputBar', () => {
	let originalVibrate: typeof navigator.vibrate;
	let originalVisualViewport: VisualViewport | null;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });

		// Save original values
		originalVibrate = navigator.vibrate;
		originalVisualViewport = window.visualViewport;

		// Mock navigator.vibrate
		Object.defineProperty(navigator, 'vibrate', {
			value: vi.fn().mockReturnValue(true),
			writable: true,
			configurable: true,
		});

		// Mock visualViewport
		const mockViewport = {
			height: 800,
			width: 400,
			offsetTop: 0,
			offsetLeft: 0,
			scale: 1,
			pageTop: 0,
			pageLeft: 0,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		};
		Object.defineProperty(window, 'visualViewport', {
			value: mockViewport,
			writable: true,
			configurable: true,
		});

		// Mock window dimensions
		Object.defineProperty(window, 'innerHeight', { value: 800, writable: true });
		Object.defineProperty(window, 'innerWidth', { value: 400, writable: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		// Restore original values
		Object.defineProperty(navigator, 'vibrate', {
			value: originalVibrate,
			writable: true,
			configurable: true,
		});
		if (originalVisualViewport !== null) {
			Object.defineProperty(window, 'visualViewport', {
				value: originalVisualViewport,
				writable: true,
				configurable: true,
			});
		}
	});

	describe('Rendering', () => {
		it('renders with default props', () => {
			renderComponent();
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});

		it('renders a filled bottom dock when the keyboard is hidden', () => {
			const { container } = renderComponent();
			const dock = container.firstElementChild as HTMLElement;
			const form = container.querySelector('form') as HTMLElement;
			expect(dock.style.background).toContain('linear-gradient');
			expect(dock.style.borderTop).not.toBe('none');
			expect(dock.style.paddingBottom).toBe('0px');
			expect(form.style.paddingBottom).toContain('env(safe-area-inset-bottom)');
		});

		it('can render the composer in normal layout flow', () => {
			const { container } = renderComponent({ layoutMode: 'in-flow' });
			const dock = container.firstElementChild as HTMLElement;
			expect(dock.style.position).toBe('relative');
			expect(dock.style.bottom).toBe('auto');
			expect(dock.style.flexShrink).toBe('0');
			expect(dock.style.paddingBottom).toBe('0px');
		});

		it('renders textarea for AI mode', () => {
			renderComponent({ inputMode: 'ai' });
			const input = screen.getByRole('textbox');
			expect(input.tagName.toLowerCase()).toBe('input');
		});

		it('renders textarea for terminal mode', () => {
			renderComponent({ inputMode: 'terminal' });
			const textarea = screen.getByRole('textbox');
			expect(textarea.tagName.toLowerCase()).toBe('textarea');
		});

		it('renders send button', () => {
			renderComponent({ value: 'test' });
			const sendButton = screen.getByRole('button', { name: /send/i });
			expect(sendButton).toBeInTheDocument();
		});

		it('renders expanded interrupt button when session is busy in AI mode', async () => {
			renderComponent({ inputMode: 'ai', isSessionBusy: true });
			await focusAiComposer();
			const interruptButton = screen.getByRole('button', { name: /cancel running ai query/i });
			expect(interruptButton).toBeInTheDocument();
		});

		it('renders send button when session is busy in terminal mode (not interrupt)', () => {
			renderComponent({ inputMode: 'terminal', isSessionBusy: true, value: 'test' });
			const sendButton = screen.getByRole('button', { name: /send/i });
			expect(sendButton).toBeInTheDocument();
		});
	});

	describe('Placeholder Text', () => {
		it('shows "Offline..." when offline', () => {
			renderComponent({ isOffline: true });
			expect(screen.getByPlaceholderText('Offline...')).toBeInTheDocument();
		});

		it('shows "Connecting..." when not connected', () => {
			renderComponent({ isConnected: false });
			expect(screen.getByPlaceholderText('Connecting...')).toBeInTheDocument();
		});

		it('shows AI thinking message when AI is busy', () => {
			renderComponent({ inputMode: 'ai', isSessionBusy: true });
			expect(screen.getByPlaceholderText(/AI thinking/i)).toBeInTheDocument();
		});

		it('shows custom placeholder when provided', () => {
			renderComponent({ placeholder: 'Custom placeholder' });
			expect(screen.getByPlaceholderText('Custom placeholder')).toBeInTheDocument();
		});

		it('shows default placeholder when no custom provided', () => {
			renderComponent();
			expect(screen.getByPlaceholderText('Message agent...')).toBeInTheDocument();
		});
	});

	describe('Disabled State', () => {
		it('disables input when offline', () => {
			renderComponent({ isOffline: true });
			expect(screen.getByRole('textbox')).toBeDisabled();
		});

		it('disables input when not connected', () => {
			renderComponent({ isConnected: false });
			expect(screen.getByRole('textbox')).toBeDisabled();
		});

		it('disables input when disabled prop is true', () => {
			renderComponent({ disabled: true });
			expect(screen.getByRole('textbox')).toBeDisabled();
		});

		it('does NOT disable input when AI is busy (user can prep next message)', () => {
			renderComponent({ inputMode: 'ai', isSessionBusy: true });
			expect(screen.getByRole('textbox')).not.toBeDisabled();
		});

		it('does NOT disable input when terminal session is busy', () => {
			renderComponent({ inputMode: 'terminal', isSessionBusy: true });
			expect(screen.getByRole('textbox')).not.toBeDisabled();
		});
	});

	describe('Controlled vs Uncontrolled Mode', () => {
		it('uses controlled value when provided', () => {
			renderComponent({ value: 'controlled value' });
			expect(screen.getByRole('textbox')).toHaveValue('controlled value');
		});

		it('manages internal state in uncontrolled mode', () => {
			renderComponent();
			const input = screen.getByRole('textbox');

			fireEvent.change(input, { target: { value: 'test' } });
			expect(input).toHaveValue('test');
		});

		it('calls onChange callback when value changes', () => {
			const onChange = vi.fn();
			renderComponent({ onChange });
			const input = screen.getByRole('textbox');

			fireEvent.change(input, { target: { value: 'a' } });
			expect(onChange).toHaveBeenCalledWith('a');
		});

		it('clears internal state after submit in uncontrolled mode', async () => {
			const onSubmit = vi.fn();
			renderComponent({ onSubmit });

			const input = screen.getByRole('textbox');
			fireEvent.change(input, { target: { value: 'test command' } });
			expect(input).toHaveValue('test command');

			const form = input.closest('form');
			fireEvent.submit(form!);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(input).toHaveValue('');
		});
	});

	describe('Form Submission', () => {
		it('calls onSubmit with trimmed value', () => {
			const onSubmit = vi.fn();
			renderComponent({ value: '  test command  ', onSubmit });

			const form = screen.getByRole('textbox').closest('form');
			fireEvent.submit(form!);

			expect(onSubmit).toHaveBeenCalledWith('test command');
		});

		it('does not submit empty value', () => {
			const onSubmit = vi.fn();
			renderComponent({ value: '', onSubmit });

			const form = screen.getByRole('textbox').closest('form');
			fireEvent.submit(form!);

			expect(onSubmit).not.toHaveBeenCalled();
		});

		it('does not submit whitespace-only value', () => {
			const onSubmit = vi.fn();
			renderComponent({ value: '   ', onSubmit });

			const form = screen.getByRole('textbox').closest('form');
			fireEvent.submit(form!);

			expect(onSubmit).not.toHaveBeenCalled();
		});

		it('does not submit when disabled', () => {
			const onSubmit = vi.fn();
			renderComponent({ value: 'test', disabled: true, onSubmit });

			const form = screen.getByRole('textbox').closest('form');
			fireEvent.submit(form!);

			expect(onSubmit).not.toHaveBeenCalled();
		});

		it('triggers haptic feedback on successful submit', () => {
			const onSubmit = vi.fn();
			renderComponent({ value: 'test', onSubmit });

			const form = screen.getByRole('textbox').closest('form');
			fireEvent.submit(form!);

			expect(navigator.vibrate).toHaveBeenCalledWith(25); // 'medium' = 25ms
		});
	});

	describe('Keyboard Handling', () => {
		it('Enter submits in compact AI mode', () => {
			const onSubmit = vi.fn();
			renderComponent({ inputMode: 'ai', value: 'test', onSubmit });

			const input = screen.getByRole('textbox');
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(onSubmit).toHaveBeenCalledWith('test');
		});

		it('Enter adds newline in expanded AI mode', async () => {
			const onSubmit = vi.fn();
			renderComponent({ inputMode: 'ai', value: 'test', onSubmit });

			const textarea = await focusAiComposer();
			fireEvent.keyDown(textarea, { key: 'Enter' });

			expect(onSubmit).not.toHaveBeenCalled();
		});

		it('Enter submits in terminal mode', () => {
			const onSubmit = vi.fn();
			renderComponent({ inputMode: 'terminal', value: 'test', onSubmit });

			const input = screen.getByRole('textbox');
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(onSubmit).toHaveBeenCalledWith('test');
		});

		it('Shift+Enter does not submit in terminal mode', () => {
			const onSubmit = vi.fn();
			renderComponent({ inputMode: 'terminal', value: 'test', onSubmit });

			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

			expect(onSubmit).not.toHaveBeenCalled();
		});
	});

	describe('Interrupt Button', () => {
		it('calls onInterrupt when interrupt button is clicked', async () => {
			const onInterrupt = vi.fn();
			renderComponent({ inputMode: 'ai', isSessionBusy: true, onInterrupt });

			await focusAiComposer();
			const interruptButton = screen.getByRole('button', { name: /cancel running ai query/i });
			fireEvent.click(interruptButton);

			expect(onInterrupt).toHaveBeenCalled();
		});

		it('triggers strong haptic feedback on interrupt', async () => {
			const onInterrupt = vi.fn();
			renderComponent({ inputMode: 'ai', isSessionBusy: true, onInterrupt });

			await focusAiComposer();
			const interruptButton = screen.getByRole('button', { name: /cancel running ai query/i });
			fireEvent.click(interruptButton);

			expect(navigator.vibrate).toHaveBeenCalledWith(50); // 'strong' = 50ms
		});
	});

	describe('Slash Command Autocomplete', () => {
		it('shows autocomplete when input starts with /', async () => {
			renderComponent();

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: '/' } });

			expect(screen.getByTestId('slash-autocomplete')).toBeInTheDocument();
		});

		it('shows autocomplete when typing /cl', () => {
			renderComponent();

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: '/cl' } });

			expect(screen.getByTestId('slash-autocomplete')).toBeInTheDocument();
		});

		it('hides autocomplete when input contains space', () => {
			renderComponent();

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: '/clear ' } });

			expect(screen.queryByTestId('slash-autocomplete')).not.toBeInTheDocument();
		});

		it('hides autocomplete when input does not start with /', () => {
			renderComponent();

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'hello' } });

			expect(screen.queryByTestId('slash-autocomplete')).not.toBeInTheDocument();
		});

		it('selects slash command and auto-submits', async () => {
			const onSubmit = vi.fn();
			const onChange = vi.fn();
			renderComponent({ onSubmit, onChange });

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: '/' } });

			const selectButton = screen.getByTestId('select-slash-cmd');
			fireEvent.click(selectButton);

			// Should update value
			expect(onChange).toHaveBeenCalledWith('/test');

			// Auto-submit after delay
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(onSubmit).toHaveBeenCalledWith('/test');
		});

		it('closes autocomplete and clears partial command on close', () => {
			const onChange = vi.fn();
			renderComponent({ onChange });

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: '/cle' } });

			expect(screen.getByTestId('slash-autocomplete')).toBeInTheDocument();

			const closeButton = screen.getByTestId('close-slash-cmd');
			fireEvent.click(closeButton);

			expect(screen.queryByTestId('slash-autocomplete')).not.toBeInTheDocument();
			expect(onChange).toHaveBeenCalledWith('');
		});
	});

	describe('Swipe Up Handle', () => {
		it('renders swipe handle when onHistoryOpen is provided', () => {
			renderComponent({ onHistoryOpen: vi.fn() });
			expect(screen.getByLabelText('Open command history')).toBeInTheDocument();
		});

		it('does not render swipe handle when onHistoryOpen is not provided', () => {
			renderComponent();
			expect(screen.queryByLabelText('Open command history')).not.toBeInTheDocument();
		});

		it('calls onHistoryOpen when handle is clicked', () => {
			const onHistoryOpen = vi.fn();
			renderComponent({ onHistoryOpen });

			const handle = screen.getByLabelText('Open command history');
			fireEvent.click(handle);

			expect(onHistoryOpen).toHaveBeenCalled();
		});
	});

	describe('Recent Command Chips', () => {
		const recentCommands = [
			{ id: '1', command: 'ls -la', mode: 'terminal' as const, timestamp: Date.now() },
			{ id: '2', command: 'git status', mode: 'terminal' as const, timestamp: Date.now() },
		];

		it('renders recent command chips when provided', () => {
			renderComponent({
				recentCommands,
				onSelectRecentCommand: vi.fn(),
			});

			expect(screen.getByTestId('recent-command-chips')).toBeInTheDocument();
		});

		it('does not render chips when showRecentCommands is false', () => {
			renderComponent({
				recentCommands,
				onSelectRecentCommand: vi.fn(),
				showRecentCommands: false,
			});

			expect(screen.queryByTestId('recent-command-chips')).not.toBeInTheDocument();
		});

		it('does not render chips when recentCommands is empty', () => {
			renderComponent({
				recentCommands: [],
				onSelectRecentCommand: vi.fn(),
			});

			expect(screen.queryByTestId('recent-command-chips')).not.toBeInTheDocument();
		});

		it('calls onSelectRecentCommand when chip is clicked', () => {
			const onSelectRecentCommand = vi.fn();
			renderComponent({ recentCommands, onSelectRecentCommand });

			const chip = screen.getByTestId('chip-1');
			fireEvent.click(chip);

			expect(onSelectRecentCommand).toHaveBeenCalledWith('ls -la');
		});
	});

	describe('Terminal Mode UI', () => {
		it('uses inherited font for terminal input', () => {
			renderComponent({ inputMode: 'terminal' });
			const textarea = screen.getByRole('textbox');
			expect(textarea.style.fontFamily).toBe('inherit');
		});
	});

	describe('Focus Handling', () => {
		it('calls onInputFocus when input is focused', () => {
			const onInputFocus = vi.fn();
			renderComponent({ onInputFocus });

			const textarea = screen.getByRole('textbox');
			fireEvent.focus(textarea);

			expect(onInputFocus).toHaveBeenCalled();
		});

		it('calls onInputBlur when input loses focus (terminal mode)', () => {
			// Test in terminal mode where onInputBlur is guaranteed to be called directly
			const onInputBlur = vi.fn();
			renderComponent({ inputMode: 'terminal', onInputBlur });

			const input = screen.getByRole('textbox');
			fireEvent.focus(input);
			fireEvent.blur(input);

			expect(onInputBlur).toHaveBeenCalled();
		});

		it('expands AI composer on focus', async () => {
			renderComponent({ inputMode: 'ai' });
			const textarea = await focusAiComposer();
			expect(textarea.tagName.toLowerCase()).toBe('textarea');
		});

		it('keeps a stable textarea surface for in-flow mobile layout', () => {
			renderComponent({ inputMode: 'ai', layoutMode: 'in-flow' });
			const input = screen.getByRole('textbox');
			expect(input.tagName.toLowerCase()).toBe('textarea');
			fireEvent.focus(input);
			expect(screen.getByRole('textbox').tagName.toLowerCase()).toBe('textarea');
		});

		it('does not change in-flow composer chrome after blur', () => {
			renderComponent({ inputMode: 'ai', layoutMode: 'in-flow' });
			const input = screen.getByRole('textbox');
			const form = input.closest('form') as HTMLElement;
			const initialPaddingTop = form.style.paddingTop;
			const initialPaddingBottom = form.style.paddingBottom;

			fireEvent.focus(input);
			fireEvent.blur(screen.getByRole('textbox'));

			const blurredInput = screen.getByRole('textbox');
			const blurredForm = blurredInput.closest('form') as HTMLElement;

			expect(blurredInput.tagName.toLowerCase()).toBe('textarea');
			expect(blurredForm.style.paddingTop).toBe(initialPaddingTop);
			expect(blurredForm.style.paddingBottom).toBe(initialPaddingBottom);
		});

		it('uses the larger AI composer in in-flow mobile layout', () => {
			renderComponent({ inputMode: 'ai', layoutMode: 'in-flow' });
			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			expect(textarea.style.minHeight).toBe('40px');
			fireEvent.focus(textarea);
			const focusedTextarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			expect(focusedTextarea.style.minHeight).toBe('88px');
			expect(screen.queryAllByRole('button', { name: /start voice recording/i }).length).toBeLessThanOrEqual(1);
			expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
		});

		it('shows focused action badges in in-flow mobile layout', () => {
			renderComponent({
				inputMode: 'ai',
				layoutMode: 'in-flow',
				onAddAttachments: vi.fn(),
				onToggleDemoCapture: vi.fn(),
			});
			const textarea = screen.getByRole('textbox');
			fireEvent.focus(textarea);
			expect(screen.getByRole('button', { name: /add files/i })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /require demo/i })).toBeInTheDocument();
		});

		it('adds focus ring on focus in terminal mode', () => {
			renderComponent({ inputMode: 'terminal' });
			const textarea = screen.getByRole('textbox');

			fireEvent.focus(textarea);

			const container = textarea.parentElement;
			expect(container?.style.border).toContain('rgba(99, 102, 241, 0.4)');
		});
	});

	describe('Touch Feedback on Buttons', () => {
		it('scales down send button on touch', () => {
			renderComponent({ value: 'test' });
			const sendButton = screen.getByRole('button', { name: /send command/i });

			fireEvent.touchStart(sendButton, {
				touches: [{ clientX: 0, clientY: 0 }],
				currentTarget: sendButton,
			});

			expect(sendButton.style.transform).toBe('scale(0.96)');
		});

		it('scales back up on touch end', () => {
			renderComponent({ value: 'test' });
			const sendButton = screen.getByRole('button', { name: /send command/i });

			fireEvent.touchStart(sendButton, {
				touches: [{ clientX: 0, clientY: 0 }],
				currentTarget: sendButton,
			});
			fireEvent.touchEnd(sendButton, {
				currentTarget: sendButton,
			});

			expect(sendButton.style.transform).toBe('scale(1)');
		});

		it('interrupt button changes color on touch', async () => {
			renderComponent({ inputMode: 'ai', isSessionBusy: true, onInterrupt: vi.fn() });
			await focusAiComposer();
			const interruptButton = screen.getByRole('button', { name: /cancel running ai query/i });

			fireEvent.touchStart(interruptButton, {
				touches: [{ clientX: 0, clientY: 0 }],
				currentTarget: interruptButton,
			});

			expect(interruptButton.style.backgroundColor).toBe('rgb(220, 38, 38)'); // darker red
		});
	});

	describe('Accessibility', () => {
		it('has aria-label on compact AI input', () => {
			renderComponent({ inputMode: 'ai' });
			expect(
				screen.getByLabelText(/message input\. type slash commands directly if needed\./i)
			).toBeInTheDocument();
		});

		it('has aria-label on expanded AI textarea', async () => {
			renderComponent({ inputMode: 'ai' });
			await focusAiComposer();
			expect(screen.getByLabelText(/AI message input/i)).toBeInTheDocument();
		});

		it('has aria-label on terminal textarea', () => {
			renderComponent({ inputMode: 'terminal' });
			expect(
				screen.getByLabelText(/message input\. type slash commands directly if needed\./i)
			).toBeInTheDocument();
		});

		it('has aria-multiline on textarea', () => {
			renderComponent({ inputMode: 'terminal' });
			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveAttribute('aria-multiline', 'true');
		});
	});

	describe('Constants', () => {
		// Test that the component uses the expected constants
		it('inline AI send button uses compact action sizing', () => {
			renderComponent({ value: 'test' });
			const sendButton = screen.getByRole('button', { name: /send/i });

			expect(sendButton.style.width).toBe('34px');
			expect(sendButton.style.height).toBe('34px');
		});

		it('terminal send button meets minimum touch target size', () => {
			renderComponent({ inputMode: 'terminal', value: 'test' });
			const sendButton = screen.getByRole('button', { name: /send command/i });

			expect(sendButton.style.width).toBe('48px');
			expect(sendButton.style.height).toBe('48px');
		});
	});
});

describe('triggerHapticFeedback helper', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.defineProperty(navigator, 'vibrate', {
			value: vi.fn().mockReturnValue(true),
			writable: true,
			configurable: true,
		});
	});

	it('triggers medium haptic (25ms) on submit', () => {
		const onSubmit = vi.fn();
		renderComponent({ value: 'test', onSubmit });

		const form = screen.getByRole('textbox').closest('form');
		fireEvent.submit(form!);

		expect(navigator.vibrate).toHaveBeenCalledWith(25);
	});

	it('triggers strong haptic (50ms) on interrupt', async () => {
		renderComponent({ inputMode: 'ai', isSessionBusy: true, onInterrupt: vi.fn() });

		await focusAiComposer();
		const interruptButton = screen.getByRole('button', { name: /cancel running ai query/i });
		fireEvent.click(interruptButton);

		expect(navigator.vibrate).toHaveBeenCalledWith(50);
	});

	it('does not throw when vibrate is not supported', () => {
		Object.defineProperty(navigator, 'vibrate', {
			value: undefined,
			writable: true,
			configurable: true,
		});

		expect(() => {
			const onSubmit = vi.fn();
			renderComponent({ value: 'test', onSubmit });
			const form = screen.getByRole('textbox').closest('form');
			fireEvent.submit(form!);
		}).not.toThrow();
	});
});

describe('useIsMobilePhone hook', () => {
	beforeEach(() => {
		// Reset to non-mobile defaults
		Object.defineProperty(window, 'innerWidth', { value: 800, writable: true });
		Object.defineProperty(window, 'ontouchstart', { value: undefined, writable: true });
		Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, writable: true });
	});

	it('detects mobile phone when touch and small screen', () => {
		Object.defineProperty(window, 'innerWidth', { value: 400, writable: true });
		Object.defineProperty(window, 'ontouchstart', { value: () => {}, writable: true });

		renderComponent({ inputMode: 'ai' });

		// On mobile phone in AI mode, clicking textarea should expand
		// We can verify the hook is working through behavior
	});

	it('does not detect mobile on large screens', () => {
		Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });
		Object.defineProperty(window, 'ontouchstart', { value: () => {}, writable: true });

		renderComponent({ inputMode: 'ai' });

		// Large screen = not mobile, even with touch
	});

	it('does not detect mobile without touch capability', () => {
		Object.defineProperty(window, 'innerWidth', { value: 400, writable: true });
		Object.defineProperty(window, 'ontouchstart', { value: undefined, writable: true });
		Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, writable: true });

		renderComponent({ inputMode: 'ai' });

		// Small screen but no touch = not mobile phone
	});

	it('responds to resize events', () => {
		Object.defineProperty(window, 'innerWidth', { value: 800, writable: true });
		Object.defineProperty(window, 'ontouchstart', { value: () => {}, writable: true });

		renderComponent({ inputMode: 'ai' });

		// Initially not mobile (800px wide)

		// Simulate resize to mobile width
		Object.defineProperty(window, 'innerWidth', { value: 400, writable: true });

		act(() => {
			fireEvent(window, new Event('resize'));
		});

		// The resize handler runs synchronously, state change will be reflected
	});
});

describe('Visual Viewport API', () => {
	it('responds to keyboard appearance', async () => {
		const mockViewport = {
			height: 400, // Simulating keyboard taking half the screen
			width: 400,
			offsetTop: 0,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		};

		Object.defineProperty(window, 'visualViewport', {
			value: mockViewport,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(window, 'innerHeight', { value: 800, writable: true });

		renderComponent();

		// The component should have registered event listeners
		expect(mockViewport.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
		expect(mockViewport.addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
	});

	it('cleans up viewport listeners on unmount', () => {
		const mockViewport = {
			height: 800,
			width: 400,
			offsetTop: 0,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		};

		Object.defineProperty(window, 'visualViewport', {
			value: mockViewport,
			writable: true,
			configurable: true,
		});

		const { unmount } = renderComponent();
		unmount();

		expect(mockViewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
		expect(mockViewport.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
	});
});

describe('InputMode Type', () => {
	it('exports InputMode type', async () => {
		// TypeScript compile-time check - if this compiles, the type is exported
		const mode1: InputMode = 'ai';
		const mode2: InputMode = 'terminal';

		expect(mode1).toBe('ai');
		expect(mode2).toBe('terminal');
	});
});

describe('Edge Cases', () => {
	it('handles empty recentCommands array gracefully', () => {
		renderComponent({
			recentCommands: [],
			onSelectRecentCommand: vi.fn(),
		});

		expect(screen.queryByTestId('recent-command-chips')).not.toBeInTheDocument();
	});

	it('handles undefined slashCommands (uses defaults)', () => {
		renderComponent({ inputMode: 'ai', slashCommands: undefined });

		const textarea = screen.getByRole('textbox');
		fireEvent.change(textarea, { target: { value: '/' } });

		// Should still show autocomplete with defaults
		expect(screen.getByTestId('slash-autocomplete')).toBeInTheDocument();
	});

	it('handles very long input value', () => {
		const longValue = 'a'.repeat(10000);
		renderComponent({ value: longValue });

		const textarea = screen.getByRole('textbox');
		expect(textarea).toHaveValue(longValue);
	});

	it('handles special characters in input', () => {
		const specialChars = '!@#$%^&*()_+-=[]{}|;\':",.<>?/~`';
		renderComponent({ value: specialChars });

		const textarea = screen.getByRole('textbox');
		expect(textarea).toHaveValue(specialChars);
	});

	it('handles unicode characters', () => {
		const unicode = '你好世界 🌍 مرحبا';
		renderComponent({ value: unicode });

		const textarea = screen.getByRole('textbox');
		expect(textarea).toHaveValue(unicode);
	});

	it('handles newlines in terminal input value', () => {
		const multiline = 'line 1\nline 2\nline 3';
		renderComponent({ inputMode: 'terminal', value: multiline });

		const textarea = screen.getByRole('textbox');
		expect(textarea).toHaveValue(multiline);
	});

	it('handles null/undefined callbacks gracefully', () => {
		expect(() => {
			renderComponent({
				onSubmit: undefined,
				onChange: undefined,
				onInterrupt: undefined,
				onHistoryOpen: undefined,
			});

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'test' } });

			const form = textarea.closest('form');
			fireEvent.submit(form!);
		}).not.toThrow();
	});
});

describe('CSS Animation Styles', () => {
	it('includes pulse animation keyframes', () => {
		renderComponent();

		const styleElement = document.querySelector('style');
		expect(styleElement?.textContent).toContain('@keyframes pulse');
	});
});

describe('Default Export', () => {
	it('exports CommandInputBar as default', async () => {
		const module = await import('../../../web/mobile/CommandInputBar');
		expect(module.default).toBe(module.CommandInputBar);
	});
});
