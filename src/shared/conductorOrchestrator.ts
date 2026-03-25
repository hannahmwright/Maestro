import type { Conductor, ConductorRun, ConductorTask, ConductorTaskPriority } from './types';
import type { ConductorOrchestratorUpdate } from './conductorUpdates';
import {
	formatConductorOperatorMessage,
	getConductorTaskAttentionBlockers,
	getConductorTaskProgress,
	getConductorTaskRollupStatus,
	getConductorTaskVisibleAttention,
	getTopLevelConductorTasks,
	isConductorTaskOperatorActionRequired,
	isConductorTaskRunnableByAgent,
} from './conductorTasks';

export type ConductorOrchestratorContext =
	| { scope: 'board' }
	| { scope: 'task'; taskId: string }
	| { scope: 'update'; updateId: string }
	| { scope: 'member'; memberName: string };

export interface ConductorOrchestratorTeamSnapshot {
	name: string;
	emoji: string;
	status: 'working' | 'idle' | 'waiting' | 'error';
	parentTaskId?: string;
	parentTaskTitle?: string;
	threadCount: number;
}

export interface ConductorOrchestratorReply {
	title: string;
	body: string;
	bullets: string[];
	relatedTaskId?: string;
	actions?: ConductorOrchestratorAction[];
}

export type ConductorOrchestratorAction =
	| { type: 'open_task'; label: string; taskId: string }
	| { type: 'prioritize_task'; label: string; taskId: string; priority: ConductorTaskPriority }
	| {
			type: 'set_task_group_priority';
			label: string;
			taskIds: string[];
			priority: ConductorTaskPriority;
			summary: string;
	  }
	| {
			type: 'rebalance_task_groups';
			label: string;
			raiseTaskIds: string[];
			raisePriority: ConductorTaskPriority;
			lowerTaskIds: string[];
			lowerPriority: ConductorTaskPriority;
			summary: string;
	  }
	| { type: 'pause_task'; label: string; taskId: string }
	| { type: 'resume_task'; label: string; taskId: string }
	| { type: 'requeue_task'; label: string; taskId: string }
	| { type: 'pause_board'; label: string }
	| { type: 'resume_board'; label: string }
	| { type: 'open_member'; label: string; memberName: string };

export function getConductorOrchestratorQuickPrompts(
	context: ConductorOrchestratorContext
): string[] {
	switch (context.scope) {
		case 'task':
			return ['Why is this blocked?', 'Do you need me for anything?', 'What changed recently?'];
		case 'update':
			return ['Explain this update', 'What should happen next?', 'Do I need to do anything?'];
		case 'member':
			return ['What is this teammate doing?', 'Is anything blocked here?', 'Do I need to step in?'];
		case 'board':
		default:
			return ['What needs me?', 'What is moving right now?', 'What is blocked?'];
	}
}

function formatTaskStatusLabel(status: string): string {
	switch (status) {
		case 'draft':
			return 'Brainstorm';
		case 'planning':
			return 'Planning';
		case 'ready':
			return 'Ready';
		case 'running':
			return 'In progress';
		case 'needs_revision':
			return 'Agents revising';
		case 'needs_input':
			return 'Waiting on you';
		case 'needs_proof':
			return 'Needs proof';
		case 'blocked':
			return 'Blocked';
		case 'needs_review':
			return 'In QA';
		case 'cancelled':
			return 'Stopped';
		case 'done':
			return 'Done';
		default:
			return status;
	}
}

function getNextPriority(priority: ConductorTaskPriority): ConductorTaskPriority | null {
	switch (priority) {
		case 'low':
			return 'medium';
		case 'medium':
			return 'high';
		case 'high':
			return 'critical';
		case 'critical':
		default:
			return null;
	}
}

const ORCHESTRATOR_SEARCH_STOP_WORDS = new Set([
	'the',
	'this',
	'that',
	'work',
	'workstream',
	'workstreams',
	'task',
	'tasks',
	'feature',
	'features',
	'project',
	'projects',
	'please',
	'now',
	'next',
]);

function normalizeSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
}

function extractSearchTokens(value: string): string[] {
	return normalizeSearchText(value)
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= 2 && !ORCHESTRATOR_SEARCH_STOP_WORDS.has(token));
}

function findTasksMatchingPhrase(
	phrase: string,
	topLevelTasks: ConductorTask[],
	childTasksByParentId: Map<string, ConductorTask[]>,
	runs: ConductorRun[]
): ConductorTask[] {
	const tokens = extractSearchTokens(phrase);
	if (tokens.length === 0) {
		return [];
	}

	const candidates = topLevelTasks.filter((task) => {
		const rollupStatus = getConductorTaskRollupStatus(task, childTasksByParentId, runs);
		return rollupStatus !== 'done' && rollupStatus !== 'cancelled';
	});

	const scored = candidates
		.map((task) => {
			const haystack = normalizeSearchText(`${task.title} ${task.description}`);
			const score = tokens.reduce((count, token) => count + (haystack.includes(token) ? 1 : 0), 0);
			return { task, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score;
			}
			return right.task.updatedAt - left.task.updatedAt;
		});

	const fullMatches = scored.filter((entry) => entry.score >= tokens.length);
	const matches = fullMatches.length > 0 ? fullMatches : scored;
	return matches.slice(0, 6).map((entry) => entry.task);
}

function buildTaskListLabel(tasks: ConductorTask[]): string {
	return tasks.map((task) => task.title).join(', ');
}

function buildReprioritizationReply(input: {
	question: string;
	topLevelTasks: ConductorTask[];
	childTasksByParentId: Map<string, ConductorTask[]>;
	runs: ConductorRun[];
}): ConductorOrchestratorReply | null {
	const normalizedQuestion = input.question.trim();
	const prioritizeOverMatch = normalizedQuestion.match(
		/(?:prioriti[sz]e|focus on|move)\s+(.+?)\s+(?:over|ahead of|before)\s+(.+)/i
	);
	if (prioritizeOverMatch) {
		const focusPhrase = prioritizeOverMatch[1].trim();
		const otherPhrase = prioritizeOverMatch[2].trim();
		const focusTasks = findTasksMatchingPhrase(
			focusPhrase,
			input.topLevelTasks,
			input.childTasksByParentId,
			input.runs
		);
		const otherTasks = findTasksMatchingPhrase(
			otherPhrase,
			input.topLevelTasks,
			input.childTasksByParentId,
			input.runs
		).filter((task) => !focusTasks.some((focusTask) => focusTask.id === task.id));

		if (focusTasks.length === 0 && otherTasks.length === 0) {
			return {
				title: 'Priority change needs clearer task names',
				body: 'I could not confidently map that request to the current top-level tasks.',
				bullets: ['Try naming the workstream more directly, like emoji, brace, onboarding, or QA.'],
				actions: [],
			};
		}

		return {
			title: 'Priority plan',
			body: `I can push ${focusPhrase} forward and de-emphasize ${otherPhrase} across the current top-level tasks.`,
			bullets: [
				...(focusTasks.length > 0
					? [`Raise: ${buildTaskListLabel(focusTasks)}`]
					: [`No active top-level tasks matched ${focusPhrase}.`]),
				...(otherTasks.length > 0
					? [`Lower: ${buildTaskListLabel(otherTasks)}`]
					: [`No active top-level tasks matched ${otherPhrase}.`]),
			],
			relatedTaskId: focusTasks[0]?.id || otherTasks[0]?.id,
			actions:
				focusTasks.length > 0 || otherTasks.length > 0
					? [
							{
								type: 'rebalance_task_groups',
								label: `Prioritize ${focusPhrase} over ${otherPhrase}`,
								raiseTaskIds: focusTasks.map((task) => task.id),
								raisePriority: 'high',
								lowerTaskIds: otherTasks.map((task) => task.id),
								lowerPriority: 'low',
								summary: `Raised ${focusPhrase} and lowered ${otherPhrase}.`,
							},
					  ]
					: [],
		};
	}

	const prioritizeMatch = normalizedQuestion.match(/(?:prioriti[sz]e|focus on)\s+(.+)/i);
	if (prioritizeMatch) {
		const focusPhrase = prioritizeMatch[1].trim();
		const focusTasks = findTasksMatchingPhrase(
			focusPhrase,
			input.topLevelTasks,
			input.childTasksByParentId,
			input.runs
		);
		if (focusTasks.length === 0) {
			return {
				title: 'Priority change needs clearer task names',
				body: `I could not find active top-level tasks matching ${focusPhrase}.`,
				bullets: [],
				actions: [],
			};
		}

		return {
			title: 'Priority plan',
			body: `I can move ${focusPhrase} to the front of the queue across the current top-level tasks.`,
			bullets: [`Raise: ${buildTaskListLabel(focusTasks)}`],
			relatedTaskId: focusTasks[0]?.id,
			actions: [
				{
					type: 'set_task_group_priority',
					label: `Prioritize ${focusPhrase}`,
					taskIds: focusTasks.map((task) => task.id),
					priority: 'high',
					summary: `Raised ${focusPhrase}.`,
				},
			],
		};
	}

	const deprioritizeMatch = normalizedQuestion.match(/deprioriti[sz]e\s+(.+)/i);
	if (deprioritizeMatch) {
		const phrase = deprioritizeMatch[1].trim();
		const tasks = findTasksMatchingPhrase(
			phrase,
			input.topLevelTasks,
			input.childTasksByParentId,
			input.runs
		);
		if (tasks.length === 0) {
			return {
				title: 'Priority change needs clearer task names',
				body: `I could not find active top-level tasks matching ${phrase}.`,
				bullets: [],
				actions: [],
			};
		}

		return {
			title: 'Priority plan',
			body: `I can move ${phrase} to the back of the queue across the current top-level tasks.`,
			bullets: [`Lower: ${buildTaskListLabel(tasks)}`],
			relatedTaskId: tasks[0]?.id,
			actions: [
				{
					type: 'set_task_group_priority',
					label: `Deprioritize ${phrase}`,
					taskIds: tasks.map((task) => task.id),
					priority: 'low',
					summary: `Lowered ${phrase}.`,
				},
			],
		};
	}

	return null;
}

function countTopLevelStatuses(
	topLevelTasks: ConductorTask[],
	childTasksByParentId: Map<string, ConductorTask[]>,
	runs: ConductorRun[]
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const task of topLevelTasks) {
		const status = getConductorTaskRollupStatus(task, childTasksByParentId, runs);
		counts.set(status, (counts.get(status) || 0) + 1);
	}
	return counts;
}

function buildTaskReply(input: {
	task: ConductorTask;
	childTasksByParentId: Map<string, ConductorTask[]>;
	runs: ConductorRun[];
	updates: ConductorOrchestratorUpdate[];
}): ConductorOrchestratorReply {
	const { task, childTasksByParentId, runs, updates } = input;
	const rollupStatus = getConductorTaskRollupStatus(task, childTasksByParentId, runs);
	const visibleAttention = getConductorTaskVisibleAttention(task, childTasksByParentId, runs);
	const progress = getConductorTaskProgress(task, childTasksByParentId);
	const attentionBlockers = getConductorTaskAttentionBlockers(task, childTasksByParentId, runs);
	const latestUpdate = updates.find((update) => update.taskId === task.id);
	const operatorActionRequired = isConductorTaskOperatorActionRequired(task, childTasksByParentId, runs);
	const runnableByAgent = isConductorTaskRunnableByAgent(task, childTasksByParentId, runs);

	let body = `${task.title} is currently ${formatTaskStatusLabel(rollupStatus).toLowerCase()}.`;
	if (rollupStatus === 'needs_input' && visibleAttention?.attentionRequest) {
		body = `${task.title} is waiting on your guidance.`;
	} else if (rollupStatus === 'needs_proof') {
		body = `${task.title} is waiting on proof of completion before it can move into Done.`;
	} else if (rollupStatus === 'needs_revision') {
		body = `${task.title} is back with the agents for another pass.`;
	} else if (rollupStatus === 'needs_review') {
		body = `${task.title} is sitting in QA right now.`;
	} else if (rollupStatus === 'ready') {
		body = `${task.title} is implemented and ready for the next pass.`;
	} else if (rollupStatus === 'done') {
		body = `${task.title} is complete.`;
	}

	const bullets: string[] = [`Status: ${formatTaskStatusLabel(rollupStatus)}`];
	if (progress.totalSubtasks > 0) {
		bullets.push(
			`Progress: ${progress.completedSubtasks}/${progress.totalSubtasks} nested tasks complete`
		);
	}
	if (visibleAttention?.attentionRequest?.requestedAction) {
		bullets.push(`Need from you: ${visibleAttention.attentionRequest.requestedAction}`);
	} else if (attentionBlockers[0]) {
		bullets.push(
			`Top blocker: ${
				attentionBlockers[0].attentionRequest?.summary || attentionBlockers[0].task.title
			}`
		);
	}
	if (latestUpdate?.summary) {
		bullets.push(`Latest update: ${latestUpdate.summary}`);
	}

	const actions: ConductorOrchestratorAction[] = [{ type: 'open_task', label: 'Open task', taskId: task.id }];
	const nextPriority = getNextPriority(task.priority);
	if (nextPriority && rollupStatus !== 'done' && rollupStatus !== 'cancelled') {
		actions.push({
			type: 'prioritize_task',
			label: nextPriority === 'critical' ? 'Mark critical' : `Raise to ${nextPriority}`,
			taskId: task.id,
			priority: nextPriority,
		});
	}
	if (rollupStatus === 'ready') {
		actions.push({ type: 'pause_task', label: 'Pause this task', taskId: task.id });
	}
	if (rollupStatus === 'blocked' && !operatorActionRequired) {
		actions.push({ type: 'resume_task', label: 'Resume this task', taskId: task.id });
	}
	if (rollupStatus === 'needs_revision' && runnableByAgent) {
		actions.push({ type: 'requeue_task', label: 'Queue next pass', taskId: task.id });
	}

	return {
		title: 'Task summary',
		body,
		bullets,
		relatedTaskId: task.id,
		actions,
	};
}

function buildUpdateReply(input: {
	update: ConductorOrchestratorUpdate;
	tasksById: Map<string, ConductorTask>;
	childTasksByParentId: Map<string, ConductorTask[]>;
	runs: ConductorRun[];
}): ConductorOrchestratorReply {
	const task = input.update.taskId ? input.tasksById.get(input.update.taskId) || null : null;
	const bullets = [`This update is ${input.update.isHistorical ? 'from history' : 'current'}.`];

	if (task) {
		const rollupStatus = getConductorTaskRollupStatus(task, input.childTasksByParentId, input.runs);
		bullets.push(`Task status: ${formatTaskStatusLabel(rollupStatus)}`);
	}
	if (input.update.detail) {
		bullets.push(formatConductorOperatorMessage(input.update.detail));
	}

	return {
		title: 'Update summary',
		body: input.update.summary,
		bullets,
		relatedTaskId: task?.id,
		actions: task
			? buildTaskReply({
					task,
					childTasksByParentId: input.childTasksByParentId,
					runs: input.runs,
					updates: [],
			  }).actions
			: [],
	};
}

function buildMemberReply(input: {
	member: ConductorOrchestratorTeamSnapshot;
	tasksById: Map<string, ConductorTask>;
	childTasksByParentId: Map<string, ConductorTask[]>;
	runs: ConductorRun[];
}): ConductorOrchestratorReply {
	const task = input.member.parentTaskId
		? input.tasksById.get(input.member.parentTaskId) || null
		: null;
	const bullets = [
		`Status: ${
			input.member.status === 'working'
				? 'Working'
				: input.member.status === 'waiting'
					? 'Waiting'
					: input.member.status === 'error'
						? 'Needs attention'
						: 'Idle'
		}`,
		`${input.member.threadCount} conversation${input.member.threadCount === 1 ? '' : 's'} available`,
	];

	let body = `${input.member.name} is currently idle.`;
	if (input.member.status === 'working' && task) {
		body = `${input.member.name} is currently working on ${task.title}.`;
		const status = getConductorTaskRollupStatus(task, input.childTasksByParentId, input.runs);
		bullets.push(`Task status: ${formatTaskStatusLabel(status)}`);
	} else if (input.member.status === 'waiting' && task) {
		body = `${input.member.name} is waiting on ${task.title}.`;
	} else if (input.member.status === 'error') {
		body = `${input.member.name} hit something that needs attention.`;
	}

	return {
		title: 'Teammate summary',
		body,
		bullets,
		relatedTaskId: task?.id,
		actions: [
			{ type: 'open_member', label: 'Open teammate thread', memberName: input.member.name },
			...(task ? [{ type: 'open_task' as const, label: 'Open task', taskId: task.id }] : []),
		],
	};
}

function buildWhatNeedsMeReply(input: {
	topLevelTasks: ConductorTask[];
	childTasksByParentId: Map<string, ConductorTask[]>;
	runs: ConductorRun[];
}): ConductorOrchestratorReply {
	const waiting = input.topLevelTasks.filter(
		(task) =>
			['needs_input', 'needs_proof'].includes(
				getConductorTaskRollupStatus(task, input.childTasksByParentId, input.runs)
			)
	);
	if (waiting.length === 0) {
		return {
			title: 'Nothing is waiting on you',
			body: 'There is no top-level task currently asking you for a decision or clarification.',
			bullets: [],
			actions: [],
		};
	}

	return {
		title: 'Tasks waiting on you',
		body: `${waiting.length} top-level task${waiting.length === 1 ? '' : 's'} currently need your guidance.`,
		bullets: waiting.slice(0, 4).map((task) => task.title),
		relatedTaskId: waiting[0]?.id,
		actions: waiting[0] ? [{ type: 'open_task', label: 'Open first task', taskId: waiting[0].id }] : [],
	};
}

function buildWhatChangedReply(updates: ConductorOrchestratorUpdate[]): ConductorOrchestratorReply {
	const visibleUpdates = updates.slice(0, 4);
	if (visibleUpdates.length === 0) {
		return {
			title: 'No recent updates',
			body: 'I do not have a recent orchestrator update to summarize yet.',
			bullets: [],
			actions: [],
		};
	}

	return {
		title: 'Recent changes',
		body: 'Here are the most recent manager-level updates from the board.',
		bullets: visibleUpdates.map((update) =>
			update.taskTitle ? `${update.taskTitle}: ${update.summary}` : update.summary
		),
		relatedTaskId: visibleUpdates[0]?.taskId,
		actions: visibleUpdates[0]?.taskId
			? [{ type: 'open_task', label: 'Open latest task', taskId: visibleUpdates[0].taskId }]
			: [],
	};
}

function buildWhatIsMovingReply(team: ConductorOrchestratorTeamSnapshot[]): ConductorOrchestratorReply {
	const activeTeam = team.filter((member) => member.status === 'working');
	if (activeTeam.length === 0) {
		return {
			title: 'Nothing is actively moving',
			body: 'No helper teammate is actively working at this moment.',
			bullets: [],
			actions: [],
		};
	}

	return {
		title: 'Active teammates',
		body: `${activeTeam.length} teammate${activeTeam.length === 1 ? '' : 's'} are actively working right now.`,
		bullets: activeTeam.map((member) =>
			member.parentTaskTitle ? `${member.emoji} ${member.name}: ${member.parentTaskTitle}` : `${member.emoji} ${member.name}`
		),
		relatedTaskId: activeTeam[0]?.parentTaskId,
		actions: [{ type: 'open_member', label: `Open ${activeTeam[0].name}`, memberName: activeTeam[0].name }],
	};
}

function buildBlockedReply(input: {
	topLevelTasks: ConductorTask[];
	childTasksByParentId: Map<string, ConductorTask[]>;
	runs: ConductorRun[];
	conductor?: Conductor | null;
}): ConductorOrchestratorReply {
	const blocked = input.topLevelTasks.filter((task) => {
		const status = getConductorTaskRollupStatus(task, input.childTasksByParentId, input.runs);
		return (
			status === 'blocked' ||
			status === 'needs_review' ||
			status === 'needs_revision' ||
			status === 'needs_proof'
		);
	});

	if (blocked.length === 0 && !input.conductor?.holdReason) {
		return {
			title: 'Nothing major is blocked',
			body: 'I do not see a current top-level blocker on the board.',
			bullets: [],
			actions: input.conductor?.isPaused ? [{ type: 'resume_board', label: 'Resume conductor' }] : [],
		};
	}

	const bullets = blocked.slice(0, 4).map((task) => {
		const status = getConductorTaskRollupStatus(task, input.childTasksByParentId, input.runs);
		return `${task.title}: ${formatTaskStatusLabel(status)}`;
	});
	if (input.conductor?.holdReason) {
		bullets.unshift(`Board hold: ${formatConductorOperatorMessage(input.conductor.holdReason)}`);
	}

	return {
		title: 'Current blockers',
		body:
			blocked.length > 0
				? `${blocked.length} top-level task${blocked.length === 1 ? '' : 's'} still need review, revision, proof, or a blocker cleared.`
				: 'The board itself is holding even though no single top-level task is currently blocked.',
		bullets,
		relatedTaskId: blocked[0]?.id,
		actions: [
			...(blocked[0] ? [{ type: 'open_task' as const, label: 'Open top blocker', taskId: blocked[0].id }] : []),
			input.conductor?.isPaused
				? { type: 'resume_board' as const, label: 'Resume conductor' }
				: { type: 'pause_board' as const, label: 'Pause conductor' },
		],
	};
}

function buildBoardReply(input: {
	groupName: string;
	conductor?: Conductor | null;
	topLevelTasks: ConductorTask[];
	childTasksByParentId: Map<string, ConductorTask[]>;
	runs: ConductorRun[];
	team: ConductorOrchestratorTeamSnapshot[];
}): ConductorOrchestratorReply {
	const counts = countTopLevelStatuses(input.topLevelTasks, input.childTasksByParentId, input.runs);
	const nextReadyTask = input.topLevelTasks.find(
		(task) => getConductorTaskRollupStatus(task, input.childTasksByParentId, input.runs) === 'ready'
	);
	const activeCount = input.team.filter((member) => member.status === 'working').length;
	const waitingOnYouCount = (counts.get('needs_input') || 0) + (counts.get('needs_proof') || 0);

	return {
		title: `${input.groupName} at a glance`,
		body:
			waitingOnYouCount > 0
				? `${waitingOnYouCount} task${waitingOnYouCount === 1 ? '' : 's'} still need your guidance.`
				: activeCount > 0
					? `${activeCount} teammate${activeCount === 1 ? '' : 's'} are actively working.`
					: nextReadyTask
						? `The board is quiet right now. ${nextReadyTask.title} looks like the next top-level task to move.`
						: 'The board is quiet right now.',
		bullets: [
			`${counts.get('done') || 0} done`,
			`${counts.get('needs_review') || 0} in QA`,
			`${counts.get('needs_revision') || 0} in revision`,
			`${counts.get('needs_input') || 0} waiting on you`,
			`${counts.get('needs_proof') || 0} waiting on proof`,
			input.conductor?.holdReason
				? `Board hold: ${formatConductorOperatorMessage(input.conductor.holdReason)}`
				: nextReadyTask
					? `Next likely task: ${nextReadyTask.title}`
					: 'No top-level task is queued to move next',
		],
		relatedTaskId: nextReadyTask?.id,
		actions: [
			input.conductor?.isPaused
				? { type: 'resume_board' as const, label: 'Resume conductor' }
				: { type: 'pause_board' as const, label: 'Pause conductor' },
			...(nextReadyTask ? [{ type: 'open_task' as const, label: 'Open next task', taskId: nextReadyTask.id }] : []),
		],
	};
}

export function buildConductorOrchestratorReply(input: {
	groupName: string;
	context: ConductorOrchestratorContext;
	question?: string;
	conductor?: Conductor | null;
	tasksById: Map<string, ConductorTask>;
	childTasksByParentId: Map<string, ConductorTask[]>;
	runs: ConductorRun[];
	updates: ConductorOrchestratorUpdate[];
	team: ConductorOrchestratorTeamSnapshot[];
}): ConductorOrchestratorReply {
	const topLevelTasks = getTopLevelConductorTasks([...input.tasksById.values()]);
	const normalizedQuestion = (input.question || '').trim().toLowerCase();
	const context = input.context;
	const reprioritizationReply = input.question
		? buildReprioritizationReply({
				question: input.question,
				topLevelTasks,
				childTasksByParentId: input.childTasksByParentId,
				runs: input.runs,
		  })
		: null;

	if (reprioritizationReply) {
		return reprioritizationReply;
	}

	if (
		normalizedQuestion.includes('need me') ||
		normalizedQuestion.includes('needs me') ||
		normalizedQuestion.includes('waiting on me')
	) {
		return buildWhatNeedsMeReply({
			topLevelTasks,
			childTasksByParentId: input.childTasksByParentId,
			runs: input.runs,
		});
	}

	if (
		normalizedQuestion.includes('what changed') ||
		normalizedQuestion.includes('recent') ||
		normalizedQuestion.includes('latest')
	) {
		return buildWhatChangedReply(input.updates);
	}

	if (
		normalizedQuestion.includes('what is moving') ||
		normalizedQuestion.includes('who is working') ||
		normalizedQuestion.includes('who\'s working')
	) {
		return buildWhatIsMovingReply(input.team);
	}

	if (normalizedQuestion.includes('blocked')) {
		return buildBlockedReply({
			topLevelTasks,
			childTasksByParentId: input.childTasksByParentId,
			runs: input.runs,
			conductor: input.conductor,
		});
	}

	switch (context.scope) {
		case 'task': {
			const task = input.tasksById.get(context.taskId);
			if (!task) {
				break;
			}
			return buildTaskReply({
				task,
				childTasksByParentId: input.childTasksByParentId,
				runs: input.runs,
				updates: input.updates,
			});
		}
		case 'update': {
			const update = input.updates.find((item) => item.id === context.updateId);
			if (!update) {
				break;
			}
			return buildUpdateReply({
				update,
				tasksById: input.tasksById,
				childTasksByParentId: input.childTasksByParentId,
				runs: input.runs,
			});
		}
		case 'member': {
			const member = input.team.find((item) => item.name === context.memberName);
			if (!member) {
				break;
			}
			return buildMemberReply({
				member,
				tasksById: input.tasksById,
				childTasksByParentId: input.childTasksByParentId,
				runs: input.runs,
			});
		}
		case 'board':
		default:
			break;
	}

	return buildBoardReply({
		groupName: input.groupName,
		conductor: input.conductor,
		topLevelTasks,
		childTasksByParentId: input.childTasksByParentId,
		runs: input.runs,
		team: input.team,
	});
}
