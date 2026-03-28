import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileDemoViewer } from '../../../web/mobile/MobileDemoViewer';

const mockColors = {
	accent: '#8b5cf6',
	border: '#374151',
	bgMain: '#1f2937',
	bgSidebar: '#111827',
	textMain: '#f3f4f6',
	textDim: '#9ca3af',
	success: '#22c55e',
	warning: '#f59e0b',
	error: '#ef4444',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('../../../web/utils/config', () => ({
	buildApiUrl: (endpoint: string) => `http://localhost:3000${endpoint}`,
}));

describe('MobileDemoViewer', () => {
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
			filename: 'example.png',
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

	beforeEach(() => {
		vi.restoreAllMocks();
		global.fetch = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes('/demos/demo-1')) {
				return {
					ok: true,
					json: async () => ({ demo: mockDemo }),
				} as Response;
			}

			return {
				ok: true,
				blob: async () => new Blob(['demo-image'], { type: 'image/png' }),
			} as Response;
		}) as typeof fetch;
	});

	it('renders the back-to-thread control and closes when tapped', async () => {
		const onClose = vi.fn();
		render(<MobileDemoViewer demoId="demo-1" onClose={onClose} />);

		await screen.findByText('Example.com');
		fireEvent.click(screen.getByRole('button', { name: /back to thread/i }));

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('opens the full-screen media lightbox and exposes save controls', async () => {
		render(<MobileDemoViewer demoId="demo-1" onClose={vi.fn()} />);

		await screen.findByText('Example.com');
		fireEvent.click((await screen.findAllByRole('button', { name: /tap to zoom/i }))[0]);

		expect(await screen.findByRole('button', { name: /close media preview/i })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /previous image/i })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /next image/i })).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
	});

	it('downloads the currently open media from the lightbox', async () => {
		const clickSpy = vi.fn();
		const fakeAnchor = {
			click: clickSpy,
			set href(_value: string) {},
			set download(_value: string) {},
		} as unknown as HTMLAnchorElement;

		render(<MobileDemoViewer demoId="demo-1" onClose={vi.fn()} />);

		await screen.findByText('Example.com');
		fireEvent.click((await screen.findAllByRole('button', { name: /tap to zoom/i }))[0]);

		const originalCreateElement = document.createElement.bind(document);
		const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation(() => fakeAnchor);
		const removeSpy = vi.spyOn(document.body, 'removeChild').mockImplementation(() => fakeAnchor);
		const createElementSpy = vi
			.spyOn(document, 'createElement')
			.mockImplementation((tagName: string) => {
				if (tagName.toLowerCase() === 'a') {
					return fakeAnchor;
				}
				return originalCreateElement(tagName);
			});
		const createObjectUrlSpy = vi
			.spyOn(URL, 'createObjectURL')
			.mockReturnValue('blob:http://localhost/demo');
		const revokeObjectUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

		fireEvent.click(await screen.findByRole('button', { name: /^save$/i }));

		await waitFor(() => {
			expect(clickSpy).toHaveBeenCalledTimes(1);
		});
		expect(createObjectUrlSpy).toHaveBeenCalled();
		expect(revokeObjectUrlSpy).toHaveBeenCalledWith('blob:http://localhost/demo');
		expect(appendSpy).toHaveBeenCalled();
		expect(removeSpy).toHaveBeenCalled();

		createElementSpy.mockRestore();
		createObjectUrlSpy.mockRestore();
		revokeObjectUrlSpy.mockRestore();
		appendSpy.mockRestore();
		removeSpy.mockRestore();
	});

	it('does not duplicate the poster image inside the first step when they share the same artifact', async () => {
		const duplicatePosterDemo = {
			...mockDemo,
			posterArtifact: {
				...mockDemo.posterArtifact,
				id: 'shared-artifact',
				filename: 'shared.png',
			},
			steps: [
				{
					...mockDemo.steps[0],
					screenshotArtifact: {
						...mockDemo.steps[0].screenshotArtifact,
						id: 'shared-artifact',
						filename: 'shared.png',
					},
				},
			],
		};

		global.fetch = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes('/demos/demo-1')) {
				return {
					ok: true,
					json: async () => ({ demo: duplicatePosterDemo }),
				} as Response;
			}

			return {
				ok: true,
				blob: async () => new Blob(['demo-image'], { type: 'image/png' }),
			} as Response;
		}) as typeof fetch;

		render(<MobileDemoViewer demoId="demo-1" onClose={vi.fn()} />);

		await screen.findByText('Example.com');
		expect(await screen.findAllByRole('button', { name: /tap to zoom/i })).toHaveLength(1);
		expect(screen.queryByAltText('Example.com')).not.toBeInTheDocument();
	});

	it('uses step screenshots as the only image surface for screenshot-only demos', async () => {
		render(<MobileDemoViewer demoId="demo-1" onClose={vi.fn()} />);

		await screen.findByText('Example.com');
		expect(await screen.findAllByRole('button', { name: /tap to zoom/i })).toHaveLength(1);
		expect(screen.queryByAltText('Example.com')).not.toBeInTheDocument();
		expect(screen.getByAltText('Example Domain loaded')).toBeInTheDocument();
	});

	it('supports zooming the full-screen image with touch gestures', async () => {
		render(<MobileDemoViewer demoId="demo-1" onClose={vi.fn()} />);

		await screen.findByText('Example.com');
		fireEvent.click((await screen.findAllByRole('button', { name: /tap to zoom/i }))[0]);

		const zoomedImage = (await screen.findAllByAltText('Example Domain loaded')).at(
			-1
		) as HTMLImageElement;
		const gestureSurface = zoomedImage.parentElement as HTMLElement;

		fireEvent.touchEnd(gestureSurface, {
			changedTouches: [{ clientX: 120, clientY: 160 }],
			touches: [],
		});
		fireEvent.touchEnd(gestureSurface, {
			changedTouches: [{ clientX: 122, clientY: 162 }],
			touches: [],
		});

		expect(zoomedImage.style.transform).toContain('scale(2)');
	});
});
