import type { ConductorProviderAgent, Session, WizardMessage } from '../types';
import { useSettingsStore } from '../stores/settingsStore';
import { getProviderDisplayName } from '../utils/sessionValidation';
import { conductorPlanDiscoveryPrompt } from '../../prompts';
import {
	READY_CONFIDENCE_THRESHOLD,
	endInlineWizardConversation,
	sendWizardMessage,
	startInlineWizardConversation,
	type WizardResponse,
} from './inlineWizardConversation';
import { resolveConductorProviderConfig } from './conductorAgentRuntime';

interface ConductorPlanDiscoveryPromptInput {
	groupName: string;
	projectName: string;
	initialRequest: string;
	operatorNotes: string;
}

export interface ConductorPlanDiscoveryTurnResult {
	response: WizardResponse;
	toolType: ConductorProviderAgent;
	providerLabel: string;
	routedFromLabel?: string;
	reason?: string;
}

function replacePlaceholder(prompt: string, token: string, value: string): string {
	return prompt.replace(new RegExp(`\\{\\{${token}\\}\\}`, 'gi'), () => value);
}

function buildConductorPlanDiscoveryPrompt(
	input: ConductorPlanDiscoveryPromptInput
): string {
	return [
		['GROUP_NAME', input.groupName.trim() || 'Unnamed Workspace'],
		['PROJECT_NAME', input.projectName.trim() || 'this project'],
		['INITIAL_REQUEST', input.initialRequest.trim() || 'No request provided.'],
		['OPERATOR_NOTES', input.operatorNotes.trim() || 'No additional operator notes.'],
		['READY_CONFIDENCE_THRESHOLD', String(READY_CONFIDENCE_THRESHOLD)],
	].reduce(
		(prompt, [token, value]) => replacePlaceholder(prompt, token, value),
		conductorPlanDiscoveryPrompt
	);
}

async function getHistoryFilePath(parentSession: Session): Promise<string | undefined> {
	if (parentSession.sshRemoteId || parentSession.sessionSshRemoteConfig?.enabled) {
		return undefined;
	}

	try {
		return (await window.maestro.history.getFilePath(parentSession.id)) || undefined;
	} catch {
		return undefined;
	}
}

export async function sendConductorPlanDiscoveryTurn(input: {
	parentSession: Session;
	groupName: string;
	initialRequest: string;
	operatorNotes: string;
	conversationHistory: WizardMessage[];
	userMessage: string;
}): Promise<ConductorPlanDiscoveryTurnResult> {
	const providerConfig = await resolveConductorProviderConfig(input.parentSession, {
		role: 'planner',
		taskTitle: input.initialRequest.trim(),
		taskDescription: input.initialRequest.trim(),
		providerRouteHint: 'default',
	});
	const conductorProfile = useSettingsStore.getState().conductorProfile;
	const historyFilePath = await getHistoryFilePath(input.parentSession);
	const session = startInlineWizardConversation({
		mode: 'new',
		agentType: providerConfig.toolType,
		directoryPath: input.parentSession.cwd,
		projectName: input.groupName.trim() || input.parentSession.name,
		sessionSshRemoteConfig: providerConfig.sessionSshRemoteConfig,
		sessionCustomPath: providerConfig.sessionCustomPath,
		sessionCustomArgs: providerConfig.sessionCustomArgs,
		sessionCustomEnvVars: providerConfig.sessionCustomEnvVars,
		sessionCustomModel: providerConfig.sessionCustomModel,
		sessionCustomContextWindow: providerConfig.sessionCustomContextWindow,
		conductorProfile,
		historyFilePath,
		systemPromptOverride: buildConductorPlanDiscoveryPrompt({
			groupName: input.groupName,
			projectName: input.parentSession.name,
			initialRequest: input.initialRequest,
			operatorNotes: input.operatorNotes,
		}),
	});

	try {
		const result = await sendWizardMessage(
			session,
			input.userMessage,
			input.conversationHistory
		);
		if (!result.success || !result.response) {
			throw new Error(result.error || 'Conductor discovery did not return a usable response.');
		}

		return {
			response: result.response,
			toolType: providerConfig.toolType,
			providerLabel: getProviderDisplayName(providerConfig.toolType),
			routedFromLabel: providerConfig.routedFrom
				? getProviderDisplayName(providerConfig.routedFrom)
				: undefined,
			reason: providerConfig.reason,
		};
	} finally {
		await endInlineWizardConversation(session);
	}
}

export function buildConductorPlanDiscoveryHandoff(input: {
	operatorNotes: string;
	conversationHistory: WizardMessage[];
}): string {
	const sections: string[] = [];
	const trimmedNotes = input.operatorNotes.trim();
	if (trimmedNotes) {
		sections.push(`Operator notes:\n${trimmedNotes}`);
	}

	const assistantMessages = input.conversationHistory.filter(
		(message): message is WizardMessage & { role: 'assistant' } => message.role === 'assistant'
	);
	const readySummary =
		[...assistantMessages].reverse().find((message) => message.ready && message.content.trim()) ||
		[...assistantMessages].reverse().find((message) => message.content.trim());
	if (readySummary) {
		sections.push(`Discovery summary:\n${readySummary.content.trim()}`);
	}

	const followUpAnswers = input.conversationHistory
		.filter((message) => message.role === 'user')
		.slice(1)
		.map((message) => message.content.trim())
		.filter(Boolean);
	if (followUpAnswers.length > 0) {
		sections.push(
			`Operator follow-up answers:\n${followUpAnswers.map((answer) => `- ${answer}`).join('\n')}`
		);
	}

	return sections.join('\n\n').trim();
}
