import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const codeHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const helperPath = path.join(codeHome, 'skills/playwright/scripts/maestro_playwright_demo.sh');
const eventHelperPath = path.join(codeHome, 'skills/playwright/scripts/maestro_demo_event.sh');

const describeIfHelpersAvailable = describe.skipIf(
	!existsSync(helperPath) || !existsSync(eventHelperPath)
);

describeIfHelpersAvailable('Maestro Playwright demo helper scripts', () => {
	let tempDir: string;
	let fakePwcliPath: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-playwright-helper-'));
		fakePwcliPath = path.join(tempDir, 'fake-pwcli.sh');
		await fs.writeFile(
			fakePwcliPath,
			`#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
shift || true
case "$cmd" in
	screenshot)
		filename=""
		while (($#)); do
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
		mkdir -p "$(dirname "$filename")"
		printf 'png' > "$filename"
		echo "### Result"
		echo "- [Screenshot of viewport]($filename)"
		;;
	video-start)
		echo "Video recording started."
		;;
	video-stop)
		filename=""
		while (($#)); do
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
		mkdir -p "$(dirname "$filename")"
		printf 'webm' > "$filename"
		echo "### Result"
		echo "- [Video]($filename)"
		;;
	*)
		echo "noop $cmd"
		;;
esac
`
		);
		await fs.chmod(fakePwcliPath, 0o755);
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it('emits capture_started and step_created for screenshot-step', async () => {
		const outputDir = path.join(tempDir, 'output');
		const { stdout } = await execFileAsync(
			helperPath,
			[
				'screenshot-step',
				'--title',
				'Loaded dashboard',
				'--description',
				'Dashboard rendered',
				'--filename',
				path.join(outputDir, 'step-1.png'),
			],
			{
				env: {
					...process.env,
					PWCLI: fakePwcliPath,
					MAESTRO_DEMO_CAPTURE: '1',
					MAESTRO_DEMO_EVENT_PREFIX: '__MAESTRO_DEMO_EVENT__',
					MAESTRO_DEMO_RUN_ID: 'script-run-1',
					MAESTRO_DEMO_OUTPUT_DIR: outputDir,
				},
			}
		);

		expect(stdout).toContain('"type":"capture_started"');
		expect(stdout).toContain('"runId":"script-run-1"');
		expect(stdout).toContain('"type":"step_created"');
		expect(stdout).toContain('"title":"Loaded dashboard"');
	});

	it('emits artifact_created and capture_completed for video-stop plus complete', async () => {
		const outputDir = path.join(tempDir, 'output');
		const videoFile = path.join(outputDir, 'demo.webm');
		const videoResult = await execFileAsync(helperPath, ['video-stop', '--filename', videoFile], {
			env: {
				...process.env,
				PWCLI: fakePwcliPath,
				MAESTRO_DEMO_CAPTURE: '1',
				MAESTRO_DEMO_EVENT_PREFIX: '__MAESTRO_DEMO_EVENT__',
				MAESTRO_DEMO_RUN_ID: 'script-run-2',
				MAESTRO_DEMO_OUTPUT_DIR: outputDir,
			},
		});
		const completeResult = await execFileAsync(
			helperPath,
			['complete', '--title', 'Demo', '--summary', 'Summary'],
			{
				env: {
					...process.env,
					PWCLI: fakePwcliPath,
					MAESTRO_DEMO_CAPTURE: '1',
					MAESTRO_DEMO_EVENT_PREFIX: '__MAESTRO_DEMO_EVENT__',
					MAESTRO_DEMO_RUN_ID: 'script-run-2',
					MAESTRO_DEMO_OUTPUT_DIR: outputDir,
				},
			}
		);

		expect(videoResult.stdout).toContain('"type":"artifact_created"');
		expect(videoResult.stdout).toContain('"role":"video"');
		expect(completeResult.stdout).toContain('"type":"capture_completed"');
		expect(completeResult.stdout).toContain('"runId":"script-run-2"');
	});

	it('keeps run state isolated across different run ids', async () => {
		const outputDir = path.join(tempDir, 'output');
		const runAPath = path.join(outputDir, 'a.png');
		const runBPath = path.join(outputDir, 'b.png');
		await fs.mkdir(outputDir, { recursive: true });
		await fs.writeFile(runAPath, 'a');
		await fs.writeFile(runBPath, 'b');

		await execFileAsync(eventHelperPath, ['start', '--run-id', 'run-a', '--title', 'Run A'], {
			env: {
				...process.env,
				MAESTRO_DEMO_CAPTURE: '1',
				MAESTRO_DEMO_EVENT_PREFIX: '__MAESTRO_DEMO_EVENT__',
				MAESTRO_DEMO_RUN_ID: 'run-a',
				MAESTRO_DEMO_OUTPUT_DIR: outputDir,
			},
		});
		await execFileAsync(eventHelperPath, ['start', '--run-id', 'run-b', '--title', 'Run B'], {
			env: {
				...process.env,
				MAESTRO_DEMO_CAPTURE: '1',
				MAESTRO_DEMO_EVENT_PREFIX: '__MAESTRO_DEMO_EVENT__',
				MAESTRO_DEMO_RUN_ID: 'run-b',
				MAESTRO_DEMO_OUTPUT_DIR: outputDir,
			},
		});

		const stepA = await execFileAsync(
			eventHelperPath,
			['step', '--run-id', 'run-a', '--title', 'Step A', '--path', runAPath],
			{
				env: {
					...process.env,
					MAESTRO_DEMO_CAPTURE: '1',
					MAESTRO_DEMO_EVENT_PREFIX: '__MAESTRO_DEMO_EVENT__',
					MAESTRO_DEMO_RUN_ID: 'run-a',
					MAESTRO_DEMO_OUTPUT_DIR: outputDir,
				},
			}
		);
		const stepB = await execFileAsync(
			eventHelperPath,
			['step', '--run-id', 'run-b', '--title', 'Step B', '--path', runBPath],
			{
				env: {
					...process.env,
					MAESTRO_DEMO_CAPTURE: '1',
					MAESTRO_DEMO_EVENT_PREFIX: '__MAESTRO_DEMO_EVENT__',
					MAESTRO_DEMO_RUN_ID: 'run-b',
					MAESTRO_DEMO_OUTPUT_DIR: outputDir,
				},
			}
		);

		expect(stepA.stdout).toContain('"runId":"run-a"');
		expect(stepA.stdout).not.toContain('"runId":"run-b"');
		expect(stepB.stdout).toContain('"runId":"run-b"');
		expect(stepB.stdout).not.toContain('"runId":"run-a"');
	});
});
