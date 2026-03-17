import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { BrowserContext, ConsoleMessage, Dialog, Locator, Page, Response } from 'playwright';
import { DEFAULT_DEMO_VIEWPORT } from './maestroDemoRuntime';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'MaestroPlaywrightDriver';
const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000;
const MAX_SNAPSHOT_ELEMENTS = 80;
const MAX_CONSOLE_ENTRIES = 100;
const MAX_NETWORK_ENTRIES = 120;

function loadChromium() {
	try {
		const packagedPlaywrightPath =
			typeof process.resourcesPath === 'string' && process.resourcesPath
				? path.join(process.resourcesPath, 'app.asar', 'node_modules', 'playwright')
				: null;
		if (packagedPlaywrightPath) {
			try {
				const packagedPlaywright = require(packagedPlaywrightPath) as {
					chromium?: typeof import('playwright').chromium;
				};
				if (packagedPlaywright?.chromium) {
					return packagedPlaywright.chromium;
				}
			} catch {
				// Fall through to standard resolution in development or unpackaged environments.
			}
		}
		const playwright = require('playwright') as {
			chromium?: typeof import('playwright').chromium;
		};
		if (playwright?.chromium) {
			return playwright.chromium;
		}
		throw new Error('The Playwright chromium runtime is unavailable.');
	} catch (error) {
		throw new Error(`Unable to load Playwright chromium: ${String(error)}`);
	}
}

export interface BrowserBrokerExecuteRequest {
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
}

export interface BrowserBrokerExecuteResponse {
	ok: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface BrowserLaunchConfig {
	headless: boolean;
	channel?: string;
	viewport?: {
		width: number;
		height: number;
	} | null;
}

interface ParsedBrowserCommand {
	sessionName: string;
	configPath: string | null;
	headedOverride: boolean | null;
	command: string | null;
	commandArgs: string[];
}

function isHelpRequest(command: string | null, commandArgs: string[]): boolean {
	if (command === '--help' || command === 'help') {
		return true;
	}
	return commandArgs.includes('--help') || commandArgs.includes('-h');
}

interface SnapshotEntry {
	ref: string;
	tag: string;
	role: string | null;
	type: string | null;
	text: string | null;
	name: string | null;
	placeholder: string | null;
	ariaLabel: string | null;
	testId: string | null;
	classSummary: string | null;
	handleKind: string | null;
	checked: boolean | null;
	disabled: boolean;
}

interface ConsoleEntry {
	type: string;
	text: string;
}

interface NetworkEntry {
	status: number;
	method: string;
	url: string;
}

interface PageState {
	id: string;
	page: Page;
	consoleEntries: ConsoleEntry[];
	networkEntries: NetworkEntry[];
	pendingDialog: Dialog | null;
}

interface SessionState {
	key: string;
	sessionName: string;
	userDataDir: string;
	context: BrowserContext;
	pageStates: Map<string, PageState>;
	pageOrder: string[];
	activePageId: string | null;
	lastUsedAt: number;
	headless: boolean;
	channel?: string;
	viewport?: {
		width: number;
		height: number;
	} | null;
	autoRecordVideo: boolean;
	videoArtifactDir: string;
	activeVideoPageId: string | null;
}

const RECORDING_OVERLAY_STATE_KEY = '__MAESTRO_RECORDING_OVERLAY__';

type OverlayRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

type OverlayPoint = {
	x: number;
	y: number;
};

function readJsonObject(raw: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function normalizeSessionName(value: string | undefined): string {
	return value && value.trim() ? value.trim() : 'default';
}

function isRefToken(value: string | undefined): boolean {
	return typeof value === 'string' && /^e\d+$/i.test(value);
}

function asJsonResult(value: unknown): string {
	if (value === undefined) {
		return 'undefined';
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function buildResult(stdout = '', stderr = '', exitCode = 0): BrowserBrokerExecuteResponse {
	return {
		ok: exitCode === 0,
		exitCode,
		stdout,
		stderr,
	};
}

function hashValue(value: string): string {
	return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function parseGlobalCommandArgs(args: string[], env: NodeJS.ProcessEnv): ParsedBrowserCommand {
	let sessionName = normalizeSessionName(
		env.PLAYWRIGHT_CLI_SESSION || env.MAESTRO_PLAYWRIGHT_SESSION
	);
	let configPath =
		typeof env.MAESTRO_PLAYWRIGHT_CONFIG_FILE === 'string' &&
		env.MAESTRO_PLAYWRIGHT_CONFIG_FILE.trim()
			? env.MAESTRO_PLAYWRIGHT_CONFIG_FILE
			: null;
	let headedOverride: boolean | null = null;
	const strippedArgs: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === '--session') {
			sessionName = normalizeSessionName(args[index + 1]);
			index += 1;
			continue;
		}
		if (token.startsWith('--session=')) {
			sessionName = normalizeSessionName(token.split('=').slice(1).join('='));
			continue;
		}
		if (token === '--config') {
			configPath = args[index + 1] || configPath;
			index += 1;
			continue;
		}
		if (token.startsWith('--config=')) {
			configPath = token.split('=').slice(1).join('=') || configPath;
			continue;
		}
		if (token === '--headed') {
			headedOverride = true;
			continue;
		}
		if (token === '--headless') {
			headedOverride = false;
			continue;
		}
		strippedArgs.push(token);
	}

	return {
		sessionName,
		configPath,
		headedOverride,
		command: strippedArgs[0] || null,
		commandArgs: strippedArgs.slice(1),
	};
}

async function loadLaunchConfig(
	configPath: string | null,
	headedOverride: boolean | null
): Promise<BrowserLaunchConfig> {
	let headless = true;
	let channel: string | undefined;
	let viewport: BrowserLaunchConfig['viewport'] | null | undefined = { ...DEFAULT_DEMO_VIEWPORT };

	if (configPath) {
		try {
			const raw = await fs.readFile(configPath, 'utf8');
			const parsed = readJsonObject(raw);
			const browser = parsed?.browser;
			const launchOptions =
				browser && typeof browser === 'object'
					? ((browser as Record<string, unknown>).launchOptions as
							| Record<string, unknown>
							| undefined)
					: undefined;
			const contextOptions =
				browser && typeof browser === 'object'
					? ((browser as Record<string, unknown>).contextOptions as
							| Record<string, unknown>
							| undefined)
					: undefined;
			if (typeof launchOptions?.headless === 'boolean') {
				headless = launchOptions.headless;
			}
			if (typeof launchOptions?.channel === 'string' && launchOptions.channel.trim()) {
				channel = launchOptions.channel.trim();
			}
			const rawViewport = contextOptions?.viewport;
			if (
				rawViewport &&
				typeof rawViewport === 'object' &&
				typeof (rawViewport as Record<string, unknown>).width === 'number' &&
				typeof (rawViewport as Record<string, unknown>).height === 'number'
			) {
				viewport = {
					width: (rawViewport as Record<string, number>).width,
					height: (rawViewport as Record<string, number>).height,
				};
			}
		} catch (error) {
			logger.warn(`Failed to read browser config ${configPath}: ${String(error)}`, LOG_CONTEXT);
		}
	}

	if (headedOverride !== null) {
		headless = !headedOverride;
	}

	return {
		headless,
		channel,
		viewport,
	};
}

function resolveUserDataDir(
	sessionName: string,
	env: NodeJS.ProcessEnv
): { userDataDir: string; sessionKey: string } {
	const explicitProfileDir =
		typeof env.MAESTRO_DEMO_PROJECT_PROFILE_DIR === 'string' &&
		env.MAESTRO_DEMO_PROJECT_PROFILE_DIR.trim()
			? path.resolve(env.MAESTRO_DEMO_PROJECT_PROFILE_DIR)
			: null;

	if (explicitProfileDir) {
		return {
			userDataDir: explicitProfileDir,
			sessionKey: `${explicitProfileDir}::${sessionName}`,
		};
	}

	const tempBaseDir = path.join(os.tmpdir(), 'maestro-browser-runtime');
	const derivedDir = path.join(tempBaseDir, `${sessionName}-${hashValue(sessionName)}`);
	return {
		userDataDir: derivedDir,
		sessionKey: `${derivedDir}::${sessionName}`,
	};
}

function defaultArtifactPath(cwd: string, prefix: string, extension: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	return path.resolve(cwd, `${prefix}-${stamp}.${extension}`);
}

function resolveArtifactPath(cwd: string, filename: string | null, extension: string): string {
	if (!filename || !filename.trim()) {
		return defaultArtifactPath(cwd, `maestro-${extension}`, extension);
	}
	return path.isAbsolute(filename) ? path.normalize(filename) : path.resolve(cwd, filename);
}

function extractOptionValue(
	args: string[],
	optionName: string
): { value: string | null; rest: string[] } {
	const rest: string[] = [];
	let value: string | null = null;
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === optionName) {
			value = args[index + 1] || null;
			index += 1;
			continue;
		}
		if (token.startsWith(`${optionName}=`)) {
			value = token.slice(optionName.length + 1) || null;
			continue;
		}
		rest.push(token);
	}
	return { value, rest };
}

async function formatSnapshot(
	entries: SnapshotEntry[],
	page: Page,
	session: SessionState
): Promise<string> {
	const title = (await page.title()) || page.url() || 'about:blank';
	const tabLines = session.pageOrder.map((pageId, index) => {
		const pageState = session.pageStates.get(pageId);
		if (!pageState) return null;
		const label = pageState.page.url() || 'about:blank';
		const activeMarker = pageId === session.activePageId ? '*' : '-';
		return `${activeMarker} ${index}: ${label}`;
	});

	const elementLines = entries.map((entry) => {
		const parts = [`${entry.ref}`, `<${entry.tag}>`];
		if (entry.role) parts.push(`role=${entry.role}`);
		if (entry.type) parts.push(`type=${entry.type}`);
		if (entry.text) parts.push(`"${entry.text}"`);
		if (entry.name && entry.name !== entry.text) parts.push(`name=${entry.name}`);
		if (entry.placeholder) parts.push(`placeholder=${entry.placeholder}`);
		if (entry.ariaLabel && entry.ariaLabel !== entry.text) parts.push(`aria=${entry.ariaLabel}`);
		if (entry.testId) parts.push(`testid=${entry.testId}`);
		if (entry.handleKind) parts.push(`handle=${entry.handleKind}`);
		if (entry.classSummary) parts.push(`class=${entry.classSummary}`);
		if (entry.checked !== null) parts.push(entry.checked ? 'checked' : 'unchecked');
		if (entry.disabled) parts.push('disabled');
		return `- ${parts.join(' ')}`;
	});

	return [
		'### Page',
		`URL: ${page.url() || 'about:blank'}`,
		`Title: ${title}`,
		'',
		'### Tabs',
		...tabLines.filter((line): line is string => Boolean(line)),
		'',
		'### Elements',
		...(elementLines.length ? elementLines : ['- No visible interactive elements found.']),
		'',
	].join('\n');
}

async function collectSnapshotEntries(page: Page): Promise<SnapshotEntry[]> {
	return await page.evaluate((maxElements) => {
		const doc = (globalThis as any).document;
		const win = globalThis as any;
		if (!doc) {
			return [];
		}

		const existing = doc.querySelectorAll('[data-maestro-ref]');
		for (const node of existing) {
			node.removeAttribute('data-maestro-ref');
		}

		const selectors = [
			'a',
			'button',
			'input',
			'textarea',
			'select',
			'label',
			'summary',
			'[role]',
			'[contenteditable="true"]',
			'[tabindex]:not([tabindex="-1"])',
			'[onclick]',
			'.react-flow__handle',
			'.xy-flow__handle',
			'[data-handleid]',
			'[data-node-handle]',
			'[data-source-handleid]',
			'[data-target-handleid]',
		].join(',');

		const isVisible = (element: any) => {
			if (!element || typeof element.getBoundingClientRect !== 'function') return false;
			const style = win.getComputedStyle(element);
			if (!style || style.visibility === 'hidden' || style.display === 'none') return false;
			if (style.opacity === '0') return false;
			const rect = element.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		};

		const textFor = (element: any) => {
			if (String(element.tagName || '').toLowerCase() === 'select') {
				const selectedOption =
					typeof element.selectedIndex === 'number' && element.selectedIndex >= 0
						? element.options?.[element.selectedIndex]
						: null;
				const selectedText =
					typeof selectedOption?.text === 'string' ? selectedOption.text.trim() : '';
				if (selectedText) {
					return selectedText.replace(/\s+/g, ' ');
				}
				if (typeof element.value === 'string' && element.value.trim()) {
					return element.value.trim().replace(/\s+/g, ' ');
				}
			}

			const textParts = [
				element.innerText,
				element.value,
				element.getAttribute?.('aria-label'),
				element.getAttribute?.('placeholder'),
				element.getAttribute?.('title'),
				element.getAttribute?.('alt'),
			]
				.filter((value: unknown) => typeof value === 'string' && value.trim())
				.map((value: string) => value.trim().replace(/\s+/g, ' '));
			return textParts[0] || null;
		};

		const summarizeClasses = (element: any) => {
			const className =
				typeof element.className === 'string'
					? element.className
					: typeof element.getAttribute === 'function'
						? element.getAttribute('class')
						: null;
			if (typeof className !== 'string' || !className.trim()) {
				return null;
			}
			const meaningful = className
				.split(/\s+/)
				.map((token: string) => token.trim())
				.filter(Boolean)
				.filter(
					(token: string) =>
						token.includes('handle') ||
						token.includes('connector') ||
						token.includes('port') ||
						token.includes('node') ||
						token.includes('edge')
				)
				.slice(0, 4);
			return meaningful.length > 0 ? meaningful.join('.') : null;
		};

		const inferHandleKind = (element: any) => {
			const explicit =
				element.getAttribute?.('data-handleid') ||
				element.getAttribute?.('data-node-handle') ||
				element.getAttribute?.('data-source-handleid') ||
				element.getAttribute?.('data-target-handleid');
			if (typeof explicit === 'string' && explicit.trim()) {
				return explicit.trim();
			}
			const classes =
				typeof element.className === 'string'
					? element.className
					: typeof element.getAttribute === 'function'
						? element.getAttribute('class') || ''
						: '';
			if (/\b(source|out)\b/i.test(classes)) return 'source';
			if (/\b(target|in)\b/i.test(classes)) return 'target';
			if (/react-flow__handle|xy-flow__handle/i.test(classes)) return 'handle';
			return null;
		};

		const seen = new Set<any>();
		const entries: SnapshotEntry[] = [];
		const nodes = Array.from(doc.querySelectorAll(selectors)) as any[];
		for (const element of nodes) {
			if (entries.length >= maxElements) break;
			if (seen.has(element) || !isVisible(element)) continue;
			seen.add(element);
			const ref = `e${entries.length + 1}`;
			element.setAttribute('data-maestro-ref', ref);
			entries.push({
				ref,
				tag: String(element.tagName || '').toLowerCase(),
				role: element.getAttribute?.('role') || null,
				type: element.getAttribute?.('type') || null,
				text: textFor(element),
				name: element.getAttribute?.('name') || null,
				placeholder: element.getAttribute?.('placeholder') || null,
				ariaLabel: element.getAttribute?.('aria-label') || null,
				testId:
					element.getAttribute?.('data-testid') || element.getAttribute?.('data-test-id') || null,
				classSummary: summarizeClasses(element),
				handleKind: inferHandleKind(element),
				checked: typeof element.checked === 'boolean' ? Boolean(element.checked) : null,
				disabled: Boolean(element.disabled),
			});
		}

		return entries;
	}, MAX_SNAPSHOT_ELEMENTS);
}

export class MaestroPlaywrightDriver {
	private readonly sessions = new Map<string, SessionState>();
	private cleanupTimer: NodeJS.Timeout | null = null;

	private shouldShowRecordingOverlay(session: SessionState, pageId: string): boolean {
		return session.activeVideoPageId === pageId;
	}

	private async ensureRecordingOverlay(page: Page): Promise<void> {
		await page.evaluate((stateKey) => {
			const globalWindow = globalThis as typeof globalThis & Record<string, unknown>;
			const existingApi = globalWindow[stateKey] as
				| {
						ensure?: () => void;
				  }
				| undefined;
			if (existingApi?.ensure) {
				existingApi.ensure();
				return;
			}

			const rootId = '__maestro-recording-overlay-root';
			const styleId = '__maestro-recording-overlay-style';
			const state = {
				enabled: false,
				pointer: {
					x: 0,
					y: 0,
					visible: false,
					pressed: false,
				},
				focusRect: null as OverlayRect | null,
				clickPulseCount: 0,
			};

			const ensure = () => {
				const documentRef = globalWindow.document as any;
				if (!documentRef || !documentRef.documentElement) {
					return null;
				}

				if (!documentRef.getElementById(styleId)) {
					const style = documentRef.createElement('style') as any;
					style.id = styleId;
					style.textContent = `
						#${rootId} {
							position: fixed;
							inset: 0;
							pointer-events: none;
							z-index: 2147483647;
							overflow: hidden;
						}
						#${rootId}[data-enabled="false"] {
							opacity: 0;
						}
						#${rootId}[data-enabled="true"] {
							opacity: 1;
						}
						#${rootId} .maestro-recording-cursor {
							position: absolute;
							width: 20px;
							height: 28px;
							margin-left: -3px;
							margin-top: -2px;
							background: rgba(255, 255, 255, 0.98);
							clip-path: polygon(0 0, 0 82%, 28% 63%, 46% 100%, 60% 94%, 44% 58%, 78% 58%);
							filter: drop-shadow(0 0 0.8px rgba(15, 23, 42, 0.92)) drop-shadow(0 8px 18px rgba(15, 23, 42, 0.22));
							transform: translate(-9999px, -9999px);
							transform-origin: top left;
							transition: transform 420ms ease-out, opacity 160ms ease-out, filter 160ms ease-out;
							opacity: 0;
						}
						#${rootId} .maestro-recording-cursor[data-visible="true"] {
							opacity: 1;
						}
						#${rootId} .maestro-recording-cursor[data-pressed="true"] {
							filter: drop-shadow(0 0 1px rgba(15, 23, 42, 0.95)) drop-shadow(0 5px 14px rgba(15, 23, 42, 0.2));
						}
						#${rootId} .maestro-recording-cursor::after {
							content: '';
							position: absolute;
							left: 2px;
							top: 2px;
							width: 15px;
							height: 22px;
							background: rgba(15, 23, 42, 0.9);
							clip-path: polygon(0 0, 0 82%, 28% 63%, 46% 100%, 60% 94%, 44% 58%, 78% 58%);
							transform: translate(1px, 1px);
							opacity: 0.18;
						}
						#${rootId} .maestro-recording-click {
							position: absolute;
							width: 20px;
							height: 20px;
							margin-left: -10px;
							margin-top: -10px;
							border-radius: 999px;
							border: 3px solid rgba(79, 70, 229, 0.82);
							background: rgba(79, 70, 229, 0.18);
							transform: translate(-9999px, -9999px) scale(0.5);
							opacity: 0;
						}
						#${rootId} .maestro-recording-click[data-active="true"] {
							animation: maestro-recording-click-pulse 1100ms ease-out;
						}
						#${rootId} .maestro-recording-focus {
							position: absolute;
							border-radius: 999px;
							border: 2px solid rgba(79, 70, 229, 0.72);
							background: rgba(79, 70, 229, 0.06);
							box-shadow: 0 0 0 6px rgba(79, 70, 229, 0.08), 0 8px 18px rgba(15, 23, 42, 0.08);
							opacity: 0;
							transform: scale(0.98);
							transition: opacity 180ms ease-out, transform 180ms ease-out, left 180ms ease-out, top 180ms ease-out, width 180ms ease-out, height 180ms ease-out;
						}
						#${rootId} .maestro-recording-focus[data-visible="true"] {
							opacity: 1;
							transform: scale(1);
						}
						@keyframes maestro-recording-click-pulse {
							0% {
								opacity: 0.92;
								transform: scale(0.4);
							}
							80% {
								opacity: 0.18;
								transform: scale(3.8);
							}
							100% {
								opacity: 0;
								transform: scale(4);
							}
						}
					`;
					documentRef.head?.appendChild(style);
				}

				let root = documentRef.getElementById(rootId) as any;
				if (!root) {
					root = documentRef.createElement('div');
					root.id = rootId;
					root.setAttribute('data-enabled', 'false');
					root.innerHTML = `
						<div class="maestro-recording-focus" data-visible="false"></div>
						<div class="maestro-recording-click" data-active="false"></div>
						<div class="maestro-recording-cursor" data-visible="false" data-pressed="false"></div>
					`;
					documentRef.body?.appendChild(root);
				} else if (!root.parentElement && documentRef.body) {
					documentRef.body.appendChild(root);
				}

				const focus = root.querySelector('.maestro-recording-focus') as any;
				const click = root.querySelector('.maestro-recording-click') as any;
				const cursor = root.querySelector('.maestro-recording-cursor') as any;

				if (!focus || !click || !cursor) {
					return null;
				}

				return { root, focus, click, cursor };
			};

			const api = {
				ensure,
				setEnabled: (enabled: boolean) => {
					state.enabled = enabled;
					const elements = ensure();
					if (!elements) return;
					elements.root.setAttribute('data-enabled', enabled ? 'true' : 'false');
					if (!enabled) {
						elements.cursor.setAttribute('data-visible', 'false');
						elements.focus.setAttribute('data-visible', 'false');
						elements.click.setAttribute('data-active', 'false');
						state.pointer.visible = false;
						state.focusRect = null;
					}
				},
				moveCursor: (x: number, y: number, pressed = false) => {
					state.pointer = { x, y, visible: true, pressed };
					const elements = ensure();
					if (!elements || !state.enabled) return;
					elements.cursor.style.transform = `translate(${x}px, ${y}px)`;
					elements.cursor.setAttribute('data-visible', 'true');
					elements.cursor.setAttribute('data-pressed', pressed ? 'true' : 'false');
				},
				click: (x: number, y: number) => {
					state.clickPulseCount += 1;
					const elements = ensure();
					if (!elements || !state.enabled) return;
					elements.click.style.transform = `translate(${x}px, ${y}px) scale(0.5)`;
					elements.click.setAttribute('data-active', 'false');
					void elements.click.getBoundingClientRect();
					elements.click.setAttribute('data-active', 'true');
					globalWindow.setTimeout(() => {
						elements.click?.setAttribute('data-active', 'false');
					}, 520);
				},
				focusRect: (rect: OverlayRect | null) => {
					state.focusRect = rect;
					const elements = ensure();
					if (!elements || !state.enabled) return;
					if (!rect) {
						elements.focus.setAttribute('data-visible', 'false');
						return;
					}
					const paddingX = 8;
					const paddingY = 8;
					const left = Math.max(8, rect.x - paddingX);
					const top = Math.max(8, rect.y - paddingY);
					const width = Math.max(36, rect.width + paddingX * 2);
					const height = Math.max(36, rect.height + paddingY * 2);
					elements.focus.style.left = `${left}px`;
					elements.focus.style.top = `${top}px`;
					elements.focus.style.width = `${width}px`;
					elements.focus.style.height = `${height}px`;
					elements.focus.setAttribute('data-visible', 'true');
				},
				clearFocus: () => {
					state.focusRect = null;
					const elements = ensure();
					if (!elements) return;
					elements.focus.setAttribute('data-visible', 'false');
				},
				getState: () => ({
					enabled: state.enabled,
					pointer: state.pointer,
					focusRect: state.focusRect,
					clickPulseCount: state.clickPulseCount,
				}),
			};

			globalWindow[stateKey] = api;
			api.ensure();
		}, RECORDING_OVERLAY_STATE_KEY);
	}

	private async setRecordingOverlayEnabled(page: Page, enabled: boolean): Promise<void> {
		await this.ensureRecordingOverlay(page);
		await page.evaluate(
			({ stateKey, enabledValue }) => {
				const api = (globalThis as typeof globalThis & Record<string, unknown>)[stateKey] as
					| { setEnabled?: (enabled: boolean) => void }
					| undefined;
				api?.setEnabled?.(enabledValue);
			},
			{ stateKey: RECORDING_OVERLAY_STATE_KEY, enabledValue: enabled }
		);
	}

	private async setRecordingOverlayFocus(page: Page, rect: OverlayRect | null): Promise<void> {
		await this.ensureRecordingOverlay(page);
		await page.evaluate(
			({ stateKey, rectValue }) => {
				const api = (globalThis as typeof globalThis & Record<string, unknown>)[stateKey] as
					| { focusRect?: (rect: OverlayRect | null) => void }
					| undefined;
				api?.focusRect?.(rectValue);
			},
			{ stateKey: RECORDING_OVERLAY_STATE_KEY, rectValue: rect }
		);
	}

	private async moveRecordingOverlayCursor(
		page: Page,
		point: OverlayPoint,
		pressed = false
	): Promise<void> {
		await this.ensureRecordingOverlay(page);
		await page.evaluate(
			({ stateKey, x, y, pressedValue }) => {
				const api = (globalThis as typeof globalThis & Record<string, unknown>)[stateKey] as
					| { moveCursor?: (x: number, y: number, pressed?: boolean) => void }
					| undefined;
				api?.moveCursor?.(x, y, pressedValue);
			},
			{ stateKey: RECORDING_OVERLAY_STATE_KEY, x: point.x, y: point.y, pressedValue: pressed }
		);
	}

	private async triggerRecordingOverlayClick(page: Page, point: OverlayPoint): Promise<void> {
		await this.ensureRecordingOverlay(page);
		await page.evaluate(
			({ stateKey, x, y }) => {
				const api = (globalThis as typeof globalThis & Record<string, unknown>)[stateKey] as
					| { click?: (x: number, y: number) => void }
					| undefined;
				api?.click?.(x, y);
			},
			{ stateKey: RECORDING_OVERLAY_STATE_KEY, x: point.x, y: point.y }
		);
	}

	private getBoxCenter(
		box: NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>
	): OverlayPoint {
		return {
			x: box.x + box.width / 2,
			y: box.y + box.height / 2,
		};
	}

	private async centerLocatorInViewport(locator: Locator): Promise<void> {
		await locator.evaluate((element) => {
			try {
				(element as any).scrollIntoView({
					block: 'center',
					inline: 'center',
					behavior: 'instant',
				});
			} catch {
				(element as any).scrollIntoView({
					block: 'center',
					inline: 'center',
				});
			}
		});
	}

	private async prepareLocatorForRecording(
		session: SessionState,
		pageState: PageState,
		locator: Locator
	): Promise<OverlayPoint | null> {
		await locator.scrollIntoViewIfNeeded();
		if (!this.shouldShowRecordingOverlay(session, pageState.id)) {
			return null;
		}

		await this.centerLocatorInViewport(locator);
		const box = await locator.boundingBox();
		if (!box) {
			return null;
		}

		const point = this.getBoxCenter(box);
		await this.setRecordingOverlayFocus(pageState.page, {
			x: box.x,
			y: box.y,
			width: box.width,
			height: box.height,
		});
		await this.moveRecordingOverlayCursor(pageState.page, point, false);
		await pageState.page.mouse.move(point.x, point.y);
		await pageState.page.waitForTimeout(60);
		return point;
	}

	async execute(payload: BrowserBrokerExecuteRequest): Promise<BrowserBrokerExecuteResponse> {
		const mergedEnv: NodeJS.ProcessEnv = {
			...process.env,
			...(payload.env || {}),
		};
		const parsed = parseGlobalCommandArgs(payload.args || [], mergedEnv);
		if (!parsed.command) {
			return buildResult('', this.helpText(), 1);
		}
		if (isHelpRequest(parsed.command, parsed.commandArgs)) {
			return buildResult(`${this.helpText()}\n`);
		}

		try {
			const session = await this.ensureSession(parsed, mergedEnv);
			session.lastUsedAt = Date.now();
			this.ensureCleanupTimer();
			return await this.executeCommand(
				session,
				parsed.command,
				parsed.commandArgs,
				payload.cwd || process.cwd()
			);
		} catch (error) {
			return buildResult('', `Maestro browser command failed: ${String(error)}\n`, 1);
		}
	}

	async dispose(): Promise<void> {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		const sessions = Array.from(this.sessions.values());
		this.sessions.clear();
		await Promise.allSettled(
			sessions.map(async (session) => {
				await session.context.close();
			})
		);
	}

	private helpText(): string {
		return [
			'Usage: maestro-pwcli [--session <name>] [--config <path>] <command> [args]',
			'Commands: open, close, snapshot, click, dblclick, hover, fill, type, press, keydown, keyup,',
			'check, uncheck, select, drag, eval, run-code, screenshot, pdf, resize, go-back, go-forward, reload,',
			'tab-list, tab-new, tab-select, tab-close, upload, dialog-accept, dialog-dismiss,',
			'mousemove, mousedown, mouseup, mousewheel, console, network, tracing-start, tracing-stop,',
			'video-start, video-stop',
		].join('\n');
	}

	private ensureCleanupTimer(): void {
		if (this.cleanupTimer) {
			return;
		}
		this.cleanupTimer = setInterval(() => {
			void this.cleanupIdleSessions();
		}, 60 * 1000);
		this.cleanupTimer.unref();
	}

	private async cleanupIdleSessions(): Promise<void> {
		const now = Date.now();
		const idleSessions = Array.from(this.sessions.values()).filter(
			(session) => now - session.lastUsedAt > DEFAULT_IDLE_TTL_MS
		);
		await Promise.allSettled(
			idleSessions.map(async (session) => {
				this.sessions.delete(session.key);
				await session.context.close();
			})
		);
	}

	private async ensureSession(
		parsed: ParsedBrowserCommand,
		env: NodeJS.ProcessEnv
	): Promise<SessionState> {
		const { userDataDir, sessionKey } = resolveUserDataDir(parsed.sessionName, env);
		const existing = this.sessions.get(sessionKey);
		if (existing) {
			if (!(await this.isSessionUsable(existing))) {
				this.sessions.delete(sessionKey);
				await existing.context.close().catch(() => undefined);
			} else {
				existing.autoRecordVideo = existing.autoRecordVideo || env.MAESTRO_DEMO_CAPTURE === '1';
				return existing;
			}
		}

		const launchConfig = await loadLaunchConfig(parsed.configPath, parsed.headedOverride);

		await fs.mkdir(userDataDir, { recursive: true });
		const videoArtifactDir = path.join(userDataDir, 'videos');
		await fs.mkdir(videoArtifactDir, { recursive: true });

		const context = await this.launchPersistentContext(userDataDir, launchConfig, videoArtifactDir);
		const session: SessionState = {
			key: sessionKey,
			sessionName: parsed.sessionName,
			userDataDir,
			context,
			pageStates: new Map(),
			pageOrder: [],
			activePageId: null,
			lastUsedAt: Date.now(),
			headless: launchConfig.headless,
			channel: launchConfig.channel,
			viewport: launchConfig.viewport,
			autoRecordVideo: env.MAESTRO_DEMO_CAPTURE === '1',
			videoArtifactDir,
			activeVideoPageId: null,
		};

		context.on('close', () => {
			if (this.sessions.get(sessionKey) === session) {
				this.sessions.delete(sessionKey);
			}
			session.pageStates.clear();
			session.pageOrder = [];
			session.activePageId = null;
			session.activeVideoPageId = null;
		});
		context.on('page', (page) => {
			this.attachPage(session, page);
		});
		for (const page of context.pages()) {
			this.attachPage(session, page);
		}
		this.sessions.set(sessionKey, session);
		return session;
	}

	private async isSessionUsable(session: SessionState): Promise<boolean> {
		const browser = session.context.browser();
		if (browser && !browser.isConnected()) {
			return false;
		}

		try {
			session.context.pages();
			return true;
		} catch {
			return false;
		}
	}

	private async launchPersistentContext(
		userDataDir: string,
		launchConfig: BrowserLaunchConfig,
		videoArtifactDir: string
	): Promise<BrowserContext> {
		const chromium = loadChromium();
		const launchAttempts = [
			launchConfig,
			launchConfig.channel
				? null
				: {
						...launchConfig,
						channel: 'chrome',
					},
		].filter((attempt): attempt is BrowserLaunchConfig => Boolean(attempt));

		let lastError: unknown;
		for (const attempt of launchAttempts) {
			try {
				return await chromium.launchPersistentContext(userDataDir, {
					headless: attempt.headless,
					channel: attempt.channel,
					viewport: attempt.viewport || undefined,
					recordVideo: {
						dir: videoArtifactDir,
						size: attempt.viewport || { width: 1280, height: 720 },
					},
					acceptDownloads: true,
				});
			} catch (error) {
				lastError = error;
				logger.warn(
					`Persistent browser launch failed for ${userDataDir} (${attempt.channel || 'default'}): ${String(error)}`,
					LOG_CONTEXT
				);
			}
		}

		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	private attachPage(session: SessionState, page: Page): void {
		const existing = Array.from(session.pageStates.values()).find((state) => state.page === page);
		if (existing) {
			session.activePageId = existing.id;
			return;
		}

		const id = randomUUID();
		const pageState: PageState = {
			id,
			page,
			consoleEntries: [],
			networkEntries: [],
			pendingDialog: null,
		};
		page.on('console', (message) => {
			pageState.consoleEntries.push(this.formatConsoleMessage(message));
			if (pageState.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
				pageState.consoleEntries.splice(0, pageState.consoleEntries.length - MAX_CONSOLE_ENTRIES);
			}
		});
		page.on('dialog', (dialog) => {
			pageState.pendingDialog = dialog;
		});
		page.on('response', (response) => {
			pageState.networkEntries.push(this.formatResponse(response));
			if (pageState.networkEntries.length > MAX_NETWORK_ENTRIES) {
				pageState.networkEntries.splice(0, pageState.networkEntries.length - MAX_NETWORK_ENTRIES);
			}
		});
		page.on('close', () => {
			session.pageStates.delete(id);
			session.pageOrder = session.pageOrder.filter((pageId) => pageId !== id);
			if (session.activePageId === id) {
				session.activePageId = session.pageOrder[session.pageOrder.length - 1] || null;
			}
			if (session.activeVideoPageId === id) {
				session.activeVideoPageId = null;
			}
		});
		session.pageStates.set(id, pageState);
		session.pageOrder.push(id);
		session.activePageId = id;
		void this.ensureSessionViewport(page, session).catch(() => undefined);
		void this.ensureRecordingOverlay(page)
			.then(async () => {
				if (this.shouldShowRecordingOverlay(session, id)) {
					await this.setRecordingOverlayEnabled(page, true);
				}
			})
			.catch(() => undefined);
		page.on('domcontentloaded', () => {
			void this.ensureRecordingOverlay(page)
				.then(async () => {
					if (this.shouldShowRecordingOverlay(session, id)) {
						await this.setRecordingOverlayEnabled(page, true);
					}
				})
				.catch(() => undefined);
		});
	}

	private formatConsoleMessage(message: ConsoleMessage): ConsoleEntry {
		return {
			type: message.type(),
			text: message.text(),
		};
	}

	private formatResponse(response: Response): NetworkEntry {
		return {
			status: response.status(),
			method: response.request().method(),
			url: response.url(),
		};
	}

	private getActivePageState(session: SessionState): PageState {
		const pageId = session.activePageId;
		if (!pageId) {
			throw new Error('No active browser tab is available.');
		}
		const pageState = session.pageStates.get(pageId);
		if (!pageState) {
			throw new Error('The active browser tab is no longer available.');
		}
		return pageState;
	}

	private async ensureLocator(page: Page, ref: string) {
		const locator = page.locator(`[data-maestro-ref="${ref}"]`).first();
		if ((await locator.count()) < 1) {
			throw new Error(
				`Element reference ${ref} was not found. Run snapshot again before using it.`
			);
		}
		return locator;
	}

	private async executeCommand(
		session: SessionState,
		command: string,
		commandArgs: string[],
		cwd: string
	): Promise<BrowserBrokerExecuteResponse> {
		if (this.shouldAutoStartVideo(session, command)) {
			await this.ensureAutoVideoRecording(session);
		}

		switch (command) {
			case '--help':
			case 'help':
				return buildResult(`${this.helpText()}\n`);
			case 'open':
				return await this.commandOpen(session, commandArgs);
			case 'close':
				return await this.commandClose(session);
			case 'snapshot':
				return await this.commandSnapshot(session);
			case 'click':
			case 'dblclick':
			case 'hover':
				return await this.commandPointerAction(session, command, commandArgs);
			case 'fill':
				return await this.commandFill(session, commandArgs);
			case 'type':
				return await this.commandType(session, commandArgs);
			case 'press':
			case 'keydown':
			case 'keyup':
				return await this.commandKeyboard(session, command, commandArgs);
			case 'check':
			case 'uncheck':
				return await this.commandCheck(session, command, commandArgs);
			case 'select':
				return await this.commandSelect(session, commandArgs);
			case 'drag':
				return await this.commandDrag(session, commandArgs);
			case 'eval':
			case 'run-code':
				return await this.commandEval(session, commandArgs);
			case 'screenshot':
				return await this.commandScreenshot(session, commandArgs, cwd);
			case 'pdf':
				return await this.commandPdf(session, commandArgs, cwd);
			case 'resize':
				return await this.commandResize(session, commandArgs);
			case 'go-back':
			case 'go-forward':
			case 'reload':
				return await this.commandNavigate(session, command);
			case 'tab-list':
				return this.commandTabList(session);
			case 'tab-new':
				return await this.commandTabNew(session, commandArgs);
			case 'tab-select':
				return this.commandTabSelect(session, commandArgs);
			case 'tab-close':
				return await this.commandTabClose(session, commandArgs);
			case 'upload':
				return await this.commandUpload(session, commandArgs, cwd);
			case 'dialog-accept':
			case 'dialog-dismiss':
				return await this.commandDialog(session, command, commandArgs);
			case 'mousemove':
			case 'mousedown':
			case 'mouseup':
			case 'mousewheel':
				return await this.commandMouse(session, command, commandArgs);
			case 'console':
				return this.commandConsole(session, commandArgs);
			case 'network':
				return this.commandNetwork(session);
			case 'tracing-start':
			case 'tracing-stop':
				return await this.commandTracing(session, command, commandArgs, cwd);
			case 'video-start':
				return await this.commandVideoStart(session);
			case 'video-stop':
				return await this.commandVideoStop(session, commandArgs, cwd);
			default:
				return buildResult('', `Unsupported browser command: ${command}\n`, 1);
		}
	}

	private shouldAutoStartVideo(session: SessionState, command: string): boolean {
		if (!session.autoRecordVideo || session.activeVideoPageId) {
			return false;
		}

		return ![
			'--help',
			'help',
			'close',
			'console',
			'network',
			'open',
			'status',
			'video-start',
			'video-stop',
		].includes(command);
	}

	private async ensureAutoVideoRecording(session: SessionState): Promise<void> {
		const pageState = this.getActivePageState(session);
		session.activeVideoPageId = pageState.id;
		await this.ensureSessionViewport(pageState.page, session);
		await this.setRecordingOverlayEnabled(pageState.page, true);
		await this.setRecordingOverlayFocus(pageState.page, null);
	}

	private async ensureSessionViewport(page: Page, session: SessionState): Promise<void> {
		if (!session.viewport) {
			return;
		}
		await page.setViewportSize(session.viewport);
	}

	private async commandOpen(
		session: SessionState,
		commandArgs: string[]
	): Promise<BrowserBrokerExecuteResponse> {
		let pageState: PageState;
		if (session.activePageId) {
			pageState = this.getActivePageState(session);
			if (pageState.page.url() === 'about:blank') {
				const page = await session.context.newPage();
				this.attachPage(session, page);
				pageState = this.getActivePageState(session);
			}
		} else {
			const page = await session.context.newPage();
			this.attachPage(session, page);
			pageState = this.getActivePageState(session);
		}
		const url = commandArgs.find((arg) => !arg.startsWith('--')) || 'about:blank';
		await this.ensureSessionViewport(pageState.page, session);
		await pageState.page.goto(url, { waitUntil: 'domcontentloaded' });
		if (
			session.autoRecordVideo &&
			!session.activeVideoPageId &&
			pageState.page.url() !== 'about:blank'
		) {
			await this.ensureAutoVideoRecording(session);
		}
		return buildResult(`Opened ${pageState.page.url()}\n`);
	}

	private async commandClose(session: SessionState): Promise<BrowserBrokerExecuteResponse> {
		this.sessions.delete(session.key);
		await session.context.close();
		return buildResult('Closed browser session.\n');
	}

	private async commandSnapshot(session: SessionState): Promise<BrowserBrokerExecuteResponse> {
		const pageState = this.getActivePageState(session);
		const entries = await collectSnapshotEntries(pageState.page);
		return buildResult(await formatSnapshot(entries, pageState.page, session));
	}

	private async commandPointerAction(
		session: SessionState,
		command: 'click' | 'dblclick' | 'hover',
		commandArgs: string[]
	): Promise<BrowserBrokerExecuteResponse> {
		const ref = commandArgs[0];
		if (!isRefToken(ref)) {
			return buildResult('', `${command} requires an element ref like e1.\n`, 1);
		}
		const pageState = this.getActivePageState(session);
		const locator = await this.ensureLocator(pageState.page, ref);
		const focusPoint = await this.prepareLocatorForRecording(session, pageState, locator);
		if (command === 'click') await locator.click();
		if (command === 'dblclick') await locator.dblclick();
		if (command === 'hover') await locator.hover();
		if (focusPoint && command !== 'hover') {
			await this.triggerRecordingOverlayClick(pageState.page, focusPoint);
			await pageState.page.waitForTimeout(command === 'dblclick' ? 220 : 180);
		}
		return buildResult(
			`${command === 'dblclick' ? 'Double-clicked' : command === 'hover' ? 'Hovered' : 'Clicked'} ${ref}\n`
		);
	}

	private async commandFill(
		session: SessionState,
		commandArgs: string[]
	): Promise<BrowserBrokerExecuteResponse> {
		const [ref, value] = commandArgs;
		if (!isRefToken(ref) || typeof value !== 'string') {
			return buildResult('', 'fill requires an element ref and text value.\n', 1);
		}
		const pageState = this.getActivePageState(session);
		const locator = await this.ensureLocator(pageState.page, ref);
		const focusPoint = await this.prepareLocatorForRecording(session, pageState, locator);
		await locator.click();
		if (focusPoint) {
			await this.triggerRecordingOverlayClick(pageState.page, focusPoint);
		}
		await locator.fill(value);
		return buildResult(`Filled ${ref}\n`);
	}

	private async commandType(
		session: SessionState,
		commandArgs: string[]
	): Promise<BrowserBrokerExecuteResponse> {
		const pageState = this.getActivePageState(session);
		if (commandArgs.length === 0) {
			return buildResult('', 'type requires text.\n', 1);
		}
		if (isRefToken(commandArgs[0]) && typeof commandArgs[1] === 'string') {
			const locator = await this.ensureLocator(pageState.page, commandArgs[0]);
			const focusPoint = await this.prepareLocatorForRecording(session, pageState, locator);
			await locator.click();
			if (focusPoint) {
				await this.triggerRecordingOverlayClick(pageState.page, focusPoint);
			}
			await pageState.page.keyboard.type(commandArgs[1]);
			return buildResult(`Typed into ${commandArgs[0]}\n`);
		}
		await pageState.page.keyboard.type(commandArgs[0]);
		return buildResult('Typed text.\n');
	}

	private async commandKeyboard(
		session: SessionState,
		command: 'press' | 'keydown' | 'keyup',
		commandArgs: string[]
	): Promise<BrowserBrokerExecuteResponse> {
		const pageState = this.getActivePageState(session);
		let key = commandArgs[0];
		if (isRefToken(commandArgs[0]) && typeof commandArgs[1] === 'string') {
			const locator = await this.ensureLocator(pageState.page, commandArgs[0]);
			const focusPoint = await this.prepareLocatorForRecording(session, pageState, locator);
			await locator.click();
			if (focusPoint) {
				await this.triggerRecordingOverlayClick(pageState.page, focusPoint);
			}
			key = commandArgs[1];
		}
		if (!key) {
			return buildResult('', `${command} requires a key value.\n`, 1);
		}
		if (command === 'press') await pageState.page.keyboard.press(key);
		if (command === 'keydown') await pageState.page.keyboard.down(key);
		if (command === 'keyup') await pageState.page.keyboard.up(key);
		return buildResult(`${command} ${key}\n`);
	}

	private async commandCheck(
		session: SessionState,
		command: 'check' | 'uncheck',
		commandArgs: string[]
	): Promise<BrowserBrokerExecuteResponse> {
		const ref = commandArgs[0];
		if (!isRefToken(ref)) {
			return buildResult('', `${command} requires an element ref like e1.\n`, 1);
		}
		const pageState = this.getActivePageState(session);
		const locator = await this.ensureLocator(pageState.page, ref);
		const focusPoint = await this.prepareLocatorForRecording(session, pageState, locator);
		if (command === 'check') await locator.check();
		if (command === 'uncheck') await locator.uncheck();
		if (focusPoint) {
			await this.triggerRecordingOverlayClick(pageState.page, focusPoint);
		}
		return buildResult(`${command === 'check' ? 'Checked' : 'Unchecked'} ${ref}\n`);
	}

	private async commandSelect(
		session: SessionState,
		commandArgs: string[]
	): Promise<BrowserBrokerExecuteResponse> {
		const [ref, value] = commandArgs;
		if (!isRefToken(ref) || typeof value !== 'string') {
			return buildResult('', 'select requires an element ref and option value.\n', 1);
		}
		const pageState = this.getActivePageState(session);
		const locator = await this.ensureLocator(pageState.page, ref);
		const focusPoint = await this.prepareLocatorForRecording(session, pageState, locator);
		await locator.selectOption(value);
		if (focusPoint) {
			await this.triggerRecordingOverlayClick(pageState.page, focusPoint);
		}
		return buildResult(`Selected ${value} on ${ref}\n`);
	}

	private async commandDrag(
		session: SessionState,
		commandArgs: string[]
	): Promise<BrowserBrokerExecuteResponse> {
		const [fromRef, toRef] = commandArgs;
		if (!isRefToken(fromRef) || !isRefToken(toRef)) {
			return buildResult('', 'drag requires two element refs.\n', 1);
		}
		const pageState = this.getActivePageState(session);
		const fromLocator = await this.ensureLocator(pageState.page, fromRef);
		const toLocator = await this.ensureLocator(pageState.page, toRef);
		const preparedFromPoint = await this.prepareLocatorForRecording(
			session,
			pageState,
			fromLocator
		);
		if (preparedFromPoint) {
			await this.triggerRecordingOverlayClick(pageState.page, preparedFromPoint);
		}
		if (this.shouldShowRecordingOverlay(session, pageState.id)) {
			await this.centerLocatorInViewport(toLocator);
			const targetBox = await toLocator.boundingBox();
			if (targetBox) {
				await this.setRecordingOverlayFocus(pageState.page, {
					x: targetBox.x,
					y: targetBox.y,
					width: targetBox.width,
					height: targetBox.height,
				});
				await this.moveRecordingOverlayCursor(pageState.page, this.getBoxCenter(targetBox), true);
			}
		}
		const fromBox = await fromLocator.boundingBox();
		const toBox = await toLocator.boundingBox();
		if (!fromBox || !toBox) {
			return buildResult('', 'Unable to determine source/target positions for drag.\n', 1);
		}
		const fromPoint = this.getBoxCenter(fromBox);
		const toPoint = this.getBoxCenter(toBox);
		await pageState.page.mouse.move(fromPoint.x, fromPoint.y);
		await pageState.page.mouse.down();
		await pageState.page.waitForTimeout(60);
		await pageState.page.mouse.move(toPoint.x, toPoint.y, { steps: 24 });
		await pageState.page.waitForTimeout(60);
		await pageState.page.mouse.up();
		if (this.shouldShowRecordingOverlay(session, pageState.id)) {
			await this.moveRecordingOverlayCursor(pageState.page, toPoint, false);
			await this.triggerRecordingOverlayClick(pageState.page, toPoint);
			await pageState.page.waitForTimeout(120);
		}
		return buildResult(`Dragged ${fromRef} to ${toRef}\n`);
	}

	private async commandEval(
		session: SessionState,
		commandArgs: string[]
	): Promise<BrowserBrokerExecuteResponse> {
		const expression = commandArgs[0];
		if (!expression) {
			return buildResult('', 'eval requires a JavaScript expression.\n', 1);
		}
		const maybeRef = commandArgs[1];
		const pageState = this.getActivePageState(session);
		let result: unknown;
		if (isRefToken(maybeRef)) {
			const locator = await this.ensureLocator(pageState.page, maybeRef);
			result = await locator.evaluate((element, source) => {
				const evaluated = (0, eval)(source as string);
				return typeof evaluated === 'function' ? evaluated(element) : evaluated;
			}, expression);
		} else {
			result = await pageState.page.evaluate((source) => {
				const evaluated = (0, eval)(source as string);
				return typeof evaluated === 'function' ? evaluated() : evaluated;
			}, expression);
		}
		return buildResult(`### Result\n${asJsonResult(result)}\n`);
	}

	private async commandScreenshot(
		session: SessionState,
		commandArgs: string[],
		cwd: string
	): Promise<BrowserBrokerExecuteResponse> {
		const { value: filename, rest } = extractOptionValue(commandArgs, '--filename');
		const fullPage = rest.includes('--full-page');
		let targetRef: string | null = null;
		const firstArg = rest[0];
		if (isRefToken(firstArg)) {
			targetRef = firstArg;
		}
		const outputPath = resolveArtifactPath(cwd, filename, 'png');
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		const pageState = this.getActivePageState(session);
		if (targetRef) {
			const locator = await this.ensureLocator(pageState.page, targetRef);
			await locator.screenshot({ path: outputPath });
		} else {
			await this.ensureSessionViewport(pageState.page, session);
			await pageState.page.screenshot({ path: outputPath, fullPage });
		}
		return buildResult(`${outputPath}\n`);
	}

	private async commandPdf(
		session: SessionState,
		commandArgs: string[],
		cwd: string
	): Promise<BrowserBrokerExecuteResponse> {
		const { value: filename } = extractOptionValue(commandArgs, '--filename');
		const outputPath = resolveArtifactPath(cwd, filename, 'pdf');
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		const pageState = this.getActivePageState(session);
		await pageState.page.pdf({ path: outputPath });
		return buildResult(`${outputPath}\n`);
	}

	private async commandResize(
		session: SessionState,
		commandArgs: string[]
	): Promise<BrowserBrokerExecuteResponse> {
		const width = Number(commandArgs[0]);
		const height = Number(commandArgs[1]);
		if (!Number.isFinite(width) || !Number.isFinite(height)) {
			return buildResult('', 'resize requires numeric width and height.\n', 1);
		}
		const pageState = this.getActivePageState(session);
		await pageState.page.setViewportSize({ width, height });
		session.viewport = { width, height };
		return buildResult(`Resized viewport to ${width}x${height}\n`);
	}

	private async commandNavigate(
		session: SessionState,
		command: 'go-back' | 'go-forward' | 'reload'
	): Promise<BrowserBrokerExecuteResponse> {
		const pageState = this.getActivePageState(session);
		if (command === 'go-back') await pageState.page.goBack({ waitUntil: 'domcontentloaded' });
		if (command === 'go-forward') await pageState.page.goForward({ waitUntil: 'domcontentloaded' });
		if (command === 'reload') await pageState.page.reload({ waitUntil: 'domcontentloaded' });
		return buildResult(`${command}\n`);
	}

	private commandTabList(session: SessionState): BrowserBrokerExecuteResponse {
		const lines = session.pageOrder.map((pageId, index) => {
			const pageState = session.pageStates.get(pageId);
			if (!pageState) return null;
			const marker = pageId === session.activePageId ? '*' : '-';
			return `${marker} ${index}: ${pageState.page.url() || 'about:blank'}`;
		});
		return buildResult(`${lines.filter((line): line is string => Boolean(line)).join('\n')}\n`);
	}

	private async commandTabNew(
		session: SessionState,
		commandArgs: string[]
	): Promise<BrowserBrokerExecuteResponse> {
		const page = await session.context.newPage();
		this.attachPage(session, page);
		await this.ensureSessionViewport(page, session);
		const targetUrl = commandArgs.find((arg) => !arg.startsWith('--'));
		if (targetUrl) {
			await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
		}
		return buildResult(`Opened new tab ${page.url() || 'about:blank'}\n`);
	}

	private commandTabSelect(
		session: SessionState,
		commandArgs: string[]
	): BrowserBrokerExecuteResponse {
		const index = Number(commandArgs[0]);
		if (!Number.isInteger(index) || index < 0 || index >= session.pageOrder.length) {
			return buildResult('', 'tab-select requires a valid tab index.\n', 1);
		}
		session.activePageId = session.pageOrder[index];
		return buildResult(`Selected tab ${index}\n`);
	}

	private async commandTabClose(
		session: SessionState,
		commandArgs: string[]
	): Promise<BrowserBrokerExecuteResponse> {
		let targetPageId = session.activePageId;
		if (typeof commandArgs[0] === 'string') {
			const index = Number(commandArgs[0]);
			if (Number.isInteger(index) && index >= 0 && index < session.pageOrder.length) {
				targetPageId = session.pageOrder[index];
			}
		}
		if (!targetPageId) {
			return buildResult('', 'No tab is available to close.\n', 1);
		}
		const pageState = session.pageStates.get(targetPageId);
		if (!pageState) {
			return buildResult('', 'The requested tab is no longer available.\n', 1);
		}
		await pageState.page.close();
		return buildResult('Closed tab.\n');
	}

	private async commandUpload(
		session: SessionState,
		commandArgs: string[],
		cwd: string
	): Promise<BrowserBrokerExecuteResponse> {
		const pageState = this.getActivePageState(session);
		const firstArg = commandArgs[0];
		if (!firstArg) {
			return buildResult('', 'upload requires a file path.\n', 1);
		}
		const targetPath = path.isAbsolute(firstArg) ? firstArg : path.resolve(cwd, firstArg);
		const handle = await pageState.page.evaluateHandle(
			() => (globalThis as any).document?.activeElement || null
		);
		const element = handle.asElement();
		if (!element) {
			await handle.dispose();
			return buildResult('', 'No focused file input is available for upload.\n', 1);
		}
		await element.setInputFiles(targetPath);
		await handle.dispose();
		return buildResult(`Uploaded ${targetPath}\n`);
	}

	private async commandDialog(
		session: SessionState,
		command: 'dialog-accept' | 'dialog-dismiss',
		commandArgs: string[]
	): Promise<BrowserBrokerExecuteResponse> {
		const pageState = this.getActivePageState(session);
		const dialog = pageState.pendingDialog;
		if (!dialog) {
			return buildResult('', 'No pending browser dialog is available.\n', 1);
		}
		pageState.pendingDialog = null;
		if (command === 'dialog-accept') {
			await dialog.accept(commandArgs[0]);
		} else {
			await dialog.dismiss();
		}
		return buildResult(`${command}\n`);
	}

	private async commandMouse(
		session: SessionState,
		command: 'mousemove' | 'mousedown' | 'mouseup' | 'mousewheel',
		commandArgs: string[]
	): Promise<BrowserBrokerExecuteResponse> {
		const pageState = this.getActivePageState(session);
		if (command === 'mousemove') {
			const x = Number(commandArgs[0]);
			const y = Number(commandArgs[1]);
			if (!Number.isFinite(x) || !Number.isFinite(y)) {
				return buildResult('', 'mousemove requires x and y coordinates.\n', 1);
			}
			await pageState.page.mouse.move(x, y);
			if (this.shouldShowRecordingOverlay(session, pageState.id)) {
				await this.moveRecordingOverlayCursor(pageState.page, { x, y });
			}
		} else if (command === 'mousewheel') {
			const deltaX = Number(commandArgs[0]);
			const deltaY = Number(commandArgs[1]);
			if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
				return buildResult('', 'mousewheel requires deltaX and deltaY.\n', 1);
			}
			await pageState.page.mouse.wheel(deltaX, deltaY);
		} else {
			const button = commandArgs[0] === 'right' ? 'right' : 'left';
			const fallbackPoint = {
				x: (session.viewport?.width || DEFAULT_DEMO_VIEWPORT.width) / 2,
				y: (session.viewport?.height || DEFAULT_DEMO_VIEWPORT.height) / 2,
			};
			if (command === 'mousedown') {
				await pageState.page.mouse.down({ button });
				if (this.shouldShowRecordingOverlay(session, pageState.id)) {
					await this.moveRecordingOverlayCursor(pageState.page, fallbackPoint, true);
				}
			} else {
				await pageState.page.mouse.up({ button });
				if (this.shouldShowRecordingOverlay(session, pageState.id)) {
					await this.moveRecordingOverlayCursor(pageState.page, fallbackPoint, false);
					await this.triggerRecordingOverlayClick(pageState.page, fallbackPoint);
				}
			}
		}
		return buildResult(`${command}\n`);
	}

	private commandConsole(
		session: SessionState,
		commandArgs: string[]
	): BrowserBrokerExecuteResponse {
		const pageState = this.getActivePageState(session);
		const filterType = commandArgs[0];
		const lines = pageState.consoleEntries
			.filter((entry) => !filterType || entry.type === filterType)
			.map((entry) => `[${entry.type}] ${entry.text}`);
		return buildResult(`${(lines.length ? lines : ['No console entries recorded.']).join('\n')}\n`);
	}

	private commandNetwork(session: SessionState): BrowserBrokerExecuteResponse {
		const pageState = this.getActivePageState(session);
		const lines = pageState.networkEntries.map(
			(entry) => `${entry.status} ${entry.method} ${entry.url}`
		);
		return buildResult(
			`${(lines.length ? lines : ['No network activity recorded.']).join('\n')}\n`
		);
	}

	private async commandTracing(
		session: SessionState,
		command: 'tracing-start' | 'tracing-stop',
		commandArgs: string[],
		cwd: string
	): Promise<BrowserBrokerExecuteResponse> {
		if (command === 'tracing-start') {
			await session.context.tracing.start({ screenshots: true, snapshots: true });
			return buildResult('Tracing started.\n');
		}
		const { value: filename } = extractOptionValue(commandArgs, '--filename');
		const outputPath = resolveArtifactPath(cwd, filename, 'zip');
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await session.context.tracing.stop({ path: outputPath });
		return buildResult(`${outputPath}\n`);
	}

	private async commandVideoStart(session: SessionState): Promise<BrowserBrokerExecuteResponse> {
		const pageState = this.getActivePageState(session);
		session.activeVideoPageId = pageState.id;
		await this.setRecordingOverlayEnabled(pageState.page, true);
		await this.setRecordingOverlayFocus(pageState.page, null);
		return buildResult(`Recording video for ${pageState.page.url() || 'about:blank'}\n`);
	}

	private async commandVideoStop(
		session: SessionState,
		commandArgs: string[],
		cwd: string
	): Promise<BrowserBrokerExecuteResponse> {
		const pageId = session.activeVideoPageId || session.activePageId;
		if (!pageId) {
			return buildResult('', 'No video recording session is active.\n', 1);
		}
		const pageState = session.pageStates.get(pageId);
		if (!pageState) {
			return buildResult('', 'The active video tab is no longer available.\n', 1);
		}
		const { value: filename } = extractOptionValue(commandArgs, '--filename');
		const outputPath = resolveArtifactPath(cwd, filename, 'webm');
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		const page = pageState.page;
		const video = page.video();
		if (!video) {
			return buildResult('', 'Video capture is unavailable for the active page.\n', 1);
		}
		await this.setRecordingOverlayEnabled(page, false);
		await page.close();
		await video.saveAs(outputPath);
		session.activeVideoPageId = null;
		return buildResult(`${outputPath}\n`);
	}
}
