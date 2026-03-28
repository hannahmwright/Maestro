import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NewInstanceModal } from '../../../renderer/components/NewInstanceModal';
import type { AgentConfig, Session, Theme } from '../../../renderer/types';

const mockRegisterLayer = vi.fn(() => 'layer-new-instance-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

const theme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e8e8e8',
		textDim: '#888888',
		accent: '#7b2cbf',
		accentForeground: '#ffffff',
		border: '#333355',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		info: '#3b82f6',
		bgAccentHover: '#9333ea',
	},
};

const createAgentConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
	id: 'claude-code',
	name: 'Claude Code',
	available: true,
	path: '/usr/local/bin/claude',
	binaryName: 'claude',
	hidden: false,
	capabilities: {
		supportsModelSelection: false,
	},
	...overrides,
});

describe('NewInstanceModal', () => {
	const onClose = vi.fn();
	const onCreate = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		mockRegisterLayer.mockReturnValue('layer-new-instance-123');
		vi.mocked(window.maestro.fs.homeDir).mockResolvedValue('/home/testuser');
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
		]);
		vi.mocked(window.maestro.agents.getAllCustomPaths).mockResolvedValue({});
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue(null);
		vi.mocked(window.maestro.agents.refresh).mockResolvedValue({
			agents: [createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true })],
			debugInfo: null,
		});
		vi.mocked(window.maestro.agents.setCustomPath).mockResolvedValue(undefined);
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [],
		});
	});

	const renderModal = (props: Partial<React.ComponentProps<typeof NewInstanceModal>> = {}) =>
		render(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[] as Session[]}
				{...props}
			/>
		);

	it('renders nothing when closed', async () => {
		const { container } = render(
			<NewInstanceModal
				isOpen={false}
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);

		await act(async () => {
			await Promise.resolve();
		});

		expect(container.firstChild).toBeNull();
	});

	it('renders the current workspace creation labels in workspace mode', async () => {
		renderModal();

		expect(screen.getByRole('dialog', { name: 'Create New Workspace' })).toBeInTheDocument();
		expect(screen.getByLabelText('First Thread Name')).toBeInTheDocument();
		expect(screen.getByText('Initial Provider')).toBeInTheDocument();
		expect(screen.getByLabelText('Working Directory')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create Workspace' })).toBeInTheDocument();

		await waitFor(() => {
			expect(screen.getByText('Claude Code')).toBeInTheDocument();
			expect(screen.getByText('Available')).toBeInTheDocument();
		});
	});

	it('renders the current labels in thread mode', () => {
		renderModal({
			mode: 'thread',
			workspaceId: 'workspace-1',
		});

		expect(screen.getByRole('dialog', { name: 'Create New Thread' })).toBeInTheDocument();
		expect(screen.getByText('Choose a provider')).toBeInTheDocument();
		expect(screen.getByText(/Nudge Message/i)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create Thread' })).toBeInTheDocument();
	});

	it('creates a workspace with the selected provider and expanded home-directory path', async () => {
		renderModal();

		await waitFor(() => {
			expect(screen.getByText('Claude Code')).toBeInTheDocument();
		});

		fireEvent.change(screen.getByLabelText('First Thread Name'), {
			target: { value: 'Inbox Thread' },
		});
		fireEvent.change(screen.getByLabelText('Working Directory'), {
			target: { value: '~/project' },
		});
		fireEvent.click(screen.getByText('Claude Code'));
		fireEvent.click(screen.getByRole('button', { name: 'Create Workspace' }));

		await waitFor(() => {
			expect(onCreate).toHaveBeenCalledTimes(1);
		});

		const args = onCreate.mock.calls[0];
		expect(args[0]).toBe('claude-code');
		expect(args[1]).toBe('/home/testuser/project');
		expect(args[2]).toBe('Inbox Thread');
		expect(args[10]).toEqual({ enabled: false, remoteId: null });
		expect(args[11]).toBeUndefined();
		expect(onClose).toHaveBeenCalled();
	});
});
