import type { Group, Session, Thread } from '../types';
import { generateId } from './ids';
import { useSettingsStore } from '../stores/settingsStore';

function normalizePath(path: string | undefined): string {
	return (path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function getPreferredThreadTitle(
	session: Pick<Session, 'name' | 'activeTabId' | 'aiTabs'>,
	existingTitle?: string
): string {
	const activeTab = session.aiTabs?.find((tab) => tab.id === session.activeTabId);
	const namedTab =
		(activeTab?.name?.trim() ? activeTab : undefined) ||
		session.aiTabs?.find((tab) => tab.name?.trim());

	if (namedTab?.name?.trim() && (!existingTitle || existingTitle === session.name)) {
		return namedTab.name.trim();
	}

	return existingTitle || session.name;
}

export function getThreadDisplayTitle(
	thread: Pick<Thread, 'title' | 'tabId'> | null | undefined,
	session: Pick<Session, 'name' | 'activeTabId' | 'aiTabs'>
): string {
	const targetTabId = thread ? getThreadTabId(thread, session) : session.activeTabId || session.aiTabs?.[0]?.id;
	const targetTab = session.aiTabs?.find((tab) => tab.id === targetTabId);
	const namedTab =
		(targetTab?.name?.trim() ? targetTab : undefined) ||
		session.aiTabs?.find((tab) => tab.name?.trim());

	if (namedTab?.name?.trim() && (!thread?.title || thread.title === session.name)) {
		return namedTab.name.trim();
	}

	return thread?.title || session.name;
}

export function getProjectRootForSession(session: Pick<Session, 'projectRoot' | 'cwd'>): string {
	return session.projectRoot || session.cwd;
}

export function getWorkspaceDisplayName(projectRoot: string): string {
	const normalized = (projectRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
	if (!normalized) return 'Workspace';
	const parts = normalized.split('/');
	return parts[parts.length - 1] || normalized;
}

export function getSessionLastActivity(session: Pick<Session, 'aiTabs' | 'shellLogs'>): number {
	const aiTimestamps =
		session.aiTabs?.flatMap((tab) => tab.logs?.map((log) => log.timestamp) || []) || [];
	const shellTimestamps = session.shellLogs?.map((log) => log.timestamp) || [];
	const lastActivity = Math.max(0, ...aiTimestamps, ...shellTimestamps);
	return lastActivity || Date.now();
}

type MutableSession = Session & {
	groupId?: string;
	workspaceId?: string;
	threadId?: string;
	runtimeId?: string;
};

export function getRuntimeIdForSession(session: Pick<Session, 'id' | 'runtimeId'>): string {
	return session.runtimeId || session.id;
}

export function getRuntimeIdForThread(thread: Pick<Thread, 'runtimeId' | 'sessionId'>): string {
	return thread.runtimeId || thread.sessionId;
}

export function getThreadTabId(
	thread: Pick<Thread, 'tabId'>,
	session: Pick<Session, 'activeTabId' | 'aiTabs'>
): string | null {
	if (thread.tabId && session.aiTabs?.some((tab) => tab.id === thread.tabId)) {
		return thread.tabId;
	}

	if (session.activeTabId && session.aiTabs?.some((tab) => tab.id === session.activeTabId)) {
		return session.activeTabId;
	}

	return session.aiTabs?.[0]?.id || null;
}

export function isThreadActiveForSession(
	thread: Pick<Thread, 'runtimeId' | 'sessionId' | 'tabId'>,
	session: Pick<Session, 'id' | 'runtimeId' | 'activeTabId' | 'aiTabs'>
): boolean {
	if (getRuntimeIdForThread(thread) !== getRuntimeIdForSession(session)) {
		return false;
	}

	const resolvedTabId = getThreadTabId(thread, session);
	return resolvedTabId ? resolvedTabId === session.activeTabId : true;
}

export function findActiveThreadForSession(
	threads: Thread[],
	session: Pick<Session, 'id' | 'runtimeId' | 'activeTabId' | 'aiTabs'>
): Thread | null {
	const matchingThreads = threads.filter(
		(thread) => getRuntimeIdForThread(thread) === getRuntimeIdForSession(session)
	);
	if (matchingThreads.length === 0) {
		return null;
	}

	const exactMatch =
		matchingThreads.find((thread) => isThreadActiveForSession(thread, session)) || null;
	if (exactMatch) {
		return exactMatch;
	}

	return matchingThreads[0] || null;
}

export function migrateWorkspacesAndThreads(
	savedSessions: Session[],
	savedGroups: Group[],
	activeSessionId?: string
): {
	sessions: Session[];
	groups: Group[];
	threads: Thread[];
} {
	const topLevelSessions = savedSessions.filter((session) => !session.parentSessionId);
	const repoToSessions = new Map<string, Session[]>();

	for (const session of topLevelSessions) {
		const projectRoot = getProjectRootForSession(session);
		const key = normalizePath(projectRoot);
		const existing = repoToSessions.get(key);
		if (existing) {
			existing.push(session);
		} else {
			repoToSessions.set(key, [session]);
		}
	}

	const groupById = new Map(savedGroups.map((group) => [group.id, group]));
	const repoToWorkspace = new Map<
		string,
		{
			id: string;
			name: string;
			emoji: string;
			collapsed: boolean;
			archived: boolean;
			projectRoot: string;
		}
	>();

	for (const [repoKey, sessions] of repoToSessions.entries()) {
		const projectRoot = getProjectRootForSession(sessions[0]);
		const repoGroups = new Map<string, { group: Group; count: number; spansRepoOnly: boolean }>();

		for (const session of topLevelSessions) {
			if (!session.groupId) continue;
			const group = groupById.get(session.groupId);
			if (!group) continue;
			const groupRepoKey = normalizePath(getProjectRootForSession(session));
			const existing = repoGroups.get(group.id);
			const nextCount = existing ? existing.count + (groupRepoKey === repoKey ? 1 : 0) : groupRepoKey === repoKey ? 1 : 0;
			repoGroups.set(group.id, {
				group,
				count: nextCount,
				spansRepoOnly: existing ? existing.spansRepoOnly && groupRepoKey === repoKey : groupRepoKey === repoKey,
			});
		}

		const reusableGroups = Array.from(repoGroups.values())
			.filter((entry) => entry.count > 0 && entry.spansRepoOnly)
			.sort((a, b) => {
				if (b.count !== a.count) return b.count - a.count;
				return a.group.name.localeCompare(b.group.name);
			});

		const chosenGroup = reusableGroups[0]?.group;
		repoToWorkspace.set(repoKey, {
			id: chosenGroup?.id || `workspace-${generateId()}`,
			name: chosenGroup?.name || getWorkspaceDisplayName(projectRoot),
			emoji: chosenGroup?.emoji || '📁',
			collapsed: chosenGroup?.collapsed ?? false,
			archived: chosenGroup?.archived ?? false,
			projectRoot,
		});
	}

	const migratedGroups: Group[] = Array.from(repoToWorkspace.values()).map((workspace) => ({
		id: workspace.id,
		name: workspace.name,
		emoji: workspace.emoji,
		collapsed: workspace.collapsed,
		archived: workspace.archived,
		projectRoot: workspace.projectRoot,
		lastUsedAt: 0,
	}));

	const topLevelSessionMap = new Map(topLevelSessions.map((session) => [session.id, session]));

	const migratedSessions = savedSessions.map((session) => {
		const mutableSession: MutableSession = { ...session, runtimeId: session.runtimeId || session.id };
		const parentSession =
			session.parentSessionId && topLevelSessionMap.has(session.parentSessionId)
				? topLevelSessionMap.get(session.parentSessionId)!
				: null;
		const workspaceSource = parentSession || session;
		const repoKey = normalizePath(getProjectRootForSession(workspaceSource));
		const workspace = repoToWorkspace.get(repoKey);
		if (workspace) {
			mutableSession.groupId = workspace.id;
			mutableSession.workspaceId = workspace.id;
		}
		return mutableSession;
	});

	const threads: Thread[] = topLevelSessions.map((session) => {
		const repoKey = normalizePath(getProjectRootForSession(session));
		const workspace = repoToWorkspace.get(repoKey);
		const lastUsedAt = getSessionLastActivity(session);
		const threadId = session.threadId || `thread-${generateId()}`;

		return {
			id: threadId,
			workspaceId: workspace?.id || `workspace-${generateId()}`,
			sessionId: session.id,
			runtimeId: getRuntimeIdForSession(session),
			tabId: session.activeTabId || session.aiTabs?.[0]?.id,
			title: getPreferredThreadTitle(session),
			agentId: session.toolType,
			projectRoot: getProjectRootForSession(session),
			pinned: !!session.bookmarked,
			archived: false,
			isOpen: session.id === activeSessionId || !!session.bookmarked,
			createdAt: lastUsedAt,
			lastUsedAt,
		};
	});

	const threadsBySessionId = new Map(threads.map((thread) => [thread.sessionId, thread.id]));
	for (const session of migratedSessions) {
		if (!session.parentSessionId) {
			session.threadId = threadsBySessionId.get(session.id);
		}
	}

	const workspaceLastUsed = new Map<string, number>();
	for (const thread of threads) {
		const current = workspaceLastUsed.get(thread.workspaceId) || 0;
		if (thread.lastUsedAt > current) {
			workspaceLastUsed.set(thread.workspaceId, thread.lastUsedAt);
		}
	}

	for (const group of migratedGroups) {
		group.lastUsedAt = workspaceLastUsed.get(group.id) || 0;
	}

	return {
		sessions: migratedSessions,
		groups: migratedGroups,
		threads,
	};
}

export function reconcileThreadsWithSessions(
	threads: Thread[],
	sessions: Session[]
): Thread[] {
	const topLevelSessions = sessions.filter((session) => !session.parentSessionId);
	const sessionsById = new Map(topLevelSessions.map((session) => [session.id, session]));
	const seenThreadKeys = new Set<string>();
	const nextThreads = [...threads]
		.sort((a, b) => {
			if (Number(b.pinned) !== Number(a.pinned)) return Number(b.pinned) - Number(a.pinned);
			if (Number(b.isOpen) !== Number(a.isOpen)) return Number(b.isOpen) - Number(a.isOpen);
			if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
			return b.createdAt - a.createdAt;
		})
		.filter((thread) => {
			const session = sessionsById.get(thread.sessionId);
			if (!session) {
				return false;
			}

			if (!thread.tabId) {
				return false;
			}

			if (!session.aiTabs?.some((tab) => tab.id === thread.tabId)) {
				return false;
			}

			const dedupeKey = `${thread.sessionId}:${thread.tabId}`;
			if (seenThreadKeys.has(dedupeKey)) {
				return false;
			}
			seenThreadKeys.add(dedupeKey);
			return true;
		})
		.map((thread) => {
			const session = sessionsById.get(thread.sessionId)!;
			const lastUsedAt = getSessionLastActivity(session);
			return {
				...thread,
				runtimeId: thread.runtimeId || getRuntimeIdForSession(session),
				tabId: thread.tabId,
				title: getThreadDisplayTitle(thread, session),
				agentId: session.toolType,
				projectRoot: getProjectRootForSession(session),
				workspaceId: session.workspaceId || session.groupId || thread.workspaceId,
				lastUsedAt: Math.max(thread.lastUsedAt, lastUsedAt),
				isOpen: thread.isOpen,
			};
		});

	for (const session of topLevelSessions) {
		if (nextThreads.some((thread) => thread.sessionId === session.id)) continue;
		const lastUsedAt = getSessionLastActivity(session);
		nextThreads.push({
			id: session.threadId || `thread-${generateId()}`,
			workspaceId: session.workspaceId || session.groupId || `workspace-${generateId()}`,
			sessionId: session.id,
			runtimeId: getRuntimeIdForSession(session),
			tabId: session.activeTabId || session.aiTabs?.[0]?.id,
			title: getPreferredThreadTitle(session),
			agentId: session.toolType,
			projectRoot: getProjectRootForSession(session),
			pinned: !!session.bookmarked,
			archived: false,
			isOpen: false,
			createdAt: lastUsedAt,
			lastUsedAt,
		});
	}

	return nextThreads;
}

export function reconcileWorkspacesWithThreads(groups: Group[], threads: Thread[]): Group[] {
	const nextLastUsed = new Map<string, number>();
	for (const thread of threads) {
		const current = nextLastUsed.get(thread.workspaceId) || 0;
		if (thread.lastUsedAt > current) {
			nextLastUsed.set(thread.workspaceId, thread.lastUsedAt);
		}
	}

	return groups.map((group) => ({
		...group,
		lastUsedAt: nextLastUsed.get(group.id) || group.lastUsedAt || 0,
	}));
}

interface RecoverableAgentSession {
	agentId: string;
	sessionId: string;
	projectPath: string;
	timestamp: string;
	modifiedAt: string;
	firstMessage: string;
	sessionName?: string;
	starred?: boolean;
	contextUsage?: number;
	origin?: 'user' | 'auto';
	gitBranch?: string;
	slug?: string;
}

function formatRecoveredSlug(slug: string): string {
	return slug
		.split('-')
		.filter(Boolean)
		.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join(' ');
}

function getRecoveredThreadTitle(candidate: RecoverableAgentSession): string {
	if (candidate.sessionName?.trim()) return candidate.sessionName.trim();
	if (candidate.slug?.trim()) return formatRecoveredSlug(candidate.slug.trim());
	if (candidate.firstMessage?.trim()) return candidate.firstMessage.trim().slice(0, 60);
	return `Recovered Claude Thread ${candidate.sessionId.slice(0, 8)}`;
}

function convertStoredMessagesToLogs(
	messages: Array<{
		type: string;
		role?: string;
		content: string;
		timestamp: string;
		uuid: string;
		toolUse?: unknown;
	}>
) {
	return messages
		.map((message) => {
			const text =
				message.content?.trim() ||
				(message.toolUse ? '[Tool output]' : '');
			if (!text) return null;
			return {
				id: message.uuid || generateId(),
				timestamp: Date.parse(message.timestamp) || Date.now(),
				source:
					message.type === 'user'
						? ('user' as const)
						: message.type === 'thinking'
							? ('thinking' as const)
							: ('stdout' as const),
				text,
			};
		})
		.filter((entry): entry is NonNullable<typeof entry> => !!entry);
}

export async function recoverMissingProviderThreads(
	sessions: Session[],
	groups: Group[],
	threads: Thread[]
): Promise<{
	sessions: Session[];
	groups: Group[];
	threads: Thread[];
	recoveredCount: number;
}> {
	const hasClaudeStorage = await window.maestro.agentSessions.hasStorage('claude-code');
	if (!hasClaudeStorage) {
		return { sessions, groups, threads, recoveredCount: 0 };
	}

	const candidates = await window.maestro.agentSessions.discoverRecoverable('claude-code');
	if (!candidates.length) {
		return { sessions, groups, threads, recoveredCount: 0 };
	}

	const existingAgentSessionIds = new Set<string>();
	for (const session of sessions) {
		for (const tab of session.aiTabs || []) {
			if (tab.agentSessionId) {
				existingAgentSessionIds.add(tab.agentSessionId);
			}
		}
	}

	const nextSessions = [...sessions];
	const nextGroups = [...groups];
	const nextThreads = [...threads];
	const { defaultSaveToHistory, defaultShowThinking } = useSettingsStore.getState();
	let recoveredCount = 0;

	for (const candidate of candidates) {
		if (candidate.agentId !== 'claude-code') continue;
		if (existingAgentSessionIds.has(candidate.sessionId)) continue;

		const projectRoot = candidate.projectPath;
		const normalizedProjectRoot = normalizePath(projectRoot);
		if (!normalizedProjectRoot) continue;

		let workspace = nextGroups.find(
			(group) => normalizePath(group.projectRoot) === normalizedProjectRoot
		);
		if (!workspace) {
			workspace = {
				id: `workspace-${generateId()}`,
				name: getWorkspaceDisplayName(projectRoot),
				emoji: '📁',
				collapsed: false,
				archived: false,
				projectRoot,
				lastUsedAt: 0,
			};
			nextGroups.push(workspace);
		}

		try {
			const readResult = await window.maestro.agentSessions.read(
				'claude-code',
				projectRoot,
				candidate.sessionId,
				{ offset: 0, limit: 100 }
			);
			const logs = convertStoredMessagesToLogs(readResult.messages);
			const createdAt = Date.parse(candidate.timestamp) || Date.now();
			const lastUsedAt = Date.parse(candidate.modifiedAt) || createdAt;
			const tabId = generateId();
			const sessionId = generateId();
			const threadId = `thread-${generateId()}`;
			const title = getRecoveredThreadTitle(candidate);
			const isGitRepo = !!candidate.gitBranch;

			const recoveredSession: Session = {
				id: sessionId,
				runtimeId: sessionId,
				groupId: workspace.id,
				workspaceId: workspace.id,
				threadId,
				name: title,
				toolType: 'claude-code',
				state: 'idle',
				cwd: projectRoot,
				fullPath: projectRoot,
				projectRoot,
				aiLogs: [],
				shellLogs: [
					{
						id: generateId(),
						timestamp: createdAt,
						source: 'system',
						text: 'Shell Session Ready.',
					},
				],
				workLog: [],
				contextUsage: candidate.contextUsage || 0,
				inputMode: 'ai',
				aiPid: 0,
				terminalPid: 0,
				port: 3000 + Math.floor(Math.random() * 100),
				isLive: false,
				changedFiles: [],
				isGitRepo,
				gitBranches: candidate.gitBranch ? [candidate.gitBranch] : undefined,
				gitTags: undefined,
				gitRefsCacheTime: isGitRepo ? lastUsedAt : undefined,
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				fileTreeAutoRefreshInterval: 180,
				shellCwd: projectRoot,
				aiCommandHistory: [],
				shellCommandHistory: [],
				executionQueue: [],
				activeTimeMs: 0,
				aiTabs: [
					{
						id: tabId,
						agentSessionId: candidate.sessionId,
						name: title,
						starred: !!candidate.starred,
						logs,
						inputValue: '',
						stagedImages: [],
						createdAt,
						state: 'idle',
						saveToHistory: defaultSaveToHistory ?? false,
						showThinking: defaultShowThinking ?? 'sticky',
					},
				],
				activeTabId: tabId,
				closedTabHistory: [],
				filePreviewTabs: [],
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai', id: tabId }],
				unifiedClosedTabHistory: [],
				autoRunFolderPath: `${projectRoot}/Auto Run Docs`,
			};

			const recoveredThread: Thread = {
				id: threadId,
				workspaceId: workspace.id,
				sessionId,
				runtimeId: sessionId,
				tabId,
				title,
				agentId: 'claude-code',
				projectRoot,
				pinned: !!candidate.starred,
				archived: false,
				isOpen: false,
				createdAt,
				lastUsedAt,
			};

			nextSessions.push(recoveredSession);
			nextThreads.push(recoveredThread);
			existingAgentSessionIds.add(candidate.sessionId);
			workspace.lastUsedAt = Math.max(workspace.lastUsedAt || 0, lastUsedAt);
			recoveredCount += 1;
		} catch (error) {
			console.warn(
				`[recoverMissingProviderThreads] Failed to recover Claude session ${candidate.sessionId}:`,
				error
			);
		}
	}

	return {
		sessions: nextSessions,
		groups: reconcileWorkspacesWithThreads(nextGroups, nextThreads),
		threads: nextThreads,
		recoveredCount,
	};
}
