import { useEffect, useMemo, useState } from 'react';
import {
	ArrowLeft,
	ArrowUpRight,
	CheckCircle2,
	FolderKanban,
	LayoutGrid,
	Loader2,
	MessageCircle,
	PlayCircle,
	Plus,
	Trash2,
	X,
} from 'lucide-react';
import { useThemeColors } from '../components/ThemeProvider';
import { buildApiUrl } from '../utils/config';
import type {
	Group,
	Conductor,
	ConductorTask,
	ConductorRun,
	ConductorTaskAttentionRequest,
	ConductorTaskPriority,
	ConductorTaskStatus,
	ConductorTaskCompletionProofStatus,
} from '../../shared/types';
import type { DemoDetail } from '../../shared/demo-artifacts';
import {
	buildConductorHoldReason,
	buildConductorMetrics,
	buildWorkspaceSummaries,
	groupTasksByLane,
	MOBILE_CONDUCTOR_COLUMNS,
	MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS,
	MOBILE_CONDUCTOR_PRIORITY_LABELS,
	MOBILE_CONDUCTOR_STATUS_LABELS,
	PASTEL_STATUS_TONES,
} from './conductorUtils';
import {
	buildConductorChildTaskMap,
	formatConductorOperatorMessage,
	getConductorTaskAttentionBlockers,
	getConductorTaskQaFailureState,
	getConductorTaskVisibleAttention,
	isConductorTaskAgentRevision,
	isConductorTaskOperatorActionRequired,
	getConductorTaskOpenFollowUps,
	getConductorTaskProgress,
	getConductorTaskRollupStatus,
	getTopLevelConductorTasks,
	requiresConductorTaskCompletionProof,
} from '../../shared/conductorTasks';
import { buildConductorOrchestratorUpdates } from '../../shared/conductorUpdates';
import type { ConductorOrchestratorUpdate } from '../../shared/conductorUpdates';
import type {
	ConductorOrchestratorAction,
	ConductorOrchestratorContext,
} from '../../shared/conductorOrchestrator';
import { resolveConductorRosterIdentity } from '../../shared/conductorRoster';
import type { ConductorProviderAgent } from '../../shared/types';
import { MobileTeamPanel, type MobileTeamMember } from './MobileTeamPanel';
import { MobileUpdatesPanel } from './MobileUpdatesPanel';
import { MobileOrchestratorChat } from './MobileOrchestratorChat';

type MobileKanbanScope =
	| { type: 'home' }
	| {
			type: 'workspace';
			groupId: string;
	  };

export interface MobileSessionInfo {
	id: string;
	name: string;
	toolType: string;
	state: string;
	groupId?: string | null;
	lastTurnAt?: number | null;
	aiTabs?: Array<{ id: string; name?: string | null }>;
}

type WorkspaceTab = 'board' | 'team' | 'updates';

interface MobileKanbanPanelProps {
	isOpen: boolean;
	scope: MobileKanbanScope | null;
	groups: Group[];
	conductors: Conductor[];
	tasks: ConductorTask[];
	runs: ConductorRun[];
	sessions?: MobileSessionInfo[];
	isLoading: boolean;
	error: string | null;
	onClose: () => void;
	onRefresh: () => Promise<void> | void;
	onOpenHome: () => void;
	onOpenWorkspace: (groupId: string) => void;
	onCreateTask: (input: {
		groupId: string;
		title: string;
		description?: string;
		priority?: ConductorTaskPriority;
		status?: ConductorTaskStatus;
	}) => Promise<void>;
	onUpdateTask: (
		taskId: string,
		updates: {
			title?: string;
			description?: string;
			priority?: ConductorTaskPriority;
			status?: ConductorTaskStatus;
			acceptanceCriteria?: string[];
			attentionRequest?: ConductorTaskAttentionRequest | null;
			completionProofRequirement?: ConductorTask['completionProofRequirement'];
			completionProof?: ConductorTask['completionProof'];
		}
	) => Promise<void>;
	onDeleteTask: (taskId: string) => Promise<void>;
	onOpenDemo?: (demoId: string) => void;
	onOpenAgentSession?: (sessionId: string) => void;
}

interface TaskDraft {
	title: string;
	description: string;
	priority: ConductorTaskPriority;
	status: ConductorTaskStatus;
	acceptanceCriteria: string;
}

interface TaskCardMeta {
	workspace: Group | null;
	progress: ReturnType<typeof getConductorTaskProgress>;
	visibleAttention: ReturnType<typeof getConductorTaskVisibleAttention>;
	operatorAttentionMessage: string | null;
	firstFollowUpTitle: string | null;
	updatedLabel: string;
}

type CompletionProofTone = 'warning' | 'accent' | 'success' | 'error';

interface CompletionProofDisplayState {
	status: ConductorTaskCompletionProofStatus;
	label: string;
	summary: string;
	tone: CompletionProofTone;
}

const COMPLETION_PROOF_STATUS_LABELS: Record<ConductorTaskCompletionProofStatus, string> = {
	missing: 'Missing',
	capturing: 'Capturing',
	captured: 'Captured',
	approved: 'Approved',
	rejected: 'Rejected',
};

function buildDefaultTaskDraft(): TaskDraft {
	return {
		title: '',
		description: '',
		priority: 'medium',
		status: 'draft',
		acceptanceCriteria: '',
	};
}

function formatRelativeTime(timestamp: number): string {
	const elapsedMs = Date.now() - timestamp;
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;

	if (elapsedMs < minute) {
		return 'Just now';
	}
	if (elapsedMs < hour) {
		return `${Math.round(elapsedMs / minute)}m ago`;
	}
	if (elapsedMs < day) {
		return `${Math.round(elapsedMs / hour)}h ago`;
	}
	return `${Math.round(elapsedMs / day)}d ago`;
}

function artifactUrl(artifactId?: string | null): string | null {
	if (!artifactId) {
		return null;
	}
	return buildApiUrl(`/artifacts/${artifactId}/content`);
}

function getCompletionProofRequirementSummary(task: ConductorTask): string {
	const requirement = task.completionProofRequirement;
	if (!requirement?.required) {
		return 'No completion proof required.';
	}
	const screenshotLabel =
		requirement.minScreenshots === 1
			? '1 screenshot'
			: `${Math.max(0, requirement.minScreenshots || 0)} screenshots`;
	if (requirement.requireVideo) {
		return `Needs a screen recording and ${screenshotLabel} before the task can move into Done.`;
	}
	return `Needs ${screenshotLabel} before the task can move into Done.`;
}

function getCompletionProofDisplayState(
	task: ConductorTask,
	rolledUpStatus: ConductorTaskStatus | null
): CompletionProofDisplayState | null {
	if (!requiresConductorTaskCompletionProof(task)) {
		return null;
	}

	const proofStatus = task.completionProof?.status || 'missing';
	switch (proofStatus) {
		case 'approved':
			return {
				status: proofStatus,
				label: 'Proof approved',
				summary: 'Completion proof has been reviewed and approved for this task.',
				tone: 'success',
			};
		case 'captured':
			return {
				status: proofStatus,
				label: 'Proof captured',
				summary: 'Proof artifacts are attached and ready for review.',
				tone: 'accent',
			};
		case 'capturing':
			return {
				status: proofStatus,
				label: 'Capturing proof',
				summary: 'A reviewer is recording the proof artifacts for this task right now.',
				tone: 'accent',
			};
		case 'rejected':
			return {
				status: proofStatus,
				label: 'Proof rejected',
				summary: 'The last proof was rejected and needs to be recaptured.',
				tone: 'error',
			};
		case 'missing':
		default:
			if (rolledUpStatus !== 'needs_proof') {
				return null;
			}
			return {
				status: 'missing',
				label: 'Proof required',
				summary: 'This task cannot move into Done until proof is captured and reviewed.',
				tone: 'warning',
			};
	}
}

export function MobileKanbanPanel({
	isOpen,
	scope,
	groups,
	conductors,
	tasks,
	runs,
	sessions = [],
	isLoading,
	error,
	onClose,
	onRefresh: _onRefresh,
	onOpenHome,
	onOpenWorkspace,
	onCreateTask,
	onUpdateTask,
	onDeleteTask,
	onOpenDemo,
	onOpenAgentSession,
}: MobileKanbanPanelProps): JSX.Element | null {
	const colors = useThemeColors();
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [editorDraft, setEditorDraft] = useState<TaskDraft>(() => buildDefaultTaskDraft());
	const [isCreatingTask, setIsCreatingTask] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [responseDrafts, setResponseDrafts] = useState<Record<string, string>>({});
	const [activeLaneIndex, setActiveLaneIndex] = useState(0);
	const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('board');
	const [orchestratorContext, setOrchestratorContext] =
		useState<ConductorOrchestratorContext | null>(null);
	const [isEditingTask, setIsEditingTask] = useState(false);
	const [selectedTaskProofDemo, setSelectedTaskProofDemo] = useState<DemoDetail | null>(null);

	const selectedTask = useMemo(
		() => tasks.find((task) => task.id === selectedTaskId) || null,
		[selectedTaskId, tasks]
	);
	const activeGroup =
		scope?.type === 'workspace' ? groups.find((group) => group.id === scope.groupId) || null : null;
	const visibleTasks = useMemo(() => {
		if (scope?.type === 'workspace') {
			return tasks.filter((task) => task.groupId === scope.groupId);
		}
		return tasks;
	}, [scope, tasks]);
	const childTaskMap = useMemo(() => buildConductorChildTaskMap(visibleTasks), [visibleTasks]);
	const visibleAttentionByTaskId = useMemo(() => {
		const entries = visibleTasks.map(
			(task) =>
				[
					task.id,
					getConductorTaskVisibleAttention(
						task,
						childTaskMap,
						runs,
						MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS
					),
				] as const
		);
		return new Map(entries);
	}, [childTaskMap, runs, visibleTasks]);
	const laneGroups = useMemo(() => groupTasksByLane(visibleTasks, runs), [runs, visibleTasks]);
	const metrics = useMemo(() => buildConductorMetrics(visibleTasks, runs), [runs, visibleTasks]);
	const workspaceSummaries = useMemo(
		() => buildWorkspaceSummaries(groups, tasks, runs),
		[groups, runs, tasks]
	);
	const workspaceById = useMemo(
		() => new Map(groups.map((group) => [group.id, group] as const)),
		[groups]
	);
	const currentConductor = useMemo(
		() =>
			scope?.type === 'workspace'
				? conductors.find((conductor) => conductor.groupId === scope.groupId) || null
				: null,
		[conductors, scope]
	);
	const holdReason = useMemo(
		() => buildConductorHoldReason(currentConductor, visibleTasks, runs),
		[currentConductor, runs, visibleTasks]
	);
	const selectedTaskProgress = useMemo(
		() =>
			selectedTask
				? getConductorTaskProgress(selectedTask, childTaskMap)
				: { totalSubtasks: 0, completedSubtasks: 0, openSubtasks: 0, completionRatio: 0 },
		[childTaskMap, selectedTask]
	);
	const selectedTaskRolledUpStatus = useMemo(
		() =>
			selectedTask
				? getConductorTaskRollupStatus(
						selectedTask,
						childTaskMap,
						runs,
						MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS
					)
				: null,
		[childTaskMap, runs, selectedTask]
	);
	const selectedTaskProofDisplayState = useMemo(
		() =>
			selectedTask
				? getCompletionProofDisplayState(selectedTask, selectedTaskRolledUpStatus)
				: null,
		[selectedTask, selectedTaskRolledUpStatus]
	);
	const selectedTaskChildren = useMemo(
		() => (selectedTask ? childTaskMap.get(selectedTask.id) || [] : []),
		[childTaskMap, selectedTask]
	);
	const selectedTaskOpenFollowUps = useMemo(
		() => (selectedTask ? getConductorTaskOpenFollowUps(selectedTask, childTaskMap) : []),
		[childTaskMap, selectedTask]
	);
	const selectedTaskAttentionBlockers = useMemo(
		() =>
			selectedTask
				? getConductorTaskAttentionBlockers(
						selectedTask,
						childTaskMap,
						runs,
						MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS
					)
				: [],
		[childTaskMap, runs, selectedTask]
	);
	const selectedTaskEffectiveAttention = useMemo(
		() =>
			selectedTask ? visibleAttentionByTaskId.get(selectedTask.id)?.attentionRequest || null : null,
		[selectedTask, visibleAttentionByTaskId]
	);
	const selectedTaskAttentionTarget = useMemo(
		() => (selectedTask ? visibleAttentionByTaskId.get(selectedTask.id)?.task || null : null),
		[selectedTask, visibleAttentionByTaskId]
	);
	const selectedTaskNeedsOperatorAttention = useMemo(
		() =>
			selectedTask
				? (() => {
						const visibleAttention = visibleAttentionByTaskId.get(selectedTask.id);
						return visibleAttention
							? isConductorTaskOperatorActionRequired(
									visibleAttention.task,
									childTaskMap,
									runs,
									MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS
								)
							: false;
					})()
				: false,
		[childTaskMap, runs, selectedTask, visibleAttentionByTaskId]
	);
	const proofToneByKey = useMemo(
		() => ({
			warning: colors.warning,
			accent: colors.accent,
			success: colors.success,
			error: colors.error,
		}),
		[colors.accent, colors.error, colors.success, colors.warning]
	);
	const selectedTaskProofPosterUrl = useMemo(
		() => artifactUrl(selectedTaskProofDemo?.posterArtifact?.id),
		[selectedTaskProofDemo?.posterArtifact?.id]
	);
	const selectedTaskQaFailureState = useMemo(
		() => (selectedTask ? getConductorTaskQaFailureState(selectedTask, runs) : null),
		[runs, selectedTask]
	);

	useEffect(() => {
		const demoId = selectedTask?.completionProof?.demoId;
		if (!demoId) {
			setSelectedTaskProofDemo(null);
			return;
		}

		let cancelled = false;
		setSelectedTaskProofDemo(null);
		void window.maestro.artifacts
			.getDemo(demoId)
			.then((demo) => {
				if (!cancelled) {
					setSelectedTaskProofDemo(demo);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setSelectedTaskProofDemo(null);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [selectedTask?.completionProof?.demoId]);
	const taskCardMetaById = useMemo(() => {
		const entries = visibleTasks.map((task) => {
			const progress = getConductorTaskProgress(task, childTaskMap);
			const visibleAttention = visibleAttentionByTaskId.get(task.id) ?? null;
			const operatorAttentionMessage =
				visibleAttention &&
				isConductorTaskOperatorActionRequired(
					visibleAttention.task,
					childTaskMap,
					runs,
					MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS
				)
					? formatConductorOperatorMessage(visibleAttention.attentionRequest.requestedAction)
					: null;
			const firstFollowUpTitle =
				getConductorTaskOpenFollowUps(task, childTaskMap)[0]?.title ?? null;
			return [
				task.id,
				{
					workspace: workspaceById.get(task.groupId) ?? null,
					progress,
					visibleAttention,
					operatorAttentionMessage,
					firstFollowUpTitle,
					updatedLabel: formatRelativeTime(task.updatedAt),
				},
			] as const;
		});
		return new Map<string, TaskCardMeta>(entries);
	}, [childTaskMap, runs, visibleAttentionByTaskId, visibleTasks, workspaceById]);

	// ── Team members derived from sessions + tasks ──
	const tasksById = useMemo(
		() => new Map(visibleTasks.map((task) => [task.id, task] as const)),
		[visibleTasks]
	);

	const conductorTeamMembers = useMemo<MobileTeamMember[]>(() => {
		if (scope?.type !== 'workspace') return [];

		const groupSessions = sessions.filter((session) => session.groupId === scope.groupId);

		const byKey = new Map<string, { member: MobileTeamMember; priority: number }>();

		const getStatusPriority = (status: MobileTeamMember['status']): number => {
			switch (status) {
				case 'working':
					return 3;
				case 'error':
					return 2;
				case 'waiting':
					return 1;
				case 'idle':
				default:
					return 0;
			}
		};

		// Build from tasks' agent session refs
		const taskSessionRefs = visibleTasks.flatMap((task) =>
			[
				{
					role: 'worker',
					sessionId: task.workerSessionId,
					sessionName: task.workerSessionName,
					task,
				},
				{
					role: 'planner',
					sessionId: task.plannerSessionId,
					sessionName: task.plannerSessionName,
					task,
				},
				{
					role: 'reviewer',
					sessionId: task.reviewerSessionId,
					sessionName: task.reviewerSessionName,
					task,
				},
			].filter((ref) => ref.sessionId)
		);

		// Cross-reference with live sessions
		const sessionMap = new Map(groupSessions.map((s) => [s.id, s]));

		for (const ref of taskSessionRefs) {
			const liveSession = ref.sessionId ? sessionMap.get(ref.sessionId) : null;
			const providerToolType = (
				liveSession?.toolType === 'terminal'
					? 'claude-code'
					: liveSession?.toolType || 'claude-code'
			) as ConductorProviderAgent;
			const identity = resolveConductorRosterIdentity(
				providerToolType,
				ref.sessionName || ref.sessionId || ''
			);
			const parentTask = ref.task.parentTaskId
				? tasksById.get(ref.task.parentTaskId) || ref.task
				: ref.task;
			const topLevelTask = getTopLevelConductorTasks([parentTask])[0] || parentTask;
			const rolledUpStatus = getConductorTaskRollupStatus(
				topLevelTask,
				childTaskMap,
				runs,
				MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS
			);

			const status: MobileTeamMember['status'] =
				liveSession?.state === 'busy'
					? 'working'
					: ['needs_revision', 'needs_review', 'needs_input', 'needs_proof', 'blocked'].includes(
								rolledUpStatus
						  )
						? 'waiting'
						: 'idle';
			const isWorking = liveSession?.state === 'busy';

			const member: MobileTeamMember = {
				sessionId: ref.sessionId || '',
				name: identity.name,
				emoji: identity.emoji,
				providerLabel: providerToolType,
				status,
				parentTaskId: isWorking ? topLevelTask.id : undefined,
				parentTaskTitle: isWorking ? topLevelTask.title : undefined,
				threadTargets: liveSession?.aiTabs?.length
					? liveSession.aiTabs.map((tab, idx) => ({
							sessionId: liveSession.id,
							tabId: tab.id,
							label: tab.name?.trim() || `Thread ${idx + 1}`,
						}))
					: [{ sessionId: ref.sessionId || '', label: 'Conversation' }],
				lastActiveAt: liveSession?.lastTurnAt || ref.task.updatedAt,
			};

			const key = `${providerToolType}:${identity.name}`;
			const existing = byKey.get(key);
			if (!existing) {
				byKey.set(key, { member, priority: getStatusPriority(status) });
				continue;
			}

			const nextPriority = getStatusPriority(status);
			const shouldReplace =
				nextPriority > existing.priority ||
				(nextPriority === existing.priority && member.lastActiveAt > existing.member.lastActiveAt);

			byKey.set(key, {
				priority: Math.max(existing.priority, nextPriority),
				member: {
					...(shouldReplace ? member : existing.member),
					parentTaskId: existing.member.parentTaskId || member.parentTaskId,
					parentTaskTitle: existing.member.parentTaskTitle || member.parentTaskTitle,
					lastActiveAt: Math.max(existing.member.lastActiveAt, member.lastActiveAt),
				},
			});
		}

		return [...byKey.values()]
			.map((entry) => entry.member)
			.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
	}, [childTaskMap, runs, scope, sessions, tasksById, visibleTasks]);

	// ── Orchestrator updates derived from runs ──
	const runIsLiveById = useMemo(() => {
		const map = new Map<string, boolean>();
		for (const run of runs) {
			map.set(run.id, !run.endedAt);
		}
		return map;
	}, [runs]);

	const orchestratorUpdates = useMemo<ConductorOrchestratorUpdate[]>(
		() =>
			buildConductorOrchestratorUpdates({
				runs,
				tasksById,
				runIsLiveById,
				limit: 10,
			}),
		[runs, runIsLiveById, tasksById]
	);

	// ── Orchestrator chat helpers ──
	const openOrchestratorChat = (ctx: ConductorOrchestratorContext) => {
		setOrchestratorContext(ctx);
	};

	const handleApplyOrchestratorAction = (action: ConductorOrchestratorAction) => {
		if (action.type === 'open_task') {
			setSelectedTaskId(action.taskId);
			setOrchestratorContext(null);
			return;
		}
		// For board-level actions, delegate to the update handler
		if (action.type === 'pause_board' || action.type === 'resume_board') {
			// These would need conductor store updates - no-op on mobile for now
			setOrchestratorContext(null);
			return;
		}
		if ('taskId' in action && action.taskId) {
			const taskAction = action as { taskId: string; priority?: ConductorTaskPriority };
			if (taskAction.priority) {
				void onUpdateTask(taskAction.taskId, { priority: taskAction.priority });
			}
		}
		setOrchestratorContext(null);
	};

	useEffect(() => {
		if (!isOpen) {
			setSelectedTaskId(null);
			setIsCreatingTask(false);
			setWorkspaceTab('board');
			setOrchestratorContext(null);
			return;
		}

		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = previousOverflow;
		};
	}, [isOpen]);

	useEffect(() => {
		if (!selectedTask) {
			if (!isCreatingTask) {
				setEditorDraft(buildDefaultTaskDraft());
			}
			return;
		}

		setEditorDraft({
			title: selectedTask.title,
			description: selectedTask.description,
			priority: selectedTask.priority,
			status: selectedTask.status,
			acceptanceCriteria: selectedTask.acceptanceCriteria.join('\n'),
		});
	}, [isCreatingTask, selectedTask]);

	useEffect(() => {
		if (!selectedTask || !selectedTaskAttentionTarget) {
			return;
		}

		setResponseDrafts((previous) => {
			if (previous[selectedTaskAttentionTarget.id] !== undefined) {
				return previous;
			}

			return {
				...previous,
				[selectedTaskAttentionTarget.id]: selectedTaskEffectiveAttention?.response || '',
			};
		});
	}, [selectedTask, selectedTaskAttentionTarget, selectedTaskEffectiveAttention]);

	if (!isOpen || !scope) {
		return null;
	}

	const mutedSurface: React.CSSProperties = {
		background: 'rgba(255,255,255,0.05)',
		border: '1px solid rgba(255,255,255,0.06)',
		boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
	};
	const scrollCardSurface: React.CSSProperties = {
		backgroundColor: colors.bgSidebar,
		border: '1px solid rgba(255,255,255,0.10)',
		boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
	};

	const buttonStyle: React.CSSProperties = {
		height: '40px',
		borderRadius: '14px',
		border: '1px solid rgba(255,255,255,0.08)',
		background: 'rgba(255,255,255,0.08)',
		color: colors.textMain,
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		gap: '8px',
		padding: '0 14px',
		fontSize: '12px',
		fontWeight: 600,
		cursor: 'pointer',
	};

	const handleTaskOpen = (task: ConductorTask) => {
		setIsCreatingTask(false);
		setIsEditingTask(false);
		setSelectedTaskId(task.id);
	};

	const handleStartCreate = () => {
		if (!activeGroup) {
			return;
		}
		setSelectedTaskId(null);
		setEditorDraft(buildDefaultTaskDraft());
		setIsCreatingTask(true);
		setIsEditingTask(false);
	};

	const handleCloseEditor = () => {
		setSelectedTaskId(null);
		setIsCreatingTask(false);
		setIsEditingTask(false);
		setEditorDraft(buildDefaultTaskDraft());
	};

	const handleSave = async () => {
		if (isSaving) {
			return;
		}

		if (!editorDraft.title.trim()) {
			return;
		}

		setIsSaving(true);
		try {
			if (isCreatingTask && activeGroup) {
				await onCreateTask({
					groupId: activeGroup.id,
					title: editorDraft.title.trim(),
					description: editorDraft.description.trim(),
					priority: editorDraft.priority,
					status: editorDraft.status,
				});
			} else if (selectedTask) {
				await onUpdateTask(selectedTask.id, {
					title: editorDraft.title.trim(),
					description: editorDraft.description.trim(),
					priority: editorDraft.priority,
					status: editorDraft.status,
					acceptanceCriteria: editorDraft.acceptanceCriteria
						.split('\n')
						.map((line) => line.trim())
						.filter(Boolean),
				});
			}
			handleCloseEditor();
		} finally {
			setIsSaving(false);
		}
	};

	const handleDelete = async () => {
		if (!selectedTask || isSaving) {
			return;
		}

		const confirmed = window.confirm(`Delete task "${selectedTask.title}"?`);
		if (!confirmed) {
			return;
		}

		setIsSaving(true);
		try {
			await onDeleteTask(selectedTask.id);
			handleCloseEditor();
		} finally {
			setIsSaving(false);
		}
	};

	const handleResolveAttention = async () => {
		if (
			!selectedTask ||
			!selectedTaskAttentionTarget ||
			!selectedTaskEffectiveAttention ||
			!selectedTaskNeedsOperatorAttention ||
			isSaving
		) {
			return;
		}

		const response = (responseDrafts[selectedTaskAttentionTarget.id] || '').trim();
		setIsSaving(true);
		try {
			await onUpdateTask(selectedTaskAttentionTarget.id, {
				description: response
					? [selectedTaskAttentionTarget.description.trim(), `Operator follow-up:\n${response}`]
							.filter(Boolean)
							.join('\n\n')
					: selectedTaskAttentionTarget.description,
				status: 'ready',
				attentionRequest: {
					...selectedTaskEffectiveAttention,
					status: 'resolved',
					response,
					updatedAt: Date.now(),
					resolvedAt: Date.now(),
				},
			});
			handleCloseEditor();
		} finally {
			setIsSaving(false);
		}
	};

	const handleApproveCompletionProof = async () => {
		if (
			!selectedTask ||
			!selectedTaskProofDisplayState ||
			selectedTaskProofDisplayState.status !== 'captured'
		) {
			return;
		}

		const now = Date.now();
		setIsSaving(true);
		try {
			await onUpdateTask(selectedTask.id, {
				status: 'done',
				completionProof: {
					...(selectedTask.completionProof || {
						status: 'captured',
						requestedAt: selectedTask.updatedAt,
					}),
					status: 'approved',
					approvedAt: now,
				},
			});
		} finally {
			setIsSaving(false);
		}
	};

	const getTaskAgentLinks = (task: ConductorTask) => {
		const sessionRefs = [
			{ role: 'planner', sessionId: task.plannerSessionId, sessionName: task.plannerSessionName },
			{ role: 'worker', sessionId: task.workerSessionId, sessionName: task.workerSessionName },
			{
				role: 'reviewer',
				sessionId: task.reviewerSessionId,
				sessionName: task.reviewerSessionName,
			},
		].flatMap((entry) =>
			entry.sessionId
				? [{ role: entry.role, sessionId: entry.sessionId, sessionName: entry.sessionName }]
				: []
		);

		return [...(task.agentHistory || []), ...sessionRefs].filter(
			(entry, index, entries) =>
				entries.findIndex(
					(candidate) => candidate.role === entry.role && candidate.sessionId === entry.sessionId
				) === index
		);
	};

	const taskCardStyle: React.CSSProperties = {
		...scrollCardSurface,
		borderRadius: '14px',
		padding: '12px 14px',
		display: 'block',
		textAlign: 'left',
		cursor: 'pointer',
		minWidth: 0,
		width: '100%',
		boxSizing: 'border-box',
		outline: 'none',
	};

	return (
		<div
			style={{
				position: 'fixed',
				inset: 0,
				zIndex: 150,
				background: 'rgba(2, 8, 23, 0.52)',
				display: 'flex',
				justifyContent: 'center',
			}}
		>
			<div
				style={{
					width: 'min(100vw, 520px)',
					height: '100%',
					display: 'flex',
					flexDirection: 'column',
					overflow: 'hidden',
					isolation: 'isolate',
					backgroundColor: colors.bgMain,
					background: `linear-gradient(180deg, ${colors.bgSidebar} 0%, ${colors.bgMain} 100%)`,
				}}
			>
				<header
					style={{
						padding: '12px 16px 0',
						paddingTop: 'max(14px, env(safe-area-inset-top))',
						display: 'flex',
						flexDirection: 'column',
						gap: '10px',
						position: 'sticky',
						top: 0,
						zIndex: 2,
						background: `linear-gradient(180deg, ${colors.bgSidebar} 0%, ${colors.bgMain} 100%)`,
					}}
				>
					{/* Top row: back + title + actions */}
					<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
						{scope.type === 'workspace' ? (
							<button
								type="button"
								onClick={onOpenHome}
								style={{ ...buttonStyle, width: '36px', height: '36px', padding: 0 }}
							>
								<ArrowLeft size={15} />
							</button>
						) : (
							<LayoutGrid size={16} color={colors.accent} style={{ flexShrink: 0 }} />
						)}
						<div style={{ minWidth: 0, flex: 1 }}>
							<div
								style={{
									fontSize: '15px',
									fontWeight: 700,
									color: colors.textMain,
									whiteSpace: 'nowrap',
									overflow: 'hidden',
									textOverflow: 'ellipsis',
								}}
							>
								{scope.type === 'home'
									? 'Kanban'
									: `${activeGroup?.emoji || '📂'} ${activeGroup?.name || 'Workspace'}`}
							</div>
						</div>
						{scope.type === 'workspace' && (
							<>
								<button
									type="button"
									onClick={() => openOrchestratorChat({ scope: 'board' })}
									style={{
										...buttonStyle,
										width: '36px',
										height: '36px',
										padding: 0,
										background: `${colors.accent}14`,
										border: `1px solid ${colors.accent}28`,
										color: colors.accent,
									}}
								>
									<MessageCircle size={15} />
								</button>
								<button
									type="button"
									onClick={handleStartCreate}
									style={{
										...buttonStyle,
										height: '36px',
										padding: '0 12px',
										background: `${colors.accent}20`,
										border: `1px solid ${colors.accent}32`,
										color: colors.accent,
									}}
								>
									<Plus size={14} />
								</button>
							</>
						)}
						<button
							type="button"
							onClick={onClose}
							style={{ ...buttonStyle, width: '36px', height: '36px', padding: 0 }}
						>
							<X size={14} />
						</button>
					</div>

					{/* Compact inline metric pills */}
					<div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
						{[
							{ label: 'Open', value: metrics.open, tone: colors.accent },
							{ label: 'Running', value: metrics.running, tone: colors.warning },
							{ label: 'Attention', value: metrics.attention, tone: colors.error },
							{ label: 'Done', value: metrics.done, tone: colors.success },
						].map((pill) => (
							<span
								key={pill.label}
								style={{
									padding: '4px 10px',
									borderRadius: '999px',
									background: `${pill.tone}14`,
									border: `1px solid ${pill.tone}28`,
									fontSize: '11px',
									fontWeight: 700,
									color: pill.tone,
								}}
							>
								{pill.value} {pill.label}
							</span>
						))}
					</div>

					{/* Hold reason (if any) */}
					{scope.type === 'workspace' && holdReason && (
						<div
							style={{ fontSize: '11px', color: colors.warning, lineHeight: 1.4, padding: '0 2px' }}
						>
							{holdReason}
						</div>
					)}

					{/* Workspace section tabs: Board / Team / Updates */}
					{scope.type === 'workspace' && (
						<div
							style={{
								display: 'flex',
								gap: '0',
								borderBottom: '1px solid rgba(255,255,255,0.06)',
							}}
						>
							{[
								{ key: 'board' as const, label: 'Board' },
								{
									key: 'team' as const,
									label: `Team${conductorTeamMembers.length > 0 ? ` (${conductorTeamMembers.filter((m) => m.status === 'working' || m.status === 'waiting' || m.status === 'error').length})` : ''}`,
								},
								{
									key: 'updates' as const,
									label: `Updates${orchestratorUpdates.length > 0 ? ` (${orchestratorUpdates.length})` : ''}`,
								},
							].map((tab) => {
								const isSelected = workspaceTab === tab.key;
								return (
									<button
										key={tab.key}
										type="button"
										onClick={() => setWorkspaceTab(tab.key)}
										style={{
											flex: 1,
											padding: '9px 8px',
											fontSize: '11px',
											fontWeight: 700,
											textTransform: 'uppercase',
											letterSpacing: '0.05em',
											textAlign: 'center',
											background: 'transparent',
											border: 'none',
											borderBottom: isSelected
												? `2px solid ${colors.accent}`
												: '2px solid transparent',
											color: isSelected ? colors.textMain : colors.textDim,
											cursor: 'pointer',
										}}
									>
										{tab.label}
									</button>
								);
							})}
						</div>
					)}

					{/* Lane tabs — swipeable navigation (board tab only) */}
					{scope.type === 'workspace' && workspaceTab === 'board' && (
						<div
							style={{
								display: 'flex',
								gap: '2px',
								overflowX: 'auto',
								WebkitOverflowScrolling: 'touch',
								scrollbarWidth: 'none',
								paddingBottom: '2px',
							}}
						>
							{laneGroups.map((group, index) => {
								const isActive = activeLaneIndex === index;
								const count = group.tasks.length;
								return (
									<button
										key={group.lane.key}
										type="button"
										onClick={() => setActiveLaneIndex(index)}
										style={{
											padding: '8px 12px',
											borderRadius: '12px 12px 0 0',
											border: 'none',
											borderBottom: isActive
												? `2px solid ${group.lane.color}`
												: '2px solid transparent',
											background: isActive ? `${group.lane.color}14` : 'transparent',
											color: isActive ? group.lane.color : colors.textDim,
											fontSize: '12px',
											fontWeight: isActive ? 700 : 600,
											whiteSpace: 'nowrap',
											cursor: 'pointer',
											display: 'flex',
											alignItems: 'center',
											gap: '6px',
											flexShrink: 0,
											transition: 'all 0.15s ease',
										}}
									>
										{group.lane.label}
										{count > 0 && (
											<span
												style={{
													minWidth: '18px',
													height: '18px',
													padding: '0 5px',
													borderRadius: '999px',
													background: isActive ? `${group.lane.color}24` : 'rgba(255,255,255,0.08)',
													fontSize: '10px',
													fontWeight: 700,
													display: 'inline-flex',
													alignItems: 'center',
													justifyContent: 'center',
													color: isActive ? group.lane.color : colors.textDim,
												}}
											>
												{count}
											</span>
										)}
									</button>
								);
							})}
						</div>
					)}
				</header>

				<div
					style={{
						flex: 1,
						minHeight: 0,
						overflowX: 'hidden',
						overflowY: 'auto',
						WebkitOverflowScrolling: 'touch',
						overscrollBehaviorY: 'contain',
						backfaceVisibility: 'hidden',
						transform: 'translateZ(0)',
						backgroundColor: colors.bgMain,
						padding: '14px 16px 32px',
						display: 'flex',
						flexDirection: 'column',
						gap: '12px',
					}}
				>
					{/* Home view: workspace list */}
					{scope.type === 'home' && (
						<>
							<div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '0 2px' }}>
								<FolderKanban size={14} color={colors.accent} />
								<div style={{ fontSize: '12px', fontWeight: 700, color: colors.textMain }}>
									Workspace Boards
								</div>
							</div>
							{workspaceSummaries.length === 0 ? (
								<div style={{ fontSize: '12px', color: colors.textDim, padding: '8px 2px' }}>
									No kanban tasks yet. Open a workspace board to add one.
								</div>
							) : (
								workspaceSummaries.map((summary) => (
									<button
										key={summary.group.id}
										type="button"
										onClick={() => onOpenWorkspace(summary.group.id)}
										style={{
											...scrollCardSurface,
											borderRadius: '16px',
											padding: '12px',
											display: 'flex',
											alignItems: 'center',
											gap: '10px',
											textAlign: 'left',
											cursor: 'pointer',
										}}
									>
										<span style={{ fontSize: '18px', flexShrink: 0 }}>
											{summary.group.emoji || '📂'}
										</span>
										<div style={{ minWidth: 0, flex: 1 }}>
											<div style={{ fontSize: '13px', fontWeight: 700, color: colors.textMain }}>
												{summary.group.name}
											</div>
											<div style={{ fontSize: '11px', color: colors.textDim, marginTop: '2px' }}>
												{summary.openCount} open · {summary.runningCount} running ·{' '}
												{summary.attentionCount} attention · {summary.doneCount} done
											</div>
										</div>
										<ArrowUpRight size={14} color={colors.textDim} style={{ flexShrink: 0 }} />
									</button>
								))
							)}
						</>
					)}

					{isLoading && (
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								gap: '8px',
								padding: '24px 0',
								color: colors.textDim,
								fontSize: '13px',
							}}
						>
							<Loader2 size={16} className="animate-spin" />
							Loading kanban…
						</div>
					)}

					{error && !isLoading && (
						<div
							style={{
								padding: '12px',
								borderRadius: '14px',
								color: colors.error,
								fontSize: '13px',
								background: `${colors.error}12`,
								border: `1px solid ${colors.error}24`,
							}}
						>
							{error}
						</div>
					)}

					{/* Workspace view: single active lane (board tab) */}
					{!isLoading &&
						scope.type === 'workspace' &&
						workspaceTab === 'board' &&
						(() => {
							const activeLane = laneGroups[activeLaneIndex];
							if (!activeLane) return null;
							const { lane, tasks: laneTasks, statusCounts } = activeLane;
							const subStatusChips = Object.entries(statusCounts)
								.map(([s, c]) => `${c} ${MOBILE_CONDUCTOR_STATUS_LABELS[s as ConductorTaskStatus]}`)
								.join(' · ');

							return (
								<>
									{/* Sub-status summary for multi-status lanes */}
									{lane.statuses.length > 1 && subStatusChips && (
										<div style={{ fontSize: '11px', color: colors.textDim, padding: '0 2px' }}>
											{subStatusChips}
										</div>
									)}

									{laneTasks.length === 0 ? (
										<div
											style={{
												padding: '32px 16px',
												textAlign: 'center',
												fontSize: '13px',
												color: colors.textDim,
												lineHeight: 1.5,
											}}
										>
											No tasks in {lane.label.toLowerCase()}.
										</div>
									) : (
										laneTasks.map((task) => {
											const meta = taskCardMetaById.get(task.id);
											const taskProgress = meta?.progress ?? {
												totalSubtasks: 0,
												completedSubtasks: 0,
												openSubtasks: 0,
												completionRatio: 0,
											};
											const rolledUpStatus = getConductorTaskRollupStatus(
												task,
												childTaskMap,
												runs,
												MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS
											);
											const statusTone =
												PASTEL_STATUS_TONES[rolledUpStatus] ?? PASTEL_STATUS_TONES.draft;
											const proofDisplayState = getCompletionProofDisplayState(
												task,
												rolledUpStatus
											);
											const attentionMessage =
												meta?.operatorAttentionMessage ?? meta?.firstFollowUpTitle ?? null;
											const needsAttention =
												meta?.visibleAttention?.attentionRequest.status === 'open' ||
												(rolledUpStatus === 'needs_revision' && Boolean(meta?.firstFollowUpTitle));
											const secondaryText = needsAttention
												? attentionMessage || 'Agents are handling review changes.'
												: taskProgress.totalSubtasks > 0
													? `${taskProgress.completedSubtasks}/${taskProgress.totalSubtasks} subtasks complete`
													: task.description || null;
											return (
												<div
													key={task.id}
													role="button"
													tabIndex={0}
													onClick={() => handleTaskOpen(task)}
													onKeyDown={(event) => {
														if (event.key === 'Enter' || event.key === ' ') {
															event.preventDefault();
															handleTaskOpen(task);
														}
													}}
													style={{
														...taskCardStyle,
														borderLeft: `3px solid ${statusTone.fg}`,
													}}
												>
													<div
														style={{
															display: 'flex',
															flexDirection: 'column',
															gap: '8px',
															minWidth: 0,
														}}
													>
														<div
															style={{
																display: 'grid',
																gridTemplateColumns: 'minmax(0, 1fr) auto',
																alignItems: 'start',
																columnGap: '10px',
															}}
														>
															<div
																style={{
																	fontSize: '13px',
																	fontWeight: 700,
																	color: colors.textMain,
																	minWidth: 0,
																	lineHeight: 1.35,
																	display: '-webkit-box',
																	WebkitLineClamp: 2,
																	WebkitBoxOrient: 'vertical',
																	overflow: 'hidden',
																	wordBreak: 'break-word',
																}}
															>
																{task.title}
															</div>
															<div
																style={{
																	padding: '4px 8px',
																	borderRadius: '999px',
																	background: 'rgba(255,255,255,0.08)',
																	fontSize: '11px',
																	fontWeight: 700,
																	color: colors.textDim,
																	flexShrink: 0,
																	marginTop: '1px',
																	alignSelf: 'start',
																}}
															>
																{MOBILE_CONDUCTOR_PRIORITY_LABELS[task.priority]}
															</div>
														</div>
														{secondaryText ? (
															<div
																style={{
																	fontSize: '11px',
																	color: needsAttention ? colors.warning : colors.textDim,
																	lineHeight: 1.4,
																	display: '-webkit-box',
																	WebkitLineClamp: 2,
																	WebkitBoxOrient: 'vertical',
																	overflow: 'hidden',
																	wordBreak: 'break-word',
																}}
															>
																{secondaryText}
															</div>
														) : null}
														{proofDisplayState ? (
															<div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
																<span
																	style={{
																		padding: '4px 8px',
																		borderRadius: '999px',
																		background: `${proofToneByKey[proofDisplayState.tone]}14`,
																		border: `1px solid ${proofToneByKey[proofDisplayState.tone]}28`,
																		fontSize: '10px',
																		fontWeight: 700,
																		color: proofToneByKey[proofDisplayState.tone],
																	}}
																>
																	{proofDisplayState.label}
																</span>
																{task.completionProof?.demoId && onOpenDemo ? (
																	<button
																		type="button"
																		onClick={(event) => {
																			event.stopPropagation();
																			onOpenDemo(task.completionProof!.demoId!);
																		}}
																		style={{
																			padding: '4px 8px',
																			borderRadius: '999px',
																			border: '1px solid rgba(255,255,255,0.10)',
																			background: 'rgba(255,255,255,0.04)',
																			fontSize: '10px',
																			fontWeight: 700,
																			color: colors.textMain,
																			display: 'inline-flex',
																			alignItems: 'center',
																			gap: '4px',
																		}}
																	>
																		<PlayCircle size={11} />
																		Review proof
																	</button>
																) : null}
															</div>
														) : null}
														<div
															style={{
																display: 'flex',
																flexWrap: 'wrap',
																gap: '6px',
																paddingTop: '2px',
															}}
														>
															{lane.statuses.length > 1 && (
																<span
																	style={{
																		padding: '4px 8px',
																		borderRadius: '999px',
																		background: statusTone.bg,
																		border: `1px solid ${statusTone.border}`,
																		fontSize: '11px',
																		fontWeight: 700,
																		color: statusTone.fg,
																	}}
																>
																	{MOBILE_CONDUCTOR_STATUS_LABELS[rolledUpStatus]}
																</span>
															)}
															<span
																style={{
																	padding: '4px 8px',
																	borderRadius: '999px',
																	background: 'rgba(255,255,255,0.08)',
																	fontSize: '11px',
																	fontWeight: 600,
																	color: colors.textDim,
																}}
															>
																{meta?.updatedLabel || formatRelativeTime(task.updatedAt)}
															</span>
														</div>
													</div>
												</div>
											);
										})
									)}
								</>
							);
						})()}

					{/* Workspace view: team tab */}
					{!isLoading && scope.type === 'workspace' && workspaceTab === 'team' && (
						<>
							<MobileTeamPanel
								colors={colors}
								members={conductorTeamMembers}
								onOpenMember={(member) => {
									if (member.sessionId && onOpenAgentSession) {
										onOpenAgentSession(member.sessionId);
									}
								}}
								onOpenTask={(taskId) => {
									setSelectedTaskId(taskId);
									setWorkspaceTab('board');
								}}
								onAskMember={(member) => {
									openOrchestratorChat({ scope: 'member', memberName: member.name });
								}}
							/>
						</>
					)}

					{/* Workspace view: updates tab */}
					{!isLoading && scope.type === 'workspace' && workspaceTab === 'updates' && (
						<>
							<MobileUpdatesPanel
								colors={colors}
								updates={orchestratorUpdates}
								onOpenTask={(taskId) => {
									setSelectedTaskId(taskId);
									setWorkspaceTab('board');
								}}
								onAskUpdate={(update) => {
									openOrchestratorChat({ scope: 'update', updateId: update.id });
								}}
							/>
						</>
					)}

					{/* Home view: flat task list across all workspaces */}
					{!isLoading && scope.type === 'home' && !visibleTasks.length && !error && (
						<div style={{ padding: '16px 2px', fontSize: '13px', color: colors.textDim }}>
							No conductor tasks yet. Open a workspace board to add your first card.
						</div>
					)}
				</div>

				{(isCreatingTask || selectedTask) && (
					<div
						role="button"
						tabIndex={-1}
						onClick={handleCloseEditor}
						onKeyDown={(e) => {
							if (e.key === 'Escape') handleCloseEditor();
						}}
						style={{
							position: 'fixed',
							inset: 0,
							zIndex: 160,
							background: 'rgba(2, 8, 23, 0.45)',
							display: 'flex',
							alignItems: 'flex-end',
							justifyContent: 'center',
						}}
					>
						<div
							onClick={(e) => e.stopPropagation()}
							style={{
								width: 'min(100vw, 520px)',
								maxHeight: '85vh',
								overflowY: 'auto',
								WebkitOverflowScrolling: 'touch',
								padding: '16px 16px calc(16px + env(safe-area-inset-bottom))',
								borderTopLeftRadius: '26px',
								borderTopRightRadius: '26px',
								background: `linear-gradient(180deg, ${colors.bgSidebar} 0%, ${colors.bgMain} 100%)`,
								borderTop: '1px solid rgba(255,255,255,0.08)',
								display: 'flex',
								flexDirection: 'column',
								gap: '10px',
							}}
						>
							{/* ── Header row: close + title + status pill ── */}
							<div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
								<button
									type="button"
									onClick={handleCloseEditor}
									style={{
										...buttonStyle,
										width: '34px',
										height: '34px',
										padding: 0,
										flexShrink: 0,
									}}
								>
									<X size={14} />
								</button>
								<div style={{ minWidth: 0, flex: 1 }}>
									{isCreatingTask ? (
										<div
											style={{
												fontSize: '10px',
												fontWeight: 700,
												color: colors.textDim,
												textTransform: 'uppercase',
												letterSpacing: '0.06em',
											}}
										>
											New Task
										</div>
									) : null}
									<div
										style={{
											fontSize: '14px',
											fontWeight: 700,
											color: colors.textMain,
											lineHeight: 1.3,
											display: '-webkit-box',
											WebkitLineClamp: 2,
											WebkitBoxOrient: 'vertical',
											overflow: 'hidden',
											wordBreak: 'break-word',
										}}
									>
										{isCreatingTask
											? activeGroup?.name || 'Workspace'
											: selectedTask?.title || 'Task'}
									</div>
								</div>
								{selectedTask && selectedTaskRolledUpStatus && (
									<span
										style={{
											padding: '4px 10px',
											borderRadius: '999px',
											fontSize: '11px',
											fontWeight: 700,
											flexShrink: 0,
											background: (
												PASTEL_STATUS_TONES[selectedTaskRolledUpStatus] ?? PASTEL_STATUS_TONES.draft
											).bg,
											border: `1px solid ${(PASTEL_STATUS_TONES[selectedTaskRolledUpStatus] ?? PASTEL_STATUS_TONES.draft).border}`,
											color: (
												PASTEL_STATUS_TONES[selectedTaskRolledUpStatus] ?? PASTEL_STATUS_TONES.draft
											).fg,
										}}
									>
										{MOBILE_CONDUCTOR_STATUS_LABELS[selectedTaskRolledUpStatus]}
									</span>
								)}
							</div>

							{/* ── Create task form ── */}
							{isCreatingTask && (
								<>
									<input
										type="text"
										value={editorDraft.title}
										onChange={(event) =>
											setEditorDraft((previous) => ({ ...previous, title: event.target.value }))
										}
										placeholder="Task title"
										style={{
											...mutedSurface,
											borderRadius: '12px',
											padding: '10px 12px',
											fontSize: '13px',
											color: colors.textMain,
											outline: 'none',
										}}
									/>
									<textarea
										value={editorDraft.description}
										onChange={(event) =>
											setEditorDraft((previous) => ({
												...previous,
												description: event.target.value,
											}))
										}
										placeholder="What needs doing?"
										rows={3}
										style={{
											...mutedSurface,
											borderRadius: '12px',
											padding: '10px 12px',
											fontSize: '12px',
											color: colors.textMain,
											outline: 'none',
											resize: 'vertical',
											fontFamily: 'inherit',
											lineHeight: 1.5,
										}}
									/>
									<div
										style={{
											display: 'grid',
											gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
											gap: '8px',
										}}
									>
										<select
											value={editorDraft.status}
											onChange={(event) =>
												setEditorDraft((previous) => ({
													...previous,
													status: event.target.value as ConductorTaskStatus,
												}))
											}
											style={{
												...mutedSurface,
												borderRadius: '12px',
												padding: '10px 12px',
												fontSize: '12px',
												color: colors.textMain,
												outline: 'none',
											}}
										>
											{MOBILE_CONDUCTOR_COLUMNS.map((status) => (
												<option key={status} value={status}>
													{MOBILE_CONDUCTOR_STATUS_LABELS[status]}
												</option>
											))}
										</select>
										<select
											value={editorDraft.priority}
											onChange={(event) =>
												setEditorDraft((previous) => ({
													...previous,
													priority: event.target.value as ConductorTaskPriority,
												}))
											}
											style={{
												...mutedSurface,
												borderRadius: '12px',
												padding: '10px 12px',
												fontSize: '12px',
												color: colors.textMain,
												outline: 'none',
											}}
										>
											{(['low', 'medium', 'high', 'critical'] as ConductorTaskPriority[]).map(
												(priority) => (
													<option key={priority} value={priority}>
														{MOBILE_CONDUCTOR_PRIORITY_LABELS[priority]}
													</option>
												)
											)}
										</select>
									</div>
								</>
							)}

							{/* ── Existing task: read-only summary first ── */}
							{selectedTask && !isCreatingTask ? (
								<>
									{/* Inline meta row: priority + updated */}
									<div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
										<span
											style={{
												padding: '3px 8px',
												borderRadius: '999px',
												background: 'rgba(255,255,255,0.08)',
												fontSize: '11px',
												fontWeight: 600,
												color: colors.textDim,
											}}
										>
											{MOBILE_CONDUCTOR_PRIORITY_LABELS[selectedTask.priority]}
										</span>
										<span
											style={{
												padding: '3px 8px',
												borderRadius: '999px',
												background: 'rgba(255,255,255,0.08)',
												fontSize: '11px',
												fontWeight: 600,
												color: colors.textDim,
											}}
										>
											{formatRelativeTime(selectedTask.updatedAt)}
										</span>
									</div>

									{/* Description (read-only) */}
									{selectedTask.description ? (
										<div
											style={{
												fontSize: '12px',
												color: colors.textMain,
												lineHeight: 1.5,
												padding: '0 2px',
												display: '-webkit-box',
												WebkitLineClamp: 4,
												WebkitBoxOrient: 'vertical',
												overflow: 'hidden',
												wordBreak: 'break-word',
											}}
										>
											{selectedTask.description}
										</div>
									) : null}

									{/* Progress bar */}
									{selectedTaskProgress.totalSubtasks > 0 ? (
										<div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
											<div
												style={{
													height: '5px',
													borderRadius: '999px',
													background: 'rgba(255,255,255,0.08)',
													overflow: 'hidden',
												}}
											>
												<div
													style={{
														width: `${Math.round(selectedTaskProgress.completionRatio * 100)}%`,
														height: '100%',
														background: colors.accent,
														borderRadius: '999px',
													}}
												/>
											</div>
											<div style={{ fontSize: '11px', color: colors.textDim }}>
												{selectedTaskProgress.completedSubtasks}/
												{selectedTaskProgress.totalSubtasks} subtasks done
												{selectedTaskProgress.openSubtasks > 0
													? ` \u00b7 ${selectedTaskProgress.openSubtasks} open`
													: ''}
											</div>
										</div>
									) : null}

									{selectedTaskProofDisplayState ? (
										<div
											style={{
												padding: '12px',
												borderRadius: '16px',
												background: `${proofToneByKey[selectedTaskProofDisplayState.tone]}10`,
												border: `1px solid ${proofToneByKey[selectedTaskProofDisplayState.tone]}22`,
												display: 'flex',
												flexDirection: 'column',
												gap: '10px',
											}}
										>
											<div
												style={{
													display: 'flex',
													alignItems: 'flex-start',
													justifyContent: 'space-between',
													gap: '10px',
												}}
											>
												<div style={{ minWidth: 0 }}>
													<div
														style={{
															fontSize: '11px',
															fontWeight: 700,
															color: colors.textDim,
															textTransform: 'uppercase',
															letterSpacing: '0.06em',
														}}
													>
														Completion Proof
													</div>
													<div
														style={{
															fontSize: '12px',
															fontWeight: 700,
															color: colors.textMain,
															marginTop: '4px',
														}}
													>
														{selectedTaskProofDisplayState.summary}
													</div>
												</div>
												<span
													style={{
														padding: '4px 8px',
														borderRadius: '999px',
														background: `${proofToneByKey[selectedTaskProofDisplayState.tone]}14`,
														border: `1px solid ${proofToneByKey[selectedTaskProofDisplayState.tone]}28`,
														fontSize: '10px',
														fontWeight: 700,
														color: proofToneByKey[selectedTaskProofDisplayState.tone],
														whiteSpace: 'nowrap',
														flexShrink: 0,
													}}
												>
													{selectedTaskProofDisplayState.label}
												</span>
											</div>
											<div style={{ fontSize: '12px', color: colors.textDim, lineHeight: 1.45 }}>
												{getCompletionProofRequirementSummary(selectedTask)}
												{selectedTask.completionProof?.capturedAt
													? ` Captured ${formatRelativeTime(selectedTask.completionProof.capturedAt)}.`
													: ''}
												{selectedTask.completionProof?.approvedAt
													? ` Approved ${formatRelativeTime(selectedTask.completionProof.approvedAt)}.`
													: ''}
											</div>
											{selectedTaskProofDemo ? (
												<button
													type="button"
													onClick={() => onOpenDemo?.(selectedTaskProofDemo.demoId)}
													style={{
														padding: '12px',
														borderRadius: '18px',
														border: `1px solid ${colors.border}`,
														background: `${colors.bgMain}cc`,
														display: 'flex',
														flexDirection: 'column',
														gap: '10px',
														textAlign: 'left',
													}}
												>
													{selectedTaskProofPosterUrl ? (
														<img
															src={selectedTaskProofPosterUrl}
															alt={selectedTaskProofDemo.title}
															style={{
																width: '100%',
																borderRadius: '14px',
																border: `1px solid ${colors.border}`,
																display: 'block',
															}}
														/>
													) : null}
													<div
														style={{ fontSize: '15px', fontWeight: 700, color: colors.textMain }}
													>
														{selectedTaskProofDemo.title}
													</div>
													{selectedTaskProofDemo.summary ? (
														<div style={{ fontSize: '13px', color: colors.textDim }}>
															{selectedTaskProofDemo.summary}
														</div>
													) : null}
													<div
														style={{
															display: 'flex',
															flexWrap: 'wrap',
															gap: '8px',
															fontSize: '12px',
															color: colors.textDim,
														}}
													>
														<span>{selectedTaskProofDemo.stepCount} steps</span>
														{selectedTaskProofDemo.durationMs ? (
															<span>{Math.round(selectedTaskProofDemo.durationMs / 1000)}s</span>
														) : null}
														<span>{selectedTaskProofDemo.status}</span>
														<span>
															{COMPLETION_PROOF_STATUS_LABELS[selectedTaskProofDisplayState.status]}
														</span>
													</div>
												</button>
											) : selectedTask.completionProof?.demoId ? (
												<div
													style={{
														padding: '12px',
														borderRadius: '14px',
														background: 'rgba(255,255,255,0.05)',
														border: '1px solid rgba(255,255,255,0.08)',
														fontSize: '12px',
														color: colors.textDim,
														display: 'flex',
														alignItems: 'center',
														gap: '8px',
													}}
												>
													<Loader2 size={14} className="animate-spin" />
													Loading proof preview…
												</div>
											) : null}
											<div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
												{selectedTask.completionProof?.demoId && onOpenDemo ? (
													<button
														type="button"
														onClick={() => onOpenDemo(selectedTask.completionProof!.demoId!)}
														style={{
															...buttonStyle,
															background: 'rgba(255,255,255,0.06)',
															border: '1px solid rgba(255,255,255,0.10)',
															color: colors.textMain,
														}}
													>
														<PlayCircle size={14} />
														Review proof
													</button>
												) : null}
												{selectedTaskProofDisplayState.status === 'captured' ? (
													<button
														type="button"
														onClick={() => void handleApproveCompletionProof()}
														disabled={isSaving}
														style={{
															...buttonStyle,
															background: `${colors.success}16`,
															border: `1px solid ${colors.success}2c`,
															color: colors.success,
														}}
													>
														{isSaving ? (
															<Loader2 size={14} className="animate-spin" />
														) : (
															<CheckCircle2 size={14} />
														)}
														Approve proof
													</button>
												) : null}
											</div>
										</div>
									) : null}

									{selectedTaskQaFailureState?.isQuarantined ? (
										<div
											style={{
												padding: '12px',
												borderRadius: '16px',
												background: `${colors.warning}12`,
												border: `1px solid ${colors.warning}24`,
												display: 'flex',
												flexDirection: 'column',
												gap: '8px',
											}}
										>
											<div style={{ fontSize: '12px', fontWeight: 700, color: colors.warning }}>
												QA paused for this task
											</div>
											<div style={{ fontSize: '12px', color: colors.textMain, lineHeight: 1.45 }}>
												Conductor stopped auto-retrying QA after{' '}
												{selectedTaskQaFailureState.malformedFailureCount} malformed reviewer
												response{selectedTaskQaFailureState.malformedFailureCount === 1 ? '' : 's'}{' '}
												so other ready work can continue.
											</div>
											{selectedTaskQaFailureState.lastFailureEvent?.message ? (
												<div style={{ fontSize: '12px', color: colors.textDim, lineHeight: 1.45 }}>
													{selectedTaskQaFailureState.lastFailureEvent.message}
												</div>
											) : null}
										</div>
									) : null}

									{(selectedTaskEffectiveAttention?.status === 'open' ||
										(selectedTaskOpenFollowUps.length > 0 &&
											(selectedTask?.status === 'needs_revision' ||
												isConductorTaskAgentRevision(
													selectedTask,
													childTaskMap,
													runs,
													MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS
												)))) &&
									!(selectedTaskProofDisplayState && selectedTask?.status === 'needs_proof') ? (
										<div
											style={{
												padding: '12px',
												borderRadius: '16px',
												background: `${colors.warning}12`,
												border: `1px solid ${colors.warning}24`,
												display: 'flex',
												flexDirection: 'column',
												gap: '8px',
											}}
										>
											<div style={{ fontSize: '12px', fontWeight: 700, color: colors.warning }}>
												{selectedTask?.status === 'needs_proof'
													? 'Proof required'
													: selectedTaskNeedsOperatorAttention
														? 'Waiting on you'
														: 'Agents revising'}
											</div>
											<div style={{ fontSize: '12px', color: colors.textMain, lineHeight: 1.45 }}>
												{selectedTaskNeedsOperatorAttention
													? selectedTaskEffectiveAttention?.summary
													: selectedTaskEffectiveAttention?.summary ||
														'Reviewer feedback has already been turned into agent follow-up work.'}
											</div>
											{selectedTaskAttentionTarget &&
											selectedTaskAttentionTarget.id !== selectedTask.id ? (
												<div style={{ fontSize: '11px', color: colors.textDim, lineHeight: 1.45 }}>
													From subtask: {selectedTaskAttentionTarget.title}
												</div>
											) : null}
											{selectedTaskEffectiveAttention?.requestedAction ? (
												<div style={{ fontSize: '12px', color: colors.textDim, lineHeight: 1.45 }}>
													{formatConductorOperatorMessage(
														selectedTaskEffectiveAttention.requestedAction
													)}
												</div>
											) : null}
											{selectedTaskNeedsOperatorAttention &&
											selectedTaskEffectiveAttention?.suggestedResponse ? (
												<div style={{ fontSize: '11px', color: colors.textDim, lineHeight: 1.45 }}>
													Suggested: {selectedTaskEffectiveAttention.suggestedResponse}
												</div>
											) : null}
											{selectedTaskOpenFollowUps.length > 0 ? (
												<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
													<div
														style={{
															fontSize: '11px',
															fontWeight: 700,
															color: colors.textDim,
															textTransform: 'uppercase',
															letterSpacing: '0.06em',
														}}
													>
														Requested Changes
													</div>
													{selectedTaskOpenFollowUps.map((followUpTask) => (
														<button
															key={followUpTask.id}
															type="button"
															onClick={() => handleTaskOpen(followUpTask)}
															style={{
																...mutedSurface,
																borderRadius: '14px',
																padding: '12px',
																textAlign: 'left',
																display: 'flex',
																flexDirection: 'column',
																gap: '6px',
															}}
														>
															<div
																style={{
																	fontSize: '12px',
																	fontWeight: 700,
																	color: colors.textMain,
																}}
															>
																{followUpTask.title}
															</div>
															{followUpTask.description ? (
																<div
																	style={{
																		fontSize: '11px',
																		color: colors.textDim,
																		lineHeight: 1.45,
																	}}
																>
																	{followUpTask.description}
																</div>
															) : null}
														</button>
													))}
												</div>
											) : null}
											{selectedTaskNeedsOperatorAttention &&
											selectedTask?.status !== 'needs_proof' ? (
												<>
													<textarea
														value={
															selectedTaskAttentionTarget
																? responseDrafts[selectedTaskAttentionTarget.id] || ''
																: ''
														}
														onChange={(event) =>
															setResponseDrafts((previous) => ({
																...previous,
																[(selectedTaskAttentionTarget || selectedTask).id]:
																	event.target.value,
															}))
														}
														placeholder="Write the clarification or answer the next agent run should use."
														rows={3}
														style={{
															...mutedSurface,
															borderRadius: '14px',
															padding: '12px',
															fontSize: '12px',
															color: colors.textMain,
															outline: 'none',
															resize: 'vertical',
															fontFamily: 'inherit',
															lineHeight: 1.5,
														}}
													/>
													<button
														type="button"
														onClick={() => void handleResolveAttention()}
														disabled={isSaving}
														style={{
															...buttonStyle,
															width: '100%',
															background: `${colors.accent}22`,
															border: `1px solid ${colors.accent}34`,
															color: colors.accent,
														}}
													>
														Return To Ready
													</button>
												</>
											) : null}
										</div>
									) : null}

									{!selectedTaskEffectiveAttention && selectedTaskAttentionBlockers.length > 0 ? (
										<div
											style={{
												padding: '12px',
												borderRadius: '16px',
												background: `${colors.warning}10`,
												border: `1px solid ${colors.warning}22`,
												display: 'flex',
												flexDirection: 'column',
												gap: '10px',
											}}
										>
											<div style={{ fontSize: '12px', fontWeight: 700, color: colors.warning }}>
												Nested tasks waiting
											</div>
											<div style={{ fontSize: '12px', color: colors.textMain, lineHeight: 1.45 }}>
												This parent task is paused because subtasks were sent back with requested
												changes.
											</div>
											{selectedTaskAttentionBlockers.map(
												({ task: blockerTask, attentionRequest, followUpTasks }) => (
													<div
														key={blockerTask.id}
														style={{
															...mutedSurface,
															borderRadius: '14px',
															padding: '12px',
															display: 'flex',
															flexDirection: 'column',
															gap: '8px',
														}}
													>
														<button
															type="button"
															onClick={() => handleTaskOpen(blockerTask)}
															style={{
																padding: 0,
																background: 'transparent',
																border: 0,
																textAlign: 'left',
																display: 'flex',
																justifyContent: 'space-between',
																gap: '10px',
																alignItems: 'flex-start',
																color: colors.textMain,
															}}
														>
															<span style={{ fontSize: '12px', fontWeight: 700 }}>
																{blockerTask.title}
															</span>
															<span
																style={{ fontSize: '11px', color: colors.warning, flexShrink: 0 }}
															>
																{MOBILE_CONDUCTOR_STATUS_LABELS[blockerTask.status]}
															</span>
														</button>
														<div
															style={{ fontSize: '11px', color: colors.textDim, lineHeight: 1.45 }}
														>
															{formatConductorOperatorMessage(attentionRequest?.requestedAction) ||
																'This subtask is waiting for follow-up changes before it can continue.'}
														</div>
														{followUpTasks.length > 0 ? (
															<div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
																<div
																	style={{
																		fontSize: '11px',
																		fontWeight: 700,
																		color: colors.textDim,
																		textTransform: 'uppercase',
																		letterSpacing: '0.06em',
																	}}
																>
																	Requested Changes
																</div>
																{followUpTasks.slice(0, 3).map((followUpTask) => (
																	<button
																		key={followUpTask.id}
																		type="button"
																		onClick={() => handleTaskOpen(followUpTask)}
																		style={{
																			...mutedSurface,
																			borderRadius: '12px',
																			padding: '10px',
																			textAlign: 'left',
																			display: 'flex',
																			flexDirection: 'column',
																			gap: '4px',
																		}}
																	>
																		<div
																			style={{
																				fontSize: '12px',
																				fontWeight: 700,
																				color: colors.textMain,
																			}}
																		>
																			{followUpTask.title}
																		</div>
																		{followUpTask.description ? (
																			<div
																				style={{
																					fontSize: '11px',
																					color: colors.textDim,
																					lineHeight: 1.45,
																				}}
																			>
																				{followUpTask.description}
																			</div>
																		) : null}
																	</button>
																))}
																{followUpTasks.length > 3 ? (
																	<div style={{ fontSize: '11px', color: colors.textDim }}>
																		+{followUpTasks.length - 3} more requested change
																		{followUpTasks.length - 3 === 1 ? '' : 's'}
																	</div>
																) : null}
															</div>
														) : null}
													</div>
												)
											)}
										</div>
									) : null}

									{getTaskAgentLinks(selectedTask).length > 0 ? (
										<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
											<div
												style={{
													fontSize: '11px',
													fontWeight: 700,
													color: colors.textDim,
													textTransform: 'uppercase',
													letterSpacing: '0.06em',
												}}
											>
												Agents
											</div>
											<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
												{getTaskAgentLinks(selectedTask).map((entry) => {
													const roleTones: Record<
														string,
														{ bg: string; border: string; fg: string }
													> = {
														planner: { bg: '#60a5fa1a', border: '#60a5fa3d', fg: '#60a5fa' },
														worker: { bg: '#a78bfa1a', border: '#a78bfa3d', fg: '#a78bfa' },
														reviewer: { bg: '#22d3ee1a', border: '#22d3ee3d', fg: '#22d3ee' },
													};
													const tone = roleTones[entry.role] ?? roleTones.worker;
													const liveSession = sessions.find((s) => s.id === entry.sessionId);
													const providerToolType = (
														liveSession?.toolType === 'terminal'
															? 'claude-code'
															: liveSession?.toolType || 'claude-code'
													) as ConductorProviderAgent;
													const identity = resolveConductorRosterIdentity(
														providerToolType,
														entry.sessionName || entry.sessionId || ''
													);
													return (
														<button
															key={`${entry.role}-${entry.sessionId}`}
															type="button"
															onClick={() =>
																entry.sessionId && onOpenAgentSession?.(entry.sessionId)
															}
															disabled={!entry.sessionId || !onOpenAgentSession}
															style={{
																...buttonStyle,
																height: 'auto',
																padding: '8px 12px',
																fontSize: '12px',
																display: 'flex',
																alignItems: 'center',
																gap: '8px',
															}}
														>
															<span
																style={{
																	padding: '2px 8px',
																	borderRadius: '999px',
																	fontSize: '10px',
																	fontWeight: 700,
																	textTransform: 'uppercase',
																	letterSpacing: '0.04em',
																	background: tone.bg,
																	border: `1px solid ${tone.border}`,
																	color: tone.fg,
																	whiteSpace: 'nowrap',
																	flexShrink: 0,
																}}
															>
																{entry.role}
															</span>
															<span style={{ fontSize: '14px', flexShrink: 0 }}>
																{identity.emoji}
															</span>
															<span
																style={{
																	fontWeight: 600,
																	color: colors.textMain,
																	fontSize: '12px',
																	overflow: 'hidden',
																	textOverflow: 'ellipsis',
																	whiteSpace: 'nowrap',
																}}
															>
																{identity.name}
															</span>
															<ArrowUpRight
																size={13}
																style={{ marginLeft: 'auto', flexShrink: 0, opacity: 0.5 }}
															/>
														</button>
													);
												})}
											</div>
										</div>
									) : null}

									{selectedTaskChildren.length > 0 ? (
										<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
											<div
												style={{
													fontSize: '11px',
													fontWeight: 700,
													color: colors.textDim,
													textTransform: 'uppercase',
													letterSpacing: '0.06em',
												}}
											>
												Nested Tasks
											</div>
											<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
												{selectedTaskChildren.map((childTask) => (
													<button
														key={childTask.id}
														type="button"
														onClick={() => handleTaskOpen(childTask)}
														style={{
															...mutedSurface,
															borderRadius: '14px',
															padding: '12px',
															display: 'flex',
															alignItems: 'center',
															justifyContent: 'space-between',
															gap: '10px',
															textAlign: 'left',
														}}
													>
														<div style={{ minWidth: 0, flex: 1 }}>
															<div
																style={{
																	fontSize: '12px',
																	fontWeight: 700,
																	color: colors.textMain,
																}}
															>
																{childTask.title}
															</div>
														</div>
														{(() => {
															const childRolledUp = getConductorTaskRollupStatus(
																childTask,
																childTaskMap,
																runs,
																MOBILE_LIVE_CONDUCTOR_STATE_OPTIONS
															);
															const childTone =
																PASTEL_STATUS_TONES[childRolledUp] ?? PASTEL_STATUS_TONES.draft;
															return (
																<span
																	style={{
																		padding: '3px 8px',
																		borderRadius: '999px',
																		fontSize: '10px',
																		fontWeight: 700,
																		flexShrink: 0,
																		background: childTone.bg,
																		border: `1px solid ${childTone.border}`,
																		color: childTone.fg,
																		whiteSpace: 'nowrap',
																	}}
																>
																	{MOBILE_CONDUCTOR_STATUS_LABELS[childRolledUp]}
																</span>
															);
														})()}
														<ArrowUpRight
															size={14}
															color={colors.textDim}
															style={{ flexShrink: 0 }}
														/>
													</button>
												))}
											</div>
										</div>
									) : null}

									{/* ── Edit form (collapsed by default) ── */}
									{isEditingTask && (
										<div
											style={{
												display: 'flex',
												flexDirection: 'column',
												gap: '8px',
												padding: '10px',
												borderRadius: '14px',
												...mutedSurface,
											}}
										>
											<div
												style={{
													fontSize: '11px',
													fontWeight: 700,
													color: colors.textDim,
													textTransform: 'uppercase',
													letterSpacing: '0.06em',
												}}
											>
												Edit Task
											</div>
											<input
												type="text"
												value={editorDraft.title}
												onChange={(event) =>
													setEditorDraft((previous) => ({ ...previous, title: event.target.value }))
												}
												placeholder="Task title"
												style={{
													...mutedSurface,
													borderRadius: '10px',
													padding: '8px 10px',
													fontSize: '12px',
													color: colors.textMain,
													outline: 'none',
												}}
											/>
											<textarea
												value={editorDraft.description}
												onChange={(event) =>
													setEditorDraft((previous) => ({
														...previous,
														description: event.target.value,
													}))
												}
												placeholder="Description"
												rows={3}
												style={{
													...mutedSurface,
													borderRadius: '10px',
													padding: '8px 10px',
													fontSize: '12px',
													color: colors.textMain,
													outline: 'none',
													resize: 'vertical',
													fontFamily: 'inherit',
													lineHeight: 1.5,
												}}
											/>
											<div
												style={{
													display: 'grid',
													gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
													gap: '6px',
												}}
											>
												<select
													value={editorDraft.status}
													onChange={(event) =>
														setEditorDraft((previous) => ({
															...previous,
															status: event.target.value as ConductorTaskStatus,
														}))
													}
													style={{
														...mutedSurface,
														borderRadius: '10px',
														padding: '8px 10px',
														fontSize: '12px',
														color: colors.textMain,
														outline: 'none',
													}}
												>
													{MOBILE_CONDUCTOR_COLUMNS.map((status) => (
														<option key={status} value={status}>
															{MOBILE_CONDUCTOR_STATUS_LABELS[status]}
														</option>
													))}
												</select>
												<select
													value={editorDraft.priority}
													onChange={(event) =>
														setEditorDraft((previous) => ({
															...previous,
															priority: event.target.value as ConductorTaskPriority,
														}))
													}
													style={{
														...mutedSurface,
														borderRadius: '10px',
														padding: '8px 10px',
														fontSize: '12px',
														color: colors.textMain,
														outline: 'none',
													}}
												>
													{(['low', 'medium', 'high', 'critical'] as ConductorTaskPriority[]).map(
														(priority) => (
															<option key={priority} value={priority}>
																{MOBILE_CONDUCTOR_PRIORITY_LABELS[priority]}
															</option>
														)
													)}
												</select>
											</div>
											<div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
												<button
													type="button"
													onClick={() => setIsEditingTask(false)}
													style={{
														...buttonStyle,
														background: 'rgba(255,255,255,0.06)',
														border: '1px solid rgba(255,255,255,0.08)',
														color: colors.textDim,
													}}
												>
													Cancel
												</button>
												<button
													type="button"
													onClick={() => {
														void handleSave();
														setIsEditingTask(false);
													}}
													disabled={!editorDraft.title.trim() || isSaving}
													style={{
														...buttonStyle,
														background: `${colors.accent}22`,
														border: `1px solid ${colors.accent}34`,
														color: colors.accent,
														opacity: !editorDraft.title.trim() || isSaving ? 0.65 : 1,
													}}
												>
													{isSaving ? <Loader2 size={16} className="animate-spin" /> : null}
													Save
												</button>
											</div>
										</div>
									)}

									{/* ── Action bar for existing task ── */}
									{!isEditingTask && (
										<div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
											<button
												type="button"
												onClick={() => setIsEditingTask(true)}
												style={{
													...buttonStyle,
													background: 'rgba(255,255,255,0.06)',
													border: '1px solid rgba(255,255,255,0.08)',
													color: colors.textMain,
												}}
											>
												Edit
											</button>
											<button
												type="button"
												onClick={() => void handleDelete()}
												disabled={isSaving}
												style={{
													...buttonStyle,
													background: `${colors.error}18`,
													border: `1px solid ${colors.error}28`,
													color: colors.error,
												}}
											>
												<Trash2 size={14} />
												Delete
											</button>
										</div>
									)}
								</>
							) : null}

							{/* ── Create task: action buttons ── */}
							{isCreatingTask && (
								<div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
									<button
										type="button"
										onClick={() => void handleSave()}
										disabled={!editorDraft.title.trim() || isSaving}
										style={{
											...buttonStyle,
											background: `${colors.accent}22`,
											border: `1px solid ${colors.accent}34`,
											color: colors.accent,
											opacity: !editorDraft.title.trim() || isSaving ? 0.65 : 1,
										}}
									>
										{isSaving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
										Create Task
									</button>
								</div>
							)}
						</div>
					</div>
				)}
			</div>

			{/* Orchestrator chat overlay */}
			{scope?.type === 'workspace' && activeGroup && (
				<MobileOrchestratorChat
					colors={colors}
					groupName={activeGroup.name}
					isOpen={orchestratorContext !== null}
					context={orchestratorContext}
					conductor={currentConductor}
					tasksById={tasksById}
					childTasksByParentId={childTaskMap}
					runs={runs}
					updates={orchestratorUpdates}
					teamMembers={conductorTeamMembers}
					onOpenTask={(taskId) => {
						setSelectedTaskId(taskId);
						setOrchestratorContext(null);
						setWorkspaceTab('board');
					}}
					onApplyAction={handleApplyOrchestratorAction}
					onClose={() => setOrchestratorContext(null)}
				/>
			)}
		</div>
	);
}

export default MobileKanbanPanel;
