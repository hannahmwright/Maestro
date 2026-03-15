import { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import Store from 'electron-store';
import * as os from 'os';
import { logger } from '../utils/logger';
import { addBreadcrumb } from '../utils/sentry';
import { isWebContentsAvailable } from '../utils/safe-send';
import { AgentDetector } from '../agents';
import {
	buildAgentArgs,
	applyAgentConfigOverrides,
	getContextWindowValue,
} from '../utils/agent-args';
import { getSshRemoteConfig, createSshRemoteStoreAdapter } from '../utils/ssh-remote-resolver';
import { buildSshCommandWithStdin } from '../utils/ssh-command-builder';
import { buildStreamJsonMessage } from './utils/streamJsonBuilder';
import { getWindowsShellForAgentExecution } from './utils/shellEscape';
import { readLocalCodexModel, readRemoteCodexModel } from '../utils/codex-config';
import { buildExpandedEnv } from '../../shared/pathUtils';
import type { SshRemoteConfig } from '../../shared/types';
import { MAESTRO_DEMO_EVENT_PREFIX } from '../../shared/demo-artifacts';
import { powerManager } from '../power-manager';
import type { MaestroSettings } from '../ipc/handlers/persistence';
import type { ProcessConfig, SpawnResult } from './types';
import type { ProcessManager } from './ProcessManager';
import { getDemoArtifactService } from '../artifacts';
import {
	buildDemoContextFilePath,
	ensureMaestroDemoCommand,
	extractRequestedTarget,
	prependPathEntry,
	writeDemoTurnContextFile,
} from '../artifacts/maestroDemoRuntime';

const LOG_CONTEXT = '[SpawnDispatcher]';

export interface AgentConfigsData {
	configs: Record<string, Record<string, any>>;
}

export interface SpawnDispatchRequest {
	sessionId: string;
	toolType: string;
	cwd: string;
	command: string;
	args: string[];
	prompt?: string;
	shell?: string;
	images?: string[];
	taskContractInput?: ProcessConfig['taskContractInput'];
	sendPromptViaStdin?: boolean;
	sendPromptViaStdinRaw?: boolean;
	agentSessionId?: string;
	readOnlyMode?: boolean;
	modelId?: string;
	yoloMode?: boolean;
	sessionCustomPath?: string;
	sessionCustomArgs?: string;
	sessionCustomEnvVars?: Record<string, string>;
	sessionCustomModel?: string;
	sessionCustomContextWindow?: number;
	sessionReasoningEffort?: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	querySource?: 'user' | 'auto';
	tabId?: string;
	demoCapture?: {
		enabled: boolean;
	};
}

export interface SpawnDispatchDependencies {
	processManager: ProcessManager;
	agentDetector: AgentDetector;
	agentConfigsStore: Store<AgentConfigsData>;
	settingsStore: Store<MaestroSettings>;
	getMainWindow?: () => BrowserWindow | null;
}

export interface PreparedSpawnContext {
	processManager: ProcessManager;
	spawnConfig: ProcessConfig;
	sshRemoteUsed: SshRemoteConfig | null;
}

export interface DispatchSpawnOptions {
	logContext?: string;
	spawnConfigOverrides?: Partial<ProcessConfig>;
	spawnStrategy?: (context: PreparedSpawnContext) => SpawnResult;
}

function getSshRemoteById(
	store: Store<MaestroSettings>,
	sshRemoteId?: string | null
): SshRemoteConfig | undefined {
	if (!sshRemoteId) {
		return undefined;
	}

	const sshRemotes = store.get('sshRemotes', []) as SshRemoteConfig[];
	return sshRemotes.find((remote) => remote.id === sshRemoteId);
}

function defaultSpawnStrategy({ processManager, spawnConfig, sshRemoteUsed }: PreparedSpawnContext) {
	const useCodexAppServerBridge =
		spawnConfig.toolType === 'codex' &&
		spawnConfig.readOnlyMode === true &&
		!sshRemoteUsed &&
		spawnConfig.conversationRuntime !== 'live';
	return useCodexAppServerBridge
		? processManager.spawnCodexAppServer(spawnConfig)
		: processManager.spawn(spawnConfig);
}

export async function prepareSpawnContext(
	deps: SpawnDispatchDependencies,
	request: SpawnDispatchRequest,
	options?: Pick<DispatchSpawnOptions, 'logContext' | 'spawnConfigOverrides'>
): Promise<PreparedSpawnContext> {
	const logContext = options?.logContext || LOG_CONTEXT;
	const agent = await deps.agentDetector.getAgent(request.toolType);
	const isWindows = process.platform === 'win32';
	const logFn = isWindows ? logger.info.bind(logger) : logger.debug.bind(logger);

	logFn('Spawn config received', logContext, {
		platform: process.platform,
		configToolType: request.toolType,
		configCommand: request.command,
		agentId: agent?.id,
		agentCommand: agent?.command,
		agentPath: agent?.path,
		agentPathExtension: agent?.path ? require('path').extname(agent.path) : 'none',
		hasAgentSessionId: !!request.agentSessionId,
		hasPrompt: !!request.prompt,
		promptLength: request.prompt?.length,
		promptPreview:
			request.prompt && isWindows
				? {
						first50: request.prompt.substring(0, 50),
						last50: request.prompt.substring(Math.max(0, request.prompt.length - 50)),
						containsHash: request.prompt.includes('#'),
						containsNewline: request.prompt.includes('\n'),
					}
				: undefined,
		hasSessionSshRemoteConfig: !!request.sessionSshRemoteConfig,
		sessionSshRemoteConfig: request.sessionSshRemoteConfig
			? {
					enabled: request.sessionSshRemoteConfig.enabled,
					remoteId: request.sessionSshRemoteConfig.remoteId,
					hasWorkingDirOverride: !!request.sessionSshRemoteConfig.workingDirOverride,
				}
			: null,
	});

	let finalArgs = buildAgentArgs(agent, {
		baseArgs: request.args,
		prompt: request.prompt,
		cwd: request.cwd,
		readOnlyMode: request.readOnlyMode,
		modelId: request.modelId,
		yoloMode: request.yoloMode,
		agentSessionId: request.agentSessionId,
	});

	const allConfigs = deps.agentConfigsStore.get('configs', {});
	const agentConfigValues = allConfigs[request.toolType] || {};
	const configResolution = applyAgentConfigOverrides(agent, finalArgs, {
		agentConfigValues,
		sessionCustomModel: request.sessionCustomModel,
		sessionCustomArgs: request.sessionCustomArgs,
		sessionCustomEnvVars: request.sessionCustomEnvVars,
	});
	finalArgs = configResolution.args;

	let resolvedModel =
		configResolution.effectiveModel ||
		(typeof request.modelId === 'string' && request.modelId.trim() ? request.modelId.trim() : undefined);

	if (!resolvedModel && request.toolType === 'codex') {
		const sshRemoteId =
			request.sessionSshRemoteConfig?.enabled && request.sessionSshRemoteConfig.remoteId
				? request.sessionSshRemoteConfig.remoteId
				: null;
		const sshRemote = getSshRemoteById(deps.settingsStore, sshRemoteId);
		resolvedModel = sshRemote
			? (await readRemoteCodexModel(sshRemote)) || undefined
			: readLocalCodexModel() || undefined;
	}

	if (
		request.toolType === 'codex' &&
		request.sessionReasoningEffort &&
		request.sessionReasoningEffort !== 'default'
	) {
		const strippedArgs: string[] = [];
		for (let i = 0; i < finalArgs.length; i++) {
			const current = finalArgs[i];
			const next = finalArgs[i + 1];
			if (current === '-c' && typeof next === 'string' && next.includes('model_reasoning_effort')) {
				i++;
				continue;
			}
			strippedArgs.push(current);
		}
		finalArgs = [
			...strippedArgs,
			'-c',
			`model_reasoning_effort="${request.sessionReasoningEffort}"`,
		];
	}

	let effectiveCustomEnvVars = configResolution.effectiveCustomEnvVars;
	if (request.readOnlyMode && agent?.readOnlyEnvOverrides) {
		effectiveCustomEnvVars = {
			...(effectiveCustomEnvVars || {}),
			...agent.readOnlyEnvOverrides,
		};
	}

	let shellToUse =
		request.shell ||
		(request.toolType === 'terminal' ? deps.settingsStore.get('defaultShell', 'zsh') : undefined);
	let shellArgsStr: string | undefined;

	const globalShellEnvVars = deps.settingsStore.get('shellEnvVars', {}) as Record<string, string>;

	if (request.toolType === 'terminal') {
		const customShellPath = deps.settingsStore.get('customShellPath', '');
		if (customShellPath && customShellPath.trim()) {
			shellToUse = customShellPath.trim();
		}
		shellArgsStr = deps.settingsStore.get('shellArgs', '');
	}

	await addBreadcrumb('agent', `Spawn: ${request.toolType}`, {
		sessionId: request.sessionId,
		toolType: request.toolType,
		command: request.command,
		hasPrompt: !!request.prompt,
	});

	const contextWindow = getContextWindowValue(
		agent,
		agentConfigValues,
		request.sessionCustomContextWindow
	);

	let commandToSpawn = request.sessionCustomPath || request.command;
	let argsToSpawn = finalArgs;
	let useShell = false;
	let sshRemoteUsed: SshRemoteConfig | null = null;
	let customEnvVarsToPass: Record<string, string> | undefined = effectiveCustomEnvVars;
	let sshStdinScript: string | undefined;
	const effectiveConversationRuntime = options?.spawnConfigOverrides?.conversationRuntime;
	const shouldProvisionDemoRuntime =
		request.toolType !== 'terminal' &&
		request.sessionSshRemoteConfig?.enabled !== true &&
		(request.demoCapture?.enabled === true ||
			effectiveConversationRuntime === 'live' ||
			request.toolType === 'claude-code' ||
			request.toolType === 'codex');
	let demoCaptureContext: ProcessConfig['demoCaptureContext'];

	if (shouldProvisionDemoRuntime) {
		const outputDir = 'output/playwright';
		const provisionalTurnId = randomUUID();
		const turnToken = randomUUID();
		const { binDir } = await ensureMaestroDemoCommand();
		const { contextFilePath, stateFilePath } = buildDemoContextFilePath(
			request.sessionId,
			request.tabId || null
		);
		demoCaptureContext = await getDemoArtifactService().prepareDemoTurn({
			sessionId: request.sessionId,
			tabId: request.tabId || null,
			turnId: provisionalTurnId,
			turnToken,
			provider: request.toolType,
			model: resolvedModel || request.sessionCustomModel || null,
			requestedTarget: extractRequestedTarget(request.prompt),
			contextFilePath,
			stateFilePath,
			outputDir,
		});
		await writeDemoTurnContextFile(demoCaptureContext);
		customEnvVarsToPass = {
			...(customEnvVarsToPass || {}),
			MAESTRO_DEMO_CAPTURE: request.demoCapture?.enabled ? '1' : '0',
			MAESTRO_DEMO_EVENT_PREFIX,
			MAESTRO_DEMO_RUN_ID: demoCaptureContext.externalRunId,
			MAESTRO_DEMO_OUTPUT_DIR: outputDir,
			MAESTRO_DEMO_CONTEXT_FILE: demoCaptureContext.contextFilePath,
			MAESTRO_DEMO_TURN_ID: demoCaptureContext.turnId,
			MAESTRO_DEMO_TURN_TOKEN: demoCaptureContext.turnToken,
			MAESTRO_DEMO_BIN: 'maestro-demo',
			PATH: prependPathEntry(
				customEnvVarsToPass?.PATH || process.env.PATH || '',
				binDir
			),
		};
	}

	if (isWindows && !request.sessionSshRemoteConfig?.enabled) {
		const expandedEnv = buildExpandedEnv(customEnvVarsToPass);
		customEnvVarsToPass = Object.fromEntries(
			Object.entries(expandedEnv).filter(([_, value]) => value !== undefined)
		) as Record<string, string>;

		const customShellPath = deps.settingsStore.get('customShellPath', '') as string;
		const shellConfig = getWindowsShellForAgentExecution({
			customShellPath,
			currentShell: shellToUse,
		});
		shellToUse = shellConfig.shell;
		useShell = shellConfig.useShell;
	}

	if (request.toolType !== 'terminal' && request.sessionSshRemoteConfig?.enabled) {
		const sshStoreAdapter = createSshRemoteStoreAdapter(deps.settingsStore);
		const sshResult = getSshRemoteConfig(sshStoreAdapter, {
			sessionSshConfig: request.sessionSshRemoteConfig,
		});

		if (sshResult.config) {
			sshRemoteUsed = sshResult.config;
			const remoteCommand = request.sessionCustomPath || agent?.binaryName || request.command;
			const hasImages = request.images && request.images.length > 0;
			let sshArgs = finalArgs;
			let stdinInput: string | undefined = request.prompt;

			if (hasImages && request.prompt && agent?.capabilities?.supportsStreamJsonInput) {
				stdinInput = buildStreamJsonMessage(request.prompt, request.images!) + '\n';
				if (!sshArgs.includes('--input-format')) {
					sshArgs = [...sshArgs, '--input-format', 'stream-json'];
				}
			}

			const isResumeWithImages =
				hasImages &&
				agent?.capabilities?.imageResumeMode === 'prompt-embed' &&
				request.agentSessionId;

			const mergedSshEnvVars = { ...globalShellEnvVars, ...(effectiveCustomEnvVars || {}) };
			const sshCommand = await buildSshCommandWithStdin(sshResult.config, {
				command: remoteCommand,
				args: sshArgs,
				cwd: request.cwd,
				env: mergedSshEnvVars,
				stdinInput,
				images:
					hasImages && agent?.imageArgs && !agent?.capabilities?.supportsStreamJsonInput
						? request.images
						: undefined,
				imageArgs:
					hasImages && agent?.imageArgs && !agent?.capabilities?.supportsStreamJsonInput
						? agent.imageArgs
						: undefined,
				imageResumeMode: isResumeWithImages ? 'prompt-embed' : undefined,
			});

			commandToSpawn = sshCommand.command;
			argsToSpawn = sshCommand.args;
			sshStdinScript = sshCommand.stdinScript;
			customEnvVarsToPass = undefined;
			useShell = false;
			shellToUse = undefined;
		}
	}

	const baseSpawnConfig: ProcessConfig = {
		...request,
		command: commandToSpawn,
		args: argsToSpawn,
		cwd: sshRemoteUsed ? os.homedir() : request.cwd,
		requiresPty: sshRemoteUsed ? false : agent?.requiresPty,
		prompt: sshRemoteUsed ? undefined : request.prompt,
		shell: shellToUse,
		runInShell: useShell,
		shellArgs: shellArgsStr,
		shellEnvVars: globalShellEnvVars,
		contextWindow,
		customEnvVars: customEnvVarsToPass,
		imageArgs: agent?.imageArgs,
		promptArgs: agent?.promptArgs,
		noPromptSeparator: agent?.noPromptSeparator,
		projectPath: request.cwd,
		resolvedModel,
		sshRemoteId: sshRemoteUsed?.id,
		sshRemoteHost: sshRemoteUsed?.host,
		sshStdinScript,
		demoCaptureContext,
	};

	return {
		processManager: deps.processManager,
		spawnConfig: {
			...baseSpawnConfig,
			...(options?.spawnConfigOverrides || {}),
		},
		sshRemoteUsed,
	};
}

export async function dispatchProcessSpawn(
	deps: SpawnDispatchDependencies,
	request: SpawnDispatchRequest,
	options?: DispatchSpawnOptions
): Promise<
	SpawnResult & {
		sshRemote?: {
			id: string;
			name: string;
			host: string;
		};
	}
> {
	const prepared = await prepareSpawnContext(deps, request, options);
	const spawnStrategy = options?.spawnStrategy || defaultSpawnStrategy;
	const result = spawnStrategy(prepared);
	const sshRemoteInfo = prepared.sshRemoteUsed
		? {
				id: prepared.sshRemoteUsed.id,
				name: prepared.sshRemoteUsed.name,
				host: prepared.sshRemoteUsed.host,
			}
		: undefined;

	if (request.toolType !== 'terminal') {
		powerManager.addBlockReason(`session:${request.sessionId}`);
	}

	const mainWindow = deps.getMainWindow?.();
	if (isWebContentsAvailable(mainWindow)) {
		mainWindow.webContents.send('process:ssh-remote', request.sessionId, sshRemoteInfo || null);
	}

	return {
		...result,
		sshRemote: sshRemoteInfo,
	};
}
