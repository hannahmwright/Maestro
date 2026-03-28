import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TabBar } from '../../../web/mobile/TabBar';

const mockColors = {
	accent: '#007acc',
	border: '#333333',
	bgMain: '#1a1a1a',
	bgSidebar: '#111111',
	bgActivity: '#252526',
	textMain: '#ffffff',
	textDim: '#888888',
	success: '#22c55e',
	warning: '#f59e0b',
	error: '#ef4444',
};

const mockTriggerHaptic = vi.fn();

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('../../../web/mobile/constants', async () => {
	const actual = await vi.importActual<typeof import('../../../web/mobile/constants')>(
		'../../../web/mobile/constants'
	);

	return {
		...actual,
		triggerHaptic: (...args: unknown[]) => mockTriggerHaptic(...args),
		HAPTIC_PATTERNS: {
			...actual.HAPTIC_PATTERNS,
			tap: [10],
		},
	};
});

function renderTabBar(props: Partial<React.ComponentProps<typeof TabBar>> = {}) {
	const onNewThread = vi.fn();

	render(<TabBar onNewThread={onNewThread} {...props} />);

	return { onNewThread };
}

async function expandTabBar() {
	fireEvent.click(screen.getByRole('button', { name: 'Pull down to open thread controls' }));
	await screen.findByText('Thread controls');
}

describe('TabBar', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders a collapsed thread controls handle by default', () => {
		renderTabBar();

		expect(
			screen.getByRole('button', { name: 'Pull down to open thread controls' })
		).toBeInTheDocument();
		expect(screen.queryByText('Thread controls')).not.toBeInTheDocument();
	});

	it('expands to show thread controls and a new thread action', async () => {
		renderTabBar();

		await expandTabBar();

		expect(screen.getByText('Thread controls')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'New Thread' })).toBeInTheDocument();
	});

	it('calls onNewThread from the expanded controls', async () => {
		const { onNewThread } = renderTabBar();

		await expandTabBar();
		fireEvent.click(screen.getByRole('button', { name: 'New Thread' }));

		expect(onNewThread).toHaveBeenCalledTimes(1);
	});

	it('shows context usage when provided', async () => {
		renderTabBar({
			contextUsagePercentage: 72,
			contextUsageColor: '#22c55e',
		});

		await expandTabBar();

		expect(screen.getByLabelText('Context window 72% used')).toBeInTheDocument();
		expect(screen.getByText('72%')).toBeInTheDocument();
	});

	it('loads selectable models and calls onSelectModel', async () => {
		const loadModels = vi.fn().mockResolvedValue(['GPT-5', 'GPT-4.1']);
		const onSelectModel = vi.fn().mockResolvedValue(undefined);

		renderTabBar({
			supportsModelSelection: true,
			modelLabel: 'GPT-5',
			loadModels,
			onSelectModel,
		});

		await expandTabBar();
		fireEvent.click(screen.getByRole('button', { name: 'Choose model. Current model: GPT-5' }));

		expect(loadModels).toHaveBeenCalledWith(false);
		fireEvent.click(await screen.findByText('GPT-4.1'));

		await waitFor(() => {
			expect(onSelectModel).toHaveBeenCalledWith('GPT-4.1');
		});
	});

	it('loads provider models and calls onSelectProviderModel', async () => {
		const loadProviderModels = vi.fn().mockResolvedValue([
			{
				provider: 'codex',
				providerLabel: 'Codex',
				options: [
					{ id: 'default', label: 'Default', modelId: null, isDefault: true },
					{ id: 'gpt-5', label: 'GPT-5', modelId: 'gpt-5', isDefault: false },
				],
			},
		]);
		const onSelectProviderModel = vi.fn().mockResolvedValue(undefined);

		renderTabBar({
			canChooseProviderModels: true,
			modelLabel: 'Model',
			modelToolType: 'codex',
			loadProviderModels,
			onSelectProviderModel,
		});

		await expandTabBar();
		fireEvent.click(screen.getByRole('button', { name: 'Choose model. Current model: Model' }));

		expect(loadProviderModels).toHaveBeenCalledWith(false);
		expect(await screen.findByText('Codex')).toBeInTheDocument();
		fireEvent.click(screen.getByText('GPT-5'));

		await waitFor(() => {
			expect(onSelectProviderModel).toHaveBeenCalledWith('codex', 'gpt-5');
		});
	});
});
