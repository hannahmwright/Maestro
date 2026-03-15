/**
 * Data output listener.
 * Handles process output data, including group chat buffering and web broadcasting.
 */

import type { ProcessManager } from '../process-manager';
import type { AssistantStreamEvent } from '../process-manager/types';
import { GROUP_CHAT_PREFIX, type ProcessListenerDependencies } from './types';
import { MAESTRO_DEMO_EVENT_PREFIX, type DemoCaptureEvent } from '../../shared/demo-artifacts';

/**
 * Maximum buffer size per session (10MB).
 * Prevents unbounded memory growth from long-running or misbehaving processes.
 */
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Length of random suffix in message IDs (9 characters of base36).
 * Combined with timestamp provides uniqueness for web broadcast deduplication.
 */
const MSG_ID_RANDOM_LENGTH = 9;

/**
 * Sets up the data listener for process output.
 * Handles:
 * - Group chat moderator/participant output buffering
 * - Regular process data forwarding to renderer
 * - Web broadcast to connected clients
 */
export function setupDataListener(
	processManager: ProcessManager,
	deps: Pick<
		ProcessListenerDependencies,
		| 'getProcessManager'
		| 'safeSend'
		| 'getWebServer'
		| 'outputBuffer'
		| 'outputParser'
		| 'debugLog'
		| 'patterns'
		| 'getDemoArtifactService'
	>
): void {
	const {
		getProcessManager,
		safeSend,
		getWebServer,
		outputBuffer,
		outputParser,
		debugLog,
		patterns,
		getDemoArtifactService,
	} = deps;
	const {
		REGEX_MODERATOR_SESSION,
		REGEX_AI_SUFFIX,
		REGEX_AI_TAB_ID,
		REGEX_BATCH_SESSION,
		REGEX_SYNOPSIS_SESSION,
	} = patterns;
	const demoEventRemainders = new Map<string, string>();

	const parseSessionContext = (
		sessionId: string
	): { baseSessionId: string; tabId: string | null; isAiOutput: boolean } => {
		const tabIdMatch = sessionId.match(REGEX_AI_TAB_ID);
		return {
			baseSessionId: sessionId.replace(REGEX_AI_SUFFIX, ''),
			tabId: tabIdMatch ? tabIdMatch[1] : null,
			isAiOutput: sessionId.includes('-ai-'),
		};
	};

	const maybeHandleDemoEventLine = (
		sessionId: string,
		line: string,
		context: { baseSessionId: string; tabId: string | null }
	): boolean => {
		const trimmedLine = line.trim();
		if (!trimmedLine.startsWith(MAESTRO_DEMO_EVENT_PREFIX)) {
			return false;
		}

		const rawJson = trimmedLine.slice(MAESTRO_DEMO_EVENT_PREFIX.length).trim();
		if (!rawJson) {
			debugLog('DemoCapture', `Ignoring empty demo event payload for ${sessionId}`);
			return true;
		}

		let event: DemoCaptureEvent;
		try {
			event = JSON.parse(rawJson) as DemoCaptureEvent;
		} catch (error) {
			debugLog('DemoCapture', `Failed to parse demo event for ${sessionId}: ${String(error)}`);
			return true;
		}

		const managedProcess = getProcessManager()?.get(sessionId);
		const artifactSessionId = managedProcess?.demoCaptureContext
			? managedProcess.demoCaptureContext.sessionId
			: sessionId;
		const artifactTabId = managedProcess?.demoCaptureContext
			? managedProcess.demoCaptureContext.tabId
			: managedProcess?.tabId ?? null;
		if (managedProcess) {
			if (event.type === 'artifact_created' || event.type === 'step_created') {
				managedProcess.demoCaptureArtifactSeen = true;
			}
			if (event.type === 'capture_completed' || event.type === 'capture_failed') {
				managedProcess.demoCaptureFinalized = true;
			}
			if (event.type === 'capture_failed') {
				managedProcess.demoCaptureFailed = true;
			}
		}

		const runCaptureTask = async () => {
			const demoCard = await getDemoArtifactService().handleCaptureEvent({
				context: {
					sessionId: artifactSessionId,
					tabId: artifactTabId,
					sshRemoteId: managedProcess?.sshRemoteId ?? null,
					sshRemoteHost: managedProcess?.sshRemoteHost ?? null,
				},
				event,
			});
			if (!demoCard) {
				return;
			}
			safeSend('process:demo-generated', context.baseSessionId, context.tabId, demoCard);
		};

		if (managedProcess) {
			const previousTask = managedProcess.demoCapturePending || Promise.resolve();
			managedProcess.demoCapturePending = previousTask
				.catch(() => undefined)
				.then(runCaptureTask)
				.catch((error) => {
					debugLog('DemoCapture', `Failed to handle demo event for ${sessionId}: ${String(error)}`);
				});
		} else {
			void runCaptureTask().catch((error) => {
				debugLog('DemoCapture', `Failed to handle demo event for ${sessionId}: ${String(error)}`);
			});
		}

		return true;
	};

	const sanitizeDemoEventOutput = (
		sessionId: string,
		data: string,
		context: { baseSessionId: string; tabId: string | null }
	): string => {
		const combined = `${demoEventRemainders.get(sessionId) || ''}${data}`;
		const normalized = combined.replace(/\r\n/g, '\n');
		const lines = normalized.split('\n');
		const trailingLine = lines.pop() ?? '';
		const sanitizedLines: string[] = [];

		for (const line of lines) {
			if (!maybeHandleDemoEventLine(sessionId, line, context)) {
				sanitizedLines.push(line);
			}
		}

		if (trailingLine.startsWith(MAESTRO_DEMO_EVENT_PREFIX)) {
			demoEventRemainders.set(sessionId, trailingLine);
		} else {
			demoEventRemainders.delete(sessionId);
			if (trailingLine.length > 0) {
				sanitizedLines.push(trailingLine);
			}
		}

		return sanitizedLines.length > 0 ? sanitizedLines.join('\n') : '';
	};

	processManager.on('data', (sessionId: string, data: string) => {
		// Fast path: skip regex for non-group-chat sessions (performance optimization)
		// Most sessions don't start with 'group-chat-', so this avoids expensive regex matching
		const isGroupChatSession = sessionId.startsWith(GROUP_CHAT_PREFIX);

		// Handle group chat moderator output - buffer it
		// Session ID format: group-chat-{groupChatId}-moderator-{uuid} or group-chat-{groupChatId}-moderator-synthesis-{uuid}
		const moderatorMatch = isGroupChatSession ? sessionId.match(REGEX_MODERATOR_SESSION) : null;
		if (moderatorMatch) {
			const groupChatId = moderatorMatch[1];
			debugLog('GroupChat:Debug', `MODERATOR DATA received for chat ${groupChatId}`);
			debugLog('GroupChat:Debug', `Session ID: ${sessionId}`);
			debugLog('GroupChat:Debug', `Data length: ${data.length}`);
			// Buffer the output - will be routed on process exit
			const totalLength = outputBuffer.appendToGroupChatBuffer(sessionId, data);
			debugLog('GroupChat:Debug', `Buffered total: ${totalLength} chars`);
			// Warn if buffer is growing too large (potential memory leak)
			if (totalLength > MAX_BUFFER_SIZE) {
				debugLog(
					'GroupChat:Debug',
					`WARNING: Buffer size ${totalLength} exceeds ${MAX_BUFFER_SIZE} bytes for moderator session ${sessionId}`
				);
			}
			return; // Don't send to regular process:data handler
		}

		// Handle group chat participant output - buffer it
		// Session ID format: group-chat-{groupChatId}-participant-{name}-{uuid|timestamp}
		// Only parse if it's a group chat session (performance optimization)
		const participantInfo = isGroupChatSession
			? outputParser.parseParticipantSessionId(sessionId)
			: null;
		if (participantInfo) {
			debugLog('GroupChat:Debug', 'PARTICIPANT DATA received');
			debugLog(
				'GroupChat:Debug',
				`Chat: ${participantInfo.groupChatId}, Participant: ${participantInfo.participantName}`
			);
			debugLog('GroupChat:Debug', `Session ID: ${sessionId}`);
			debugLog('GroupChat:Debug', `Data length: ${data.length}`);
			// Buffer the output - will be routed on process exit
			const totalLength = outputBuffer.appendToGroupChatBuffer(sessionId, data);
			debugLog('GroupChat:Debug', `Buffered total: ${totalLength} chars`);
			// Warn if buffer is growing too large (potential memory leak)
			if (totalLength > MAX_BUFFER_SIZE) {
				debugLog(
					'GroupChat:Debug',
					`WARNING: Buffer size ${totalLength} exceeds ${MAX_BUFFER_SIZE} bytes for participant ${participantInfo.participantName}`
				);
			}
			return; // Don't send to regular process:data handler
		}

		const sessionContext = parseSessionContext(sessionId);
		const sanitizedData = sanitizeDemoEventOutput(sessionId, data, sessionContext);
		if (!sanitizedData) {
			return;
		}

		safeSend('process:data', sessionId, sanitizedData);

		// Broadcast to web clients - extract base session ID (remove -ai or -terminal suffix)
		// IMPORTANT: Skip PTY terminal output (-terminal suffix) as it contains raw ANSI codes.
		// Web interface terminal commands use runCommand() which emits with plain session IDs.
		const webServer = getWebServer();
		if (webServer) {
			// Don't broadcast raw PTY terminal output to web clients
			if (sessionId.endsWith('-terminal')) {
				debugLog('WebBroadcast', `SKIPPING PTY terminal output for web: session=${sessionId}`);
				return;
			}

			// Don't broadcast background batch/synopsis output to web clients
			// These are internal Auto Run operations that should only appear in history, not as chat messages
			// Use proper regex patterns to avoid false positives from UUIDs containing "batch" or "synopsis"
			if (REGEX_BATCH_SESSION.test(sessionId) || REGEX_SYNOPSIS_SESSION.test(sessionId)) {
				debugLog('WebBroadcast', `SKIPPING batch/synopsis output for web: session=${sessionId}`);
				return;
			}

			// Extract base session ID and tab ID from format: {id}-ai-{tabId}
			const baseSessionId = sessionContext.baseSessionId;
			const isAiOutput = sessionContext.isAiOutput;
			const tabId = sessionContext.tabId || undefined;

			// Generate unique message ID: timestamp + random suffix for deduplication
			const msgId = `${Date.now()}-${Math.random()
				.toString(36)
				.substring(2, 2 + MSG_ID_RANDOM_LENGTH)}`;
			debugLog(
				'WebBroadcast',
				`Broadcasting session_output: msgId=${msgId}, session=${baseSessionId}, tabId=${tabId || 'none'}, source=${isAiOutput ? 'ai' : 'terminal'}, dataLen=${sanitizedData.length}`
			);
			webServer.broadcastToSessionClients(baseSessionId, {
				type: 'session_output',
				sessionId: baseSessionId,
				tabId,
				data: sanitizedData,
				source: isAiOutput ? 'ai' : 'terminal',
				timestamp: Date.now(),
				msgId,
			});
		}
	});

	processManager.on('exit', (sessionId: string) => {
		const trailingLine = demoEventRemainders.get(sessionId);
		if (!trailingLine) {
			return;
		}

		demoEventRemainders.delete(sessionId);
		maybeHandleDemoEventLine(sessionId, trailingLine, parseSessionContext(sessionId));
	});

	processManager.on('assistant-stream', (sessionId: string, event: AssistantStreamEvent) => {
		const webServer = getWebServer();
		if (!webServer) {
			return;
		}

		if (REGEX_BATCH_SESSION.test(sessionId) || REGEX_SYNOPSIS_SESSION.test(sessionId)) {
			debugLog(
				'WebBroadcast',
				`SKIPPING assistant stream for batch/synopsis: session=${sessionId}`
			);
			return;
		}

		const sessionContext = parseSessionContext(sessionId);
		if (!sessionContext.isAiOutput || !sessionContext.tabId) {
			debugLog(
				'WebBroadcast',
				`SKIPPING assistant stream without AI tab context: session=${sessionId}`
			);
			return;
		}

		webServer.broadcastToSessionClients(sessionContext.baseSessionId, {
			type: 'assistant_stream',
			sessionId: sessionContext.baseSessionId,
			tabId: sessionContext.tabId,
			event,
			timestamp: Date.now(),
		});
	});
}
