import type { Session, Thread } from '../types';
import {
	getRuntimeIdForThread,
	getSessionLastActivity,
	isConductorHelperLikeSession,
} from '../utils/workspaceThreads';

export function isConductorHelperSession(session: Session): boolean {
	return isConductorHelperLikeSession(session);
}

export function selectConductorLeadSession(input: {
	groupId: string;
	sessions: Session[];
	threads: Thread[];
}): Session | null {
	const groupSessions = input.sessions.filter(
		(session) =>
			session.groupId === input.groupId &&
			!session.parentSessionId &&
			!session.conductorMetadata?.isConductorSession &&
			session.toolType !== 'terminal'
	);

	const preferredSessions = groupSessions.filter((session) => !isConductorHelperSession(session));
	const candidateSessions = preferredSessions.length > 0 ? preferredSessions : groupSessions;

	const sessionsByRuntimeId = new Map(
		candidateSessions.map((session) => [session.runtimeId || session.id, session] as const)
	);
	const workspaceThreads = input.threads
		.filter(
			(thread) =>
				thread.workspaceId === input.groupId &&
				sessionsByRuntimeId.has(getRuntimeIdForThread(thread))
		)
		.sort((left, right) => {
			const leftSession = sessionsByRuntimeId.get(getRuntimeIdForThread(left));
			const rightSession = sessionsByRuntimeId.get(getRuntimeIdForThread(right));
			const leftActivity = Math.max(
				left.lastUsedAt,
				leftSession ? getSessionLastActivity(leftSession) : 0
			);
			const rightActivity = Math.max(
				right.lastUsedAt,
				rightSession ? getSessionLastActivity(rightSession) : 0
			);
			return rightActivity - leftActivity;
		});

	const threadLead = workspaceThreads[0]
		? sessionsByRuntimeId.get(getRuntimeIdForThread(workspaceThreads[0])) || null
		: null;
	if (threadLead) {
		return threadLead;
	}

	return (
		[...candidateSessions].sort(
			(left, right) => getSessionLastActivity(right) - getSessionLastActivity(left)
		)[0] || null
	);
}
