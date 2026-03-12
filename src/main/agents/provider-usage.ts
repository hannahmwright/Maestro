import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import type { ToolType } from '../../shared/types';
import type { ProviderUsageSnapshot, ProviderUsageWindow } from '../../shared/provider-usage';
import { execFileNoThrow, needsWindowsShell } from '../utils/execFile';
import { logger } from '../utils/logger';
import type { AgentDetector } from './detector';

const LOG_CONTEXT = 'ProviderUsageService';
const LISTENING_URL_RE = /listening on:\s*(ws:\/\/[^\s]+)/i;
const CACHE_TTL_MS = 30 * 1000;
const CLAUDE_CACHE_TTL_MS = 15 * 60 * 1000;
const STARTUP_TIMEOUT_MS = 10 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

type JsonRpcMessage = Record<string, unknown>;

interface UsageRequestOptions {
	forceRefresh?: boolean;
	customEnvVars?: Record<string, string>;
}

interface CacheEntry {
	snapshot: ProviderUsageSnapshot | null;
	fetchedAt: number;
}

interface PendingRequest {
	resolve: (value: JsonRpcMessage) => void;
	reject: (reason?: unknown) => void;
	timeout: ReturnType<typeof setTimeout>;
}

interface CodexAccountResponse {
	account?: {
		type?: string;
		email?: string;
		planType?: string;
	} | null;
	requiresOpenaiAuth?: boolean;
}

interface CodexRateLimitWindow {
	usedPercent?: number;
	resetsAt?: number | null;
	windowDurationMins?: number | null;
}

interface CodexCreditsSnapshot {
	balance?: string | null;
	hasCredits?: boolean;
	unlimited?: boolean;
}

interface CodexRateLimitSnapshot {
	credits?: CodexCreditsSnapshot | null;
	limitId?: string | null;
	limitName?: string | null;
	planType?: string | null;
	primary?: CodexRateLimitWindow | null;
	secondary?: CodexRateLimitWindow | null;
}

interface CodexRateLimitsResponse {
	rateLimits?: CodexRateLimitSnapshot | null;
	rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
}

interface ClaudeAuthStatusResponse {
	loggedIn?: boolean;
	authMethod?: string;
	apiProvider?: string;
	email?: string;
	orgId?: string;
	orgName?: string;
	subscriptionType?: string;
}

interface ClaudeOauthCredentialRecord {
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number | string;
	scopes?: string[];
	subscriptionType?: string;
	rateLimitTier?: string;
}

interface ClaudeStoredCredentials {
	claudeAiOauth?: ClaudeOauthCredentialRecord | null;
}

interface ClaudeUsageApiWindow {
	utilization?: number | null;
	resets_at?: string | null;
}

interface ClaudeUsageApiResponse {
	five_hour?: ClaudeUsageApiWindow | null;
	seven_day?: ClaudeUsageApiWindow | null;
	seven_day_oauth_apps?: ClaudeUsageApiWindow | null;
	seven_day_opus?: ClaudeUsageApiWindow | null;
	seven_day_sonnet?: ClaudeUsageApiWindow | null;
	seven_day_cowork?: ClaudeUsageApiWindow | null;
}

class HttpStatusError extends Error {
	constructor(
		message: string,
		public statusCode: number,
		public responseBody: string,
		public headers: Record<string, string>
	) {
		super(message);
	}
}

function parseRetryAfterMs(value: string | null | undefined): number | null {
	if (!value) {
		return null;
	}

	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds > 0) {
		return seconds * 1000;
	}

	const retryAt = Date.parse(value);
	if (Number.isFinite(retryAt)) {
		return Math.max(0, retryAt - Date.now());
	}

	return null;
}

function getProviderCacheTtlMs(provider: ToolType): number {
	switch (provider) {
		case 'claude-code':
			return CLAUDE_CACHE_TTL_MS;
		default:
			return CACHE_TTL_MS;
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
	return typeof value === 'boolean' ? value : null;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
	try {
		return asRecord(JSON.parse(value));
	} catch {
		return null;
	}
}

function formatClaudePlanLabel(planType: string | null): string | null {
	if (!planType) {
		return 'Claude';
	}

	return `Claude ${formatPlanType(planType)}`;
}

function parseTimestamp(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === 'string' && value.trim()) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}

	return null;
}

function normalizeClaudeUsageWindow(
	id: string,
	label: string,
	window: ClaudeUsageApiWindow | null | undefined,
	windowDurationMins: number
): ProviderUsageWindow | null {
	const usedPercent = asNumber(window?.utilization);
	if (usedPercent === null) {
		return null;
	}

	return {
		id,
		label,
		usedPercent,
		resetsAt: parseTimestamp(window?.resets_at),
		windowDurationMins,
	};
}

function normalizeClaudeUsageSnapshot(
	response: ClaudeUsageApiResponse,
	authStatus: ClaudeAuthStatusResponse | null
): ProviderUsageSnapshot | null {
	const windows = [
		normalizeClaudeUsageWindow('five_hour', 'Current 5h window', response.five_hour, 300),
		normalizeClaudeUsageWindow('seven_day', 'Weekly allowance', response.seven_day, 10080),
		normalizeClaudeUsageWindow('seven_day_sonnet', 'Weekly Sonnet', response.seven_day_sonnet, 10080),
		normalizeClaudeUsageWindow('seven_day_opus', 'Weekly Opus', response.seven_day_opus, 10080),
		normalizeClaudeUsageWindow(
			'seven_day_oauth_apps',
			'Weekly OAuth apps',
			response.seven_day_oauth_apps,
			10080
		),
		normalizeClaudeUsageWindow('seven_day_cowork', 'Weekly Cowork', response.seven_day_cowork, 10080),
	].filter((window): window is ProviderUsageWindow => Boolean(window));
	const primaryWindow = windows[0] ?? null;

	if (!primaryWindow && windows.length === 0) {
		return null;
	}

	const planType = asString(authStatus?.subscriptionType);

	return {
		provider: 'claude-code',
		usedPercent: primaryWindow?.usedPercent ?? null,
		resetsAt: primaryWindow?.resetsAt ?? null,
		label: formatClaudePlanLabel(planType),
		planType,
		accountType: asString(authStatus?.authMethod) ?? 'claude.ai',
		source: 'claude-oauth-usage',
		confidence: 'high',
		fetchedAt: Date.now(),
		windows,
	};
}

function formatPlanType(planType: string | null): string | null {
	if (!planType) {
		return null;
	}

	const normalized = planType.trim().toLowerCase();
	if (!normalized) {
		return null;
	}

	return normalized
		.split(/[-_\s]+/)
		.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join(' ');
}

function buildUsageLabel(
	accountType: string | null,
	planType: string | null,
	limitName: string | null
): string | null {
	if (accountType === 'chatgpt' && planType) {
		return `ChatGPT ${formatPlanType(planType)}`;
	}

	if (limitName) {
		return limitName;
	}

	return formatPlanType(planType);
}

function normalizeCodexRateLimitWindow(
	id: string,
	label: string,
	window: CodexRateLimitWindow | null | undefined,
	snapshot: CodexRateLimitSnapshot | null | undefined
): ProviderUsageWindow | null {
	const usedPercent = asNumber(window?.usedPercent);
	if (usedPercent === null) {
		return null;
	}

	return {
		id,
		label,
		usedPercent,
		resetsAt: asNumber(window?.resetsAt),
		windowDurationMins: asNumber(window?.windowDurationMins),
		limitId: asString(snapshot?.limitId),
		limitName: asString(snapshot?.limitName),
	};
}

function chooseCodexRateLimitSnapshot(
	response: CodexRateLimitsResponse
): CodexRateLimitSnapshot | null {
	const byLimitId = response.rateLimitsByLimitId;
	if (byLimitId) {
		if (byLimitId.codex) {
			return byLimitId.codex;
		}

		const firstKey = Object.keys(byLimitId)[0];
		if (firstKey) {
			return byLimitId[firstKey];
		}
	}

	return response.rateLimits ?? null;
}

function normalizeCodexUsageSnapshot(
	accountResponse: CodexAccountResponse,
	rateLimitResponse: CodexRateLimitsResponse
): ProviderUsageSnapshot | null {
	const selectedSnapshot = chooseCodexRateLimitSnapshot(rateLimitResponse);
	const account = accountResponse.account ?? null;
	const accountType = asString(account?.type);
	const accountPlanType = asString(account?.planType);
	const snapshotPlanType = asString(selectedSnapshot?.planType);
	const planType = accountPlanType ?? snapshotPlanType;
	const primaryWindow = selectedSnapshot?.primary ?? selectedSnapshot?.secondary ?? null;
	const windows = [
		normalizeCodexRateLimitWindow('primary', 'Primary', selectedSnapshot?.primary, selectedSnapshot),
		normalizeCodexRateLimitWindow(
			'secondary',
			'Secondary',
			selectedSnapshot?.secondary,
			selectedSnapshot
		),
	].filter((window): window is ProviderUsageWindow => Boolean(window));
	const primaryUsedPercent = asNumber(primaryWindow?.usedPercent);

	if (primaryUsedPercent === null && windows.length === 0) {
		return null;
	}

	return {
		provider: 'codex',
		usedPercent: primaryUsedPercent,
		resetsAt: asNumber(primaryWindow?.resetsAt),
		label: buildUsageLabel(accountType, planType, asString(selectedSnapshot?.limitName)),
		planType,
		accountType,
		source: 'codex-app-server',
		confidence: 'high',
		fetchedAt: Date.now(),
		windows,
		credits: selectedSnapshot?.credits
			? {
					balance: asString(selectedSnapshot.credits.balance),
					hasCredits: asBoolean(selectedSnapshot.credits.hasCredits) ?? false,
					unlimited: asBoolean(selectedSnapshot.credits.unlimited) ?? false,
				}
			: null,
	};
}

function parseCodexAccountResponse(message: JsonRpcMessage): CodexAccountResponse {
	const result = asRecord(message.result);
	const rawAccount = asRecord(result?.account);
	return {
		account: rawAccount
			? {
					type: asString(rawAccount.type) ?? undefined,
					email: asString(rawAccount.email) ?? undefined,
					planType: asString(rawAccount.planType) ?? undefined,
				}
			: null,
		requiresOpenaiAuth: asBoolean(result?.requiresOpenaiAuth) ?? undefined,
	};
}

function parseCodexRateLimitsResponse(message: JsonRpcMessage): CodexRateLimitsResponse {
	const result = asRecord(message.result);
	const parseWindow = (raw: unknown): CodexRateLimitWindow | null => {
		const record = asRecord(raw);
		if (!record) {
			return null;
		}
		return {
			usedPercent: asNumber(record.usedPercent) ?? undefined,
			resetsAt: asNumber(record.resetsAt),
			windowDurationMins: asNumber(record.windowDurationMins),
		};
	};

	const parseSnapshot = (raw: unknown): CodexRateLimitSnapshot | null => {
		const record = asRecord(raw);
		if (!record) {
			return null;
		}
		const rawCredits = asRecord(record.credits);
		return {
			credits: rawCredits
				? {
						balance: asString(rawCredits.balance),
						hasCredits: asBoolean(rawCredits.hasCredits) ?? undefined,
						unlimited: asBoolean(rawCredits.unlimited) ?? undefined,
					}
				: null,
			limitId: asString(record.limitId),
			limitName: asString(record.limitName),
			planType: asString(record.planType),
			primary: parseWindow(record.primary),
			secondary: parseWindow(record.secondary),
		};
	};

	const byLimitIdRecord = asRecord(result?.rateLimitsByLimitId);
	const rateLimitsByLimitId = byLimitIdRecord
		? Object.fromEntries(
				Object.entries(byLimitIdRecord)
					.map(([key, value]) => [key, parseSnapshot(value)] as const)
					.filter((entry): entry is readonly [string, CodexRateLimitSnapshot] => Boolean(entry[1]))
			)
		: null;

	return {
		rateLimits: parseSnapshot(result?.rateLimits),
		rateLimitsByLimitId:
			rateLimitsByLimitId && Object.keys(rateLimitsByLimitId).length > 0
				? (rateLimitsByLimitId as Record<string, CodexRateLimitSnapshot>)
				: null,
	};
}

export class ProviderUsageService {
	private cache = new Map<ToolType, CacheEntry>();
	private pending = new Map<ToolType, Promise<ProviderUsageSnapshot | null>>();
	private blockedUntil = new Map<ToolType, number>();

	constructor(private getAgentDetector: () => AgentDetector | null) {}

	async getUsageSnapshot(
		provider: ToolType,
		options: UsageRequestOptions = {}
	): Promise<ProviderUsageSnapshot | null> {
		const retryBlockedUntil = this.blockedUntil.get(provider);
		if (
			retryBlockedUntil &&
			retryBlockedUntil > Date.now() &&
			!options.forceRefresh
		) {
			return this.cache.get(provider)?.snapshot ?? null;
		}

		if (!options.forceRefresh) {
			const cached = this.cache.get(provider);
			if (cached && Date.now() - cached.fetchedAt < getProviderCacheTtlMs(provider)) {
				return cached.snapshot;
			}

			const pendingRequest = this.pending.get(provider);
			if (pendingRequest) {
				return pendingRequest;
			}
		}

		const promise = this.fetchUsageSnapshot(provider, options)
			.then((snapshot) => {
				if (snapshot !== null || !this.cache.has(provider)) {
					this.cache.set(provider, {
						snapshot,
						fetchedAt: Date.now(),
					});
				}
				return snapshot;
			})
			.finally(() => {
				this.pending.delete(provider);
			});

		this.pending.set(provider, promise);
		return promise;
	}

	private async fetchUsageSnapshot(
		provider: ToolType,
		options: UsageRequestOptions
	): Promise<ProviderUsageSnapshot | null> {
		switch (provider) {
			case 'codex':
				return this.fetchCodexUsage(options.customEnvVars);
			case 'claude-code':
				return this.fetchClaudeUsage(options.customEnvVars);
			default:
				return null;
		}
	}

	private getClaudeCredentialServiceName(): string {
		const oauthFileSuffix = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : '';
		const configHashSuffix = process.env.CLAUDE_CONFIG_DIR
			? `-${createHash('sha256').update(process.env.CLAUDE_CONFIG_DIR).digest('hex').substring(0, 8)}`
			: '';

		return `Claude Code${oauthFileSuffix}-credentials${configHashSuffix}`;
	}

	private getClaudeCredentialAccountName(): string {
		try {
			return process.env.USER || os.userInfo().username || 'claude-code-user';
		} catch {
			return 'claude-code-user';
		}
	}

	private getClaudeCredentialFilePath(): string {
		const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
		return path.join(configDir, '.credentials.json');
	}

	private readClaudePlaintextCredentials(): ClaudeStoredCredentials | null {
		try {
			const raw = readFileSync(this.getClaudeCredentialFilePath(), 'utf8');
			return (parseJsonRecord(raw) as ClaudeStoredCredentials | null) ?? null;
		} catch {
			return null;
		}
	}

	private async readClaudeCredentials(): Promise<ClaudeStoredCredentials | null> {
		if (process.platform === 'darwin') {
			const result = await execFileNoThrow(
				'security',
				[
					'find-generic-password',
					'-a',
					this.getClaudeCredentialAccountName(),
					'-s',
					this.getClaudeCredentialServiceName(),
					'-w',
				],
				undefined,
				{ timeout: REQUEST_TIMEOUT_MS }
			);
			if (result.exitCode === 0 && result.stdout.trim()) {
				return (parseJsonRecord(result.stdout.trim()) as ClaudeStoredCredentials | null) ?? null;
			}
		}

		return this.readClaudePlaintextCredentials();
	}

	private async readClaudeAuthStatus(
		command: string,
		env?: NodeJS.ProcessEnv
	): Promise<ClaudeAuthStatusResponse | null> {
		const result = await execFileNoThrow(command, ['auth', 'status', '--json'], undefined, env);
		if (result.exitCode !== 0 || !result.stdout.trim()) {
			return null;
		}

		return (parseJsonRecord(result.stdout.trim()) as ClaudeAuthStatusResponse | null) ?? null;
	}

	private async fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const request = https.request(
				url,
				{
					method: 'GET',
					headers,
					timeout: REQUEST_TIMEOUT_MS,
				},
				(response) => {
					let responseBody = '';
					response.setEncoding('utf8');
					response.on('data', (chunk) => {
						responseBody += chunk;
					});
					response.on('end', () => {
						const statusCode = response.statusCode ?? 500;
						if (statusCode < 200 || statusCode >= 300) {
							const headers = Object.fromEntries(
								Object.entries(response.headers).map(([key, value]) => [
									key,
									Array.isArray(value) ? value.join(', ') : String(value ?? ''),
								])
							);
							reject(
								new HttpStatusError(
									`Request failed with status ${statusCode}`,
									statusCode,
									responseBody,
									headers
								)
							);
							return;
						}

						try {
							resolve(JSON.parse(responseBody));
						} catch (error) {
							reject(error);
						}
					});
				}
			);

			request.on('error', reject);
			request.on('timeout', () => {
				request.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
			});
			request.end();
		});
	}

	private async fetchClaudeUsage(
		customEnvVars?: Record<string, string>
	): Promise<ProviderUsageSnapshot | null> {
		const agentDetector = this.getAgentDetector();
		if (!agentDetector) {
			return null;
		}

		const agent = await agentDetector.getAgent('claude-code');
		if (!agent?.available) {
			return null;
		}

		const command = agent.path || agent.command;
		const env = {
			...process.env,
			...(customEnvVars || {}),
		};
		let authStatus = await this.readClaudeAuthStatus(command, env);
		if (!authStatus?.loggedIn) {
			return null;
		}

		for (let attempt = 0; attempt < 2; attempt++) {
			const credentials = await this.readClaudeCredentials();
			const accessToken = asString(credentials?.claudeAiOauth?.accessToken);
			if (!accessToken) {
				return null;
			}

			try {
				const response = (await this.fetchJson(CLAUDE_USAGE_ENDPOINT, {
					Authorization: `Bearer ${accessToken}`,
					'Content-Type': 'application/json',
					'anthropic-version': '2023-06-01',
					'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER,
					'User-Agent': 'Maestro',
				})) as ClaudeUsageApiResponse;
				this.blockedUntil.delete('claude-code');
				return normalizeClaudeUsageSnapshot(response, authStatus);
			} catch (error) {
				if (error instanceof HttpStatusError && error.statusCode === 429) {
					const retryAfterMs = parseRetryAfterMs(error.headers['retry-after']);
					if (retryAfterMs) {
						this.blockedUntil.set('claude-code', Date.now() + retryAfterMs);
					}
				}

				if (error instanceof HttpStatusError && error.statusCode === 401 && attempt === 0) {
					authStatus = await this.readClaudeAuthStatus(command, env);
					if (!authStatus?.loggedIn) {
						return null;
					}
					continue;
				}

				logger.warn('Failed to fetch Claude provider usage', LOG_CONTEXT, {
					error: String(error),
				});
				return null;
			}
		}

		return null;
	}

	private async fetchCodexUsage(
		customEnvVars?: Record<string, string>
	): Promise<ProviderUsageSnapshot | null> {
		const agentDetector = this.getAgentDetector();
		if (!agentDetector) {
			return null;
		}

		const agent = await agentDetector.getAgent('codex');
		if (!agent?.available) {
			return null;
		}

		const command = agent.path || agent.command;
		const env = {
			...process.env,
			...(customEnvVars || {}),
		};

		return new Promise<ProviderUsageSnapshot | null>((resolve) => {
			const child = spawn(command, ['app-server', '--listen', 'ws://127.0.0.1:0'], {
				env,
				shell: process.platform === 'win32' ? needsWindowsShell(command) : false,
				stdio: ['ignore', 'ignore', 'pipe'],
			});

			let stderrBuffer = '';
			let ws: WebSocket | null = null;
			let settled = false;
			const pendingRequests = new Map<string, PendingRequest>();

			const cleanup = () => {
				for (const pending of pendingRequests.values()) {
					clearTimeout(pending.timeout);
				}
				pendingRequests.clear();
				if (ws) {
					ws.removeAllListeners();
					try {
						ws.close();
					} catch {
						// Ignore close errors during cleanup.
					}
				}
				if (!child.killed) {
					try {
						child.kill('SIGTERM');
					} catch {
						// Ignore kill errors during cleanup.
					}
				}
			};

			const finish = (snapshot: ProviderUsageSnapshot | null) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(startupTimeout);
				cleanup();
				resolve(snapshot);
			};

			const fail = (error: unknown) => {
				logger.warn('Failed to fetch Codex provider usage', LOG_CONTEXT, {
					error: String(error),
				});
				finish(null);
			};

			const startupTimeout = setTimeout(() => {
				fail(new Error('Timed out waiting for Codex app-server usage endpoint.'));
			}, STARTUP_TIMEOUT_MS);

			const sendJson = (socket: WebSocket, payload: JsonRpcMessage) => {
				socket.send(JSON.stringify(payload));
			};

			const requestJson = (socket: WebSocket, id: string, method: string): Promise<JsonRpcMessage> =>
				new Promise((requestResolve, requestReject) => {
					const timeout = setTimeout(() => {
						pendingRequests.delete(id);
						requestReject(new Error(`Timed out waiting for Codex response: ${method}`));
					}, REQUEST_TIMEOUT_MS);

					pendingRequests.set(id, {
						resolve: requestResolve,
						reject: requestReject,
						timeout,
					});

					sendJson(socket, {
						id,
						method,
					});
				});

			const connectWebSocket = (wsUrl: string) => {
				if (ws || settled) {
					return;
				}

				ws = new WebSocket(wsUrl);

				ws.on('open', () => {
					sendJson(ws!, {
						id: 'initialize',
						method: 'initialize',
						params: {
							clientInfo: {
								name: 'Maestro',
								version: '0.15.1',
							},
							capabilities: {
								experimentalApi: true,
							},
						},
					});
				});

				ws.on('message', (data) => {
					let message: JsonRpcMessage;
					try {
						message = JSON.parse(data.toString()) as JsonRpcMessage;
					} catch {
						return;
					}

					const messageId =
						typeof message.id === 'string' || typeof message.id === 'number'
							? String(message.id)
							: null;

					if (messageId && pendingRequests.has(messageId)) {
						const pending = pendingRequests.get(messageId)!;
						pendingRequests.delete(messageId);
						clearTimeout(pending.timeout);
						pending.resolve(message);
						return;
					}

					if (messageId === 'initialize') {
						sendJson(ws!, { method: 'initialized' });
						Promise.all([
							requestJson(ws!, 'account', 'account/read'),
							requestJson(ws!, 'rateLimits', 'account/rateLimits/read'),
						])
							.then(([accountMessage, rateLimitsMessage]) => {
								const snapshot = normalizeCodexUsageSnapshot(
									parseCodexAccountResponse(accountMessage),
									parseCodexRateLimitsResponse(rateLimitsMessage)
								);
								finish(snapshot);
							})
							.catch(fail);
					}
				});

				ws.on('error', (error) => {
					fail(error);
				});
			};

			child.stderr?.on('data', (chunk: Buffer | string) => {
				stderrBuffer += chunk.toString();
				const lines = stderrBuffer.split(/\r?\n/);
				stderrBuffer = lines.pop() || '';

				for (const line of lines) {
					const listeningMatch = line.match(LISTENING_URL_RE);
					if (listeningMatch) {
						connectWebSocket(listeningMatch[1]);
					}
				}
			});

			child.on('error', (error) => {
				fail(error);
			});

			child.on('exit', (code) => {
				if (!settled) {
					fail(new Error(`Codex app-server exited before usage completed (code ${code ?? -1}).`));
				}
			});
		});
	}
}
