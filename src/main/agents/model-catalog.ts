import type { AgentModelCatalogGroup, AgentModelCatalogOption } from '../../shared/agent-model-catalog';
import type { ToolType } from '../../shared/types';
import type { AgentCapabilities } from './capabilities';
import { AGENT_DEFINITIONS } from './definitions';
import type { AgentConfigOption } from './definitions';

interface RecommendedModelDefinition {
	modelId: string;
	label: string;
	description?: string;
}

const RECOMMENDED_MODELS: Partial<Record<ToolType, RecommendedModelDefinition[]>> = {
	'claude-code': [
		{
			modelId: 'claude-opus-4-6',
			label: 'Claude Opus 4.6',
		},
		{
			modelId: 'claude-sonnet-4-6',
			label: 'Claude Sonnet 4.6',
		},
		{
			modelId: 'claude-haiku-4-5-20251001',
			label: 'Claude Haiku 4.5',
		},
		{
			modelId: 'claude-sonnet-4-6[1m]',
			label: 'Claude Sonnet 4.6 (1M)',
		},
		{
			modelId: 'opusplan',
			label: 'Opusplan (Opus 4.6 -> Sonnet 4.6)',
		},
	],
	codex: [
		{
			modelId: 'gpt-5.3-codex-max',
			label: 'GPT-5.3 Codex Max',
			description: 'Highest-capability Codex tier for complex coding work.',
		},
		{
			modelId: 'gpt-5.3-codex',
			label: 'GPT-5.3 Codex',
			description: 'Balanced Codex coding model.',
		},
		{
			modelId: 'gpt-5.3',
			label: 'GPT-5.3',
			description: 'General-purpose GPT-5.3 model.',
		},
		{
			modelId: 'gpt-5.2-codex-max',
			label: 'GPT-5.2 Codex Max',
			description: 'Stable high-capability Codex fallback.',
		},
		{
			modelId: 'gpt-5.2-codex',
			label: 'GPT-5.2 Codex',
			description: 'Stable balanced Codex fallback.',
		},
	],
	'factory-droid': [
		{
			modelId: 'claude-opus-4-5-20251101',
			label: 'Claude Opus 4.5 (20251101)',
			description: 'Highest-capability Factory Droid model.',
		},
		{
			modelId: 'claude-sonnet-4-5-20250929',
			label: 'Claude Sonnet 4.5 (20250929)',
			description: 'Balanced Factory Droid default for coding work.',
		},
		{
			modelId: 'gpt-5.2',
			label: 'GPT-5.2',
			description: 'OpenAI option exposed by Factory Droid.',
		},
	],
};

function getProviderDisplayName(toolType: ToolType): string {
	switch (toolType) {
		case 'claude-code':
			return 'Claude Code';
		case 'codex':
			return 'Codex';
		case 'opencode':
			return 'OpenCode';
		case 'factory-droid':
			return 'Factory Droid';
		case 'terminal':
			return 'Terminal';
	}
}

function getConfiguredModelOptions(agentId: ToolType): AgentModelCatalogOption[] {
	const agentDefinition = AGENT_DEFINITIONS.find((definition) => definition.id === agentId);
	const modelOption = agentDefinition?.configOptions?.find(
		(option): option is Extract<AgentConfigOption, { type: 'select' }> =>
			option.key === 'model' && option.type === 'select'
	);

	if (!modelOption) {
		return [];
	}

	return modelOption.options
		.filter((value: string) => typeof value === 'string' && value.trim().length > 0)
		.map((modelId: string) => ({
			id: `${agentId}:configured:${modelId}`,
			provider: agentId,
			modelId,
			label: modelId,
			source: 'configured' as const,
			isRecommended: false,
			isDefault: false,
		}));
}

function getRecommendedModelOptions(agentId: ToolType): AgentModelCatalogOption[] {
	return (RECOMMENDED_MODELS[agentId] || []).map((model) => ({
		id: `${agentId}:recommended:${model.modelId}`,
		provider: agentId,
		modelId: model.modelId,
		label: model.label,
		description: model.description,
		source: 'recommended' as const,
		isRecommended: true,
		isDefault: false,
	}));
}

function getDiscoveredModelOptions(
	agentId: ToolType,
	discoveredModels: string[]
): AgentModelCatalogOption[] {
	return discoveredModels
		.filter((modelId) => modelId.trim().length > 0)
		.map((modelId) => ({
			id: `${agentId}:discovered:${modelId}`,
			provider: agentId,
			modelId,
			label: modelId,
			source: 'discovered' as const,
			isRecommended: false,
			isDefault: false,
		}));
}

function getDefaultOption(
	agentId: ToolType,
	capabilities: AgentCapabilities
): AgentModelCatalogOption {
	return {
		id: `${agentId}:default`,
		provider: agentId,
		modelId: null,
		label: 'Provider default',
		description: capabilities.supportsModelSelection
			? 'Use the provider default configured for this runtime.'
			: 'Uses the provider account default model.',
		source: 'default',
		isRecommended: false,
		isDefault: true,
	};
}

export function buildAgentModelCatalogGroup(params: {
	agentId: ToolType;
	capabilities: AgentCapabilities;
	discoveredModels?: string[];
}): AgentModelCatalogGroup {
	const { agentId, capabilities, discoveredModels = [] } = params;
	const defaultOption = getDefaultOption(agentId, capabilities);
	const deduped = new Map<string, AgentModelCatalogOption>();

	for (const option of [
		...getRecommendedModelOptions(agentId),
		...getConfiguredModelOptions(agentId),
		...getDiscoveredModelOptions(agentId, discoveredModels),
	]) {
		if (option.modelId && !deduped.has(option.modelId)) {
			deduped.set(option.modelId, option);
		}
	}

	return {
		provider: agentId,
		providerLabel: getProviderDisplayName(agentId),
		supportsModelSelection: capabilities.supportsModelSelection,
		options: [defaultOption, ...deduped.values()],
	};
}
