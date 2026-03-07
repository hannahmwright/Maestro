/**
 * Store Default Values
 *
 * Centralized default values for all stores.
 * Separated for easy modification and testing.
 */

import path from 'path';
import { CODEX_DEFAULT_FONT_STACK } from '../../shared/fonts';

import type {
	MaestroSettings,
	SessionsData,
	GroupsData,
	ConductorsData,
	AgentConfigsData,
	WindowState,
	ClaudeSessionOriginsData,
	AgentSessionOriginsData,
} from './types';

// ============================================================================
// Utility Functions for Defaults
// ============================================================================

/**
 * Get the default shell based on the current platform.
 */
export function getDefaultShell(): string {
	// Windows: $SHELL doesn't exist; default to PowerShell
	if (process.platform === 'win32') {
		return 'powershell';
	}
	// Unix: Respect user's configured login shell from $SHELL
	const shellPath = process.env.SHELL;
	if (shellPath) {
		const shellName = path.basename(shellPath);
		// Valid Unix shell IDs from shellDetector.ts
		if (['bash', 'zsh', 'fish', 'sh', 'tcsh'].includes(shellName)) {
			return shellName;
		}
	}
	// Fallback to bash (more portable than zsh on older Unix systems)
	return 'bash';
}

// ============================================================================
// Store Defaults
// ============================================================================

export const SETTINGS_DEFAULTS: MaestroSettings = {
	activeThemeId: 'dracula',
	llmProvider: 'openrouter',
	modelSlug: 'anthropic/claude-3.5-sonnet',
	apiKey: '',
	shortcuts: {},
	fontSize: 14,
	fontFamily: CODEX_DEFAULT_FONT_STACK,
	customFonts: [],
	logLevel: 'info',
	defaultShell: getDefaultShell(),
	webAuthEnabled: false,
	webAuthToken: null,
	webInterfaceUseCustomPort: false,
	webInterfaceCustomPort: 8080,
	sshRemotes: [],
	defaultSshRemoteId: null,
	sshRemoteIgnorePatterns: ['.git', '.*cache*'],
	sshRemoteHonorGitignore: false,
	installationId: null,
	wakatimeEnabled: false,
	wakatimeApiKey: '',
	wakatimeDetailedTracking: false,
	totalActiveTimeMs: 0,
};

export const SESSIONS_DEFAULTS: SessionsData = {
	sessions: [],
};

export const GROUPS_DEFAULTS: GroupsData = {
	groups: [],
};

export const CONDUCTORS_DEFAULTS: ConductorsData = {
	conductors: [],
	tasks: [],
	runs: [],
};

export const AGENT_CONFIGS_DEFAULTS: AgentConfigsData = {
	configs: {},
};

export const WINDOW_STATE_DEFAULTS: WindowState = {
	width: 1400,
	height: 900,
	isMaximized: false,
	isFullScreen: false,
};

export const CLAUDE_SESSION_ORIGINS_DEFAULTS: ClaudeSessionOriginsData = {
	origins: {},
};

export const AGENT_SESSION_ORIGINS_DEFAULTS: AgentSessionOriginsData = {
	origins: {},
};
