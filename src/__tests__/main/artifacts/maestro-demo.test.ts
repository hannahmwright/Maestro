import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAESTRO_DEMO_EVENT_PREFIX } from '../../../shared/demo-artifacts';
import {
	evaluateCompletionState,
	extractPlaywrightEvalValue,
	runCli,
} from '../../../main/artifacts/maestro-demo';

describe('maestro-demo CLI', () => {
	let tempDir: string;
	let contextFilePath: string;
	let stateFilePath: string;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;
	let originalContextFile: string | undefined;
	let originalPwcli: string | undefined;

	const baseContext = () => ({
		version: 1,
		enabled: true,
		sessionId: 'session-1',
		tabId: 'tab-1',
		captureRunId: 'capture-1',
		externalRunId: 'run-1',
		turnId: 'turn-1',
		turnToken: 'token-1',
		provider: 'claude-code',
		model: 'default',
		requestedTarget: {
			url: 'https://example.com',
			domain: 'example.com',
		},
		stateFilePath,
		outputDir: tempDir,
	});

	async function writePwcliStub(): Promise<string> {
		const stubPath = path.join(tempDir, 'pwcli-stub.sh');
		await fs.writeFile(
			stubPath,
			`#!/bin/sh
cmd="$1"
shift
filename=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		--filename)
			filename="$2"
			shift 2
			;;
		*)
			shift
			;;
	esac
done

case "$cmd" in
	video-start)
		exit 0
		;;
	screenshot|video-stop)
		mkdir -p "$(dirname "$filename")"
		printf 'artifact' > "$filename"
		exit 0
		;;
	*)
		exit 1
		;;
esac
`,
			'utf8'
		);
		await fs.chmod(stubPath, 0o755);
		process.env.PWCLI = stubPath;
		return stubPath;
	}

	async function writeContext(overrides: Record<string, unknown> = {}): Promise<void> {
		await fs.writeFile(
			contextFilePath,
			JSON.stringify(
				{
					...baseContext(),
					...overrides,
				},
				null,
				2
			),
			'utf8'
		);
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-demo-cli-'));
		contextFilePath = path.join(tempDir, 'context.json');
		stateFilePath = path.join(tempDir, 'state.json');
		await writeContext();

		originalContextFile = process.env.MAESTRO_DEMO_CONTEXT_FILE;
		originalPwcli = process.env.PWCLI;
		process.env.MAESTRO_DEMO_CONTEXT_FILE = contextFilePath;
		delete process.env.PWCLI;

		stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	});

	afterEach(async () => {
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();

		if (originalContextFile === undefined) {
			delete process.env.MAESTRO_DEMO_CONTEXT_FILE;
		} else {
			process.env.MAESTRO_DEMO_CONTEXT_FILE = originalContextFile;
		}

		if (originalPwcli === undefined) {
			delete process.env.PWCLI;
		} else {
			process.env.PWCLI = originalPwcli;
		}

		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it('rejects completion without artifacts', () => {
		const evaluation = evaluateCompletionState(
			baseContext() as any,
			{
				version: 1,
				started: true,
				artifactCount: 0,
				imageCount: 0,
				videoCount: 0,
				lastObservedUrl: null,
				lastObservedTitle: null,
			} as any,
			{}
		);

		expect(evaluation.ok).toBe(false);
		expect(evaluation.failureReason).toBe('missing_artifacts');
	});

	it('extracts raw values from Playwright eval output wrappers', () => {
		expect(
			extractPlaywrightEvalValue(
				`### Result
"https://example.com/"
### Ran Playwright code
\`\`\`js
await page.evaluate('() => (location.href)');
\`\`\``
			)
		).toBe('https://example.com/');
		expect(extractPlaywrightEvalValue('### Result\n"Example Domain"\n')).toBe('Example Domain');
	});

	it('rejects simulated local captures for a remote requested target', () => {
		const evaluation = evaluateCompletionState(
			baseContext() as any,
			{
				version: 1,
				started: true,
				artifactCount: 1,
				imageCount: 1,
				videoCount: 0,
				lastObservedUrl: 'http://127.0.0.1:3000/mock',
				lastObservedTitle: 'Local Mock',
			} as any,
			{}
		);

		expect(evaluation.ok).toBe(false);
		expect(evaluation.failureReason).toBe('simulated_capture');
	});

	it('rejects captures from the wrong target domain', () => {
		const evaluation = evaluateCompletionState(
			baseContext() as any,
			{
				version: 1,
				started: true,
				artifactCount: 1,
				imageCount: 1,
				videoCount: 0,
				lastObservedUrl: 'https://wrong.example.org',
				lastObservedTitle: 'Wrong Site',
			} as any,
			{}
		);

		expect(evaluation.ok).toBe(false);
		expect(evaluation.failureReason).toBe('wrong_target');
	});

	it('rejects auth-blocked captures when the target content was not reached', () => {
		const evaluation = evaluateCompletionState(
			baseContext() as any,
			{
				version: 1,
				started: true,
				artifactCount: 1,
				imageCount: 1,
				videoCount: 0,
				lastObservedUrl: 'https://example.com/login',
				lastObservedTitle: 'Sign in',
			} as any,
			{
				'auth-target-reached': 'false',
			}
		);

		expect(evaluation.ok).toBe(false);
		expect(evaluation.failureReason).toBe('auth_blocked');
	});

	it('accepts auth targets with trailing punctuation when the observed auth surface matches', () => {
		const evaluation = evaluateCompletionState(
			{
				...baseContext(),
				requestedTarget: {
					url: 'http://127.0.0.1:3001/sign-in,',
					domain: '127.0.0.1',
				},
			} as any,
			{
				version: 1,
				started: true,
				artifactCount: 2,
				imageCount: 1,
				videoCount: 1,
				lastObservedUrl: 'http://127.0.0.1:3001/sign-in',
				lastObservedTitle: 'Mind Loom',
			} as any,
			{}
		);

		expect(evaluation.ok).toBe(true);
		expect(evaluation.failureReason).toBeUndefined();
		expect(evaluation.authTargetReached).toBe(true);
	});

	it('emits a completed event after a verified artifact is attached', async () => {
		await writePwcliStub();

		expect(await runCli(['begin'])).toBe(0);
		expect(
			await runCli([
				'step',
				'--title',
				'Example Products',
				'--observed-url',
				'https://example.com/products',
				'--observed-title',
				'Example Products',
			])
		).toBe(0);
		expect(
			await runCli([
				'complete',
				'--summary',
				'Done.',
				'--observed-url',
				'https://example.com/products',
				'--observed-title',
				'Example Products',
			])
		).toBe(0);

		const stdout = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
		expect(stdout).toContain(MAESTRO_DEMO_EVENT_PREFIX);
		expect(stdout).toContain('"type":"capture_completed"');
		expect(stdout).toContain('"observedUrl":"https://example.com/products"');

		const savedState = JSON.parse(await fs.readFile(stateFilePath, 'utf8'));
		expect(savedState.artifactCount).toBe(2);
		expect(savedState.imageCount).toBe(1);
		expect(savedState.videoCount).toBe(1);
	});

	it('normalizes relative artifact paths before emitting demo events', async () => {
		await writePwcliStub();
		const originalCwd = process.cwd();
		const workspaceDir = path.join(tempDir, 'workspace');
		await fs.mkdir(workspaceDir, { recursive: true });
		await writeContext({ outputDir: 'output/playwright' });
		process.chdir(workspaceDir);

		try {
			expect(await runCli(['begin'])).toBe(0);
			expect(await runCli(['step', '--title', 'Relative path step'])).toBe(0);
		} finally {
			process.chdir(originalCwd);
		}

		const stdout = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
		const stepLine = stdout
			.split('\n')
			.find(
				(line) =>
					line.startsWith(MAESTRO_DEMO_EVENT_PREFIX) && line.includes('"type":"step_created"')
			);
		expect(stepLine).toBeTruthy();
		const stepEvent = JSON.parse(stepLine!.slice(MAESTRO_DEMO_EVENT_PREFIX.length).trim()) as {
			path?: string;
		};
		const workspaceRealpath = await fs.realpath(workspaceDir);
		expect(stepEvent.path).toBe(
			path.join(workspaceRealpath, 'output/playwright', '01-relative-path-step.png')
		);
	});

	it('fails complete with a non-zero exit when no artifacts were captured', async () => {
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
			throw new Error(`process.exit:${code ?? 0}`);
		}) as unknown as ReturnType<typeof vi.spyOn>;

		expect(await runCli(['begin'])).toBe(0);
		await expect(runCli(['complete'])).rejects.toThrow('process.exit:1');

		const stdout = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
		expect(stdout).toContain('"type":"capture_failed"');
		expect(stdout).toContain('"failureReason":"missing_artifacts"');
		expect(stderrSpy).toHaveBeenCalled();

		exitSpy.mockRestore();
	});
});
