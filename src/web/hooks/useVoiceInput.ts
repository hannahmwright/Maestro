import { useRef, useState, useCallback, useEffect } from 'react';
import { buildApiUrl } from '../utils/config';
import { webLogger } from '../utils/logger';
import type {
	WebVoiceTranscriptionRequest,
	WebVoiceTranscriptionResponse,
	WebVoiceTranscriptionStatusResponse,
} from '../../shared/remote-web';

const MAX_RECORDING_MS = 90_000;
const MICROPHONE_REQUEST_TIMEOUT_MS = 12_000;
const RECORDING_TICK_MS = 250;
type VoiceBackendState = 'unknown' | 'warming' | 'ready' | 'unavailable';

export function isVoiceRecordingSupported(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof navigator !== 'undefined' &&
		!!navigator.mediaDevices?.getUserMedia &&
		typeof window.MediaRecorder !== 'undefined'
	);
}

function getPreferredMimeType(): string {
	if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') {
		return '';
	}

	for (const mimeType of [
		'audio/webm;codecs=opus',
		'audio/mp4',
		'audio/webm',
		'audio/ogg;codecs=opus',
	]) {
		if (
			typeof window.MediaRecorder.isTypeSupported === 'function' &&
			window.MediaRecorder.isTypeSupported(mimeType)
		) {
			return mimeType;
		}
	}

	return '';
}

function triggerHapticFeedback(pattern: 'light' | 'medium' | 'strong' | number = 'medium'): void {
	if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
		const duration =
			pattern === 'light' ? 10 : pattern === 'medium' ? 25 : pattern === 'strong' ? 50 : pattern;

		try {
			navigator.vibrate(duration);
		} catch {
			// Ignore vibration failures.
		}
	}
}

async function getMicrophonePermissionState(): Promise<PermissionState | null> {
	if (
		typeof navigator === 'undefined' ||
		!('permissions' in navigator) ||
		!navigator.permissions?.query
	) {
		return null;
	}

	try {
		const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
		return status.state;
	} catch {
		return null;
	}
}

function formatRecordingDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
	const blobArrayBuffer =
		typeof blob.arrayBuffer === 'function'
			? await blob.arrayBuffer()
			: await new Promise<ArrayBuffer>((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => {
						if (reader.result instanceof ArrayBuffer) {
							resolve(reader.result);
							return;
						}
						reject(new Error('Unable to read recorded audio.'));
					};
					reader.onerror = () => {
						reject(reader.error || new Error('Unable to read recorded audio.'));
					};
					reader.readAsArrayBuffer(blob);
				});
	const buffer = new Uint8Array(blobArrayBuffer);
	let binary = '';
	const chunkSize = 0x8000;
	for (let index = 0; index < buffer.length; index += chunkSize) {
		const chunk = buffer.subarray(index, index + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function mergeTranscriptIntoDraft(
	currentValue: string,
	transcript: string,
	selection: { start: number; end: number } | null
): { value: string; caretPosition: number } {
	const cleanedTranscript = transcript.trim();
	if (!cleanedTranscript) {
		return {
			value: currentValue,
			caretPosition: selection?.end ?? currentValue.length,
		};
	}

	if (!selection) {
		const separator = currentValue.trim().length > 0 ? ' ' : '';
		const nextValue = `${currentValue}${separator}${cleanedTranscript}`;
		return {
			value: nextValue,
			caretPosition: nextValue.length,
		};
	}

	const before = currentValue.slice(0, selection.start);
	const after = currentValue.slice(selection.end);
	const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
	const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
	const insertedText = `${needsLeadingSpace ? ' ' : ''}${cleanedTranscript}${needsTrailingSpace ? ' ' : ''}`;
	const nextValue = `${before}${insertedText}${after}`;
	return {
		value: nextValue,
		caretPosition: before.length + insertedText.length,
	};
}

type VoiceInputState = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error';

export interface UseVoiceInputOptions {
	currentValue: string;
	disabled?: boolean;
	onTranscriptionChange: (newValue: string) => void;
	onTranscriptionSubmit?: (newValue: string) => void;
	focusRef?: React.RefObject<HTMLTextAreaElement | HTMLInputElement>;
}

export interface UseVoiceInputReturn {
	isListening: boolean;
	isTranscribing: boolean;
	voiceSupported: boolean;
	voiceState: VoiceInputState;
	voiceStatusText: string | null;
	voiceError: string | null;
	startVoiceInput: () => void;
	stopVoiceInput: () => void;
	stopVoiceInputAndSubmit: () => void;
	toggleVoiceInput: () => void;
}

export function useVoiceInput({
	currentValue,
	disabled = false,
	onTranscriptionChange,
	onTranscriptionSubmit,
	focusRef,
}: UseVoiceInputOptions): UseVoiceInputReturn {
	const [voiceState, setVoiceState] = useState<VoiceInputState>('idle');
	const [voiceError, setVoiceError] = useState<string | null>(null);
	const currentValueRef = useRef(currentValue);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const mediaStreamRef = useRef<MediaStream | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const recordingTimerRef = useRef<number | null>(null);
	const recordingDurationIntervalRef = useRef<number | null>(null);
	const microphoneRequestTokenRef = useRef(0);
	const selectionRef = useRef<{ start: number; end: number } | null>(null);
	const pendingStopActionRef = useRef<'review' | 'submit'>('review');
	const [recordingDurationMs, setRecordingDurationMs] = useState(0);
	const [backendState, setBackendState] = useState<VoiceBackendState>('unknown');
	const [, setBackendError] = useState<string | null>(null);
	const recorderSupported = isVoiceRecordingSupported();
	const voiceSupported = recorderSupported && backendState !== 'unavailable';

	useEffect(() => {
		currentValueRef.current = currentValue;
	}, [currentValue]);

	const applyBackendStatus = useCallback((status: WebVoiceTranscriptionStatusResponse) => {
		if (status.ready) {
			setBackendState('ready');
			setBackendError(null);
			return;
		}

		if (status.warming) {
			setBackendState('warming');
			setBackendError(null);
			return;
		}

		if (status.available) {
			setBackendState('unknown');
			setBackendError(null);
			return;
		}

		setBackendState('unavailable');
		setBackendError(status.error || 'Voice transcription is unavailable.');
	}, []);

	const warmVoiceBackend = useCallback(async () => {
		if (!recorderSupported) {
			return;
		}

		try {
			const statusResponse = await fetch(buildApiUrl('/transcribe/status'), {
				cache: 'no-store',
			});
			if (!statusResponse.ok) {
				return;
			}

			const statusPayload = (await statusResponse.json()) as WebVoiceTranscriptionStatusResponse & {
				timestamp?: number;
			};
			applyBackendStatus(statusPayload);

			if (statusPayload.ready || statusPayload.warming) {
				return;
			}

			setBackendState('warming');
			const prewarmResponse = await fetch(buildApiUrl('/transcribe/prewarm'), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({}),
			});
			if (!prewarmResponse.ok) {
				return;
			}

			const prewarmPayload =
				(await prewarmResponse.json()) as WebVoiceTranscriptionStatusResponse & {
					timestamp?: number;
				};
			applyBackendStatus(prewarmPayload);
		} catch (error) {
			webLogger.warn('Voice transcription backend warmup failed', 'VoiceInput', { error });
		}
	}, [applyBackendStatus, recorderSupported]);

	useEffect(() => {
		if (!recorderSupported) {
			setBackendState('unavailable');
			setBackendError('Voice recording is not supported in this browser.');
			return;
		}

		void warmVoiceBackend();
	}, [recorderSupported, warmVoiceBackend]);

	useEffect(() => {
		if (!recorderSupported) {
			return;
		}

		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible' && backendState !== 'ready') {
				void warmVoiceBackend();
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);
		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, [backendState, recorderSupported, warmVoiceBackend]);

	const clearRecordingTimer = useCallback(() => {
		if (recordingTimerRef.current !== null) {
			window.clearTimeout(recordingTimerRef.current);
			recordingTimerRef.current = null;
		}
	}, []);

	const clearRecordingDurationInterval = useCallback(() => {
		if (recordingDurationIntervalRef.current !== null) {
			window.clearInterval(recordingDurationIntervalRef.current);
			recordingDurationIntervalRef.current = null;
		}
	}, []);

	const cleanupStream = useCallback(() => {
		clearRecordingTimer();
		clearRecordingDurationInterval();
		mediaRecorderRef.current = null;
		if (mediaStreamRef.current) {
			for (const track of mediaStreamRef.current.getTracks()) {
				track.stop();
			}
			mediaStreamRef.current = null;
		}
	}, [clearRecordingDurationInterval, clearRecordingTimer]);

	const finalizeTranscription = useCallback(async () => {
		const recordedBlob = new Blob(chunksRef.current, {
			type: mediaRecorderRef.current?.mimeType || getPreferredMimeType() || 'audio/webm',
		});
		chunksRef.current = [];

		if (recordedBlob.size === 0) {
			setVoiceState('error');
			setVoiceError('No speech captured. Try again.');
			triggerHapticFeedback('light');
			return;
		}

		setVoiceState('transcribing');
		setVoiceError(null);

		try {
			const body: WebVoiceTranscriptionRequest = {
				audioBase64: await blobToBase64(recordedBlob),
				mimeType: recordedBlob.type || 'audio/webm',
				language: 'en',
			};
			const response = await fetch(buildApiUrl('/transcribe'), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				const errorPayload = (await response.json().catch(() => null)) as {
					message?: string;
				} | null;
				throw new Error(errorPayload?.message || 'Voice transcription failed.');
			}

			const payload = (await response.json()) as WebVoiceTranscriptionResponse & {
				timestamp?: number;
			};
			setBackendState('ready');
			setBackendError(null);
			if (!payload.text.trim()) {
				setVoiceState('error');
				setVoiceError('No speech detected. Try again.');
				triggerHapticFeedback('light');
				return;
			}

			const merged = mergeTranscriptIntoDraft(
				currentValueRef.current,
				payload.text,
				selectionRef.current
			);
			if (pendingStopActionRef.current === 'submit' && onTranscriptionSubmit) {
				onTranscriptionSubmit(merged.value);
			} else {
				onTranscriptionChange(merged.value);
			}
			triggerHapticFeedback('medium');

			if (pendingStopActionRef.current !== 'submit') {
				requestAnimationFrame(() => {
					const input = focusRef?.current;
					if (!input) {
						return;
					}
					input.focus();
					if ('setSelectionRange' in input) {
						input.setSelectionRange(merged.caretPosition, merged.caretPosition);
					}
				});
			}

			setVoiceState('idle');
			setRecordingDurationMs(0);
			pendingStopActionRef.current = 'review';
		} catch (error) {
			webLogger.error('Voice transcription request failed', 'VoiceInput', error);
			if (error instanceof Error && /unavailable|not configured/i.test(error.message)) {
				setBackendState('unavailable');
				setBackendError(error.message);
			}
			setVoiceState('error');
			setVoiceError(error instanceof Error ? error.message : 'Voice transcription failed.');
			pendingStopActionRef.current = 'review';
			triggerHapticFeedback('strong');
		}
	}, [focusRef, onTranscriptionChange, onTranscriptionSubmit]);

	const cancelPendingMicrophoneRequest = useCallback(() => {
		microphoneRequestTokenRef.current += 1;
		setVoiceState('idle');
		setVoiceError(null);
		setRecordingDurationMs(0);
	}, []);

	const stopVoiceInput = useCallback(() => {
		pendingStopActionRef.current = 'review';
		if (voiceState === 'requesting') {
			cancelPendingMicrophoneRequest();
			return;
		}

		const recorder = mediaRecorderRef.current;
		if (!recorder || recorder.state === 'inactive') {
			return;
		}

		clearRecordingTimer();
		recorder.stop();
	}, [cancelPendingMicrophoneRequest, clearRecordingTimer, voiceState]);

	const stopVoiceInputAndSubmit = useCallback(() => {
		pendingStopActionRef.current = 'submit';
		if (voiceState === 'requesting') {
			cancelPendingMicrophoneRequest();
			pendingStopActionRef.current = 'review';
			return;
		}

		const recorder = mediaRecorderRef.current;
		if (!recorder || recorder.state === 'inactive') {
			pendingStopActionRef.current = 'review';
			return;
		}

		clearRecordingTimer();
		recorder.stop();
	}, [cancelPendingMicrophoneRequest, clearRecordingTimer, voiceState]);

	const startVoiceInput = useCallback(async () => {
		if (
			!voiceSupported ||
			disabled ||
			voiceState === 'transcribing' ||
			voiceState === 'requesting'
		) {
			return;
		}

		try {
			setVoiceError(null);
			setVoiceState('requesting');
			setRecordingDurationMs(0);
			const requestToken = microphoneRequestTokenRef.current + 1;
			microphoneRequestTokenRef.current = requestToken;

			const permissionState = await getMicrophonePermissionState();
			if (permissionState === 'denied') {
				throw new Error('Microphone access is blocked in this browser.');
			}

			const input = focusRef?.current;
			if (input && 'selectionStart' in input && 'selectionEnd' in input) {
				selectionRef.current = {
					start: input.selectionStart ?? currentValueRef.current.length,
					end: input.selectionEnd ?? currentValueRef.current.length,
				};
			} else {
				selectionRef.current = null;
			}

			const stream = (await Promise.race([
				navigator.mediaDevices.getUserMedia({
					audio: {
						echoCancellation: true,
						noiseSuppression: true,
						autoGainControl: true,
					},
				}),
				new Promise<never>((_, reject) => {
					window.setTimeout(() => {
						reject(new Error('Microphone request timed out. Tap the mic to try again.'));
					}, MICROPHONE_REQUEST_TIMEOUT_MS);
				}),
			])) as MediaStream;

			if (microphoneRequestTokenRef.current !== requestToken) {
				for (const track of stream.getTracks()) {
					track.stop();
				}
				return;
			}

			mediaStreamRef.current = stream;

			const preferredMimeType = getPreferredMimeType();
			const recorder = preferredMimeType
				? new MediaRecorder(stream, { mimeType: preferredMimeType })
				: new MediaRecorder(stream);
			mediaRecorderRef.current = recorder;
			chunksRef.current = [];

			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) {
					chunksRef.current.push(event.data);
				}
			};

			recorder.onstart = () => {
				pendingStopActionRef.current = 'review';
				setVoiceState('recording');
				setRecordingDurationMs(0);
				const recordingStartedAt = Date.now();
				clearRecordingDurationInterval();
				recordingDurationIntervalRef.current = window.setInterval(() => {
					setRecordingDurationMs(Date.now() - recordingStartedAt);
				}, RECORDING_TICK_MS);
				triggerHapticFeedback('medium');
			};

			recorder.onstop = () => {
				cleanupStream();
				void finalizeTranscription();
			};

			recorder.onerror = (event) => {
				webLogger.error('Voice recording failed', 'VoiceInput', event);
				cleanupStream();
				setVoiceState('error');
				setVoiceError('Unable to record audio.');
				triggerHapticFeedback('strong');
			};

			recorder.start();
			recordingTimerRef.current = window.setTimeout(() => {
				stopVoiceInput();
			}, MAX_RECORDING_MS);
		} catch (error) {
			webLogger.error('Failed to start voice recording', 'VoiceInput', error);
			cleanupStream();
			if (error instanceof Error && /unavailable|not configured/i.test(error.message)) {
				setBackendState('unavailable');
				setBackendError(error.message);
			}
			setVoiceState('error');
			setVoiceError(error instanceof Error ? error.message : 'Microphone access failed.');
			pendingStopActionRef.current = 'review';
			triggerHapticFeedback('strong');
		}
	}, [
		cleanupStream,
		clearRecordingDurationInterval,
		disabled,
		finalizeTranscription,
		focusRef,
		stopVoiceInput,
		voiceState,
		voiceSupported,
	]);

	const toggleVoiceInput = useCallback(() => {
		if (voiceState === 'recording' || voiceState === 'requesting') {
			stopVoiceInput();
			return;
		}

		void startVoiceInput();
	}, [startVoiceInput, stopVoiceInput, voiceState]);

	useEffect(() => {
		return () => {
			microphoneRequestTokenRef.current += 1;
			if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
				mediaRecorderRef.current.stop();
			}
			cleanupStream();
		};
	}, [cleanupStream]);

	const voiceStatusText =
		voiceState === 'requesting'
			? 'Waiting for microphone… tap again to cancel'
			: voiceState === 'recording'
				? `Listening… ${formatRecordingDuration(recordingDurationMs)}`
				: voiceState === 'transcribing'
					? 'Transcribing…'
					: voiceState === 'error'
						? voiceError
						: null;

	return {
		isListening: voiceState === 'recording' || voiceState === 'requesting',
		isTranscribing: voiceState === 'transcribing',
		voiceSupported,
		voiceState,
		voiceStatusText,
		voiceError,
		startVoiceInput: () => {
			void startVoiceInput();
		},
		stopVoiceInput,
		stopVoiceInputAndSubmit,
		toggleVoiceInput,
	};
}

export default useVoiceInput;
