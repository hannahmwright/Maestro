import { describe, expect, it } from 'vitest';
import type { Session, Thread } from '../../../renderer/types';
import {
	isConductorHelperSession,
	selectConductorLeadSession,
} from '../../../renderer/services/conductorLeadSelection';

function buildSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		runtimeId: 'session-1',
		groupId: 'group-1',
		workspaceId: 'group-1',
		name: 'Lead',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/tmp/project',
		fullPath: '/tmp/project',
		projectRoot: '/tmp/project',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 3000,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: '/tmp/project',
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [
			{
				id: 'tab-1',
				agentSessionId: null,
				name: null,
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				createdAt: 1,
				state: 'idle',
				saveToHistory: true,
			},
		],
		activeTabId: 'tab-1',
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
		unifiedClosedTabHistory: [],
		closedTabHistory: [],
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	} as Session;
}

function buildThread(overrides: Partial<Thread> = {}): Thread {
	return {
		id: 'thread-1',
		sessionId: 'session-1',
		runtimeId: 'session-1',
		workspaceId: 'group-1',
		title: 'Lead',
		lastUsedAt: 1,
		tabId: null,
		createdAt: 1,
		updatedAt: 1,
		messageCount: 0,
		participantSessionIds: ['session-1'],
		...overrides,
	} as Thread;
}

describe('conductorLeadSelection', () => {
	it('detects top-level conductor helper sessions from their names', () => {
		const helper = buildSession({
			name: 'You are Conductor, the planning layer for the Maestro group "Questionaire".',
			aiTabs: [
				{
					id: 'tab-1',
					agentSessionId: null,
					name: 'You are Conductor, the planning layer for the Maestro group "Questionaire".',
					starred: false,
					logs: [],
					inputValue: '',
					stagedImages: [],
					createdAt: 1,
					state: 'idle',
					saveToHistory: false,
				},
			],
		});

		expect(isConductorHelperSession(helper)).toBe(true);
	});

	it('prefers a real workspace session over a newer conductor helper thread', () => {
		const realLead = buildSession({
			id: 'real-session',
			runtimeId: 'real-session',
			name: 'Real Lead',
			updatedAt: 50,
			aiTabs: [
				{
					id: 'real-tab',
					agentSessionId: 'agent-1',
					name: 'Real Lead',
					starred: false,
					logs: [
						{
							id: 'real-log',
							timestamp: 50,
							source: 'user',
							text: '# Maestro System Context\n\nYou are **Leona · Claude**.',
						},
					],
					inputValue: '',
					stagedImages: [],
					createdAt: 1,
					state: 'idle',
					saveToHistory: false,
				},
			],
			activeTabId: 'real-tab',
		});
		const helper = buildSession({
			id: 'helper-session',
			runtimeId: 'helper-session',
			name: 'You are Conductor, the planning layer for the Maestro group "Questionaire".',
			updatedAt: 100,
			aiTabs: [
				{
					id: 'helper-tab',
					agentSessionId: 'agent-2',
					name: 'You are Conductor, the planning layer for the Maestro group "Questionaire".',
					starred: false,
					logs: [],
					inputValue: '',
					stagedImages: [],
					createdAt: 1,
					state: 'idle',
					saveToHistory: false,
				},
			],
			activeTabId: 'helper-tab',
		});

		const selected = selectConductorLeadSession({
			groupId: 'group-1',
			sessions: [helper, realLead],
			threads: [
				buildThread({
					id: 'helper-thread',
					sessionId: 'helper-session',
					runtimeId: 'helper-session',
					lastUsedAt: 100,
					title: 'Playful Plotting Bengio',
				}),
				buildThread({
					id: 'real-thread',
					sessionId: 'real-session',
					runtimeId: 'real-session',
					lastUsedAt: 50,
					title: 'Real Lead',
				}),
			],
		});

		expect(selected?.id).toBe('real-session');
	});

	it('falls back to helper sessions when no other lead exists', () => {
		const helper = buildSession({
			id: 'helper-session',
			runtimeId: 'helper-session',
			name: "You are Conductor's discovery planner for the Maestro workspace \"Questionaire\".",
			updatedAt: 100,
			aiTabs: [
				{
					id: 'helper-tab',
					agentSessionId: 'agent-2',
					name: "You are Conductor's discovery planner for the Maestro workspace \"Questionaire\".",
					starred: false,
					logs: [],
					inputValue: '',
					stagedImages: [],
					createdAt: 1,
					state: 'idle',
					saveToHistory: false,
				},
			],
			activeTabId: 'helper-tab',
		});

		const selected = selectConductorLeadSession({
			groupId: 'group-1',
			sessions: [helper],
			threads: [
				buildThread({
					id: 'helper-thread',
					sessionId: 'helper-session',
					runtimeId: 'helper-session',
					lastUsedAt: 100,
					title: 'Playful Plotting Bengio',
				}),
			],
		});

		expect(selected?.id).toBe('helper-session');
	});

	it('detects truncated discovery planner helper sessions', () => {
		const helper = buildSession({
			name: "You are Conductor's discovery planner for the Maestro worksp",
			aiTabs: [
				{
					id: 'tab-1',
					agentSessionId: null,
					name: "You are Conductor's discovery planner for the Maestro worksp",
					starred: false,
					logs: [],
					inputValue: '',
					stagedImages: [],
					createdAt: 1,
					state: 'idle',
					saveToHistory: false,
				},
			],
		});

		expect(isConductorHelperSession(helper)).toBe(true);
	});
});
