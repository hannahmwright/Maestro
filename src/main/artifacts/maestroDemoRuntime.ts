import * as fs from 'fs/promises';
import * as path from 'path';
import type { DemoRequestedTarget } from '../../shared/demo-artifacts';
import type { DemoTurnContextRecord } from './types';

const DEMO_RUNTIME_DIRNAME = 'demo-runtime';
const DEMO_RUNTIME_BIN_DIRNAME = 'bin';
const DEMO_CONTEXT_DIRNAME = 'contexts';
const DEMO_STATE_DIRNAME = 'states';

interface DemoRuntimePaths {
	runtimeDir: string;
	binDir: string;
	contextDir: string;
	stateDir: string;
}

function getElectronApp():
	| {
			getPath?: (name: string) => string;
			getAppPath?: () => string;
			isPackaged?: boolean;
	  }
	| null {
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

function getRuntimePaths(): DemoRuntimePaths {
	const electronApp = getElectronApp();
	const userDataPath =
		typeof electronApp?.getPath === 'function'
			? electronApp.getPath('userData')
			: path.join(process.cwd(), '.maestro-test-userdata');
	const runtimeDir = path.join(userDataPath, DEMO_RUNTIME_DIRNAME);
	return {
		runtimeDir,
		binDir: path.join(runtimeDir, DEMO_RUNTIME_BIN_DIRNAME),
		contextDir: path.join(runtimeDir, DEMO_CONTEXT_DIRNAME),
		stateDir: path.join(runtimeDir, DEMO_STATE_DIRNAME),
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

function buildUnixWrapper(scriptPath: string): string {
	return `#!/bin/sh
exec node "${scriptPath.replace(/"/g, '\\"')}" "$@"
`;
}

function buildWindowsWrapper(scriptPath: string): string {
	return `@echo off
node "${scriptPath.replace(/"/g, '""')}" %*
`;
}

export async function ensureMaestroDemoCommand(): Promise<{
	binDir: string;
	commandName: string;
	contextDir: string;
	stateDir: string;
	contextFilePath: string;
}> {
	const paths = getRuntimePaths();
	await fs.mkdir(paths.binDir, { recursive: true });
	await fs.mkdir(paths.contextDir, { recursive: true });
	await fs.mkdir(paths.stateDir, { recursive: true });

	const scriptPath = resolveBundledDemoScriptPath();
	if (process.platform === 'win32') {
		const wrapperPath = path.join(paths.binDir, 'maestro-demo.cmd');
		await fs.writeFile(wrapperPath, buildWindowsWrapper(scriptPath), 'utf8');
		return {
			binDir: paths.binDir,
			commandName: 'maestro-demo',
			contextDir: paths.contextDir,
			stateDir: paths.stateDir,
			contextFilePath: '',
		};
	}

	const wrapperPath = path.join(paths.binDir, 'maestro-demo');
	await fs.writeFile(wrapperPath, buildUnixWrapper(scriptPath), 'utf8');
	await fs.chmod(wrapperPath, 0o755);
	return {
		binDir: paths.binDir,
		commandName: 'maestro-demo',
		contextDir: paths.contextDir,
		stateDir: paths.stateDir,
		contextFilePath: '',
	};
}

export function buildDemoContextFilePath(sessionId: string, tabId?: string | null): {
	contextFilePath: string;
	stateFilePath: string;
} {
	const paths = getRuntimePaths();
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
