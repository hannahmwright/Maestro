import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: (...args: unknown[]) => mockTriggerHaptic(...args),
	HAPTIC_PATTERNS: {
		tap: [10],
	},
}));

vi.mock('../../../web/hooks/useLongPress', () => ({
	useLongPress: ({
		onTap,
		onLongPress,
	}: {
		onTap: () => void;
		onLongPress: (rect: DOMRect) => void;
	}) => ({
		elementRef: { current: null },
		handlers: {},
		handleClick: () => onTap(),
		handleContextMenu: (event: React.MouseEvent<HTMLElement>) => {
			event.preventDefault();
			onLongPress(new DOMRect(20, 30, 120, 36));
		},
	}),
}));

type TestTab = {
	id: string;
	name?: string;
	agentSessionId?: string;
	state?: string;
	starred?: boolean;
};

function createTab(overrides: Partial<TestTab> = {}) {
	return {
		id: 'tab-1',
		name: 'Main',
		state: 'idle',
		starred: false,
		...overrides,
	};
}

describe('TabBar', () => {
	const onSelectTab = vi.fn();
	const onNewTab = vi.fn();
	const onCloseTab = vi.fn();
	const onRenameTab = vi.fn();
	const onStarTab = vi.fn();
	const onReorderTab = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders the new-tab button even with no tabs', () => {
		render(
			<TabBar
				tabs={[]}
				activeTabId=""
				onSelectTab={onSelectTab}
				onNewTab={onNewTab}
				onCloseTab={onCloseTab}
			/>
		);

		expect(screen.getByTitle('New Tab')).toBeInTheDocument();
	});

	it('renders tab names and falls back to agent session id', () => {
		render(
			<TabBar
				tabs={[
					createTab({ id: 'tab-1', name: 'Alpha' }),
					createTab({ id: 'tab-2', name: '', agentSessionId: 'abcd-1234' }),
				]}
				activeTabId="tab-1"
				onSelectTab={onSelectTab}
				onNewTab={onNewTab}
				onCloseTab={onCloseTab}
			/>
		);

		expect(screen.getByText('Alpha')).toBeInTheDocument();
		expect(screen.getByText('ABCD')).toBeInTheDocument();
	});

	it('calls onSelectTab when a tab is clicked', () => {
		render(
			<TabBar
				tabs={[createTab({ id: 'tab-1' }), createTab({ id: 'tab-2', name: 'Second' })]}
				activeTabId="tab-1"
				onSelectTab={onSelectTab}
				onNewTab={onNewTab}
				onCloseTab={onCloseTab}
			/>
		);

		fireEvent.click(screen.getByText('Second'));

		expect(onSelectTab).toHaveBeenCalledWith('tab-2');
	});

	it('shows the close button for the active tab when multiple tabs exist', () => {
		render(
			<TabBar
				tabs={[createTab({ id: 'tab-1' }), createTab({ id: 'tab-2', name: 'Second' })]}
				activeTabId="tab-1"
				onSelectTab={onSelectTab}
				onNewTab={onNewTab}
				onCloseTab={onCloseTab}
			/>
		);

		fireEvent.click(screen.getByLabelText('Close tab'));

		expect(onCloseTab).toHaveBeenCalledWith('tab-1');
	});

	it('does not render any close button when there is only one tab', () => {
		render(
			<TabBar
				tabs={[createTab({ id: 'tab-1' })]}
				activeTabId="tab-1"
				onSelectTab={onSelectTab}
				onNewTab={onNewTab}
				onCloseTab={onCloseTab}
			/>
		);

		expect(screen.queryByLabelText('Close tab')).not.toBeInTheDocument();
	});

	it('calls onNewTab when the new-tab button is clicked', () => {
		render(
			<TabBar
				tabs={[createTab({ id: 'tab-1' })]}
				activeTabId="tab-1"
				onSelectTab={onSelectTab}
				onNewTab={onNewTab}
				onCloseTab={onCloseTab}
			/>
		);

		fireEvent.click(screen.getByTitle('New Tab'));

		expect(onNewTab).toHaveBeenCalledTimes(1);
	});

	it('renders busy and starred indicators', () => {
		const { container } = render(
			<TabBar
				tabs={[createTab({ id: 'tab-1', state: 'busy', starred: true })]}
				activeTabId="tab-1"
				onSelectTab={onSelectTab}
				onNewTab={onNewTab}
				onCloseTab={onCloseTab}
			/>
		);

		expect(container.textContent).toContain('★');
		expect(container.querySelector('[style*="animation: pulse"]')).toBeInTheDocument();
	});

	it('opens the actions popover on context menu', () => {
		render(
			<TabBar
				tabs={[createTab({ id: 'tab-1' }), createTab({ id: 'tab-2', name: 'Second' })]}
				activeTabId="tab-1"
				onSelectTab={onSelectTab}
				onNewTab={onNewTab}
				onCloseTab={onCloseTab}
				onRenameTab={onRenameTab}
				onStarTab={onStarTab}
				onReorderTab={onReorderTab}
			/>
		);

		fireEvent.contextMenu(screen.getByText('Main'));

		expect(screen.getByRole('dialog', { name: 'Actions for tab Main' })).toBeInTheDocument();
		expect(screen.getByText('Rename')).toBeInTheDocument();
		expect(screen.getByText('Star')).toBeInTheDocument();
	});

	it('stars and unstarrs a tab from the actions popover', () => {
		const { rerender } = render(
			<TabBar
				tabs={[
					createTab({ id: 'tab-1', name: 'Primary', starred: false }),
					createTab({ id: 'tab-2', name: 'Secondary' }),
				]}
				activeTabId="tab-1"
				onSelectTab={onSelectTab}
				onNewTab={onNewTab}
				onCloseTab={onCloseTab}
				onStarTab={onStarTab}
			/>
		);

		fireEvent.contextMenu(screen.getByText('Primary'));
		fireEvent.click(screen.getByText('Star'));
		expect(onStarTab).toHaveBeenCalledWith('tab-1', true);

		rerender(
			<TabBar
				tabs={[
					createTab({ id: 'tab-1', name: 'Primary', starred: true }),
					createTab({ id: 'tab-2', name: 'Secondary' }),
				]}
				activeTabId="tab-1"
				onSelectTab={onSelectTab}
				onNewTab={onNewTab}
				onCloseTab={onCloseTab}
				onStarTab={onStarTab}
			/>
		);

		fireEvent.contextMenu(screen.getByText('Primary'));
		fireEvent.click(screen.getByText('Unstar'));
		expect(onStarTab).toHaveBeenCalledWith('tab-1', false);
	});

	it('renames a tab from the actions popover', () => {
		render(
			<TabBar
				tabs={[
					createTab({ id: 'tab-1', name: 'Primary' }),
					createTab({ id: 'tab-2', name: 'Secondary' }),
				]}
				activeTabId="tab-1"
				onSelectTab={onSelectTab}
				onNewTab={onNewTab}
				onCloseTab={onCloseTab}
				onRenameTab={onRenameTab}
			/>
		);

		fireEvent.contextMenu(screen.getByText('Primary'));
		fireEvent.click(screen.getByText('Rename'));
		fireEvent.change(screen.getByPlaceholderText('Tab name'), {
			target: { value: 'Renamed Tab' },
		});
		fireEvent.click(screen.getByText('Save'));

		expect(onRenameTab).toHaveBeenCalledWith('tab-1', 'Renamed Tab');
	});

	it('reorders tabs from the actions popover', () => {
		render(
			<TabBar
				tabs={[
					createTab({ id: 'tab-1', name: 'First' }),
					createTab({ id: 'tab-2', name: 'Second' }),
					createTab({ id: 'tab-3', name: 'Third' }),
				]}
				activeTabId="tab-2"
				onSelectTab={onSelectTab}
				onNewTab={onNewTab}
				onCloseTab={onCloseTab}
				onReorderTab={onReorderTab}
			/>
		);

		fireEvent.contextMenu(screen.getByText('Second'));
		fireEvent.click(screen.getByText('Move Left'));
		expect(onReorderTab).toHaveBeenCalledWith(1, 0);
	});

	it('omits unavailable actions when callbacks are not provided', () => {
		render(
			<TabBar
				tabs={[
					createTab({ id: 'tab-1', name: 'Primary' }),
					createTab({ id: 'tab-2', name: 'Secondary' }),
				]}
				activeTabId="tab-1"
				onSelectTab={onSelectTab}
				onNewTab={onNewTab}
				onCloseTab={onCloseTab}
			/>
		);

		fireEvent.contextMenu(screen.getByText('Primary'));

		expect(screen.queryByText('Rename')).not.toBeInTheDocument();
		expect(screen.queryByText('Star')).not.toBeInTheDocument();
		expect(screen.queryByText('Move Left')).not.toBeInTheDocument();
	});
});
