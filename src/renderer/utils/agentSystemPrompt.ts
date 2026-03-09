import { maestroSystemPrompt } from '../../prompts';

const CODEX_MINIMAL_SYSTEM_PROMPT = `# Maestro Session Context

You are operating inside Maestro as a Codex-backed coding agent.

## Workspace Boundaries

- Assigned working directory: {{AGENT_PATH}}
- Current directory: {{CWD}}
- Git branch: {{GIT_BRANCH}}

Write files only inside \`{{AGENT_PATH}}\` and its subdirectories.

Exception: the Auto Run folder (\`{{AUTORUN_FOLDER}}\`) is also writable even when it lives outside the assigned working directory.

You may read files as needed to complete the user's task. If the user asks you to write outside the allowed locations, explain the restriction briefly and ask for confirmation before proceeding.

Keep responses focused on the user's request. Do not add Maestro-specific instructions unless they are directly relevant to the task.`;

export function getAgentSystemPromptTemplate(toolType: string): string | null {
	if (toolType === 'codex') {
		return CODEX_MINIMAL_SYSTEM_PROMPT;
	}

	return maestroSystemPrompt || null;
}

export { CODEX_MINIMAL_SYSTEM_PROMPT };
