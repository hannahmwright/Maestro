/**
 * Agent Icons Constants
 *
 * Centralized mapping of agent types to their display icons.
 * These icons are used throughout the UI to visually identify different AI agents.
 *
 * Usage:
 * ```typescript
 * import { AGENT_ICONS, getAgentIcon } from '../constants/agentIcons';
 *
 * // Direct lookup
 * const icon = AGENT_ICONS['claude-code']; // '🤖'
 *
 * // Safe lookup with fallback
 * const icon = getAgentIcon('unknown-agent'); // '🔧'
 * ```
 */

import type { ToolType } from '../types';
import {
	AGENT_ICONS,
	DEFAULT_AGENT_ICON,
	getAgentIcon,
	getAgentIconForToolType,
} from '../../shared/agent-icons';

export { AGENT_ICONS, DEFAULT_AGENT_ICON, getAgentIcon };

/**
 * Get the display icon for a ToolType.
 * Type-safe version of getAgentIcon.
 *
 * @param toolType - The ToolType value
 * @returns The corresponding icon string
 */
export { getAgentIconForToolType };

export default AGENT_ICONS;
