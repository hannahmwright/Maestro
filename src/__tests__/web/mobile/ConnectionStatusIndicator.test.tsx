import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import {
	ConnectionStatusIndicator,
	type ConnectionStatusIndicatorProps,
} from '../../../web/mobile/ConnectionStatusIndicator';

const mockColors = {
	bgMain: '#0b0b0d',
	bgSidebar: '#111113',
	bgActivity: '#1c1c1f',
	border: '#27272a',
	textMain: '#e4e4e7',
	textDim: '#a1a1aa',
	accent: '#6366f1',
	accentDim: 'rgba(99, 102, 241, 0.2)',
	accentText: '#a5b4fc',
	success: '#22c55e',
	warning: '#eab308',
	error: '#ef4444',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
	useTheme: () => ({
		theme: {
			id: 'dracula',
			name: 'Dracula',
			mode: 'dark',
			colors: mockColors,
		},
		isLight: false,
		isDark: true,
		isVibe: false,
		isDevicePreference: false,
	}),
	ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockTriggerHaptic = vi.fn();

vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: (...args: unknown[]) => mockTriggerHaptic(...args),
	HAPTIC_PATTERNS: {
		tap: [10],
	},
}));

import { HAPTIC_PATTERNS } from '../../../web/mobile/constants';

function createProps(
	overrides: Partial<ConnectionStatusIndicatorProps> = {}
): ConnectionStatusIndicatorProps {
	return {
		connectionState: 'disconnected',
		isOffline: false,
		reconnectAttempts: 0,
		onRetry: vi.fn(),
		...overrides,
	};
}

describe('ConnectionStatusIndicator', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders nothing when the connection is healthy', () => {
		const connected = render(
			<ConnectionStatusIndicator {...createProps({ connectionState: 'connected' })} />
		);
		const authenticated = render(
			<ConnectionStatusIndicator {...createProps({ connectionState: 'authenticated' })} />
		);

		expect(connected.container.firstChild).toBeNull();
		expect(authenticated.container.firstChild).toBeNull();
	});

	it('renders a compact status pill for disconnected state', () => {
		render(<ConnectionStatusIndicator {...createProps()} />);

		expect(screen.getByRole('status')).toBeInTheDocument();
		expect(screen.getByText('Disconnected')).toBeInTheDocument();
		expect(screen.getByLabelText('Retry connection')).toBeInTheDocument();
		expect(screen.getByLabelText('Dismiss connection indicator')).toBeInTheDocument();
	});

	it('uses offline-specific messaging and hides the action buttons', () => {
		render(<ConnectionStatusIndicator {...createProps({ isOffline: true })} />);

		expect(screen.getByText('Offline')).toBeInTheDocument();
		expect(screen.queryByLabelText('Retry connection')).not.toBeInTheDocument();
		expect(screen.queryByLabelText('Dismiss connection indicator')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Offline' }));
		expect(screen.getByText('Will reconnect automatically when online')).toBeInTheDocument();
	});

	it('shows connection progress details only after expanding the message button', () => {
		render(
			<ConnectionStatusIndicator
				{...createProps({
					connectionState: 'connecting',
					reconnectAttempts: 3,
				})}
			/>
		);

		expect(screen.getByText('Connecting')).toBeInTheDocument();
		expect(screen.queryByText('Attempt 3 of 10')).not.toBeInTheDocument();
		expect(screen.getByLabelText('Retry connection')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Connecting' }));
		expect(screen.getByText('Attempt 3 of 10')).toBeInTheDocument();
	});

	it('renders authenticating state with the current label', () => {
		render(
			<ConnectionStatusIndicator
				{...createProps({
					connectionState: 'authenticating',
					reconnectAttempts: 1,
				})}
			/>
		);

		expect(screen.getByText('Authenticating')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Authenticating' }));
		expect(screen.getByText('Attempt 1 of 10')).toBeInTheDocument();
	});

	it('prefers an explicit error message in disconnected details', () => {
		render(
			<ConnectionStatusIndicator
				{...createProps({
					error: 'Custom error',
					reconnectAttempts: 10,
					maxReconnectAttempts: 10,
				})}
			/>
		);

		expect(screen.getByText('Connection failed')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Connection failed' }));
		expect(screen.getByText('Custom error')).toBeInTheDocument();
	});

	it('triggers retry with haptics', () => {
		const onRetry = vi.fn();
		render(<ConnectionStatusIndicator {...createProps({ onRetry })} />);

		fireEvent.click(screen.getByLabelText('Retry connection'));

		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(mockTriggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
	});

	it('supports dismissing disconnected state and restores when the state changes', () => {
		const { rerender, container } = render(<ConnectionStatusIndicator {...createProps()} />);

		fireEvent.click(screen.getByLabelText('Dismiss connection indicator'));
		expect(mockTriggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		expect(container.firstChild).toBeNull();

		rerender(<ConnectionStatusIndicator {...createProps()} />);
		expect(container.firstChild).toBeNull();

		rerender(
			<ConnectionStatusIndicator
				{...createProps({
					connectionState: 'connecting',
				})}
			/>
		);
		expect(screen.getByText('Connecting')).toBeInTheDocument();
	});

	it('toggles aria-expanded when details are opened', () => {
		render(<ConnectionStatusIndicator {...createProps()} />);

		const messageButton = screen.getByRole('button', { name: 'Disconnected' });
		expect(messageButton).toHaveAttribute('aria-expanded', 'false');

		fireEvent.click(messageButton);
		expect(messageButton).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getByText('Tap retry to reconnect')).toBeInTheDocument();
	});

	it('merges custom inline styles onto the pill', () => {
		render(
			<ConnectionStatusIndicator
				{...createProps({
					style: {
						position: 'fixed',
						top: '16px',
					},
				})}
			/>
		);

		const status = screen.getByRole('status');
		expect(status).toHaveStyle({ position: 'fixed', top: '16px' });
	});

	it('renders the pulse keyframes style block', () => {
		const { container } = render(
			<ConnectionStatusIndicator
				{...createProps({
					connectionState: 'connecting',
				})}
			/>
		);

		expect(container.querySelector('style')?.textContent).toContain(
			'@keyframes maestro-connection-indicator-pulse'
		);
	});
});
