import type {
	AITab,
	AgentError,
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
import type { ConversationRuntimeKind } from '../../shared/conversation';
import type { DemoCard, DemoCaptureRequest } from '../../shared/demo-artifacts';
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
import { appendDemoCaptureInstructions } from '../utils/demoCapturePrompt';
import type { ProviderUsageSnapshot } from '../../shared/provider-usage';
import { conversationService } from './conversation';
import {
	parseConductorStructuredSubmissionFromToolExecution,
	supportsNativeConductorToolSubmission,
	type ConductorStructuredSubmission,
	type ConductorStructuredSubmissionKind,
} from '../../shared/conductorNativeTools';
import { getConductorNamePool } from '../../shared/conductorRoster';

export interface ConductorAgentRunOptions {
	parentSession: Session;
	role: ConductorAgentRole;
	prompt: string;
	providerOverride?: ConductorProviderAgent;
	cwd?: string;
	branch?: string | null;
	taskTitle?: string;
	taskDescription?: string;
	scopePaths?: string[];
	providerRouteHint?: ConductorProviderRouteKey;
	runId?: string;
	taskId?: string;
	readOnlyMode?: boolean;
	expectedSubmissionKind?: ConductorStructuredSubmissionKind;
	onSessionReady?: (session: Session) => void;
	demoCapture?: DemoCaptureRequest;
}

export interface ConductorAgentRunResult {
	sessionId: string;
	tabId: string;
	toolType: ConductorProviderAgent;
	agentSessionId?: string;
	response: string;
	usageStats?: UsageStats;
	runtimeKind?: ConversationRuntimeKind;
	structuredSubmission?: ConductorStructuredSubmission;
	demoCard?: DemoCard;
}

export interface ResolvedConductorProviderConfig {
	toolType: ConductorProviderAgent;
	callsign: string;
	routedFrom?: ConductorProviderAgent;
	reason?: string;
	sessionCustomPath?: string;
	sessionCustomArgs?: string;
	sessionCustomEnvVars?: Record<string, string>;
	sessionCustomModel?: string;
	sessionCustomContextWindow?: number;
	sessionSshRemoteConfig?: Session['sessionSshRemoteConfig'];
}

interface ConductorExecutionMode {
	dispatchKind: 'conversation' | 'spawn';
	requireNativeStructuredSubmission: boolean;
}

const CLAUDE_CONDUCTOR_PLANNER_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'LS'] as const;
const MAX_CONDUCTOR_RAW_OUTPUT_CHARS = 200_000;

export class ConductorAgentRunError extends Error {
	demoCard?: DemoCard;

	constructor(message: string, options?: { demoCard?: DemoCard }) {
		super(message);
		this.name = 'ConductorAgentRunError';
		this.demoCard = options?.demoCard;
	}
}

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

export function buildConductorCallsign(toolType: ConductorProviderAgent, seed: string): string {
	const hash = hashSeed(seed || 'conductor');
	const pool = getConductorNamePool(toolType);
	return pool[hash % pool.length];
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

export function detectConductorProviderRoute(input: {
	taskTitle?: string;
	taskDescription?: string;
	scopePaths?: string[];
	providerRouteHint?: ConductorProviderRouteKey;
}): ConductorProviderRouteKey {
	if (input.providerRouteHint) {
		return input.providerRouteHint;
	}

	const haystack = [input.taskTitle || '', input.taskDescription || '', ...(input.scopePaths || [])]
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

	const creditsLookExhausted =
		Boolean(snapshot.credits) &&
		snapshot.credits?.unlimited !== true &&
		snapshot.credits?.hasCredits === false;
	const hasWindowCapacitySignal =
		snapshot.usedPercent !== null || (snapshot.windows?.length || 0) > 0;
	const shouldTrustCreditExhaustion =
		snapshot.accountType !== 'chatgpt' || !hasWindowCapacitySignal;

	// ChatGPT-backed Codex accounts can report a zero credit balance while still exposing
	// active rate-limit windows. In that case, trust the window telemetry instead of
	// pausing Conductor immediately.
	if (creditsLookExhausted && shouldTrustCreditExhaustion) {
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
	const conductor = useConductorStore
		.getState()
		.conductors.find((candidate) => candidate.groupId === groupId);
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
	const parentToolType =
		parentSession.toolType === 'terminal' ? 'claude-code' : parentSession.toolType;
	const primary =
		route.primary === 'workspace-lead' ? (parentToolType as ConductorProviderAgent) : route.primary;
	const candidates = [
		primary,
		route.fallback,
		routeKey !== 'default' ? routing.default.fallback : null,
	].filter(
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
				candidate,
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
			primary,
			`${groupId}:${options.role}:${primary}:${options.taskTitle || options.taskDescription || 'general'}`
		),
	};
}

export async function resolveConductorProviderConfig(
	parentSession: Session,
	options: Pick<
		ConductorAgentRunOptions,
		'role' | 'taskTitle' | 'taskDescription' | 'scopePaths' | 'providerRouteHint'
	>
): Promise<ResolvedConductorProviderConfig> {
	const selectedProvider = await chooseConductorProvider(parentSession, options);
	const useParentOverrides = selectedProvider.toolType === parentSession.toolType;

	return {
		...selectedProvider,
		sessionCustomPath: useParentOverrides ? parentSession.customPath : undefined,
		sessionCustomArgs: useParentOverrides ? parentSession.customArgs : undefined,
		sessionCustomEnvVars: useParentOverrides ? parentSession.customEnvVars : undefined,
		sessionCustomModel: useParentOverrides ? parentSession.customModel : undefined,
		sessionCustomContextWindow: useParentOverrides
			? parentSession.customContextWindow
			: undefined,
		sessionSshRemoteConfig: parentSession.sessionSshRemoteConfig,
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
	const session = useSessionStore
		.getState()
		.sessions.find((candidate) => candidate.id === sessionId);
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

export function appendConductorTurnOutput(
	existing: string,
	chunk: string,
	maxChars: number = MAX_CONDUCTOR_RAW_OUTPUT_CHARS
): string {
	if (!chunk) {
		return existing;
	}

	if (maxChars <= 0) {
		return '';
	}

	const combined = existing + chunk;
	if (combined.length <= maxChars) {
		return combined;
	}

	return combined.slice(-maxChars);
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
	// Conductor planners need a strict prompt contract. Reusing the normal
	// agent system prompt can inject unrelated "write a plan file/playbook"
	// behavior that conflicts with the planner tool/JSON submission flow.
	if (session.conductorMetadata?.isConductorSession && session.conductorMetadata.role === 'planner') {
		return prompt;
	}

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

function resolveConductorExecutionMode(input: {
	toolType: ToolType;
	isSshSession: boolean;
	expectedSubmissionKind?: ConductorStructuredSubmissionKind;
	demoCaptureEnabled: boolean;
}): ConductorExecutionMode {
	if (input.expectedSubmissionKind) {
		return {
			dispatchKind: 'spawn',
			requireNativeStructuredSubmission: false,
		};
	}

	if (
		input.demoCaptureEnabled &&
		!input.isSshSession &&
		input.toolType === 'codex'
	) {
		return {
			dispatchKind: 'conversation',
			requireNativeStructuredSubmission: false,
		};
	}

	return {
		dispatchKind: 'spawn',
		requireNativeStructuredSubmission: false,
	};
}

export function buildConductorSpawnBaseArgs(input: {
	agentArgs: string[];
	toolType: ToolType;
	readOnlyMode: boolean;
	expectedSubmissionKind?: ConductorStructuredSubmissionKind;
}): string[] {
	const strippedArgs = input.readOnlyMode
		? input.agentArgs.filter(
				(arg) =>
					arg !== '--dangerously-skip-permissions' &&
					arg !== '--dangerously-bypass-approvals-and-sandbox'
			)
		: [...input.agentArgs];

	if (
		input.toolType !== 'claude-code' ||
		!input.readOnlyMode ||
		input.expectedSubmissionKind !== 'planner'
	) {
		return strippedArgs;
	}

	if (strippedArgs.includes('--allowedTools')) {
		return strippedArgs;
	}

	return [
		...strippedArgs,
		'--allowedTools',
		...CLAUDE_CONDUCTOR_PLANNER_ALLOWED_TOOLS,
	];
}

export async function runConductorAgentTurn(
	options: ConductorAgentRunOptions
): Promise<ConductorAgentRunResult> {
	if (options.parentSession.toolType === 'terminal') {
		throw new Error('Conductor needs an AI lead agent, not a terminal session.');
	}

	const groupId = options.parentSession.groupId || options.parentSession.workspaceId || '';
	const selectedProvider = options.providerOverride
		? {
				toolType: options.providerOverride,
				callsign: buildConductorCallsign(
					options.providerOverride,
					`${groupId}:${options.role}:${options.providerOverride}:${options.taskTitle || options.taskDescription || 'general'}`
				),
			}
		: await chooseConductorProvider(options.parentSession, {
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
	const promptWithDemoCapture = appendDemoCaptureInstructions(
		effectivePrompt,
		options.demoCapture?.enabled === true
	);
	const baseArgs = buildConductorSpawnBaseArgs({
		agentArgs: agent.args || [],
		toolType: session.toolType,
		readOnlyMode: options.readOnlyMode === true,
		expectedSubmissionKind: options.expectedSubmissionKind,
	});
	const { sendPromptViaStdin, sendPromptViaStdinRaw } = getStdinFlags({
		isSshSession: !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled,
		supportsStreamJsonInput: agent.capabilities?.supportsStreamJsonInput ?? false,
	});
	const executionMode = resolveConductorExecutionMode({
		toolType: session.toolType,
		isSshSession: !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled,
		expectedSubmissionKind: options.expectedSubmissionKind,
		demoCaptureEnabled: options.demoCapture?.enabled === true,
	});

	return new Promise((resolve, reject) => {
		const shouldBufferRawOutput = !executionMode.requireNativeStructuredSubmission;
		let rawOutput = '';
		let assistantStreamResponse = '';
		let agentSessionId: string | undefined;
		let usageStats: UsageStats | undefined;
		let runtimeKind: ConversationRuntimeKind | undefined;
		let structuredSubmission: ConductorStructuredSubmission | undefined;
		let demoCard: DemoCard | undefined;
		let agentError: AgentError | undefined;
		let conversationFailureMessage: string | undefined;
		let forcedFailureMessage: string | undefined;
		let finalized = false;
		let sawBusySession = false;
		let sawTurnActivity = false;
		let idleSessionTimer: number | undefined;
		let toolMismatchTimer: number | undefined;
		let sessionPollTimer: number | undefined;
		const runningToolNamesById = new Map<string, string>();
		let unsubscribeSessionStore = () => {};

		const getRunningToolNamesFromTabLogs = (latestTab: AITab | undefined): string[] => {
			if (!latestTab) {
				return [];
			}

			const runningToolNames = new Map<string, string>();
			for (const logEntry of latestTab.logs || []) {
				if (logEntry.source !== 'tool') {
					continue;
				}

				const toolState = (logEntry.metadata as { toolState?: Record<string, unknown> } | undefined)
					?.toolState;
				const toolId = String(toolState?.id || '').trim();
				const toolStatus = String(toolState?.status || '').toLowerCase();
				const toolName = String(logEntry.text || '').trim();
				if (!toolId || !toolName) {
					continue;
				}

				if (toolStatus === 'completed' || toolStatus === 'error') {
					runningToolNames.delete(toolId);
				} else if (toolStatus) {
					runningToolNames.set(toolId, toolName);
				}
			}

			return Array.from(new Set(runningToolNames.values()));
		};

		const getObservedRunningToolNames = (latestTab?: AITab | undefined): string[] => {
			const names = new Set(runningToolNamesById.values());
			for (const toolName of getRunningToolNamesFromTabLogs(latestTab)) {
				names.add(toolName);
			}
			return Array.from(names);
		};

		const getObservedTab = (latestSession?: Session, preferredTabId?: string): AITab | undefined => {
			const tabs = latestSession?.aiTabs || [];
			if (tabs.length === 0) {
				return undefined;
			}

			return tabs.find((candidate) => candidate.id === preferredTabId) || tabs[tabs.length - 1];
		};

		const clearIdleSessionTimer = () => {
			if (typeof idleSessionTimer === 'number') {
				window.clearTimeout(idleSessionTimer);
				idleSessionTimer = undefined;
			}
		};

		const clearToolMismatchTimer = () => {
			if (typeof toolMismatchTimer === 'number') {
				window.clearTimeout(toolMismatchTimer);
				toolMismatchTimer = undefined;
			}
		};

		const clearSessionPollTimer = () => {
			if (typeof sessionPollTimer === 'number') {
				window.clearInterval(sessionPollTimer);
				sessionPollTimer = undefined;
			}
		};

		const loadLatestDemoCard = async (): Promise<DemoCard | undefined> => {
			if (options.demoCapture?.enabled !== true) {
				return demoCard;
			}

			await new Promise((resolveDelay) => window.setTimeout(resolveDelay, 150));
			const demoCards = await window.maestro.artifacts.listSessionDemos(session.id, activeTab.id);
			if (demoCard?.demoId) {
				return demoCards.find((card) => card.demoId === demoCard?.demoId) || demoCard;
			}
			return demoCards[0] || demoCard;
		};

			const cleanup = () => {
			unsubscribeData();
			unsubscribeAssistantStream?.();
			unsubscribeSessionId();
			unsubscribeUsage();
			unsubscribeSessionStore();
			unsubscribeToolExecution?.();
			unsubscribeDemoGenerated?.();
			unsubscribeAgentError();
			unsubscribeConversationEvent?.();
			unsubscribeQueryComplete?.();
			unsubscribeExit();
				clearIdleSessionTimer();
				clearToolMismatchTimer();
				clearSessionPollTimer();
			};

			const scheduleIdleFinalize = () => {
				if (finalized || typeof idleSessionTimer === 'number') {
					return;
				}
				idleSessionTimer = window.setTimeout(() => {
					idleSessionTimer = undefined;
					if (!finalized) {
						finalizeRun({});
					}
				}, 750);
			};

			const getRunningToolSummary = (_latestSession?: Session, latestTab?: AITab) => {
				const runningToolNames = getObservedRunningToolNames(latestTab);
				return runningToolNames[0] || 'a tool';
			};

			const scheduleToolMismatchFailure = () => {
				if (finalized || typeof toolMismatchTimer === 'number') {
					return;
				}

				toolMismatchTimer = window.setTimeout(() => {
					toolMismatchTimer = undefined;
					if (finalized) {
						return;
					}

					const latestSession = useSessionStore
						.getState()
						.sessions.find((candidate) => candidate.id === session.id);
					const latestTab = getObservedTab(latestSession, activeTab.id);
					if (!latestSession || !latestTab) {
						return;
					}

					if (latestSession.state !== 'idle' || latestTab.state !== 'idle') {
						return;
					}

					const runningToolNames = getObservedRunningToolNames(latestTab);
					if (runningToolNames.length === 0) {
						return;
					}

					forcedFailureMessage = `${session.name} became idle while ${getRunningToolSummary(
						latestSession,
						latestTab
					)} was still running.`;
					finalizeRun({});
				}, 1500);
			};

			const markTurnActivity = () => {
				sawTurnActivity = true;
				clearIdleSessionTimer();
				clearToolMismatchTimer();
				const latestSession = useSessionStore
					.getState()
					.sessions.find((candidate) => candidate.id === session.id);
				const latestTab = getObservedTab(latestSession, activeTab.id);
				if (!latestSession || !latestTab) {
					return;
				}

				const runningToolNames = getObservedRunningToolNames(latestTab);
				if (latestSession.state === 'idle' && latestTab.state === 'idle') {
					if (runningToolNames.length > 0) {
						scheduleToolMismatchFailure();
					} else {
						scheduleIdleFinalize();
					}
				}
			};

			const finalizeRun = (completion: { exitCode?: number }) => {
			if (finalized) {
				return;
			}
			finalized = true;
			cleanup();

			const response =
				extractConductorAgentResponse(session.toolType, rawOutput) ||
				assistantStreamResponse.trim() ||
				getLatestAssistantResponse(session.id, activeTab.id) ||
				'';

			void (async () => {
				const persistedDemoCard = await loadLatestDemoCard();

				if (typeof completion.exitCode === 'number' && completion.exitCode !== 0) {
					reject(
						new ConductorAgentRunError(
							response || `${session.name} exited with code ${completion.exitCode}.`,
							{ demoCard: persistedDemoCard }
						)
					);
					return;
				}

				const hasUsableAgentResult = Boolean(structuredSubmission) || response.trim().length > 0;
				if (agentError?.type === 'demo_capture_failed' && !hasUsableAgentResult) {
					reject(
						new ConductorAgentRunError(agentError.message, {
							demoCard: persistedDemoCard,
						})
					);
					return;
				}

				if (conversationFailureMessage) {
					reject(
						new ConductorAgentRunError(conversationFailureMessage, {
							demoCard: persistedDemoCard,
						})
					);
					return;
				}

				if (forcedFailureMessage) {
					reject(
						new ConductorAgentRunError(forcedFailureMessage, {
							demoCard: persistedDemoCard,
						})
					);
					return;
				}

				const allowPlannerTextFallback =
					executionMode.requireNativeStructuredSubmission &&
					options.expectedSubmissionKind === 'planner' &&
					!structuredSubmission &&
					response.trim().length > 0;

				if (
					executionMode.requireNativeStructuredSubmission &&
					options.expectedSubmissionKind &&
					!structuredSubmission &&
					!allowPlannerTextFallback
				) {
					reject(
						new ConductorAgentRunError(
							`${session.name} finished without calling the required ${options.expectedSubmissionKind} Conductor result tool.`,
							{ demoCard: persistedDemoCard }
						)
					);
					return;
				}

				if (options.expectedSubmissionKind && !structuredSubmission && response.trim().length === 0) {
					reject(
						new ConductorAgentRunError(
							`${session.name} finished without returning a ${options.expectedSubmissionKind} result.`,
							{ demoCard: persistedDemoCard }
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
					runtimeKind,
					structuredSubmission,
					demoCard: persistedDemoCard,
				});
			})().catch((error) => reject(error));
		};

			const unsubscribeData = window.maestro.process.onData((sessionId, data) => {
				if (sessionId === targetSessionId) {
					if (shouldBufferRawOutput) {
						rawOutput = appendConductorTurnOutput(rawOutput, data);
					}
					markTurnActivity();
				}
			});
			const unsubscribeAssistantStream = window.maestro.process.onAssistantStream?.(
				(sessionId, event) => {
					if (sessionId !== targetSessionId) {
						return;
					}

					switch (event.mode) {
						case 'append':
							assistantStreamResponse += event.text || '';
							break;
						case 'replace':
							assistantStreamResponse = event.text || '';
							break;
						case 'discard':
							assistantStreamResponse = '';
							break;
						case 'commit':
						default:
							break;
					}

					markTurnActivity();
				}
			);
			const unsubscribeSessionId = window.maestro.process.onSessionId((sessionId, capturedId) => {
				if (sessionId === targetSessionId) {
					agentSessionId = capturedId;
					markTurnActivity();
				}
			});
			const unsubscribeUsage = window.maestro.process.onUsage((sessionId, nextUsageStats) => {
				if (sessionId === targetSessionId) {
					usageStats = nextUsageStats;
					markTurnActivity();
				}
			});
			const unsubscribeToolExecution = window.maestro.process.onToolExecution?.(
				(sessionId, toolEvent) => {
					if (sessionId !== targetSessionId) {
						return;
					}

					const toolStatus = String(
						(toolEvent.state as Record<string, unknown> | undefined)?.status || ''
					).toLowerCase();
					const toolId = String(
						(toolEvent.state as Record<string, unknown> | undefined)?.id || ''
					).trim();
					if (toolId) {
						if (toolStatus === 'completed' || toolStatus === 'error') {
							runningToolNamesById.delete(toolId);
						} else {
							runningToolNamesById.set(toolId, toolEvent.toolName);
						}
					}

					markTurnActivity();

					if (!options.expectedSubmissionKind || structuredSubmission) {
						return;
					}

				const parsedSubmission = parseConductorStructuredSubmissionFromToolExecution(
					toolEvent.toolName,
					toolEvent.state
				);
				if (!parsedSubmission || parsedSubmission.kind !== options.expectedSubmissionKind) {
					return;
				}

				structuredSubmission = parsedSubmission;
			}
		);
		const unsubscribeDemoGenerated = window.maestro.process.onDemoGenerated?.(
			(baseSessionId, tabId, nextDemoCard) => {
				if (baseSessionId === session.id && (tabId || null) === activeTab.id) {
					demoCard = nextDemoCard;
				}
			}
		);
			const unsubscribeAgentError = window.maestro.process.onAgentError(
				(sessionId, nextAgentError) => {
					if (sessionId === targetSessionId) {
						agentError = nextAgentError as AgentError;
						markTurnActivity();
						if (nextAgentError.type === 'demo_capture_failed') {
							finalizeRun({});
						}
				}
			}
		);
			const unsubscribeConversationEvent = conversationService.onEvent((sessionId, event) => {
				if (sessionId !== targetSessionId) {
					return;
				}

				markTurnActivity();

				if (event.type === 'turn_failed') {
					conversationFailureMessage = event.message;
				finalizeRun({});
				return;
			}

			if (event.type === 'turn_completed') {
				if (event.status === 'failed') {
					conversationFailureMessage =
						conversationFailureMessage || `${session.name} failed to complete the requested turn.`;
				}
				finalizeRun({});
			}
		});
			const unsubscribeQueryComplete = window.maestro.process.onQueryComplete?.(
				(sessionId, queryData) => {
					if (sessionId !== targetSessionId) {
						return;
					}
					markTurnActivity();
					if ((queryData.tabId || activeTab.id) !== activeTab.id) {
						return;
					}
				finalizeRun({});
			}
		);
		const unsubscribeExit = window.maestro.process.onExit((sessionId, exitCode) => {
			if (sessionId !== targetSessionId) {
				return;
			}
			finalizeRun({ exitCode });
		});
			const syncSessionActivity = () => {
				const latestSession = useSessionStore
					.getState()
					.sessions.find((candidate) => candidate.id === session.id);
				const latestTab = getObservedTab(latestSession, activeTab.id);
			if (!latestSession || !latestTab) {
				return;
			}

			const isBusy = latestSession.state === 'busy' || latestTab.state === 'busy';
			if (isBusy) {
				sawBusySession = true;
				clearIdleSessionTimer();
				clearToolMismatchTimer();
				return;
			}

				const runningToolNames = getObservedRunningToolNames(latestTab);
				if (
					!finalized &&
					(sawBusySession || sawTurnActivity) &&
					latestSession.state === 'idle' &&
					latestTab.state === 'idle'
				) {
					if (runningToolNames.length > 0) {
						scheduleToolMismatchFailure();
					} else {
						scheduleIdleFinalize();
					}
				}
			};
		unsubscribeSessionStore = useSessionStore.subscribe(() => {
			syncSessionActivity();
		});
		syncSessionActivity();
		sessionPollTimer = window.setInterval(() => {
			syncSessionActivity();
		}, 500);

		const spawnPromise = executionMode.dispatchKind === 'conversation'
			? conversationService
					.sendTurn({
						sessionId: targetSessionId,
						toolType: session.toolType,
						cwd: session.cwd,
						command: agent.path ?? agent.command,
						args: baseArgs,
						prompt: promptWithDemoCapture,
						agentSessionId: activeTab.agentSessionId ?? undefined,
						readOnlyMode: options.readOnlyMode === true,
						sessionCustomPath: session.customPath,
						sessionCustomArgs: session.customArgs,
						sessionCustomEnvVars: session.customEnvVars,
						sessionCustomModel: session.customModel,
						sessionCustomContextWindow: session.customContextWindow,
						sessionReasoningEffort: activeTab.reasoningEffort ?? 'default',
						sessionSshRemoteConfig: session.sessionSshRemoteConfig,
						querySource: 'auto',
						preferLiveRuntime: true,
						conductorNativeResultTools: executionMode.requireNativeStructuredSubmission,
						demoCapture: options.demoCapture,
					})
					.then((dispatchResult) => {
						runtimeKind = dispatchResult.runtimeKind;
						return dispatchResult;
					})
			: window.maestro.process.spawn({
					sessionId: targetSessionId,
					toolType: session.toolType,
					cwd: session.cwd,
					command: agent.path ?? agent.command,
					args: baseArgs,
					prompt: promptWithDemoCapture,
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
					demoCapture: options.demoCapture,
				});

		spawnPromise.catch((error) => {
			if (!finalized) {
				finalized = true;
				cleanup();
			}

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
