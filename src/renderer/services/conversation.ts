import { createIpcMethod } from './ipcWrapper';
import type {
	ConversationCapabilities,
	ConversationDispatchResult,
	ConversationEvent,
	ConversationSteerRequest,
	ConversationTurnRequest,
} from '../../shared/conversation';
import type { UserInputRequestId, UserInputResponse } from '../../shared/user-input-requests';

export const conversationService = {
	getCapabilities: (request: {
		toolType: string;
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
		};
		querySource?: 'user' | 'auto';
	}): Promise<ConversationCapabilities> =>
		createIpcMethod({
			call: () => window.maestro.conversation.getCapabilities(request),
			errorContext: 'Conversation getCapabilities',
			rethrow: true,
		}),

	sendTurn: (request: ConversationTurnRequest): Promise<ConversationDispatchResult> =>
		createIpcMethod({
			call: () => window.maestro.conversation.sendTurn(request),
			errorContext: 'Conversation sendTurn',
			rethrow: true,
		}),

	steerTurn: (request: ConversationSteerRequest): Promise<ConversationDispatchResult> =>
		createIpcMethod({
			call: () => window.maestro.conversation.steerTurn(request),
			errorContext: 'Conversation steerTurn',
			rethrow: true,
		}),

	interruptTurn: (sessionId: string, toolType: string): Promise<boolean> =>
		createIpcMethod({
			call: () => window.maestro.conversation.interruptTurn(sessionId, toolType),
			errorContext: 'Conversation interruptTurn',
			rethrow: true,
		}),

	respondToUserInput: (
		sessionId: string,
		requestId: UserInputRequestId,
		response: UserInputResponse
	): Promise<boolean> =>
		createIpcMethod({
			call: () => window.maestro.conversation.respondToUserInput(sessionId, requestId, response),
			errorContext: 'Conversation respondToUserInput',
			rethrow: true,
		}),

	onEvent: (handler: (sessionId: string, event: ConversationEvent) => void): (() => void) =>
		window.maestro.conversation.onEvent(handler),
};
