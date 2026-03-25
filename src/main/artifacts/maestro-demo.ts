#!/usr/bin/env node

import * as fs from 'fs';
import * as childProcess from 'child_process';
import * as path from 'path';
import { URL } from 'url';
import type {
	DemoCaptureEvent,
	DemoCaptureSource,
	DemoFailureReason,
	DemoRequestedTarget,
} from '../../shared/demo-artifacts';
import { MAESTRO_DEMO_EVENT_PREFIX } from '../../shared/demo-artifacts';

interface DemoCliContext {
	version: number;
	enabled: boolean;
	sessionId: string;
	tabId: string | null;
	captureRunId: string;
	externalRunId: string;
	turnId: string;
	turnToken: string;
	provider: string | null;
	model: string | null;
	requestedTarget?: DemoRequestedTarget | null;
	stateFilePath: string;
	outputDir?: string;
}

interface DemoCliState {
	version: number;
	started: boolean;
	recordingStarted: boolean;
	recordingFinalized: boolean;
	artifactCount: number;
	imageCount: number;
	videoCount: number;
	stepCount: number;
	title?: string | null;
	summary?: string | null;
	lastObservedUrl?: string | null;
	lastObservedTitle?: string | null;
}

interface CompletionEvaluation {
	ok: boolean;
	failureReason?: DemoFailureReason;
	summary: string;
	observedUrl: string | null;
	observedTitle: string | null;
	authTargetReached: boolean | null;
	isSimulated: boolean;
}

function parseArgs(argv: string[]): {
	command: string | null;
	options: Record<string, string | boolean>;
} {
	const [command, ...rest] = argv;
	const options: Record<string, string | boolean> = {};

	for (let index = 0; index < rest.length; index += 1) {
		const token = rest[index];
		if (!token.startsWith('--')) {
			continue;
		}
		const key = token.slice(2);
		const next = rest[index + 1];
		if (!next || next.startsWith('--')) {
			options[key] = true;
			continue;
		}
		options[key] = next;
		index += 1;
	}

	return {
		command: command || null,
		options,
	};
}

function readContext(): DemoCliContext {
	const contextFilePath = process.env.MAESTRO_DEMO_CONTEXT_FILE;
	if (!contextFilePath) {
		throw new Error('MAESTRO_DEMO_CONTEXT_FILE is not set');
	}
	const raw = fs.readFileSync(contextFilePath, 'utf8');
	return JSON.parse(raw) as DemoCliContext;
}

function loadState(context: DemoCliContext): DemoCliState {
	try {
		const raw = fs.readFileSync(context.stateFilePath, 'utf8');
		return JSON.parse(raw) as DemoCliState;
	} catch {
		return {
			version: 1,
			started: false,
			recordingStarted: false,
			recordingFinalized: false,
			artifactCount: 0,
			imageCount: 0,
			videoCount: 0,
			stepCount: 0,
			title: null,
			summary: null,
			lastObservedUrl: null,
			lastObservedTitle: null,
		};
	}
}

function saveState(context: DemoCliContext, state: DemoCliState): void {
	fs.mkdirSync(require('path').dirname(context.stateFilePath), { recursive: true });
	fs.writeFileSync(context.stateFilePath, JSON.stringify(state, null, 2), 'utf8');
}

function asString(
	value: string | boolean | undefined,
	fallback: string | null = null
): string | null {
	return typeof value === 'string' && value.trim() ? value : fallback;
}

function asBoolean(value: string | boolean | undefined): boolean | null {
	if (value === true) return true;
	if (value === false || value === undefined) return null;
	if (typeof value !== 'string') return null;
	if (value === 'true' || value === '1' || value === 'yes') return true;
	if (value === 'false' || value === '0' || value === 'no') return false;
	return null;
}

function slugifySegment(value: string | null | undefined, fallback: string): string {
	const normalized = (value || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
	return normalized || fallback;
}

function getOutputDir(context: DemoCliContext): string {
	const configuredOutputDir = context.outputDir?.trim() || 'output/playwright';
	return path.isAbsolute(configuredOutputDir)
		? configuredOutputDir
		: path.resolve(process.cwd(), configuredOutputDir);
}

function buildStepArtifactPath(
	context: DemoCliContext,
	state: DemoCliState,
	title: string | null
): string {
	const orderIndex = state.stepCount + 1;
	const filename = `${String(orderIndex).padStart(2, '0')}-${slugifySegment(title, `step-${orderIndex}`)}.png`;
	return path.join(getOutputDir(context), filename);
}

function buildVideoArtifactPath(context: DemoCliContext, title: string | null): string {
	const filename = `${slugifySegment(title, 'demo')}.webm`;
	return path.join(getOutputDir(context), filename);
}

function runPwcli(args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const pwcli = process.env.PWCLI;
	if (!pwcli) {
		return {
			ok: false,
			stdout: '',
			stderr: 'PWCLI is not set',
		};
	}

	const result = childProcess.spawnSync(pwcli, args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	return {
		ok: result.status === 0,
		stdout: result.stdout || '',
		stderr: result.stderr || '',
	};
}

function emitEvent(event: DemoCaptureEvent): void {
	process.stdout.write(`${MAESTRO_DEMO_EVENT_PREFIX} ${JSON.stringify(event)}\n`);
}

function sanitizeUrlLikeValue(value: string | null | undefined): string | null {
	if (!value || !value.trim()) {
		return null;
	}
	return value.trim().replace(/[.,;!?]+$/, '') || null;
}

function normalizeDomain(value: string | null | undefined): string | null {
	const sanitizedValue = sanitizeUrlLikeValue(value);
	if (!sanitizedValue) {
		return null;
	}
	try {
		return new URL(sanitizedValue).hostname.toLowerCase();
	} catch {
		return sanitizedValue
			.toLowerCase()
			.replace(/^https?:\/\//, '')
			.replace(/\/.*$/, '')
			.replace(/:\d+$/, '');
	}
}

function normalizeComparableDomain(value: string | null | undefined): string | null {
	const normalized = normalizeDomain(value);
	if (!normalized) {
		return null;
	}
	return normalized.replace(/^www\./, '');
}

function normalizeComparablePath(value: string | null | undefined): string | null {
	const sanitizedValue = sanitizeUrlLikeValue(value);
	if (!sanitizedValue) {
		return null;
	}
	try {
		const pathname = new URL(sanitizedValue).pathname || '/';
		return pathname.replace(/\/+$/, '') || '/';
	} catch {
		return null;
	}
}

function isLikelyAuthUrl(value: string | null | undefined): boolean {
	const sanitizedValue = sanitizeUrlLikeValue(value);
	if (!sanitizedValue) return false;
	return /(login|sign-?in|auth|oauth|sso)/i.test(sanitizedValue);
}

export function extractPlaywrightEvalValue(output: string): string | null {
	const trimmed = output.trim();
	if (!trimmed) {
		return null;
	}

	const wrappedMatch = trimmed.match(/(?:^|\n)### Result\s*\n([\s\S]*?)(?=\n### |\n```|$)/);
	const candidate = (wrappedMatch?.[1] || trimmed).trim();
	if (!candidate || candidate === 'null' || candidate === 'undefined') {
		return null;
	}

	try {
		const parsed = JSON.parse(candidate);
		if (parsed === null || parsed === undefined) {
			return null;
		}
		return typeof parsed === 'string' ? parsed.trim() || null : String(parsed);
	} catch {
		return candidate;
	}
}

function probeBrowserValue(expression: string): string | null {
	const pwcli = process.env.PWCLI;
	if (!pwcli) {
		return null;
	}
	const result = childProcess.spawnSync(pwcli, ['eval', expression], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (result.status !== 0) {
		return null;
	}
	return extractPlaywrightEvalValue(`${result.stdout || ''}`);
}

function isBlankObservedUrl(value: string | null | undefined): boolean {
	return !value || value === 'about:blank';
}

function resolveObservedUrl(
	options: Record<string, string | boolean>,
	state: DemoCliState
): string | null {
	const explicitValue = asString(options['observed-url']);
	if (explicitValue) {
		return explicitValue;
	}

	const probedValue = probeBrowserValue('location.href');
	if (!isBlankObservedUrl(probedValue)) {
		return probedValue;
	}

	if (!isBlankObservedUrl(state.lastObservedUrl)) {
		return state.lastObservedUrl || null;
	}

	return probedValue || state.lastObservedUrl || null;
}

function resolveObservedTitle(
	options: Record<string, string | boolean>,
	state: DemoCliState
): string | null {
	const explicitValue = asString(options['observed-title']);
	if (explicitValue) {
		return explicitValue;
	}

	const probedTitle = probeBrowserValue('document.title');
	const resolvedUrl = resolveObservedUrl(options, state);
	if (!isBlankObservedUrl(resolvedUrl) && probedTitle) {
		return probedTitle;
	}

	return state.lastObservedTitle || probedTitle || null;
}

export function evaluateCompletionState(
	context: DemoCliContext,
	state: DemoCliState,
	options: Record<string, string | boolean>
): CompletionEvaluation {
	const requestedTarget = context.requestedTarget || null;
	const observedUrl = resolveObservedUrl(options, state);
	const observedTitle = resolveObservedTitle(options, state);
	const requestedDomain = normalizeDomain(requestedTarget?.url || requestedTarget?.domain || null);
	const observedDomain = normalizeDomain(observedUrl);
	const comparableRequestedDomain = normalizeComparableDomain(
		requestedTarget?.url || requestedTarget?.domain || null
	);
	const comparableObservedDomain = normalizeComparableDomain(observedUrl);
	const comparableRequestedPath = normalizeComparablePath(requestedTarget?.url || null);
	const comparableObservedPath = normalizeComparablePath(observedUrl);
	const explicitSimulated = options.simulated === true || asBoolean(options.simulated) === true;
	const authTargetReachedOption = asBoolean(options['auth-target-reached']);
	const requestedAuthTarget = isLikelyAuthUrl(requestedTarget?.url || null);
	const matchedRequestedAuthTarget =
		requestedAuthTarget &&
		Boolean(observedUrl) &&
		isLikelyAuthUrl(observedUrl) &&
		(!comparableRequestedDomain ||
			!comparableObservedDomain ||
			comparableRequestedDomain === comparableObservedDomain) &&
		(!comparableRequestedPath ||
			!comparableObservedPath ||
			comparableRequestedPath === comparableObservedPath);
	const authTargetReached =
		authTargetReachedOption !== null
			? authTargetReachedOption
			: requestedAuthTarget
				? matchedRequestedAuthTarget
				: observedUrl
				? !isLikelyAuthUrl(observedUrl)
				: null;
	const isLocalObservedTarget =
		observedDomain === 'localhost' ||
		observedDomain === '127.0.0.1' ||
		observedUrl?.startsWith('file://') === true;
	const isSimulated =
		explicitSimulated ||
		(requestedDomain !== null && isLocalObservedTarget && requestedDomain !== observedDomain);

	if (state.artifactCount < 1) {
		return {
			ok: false,
			failureReason: 'missing_artifacts',
			summary: 'Cannot finalize demo capture without at least one screenshot or video artifact.',
			observedUrl,
			observedTitle,
			authTargetReached,
			isSimulated,
		};
	}

	if (isSimulated) {
		return {
			ok: false,
			failureReason: 'simulated_capture',
			summary: 'The captured page was a reproduction or local mock, not the requested live target.',
			observedUrl,
			observedTitle,
			authTargetReached,
			isSimulated: true,
		};
	}

	if (requestedDomain && !observedDomain) {
		return {
			ok: false,
			failureReason: 'wrong_target',
			summary: 'Maestro could not verify the final captured URL for this demo.',
			observedUrl,
			observedTitle,
			authTargetReached,
			isSimulated,
		};
	}

	if (
		comparableRequestedDomain &&
		comparableObservedDomain &&
		comparableRequestedDomain !== comparableObservedDomain
	) {
		return {
			ok: false,
			failureReason: 'wrong_target',
			summary: `The captured page domain (${observedDomain}) did not match the requested target (${requestedDomain}).`,
			observedUrl,
			observedTitle,
			authTargetReached,
			isSimulated,
		};
	}

	if (requestedDomain && authTargetReached === false) {
		return {
			ok: false,
			failureReason: 'auth_blocked',
			summary: 'The browser never reached the authenticated target content for this demo.',
			observedUrl,
			observedTitle,
			authTargetReached: false,
			isSimulated,
		};
	}

	return {
		ok: true,
		summary: asString(options.summary, 'Demo capture completed.') || 'Demo capture completed.',
		observedUrl,
		observedTitle,
		authTargetReached,
		isSimulated,
	};
}

function buildBaseEvent(
	context: DemoCliContext
): Pick<
	DemoCaptureEvent,
	'runId' | 'turnId' | 'turnToken' | 'provider' | 'model' | 'captureSource' | 'requestedTarget'
> {
	return {
		runId: context.externalRunId,
		turnId: context.turnId,
		turnToken: context.turnToken,
		provider: context.provider || undefined,
		model: context.model || undefined,
		captureSource: 'maestro_demo_cli' as DemoCaptureSource,
		requestedTarget: context.requestedTarget || null,
	};
}

function ensureDemoStarted(
	context: DemoCliContext,
	state: DemoCliState,
	options: Record<string, string | boolean>
): DemoCliState {
	if (state.started) {
		return state;
	}

	const nextState: DemoCliState = {
		version: 1,
		started: true,
		recordingStarted: false,
		recordingFinalized: false,
		artifactCount: 0,
		imageCount: 0,
		videoCount: 0,
		stepCount: 0,
		title: asString(options.title, state.title || 'Captured demo'),
		summary: asString(options.summary, state.summary || null),
		lastObservedUrl: null,
		lastObservedTitle: null,
	};
	saveState(context, nextState);
	emitEvent({
		...buildBaseEvent(context),
		type: 'capture_started',
		title: nextState.title || 'Captured demo',
		summary: nextState.summary || undefined,
	});
	return nextState;
}

function maybeStartRecording(
	context: DemoCliContext,
	state: DemoCliState,
	options: Record<string, string | boolean>
): DemoCliState {
	const nextState = ensureDemoStarted(context, state, options);
	if (nextState.recordingStarted) {
		return nextState;
	}

	const result = runPwcli(['video-start']);
	if (!result.ok) {
		return nextState;
	}

	const recordingState: DemoCliState = {
		...nextState,
		recordingStarted: true,
	};
	saveState(context, recordingState);
	return recordingState;
}

function emitFailureAndExit(
	context: DemoCliContext,
	options: Record<string, string | boolean>,
	failureReason: DemoFailureReason,
	summary: string,
	state: DemoCliState
): never {
	emitEvent({
		...buildBaseEvent(context),
		type: 'capture_failed',
		title: asString(options.title, 'Demo capture failed') || 'Demo capture failed',
		summary,
		failureReason,
		observedUrl: state.lastObservedUrl || undefined,
		observedTitle: state.lastObservedTitle || undefined,
	});
	process.stderr.write(`${summary}\n`);
	process.exit(1);
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
	const { command, options } = parseArgs(argv);
	if (!command || command === '--help' || command === '-h' || command === 'help') {
		process.stderr.write('Usage: maestro-demo <start|step|blocked|complete|fail|status>\n');
		return command ? 0 : 1;
	}

	const context = readContext();
	const state = loadState(context);

	switch (command) {
		case 'start':
		case 'begin': {
			const nextState = ensureDemoStarted(context, loadState(context), options);
			const finalState: DemoCliState = {
				...nextState,
				title: asString(options.title, nextState.title || 'Captured demo'),
				summary: asString(options.summary, nextState.summary || null),
			};
			saveState(context, finalState);
			return 0;
		}
		case 'step': {
			const preparedState = maybeStartRecording(context, state, options);
			const title =
				asString(options.title, `Step ${preparedState.stepCount + 1}`) ||
				`Step ${preparedState.stepCount + 1}`;
			const outputPath = buildStepArtifactPath(context, preparedState, title);
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });
			const screenshotResult = runPwcli(['screenshot', '--filename', outputPath]);
			if (!screenshotResult.ok) {
				emitFailureAndExit(
					context,
					options,
					'missing_artifacts',
					screenshotResult.stderr.trim() ||
						'Maestro could not capture a screenshot for this demo step.',
					preparedState
				);
			}

			const nextState = {
				...preparedState,
				artifactCount: preparedState.artifactCount + 1,
				imageCount: preparedState.imageCount + 1,
				stepCount: preparedState.stepCount + 1,
				title: preparedState.title || asString(options.title, 'Captured demo'),
				summary: preparedState.summary || asString(options.summary),
			};
			nextState.lastObservedUrl = resolveObservedUrl(options, nextState);
			nextState.lastObservedTitle = resolveObservedTitle(options, nextState);
			saveState(context, nextState);
			emitEvent({
				...buildBaseEvent(context),
				type: 'step_created',
				title,
				description: asString(options.description) || undefined,
				path: outputPath,
				filename: path.basename(outputPath),
				timestampMs: Date.now(),
				actionType: asString(options['action-type']) || undefined,
				toolContext: asString(options['tool-context']) || undefined,
				observedUrl: nextState.lastObservedUrl || undefined,
				observedTitle: nextState.lastObservedTitle || undefined,
				isSimulated: options.simulated === true,
				authTargetReached: asBoolean(options['auth-target-reached']) ?? undefined,
			});
			return 0;
		}
		case 'attach-image':
		case 'attach-video': {
			process.stderr.write(
				'attach-image and attach-video are deprecated. Use `maestro-demo step` and let Maestro manage artifacts automatically.\n'
			);
			return 1;
		}
		case 'blocked': {
			const nextState = maybeStartRecording(context, state, options);
			nextState.lastObservedUrl = resolveObservedUrl(options, nextState);
			nextState.lastObservedTitle = resolveObservedTitle(options, nextState);
			saveState(context, nextState);
			emitEvent({
				...buildBaseEvent(context),
				type: 'capture_blocked',
				title: asString(options.title, 'Demo capture blocked') || 'Demo capture blocked',
				summary: asString(options.summary) || undefined,
				blockedReason:
					asString(options['blocked-reason']) ||
					asString(options.summary) ||
					'Capture is blocked pending approval or user input.',
				observedUrl: nextState.lastObservedUrl || undefined,
				observedTitle: nextState.lastObservedTitle || undefined,
			});
			return 0;
		}
		case 'fail': {
			const nextState = ensureDemoStarted(context, state, options);
			nextState.lastObservedUrl = resolveObservedUrl(options, nextState);
			nextState.lastObservedTitle = resolveObservedTitle(options, nextState);
			saveState(context, nextState);
			emitEvent({
				...buildBaseEvent(context),
				type: 'capture_failed',
				title: asString(options.title, 'Demo capture failed') || 'Demo capture failed',
				summary: asString(options.summary) || 'Demo capture failed.',
				failureReason:
					(asString(options['failure-reason']) as DemoFailureReason | null) || 'unknown',
				observedUrl: nextState.lastObservedUrl || undefined,
				observedTitle: nextState.lastObservedTitle || undefined,
				isSimulated: options.simulated === true,
				authTargetReached: asBoolean(options['auth-target-reached']) ?? undefined,
			});
			return 1;
		}
		case 'status': {
			process.stdout.write(
				`${JSON.stringify({
					context,
					state,
				})}\n`
			);
			return 0;
		}
		case 'complete': {
			let nextState = maybeStartRecording(context, state, options);
			nextState = {
				...nextState,
				lastObservedUrl: resolveObservedUrl(options, nextState),
				lastObservedTitle: resolveObservedTitle(options, nextState),
			};
			saveState(context, nextState);
			if (nextState.recordingStarted && !nextState.recordingFinalized) {
				const videoOutputPath = buildVideoArtifactPath(
					context,
					asString(options.title, nextState.title || 'demo')
				);
				fs.mkdirSync(path.dirname(videoOutputPath), { recursive: true });
				const videoResult = runPwcli(['video-stop', '--filename', videoOutputPath]);
				if (!videoResult.ok) {
					if (nextState.artifactCount < 1) {
						emitFailureAndExit(
							context,
							options,
							'missing_artifacts',
							videoResult.stderr.trim() ||
								'Maestro could not finalize the browser recording for this demo.',
							nextState
						);
					}
				} else {
					nextState = {
						...nextState,
						recordingFinalized: true,
						artifactCount: nextState.artifactCount + 1,
						videoCount: nextState.videoCount + 1,
					};
					emitEvent({
						...buildBaseEvent(context),
						type: 'artifact_created',
						kind: 'video',
						role: 'video',
						path: videoOutputPath,
						filename: path.basename(videoOutputPath),
						observedUrl: nextState.lastObservedUrl || undefined,
						observedTitle: nextState.lastObservedTitle || undefined,
						isSimulated: options.simulated === true,
						authTargetReached: asBoolean(options['auth-target-reached']) ?? undefined,
					});
				}
			}
			nextState.lastObservedUrl = resolveObservedUrl(options, nextState);
			nextState.lastObservedTitle = resolveObservedTitle(options, nextState);
			nextState.title = asString(options.title, nextState.title || 'Captured demo');
			nextState.summary = asString(options.summary, nextState.summary || null);
			saveState(context, nextState);

			const evaluation = evaluateCompletionState(context, nextState, options);
			if (!evaluation.ok) {
				emitFailureAndExit(
					context,
					options,
					evaluation.failureReason || 'unknown',
					evaluation.summary,
					nextState
				);
			}

			emitEvent({
				...buildBaseEvent(context),
				type: 'capture_completed',
				title: nextState.title || 'Captured demo',
				summary: evaluation.summary,
				observedUrl: evaluation.observedUrl || undefined,
				observedTitle: evaluation.observedTitle || undefined,
				authTargetReached: evaluation.authTargetReached ?? undefined,
				isSimulated: evaluation.isSimulated,
			});
			return 0;
		}
		default:
			process.stderr.write(`Unknown maestro-demo command: ${command}\n`);
			return 1;
	}
}

if (require.main === module) {
	void runCli().then((code) => {
		process.exit(code);
	});
}
