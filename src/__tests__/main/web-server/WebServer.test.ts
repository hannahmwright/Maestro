import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { WebServer } from '../../../main/web-server/WebServer';

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../main/utils/networkUtils', () => ({
	getLocalIpAddressSync: () => 'localhost',
}));

describe('WebServer message handler bridge', () => {
	let server: WebServer;

	beforeEach(() => {
		server = new WebServer(0);
		(server as any).webClients.set('client-1', {
			id: 'client-1',
			connectedAt: Date.now(),
			socket: {
				readyState: WebSocket.OPEN,
				send: vi.fn(),
			},
		});
	});

	it('forwards demo capture requests from websocket messages into executeCommand', async () => {
		const executeCommand = vi.fn().mockResolvedValue(true);

		server.setGetSessionDetailCallback(() => ({
			id: 'session-1',
			name: 'Test Session',
			toolType: 'codex',
			state: 'idle',
			inputMode: 'ai',
			cwd: '/tmp',
		}));
		server.setExecuteCommandCallback(executeCommand);

		(server as any).setupMessageHandlerCallbacks();
		(server as any).handleWebClientMessage('client-1', {
			type: 'send_command',
			sessionId: 'session-1',
			command: 'Capture this flow',
			inputMode: 'ai',
			demoCapture: { enabled: true },
		});

		await vi.waitFor(() => {
			expect(executeCommand).toHaveBeenCalledWith(
				'session-1',
				'Capture this flow',
				'ai',
				'default',
				undefined,
				undefined,
				undefined,
				{ enabled: true }
			);
		});
	});
});
