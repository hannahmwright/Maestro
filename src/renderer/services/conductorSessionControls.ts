import type {
	ConductorAgentRole,
	ConductorTask,
	ConductorTaskAttentionRequest,
	Session,
	Thread,
} from '../types';

export interface ConductorTaskAgentBadge {
	key: string;
	label: string;
	sessionId: string;
	tone: 'default' | 'accent' | 'success' | 'warning';
}

export function buildConductorTaskAttentionRequest(input: {
	kind: ConductorTaskAttentionRequest['kind'];
	summary: string;
	requestedAction: string;
	requestedByRole: ConductorTaskAttentionRequest['requestedByRole'];
	requestedBySessionId?: string;
	suggestedResponse?: string;
	runId?: string;
	generateId: () => string;
	now?: number;
}): ConductorTaskAttentionRequest {
	const now = input.now ?? Date.now();
	return {
		id: `conductor-task-attention-${input.generateId()}`,
		status: 'open',
		kind: input.kind,
		summary: input.summary,
		requestedAction: input.requestedAction,
		requestedByRole: input.requestedByRole,
		requestedBySessionId: input.requestedBySessionId,
		suggestedResponse: input.suggestedResponse,
		runId: input.runId,
		createdAt: now,
		updatedAt: now,
	};
}

export function cleanupConductorAgentSessionState(input: {
	sessionIds: string[];
	force?: boolean;
	preserveWhilePaused?: boolean;
	keepConductorAgentSessions?: boolean;
	isPaused: boolean;
	threads: Thread[];
	sessions: Session[];
	activeSessionId: string;
	selectedTemplateId?: string;
}): { threads: Thread[]; sessions: Session[]; activeSessionId: string } | null {
	const force = input.force ?? false;
	const preserveWhilePaused = input.preserveWhilePaused ?? true;

	if (
		(!force && input.keepConductorAgentSessions) ||
		(!force && preserveWhilePaused && input.isPaused) ||
		input.sessionIds.length === 0
	) {
		return null;
	}

	const removableIds = new Set(input.sessionIds.filter(Boolean));
	if (removableIds.size === 0) {
		return null;
	}

	const threads = input.threads.filter(
		(thread) =>
			!removableIds.has(thread.sessionId) &&
			!removableIds.has(thread.runtimeId || thread.sessionId)
	);
	const sessions = input.sessions.filter((session) => !removableIds.has(session.id));
	const activeSessionId = removableIds.has(input.activeSessionId)
		? input.selectedTemplateId && !removableIds.has(input.selectedTemplateId)
			? input.selectedTemplateId
			: sessions[0]?.id || ''
		: input.activeSessionId;

	return {
		threads,
		sessions,
		activeSessionId,
	};
}

export function buildConductorTaskAgentBadges(input: {
	task: ConductorTask;
	sessionById: Map<string, Pick<Session, 'state'>>;
	sessionNameById: Map<string, string>;
	formatRoleLabel: (role: ConductorAgentRole) => string;
}): ConductorTaskAgentBadge[] {
	const sessionRefs = [
		{
			role: 'planner' as const,
			sessionId: input.task.plannerSessionId,
			sessionName: input.task.plannerSessionName,
		},
		{
			role: 'worker' as const,
			sessionId: input.task.workerSessionId,
			sessionName: input.task.workerSessionName,
		},
		{
			role: 'reviewer' as const,
			sessionId: input.task.reviewerSessionId,
			sessionName: input.task.reviewerSessionName,
		},
	].flatMap((candidate) =>
		candidate.sessionId
			? [
					{
						role: candidate.role,
						sessionId: candidate.sessionId,
						sessionName: candidate.sessionName,
					},
				]
			: []
	);
	const historyRefs = (input.task.agentHistory || []).map((entry) => ({
		role: entry.role,
		sessionId: entry.sessionId,
		sessionName: entry.sessionName,
	}));
	const uniqueRefs = [...historyRefs, ...sessionRefs].filter(
		(candidate, index, candidates) =>
			candidates.findIndex(
				(entry) => entry.role === candidate.role && entry.sessionId === candidate.sessionId
			) === index
	);

	return uniqueRefs.map(({ role, sessionId, sessionName }) => {
		const session = input.sessionById.get(sessionId);
		return {
			key: `${input.task.id}-${role}-${sessionId}`,
			sessionId,
			label: `${input.formatRoleLabel(role)}: ${
				sessionName ||
				(role === 'planner'
					? input.task.plannerSessionName
					: role === 'worker'
						? input.task.workerSessionName
						: input.task.reviewerSessionName) ||
				input.sessionNameById.get(sessionId) ||
				input.formatRoleLabel(role)
			}`,
			tone:
				session?.state === 'busy'
					? 'accent'
					: role === 'reviewer'
						? 'warning'
						: role === 'worker'
							? 'success'
							: 'default',
		};
	});
}
