import type {
	ConductorAgentRole,
	ConductorProviderAgent,
	ConductorProviderRouteKey,
	ConductorProviderRouting,
	ConductorSessionMetadata,
	LogEntry,
	Session,
	ToolType,
	UsageStats,
} from '../types';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useConductorStore } from '../stores/conductorStore';
import { generateId } from '../utils/ids';
import { buildWorktreeSession } from '../utils/worktreeSession';
import { gitService } from './git';
import { getActiveTab } from '../utils/tabHelpers';
import { getAgentSystemPromptTemplate } from '../utils/agentSystemPrompt';
import { substituteTemplateVariables } from '../utils/templateVariables';
import { getStdinFlags } from '../utils/spawnHelpers';
import { getProviderDisplayName } from '../utils/sessionValidation';
import type { ProviderUsageSnapshot } from '../../shared/provider-usage';

export interface ConductorAgentRunOptions {
	parentSession: Session;
	role: ConductorAgentRole;
	prompt: string;
	cwd?: string;
	branch?: string | null;
	taskTitle?: string;
	taskDescription?: string;
	scopePaths?: string[];
	providerRouteHint?: ConductorProviderRouteKey;
	runId?: string;
	taskId?: string;
	readOnlyMode?: boolean;
	onSessionReady?: (session: Session) => void;
}

export interface ConductorAgentRunResult {
	sessionId: string;
	tabId: string;
	toolType: ConductorProviderAgent;
	agentSessionId?: string;
	response: string;
	usageStats?: UsageStats;
}

const CALLSIGN_ADJECTIVES = [
	'Banana',
	'Cinder',
	'Juniper',
	'Mango',
	'Nimbus',
	'Pixel',
	'Quartz',
	'Rocket',
	'Saffron',
	'Topaz',
];

const CALLSIGN_NOUNS = ['Atlas', 'Beacon', 'Circuit', 'Drift', 'Ember', 'Harbor', 'Marble', 'Orbit'];

const UI_ROUTE_KEYWORDS = [
	'ui',
	'ux',
	'frontend',
	'front-end',
	'react',
	'component',
	'design',
	'layout',
	'style',
	'styling',
	'css',
	'tailwind',
	'page',
	'screen',
	'copy',
	'button',
	'modal',
	'visual',
];

const BACKEND_ROUTE_KEYWORDS = [
	'backend',
	'back-end',
	'api',
	'server',
	'database',
	'db',
	'migration',
	'schema',
	'route',
	'endpoint',
	'auth',
	'queue',
	'job',
	'worker',
	'ipc',
	'handler',
	'service',
];

function getSshRemoteId(session: Session): string | undefined {
	return session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
}

async function fetchGitInfo(
	path: string,
	sshRemoteId?: string
): Promise<{
	gitBranches?: string[];
	gitTags?: string[];
	gitRefsCacheTime?: number;
}> {
	try {
		const [gitBranches, gitTags] = await Promise.all([
			gitService.getBranches(path, sshRemoteId),
			gitService.getTags(path, sshRemoteId),
		]);
		return {
			gitBranches,
			gitTags,
			gitRefsCacheTime: Date.now(),
		};
	} catch {
		return {};
	}
}

function truncateLabel(value: string, maxLength = 72): string {
	const normalized = value.trim().replace(/\s+/g, ' ');
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, maxLength - 3)}...`;
}

function hashSeed(value: string): number {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
	}
	return hash;
}

function buildConductorCallsign(seed: string): string {
	const hash = hashSeed(seed || 'conductor');
	const adjective = CALLSIGN_ADJECTIVES[hash % CALLSIGN_ADJECTIVES.length];
	const noun = CALLSIGN_NOUNS[Math.floor(hash / CALLSIGN_ADJECTIVES.length) % CALLSIGN_NOUNS.length];
	return `${adjective} ${noun}`;
}

function getRoleLabel(role: ConductorAgentRole): string {
	switch (role) {
		case 'planner':
			return 'Planner';
		case 'reviewer':
			return 'QA';
		case 'worker':
		default:
			return 'Worker';
	}
}

export function detectConductorProviderRoute(
	input: {
		taskTitle?: string;
		taskDescription?: string;
		scopePaths?: string[];
		providerRouteHint?: ConductorProviderRouteKey;
	}
): ConductorProviderRouteKey {
	if (input.providerRouteHint) {
		return input.providerRouteHint;
	}

	const haystack = [
		input.taskTitle || '',
		input.taskDescription || '',
		...(input.scopePaths || []),
	]
		.join(' ')
		.toLowerCase();

	let uiScore = 0;
	let backendScore = 0;

	for (const keyword of UI_ROUTE_KEYWORDS) {
		if (haystack.includes(keyword)) {
			uiScore += 1;
		}
	}

	for (const keyword of BACKEND_ROUTE_KEYWORDS) {
		if (haystack.includes(keyword)) {
			backendScore += 1;
		}
	}

	if (uiScore === 0 && backendScore === 0) {
		return 'default';
	}

	return uiScore >= backendScore ? 'ui' : 'backend';
}

function isProviderNearLimit(
	snapshot: ProviderUsageSnapshot | null,
	thresholdPercent: number
): { nearLimit: boolean; reason?: string } {
	if (!snapshot) {
		return { nearLimit: false };
	}

	if (snapshot.credits && !snapshot.credits.unlimited && !snapshot.credits.hasCredits) {
		return {
			nearLimit: true,
			reason: `${getProviderDisplayName(snapshot.provider)} credits are exhausted.`,
		};
	}

	if (snapshot.usedPercent !== null && snapshot.usedPercent >= thresholdPercent) {
		return {
			nearLimit: true,
			reason: `${getProviderDisplayName(snapshot.provider)} usage is at ${snapshot.usedPercent}% of the current limit window.`,
		};
	}

	return { nearLimit: false };
}

function getConductorProviderRouting(groupId: string): ConductorProviderRouting {
	const conductor = useConductorStore.getState().conductors.find((candidate) => candidate.groupId === groupId);
	return (
		conductor?.providerRouting || {
			default: { primary: 'workspace-lead', fallback: null },
			ui: { primary: 'claude-code', fallback: 'codex' },
			backend: { primary: 'codex', fallback: 'claude-code' },
			pauseNearLimit: true,
			nearLimitPercent: 88,
		}
	);
}

async function chooseConductorProvider(
	parentSession: Session,
	options: Pick<
		ConductorAgentRunOptions,
		'role' | 'taskTitle' | 'taskDescription' | 'scopePaths' | 'providerRouteHint'
	>
): Promise<{
		toolType: ConductorProviderAgent;
		callsign: string;
		routedFrom?: ConductorProviderAgent;
		reason?: string;
	}> {
	const groupId = parentSession.groupId || parentSession.workspaceId || '';
	const routing = getConductorProviderRouting(groupId);
	const routeKey = detectConductorProviderRoute(options);
	const route = routing[routeKey];
	const parentToolType = parentSession.toolType === 'terminal' ? 'claude-code' : parentSession.toolType;
	const primary =
		route.primary === 'workspace-lead' ? (parentToolType as ConductorProviderAgent) : route.primary;
	const candidates = [primary, route.fallback, routeKey !== 'default' ? routing.default.fallback : null].filter(
		(candidate, index, all): candidate is ConductorProviderAgent =>
			Boolean(candidate) && all.indexOf(candidate) === index
	);

	let primaryReason: string | undefined;
	for (const candidate of candidates) {
		const agent = await window.maestro.agents.get(candidate);
		if (!agent || agent.available === false) {
			continue;
		}

		if (routing.pauseNearLimit) {
			const snapshot = await window.maestro.agents.getProviderUsage(candidate, false);
			const limitCheck = isProviderNearLimit(snapshot, routing.nearLimitPercent);
			if (limitCheck.nearLimit) {
				if (candidate === primary) {
					primaryReason = limitCheck.reason;
				}
				continue;
			}
		}

		return {
			toolType: candidate,
			callsign: buildConductorCallsign(
				`${groupId}:${options.role}:${candidate}:${options.taskTitle || options.taskDescription || 'general'}`
			),
			routedFrom: candidate !== primary ? primary : undefined,
			reason: candidate !== primary ? primaryReason : undefined,
		};
	}

	if (routing.pauseNearLimit && primaryReason) {
		throw new Error(
			`${getRoleLabel(options.role)} is paused because ${primaryReason} No healthy fallback provider is available in Conductor settings.`
		);
	}

	return {
		toolType: primary,
		callsign: buildConductorCallsign(
			`${groupId}:${options.role}:${primary}:${options.taskTitle || options.taskDescription || 'general'}`
		),
	};
}

function buildConductorSessionName(
	role: ConductorAgentRole,
	toolType: ConductorProviderAgent,
	callsign: string,
	taskTitle?: string
): string {
	const providerLabel = getProviderDisplayName(toolType).replace(/\s+Code$/i, '');
	const coreLabel = `${callsign} · ${providerLabel}`;
	if (role === 'planner' || !taskTitle) {
		return coreLabel;
	}
	return `${coreLabel} · ${truncateLabel(taskTitle, 42)}`;
}

function getLatestAssistantResponse(sessionId: string, tabId: string): string | null {
	const session = useSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId);
	const tab = session?.aiTabs.find((candidate) => candidate.id === tabId);
	const assistantLog = [...(tab?.logs || [])].reverse().find((entry) => entry.source === 'ai');
	return assistantLog?.text?.trim() || null;
}

export function extractConductorAgentResponse(toolType: ToolType, output: string): string | null {
	if (!output.trim()) {
		return null;
	}

	const lines = output.split('\n');

	try {
		if (toolType === 'opencode') {
			const textParts: string[] = [];
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const payload = JSON.parse(line) as {
						type?: string;
						part?: { text?: string };
					};
					if (payload.type === 'text' && payload.part?.text) {
						textParts.push(payload.part.text);
					}
				} catch {
					// Ignore non-JSON lines.
				}
			}
			if (textParts.length > 0) {
				return textParts.join('').trim();
			}
		}

		if (toolType === 'codex') {
			const textParts: string[] = [];
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const payload = JSON.parse(line) as {
						type?: string;
						text?: string;
						content?: Array<{ type?: string; text?: string }>;
					};
					if (payload.type === 'agent_message' && Array.isArray(payload.content)) {
						for (const block of payload.content) {
							if (block.type === 'text' && block.text) {
								textParts.push(block.text);
							}
						}
					}
					if (payload.type === 'message' && payload.text) {
						textParts.push(payload.text);
					}
				} catch {
					// Ignore non-JSON lines.
				}
			}
			if (textParts.length > 0) {
				return textParts.join('').trim();
			}
		}

		if (toolType === 'factory-droid') {
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const payload = JSON.parse(line) as {
						type?: string;
						finalText?: string;
					};
					if (payload.type === 'completion' && payload.finalText) {
						return payload.finalText.trim();
					}
				} catch {
					// Ignore non-JSON lines.
				}
			}
		}

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const payload = JSON.parse(line) as {
					type?: string;
					result?: string;
				};
				if (payload.type === 'result' && payload.result) {
					return payload.result.trim();
				}
			} catch {
				// Ignore non-JSON lines.
			}
		}
	} catch {
		// Fall back to raw output below.
	}

	return output.trim();
}

async function createConductorChildSession(
	parentSession: Session,
	options: {
		role: ConductorAgentRole;
		toolType: ConductorProviderAgent;
		sessionName: string;
		cwd: string;
		branch?: string | null;
		taskTitle?: string;
		runId?: string;
		taskId?: string;
	}
): Promise<Session> {
	const { defaultSaveToHistory, defaultShowThinking } = useSettingsStore.getState();
	const sshRemoteId = getSshRemoteId(parentSession);
	const gitInfo = await fetchGitInfo(options.cwd, sshRemoteId);
	const conductorMetadata: ConductorSessionMetadata = {
		isConductorSession: true,
		groupId: parentSession.groupId || parentSession.workspaceId || '',
		role: options.role,
		runId: options.runId,
		taskId: options.taskId,
		taskTitle: options.taskTitle,
		createdAt: Date.now(),
	};
	const baseParentSession =
		options.toolType === parentSession.toolType
			? parentSession
			: {
					...parentSession,
					toolType: options.toolType,
					customPath: undefined,
					customArgs: undefined,
					customEnvVars: undefined,
					customModel: undefined,
					customContextWindow: undefined,
				};
	const childSession = buildWorktreeSession({
		parentSession: baseParentSession,
		path: options.cwd,
		branch: options.branch,
		name: options.sessionName,
		defaultSaveToHistory,
		defaultShowThinking,
		...gitInfo,
	});
	childSession.conductorMetadata = conductorMetadata;

	useSessionStore
		.getState()
		.setSessions((previous) => [
			...previous.map((session) =>
				session.id === parentSession.id ? { ...session, worktreesExpanded: true } : session
			),
			childSession,
		]);

	return childSession;
}

async function buildEffectivePrompt(session: Session, prompt: string): Promise<string> {
	const activeTab = getActiveTab(session);
	const conductorProfile = useSettingsStore.getState().conductorProfile;
	let effectivePrompt = prompt;
	const systemPromptTemplate = getAgentSystemPromptTemplate(session.toolType);

	if (!activeTab?.agentSessionId && systemPromptTemplate) {
		let gitBranch: string | undefined;
		if (session.isGitRepo) {
			try {
				const status = await gitService.getStatus(session.cwd, getSshRemoteId(session));
				gitBranch = status.branch;
			} catch {
				// Ignore git status failures.
			}
		}

		let historyFilePath: string | undefined;
		const isSshSession = !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled;
		if (!isSshSession) {
			try {
				historyFilePath = (await window.maestro.history.getFilePath(session.id)) || undefined;
			} catch {
				// Ignore history lookup failures.
			}
		}

		const substitutedSystemPrompt = substituteTemplateVariables(systemPromptTemplate, {
			session,
			gitBranch,
			historyFilePath,
			conductorProfile,
		});
		effectivePrompt = `${substitutedSystemPrompt}\n\n---\n\n# User Request\n\n${prompt}`;
	}

	return effectivePrompt;
}

export async function runConductorAgentTurn(
	options: ConductorAgentRunOptions
): Promise<ConductorAgentRunResult> {
	if (options.parentSession.toolType === 'terminal') {
		throw new Error('Conductor needs an AI lead agent, not a terminal session.');
	}

	const selectedProvider = await chooseConductorProvider(options.parentSession, {
		role: options.role,
		taskTitle: options.taskTitle,
		taskDescription: options.taskDescription,
		scopePaths: options.scopePaths,
		providerRouteHint: options.providerRouteHint,
	});
	const session = await createConductorChildSession(options.parentSession, {
		role: options.role,
		toolType: selectedProvider.toolType,
		sessionName: buildConductorSessionName(
			options.role,
			selectedProvider.toolType,
			selectedProvider.callsign,
			options.taskTitle
		),
		cwd: options.cwd || options.parentSession.cwd,
		branch: options.branch,
		taskTitle: options.taskTitle,
		runId: options.runId,
		taskId: options.taskId,
	});
	options.onSessionReady?.(session);
	const activeTab = getActiveTab(session);

	if (!activeTab) {
		throw new Error('Failed to create a Conductor agent tab.');
	}

	if (selectedProvider.routedFrom && selectedProvider.reason) {
		const routedFrom = selectedProvider.routedFrom;
		useSessionStore.getState().setSessions((previous) =>
			previous.map((candidate) => {
				if (candidate.id !== session.id) {
					return candidate;
				}

				return {
					...candidate,
					shellLogs: [
						...candidate.shellLogs,
							{
								id: generateId(),
								timestamp: Date.now(),
								source: 'system',
								text: `Conductor rerouted this ${getRoleLabel(options.role).toLowerCase()} from ${getProviderDisplayName(routedFrom)} to ${getProviderDisplayName(selectedProvider.toolType)}. ${selectedProvider.reason}`,
							},
						],
					};
			})
		);
	}

	const agent = await window.maestro.agents.get(session.toolType);
	if (!agent) {
		throw new Error(`Agent not found for toolType: ${session.toolType}`);
	}

	const targetSessionId = `${session.id}-ai-${activeTab.id}`;
	const now = Date.now();
	const userLog: LogEntry = {
		id: generateId(),
		timestamp: now,
		source: 'user',
		text: options.prompt,
		delivered: false,
		interactionKind: 'turn',
		deliveryState: 'pending',
	};

	useSessionStore.getState().setSessions((previous) =>
		previous.map((candidate) => {
			if (candidate.id !== session.id) {
				return candidate;
			}

			return {
				...candidate,
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: now,
				currentCycleTokens: 0,
				currentCycleBytes: 0,
				activeTabId: activeTab.id,
				aiTabs: candidate.aiTabs.map((tab) =>
					tab.id === activeTab.id
						? {
								...tab,
								state: 'busy' as const,
								thinkingStartTime: now,
								awaitingSessionId: !tab.agentSessionId,
								logs: [...tab.logs, userLog],
							}
						: tab
				),
			};
		})
	);

	const effectivePrompt = await buildEffectivePrompt(session, options.prompt);
	const baseArgs =
		options.readOnlyMode
			? (agent.args || []).filter(
					(arg) =>
						arg !== '--dangerously-skip-permissions' &&
						arg !== '--dangerously-bypass-approvals-and-sandbox'
				)
			: [...(agent.args || [])];
	const { sendPromptViaStdin, sendPromptViaStdinRaw } = getStdinFlags({
		isSshSession: !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled,
		supportsStreamJsonInput: agent.capabilities?.supportsStreamJsonInput ?? false,
	});

	return new Promise((resolve, reject) => {
		let rawOutput = '';
		let agentSessionId: string | undefined;
		let usageStats: UsageStats | undefined;

		const unsubscribeData = window.maestro.process.onData((sessionId, data) => {
			if (sessionId === targetSessionId) {
				rawOutput += data;
			}
		});
		const unsubscribeSessionId = window.maestro.process.onSessionId((sessionId, capturedId) => {
			if (sessionId === targetSessionId) {
				agentSessionId = capturedId;
			}
		});
		const unsubscribeUsage = window.maestro.process.onUsage((sessionId, nextUsageStats) => {
			if (sessionId === targetSessionId) {
				usageStats = nextUsageStats;
			}
		});
		const unsubscribeExit = window.maestro.process.onExit((sessionId, exitCode) => {
			if (sessionId !== targetSessionId) {
				return;
			}

			unsubscribeData();
			unsubscribeSessionId();
			unsubscribeUsage();
			unsubscribeExit();

			const response =
				extractConductorAgentResponse(session.toolType, rawOutput) ||
				getLatestAssistantResponse(session.id, activeTab.id) ||
				'';

				if (exitCode !== 0) {
					reject(
						new Error(
							response || `${session.name} exited with code ${exitCode}.`
						)
					);
				return;
			}

			resolve({
				sessionId: session.id,
				tabId: activeTab.id,
				toolType: selectedProvider.toolType,
				agentSessionId,
				response,
				usageStats,
			});
		});

		window.maestro.process
			.spawn({
				sessionId: targetSessionId,
				toolType: session.toolType,
				cwd: session.cwd,
				command: agent.path ?? agent.command,
				args: baseArgs,
				prompt: effectivePrompt,
				agentSessionId: activeTab.agentSessionId ?? undefined,
				readOnlyMode: options.readOnlyMode === true,
				sessionCustomPath: session.customPath,
				sessionCustomArgs: session.customArgs,
				sessionCustomEnvVars: session.customEnvVars,
				sessionCustomModel: session.customModel,
				sessionCustomContextWindow: session.customContextWindow,
				sessionReasoningEffort: activeTab.reasoningEffort ?? 'default',
				sessionSshRemoteConfig: session.sessionSshRemoteConfig,
				sendPromptViaStdin,
				sendPromptViaStdinRaw,
			})
			.catch((error) => {
				unsubscribeData();
				unsubscribeSessionId();
				unsubscribeUsage();
				unsubscribeExit();

				useSessionStore.getState().setSessions((previous) =>
					previous.map((candidate) => {
						if (candidate.id !== session.id) {
							return candidate;
						}

						return {
							...candidate,
							state: 'idle',
							busySource: undefined,
							thinkingStartTime: undefined,
							aiTabs: candidate.aiTabs.map((tab) =>
								tab.id === activeTab.id
									? {
											...tab,
											state: 'idle' as const,
											thinkingStartTime: undefined,
											logs: [
												...tab.logs,
												{
													id: generateId(),
													timestamp: Date.now(),
													source: 'system',
													text: `Error: Failed to spawn Conductor agent - ${(error as Error).message}`,
												},
											],
										}
									: tab
							),
						};
					})
				);

				reject(error);
			});
	});
}
