import { randomUUID } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { logger } from '../utils/logger';
import {
	type BrowserBrokerExecuteRequest,
	MaestroPlaywrightDriver,
} from './MaestroPlaywrightDriver';

const LOG_CONTEXT = 'DemoBrowserBroker';
const AUTH_HEADER = 'x-maestro-browser-broker-token';

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const raw = Buffer.concat(chunks).toString('utf8').trim();
	if (!raw) return {};
	return JSON.parse(raw);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
	response.statusCode = statusCode;
	response.setHeader('Content-Type', 'application/json');
	response.end(JSON.stringify(body));
}

export class DemoBrowserBroker {
	private server: Server | null = null;
	private port: number | null = null;
	private readonly token = randomUUID();
	private startPromise: Promise<void> | null = null;
	private readonly driver = new MaestroPlaywrightDriver();

	async ensureStarted(): Promise<{ url: string; token: string }> {
		if (this.server && this.port) {
			return { url: `http://127.0.0.1:${this.port}`, token: this.token };
		}

		if (this.startPromise) {
			await this.startPromise;
			return { url: `http://127.0.0.1:${this.port}`, token: this.token };
		}

		this.startPromise = new Promise<void>((resolve, reject) => {
			const server = createServer(async (request, response) => {
				if (request.method !== 'POST' || request.url !== '/execute') {
					sendJson(response, 404, { error: 'Not Found' });
					return;
				}

				if (request.headers[AUTH_HEADER] !== this.token) {
					sendJson(response, 403, { error: 'Forbidden' });
					return;
				}

				try {
					const payload = (await readJsonBody(request)) as BrowserBrokerExecuteRequest;
					if (!Array.isArray(payload.args) || payload.args.some((arg) => typeof arg !== 'string')) {
						sendJson(response, 400, { error: 'Invalid args payload' });
						return;
					}

					const result = await this.driver.execute(payload);
					sendJson(response, 200, result);
				} catch (error) {
					logger.error(`Browser broker request failed: ${String(error)}`, LOG_CONTEXT);
					sendJson(response, 500, {
						error: 'Browser broker request failed',
						message: String(error),
					});
				}
			});

			server.on('error', (error) => {
				this.startPromise = null;
				reject(error);
			});

			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				if (!address || typeof address === 'string') {
					this.startPromise = null;
					reject(new Error('Browser broker failed to bind to a TCP port.'));
					return;
				}
				this.server = server;
				this.port = address.port;
				server.unref();
				this.startPromise = null;
				logger.info(`Browser broker listening on 127.0.0.1:${address.port}`, LOG_CONTEXT);
				resolve();
			});
		});

		await this.startPromise;
		return { url: `http://127.0.0.1:${this.port}`, token: this.token };
	}

	async dispose(): Promise<void> {
		if (this.server) {
			await new Promise<void>((resolve) => {
				this.server?.close(() => resolve());
			});
		}
		this.server = null;
		this.port = null;
		this.startPromise = null;
		await this.driver.dispose();
	}
}

let singletonBroker: DemoBrowserBroker | null = null;

export function getDemoBrowserBroker(): DemoBrowserBroker {
	if (!singletonBroker) {
		singletonBroker = new DemoBrowserBroker();
	}
	return singletonBroker;
}
