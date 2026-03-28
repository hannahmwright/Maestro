import { ipcMain, BrowserWindow } from 'electron';
import { ConversationManager } from '../../conversation/ConversationManager';
import { dispatchProcessSpawn } from '../../process-manager/dispatchSpawn';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import { isWebContentsAvailable } from '../../utils/safe-send';
import type { ProcessManager } from '../../process-manager';
import type { AgentDetector } from '../../agents';
import type {
	ConversationCapabilities,
	ConversationDispatchResult,
	ConversationSteerRequest,
	ConversationTurnRequest,
} from '../../../shared/conversation';
import type { UserInputRequestId, UserInputResponse } from '../../../shared/user-input-requests';

const LOG_CONTEXT = '[ConversationManager]';

export interface ConversationHandlerDependencies {
	getProcessManager: () => ProcessManager | null;
	getAgentDetector: () => AgentDetector | null;
	agentConfigsStore: any;
	settingsStore: any;
	getMainWindow: () => BrowserWindow | null;
}

export function registerConversationHandlers(deps: ConversationHandlerDependencies): void {
	const { getProcessManager, getAgentDetector, agentConfigsStore, settingsStore, getMainWindow } =
		deps;

	const getConversationManager = (): ConversationManager => {
		const processManager = getProcessManager();
		if (!processManager) {
			throw new Error('Process manager unavailable');
		}
		const agentDetector = getAgentDetector();
		if (!agentDetector) {
			throw new Error('Agent detector unavailable');
		}

		const existingManager = (
			processManager as ProcessManager & {
				conversationManager?: ConversationManager;
			}
		).conversationManager;
		if (existingManager) {
			return existingManager;
		}

		const conversationManager = new ConversationManager({
			processManager,
			agentDetector,
			dispatchSpawn: (request, options) =>
				dispatchProcessSpawn(
					{
						processManager,
						agentDetector,
						agentConfigsStore,
						settingsStore,
						getMainWindow,
					},
					request,
					options
				),
		});
		(
			processManager as ProcessManager & { conversationManager?: ConversationManager }
		).conversationManager = conversationManager;
		conversationManager.on('conversation-event', (sessionId, event) => {
			const mainWindow = getMainWindow();
			if (isWebContentsAvailable(mainWindow)) {
				mainWindow.webContents.send('conversation:event', sessionId, event);
			}
		});
		return conversationManager;
	};

	ipcMain.handle(
		'conversation:getCapabilities',
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'getCapabilities' },
			async (request: {
				toolType: string;
				sessionSshRemoteConfig?: {
					enabled: boolean;
					remoteId: string | null;
				};
				querySource?: 'user' | 'auto';
			}): Promise<ConversationCapabilities> => getConversationManager().getCapabilities(request)
		)
	);

	ipcMain.handle(
		'conversation:sendTurn',
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'sendTurn' },
			async (request: ConversationTurnRequest): Promise<ConversationDispatchResult> =>
				getConversationManager().sendTurn(request)
		)
	);

	ipcMain.handle(
		'conversation:steerTurn',
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'steerTurn' },
			async (request: ConversationSteerRequest): Promise<ConversationDispatchResult> =>
				getConversationManager().steerTurn(request)
		)
	);

	ipcMain.handle(
		'conversation:interruptTurn',
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'interruptTurn' },
			async (sessionId: string, toolType: string): Promise<boolean> =>
				getConversationManager().interruptTurn(sessionId, toolType)
		)
	);

	ipcMain.handle(
		'conversation:respondToUserInput',
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'respondToUserInput' },
			async (
				sessionId: string,
				requestId: UserInputRequestId,
				response: UserInputResponse
			): Promise<boolean> =>
				getConversationManager().respondToUserInput(sessionId, requestId, response)
		)
	);
}
