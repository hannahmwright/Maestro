import { ipcRenderer } from 'electron';
import type {
	ConversationCapabilities,
	ConversationDispatchResult,
	ConversationEvent,
	ConversationSteerRequest,
	ConversationTurnRequest,
} from '../../shared/conversation';
import type { UserInputRequestId, UserInputResponse } from '../../shared/user-input-requests';

export function createConversationApi() {
	return {
		getCapabilities: (request: {
			toolType: string;
			sessionSshRemoteConfig?: {
				enabled: boolean;
				remoteId: string | null;
			};
			querySource?: 'user' | 'auto';
			preferLiveRuntime?: boolean;
		}): Promise<ConversationCapabilities> =>
			ipcRenderer.invoke('conversation:getCapabilities', request),

		sendTurn: (request: ConversationTurnRequest): Promise<ConversationDispatchResult> =>
			ipcRenderer.invoke('conversation:sendTurn', request),

		steerTurn: (request: ConversationSteerRequest): Promise<ConversationDispatchResult> =>
			ipcRenderer.invoke('conversation:steerTurn', request),

		interruptTurn: (sessionId: string, toolType: string): Promise<boolean> =>
			ipcRenderer.invoke('conversation:interruptTurn', sessionId, toolType),

		respondToUserInput: (
			sessionId: string,
			requestId: UserInputRequestId,
			response: UserInputResponse
		): Promise<boolean> =>
			ipcRenderer.invoke('conversation:respondToUserInput', sessionId, requestId, response),

		onEvent: (callback: (sessionId: string, event: ConversationEvent) => void): (() => void) => {
			const handler = (_: unknown, sessionId: string, event: ConversationEvent) =>
				callback(sessionId, event);
			ipcRenderer.on('conversation:event', handler);
			return () => ipcRenderer.removeListener('conversation:event', handler);
		},
	};
}
