/**
 * Tests for useVoiceInput hook
 *
 * Covers:
 * - local recording support detection
 * - record -> transcribe flow
 * - graceful unsupported-browser handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useVoiceInput, isVoiceRecordingSupported } from '../../../web/hooks/useVoiceInput';

vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

class MockMediaRecorder {
	static isTypeSupported = vi.fn(() => true);

	state: RecordingState = 'inactive';
	mimeType = 'audio/webm';
	ondataavailable: ((event: BlobEvent) => void) | null = null;
	onstart: ((event: Event) => void) | null = null;
	onstop: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;

	constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
		if (options?.mimeType) {
			this.mimeType = options.mimeType;
		}
	}

	start() {
		this.state = 'recording';
		this.onstart?.(new Event('start'));
	}

	stop() {
		this.state = 'inactive';
		this.ondataavailable?.({
			data: new Blob(['audio'], { type: this.mimeType }),
		} as BlobEvent);
		this.onstop?.(new Event('stop'));
	}
}

function setRecordingSupport(enabled: boolean) {
	if (enabled) {
		Object.defineProperty(window, 'MediaRecorder', {
			value: MockMediaRecorder,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(navigator, 'mediaDevices', {
			value: {
				getUserMedia: vi.fn(async () => ({
					getTracks: () => [],
				})),
			},
			configurable: true,
		});
		return;
	}

	Object.defineProperty(window, 'MediaRecorder', {
		value: undefined,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(navigator, 'mediaDevices', {
		value: undefined,
		configurable: true,
	});
}

describe('useVoiceInput', () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		vi.clearAllMocks();
		setRecordingSupport(true);
		global.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/transcribe/status')) {
				return {
					ok: true,
					json: async () => ({
						available: true,
						ready: true,
						warming: false,
						backend: 'local-faster-whisper',
					}),
				} as Response;
			}

			if (url.includes('/transcribe/prewarm')) {
				return {
					ok: true,
					json: async () => ({
						available: true,
						ready: true,
						warming: false,
						backend: 'local-faster-whisper',
					}),
				} as Response;
			}

			return {
				ok: true,
				json: async () => ({
					text: 'world',
					language: 'en',
					backend: 'local-faster-whisper',
					durationMs: 120,
				}),
			} as Response;
		}) as typeof fetch;
	});

	afterEach(() => {
		global.fetch = originalFetch;
		setRecordingSupport(false);
	});

	it('detects local recording support', () => {
		expect(isVoiceRecordingSupported()).toBe(true);
	});

	it('records audio and merges the transcript into the draft', async () => {
		const onTranscriptionChange = vi.fn();

		const { result } = renderHook(() =>
			useVoiceInput({
				currentValue: 'hello',
				onTranscriptionChange,
			})
		);

		await act(async () => {
			result.current.startVoiceInput();
			await Promise.resolve();
		});

		await waitFor(() => {
			expect(result.current.isListening).toBe(true);
			expect(result.current.voiceState).toBe('recording');
		});

		await act(async () => {
			result.current.stopVoiceInput();
			await Promise.resolve();
		});

		await waitFor(
			() => {
				expect(onTranscriptionChange).toHaveBeenCalledWith('hello world');
				expect(result.current.voiceState).toBe('idle');
			},
			{ timeout: 3000 }
		);
	});

	it('can stop recording and submit the transcript without leaving it in review state', async () => {
		const onTranscriptionChange = vi.fn();
		const onTranscriptionSubmit = vi.fn();

		const { result } = renderHook(() =>
			useVoiceInput({
				currentValue: 'hello',
				onTranscriptionChange,
				onTranscriptionSubmit,
			})
		);

		await act(async () => {
			result.current.startVoiceInput();
			await Promise.resolve();
		});

		await waitFor(() => {
			expect(result.current.voiceState).toBe('recording');
		});

		await act(async () => {
			result.current.stopVoiceInputAndSubmit();
			await Promise.resolve();
		});

		await waitFor(
			() => {
				expect(onTranscriptionSubmit).toHaveBeenCalledWith('hello world');
				expect(onTranscriptionChange).not.toHaveBeenCalled();
				expect(result.current.voiceState).toBe('idle');
			},
			{ timeout: 3000 }
		);
	});

	it('reports unsupported browsers cleanly', () => {
		setRecordingSupport(false);
		expect(isVoiceRecordingSupported()).toBe(false);
	});
});
