export function appendDemoCaptureInstructions(prompt: string, enabled?: boolean): string {
	if (!enabled) {
		return prompt;
	}

	const trimmedPrompt = prompt.trim();
	const basePrompt = trimmedPrompt.length > 0 ? trimmedPrompt : 'Demonstrate the requested workflow.';

	return `${basePrompt}

---

# Demo Capture Enabled

This run has Maestro demo capture enabled because the user explicitly requested a demo or screenshots for this run.
Treat demo capture as a hard requirement for this run when the task can be demonstrated in a browser or browser-like dev session.

Environment provided for this process:
- \`MAESTRO_DEMO_CAPTURE=1\`
- \`MAESTRO_DEMO_EVENT_PREFIX\`
- \`MAESTRO_DEMO_RUN_ID\`

Required behavior:
- If the task can be meaningfully demonstrated in a browser or browser-like dev session, you must use Playwright/browser automation and produce demo artifacts for this run.
- If the task cannot be meaningfully demonstrated that way, you must explicitly say that in the response and explain why no browser demo was produced.
- If capture starts and the workflow later fails, emit a failure event.

If you use Playwright or any browser automation in this run, you must emit Maestro demo events and save artifacts for playback:

1. Set up the Playwright helpers:
   \`\`\`bash
   export CODEX_HOME="\${CODEX_HOME:-$HOME/.codex}"
   export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"
   export PWMAESTRO="$CODEX_HOME/skills/playwright/scripts/maestro_playwright_demo.sh"
   export PLAYWRIGHT_CLI_SESSION="<short-session-name>"
   \`\`\`
2. Start the capture before the workflow:
   \`\`\`bash
   "$PWMAESTRO" start --title "<short demo title>" --summary "<one sentence summary>"
   "$PWMAESTRO" video-start
   \`\`\`
3. For key checkpoints, save named screenshots and emit step events:
   \`\`\`bash
   "$PWMAESTRO" screenshot-step --title "<step title>" --description "<what changed>" --filename output/playwright/<step-name>.png
   \`\`\`
4. Finish the recording and finalize the demo:
   \`\`\`bash
   "$PWMAESTRO" video-stop --filename output/playwright/<demo-name>.webm
   "$PWMAESTRO" complete --title "<short demo title>" --summary "<one sentence summary>"
   \`\`\`
5. If the workflow fails after capture starts, emit:
   \`\`\`bash
   "$PWMAESTRO" fail --summary "<brief failure summary>"
   \`\`\`

Rules:
- Only emit events for files that actually exist.
- Use human-readable step titles.
- Save demo screenshots and videos under \`output/playwright/\`.
- Prefer the Maestro Playwright helper for demo artifacts over ad hoc screenshot/video commands.
- Do not silently skip demo capture on this run if the workflow is demoable.`;
}
