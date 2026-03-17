/**
 * Agent error listener.
 * Handles agent errors (auth expired, token exhaustion, rate limits, etc.).
 */

import type { ProcessManager } from '../process-manager';
import type { AgentError } from '../../shared/types';
import type { ProcessListenerDependencies } from './types';

/**
 * Sets up the agent-error listener.
 * Handles logging and forwarding of agent errors to renderer.
 */
export function setupErrorListener(
	processManager: ProcessManager,
	deps: Pick<ProcessListenerDependencies, 'safeSend' | 'logger' | 'getWebServer'>
): void {
	const { safeSend, logger, getWebServer } = deps;

	// Handle agent errors (auth expired, token exhaustion, rate limits, etc.)
	processManager.on('agent-error', (sessionId: string, agentError: AgentError) => {
		logger.info(`Agent error detected: ${agentError.type}`, 'AgentError', {
			sessionId,
			agentId: agentError.agentId,
			errorType: agentError.type,
			message: agentError.message,
			recoverable: agentError.recoverable,
		});
		safeSend('agent:error', sessionId, agentError);

		const webServer = getWebServer();
		if (!webServer) {
			return;
		}

		const aiTabMatch = sessionId.match(/^(.+)-ai-(.+)$/);
		const baseSessionId = aiTabMatch
			? aiTabMatch[1]
			: sessionId.replace(/-terminal$|-batch-\d+$|-synopsis-\d+$/, '');
		const tabId = aiTabMatch ? aiTabMatch[2] : null;
		const inputMode = aiTabMatch || !sessionId.endsWith('-terminal') ? 'ai' : 'terminal';

		const isInformationalError =
			agentError.type === 'session_not_found' || agentError.type === 'demo_capture_failed';

		webServer.broadcastSessionLogEntry(baseSessionId, tabId, inputMode, {
			id: `agent-error-${agentError.timestamp}-${agentError.type}`,
			timestamp: agentError.timestamp,
			source: isInformationalError ? 'system' : 'error',
			text: agentError.message,
		});

		if (!isInformationalError) {
			webServer.broadcastSessionStateChange(baseSessionId, 'error');
		}
	});
}
