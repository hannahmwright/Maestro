import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RenameGroupModal } from '../../../renderer/components/RenameGroupModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Group, Theme } from '../../../renderer/types';

const theme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

const renderModal = (ui: React.ReactElement) =>
	render(<LayerStackProvider>{ui}</LayerStackProvider>);

const groups: Group[] = [
	{ id: 'group-1', name: 'Workspace One', emoji: '📁', collapsed: false, projectRoot: '/repo/one' },
	{ id: 'group-2', name: 'Workspace Two', emoji: '🚀', collapsed: true, projectRoot: '/repo/two' },
];

describe('RenameGroupModal', () => {
	const setGroupName = vi.fn();
	const setGroupEmoji = vi.fn();
	const setGroupProjectRoot = vi.fn();
	const onClose = vi.fn();
	const setGroups = vi.fn();

	const defaultProps = () => ({
		theme,
		groupId: 'group-1',
		groupName: 'Workspace One',
		setGroupName,
		groupEmoji: '📁',
		setGroupEmoji,
		groupProjectRoot: '/repo/one',
		setGroupProjectRoot,
		onClose,
		groups,
		setGroups,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue(null);
	});

	it('renders the current workspace editing fields', () => {
		renderModal(<RenameGroupModal {...defaultProps()} />);

		expect(screen.getByRole('dialog', { name: 'Edit Workspace' })).toBeInTheDocument();
		expect(screen.getByLabelText('Workspace Name')).toHaveValue('Workspace One');
		expect(screen.getByLabelText('Workspace Path')).toHaveValue('/repo/one');
		expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
	});

	it('disables save when the workspace name is blank', () => {
		renderModal(<RenameGroupModal {...defaultProps()} groupName="   " />);

		expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
	});

	it('disables save when the workspace path is blank', () => {
		renderModal(<RenameGroupModal {...defaultProps()} groupProjectRoot="   " />);

		expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
		expect(screen.getByText('Workspace path is required')).toBeInTheDocument();
	});

	it('forwards name and path edits through the provided setters', () => {
		renderModal(<RenameGroupModal {...defaultProps()} />);

		fireEvent.change(screen.getByLabelText('Workspace Name'), {
			target: { value: 'Renamed Workspace' },
		});
		fireEvent.change(screen.getByLabelText('Workspace Path'), {
			target: { value: '/repo/renamed' },
		});

		expect(setGroupName).toHaveBeenCalledWith('Renamed Workspace');
		expect(setGroupProjectRoot).toHaveBeenCalledWith('/repo/renamed');
	});

	it('browses for a workspace path', async () => {
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/repo/from-dialog');

		renderModal(<RenameGroupModal {...defaultProps()} />);

		fireEvent.click(screen.getByRole('button', { name: 'Browse for workspace path' }));

		await waitFor(() => {
			expect(window.maestro.dialog.selectFolder).toHaveBeenCalled();
			expect(setGroupProjectRoot).toHaveBeenCalledWith('/repo/from-dialog');
		});
	});

	it('saves trimmed workspace values back into the matching group', () => {
		renderModal(
			<RenameGroupModal
				{...defaultProps()}
				groupName="  Renamed Workspace  "
				groupEmoji="🎸"
				groupProjectRoot="  /repo/renamed  "
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

		expect(setGroups).toHaveBeenCalledTimes(1);
		const updater = setGroups.mock.calls[0][0] as (value: Group[]) => Group[];
		const nextGroups = updater(groups);

		expect(nextGroups).toEqual([
			{
				...groups[0],
				name: 'Renamed Workspace',
				emoji: '🎸',
				projectRoot: '/repo/renamed',
			},
			groups[1],
		]);
		expect(onClose).toHaveBeenCalled();
	});
});
