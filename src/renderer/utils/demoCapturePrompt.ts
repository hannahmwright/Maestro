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
- \`MAESTRO_DEMO_CONTEXT_FILE\`
- \`MAESTRO_DEMO_OUTPUT_DIR\`

Required behavior:
- If the task can be meaningfully demonstrated in a browser or browser-like dev session, you must use browser automation and produce demo artifacts for this run.
- Requests about UI behavior, browser flows, screenshots, recordings, demos, or proof that something worked are demoable and require artifacts.
- If the task cannot be meaningfully demonstrated that way, you must explicitly say that in the response and explain why no browser demo was produced.
- If capture starts and the workflow later fails, you must mark it failed with \`maestro-demo fail\`.
- If you exit a demoable workflow without a successful \`maestro-demo complete\`, Maestro will treat the run as failed.
- A successful demo capture must include at least one screenshot or video artifact. If video recording is unavailable, capture screenshots instead.
- Do not claim that a demo card exists unless \`maestro-demo complete\` exited successfully.

If you use Playwright or any browser automation in this run, you must use the bundled Maestro demo runtime and save artifacts for playback:

1. Start the demo run before the workflow:
   \`\`\`bash
   maestro-demo begin --title "<short demo title>" --summary "<one sentence summary>"
   \`\`\`
2. For key checkpoints, save a screenshot/video file first, then attach it:
   \`\`\`bash
   maestro-demo step --title "<step title>" --description "<what changed>" --path output/playwright/<step-name>.png --filename <step-name>.png
   maestro-demo attach-video --path output/playwright/<demo-name>.webm --filename <demo-name>.webm
   \`\`\`
3. Finish and verify the run:
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
- Only attach files that actually exist.
- Use human-readable step titles.
- Save demo screenshots and videos under \`output/playwright/\`.
- Treat \`maestro-demo complete\` as the proof boundary. If it fails, the demo failed.
- If you intentionally used a mock, reproduction, alternate domain, or unauthenticated page, mark the run as failed instead of presenting it as success.
- Never present raw local file paths or local-file URLs such as \`output/playwright/*.webm\`, \`file://...\`, or \`/Users/.../output/playwright/...\` as user-facing links.
- When a demo was captured successfully, reference the Maestro demo result/card rather than the underlying local artifact path.
- If remote playback or sharing is not available for a recorded file, explicitly say that remote playback is unsupported instead of pasting a local path.
- Do not silently skip demo capture on this run if the workflow is demoable.`;
}
