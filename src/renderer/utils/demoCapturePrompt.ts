export function appendDemoCaptureInstructions(prompt: string, enabled?: boolean): string {
	if (!enabled) {
		return prompt;
	}

	const trimmedPrompt = prompt.trim();
	const basePrompt =
		trimmedPrompt.length > 0 ? trimmedPrompt : 'Demonstrate the requested workflow.';

	return `${basePrompt}

---

# Demo Capture Enabled

This run has Maestro demo capture enabled because the user explicitly requested a demo or screenshots for this run.
Treat demo capture as a hard requirement for this run when the task can be demonstrated in a browser or browser-like dev session.

	Environment provided for this process:
	- \`MAESTRO_DEMO_CAPTURE=1\`
	- \`MAESTRO_DEMO_BIN=maestro-demo\`
	- \`PWCLI\` (Maestro-provided browser wrapper)
	- \`MAESTRO_PLAYWRIGHT_CONFIG_FILE\`
	- \`MAESTRO_DEMO_BROWSER\`
	- \`PLAYWRIGHT_CLI_SESSION\` (project-scoped browser session)
	- \`MAESTRO_DEMO_PROJECT_PROFILE\`
	- \`MAESTRO_DEMO_CONTEXT_FILE\`
	- \`MAESTRO_DEMO_OUTPUT_DIR\`

Required behavior:
- If the task can be meaningfully demonstrated in a browser or browser-like dev session, you must use browser automation and produce demo artifacts for this run.
- Requests about UI behavior, browser flows, screenshots, recordings, demos, or proof that something worked are demoable and require artifacts.
- If the task cannot be meaningfully demonstrated that way, you must explicitly say that in the response and explain why no browser demo was produced.
- If capture starts and the workflow later fails, you must mark it failed with \`maestro-demo fail\`.
- If you exit a demoable workflow without a successful \`maestro-demo complete\`, Maestro will treat the run as failed.
- A successful demo capture must include at least one screenshot step or the automatic video recorded by Maestro.
- Do not claim that a demo card exists unless \`maestro-demo complete\` exited successfully.
- Do not manage screenshot paths or video paths yourself.
- Do not use \`maestro-demo attach-image\`, \`maestro-demo attach-video\`, raw \`__MAESTRO_DEMO_EVENT__\` lines, or legacy helper scripts.
- Legacy helper/demo-protocol output does not satisfy this run and will be rejected.

	If you use Playwright or any browser automation in this run, you must use the provided \`$PWCLI\` wrapper plus the bundled Maestro demo runtime:

	1. Start the demo run before the workflow:
	   \`\`\`bash
	   maestro-demo start --title "<short demo title>" --summary "<one sentence summary>"
	   \`\`\`
	2. Drive the real UI with \`$PWCLI\`, and mark meaningful proof steps as they happen:
	   \`\`\`bash
	   "$PWCLI" open <url>
	   "$PWCLI" snapshot
	   maestro-demo step --title "<step title>" --description "<what changed>"
	   \`\`\`
	   Maestro will capture the screenshot and manage the recording automatically. Prefer the default headless/background browser flow unless you have a specific reason to request a visible browser window.
3. Finish and verify the run after the workflow succeeds:
   \`\`\`bash
   maestro-demo complete --title "<short demo title>" --summary "<one sentence summary>"
   \`\`\`
4. If the workflow is blocked on auth, approval, or user input, emit a blocked state:
   \`\`\`bash
   maestro-demo blocked --summary "<brief explanation of what blocked capture>"
   \`\`\`
5. If the workflow fails after capture starts, emit:
   \`\`\`bash
   maestro-demo fail --summary "<brief failure summary>"
   \`\`\`

Rules:
- Use human-readable step titles.
	- When \`MAESTRO_DEMO_BROWSER=chrome\`, prefer the provided \`$PWCLI\` wrapper so Maestro can steer browser automation toward Chrome-backed launches for auth-sensitive flows.
	- Maestro provides a project-scoped browser session/profile automatically. Reuse it for sign-in state across runs and do not clear it unless the user explicitly asks.
	- Do not prefix commands with \`MAESTRO_DEMO_CAPTURE=0\` or otherwise disable the provided Maestro demo runtime on this run.
	- Treat \`maestro-demo complete\` as the proof boundary. If it fails, the demo failed.
- If you intentionally used a mock, reproduction, alternate domain, or unauthenticated page, mark the run as failed instead of presenting it as success.
- Never present raw local file paths or local-file URLs such as \`output/playwright/*.webm\`, \`file://...\`, or \`/Users/.../output/playwright/...\` as user-facing links.
- When a demo was captured successfully, reference the Maestro demo result/card rather than the underlying local artifact path.
- If remote playback or sharing is not available for a recorded file, explicitly say that remote playback is unsupported instead of pasting a local path.
- Do not silently skip demo capture on this run if the workflow is demoable.`;
}
