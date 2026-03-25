import type { ConductorTask, Session } from '../types';

export function buildConductorProofPrompt(
	groupName: string,
	templateSession: Session,
	task: ConductorTask
): string {
	const acceptanceCriteria =
		task.acceptanceCriteria.length > 0
			? task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')
			: '- No explicit acceptance criteria provided.';
	const scopeLines =
		task.scopePaths.length > 0
			? task.scopePaths.map((path) => `- ${path}`).join('\n')
			: '- Scope unknown; use the narrowest relevant workflow.';
	const changedPaths =
		task.changedPaths && task.changedPaths.length > 0
			? task.changedPaths.map((path) => `- ${path}`).join('\n')
			: '- Changed paths were not reported.';
	const proofRequirement = task.completionProofRequirement;
	const screenshotRequirement =
		proofRequirement?.minScreenshots && proofRequirement.minScreenshots > 0
			? `${proofRequirement.minScreenshots} screenshot${proofRequirement.minScreenshots === 1 ? '' : 's'}`
			: 'at least 1 screenshot';
	const artifactRequirement = proofRequirement?.requireVideo
		? `a screen recording and ${screenshotRequirement}`
		: screenshotRequirement;

	return `You are capturing completion proof for one Conductor task in the Maestro group "${groupName}".

Template agent:
- Name: ${templateSession.name}
- Tool type: ${templateSession.toolType}
- Working directory: ${templateSession.cwd}

Task:
- Title: ${task.title}
- Priority: ${task.priority}
- Description: ${task.description || 'No description provided.'}

Acceptance criteria:
${acceptanceCriteria}

Expected scope:
${scopeLines}

Reported changed paths:
${changedPaths}

Proof requirement:
- Capture ${artifactRequirement}.
- Demonstrate the actual implemented workflow, not a mock or placeholder path.

Instructions:
- Treat this run as verification and proof capture, not implementation.
- Do not edit source files or add new feature work during this run unless the user explicitly asks for fixes instead of proof.
- Reuse any already-running local app or dev server when possible.
- If you must start the app locally, do only the minimum setup needed to verify the task.
- Use the provided Maestro demo environment as-is.
- Do not unset or override \`MAESTRO_BROWSER_BROKER_URL\`, \`MAESTRO_BROWSER_BROKER_TOKEN\`, \`MAESTRO_DEMO_CONTEXT_FILE\`, \`MAESTRO_DEMO_OUTPUT_DIR\`, or other \`MAESTRO_*\` capture variables.
- Prefer the provided browser broker or \`maestro-demo\` flow over launching a separate local browser profile.
- Start with the actual capture sequence, not setup probing: \`maestro-demo start\`, then \`"$PWCLI" open <url>\`, then capture proof steps.
- Do not spend the run on preflight commands like \`"$PWCLI" --help\`, broker curls, or local \`curl\` checks unless a direct capture command has already failed.
- If the first browser command fails transiently, retry the actual browser command once before marking the run blocked.
- Show the completed behavior clearly enough that a reviewer can decide whether the task belongs in Done.
- End with a brief summary of what you demonstrated, what URL or surface you used, and any limitation that still prevents approval.
- If the task cannot be demonstrated in a browser or browser-like workflow, say so explicitly and let the demo capture finish in a blocked or failed state rather than pretending it succeeded.`;
}
