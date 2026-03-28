import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandInputBar } from '../../../web/mobile/CommandInputBar';

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgMain: '#111',
		bgSidebar: '#222',
		textMain: '#fff',
		textDim: '#999',
		accent: '#0af',
		border: '#444',
		error: '#f00',
	}),
}));

vi.mock('../../../web/hooks/useSwipeUp', () => ({
	useSwipeUp: () => ({ handlers: {} }),
}));

vi.mock('../../../web/hooks/useKeyboardVisibility', () => ({
	useKeyboardVisibility: () => ({ keyboardOffset: 0, isKeyboardVisible: false }),
}));

vi.mock('../../../web/hooks/useSlashCommandAutocomplete', () => ({
	useSlashCommandAutocomplete: () => ({
		isOpen: false,
		selectedIndex: 0,
		setSelectedIndex: vi.fn(),
		handleInputChange: vi.fn(),
		handleSelectCommand: vi.fn(),
		handleClose: vi.fn(),
	}),
}));

vi.mock('../../../web/hooks/useVoiceInput', () => ({
	useVoiceInput: () => ({
		isListening: false,
		isTranscribing: false,
		voiceState: 'idle',
		voiceStatusText: '',
		voiceSupported: false,
		stopVoiceInput: vi.fn(),
		stopVoiceInputAndSubmit: vi.fn(),
		toggleVoiceInput: vi.fn(),
	}),
}));

vi.mock('../../../web/mobile/RecentCommandChips', () => ({
	RecentCommandChips: () => null,
}));

vi.mock('../../../web/mobile/SlashCommandAutocomplete', () => ({
	SlashCommandAutocomplete: () => null,
	DEFAULT_SLASH_COMMANDS: [],
}));

vi.mock('../../../web/mobile/CommandInputButtons', () => ({
	ModelSelectorButton: () => null,
	VoiceInputButton: () => null,
	SendInterruptButton: ({ onSend }: { onSend?: () => void }) => (
		<button type="button" onClick={onSend}>
			Send
		</button>
	),
	ExpandedModeSendInterruptButton: ({ onSend }: { onSend?: () => void }) => (
		<button type="button" onClick={onSend}>
			Send
		</button>
	),
}));

function renderBar(overrides: Partial<React.ComponentProps<typeof CommandInputBar>> = {}) {
	return render(
		<CommandInputBar
			isOffline={false}
			isConnected
			inputMode="ai"
			value=""
			onChange={vi.fn()}
			onSubmit={vi.fn()}
			onToggleDemoCapture={vi.fn()}
			{...overrides}
		/>
	);
}

describe('CommandInputBar demo capture action', () => {
	it('opens the actions menu and toggles demo capture', () => {
		const onToggleDemoCapture = vi.fn();
		renderBar({ onToggleDemoCapture });

		fireEvent.click(screen.getByRole('button', { name: /actions/i }));
		fireEvent.click(screen.getByRole('button', { name: /require demo\/screenshots/i }));

		expect(onToggleDemoCapture).toHaveBeenCalledTimes(1);
	});

	it('shows the active demo capture label when the next run is marked for capture', () => {
		renderBar({ demoCaptureEnabled: true });

		fireEvent.click(screen.getByRole('button', { name: /actions/i }));

		expect(screen.getAllByText('Demo/screenshots required').length).toBeGreaterThan(0);
	});
});
