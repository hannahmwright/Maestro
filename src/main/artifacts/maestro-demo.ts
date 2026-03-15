#!/usr/bin/env node

import * as fs from 'fs';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath, URL } from 'url';
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
	artifactCount: number;
	imageCount: number;
	videoCount: number;
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
			artifactCount: 0,
			imageCount: 0,
			videoCount: 0,
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

function resolveArtifactPathOption(value: string | boolean | undefined): string | null {
	const rawValue = asString(value);
	if (!rawValue) {
		return null;
	}

	if (rawValue.startsWith('file://')) {
		try {
			return fileURLToPath(rawValue);
		} catch {
			return rawValue;
		}
	}

	return path.isAbsolute(rawValue) ? path.normalize(rawValue) : path.resolve(rawValue);
}

function emitEvent(event: DemoCaptureEvent): void {
	process.stdout.write(`${MAESTRO_DEMO_EVENT_PREFIX} ${JSON.stringify(event)}\n`);
}

function normalizeDomain(value: string | null | undefined): string | null {
	if (!value || !value.trim()) {
		return null;
	}
	try {
		return new URL(value).hostname.toLowerCase();
	} catch {
		return value
			.trim()
			.toLowerCase()
			.replace(/^https?:\/\//, '')
			.replace(/\/.*$/, '')
			.replace(/:\d+$/, '');
	}
}

function isLikelyAuthUrl(value: string | null | undefined): boolean {
	if (!value) return false;
	return /(login|sign-?in|auth|oauth|sso)/i.test(value);
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
	const result = spawnSync(pwcli, ['eval', expression], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (result.status !== 0) {
		return null;
	}
	return extractPlaywrightEvalValue(`${result.stdout || ''}`);
}

function resolveObservedUrl(options: Record<string, string | boolean>, state: DemoCliState): string | null {
	return (
		asString(options['observed-url']) ||
		probeBrowserValue('location.href') ||
		state.lastObservedUrl ||
		null
	);
}

function resolveObservedTitle(
	options: Record<string, string | boolean>,
	state: DemoCliState
): string | null {
	return (
		asString(options['observed-title']) ||
		probeBrowserValue('document.title') ||
		state.lastObservedTitle ||
		null
	);
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
	const explicitSimulated = options.simulated === true || asBoolean(options.simulated) === true;
	const authTargetReachedOption = asBoolean(options['auth-target-reached']);
	const authTargetReached =
		authTargetReachedOption !== null
			? authTargetReachedOption
			: observedUrl
				? !isLikelyAuthUrl(observedUrl)
				: null;
	const isLocalObservedTarget =
		observedDomain === 'localhost' ||
		observedDomain === '127.0.0.1' ||
		observedUrl?.startsWith('file://') === true;
	const isSimulated =
		explicitSimulated || (requestedDomain !== null && isLocalObservedTarget && requestedDomain !== observedDomain);

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
			summary:
				'The captured page was a reproduction or local mock, not the requested live target.',
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

	if (requestedDomain && observedDomain && requestedDomain !== observedDomain) {
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

function buildBaseEvent(context: DemoCliContext): Pick<
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

function ensureStarted(state: DemoCliState): DemoCliState {
	return state.started ? state : { ...state, started: true };
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
	if (!command) {
		process.stderr.write('Usage: maestro-demo <begin|step|attach-image|attach-video|blocked|complete|fail|status>\n');
		return 1;
	}

	const context = readContext();
	const state = loadState(context);

	switch (command) {
		case 'begin': {
			const nextState: DemoCliState = {
				version: 1,
				started: true,
				artifactCount: 0,
				imageCount: 0,
				videoCount: 0,
				lastObservedUrl: null,
				lastObservedTitle: null,
			};
			saveState(context, nextState);
			emitEvent({
				...buildBaseEvent(context),
				type: 'capture_started',
				title: asString(options.title, 'Captured demo') || 'Captured demo',
				summary: asString(options.summary) || undefined,
			});
			return 0;
		}
		case 'step': {
			const nextState = ensureStarted({
				...state,
				artifactCount: state.artifactCount + 1,
				imageCount: state.imageCount + 1,
			});
			nextState.lastObservedUrl = resolveObservedUrl(options, nextState);
			nextState.lastObservedTitle = resolveObservedTitle(options, nextState);
			saveState(context, nextState);
			emitEvent({
				...buildBaseEvent(context),
				type: 'step_created',
				title: asString(options.title, 'Captured step') || 'Captured step',
				description: asString(options.description) || undefined,
				path: resolveArtifactPathOption(options.path) || undefined,
				filename: asString(options.filename) || undefined,
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
			const kind = command === 'attach-video' ? 'video' : 'image';
			const nextState = ensureStarted({
				...state,
				artifactCount: state.artifactCount + 1,
				imageCount: state.imageCount + (kind === 'image' ? 1 : 0),
				videoCount: state.videoCount + (kind === 'video' ? 1 : 0),
			});
			const roleOption = asString(options.role);
			const role: DemoCaptureEvent['role'] =
				roleOption === 'poster' ||
				roleOption === 'video' ||
				roleOption === 'screenshot' ||
				roleOption === 'supporting'
					? roleOption
					: kind === 'video'
						? 'video'
						: nextState.imageCount === 1
							? 'poster'
							: 'supporting';
			nextState.lastObservedUrl = resolveObservedUrl(options, nextState);
			nextState.lastObservedTitle = resolveObservedTitle(options, nextState);
			saveState(context, nextState);
			emitEvent({
				...buildBaseEvent(context),
				type: 'artifact_created',
				kind,
				role,
				path: resolveArtifactPathOption(options.path) || undefined,
				filename: asString(options.filename) || undefined,
				observedUrl: nextState.lastObservedUrl || undefined,
				observedTitle: nextState.lastObservedTitle || undefined,
				isSimulated: options.simulated === true,
				authTargetReached: asBoolean(options['auth-target-reached']) ?? undefined,
			});
			return 0;
		}
		case 'blocked': {
			const nextState = ensureStarted(state);
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
					'Capture is blocked pending approval or user input.' ||
					undefined,
				observedUrl: nextState.lastObservedUrl || undefined,
				observedTitle: nextState.lastObservedTitle || undefined,
			});
			return 0;
		}
		case 'fail': {
			const nextState = ensureStarted(state);
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
			const nextState = ensureStarted(state);
			nextState.lastObservedUrl = resolveObservedUrl(options, nextState);
			nextState.lastObservedTitle = resolveObservedTitle(options, nextState);
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
				title: asString(options.title, 'Captured demo') || 'Captured demo',
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
