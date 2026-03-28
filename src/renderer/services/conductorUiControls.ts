import type { Session } from '../types';

export interface ConductorUiThreadTarget {
	sessionId: string;
	tabId?: string;
}

export interface ConductorUiTeamMember {
	sessionId: string;
	name: string;
	threadTargets: ConductorUiThreadTarget[];
}

export type ConductorThreadNavigationEffect =
	| {
			sessionId: string;
			sessionPatch?: Pick<Session, 'activeTabId' | 'activeFileTabId' | 'inputMode'>;
	  }
	| null;

export function resolveConductorAgentSessionSelection(
	sessionById: Map<string, unknown>,
	sessionId: string
): string | null {
	return sessionById.has(sessionId) ? sessionId : null;
}

export function resolveConductorThreadNavigation(input: {
	sessionById: Map<string, Pick<Session, 'activeTabId'>>;
	sessionId: string;
	tabId?: string;
}): ConductorThreadNavigationEffect {
	const session = input.sessionById.get(input.sessionId);
	if (!session) {
		return null;
	}

	if (input.tabId && session.activeTabId !== input.tabId) {
		return {
			sessionId: input.sessionId,
			sessionPatch: {
				activeTabId: input.tabId,
				activeFileTabId: null,
				inputMode: 'ai',
			},
		};
	}

	return {
		sessionId: input.sessionId,
	};
}

export function resolveConductorTeamMemberOpen(
	member: ConductorUiTeamMember
):
	| {
			kind: 'navigate';
			sessionId: string;
			tabId?: string;
	  }
	| {
			kind: 'select_member';
	  } {
	if (member.threadTargets.length <= 1) {
		const target = member.threadTargets[0];
		return {
			kind: 'navigate',
			sessionId: target?.sessionId || member.sessionId,
			tabId: target?.tabId,
		};
	}

	return {
		kind: 'select_member',
	};
}

export function findConductorTeamMemberByName<T extends ConductorUiTeamMember>(
	members: T[],
	memberName: string
): T | null {
	return members.find((candidate) => candidate.name === memberName) || null;
}

export function resolveConductorWorktreeStorageOpen(
	selectedTemplate: Pick<Session, 'id'> | null
):
	| {
			kind: 'open_modal';
			activeSessionId: string;
	  }
	| {
			kind: 'missing_template';
			toastTitle: string;
			toastMessage: string;
	  } {
	if (!selectedTemplate) {
		return {
			kind: 'missing_template',
			toastTitle: 'No workspace lead yet',
			toastMessage:
				'Add a workspace lead agent first so Conductor knows where to store worktrees.',
		};
	}

	return {
		kind: 'open_modal',
		activeSessionId: selectedTemplate.id,
	};
}

export function collectIdleConductorAgentSessionIds<T extends Pick<Session, 'id' | 'state'>>(
	sessions: T[]
): string[] {
	return sessions.filter((session) => session.state !== 'busy').map((session) => session.id);
}
