import type { ToolType } from '../../shared/types';
import { captureException } from './sentry';

interface PersistTabNameMetadataParams {
	agentSessionId: string;
	name: string;
	projectRoot: string;
	toolType: ToolType;
	source: string;
}

export function persistTabNameMetadata({
	agentSessionId,
	name,
	projectRoot,
	toolType,
	source,
}: PersistTabNameMetadataParams): void {
	const trimmedName = name.trim();
	if (!agentSessionId || !projectRoot || !trimmedName) {
		return;
	}

	const persistAgentName =
		toolType === 'claude-code'
			? window.maestro.claude.updateSessionName(projectRoot, agentSessionId, trimmedName)
			: window.maestro.agentSessions.setSessionName(
					toolType,
					projectRoot,
					agentSessionId,
					trimmedName
				);

	persistAgentName.catch((error) => {
		captureException(error, {
			extra: {
				agentSessionId,
				projectRoot,
				toolType,
				trimmedName,
				operation: 'persist-auto-tab-name',
				source,
			},
		});
	});

	window.maestro.history.updateSessionName(agentSessionId, trimmedName).catch((error) => {
		captureException(error, {
			extra: {
				agentSessionId,
				trimmedName,
				operation: 'persist-auto-tab-name-history',
				source,
			},
		});
	});
}
