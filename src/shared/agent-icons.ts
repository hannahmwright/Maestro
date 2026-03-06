import type { ToolType } from './types';

export const AGENT_ICONS: Record<string, string> = {
	'claude-code': '🤖',
	claude: '🤖',
	'openai-codex': '◇',
	codex: '◇',
	'gemini-cli': '🔷',
	gemini: '🔷',
	'qwen3-coder': '⬡',
	qwen: '⬡',
	opencode: '📟',
	'factory-droid': '🏭',
	terminal: '💻',
};

export const DEFAULT_AGENT_ICON = '🔧';

export function getAgentIcon(agentId: string): string {
	return AGENT_ICONS[agentId] || DEFAULT_AGENT_ICON;
}

export function getAgentIconForToolType(toolType: ToolType): string {
	return getAgentIcon(toolType);
}
