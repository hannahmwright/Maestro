import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SshRemoteConfig } from '../../shared/types';
import { execFileNoThrow } from './execFile';
import { logger } from './logger';
import { buildSshCommand, type RemoteCommandOptions } from './ssh-command-builder';
import { stripAnsi } from './stripAnsi';

const LOG_CONTEXT = '[CodexConfig]';
const SSH_MODEL_TIMEOUT_MS = 10000;

export function parseCodexModelFromToml(content: string): string | null {
	const modelMatch = content.match(/^\s*model\s*=\s*"([^"]+)"/m);
	return modelMatch?.[1]?.trim() || null;
}

export function readLocalCodexModel(): string | null {
	try {
		const configPath = path.join(os.homedir(), '.codex', 'config.toml');
		if (!fs.existsSync(configPath)) {
			return null;
		}
		const content = fs.readFileSync(configPath, 'utf8');
		return parseCodexModelFromToml(content);
	} catch (error) {
		logger.debug('Failed to read local Codex model from config.toml', LOG_CONTEXT, { error });
		return null;
	}
}

export async function readRemoteCodexModel(sshRemote: SshRemoteConfig): Promise<string | null> {
	const remoteOptions: RemoteCommandOptions = {
		command: 'sh',
		args: ['-lc', 'if [ -f ~/.codex/config.toml ]; then cat ~/.codex/config.toml; fi'],
	};

	try {
		const sshCommand = await buildSshCommand(sshRemote, remoteOptions);
		const resultPromise = execFileNoThrow(sshCommand.command, sshCommand.args);
		const timeoutPromise = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
			(_, reject) => {
				setTimeout(
					() => reject(new Error(`SSH connection timed out after ${SSH_MODEL_TIMEOUT_MS / 1000}s`)),
					SSH_MODEL_TIMEOUT_MS
				);
			}
		);
		const result = await Promise.race([resultPromise, timeoutPromise]);
		if (result.exitCode !== 0 || !result.stdout.trim()) {
			return null;
		}
		return parseCodexModelFromToml(stripAnsi(result.stdout));
	} catch (error) {
		logger.debug('Failed to read remote Codex model from config.toml', LOG_CONTEXT, {
			host: sshRemote.host,
			error,
		});
		return null;
	}
}
