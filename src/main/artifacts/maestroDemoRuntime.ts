import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import type { DemoBrowserMode, DemoRequestedTarget } from '../../shared/demo-artifacts';
import type { DemoTurnContextRecord } from './types';

const DEMO_RUNTIME_DIRNAME = 'demo-runtime';
const DEMO_RUNTIME_BIN_DIRNAME = 'bin';
const DEMO_RUNTIME_CONFIG_DIRNAME = 'configs';
const DEMO_CONTEXT_DIRNAME = 'contexts';
const DEMO_STATE_DIRNAME = 'states';
const DEMO_PROFILE_DIRNAME = 'profiles';
export const DEFAULT_DEMO_VIEWPORT = {
	width: 1280,
	height: 720,
} as const;

interface DemoRuntimePaths {
	runtimeDir: string;
	binDir: string;
	configDir: string;
	contextDir: string;
	stateDir: string;
	profilesDir: string;
}

export interface DemoProjectProfile {
	id: string;
	displayName: string;
	projectRoot: string | null;
	sessionName: string;
	profileDir: string;
	metadataPath: string;
	configPath: string;
}

function getElectronApp(): {
	getPath?: (name: string) => string;
	getAppPath?: () => string;
	isPackaged?: boolean;
} | null {
	try {
		const electron = require('electron') as {
			app?: {
				getPath?: (name: string) => string;
				getAppPath?: () => string;
				isPackaged?: boolean;
			};
		};
		return electron.app || null;
	} catch {
		return null;
	}
}

function sanitizePathSegment(value: string | null | undefined): string {
	const normalized = (value || 'default').trim();
	const safe = normalized.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
	return safe || 'default';
}

function resolveRuntimeBaseDir(projectRoot?: string | null): string {
	if (typeof projectRoot === 'string' && projectRoot.trim()) {
		return path.join(path.resolve(projectRoot), '.maestro');
	}
	const electronApp = getElectronApp();
	return typeof electronApp?.getPath === 'function'
		? electronApp.getPath('userData')
		: path.join(process.cwd(), '.maestro-test-userdata');
}

function getRuntimePaths(projectRoot?: string | null): DemoRuntimePaths {
	const runtimeDir = path.join(resolveRuntimeBaseDir(projectRoot), DEMO_RUNTIME_DIRNAME);
	return {
		runtimeDir,
		binDir: path.join(runtimeDir, DEMO_RUNTIME_BIN_DIRNAME),
		configDir: path.join(runtimeDir, DEMO_RUNTIME_CONFIG_DIRNAME),
		contextDir: path.join(runtimeDir, DEMO_CONTEXT_DIRNAME),
		stateDir: path.join(runtimeDir, DEMO_STATE_DIRNAME),
		profilesDir: path.join(runtimeDir, DEMO_PROFILE_DIRNAME),
	};
}

function resolveBundledDemoScriptPath(): string {
	const electronApp = getElectronApp();
	if (electronApp?.isPackaged) {
		return path.join(process.resourcesPath, 'maestro-demo.js');
	}
	const appPath =
		typeof electronApp?.getAppPath === 'function' ? electronApp.getAppPath() : process.cwd();
	return path.join(appPath, 'dist', 'main', 'artifacts', 'maestro-demo.js');
}

function resolveBundledPlaywrightClientPath(): string {
	const electronApp = getElectronApp();
	if (electronApp?.isPackaged) {
		return path.join(process.resourcesPath, 'maestro-pwcli.js');
	}
	const appPath =
		typeof electronApp?.getAppPath === 'function' ? electronApp.getAppPath() : process.cwd();
	return path.join(appPath, 'dist', 'main', 'artifacts', 'maestro-pwcli.js');
}

function buildUnixNodeWrapper(scriptPath: string): string {
	const runtimePath = process.execPath.replace(/"/g, '\\"');
	return `#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
exec "${runtimePath}" "${scriptPath.replace(/"/g, '\\"')}" "$@"
`;
}

function buildWindowsNodeWrapper(scriptPath: string): string {
	const runtimePath = process.execPath.replace(/"/g, '""');
	return `@echo off
set ELECTRON_RUN_AS_NODE=1
"${runtimePath}" "${scriptPath.replace(/"/g, '""')}" %*
`;
}

function resolvePreferredDemoBrowser(browserMode?: DemoBrowserMode): DemoBrowserMode {
	if (browserMode === 'chrome' || browserMode === 'standard') {
		return browserMode;
	}
	return process.env.MAESTRO_DEMO_BROWSER === 'chrome' ? 'chrome' : 'standard';
}

export function deriveDemoProjectProfileId(projectRoot: string | null | undefined): string {
	const normalizedProjectRoot =
		typeof projectRoot === 'string' && projectRoot.trim()
			? path.resolve(projectRoot)
			: 'default-project';
	const projectName =
		normalizedProjectRoot === 'default-project'
			? 'default-project'
			: sanitizePathSegment(path.basename(normalizedProjectRoot));
	const projectHash = createHash('sha1').update(normalizedProjectRoot).digest('hex').slice(0, 12);
	return `${projectName}-${projectHash}`;
}

export function buildDemoProjectProfile(
	projectRoot: string | null | undefined
): DemoProjectProfile {
	const normalizedProjectRoot =
		typeof projectRoot === 'string' && projectRoot.trim() ? path.resolve(projectRoot) : null;
	const profileId = deriveDemoProjectProfileId(normalizedProjectRoot);
	const runtimePaths = getRuntimePaths(normalizedProjectRoot);
	const profileDir = path.join(runtimePaths.profilesDir, profileId);
	return {
		id: profileId,
		displayName:
			normalizedProjectRoot === null
				? 'Default Project Profile'
				: path.basename(normalizedProjectRoot),
		projectRoot: normalizedProjectRoot,
		sessionName: profileId,
		profileDir,
		metadataPath: path.join(profileDir, 'profile.json'),
		configPath: path.join(profileDir, 'playwright-cli.json'),
	};
}

export function buildPlaywrightConfig(
	browserMode: DemoBrowserMode,
	_projectProfile?: Pick<DemoProjectProfile, 'sessionName' | 'displayName' | 'projectRoot'>
): string {
	const config: {
		browser: {
			launchOptions: Record<string, unknown>;
			contextOptions: Record<string, unknown>;
		};
	} = {
		browser: {
			launchOptions: {
				headless: true,
			},
			contextOptions: {
				viewport: DEFAULT_DEMO_VIEWPORT,
			},
		},
	};

	if (browserMode === 'chrome') {
		config.browser.launchOptions.channel = 'chrome';
	}

	return JSON.stringify(config, null, 2);
}

async function writeProjectProfileMetadata(
	projectProfile: DemoProjectProfile,
	browserMode: DemoBrowserMode
): Promise<void> {
	await fs.mkdir(projectProfile.profileDir, { recursive: true });
	await fs.writeFile(
		projectProfile.metadataPath,
		JSON.stringify(
			{
				version: 1,
				id: projectProfile.id,
				sessionName: projectProfile.sessionName,
				displayName: projectProfile.displayName,
				projectRoot: projectProfile.projectRoot,
				browserMode,
				lastUsedAt: Date.now(),
			},
			null,
			2
		),
		'utf8'
	);
}

export async function ensureMaestroDemoCommand(options?: {
	browserMode?: DemoBrowserMode;
	projectRoot?: string | null;
}): Promise<{
	binDir: string;
	commandName: string;
	playwrightCommandName: string;
	playwrightConfigPath: string;
	playwrightSessionName: string;
	projectProfileId: string;
	projectProfileDir: string;
	contextDir: string;
	stateDir: string;
	contextFilePath: string;
}> {
	const normalizedProjectRoot =
		typeof options?.projectRoot === 'string' && options.projectRoot.trim()
			? path.resolve(options.projectRoot)
			: null;
	const browserMode = resolvePreferredDemoBrowser(options?.browserMode);
	const projectProfile = buildDemoProjectProfile(normalizedProjectRoot);
	const paths = getRuntimePaths(normalizedProjectRoot);
	await fs.mkdir(paths.binDir, { recursive: true });
	await fs.mkdir(paths.configDir, { recursive: true });
	await fs.mkdir(paths.contextDir, { recursive: true });
	await fs.mkdir(paths.stateDir, { recursive: true });
	await fs.mkdir(paths.profilesDir, { recursive: true });

	const scriptPath = resolveBundledDemoScriptPath();
	const playwrightClientPath = resolveBundledPlaywrightClientPath();
	const playwrightConfigPath = projectProfile.configPath;
	await writeProjectProfileMetadata(projectProfile, browserMode);
	await fs.writeFile(
		playwrightConfigPath,
		buildPlaywrightConfig(browserMode, projectProfile),
		'utf8'
	);
	if (process.platform === 'win32') {
		const wrapperPath = path.join(paths.binDir, 'maestro-demo.cmd');
		await fs.writeFile(wrapperPath, buildWindowsNodeWrapper(scriptPath), 'utf8');
		const playwrightWrapperPath = path.join(paths.binDir, 'maestro-pwcli.cmd');
		await fs.writeFile(
			playwrightWrapperPath,
			buildWindowsNodeWrapper(playwrightClientPath),
			'utf8'
		);
		return {
			binDir: paths.binDir,
			commandName: 'maestro-demo',
			playwrightCommandName: 'maestro-pwcli',
			playwrightConfigPath,
			playwrightSessionName: projectProfile.sessionName,
			projectProfileId: projectProfile.id,
			projectProfileDir: projectProfile.profileDir,
			contextDir: paths.contextDir,
			stateDir: paths.stateDir,
			contextFilePath: '',
		};
	}

	const wrapperPath = path.join(paths.binDir, 'maestro-demo');
	await fs.writeFile(wrapperPath, buildUnixNodeWrapper(scriptPath), 'utf8');
	await fs.chmod(wrapperPath, 0o755);
	const playwrightWrapperPath = path.join(paths.binDir, 'maestro-pwcli');
	await fs.writeFile(playwrightWrapperPath, buildUnixNodeWrapper(playwrightClientPath), 'utf8');
	await fs.chmod(playwrightWrapperPath, 0o755);
	return {
		binDir: paths.binDir,
		commandName: 'maestro-demo',
		playwrightCommandName: 'maestro-pwcli',
		playwrightConfigPath,
		playwrightSessionName: projectProfile.sessionName,
		projectProfileId: projectProfile.id,
		projectProfileDir: projectProfile.profileDir,
		contextDir: paths.contextDir,
		stateDir: paths.stateDir,
		contextFilePath: '',
	};
}

export function buildDemoContextFilePath(
	sessionId: string,
	tabId?: string | null,
	projectRoot?: string | null
): {
	contextFilePath: string;
	stateFilePath: string;
} {
	const paths = getRuntimePaths(projectRoot);
	const key = `${sanitizePathSegment(sessionId)}__${sanitizePathSegment(tabId)}`;
	return {
		contextFilePath: path.join(paths.contextDir, `${key}.json`),
		stateFilePath: path.join(paths.stateDir, `${key}.json`),
	};
}

export async function writeDemoTurnContextFile(context: DemoTurnContextRecord): Promise<void> {
	await fs.mkdir(path.dirname(context.contextFilePath), { recursive: true });
	await fs.mkdir(path.dirname(context.stateFilePath), { recursive: true });
	await fs.writeFile(
		context.contextFilePath,
		JSON.stringify(
			{
				version: 1,
				enabled: true,
				sessionId: context.sessionId,
				tabId: context.tabId,
				captureRunId: context.captureRunId,
				externalRunId: context.externalRunId,
				turnId: context.turnId,
				turnToken: context.turnToken,
				provider: context.provider,
				model: context.model,
				requestedTarget: context.requestedTarget,
				stateFilePath: context.stateFilePath,
				outputDir: context.outputDir,
			},
			null,
			2
		),
		'utf8'
	);
}

export function prependPathEntry(existingPath: string | undefined, entry: string): string {
	if (!existingPath || !existingPath.trim()) {
		return entry;
	}
	const segments = existingPath.split(path.delimiter);
	if (segments.includes(entry)) {
		return existingPath;
	}
	return `${entry}${path.delimiter}${existingPath}`;
}

function normalizeDomain(value: string | null | undefined): string | null {
	if (!value || !value.trim()) {
		return null;
	}
	try {
		return new URL(value).hostname.toLowerCase();
	} catch {
		const normalized = value
			.trim()
			.toLowerCase()
			.replace(/^https?:\/\//, '')
			.replace(/\/.*$/, '');
		return normalized || null;
	}
}

export function extractRequestedTarget(prompt?: string): DemoRequestedTarget | null {
	if (!prompt || !prompt.trim()) {
		return null;
	}

	const urlMatch = prompt.match(/https?:\/\/[^\s)>"']+/i);
	if (urlMatch) {
		const url = urlMatch[0];
		return {
			url,
			domain: normalizeDomain(url),
		};
	}

	const domainMatch = prompt.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i);
	if (!domainMatch) {
		return null;
	}

	const domain = normalizeDomain(domainMatch[0]);
	if (!domain) {
		return null;
	}

	return {
		url: null,
		domain,
		description: domainMatch[0],
	};
}
