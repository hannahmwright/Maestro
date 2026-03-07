import type { Dispatch, SetStateAction } from 'react';
import type { Session } from '../types';
import { extractQuickTabName } from './tabHelpers';
import { persistTabNameMetadata } from './tabNamePersistence';

interface AutoTabNamingParams {
	session: Session;
	tabId: string;
	userMessage: string;
	setSessions: Dispatch<SetStateAction<Session[]>>;
	getSessions: () => Session[];
	automaticTabNamingEnabled: boolean;
}

function updateTab(
	setSessions: Dispatch<SetStateAction<Session[]>>,
	sessionId: string,
	tabId: string,
	updater: (tab: Session['aiTabs'][number]) => Session['aiTabs'][number]
) {
	setSessions((prev) =>
		prev.map((session) => {
			if (session.id !== sessionId) {
				return session;
			}

			return {
				...session,
				aiTabs: session.aiTabs.map((tab) => (tab.id === tabId ? updater(tab) : tab)),
			};
		})
	);
}

function persistGeneratedNameIfPossible(
	getSessions: () => Session[],
	sessionId: string,
	tabId: string,
	generatedName: string
) {
	const latestSession = getSessions().find((candidate) => candidate.id === sessionId);
	const latestTab = latestSession?.aiTabs.find((tab) => tab.id === tabId);
	if (!latestSession || !latestTab?.agentSessionId) {
		return;
	}

	persistTabNameMetadata({
		agentSessionId: latestTab.agentSessionId,
		name: generatedName,
		projectRoot: latestSession.projectRoot,
		toolType: latestSession.toolType,
		source: 'shared-auto-naming',
	});
}

export function maybeStartAutomaticTabNaming({
	session,
	tabId,
	userMessage,
	setSessions,
	getSessions,
	automaticTabNamingEnabled,
}: AutoTabNamingParams): void {
	const trimmedMessage = userMessage.trim();
	if (!trimmedMessage) {
		return;
	}

	const activeTab = session.aiTabs.find((tab) => tab.id === tabId);
	if (!activeTab || activeTab.agentSessionId || activeTab.name) {
		return;
	}

	if (!automaticTabNamingEnabled) {
		return;
	}

	const quickName = extractQuickTabName(trimmedMessage);
	if (quickName) {
		window.maestro.logger.log('info', `Quick tab named: "${quickName}"`, 'TabNaming', {
			tabId,
			sessionId: session.id,
			quickName,
			source: 'shared-auto-naming',
		});
		updateTab(setSessions, session.id, tabId, (tab) => ({ ...tab, name: quickName }));
		persistGeneratedNameIfPossible(getSessions, session.id, tabId, quickName);
		return;
	}

	updateTab(setSessions, session.id, tabId, (tab) => ({ ...tab, isGeneratingName: true }));

	window.maestro.logger.log('info', 'Auto tab naming started', 'TabNaming', {
		tabId,
		sessionId: session.id,
		agentType: session.toolType,
		messageLength: trimmedMessage.length,
		source: 'shared-auto-naming',
	});

	window.maestro.tabNaming
		.generateTabName({
			userMessage: trimmedMessage,
			agentType: session.toolType,
			cwd: session.cwd,
			sessionSshRemoteConfig: session.sessionSshRemoteConfig,
		})
		.then((generatedName) => {
			updateTab(setSessions, session.id, tabId, (tab) => ({ ...tab, isGeneratingName: false }));

			if (!generatedName) {
				window.maestro.logger.log('warn', 'Auto tab naming returned null', 'TabNaming', {
					tabId,
					sessionId: session.id,
					source: 'shared-auto-naming',
				});
				return;
			}

			setSessions((prev) =>
				prev.map((candidateSession) => {
					if (candidateSession.id !== session.id) {
						return candidateSession;
					}

					const targetTab = candidateSession.aiTabs.find((tab) => tab.id === tabId);
					if (!targetTab || targetTab.name !== null) {
						window.maestro.logger.log(
							'info',
							'Auto tab naming skipped (tab already named)',
							'TabNaming',
							{
								tabId,
								generatedName,
								existingName: targetTab?.name,
								source: 'shared-auto-naming',
							}
						);
						return candidateSession;
					}

					window.maestro.logger.log('info', `Auto tab named: "${generatedName}"`, 'TabNaming', {
						tabId,
						sessionId: session.id,
						generatedName,
						source: 'shared-auto-naming',
					});

					return {
						...candidateSession,
						aiTabs: candidateSession.aiTabs.map((tab) =>
							tab.id === tabId ? { ...tab, name: generatedName } : tab
						),
					};
				})
			);
			persistGeneratedNameIfPossible(getSessions, session.id, tabId, generatedName);
		})
		.catch((error) => {
			window.maestro.logger.log('error', 'Auto tab naming failed', 'TabNaming', {
				tabId,
				sessionId: session.id,
				error: String(error),
				source: 'shared-auto-naming',
			});
			updateTab(setSessions, session.id, tabId, (tab) => ({ ...tab, isGeneratingName: false }));
		});
}
