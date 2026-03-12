import type { ToolType } from './types';

export type AgentModelCatalogSource = 'default' | 'recommended' | 'configured' | 'discovered';

export interface AgentModelCatalogOption {
	id: string;
	provider: ToolType;
	modelId: string | null;
	label: string;
	description?: string;
	source: AgentModelCatalogSource;
	isRecommended: boolean;
	isDefault: boolean;
}

export interface AgentModelCatalogGroup {
	provider: ToolType;
	providerLabel: string;
	supportsModelSelection: boolean;
	options: AgentModelCatalogOption[];
}
