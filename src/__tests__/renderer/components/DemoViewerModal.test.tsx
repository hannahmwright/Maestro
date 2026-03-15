import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoViewerModal } from '../../../renderer/components/DemoViewerModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#0f172a',
		bgSidebar: '#111827',
		bgPanel: '#1f2937',
		bgActivity: '#1e293b',
		textMain: '#f8fafc',
		textDim: '#94a3b8',
		accent: '#8b5cf6',
		accentForeground: '#ffffff',
		border: '#334155',
		highlight: '#8b5cf633',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const mockDemo = {
	demoId: 'demo-1',
	captureRunId: 'run-1',
	title: 'Example.com',
	summary: 'Opened https://example.com and captured a screenshot',
	status: 'completed',
	verificationStatus: 'verified',
	captureSource: 'maestro_demo_cli',
	isSimulated: false,
	requirementSatisfied: true,
	createdAt: Date.now(),
	updatedAt: Date.now(),
	stepCount: 1,
	durationMs: 1200,
	sessionId: 'session-1',
	tabId: 'tab-1',
	posterArtifact: {
		id: 'poster-1',
		kind: 'image',
		mimeType: 'image/png',
		byteSize: 128,
		createdAt: Date.now(),
		filename: 'poster.png',
	},
	videoArtifact: null,
	steps: [
		{
			id: 'step-1',
			demoId: 'demo-1',
			orderIndex: 0,
			title: 'Example Domain loaded',
			description: 'Navigated to https://example.com',
			screenshotArtifact: {
				id: 'step-artifact-1',
				kind: 'image',
				mimeType: 'image/png',
				byteSize: 128,
				createdAt: Date.now(),
				filename: 'step.png',
			},
		},
	],
};

function renderWithProviders(component: React.ReactElement) {
	return render(<LayerStackProvider>{component}</LayerStackProvider>);
}

describe('DemoViewerModal', () => {
	const getDemo = vi.fn();
	const loadArtifact = vi.fn();
	const getArtifactFileInfo = vi.fn();
	const exportArtifact = vi.fn();
	const saveFile = vi.fn();

	beforeEach(() => {
		vi.restoreAllMocks();

		getDemo.mockResolvedValue(mockDemo);
		loadArtifact.mockImplementation(async (artifactId: string) => `data:image/png;base64,${artifactId}`);
		getArtifactFileInfo.mockResolvedValue(null);
		exportArtifact.mockResolvedValue({ success: true });
		saveFile.mockResolvedValue('/tmp/saved-demo.png');

		window.maestro = {
			...window.maestro,
			artifacts: {
				...window.maestro?.artifacts,
				getDemo,
				loadArtifact,
				getArtifactFileInfo,
				exportArtifact,
			},
			dialog: {
				...window.maestro?.dialog,
				saveFile,
			},
		};
	});

	it('renders as a full-screen dialog and closes from the header button', async () => {
		const onClose = vi.fn();
		renderWithProviders(<DemoViewerModal theme={mockTheme} demoId="demo-1" onClose={onClose} />);

		expect(await screen.findByRole('dialog', { name: /example.com/i })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /close demo viewer/i }));

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('opens a screenshot in the lightbox and allows saving it', async () => {
		renderWithProviders(<DemoViewerModal theme={mockTheme} demoId="demo-1" onClose={vi.fn()} />);

		await screen.findByRole('dialog', { name: /example.com/i });
		fireEvent.click(screen.getByRole('button', { name: /click to zoom/i }));
		expect(await screen.findByRole('button', { name: /close media preview/i })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

		await waitFor(() => {
			expect(saveFile).toHaveBeenCalledWith(
				expect.objectContaining({
					defaultPath: 'poster.png',
					title: 'Save demo media',
				})
			);
		});
		expect(exportArtifact).toHaveBeenCalledWith('poster-1', '/tmp/saved-demo.png');
	});

	it('loads desktop video playback through the artifact loader', async () => {
		getDemo.mockResolvedValue({
			...mockDemo,
			durationMs: 12120,
			videoArtifact: {
				id: 'video-1',
				kind: 'video',
				mimeType: 'video/mp4',
				byteSize: 2048,
				createdAt: Date.now(),
				filename: 'demo video.mp4',
				durationMs: 12120,
			},
		});
		loadArtifact.mockImplementation(async (artifactId: string) =>
			artifactId === 'video-1'
				? 'data:video/mp4;base64,AAAA'
				: `data:image/png;base64,${artifactId}`
		);

		renderWithProviders(<DemoViewerModal theme={mockTheme} demoId="demo-1" onClose={vi.fn()} />);

		await screen.findByRole('dialog', { name: /example.com/i });

		const video = document.querySelector('video');
		expect(video).not.toBeNull();
		expect(video?.getAttribute('src')).toBe('data:video/mp4;base64,AAAA');
		expect(screen.getByText('0:12')).toBeInTheDocument();
		expect(loadArtifact).toHaveBeenCalledWith('video-1');
	});
});
