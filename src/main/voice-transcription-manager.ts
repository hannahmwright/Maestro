import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import { execFileNoThrow } from './utils/execFile';
import { logger } from './utils/logger';
import type {
	WebVoiceTranscriptionRequest,
	WebVoiceTranscriptionResponse,
	WebVoiceTranscriptionStatusResponse,
} from '../shared/remote-web';

const LOG_CONTEXT = 'VoiceTranscription';
const TRANSCRIPTION_MODEL = 'distil-small.en';
const TRANSCRIPTION_LANGUAGE = 'en';
const TRANSCRIPTION_BACKEND = 'local-faster-whisper' as const;
const BOOTSTRAP_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSCRIBE_TIMEOUT_MS = 90 * 1000;

const PYTHON_WORKER_SCRIPT = String.raw`
import argparse
import json
import os
import sys
from faster_whisper import WhisperModel


def emit(payload):
	print(json.dumps(payload), flush=True)


def main():
	parser = argparse.ArgumentParser()
	parser.add_argument("--worker", action="store_true")
	parser.add_argument("--model", required=True)
	parser.add_argument("--language", default=None)
	parser.add_argument("--compute-type", default="int8")
	args = parser.parse_args()

	if not args.worker:
		raise SystemExit("worker mode required")

	try:
		model = WhisperModel(
			args.model,
			device="cpu",
			compute_type=args.compute_type,
			download_root=os.environ.get("HF_HOME") or None,
		)
	except Exception:
		model = WhisperModel(
			args.model,
			device="cpu",
			compute_type="default",
			download_root=os.environ.get("HF_HOME") or None,
		)

	emit({"type": "ready"})

	for raw_line in sys.stdin:
		line = raw_line.strip()
		if not line:
			continue

		try:
			request = json.loads(line)
			request_id = request["id"]
			audio_path = request["audioPath"]
			language = request.get("language") or args.language or None

			segments, info = model.transcribe(
				audio_path,
				language=language,
				vad_filter=True,
				beam_size=1,
				best_of=1,
				condition_on_previous_text=False,
			)
			text = "".join(segment.text for segment in segments).strip()
			emit(
				{
					"id": request_id,
					"ok": True,
					"text": text,
					"language": getattr(info, "language", language),
				}
			)
		except Exception as error:
			emit(
				{
					"id": request.get("id") if "request" in locals() else None,
					"ok": False,
					"error": str(error),
				}
			)


if __name__ == "__main__":
	main()
`;

interface PendingWorkerRequest {
	resolve: (value: { text: string; language?: string | null }) => void;
	reject: (error: Error) => void;
}

export class VoiceTranscriptionManager {
	private readonly runtimeDir: string;
	private readonly tempDir: string;
	private readonly cacheDir: string;
	private readonly venvDir: string;
	private readonly scriptPath: string;
	private readonly pythonBinary: string;
	private bootstrapPromise: Promise<void> | null = null;
	private workerStartPromise: Promise<void> | null = null;
	private prewarmPromise: Promise<WebVoiceTranscriptionStatusResponse> | null = null;
	private workerReadyResolve: (() => void) | null = null;
	private workerReadyReject: ((error: Error) => void) | null = null;
	private worker: ChildProcessWithoutNullStreams | null = null;
	private workerStdoutBuffer = '';
	private workerStderrBuffer = '';
	private pendingRequests = new Map<string, PendingWorkerRequest>();
	private lastError: string | null = null;

	constructor(userDataPath: string) {
		this.runtimeDir = path.join(userDataPath, 'voice-transcription');
		this.tempDir = path.join(this.runtimeDir, 'tmp');
		this.cacheDir = path.join(this.runtimeDir, 'cache');
		this.venvDir = path.join(this.runtimeDir, 'venv');
		this.scriptPath = path.join(this.runtimeDir, 'worker.py');
		this.pythonBinary = path.join(
			this.venvDir,
			process.platform === 'win32' ? 'Scripts' : 'bin',
			process.platform === 'win32' ? 'python.exe' : 'python'
		);
	}

	async transcribeAudio(
		request: WebVoiceTranscriptionRequest
	): Promise<WebVoiceTranscriptionResponse> {
		const startedAt = Date.now();
		const inputFilePath = path.join(
			this.tempDir,
			`${randomUUID()}${this.getInputExtension(request.mimeType)}`
		);
		const wavFilePath = path.join(this.tempDir, `${randomUUID()}.wav`);

		try {
			await this.ensureWorker();
			await fs.mkdir(this.tempDir, { recursive: true });
			await fs.writeFile(inputFilePath, Buffer.from(request.audioBase64, 'base64'));
			await this.convertAudioToWav(inputFilePath, wavFilePath);

			const response = await this.sendWorkerRequest(
				wavFilePath,
				request.language || TRANSCRIPTION_LANGUAGE
			);
			this.lastError = null;
			return {
				text: response.text,
				language: response.language || TRANSCRIPTION_LANGUAGE,
				backend: TRANSCRIPTION_BACKEND,
				durationMs: Date.now() - startedAt,
			};
		} finally {
			await Promise.allSettled([
				fs.rm(inputFilePath, { force: true }),
				fs.rm(wavFilePath, { force: true }),
			]);
		}
	}

	getStatus(): WebVoiceTranscriptionStatusResponse {
		return {
			available: !this.lastError,
			ready: !!(this.worker && !this.worker.killed),
			warming: !!(this.bootstrapPromise || this.workerStartPromise || this.prewarmPromise),
			backend: TRANSCRIPTION_BACKEND,
			error: this.lastError,
		};
	}

	async prewarm(): Promise<WebVoiceTranscriptionStatusResponse> {
		if (this.worker && !this.worker.killed) {
			return this.getStatus();
		}

		if (this.prewarmPromise) {
			return this.prewarmPromise;
		}

		this.prewarmPromise = (async () => {
			try {
				await this.ensureWorker();
				this.lastError = null;
				return this.getStatus();
			} catch (error) {
				this.lastError =
					error instanceof Error ? error.message : 'Voice transcription is unavailable.';
				throw error;
			} finally {
				this.prewarmPromise = null;
			}
		})();

		return this.prewarmPromise;
	}

	private async ensureWorker(): Promise<void> {
		if (this.worker && !this.worker.killed) {
			return;
		}

		if (this.workerStartPromise) {
			return this.workerStartPromise;
		}

		this.workerStartPromise = (async () => {
			await this.ensureBootstrap();
			await this.startWorker();
		})().finally(() => {
			this.workerStartPromise = null;
		});

		return this.workerStartPromise;
	}

	private async ensureBootstrap(): Promise<void> {
		if (this.bootstrapPromise) {
			return this.bootstrapPromise;
		}

		this.bootstrapPromise = (async () => {
			await fs.mkdir(this.runtimeDir, { recursive: true });
			await fs.mkdir(this.cacheDir, { recursive: true });
			await fs.writeFile(this.scriptPath, PYTHON_WORKER_SCRIPT, 'utf8');

			const basePython = await this.resolveBasePython();
			if (!basePython) {
				throw new Error('Python 3 is required for local voice transcription.');
			}

			await this.ensureVirtualEnv(basePython);
			await this.ensureDependencies();
			this.lastError = null;
		})().finally(() => {
			this.bootstrapPromise = null;
		});

		return this.bootstrapPromise;
	}

	private async resolveBasePython(): Promise<string | null> {
		for (const command of ['python3', 'python']) {
			const result = await execFileNoThrow(command, ['--version']);
			if (result.exitCode === 0) {
				return command;
			}
		}

		return null;
	}

	private async ensureVirtualEnv(basePython: string): Promise<void> {
		const pythonExists = await fs
			.access(this.pythonBinary)
			.then(() => true)
			.catch(() => false);

		if (pythonExists) {
			return;
		}

		logger.info('Creating voice transcription virtualenv', LOG_CONTEXT);
		const result = await execFileNoThrow(basePython, ['-m', 'venv', this.venvDir], undefined, {
			timeout: BOOTSTRAP_TIMEOUT_MS,
		});
		if (result.exitCode !== 0) {
			throw new Error(
				`Failed to create voice transcription virtualenv: ${result.stderr || result.stdout}`
			);
		}
	}

	private async ensureDependencies(): Promise<void> {
		const importCheck = await execFileNoThrow(this.pythonBinary, [
			'-c',
			'import faster_whisper, requests',
		]);
		if (importCheck.exitCode === 0) {
			return;
		}

		logger.info('Installing faster-whisper runtime for voice transcription', LOG_CONTEXT);

		const pipEnv = {
			...process.env,
			PIP_DISABLE_PIP_VERSION_CHECK: '1',
			HF_HOME: this.cacheDir,
			XDG_CACHE_HOME: this.cacheDir,
		};

		const upgradePip = await execFileNoThrow(
			this.pythonBinary,
			['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'],
			undefined,
			{
				timeout: BOOTSTRAP_TIMEOUT_MS,
			}
		);
		if (upgradePip.exitCode !== 0) {
			throw new Error(
				`Failed to prepare Python packaging tools: ${upgradePip.stderr || upgradePip.stdout}`
			);
		}

		const installRuntime = await execFileNoThrow(
			this.pythonBinary,
			['-m', 'pip', 'install', 'faster-whisper==1.1.1', 'requests>=2.32.0'],
			undefined,
			pipEnv
		);
		if (installRuntime.exitCode !== 0) {
			throw new Error(
				`Failed to install faster-whisper runtime: ${installRuntime.stderr || installRuntime.stdout}`
			);
		}

		const verifyRuntime = await execFileNoThrow(this.pythonBinary, [
			'-c',
			'import faster_whisper, requests',
		]);
		if (verifyRuntime.exitCode !== 0) {
			throw new Error(
				`Voice transcription runtime verification failed: ${verifyRuntime.stderr || verifyRuntime.stdout}`
			);
		}
	}

	private async startWorker(): Promise<void> {
		if (this.worker && !this.worker.killed) {
			return;
		}

		await fs.mkdir(this.tempDir, { recursive: true });

		logger.info('Starting voice transcription worker', LOG_CONTEXT);
		const worker = spawn(
			this.pythonBinary,
			[
				this.scriptPath,
				'--worker',
				'--model',
				TRANSCRIPTION_MODEL,
				'--language',
				TRANSCRIPTION_LANGUAGE,
				'--compute-type',
				'int8',
			],
			{
				stdio: ['pipe', 'pipe', 'pipe'],
				env: {
					...process.env,
					HF_HOME: this.cacheDir,
					XDG_CACHE_HOME: this.cacheDir,
					PYTHONUNBUFFERED: '1',
				},
			}
		);

		this.worker = worker;
		this.workerStdoutBuffer = '';
		this.workerStderrBuffer = '';

		const readyPromise = new Promise<void>((resolve, reject) => {
			this.workerReadyResolve = resolve;
			this.workerReadyReject = reject;
		});

		worker.stdout.on('data', (chunk) => {
			this.workerStdoutBuffer += chunk.toString();
			this.processWorkerStdout();
		});

		worker.stderr.on('data', (chunk) => {
			const stderrChunk = chunk.toString();
			this.workerStderrBuffer += stderrChunk;
			this.workerStderrBuffer = this.workerStderrBuffer.slice(-8000);
			logger.warn(stderrChunk.trim(), LOG_CONTEXT);
		});

		worker.on('error', (error) => {
			this.handleWorkerFailure(error);
		});

		worker.on('exit', (code, signal) => {
			this.handleWorkerFailure(
				new Error(
					`Voice transcription worker exited unexpectedly (${code ?? 'null'} / ${signal ?? 'null'})${
						this.workerStderrBuffer ? `: ${this.workerStderrBuffer.trim()}` : ''
					}`
				)
			);
		});

		const timeout = setTimeout(() => {
			this.handleWorkerFailure(new Error('Voice transcription worker startup timed out.'));
		}, BOOTSTRAP_TIMEOUT_MS);

		try {
			await readyPromise;
			this.lastError = null;
		} finally {
			clearTimeout(timeout);
		}
	}

	private processWorkerStdout(): void {
		while (true) {
			const newlineIndex = this.workerStdoutBuffer.indexOf('\n');
			if (newlineIndex === -1) {
				return;
			}

			const rawLine = this.workerStdoutBuffer.slice(0, newlineIndex).trim();
			this.workerStdoutBuffer = this.workerStdoutBuffer.slice(newlineIndex + 1);
			if (!rawLine) {
				continue;
			}

			try {
				const message = JSON.parse(rawLine) as {
					type?: string;
					id?: string | null;
					ok?: boolean;
					text?: string;
					language?: string | null;
					error?: string;
				};

				if (message.type === 'ready') {
					this.workerReadyResolve?.();
					this.workerReadyResolve = null;
					this.workerReadyReject = null;
					continue;
				}

				if (!message.id) {
					continue;
				}

				const pending = this.pendingRequests.get(message.id);
				if (!pending) {
					continue;
				}

				this.pendingRequests.delete(message.id);
				if (message.ok) {
					pending.resolve({
						text: message.text || '',
						language: message.language || null,
					});
				} else {
					pending.reject(new Error(message.error || 'Voice transcription failed.'));
				}
			} catch (error) {
				logger.warn('Failed to parse voice transcription worker output', LOG_CONTEXT, {
					error,
					rawLine,
				});
			}
		}
	}

	private handleWorkerFailure(error: Error): void {
		logger.warn('Voice transcription worker failure', LOG_CONTEXT, { error });
		this.lastError = error.message;

		this.workerReadyReject?.(error);
		this.workerReadyResolve = null;
		this.workerReadyReject = null;

		const pending = Array.from(this.pendingRequests.values());
		this.pendingRequests.clear();
		for (const request of pending) {
			request.reject(error);
		}

		if (this.worker) {
			this.worker.removeAllListeners();
		}
		this.worker = null;
	}

	private async convertAudioToWav(inputPath: string, outputPath: string): Promise<void> {
		const result = await execFileNoThrow(
			'ffmpeg',
			['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', outputPath],
			undefined,
			{
				timeout: TRANSCRIBE_TIMEOUT_MS,
			}
		);

		if (result.exitCode !== 0) {
			throw new Error(`Failed to normalize recorded audio: ${result.stderr || result.stdout}`);
		}
	}

	private async sendWorkerRequest(
		audioPath: string,
		language: string | null
	): Promise<{ text: string; language?: string | null }> {
		if (!this.worker || this.worker.killed || !this.worker.stdin.writable) {
			throw new Error('Voice transcription worker is not available.');
		}

		const id = randomUUID();
		const requestPromise = new Promise<{ text: string; language?: string | null }>(
			(resolve, reject) => {
				this.pendingRequests.set(id, { resolve, reject });
			}
		);

		this.worker.stdin.write(
			`${JSON.stringify({
				id,
				audioPath,
				language,
			})}\n`
		);

		const timeout = setTimeout(() => {
			const pending = this.pendingRequests.get(id);
			if (!pending) {
				return;
			}
			this.pendingRequests.delete(id);
			pending.reject(new Error('Voice transcription timed out.'));
		}, TRANSCRIBE_TIMEOUT_MS);

		try {
			return await requestPromise;
		} finally {
			clearTimeout(timeout);
		}
	}

	private getInputExtension(mimeType: string): string {
		if (mimeType.includes('mp4') || mimeType.includes('m4a')) {
			return '.m4a';
		}
		if (mimeType.includes('ogg')) {
			return '.ogg';
		}
		if (mimeType.includes('mpeg')) {
			return '.mp3';
		}
		return '.webm';
	}
}
