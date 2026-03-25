import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import MobileNavigationDrawer from '../../../web/mobile/MobileNavigationDrawer';

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgMain: '#ffffff',
		bgSidebar: '#f8fafc',
		bgActivity: '#eef2ff',
		textMain: '#111827',
		textDim: '#6b7280',
		accent: '#2563eb',
		border: '#cbd5e1',
		error: '#dc2626',
	}),
}));

vi.mock('../../../web/hooks/useSwipeGestures', () => ({
	useSwipeGestures: () => ({
		handlers: {},
		offsetX: 0,
		isDragging: false,
		isSwiping: false,
		resetOffset: vi.fn(),
	}),
}));

vi.mock('../../../web/mobile/CommandInputButtons', () => ({
	ProviderModelIcon: () => <span data-testid="provider-model-icon" />,
}));

describe('MobileNavigationDrawer', () => {
	it('uses the full mobile viewport width when open', async () => {
		const sessions = [
			{
				id: 'session-1',
				name: 'Codex Thread 1',
				threadTitle: 'Codex Thread 1',
				workspaceName: 'General',
				workspaceEmoji: '📁',
				lastTurnAt: Date.now(),
				lastResponse: { timestamp: Date.now() },
				aiTabs: [],
				toolType: 'codex',
			},
		] as any;

		const { container } = render(
			<MobileNavigationDrawer
				isOpen={true}
				sessions={sessions}
				activeSessionId="session-1"
				onClose={vi.fn()}
				onSelectSession={vi.fn()}
				canOpenTabSearch={false}
			/>
		);

		await screen.findAllByText('Workspaces');
		const aside = container.querySelector('aside') as HTMLElement;
		expect(aside.style.width).toBe('100%');
		expect(aside.style.maxWidth).toBe('100vw');
	});
});
