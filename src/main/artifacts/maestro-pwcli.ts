#!/usr/bin/env node

import { MaestroPlaywrightDriver } from './MaestroPlaywrightDriver';

const AUTH_HEADER = 'x-maestro-browser-broker-token';

function collectForwardedEnv(): Record<string, string> {
	const forwarded: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value !== 'string') continue;
		if (
			key === 'PATH' ||
			key === 'HOME' ||
			key === 'CODEX_HOME' ||
			key === 'TMPDIR' ||
			key === 'TMP' ||
			key === 'TEMP' ||
			key.startsWith('PLAYWRIGHT_') ||
			key.startsWith('MAESTRO_')
		) {
			forwarded[key] = value;
		}
	}
	return forwarded;
}

function prepareLocalArgs(args: string[]): string[] {
	const hasConfigArg = args.some((arg) => arg === '--config' || arg.startsWith('--config='));
	const configPath = process.env.MAESTRO_PLAYWRIGHT_CONFIG_FILE;
	if (!hasConfigArg && typeof configPath === 'string' && configPath.trim()) {
		return ['--config', configPath, ...args];
	}
	return args;
}

async function runViaBroker(): Promise<number> {
	const brokerUrl = process.env.MAESTRO_BROWSER_BROKER_URL;
	const brokerToken = process.env.MAESTRO_BROWSER_BROKER_TOKEN;
	if (!brokerUrl || !brokerToken) {
		return -1;
	}

	const response = await fetch(`${brokerUrl}/execute`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			[AUTH_HEADER]: brokerToken,
		},
		body: JSON.stringify({
			args: process.argv.slice(2),
			cwd: process.cwd(),
			env: collectForwardedEnv(),
		}),
	});

	if (!response.ok) {
		process.stderr.write(`Browser broker request failed with status ${response.status}.\n`);
		return 1;
	}

	const payload = (await response.json()) as {
		exitCode?: number;
		stdout?: string;
		stderr?: string;
	};
	if (payload.stdout) {
		process.stdout.write(payload.stdout);
	}
	if (payload.stderr) {
		process.stderr.write(payload.stderr);
	}
	return typeof payload.exitCode === 'number' ? payload.exitCode : 1;
}

async function runLocally(): Promise<number> {
	const driver = new MaestroPlaywrightDriver();
	try {
		const result = await driver.execute({
			args: prepareLocalArgs(process.argv.slice(2)),
			cwd: process.cwd(),
			env: collectForwardedEnv(),
		});
		if (result.stdout) {
			process.stdout.write(result.stdout);
		}
		if (result.stderr) {
			process.stderr.write(result.stderr);
		}
		return result.exitCode;
	} finally {
		await driver.dispose();
	}
}

async function main(): Promise<number> {
	try {
		const brokerExitCode = await runViaBroker();
		if (brokerExitCode >= 0) {
			return brokerExitCode;
		}
		return await runLocally();
	} catch (error) {
		process.stderr.write(`maestro-pwcli failed: ${String(error)}\n`);
		return 1;
	}
}

void main().then((code) => {
	process.exit(code);
});
