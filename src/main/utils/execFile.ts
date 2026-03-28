import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

export interface ExecOptions {
	input?: string; // Content to write to stdin
	/** Timeout in milliseconds. If the process exceeds this, it is killed and an error is returned. */
	timeout?: number;
}

// Maximum buffer size for command output (10MB)
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;
const DEV_SPAWN_TRACE_WINDOW_MS = 1000;
const DEV_SPAWN_TRACE_THRESHOLD = 20;
const devSpawnTraceCounts = new Map<string, { count: number; timer: ReturnType<typeof setTimeout> }>();
const GIT_WORKTREE_PROBE_CACHE_TTL_MS = 5000;

interface ExecResultCacheEntry {
	value?: ExecResult;
	expiresAt: number;
	promise?: Promise<ExecResult>;
}

const gitWorktreeProbeCache = new Map<string, ExecResultCacheEntry>();

export interface ExecResult {
	stdout: string;
	stderr: string;
	/**
	 * The exit code of the process.
	 * - A number (0 for success, non-zero for failure) when the process ran and exited
	 * - A string error code ('ENOENT', 'EPERM', 'EACCES', etc.) when the process couldn't be spawned
	 */
	exitCode: number | string;
}

function traceDevExecCommand(command: string, args: string[], cwd?: string): void {
	if (process.env.NODE_ENV !== 'development') {
		return;
	}

	const key = `${command} ${args.join(' ')}`.trim();
	const existing = devSpawnTraceCounts.get(key);
	if (existing) {
		existing.count += 1;
		return;
	}

	const timer = setTimeout(() => {
		const snapshot = devSpawnTraceCounts.get(key);
		if (!snapshot) {
			return;
		}
		devSpawnTraceCounts.delete(key);
		if (snapshot.count < DEV_SPAWN_TRACE_THRESHOLD) {
			return;
		}

		logger.warn('[ExecFile] Hot command loop detected', '[ExecFile]', {
			command,
			args,
			cwd,
			count: snapshot.count,
			windowMs: DEV_SPAWN_TRACE_WINDOW_MS,
		});
	}, DEV_SPAWN_TRACE_WINDOW_MS);

	devSpawnTraceCounts.set(key, { count: 1, timer });
}

function shouldCacheExecResult(command: string, args: string[], cwd?: string): boolean {
	if (command !== 'git' || !cwd || args[0] !== 'rev-parse') {
		return false;
	}

	if (args.length === 2) {
		return [
			'--is-inside-work-tree',
			'--git-dir',
			'--git-common-dir',
			'--show-toplevel',
		].includes(args[1]);
	}

	return args.length === 3 && args[1] === '--abbrev-ref' && args[2] === 'HEAD';
}

function buildExecResultCacheKey(command: string, args: string[], cwd?: string): string {
	return `${command}::${cwd || ''}::${args.join('\u0000')}`;
}

/**
 * Determine if a command needs shell execution on Windows
 * - Batch files (.cmd, .bat) always need shell
 * - Commands without extensions normally need PATHEXT resolution via shell,
 *   BUT we avoid shell for known commands that have .exe variants (git, node, etc.)
 *   to prevent percent-sign escaping issues in arguments
 * - Executables (.exe, .com) can run directly
 */
export function needsWindowsShell(command: string): boolean {
	const lowerCommand = command.toLowerCase();

	// Batch files always need shell
	if (lowerCommand.endsWith('.cmd') || lowerCommand.endsWith('.bat')) {
		return true;
	}

	// Known executables don't need shell
	if (lowerCommand.endsWith('.exe') || lowerCommand.endsWith('.com')) {
		return false;
	}

	// Commands without extension: skip shell for known commands that have .exe variants
	// This prevents issues like % being interpreted as environment variables on Windows
	// Extract basename to handle full paths like 'C:\Program Files\Git\bin\git'
	// Use regex to handle both Unix (/) and Windows (\) path separators
	const knownExeCommands = new Set([
		'git',
		'node',
		'npm',
		'npx',
		'yarn',
		'pnpm',
		'python',
		'python3',
		'pip',
		'pip3',
	]);
	const commandBaseName = lowerCommand.split(/[\\/]/).pop() || lowerCommand;
	if (knownExeCommands.has(commandBaseName)) {
		return false;
	}

	// Other commands without extension still need shell for PATHEXT resolution
	const hasExtension = path.extname(command).length > 0;
	return !hasExtension;
}

/**
 * Safely execute a command without shell injection vulnerabilities
 * Uses execFile instead of exec to prevent shell interpretation
 *
 * On Windows, batch files and commands without extensions are handled
 * by enabling shell mode, since execFile cannot directly execute them.
 *
 * @param command - The command to execute
 * @param args - Arguments to pass to the command
 * @param cwd - Working directory for the command
 * @param options - Additional options (input for stdin, env for environment)
 */
export async function execFileNoThrow(
	command: string,
	args: string[] = [],
	cwd?: string,
	options?: ExecOptions | NodeJS.ProcessEnv
): Promise<ExecResult> {
	// Handle backward compatibility: options can be env (old signature) or ExecOptions (new)
	let env: NodeJS.ProcessEnv | undefined;
	let input: string | undefined;
	let timeout: number | undefined;

	if (options) {
		if ('input' in options || 'timeout' in options) {
			// New signature with ExecOptions
			const execOpts = options as ExecOptions;
			input = execOpts.input;
			timeout = execOpts.timeout;
		} else {
			// Old signature with just env
			env = options as NodeJS.ProcessEnv;
		}
	}

	// If input is provided, use spawn instead of execFile to write to stdin
	if (input !== undefined) {
		return execFileWithInput(command, args, cwd, input, timeout);
	}

	const shouldUseCache =
		!env && !timeout && shouldCacheExecResult(command, args, cwd);
	const cacheKey = shouldUseCache ? buildExecResultCacheKey(command, args, cwd) : null;
	if (cacheKey) {
		const now = Date.now();
		const existing = gitWorktreeProbeCache.get(cacheKey);
		if (existing) {
			if (existing.value && existing.expiresAt > now) {
				return existing.value;
			}
			if (existing.promise) {
				return existing.promise;
			}
		}
	}

	const execute = async (): Promise<ExecResult> => {
		try {
			traceDevExecCommand(command, args, cwd);
			// On Windows, some commands need shell execution
			// This is safe because we're executing a specific file path, not user input
			const isWindows = process.platform === 'win32';
			const useShell = isWindows && needsWindowsShell(command);

			const { stdout, stderr } = await execFileAsync(command, args, {
				cwd,
				env,
				encoding: 'utf8',
				maxBuffer: EXEC_MAX_BUFFER,
				shell: useShell,
				timeout,
			});

			return {
				stdout,
				stderr,
				exitCode: 0,
			};
		} catch (error: any) {
			// execFile throws on non-zero exit codes
			// Use ?? instead of || to correctly handle exit code 0 (which is falsy but valid)

			// When execFile kills a process due to timeout, error.killed is true and
			// error.code is undefined (process didn't exit normally). We surface this
			// as 'ETIMEDOUT' so callers (e.g., remote-fs retry logic) can detect it.
			// Note: maxBuffer kills also set error.killed, but those have
			// error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', so we exclude them.
			const isTimeout = timeout && error.killed && !error.code;

			return {
				stdout: error.stdout || '',
				stderr: isTimeout
					? `${error.stderr || ''}\nETIMEDOUT: process timed out after ${timeout}ms`
					: error.stderr || error.message || '',
				exitCode: isTimeout ? 'ETIMEDOUT' : (error.code ?? 1),
			};
		}
	};

	if (cacheKey) {
		const promise = execute()
			.then((result) => {
				gitWorktreeProbeCache.set(cacheKey, {
					value: result,
					expiresAt: Date.now() + GIT_WORKTREE_PROBE_CACHE_TTL_MS,
				});
				return result;
			})
			.catch((error) => {
				gitWorktreeProbeCache.delete(cacheKey);
				throw error;
			});
		gitWorktreeProbeCache.set(cacheKey, {
			expiresAt: Date.now() + GIT_WORKTREE_PROBE_CACHE_TTL_MS,
			promise,
		});
		return promise;
	}

	return execute();
}

/**
 * Execute a command with input written to stdin
 * Uses spawn to allow writing to the process stdin
 */
async function execFileWithInput(
	command: string,
	args: string[],
	cwd: string | undefined,
	input: string,
	timeout?: number
): Promise<ExecResult> {
	return new Promise((resolve) => {
		traceDevExecCommand(command, args, cwd);
		const isWindows = process.platform === 'win32';
		const useShell = isWindows && needsWindowsShell(command);

		const child = spawn(command, args, {
			cwd,
			shell: useShell,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';
		let killed = false;

		// spawn() doesn't support timeout natively, so implement it manually
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (timeout && timeout > 0) {
			timer = setTimeout(() => {
				killed = true;
				child.kill();
			}, timeout);
		}

		child.stdout?.on('data', (data) => {
			stdout += data.toString();
		});

		child.stderr?.on('data', (data) => {
			stderr += data.toString();
		});

		child.on('close', (code) => {
			if (timer) clearTimeout(timer);
			resolve({
				stdout,
				stderr: killed ? `${stderr}\nETIMEDOUT: process timed out after ${timeout}ms` : stderr,
				exitCode: killed ? 'ETIMEDOUT' : (code ?? 1),
			});
		});

		child.on('error', (err) => {
			if (timer) clearTimeout(timer);
			resolve({
				stdout: '',
				stderr: err.message,
				exitCode: 1,
			});
		});

		// Write input to stdin and close it
		if (child.stdin) {
			child.stdin.write(input);
			child.stdin.end();
		}
	});
}
