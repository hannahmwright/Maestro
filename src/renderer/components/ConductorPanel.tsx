import { useEffect, useMemo, useRef, useState } from 'react';
import {
	Activity,
	ArrowUpDown,
	CheckCircle2,
	ClipboardList,
	Copy,
	ExternalLink,
	FolderKanban,
	FolderOpen,
	GitBranch,
	LayoutGrid,
	ListFilter,
	History,
	Loader2,
	PlayCircle,
	Rows3,
	Search,
	Settings2,
	ShieldAlert,
	Square,
	Sparkles,
	Trash2,
	Users,
} from 'lucide-react';
import type {
	Theme,
	ConductorRun,
	ConductorTask,
	ConductorAgentRole,
	ConductorProviderAgent,
	ConductorProviderChoice,
	ConductorProviderRouteKey,
	ConductorTaskStatus,
	ConductorTaskPriority,
	ConductorRunEvent,
	LogEntry,
} from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useSessionStore } from '../stores/sessionStore';
import { useConductorStore } from '../stores/conductorStore';
import { generateId } from '../utils/ids';
import { notifyToast } from '../stores/notificationStore';
import { safeClipboardWrite } from '../utils/clipboard';
import {
	buildConductorPlannerPrompt,
	parseConductorPlannerResponse,
} from '../services/conductorPlanner';
import {
	buildConductorReviewerPrompt,
	parseConductorReviewerResponse,
} from '../services/conductorReviewer';
import { runConductorAgentTurn } from '../services/conductorAgentRuntime';
import {
	buildConductorWorkerPrompt,
	parseConductorWorkerResponse,
} from '../services/conductorWorker';
import {
	buildConductorIntegrationTarget,
	buildConductorWorktreeTarget,
	evaluateConductorResourceGate,
	tasksConflict,
} from '../services/conductorRuntime';
import { getRuntimeIdForThread, getSessionLastActivity } from '../utils/workspaceThreads';
import { getProviderDisplayName } from '../utils/sessionValidation';
import { Modal } from './ui/Modal';
import { ToolActivityBlock } from './ToolActivityBlock';

interface ConductorPanelProps {
	theme: Theme;
	groupId: string;
}

type ConductorTab = 'overview' | 'history';
type BacklogView = 'board' | 'table';
type BacklogStatusFilter = 'all' | ConductorTaskStatus;
type BacklogSourceFilter = 'all' | ConductorTask['source'];
type BacklogSort = 'priority' | 'updated_desc' | 'updated_asc' | 'title';

interface ResourceSnapshot {
	cpuCount: number;
	loadAverage: [number, number, number];
	freeMemoryMB: number;
	availableMemoryMB: number;
	totalMemoryMB: number;
	platform: string;
}

const STATUS_OPTIONS: ConductorTaskStatus[] = [
	'draft',
	'planning',
	'ready',
	'running',
	'needs_input',
	'blocked',
	'needs_review',
	'cancelled',
	'done',
];

const PRIORITY_OPTIONS: ConductorTaskPriority[] = ['low', 'medium', 'high', 'critical'];
const CONDUCTOR_PROVIDER_OPTIONS: ConductorProviderAgent[] = [
	'claude-code',
	'codex',
	'opencode',
	'factory-droid',
];
const CONDUCTOR_PROVIDER_PRIMARY_OPTIONS: ConductorProviderChoice[] = [
	'workspace-lead',
	...CONDUCTOR_PROVIDER_OPTIONS,
];
const BOARD_COLUMNS: ConductorTaskStatus[] = [
	'draft',
	'planning',
	'ready',
	'running',
	'needs_input',
	'blocked',
	'needs_review',
	'cancelled',
	'done',
];

const SETTINGS_GUIDE_STEPS = [
	{
		key: 'lead',
		title: 'Use the workspace lead',
		description:
			'Conductor automatically follows this workspace’s primary agent and copies its setup whenever it spins up helpers.',
		icon: Users,
		accent: 'success',
	},
	{
		key: 'plan',
		title: 'Drop in a request',
		description:
			'Use + New plan to describe what you want changed. Conductor turns that into task-sized steps.',
		icon: ClipboardList,
		accent: 'accent',
	},
	{
		key: 'approve',
		title: 'Review or auto-run',
		description:
			'Keep approvals on if you want to review the task list first, or turn on auto-execute to keep things moving.',
		icon: Sparkles,
		accent: 'warning',
	},
	{
		key: 'ship',
		title: 'Watch progress and ship',
		description:
			'Conductor works through the plan, pulls finished work together, and can open a PR when it is ready.',
		icon: CheckCircle2,
		accent: 'accent',
	},
] as const;

const FRIENDLY_TASK_STATUS_LABELS: Record<ConductorTaskStatus, string> = {
	draft: 'Brainstorm',
	planning: 'Planning',
	ready: 'Ready',
	running: 'In progress',
	needs_input: 'Needs input',
	blocked: 'Blocked',
	needs_review: 'Check me',
	cancelled: 'Stopped',
	done: 'Done',
};

const FRIENDLY_TASK_SOURCE_LABELS: Record<ConductorTask['source'], string> = {
	manual: 'You added this',
	planner: 'Conductor planned this',
	worker_followup: 'Suggested follow-up',
	reviewer_followup: 'Reviewer follow-up',
};

function formatLabel(value: string): string {
	return value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTaskStatusLabel(status: ConductorTaskStatus): string {
	return FRIENDLY_TASK_STATUS_LABELS[status];
}

function formatTaskSourceLabel(source: ConductorTask['source']): string {
	return FRIENDLY_TASK_SOURCE_LABELS[source];
}

function formatConductorRoleLabel(role: ConductorAgentRole): string {
	switch (role) {
		case 'planner':
			return 'Planner';
		case 'reviewer':
			return 'QA';
		case 'worker':
		default:
			return 'Worker';
	}
}

function formatProviderChoiceLabel(choice: ConductorProviderChoice): string {
	if (choice === 'workspace-lead') {
		return 'Workspace lead';
	}
	return getProviderDisplayName(choice);
}

function formatConductorStatusLabel(status?: string): string {
	switch (status) {
		case 'needs_setup':
			return 'Needs a workspace agent';
		case 'awaiting_approval':
			return 'Waiting for your okay';
		case 'attention_required':
			return 'Needs your attention';
		case 'integrating':
			return 'Pulling results together';
		default:
			return status ? formatLabel(status) : 'Needs a workspace agent';
	}
}

function derivePlanTitle(request: string): string {
	const firstLine = request
		.trim()
		.split('\n')
		.map((line) => line.trim())
		.find(Boolean);

	if (!firstLine) {
		return 'New Conductor request';
	}

	return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function getGlassPanelStyle(
	theme: Theme,
	options?: {
		tint?: string;
		borderColor?: string;
		strong?: boolean;
		elevated?: boolean;
	}
): React.CSSProperties {
	const tint = options?.tint || 'rgba(255, 255, 255, 0.10)';
	const borderColor = options?.borderColor || 'rgba(255, 255, 255, 0.10)';
	const strong = options?.strong ?? false;
	const elevated = options?.elevated ?? false;

	return {
		background: `linear-gradient(180deg, ${tint} 0%, rgba(255, 255, 255, ${strong ? '0.06' : '0.04'}) 42%, rgba(255, 255, 255, 0.02) 100%)`,
		backgroundColor: theme.colors.bgSidebar,
		border: `1px solid ${borderColor}`,
		backdropFilter: strong ? 'blur(28px) saturate(140%)' : 'blur(22px) saturate(132%)',
		WebkitBackdropFilter: strong ? 'blur(28px) saturate(140%)' : 'blur(22px) saturate(132%)',
		boxShadow: strong
			? elevated
				? '0 30px 60px rgba(15, 23, 42, 0.18), 0 12px 28px rgba(15, 23, 42, 0.12), 0 1px 0 rgba(255, 255, 255, 0.20) inset, 0 -1px 0 rgba(255, 255, 255, 0.03) inset'
				: '0 24px 48px rgba(15, 23, 42, 0.14), 0 10px 24px rgba(15, 23, 42, 0.10), 0 1px 0 rgba(255, 255, 255, 0.16) inset, 0 -1px 0 rgba(255, 255, 255, 0.03) inset'
			: elevated
				? '0 22px 42px rgba(15, 23, 42, 0.14), 0 8px 20px rgba(15, 23, 42, 0.09), 0 1px 0 rgba(255, 255, 255, 0.14) inset, 0 -1px 0 rgba(255, 255, 255, 0.03) inset'
				: '0 16px 30px rgba(15, 23, 42, 0.10), 0 6px 14px rgba(15, 23, 42, 0.07), 0 1px 0 rgba(255, 255, 255, 0.12) inset, 0 -1px 0 rgba(255, 255, 255, 0.02) inset',
	};
}

function getGlassButtonStyle(
	theme: Theme,
	options?: {
		active?: boolean;
		accent?: boolean;
	}
): React.CSSProperties {
	const active = options?.active ?? false;
	const accent = options?.accent ?? false;

	if (accent) {
		return {
			border: `1px solid ${theme.colors.accent}35`,
			background: `linear-gradient(180deg, ${theme.colors.accent} 0%, ${theme.colors.accent}e0 55%, ${theme.colors.accent}c8 100%)`,
			color: theme.colors.accentForeground,
			boxShadow: `0 22px 34px ${theme.colors.accent}30, 0 10px 18px ${theme.colors.accent}18, inset 0 1px 0 rgba(255,255,255,0.24), inset 0 -1px 0 rgba(0,0,0,0.08)`,
		};
	}

	return {
		border: `1px solid ${active ? `${theme.colors.accent}32` : 'rgba(255, 255, 255, 0.10)'}`,
		background: active
			? `linear-gradient(180deg, ${theme.colors.accent}18 0%, rgba(255,255,255,0.08) 55%, rgba(255,255,255,0.03) 100%)`
			: 'linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.05) 55%, rgba(255,255,255,0.03) 100%)',
		color: active ? theme.colors.textMain : theme.colors.textDim,
		backdropFilter: 'blur(18px)',
		WebkitBackdropFilter: 'blur(18px)',
		boxShadow: active
			? '0 16px 28px rgba(15, 23, 42, 0.12), 0 6px 14px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255,255,255,0.12), inset 0 -1px 0 rgba(255,255,255,0.03)'
			: '0 12px 22px rgba(15, 23, 42, 0.08), 0 4px 10px rgba(15, 23, 42, 0.05), inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(255,255,255,0.02)',
	};
}

function getGlassInputStyle(theme: Theme): React.CSSProperties {
	return {
		background:
			'linear-gradient(180deg, rgba(255,255,255,0.15) 0%, rgba(255,255,255,0.07) 55%, rgba(255,255,255,0.03) 100%)',
		backgroundColor: theme.colors.bgMain,
		border: '1px solid rgba(255,255,255,0.10)',
		color: theme.colors.textMain,
		backdropFilter: 'blur(18px)',
		WebkitBackdropFilter: 'blur(18px)',
		boxShadow:
			'0 10px 20px rgba(15, 23, 42, 0.05), inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(255,255,255,0.02)',
	};
}

function getGlassPillStyle(
	theme: Theme,
	tone?: 'default' | 'accent' | 'success' | 'warning'
): React.CSSProperties {
	const tint =
		tone === 'success'
			? theme.colors.success
			: tone === 'warning'
				? theme.colors.warning
				: tone === 'accent'
					? theme.colors.accent
					: theme.colors.textDim;

	return {
		background: `linear-gradient(180deg, ${tint}18 0%, rgba(255,255,255,0.07) 55%, rgba(255,255,255,0.03) 100%)`,
		border: `1px solid ${tint}28`,
		color: tint,
		backdropFilter: 'blur(16px)',
		WebkitBackdropFilter: 'blur(16px)',
		boxShadow: '0 10px 18px rgba(15, 23, 42, 0.06), inset 0 1px 0 rgba(255,255,255,0.08)',
	};
}


function getConductorEventTone(
	eventType: ConductorRunEvent['type']
): 'accent' | 'success' | 'warning' | 'default' {
	switch (eventType) {
		case 'task_completed':
		case 'execution_completed':
		case 'review_passed':
		case 'integration_completed':
		case 'validation_passed':
		case 'cleanup_completed':
		case 'pr_created':
			return 'success';
		case 'task_needs_input':
		case 'task_blocked':
		case 'task_cancelled':
		case 'planning_failed':
		case 'execution_failed':
		case 'review_failed':
		case 'integration_conflict':
		case 'validation_failed':
			return 'warning';
		case 'planning_started':
		case 'plan_generated':
		case 'plan_approved':
		case 'execution_started':
		case 'task_started':
		case 'review_started':
		case 'integration_started':
		case 'branch_merged':
		case 'validation_started':
			return 'accent';
		default:
			return 'default';
	}
}

function formatTimestamp(value?: number): string {
	if (!value) {
		return 'Not recorded';
	}

	return new Date(value).toLocaleString();
}

function hasOutstandingIntegrationConflict(run: ConductorRun | null): boolean {
	if (!run || run.status !== 'attention_required') {
		return false;
	}

	const latestConflict = [...run.events]
		.reverse()
		.find((event) => event.type === 'integration_conflict');
	if (!latestConflict) {
		return false;
	}

	const latestCompletion = [...run.events]
		.reverse()
		.find((event) => event.type === 'integration_completed');

	return !latestCompletion || latestConflict.createdAt > latestCompletion.createdAt;
}

function buildConductorConflictResolutionPrompt(input: {
	groupName: string;
	integrationBranch: string;
	baseBranch: string;
	worktreePath: string;
	validationCommand?: string;
}): string {
	const validationLine = input.validationCommand?.trim()
		? `After resolving the merge conflict, run \`${input.validationCommand.trim()}\` and include the result in your summary.`
		: 'After resolving the merge conflict, run `git status --short` and include the result in your summary.';

	return [
		`Resolve the current git merge conflict for the ${input.groupName} integration branch.`,
		`Work in \`${input.worktreePath}\` on branch \`${input.integrationBranch}\`, which is integrating changes back into \`${input.baseBranch}\`.`,
		'Inspect the conflicted files, resolve the conflicts carefully, and stage the resolved files when you are done.',
		validationLine,
		'Do not open a PR or start a new branch. In your final response, list the files you resolved and whether any conflicts remain.',
	].join('\n\n');
}

function formatMemorySummary(snapshot: ResourceSnapshot | null): string {
	if (!snapshot) {
		return 'Unavailable';
	}

	const freeGb = ((snapshot.availableMemoryMB ?? snapshot.freeMemoryMB) / 1024).toFixed(1);
	const totalGb = (snapshot.totalMemoryMB / 1024).toFixed(1);
	return `${freeGb} GB available of ${totalGb} GB`;
}

// Spring pastel palette - each status gets a distinct soft color
const PASTEL_STATUS_TONES: Record<ConductorTaskStatus, { fg: string; bg: string; border: string }> = {
	draft:        { fg: '#b0b8c4', bg: '#b0b8c412', border: '#b0b8c428' },     // soft gray
	planning:     { fg: '#a78bfa', bg: '#a78bfa12', border: '#a78bfa28' },     // lavender
	ready:        { fg: '#60a5fa', bg: '#60a5fa12', border: '#60a5fa28' },     // sky blue
	running:      { fg: '#818cf8', bg: '#818cf812', border: '#818cf828' },     // periwinkle
	needs_input:  { fg: '#fbbf24', bg: '#fbbf2412', border: '#fbbf2428' },     // buttercup
	blocked:      { fg: '#fb923c', bg: '#fb923c12', border: '#fb923c28' },     // peach
	needs_review: { fg: '#f9a8d4', bg: '#f9a8d412', border: '#f9a8d428' },    // rose pink
	cancelled:    { fg: '#94a3b8', bg: '#94a3b812', border: '#94a3b828' },     // slate
	done:         { fg: '#86efac', bg: '#86efac12', border: '#86efac28' },     // mint green
};

function getTaskStatusTone(
	_theme: Theme,
	status: ConductorTaskStatus
): { bg: string; fg: string; border: string } {
	return PASTEL_STATUS_TONES[status] ?? PASTEL_STATUS_TONES.draft;
}

function getTaskPriorityTone(
	theme: Theme,
	priority: ConductorTaskPriority
): { bg: string; fg: string; border: string } {
	switch (priority) {
		case 'critical':
			return {
				bg: `${theme.colors.error}18`,
				fg: theme.colors.error,
				border: `${theme.colors.error}35`,
			};
		case 'high':
			return {
				bg: `${theme.colors.warning}18`,
				fg: theme.colors.warning,
				border: `${theme.colors.warning}35`,
			};
		case 'medium':
			return {
				bg: `${theme.colors.accent}14`,
				fg: theme.colors.accent,
				border: `${theme.colors.accent}30`,
			};
		default:
			return {
				bg: `${theme.colors.textDim}10`,
				fg: theme.colors.textDim,
				border: `${theme.colors.textDim}24`,
			};
	}
}

function eventRelatesToTask(run: ConductorRun, event: ConductorRunEvent, task: ConductorTask): boolean {
	if (!run.taskIds.includes(task.id)) {
		return false;
	}

	if (run.taskIds.length === 1) {
		return true;
	}

	return event.message.toLowerCase().includes(task.title.trim().toLowerCase());
}

function collectRunArtifactPaths(run: ConductorRun | null): string[] {
	if (!run) {
		return [];
	}

	const paths = new Set<string>();
	if (run.worktreePath) {
		paths.add(run.worktreePath);
	}
	for (const path of run.worktreePaths || []) {
		if (path) {
			paths.add(path);
		}
	}
	for (const path of Object.values(run.taskWorktreePaths || {})) {
		if (path) {
			paths.add(path);
		}
	}
	return [...paths];
}

function collectWorkerBranches(run: ConductorRun | null): string[] {
	if (!run) {
		return [];
	}

	const branches = new Set<string>();
	for (const branch of run.workerBranches || []) {
		if (branch) {
			branches.add(branch);
		}
	}
	for (const branch of Object.values(run.taskBranches || {})) {
		if (branch) {
			branches.add(branch);
		}
	}
	return [...branches];
}

function isConductorNoiseLogText(text: string | undefined): boolean {
	const normalized = text?.trim().toLowerCase();
	return normalized === 'file:change';
}

function isConductorConversationLog(entry: LogEntry): boolean {
	if (entry.source === 'tool' || entry.source === 'stdout') {
		return false;
	}

	if (isConductorNoiseLogText(entry.text)) {
		return false;
	}

	if (entry.source === 'thinking') {
		return Boolean(entry.text?.trim());
	}

	if (entry.source === 'system' || entry.source === 'error' || entry.source === 'stderr') {
		return Boolean(entry.text?.trim());
	}

	return entry.source === 'user' || entry.source === 'ai';
}

function isConductorActivityLog(entry: LogEntry): boolean {
	if (entry.source === 'tool') {
		return true;
	}

	if (entry.source === 'stdout') {
		return Boolean(entry.text?.trim());
	}

	if (entry.source === 'system' || entry.source === 'error' || entry.source === 'stderr') {
		return Boolean(entry.text?.trim()) && !isConductorConversationLog(entry);
	}

	return false;
}

function getConductorLogTone(
	entry: LogEntry
): 'accent' | 'success' | 'warning' | 'default' {
	if (entry.source === 'ai') {
		return 'accent';
	}
	if (entry.source === 'user') {
		return 'success';
	}
	if (
		entry.source === 'error' ||
		entry.source === 'stderr' ||
		entry.metadata?.toolState?.status === 'error'
	) {
		return 'warning';
	}
	return 'default';
}

function getConductorLogLabel(entry: LogEntry): string {
	if (entry.source === 'ai') {
		return 'Agent';
	}
	if (entry.source === 'user') {
		return 'Prompt';
	}
	if (entry.source === 'system') {
		return 'System';
	}
	if (entry.source === 'thinking') {
		return 'Thinking';
	}
	if (entry.source === 'tool') {
		return 'Tool';
	}
	return formatLabel(entry.source);
}

export function ConductorPanel({ theme, groupId }: ConductorPanelProps): JSX.Element {
	const [activeTab, setActiveTab] = useState<ConductorTab>('overview');
	const [backlogView, setBacklogView] = useState<BacklogView>('board');
	const [taskSearch, setTaskSearch] = useState('');
	const [statusFilter, setStatusFilter] = useState<BacklogStatusFilter>('all');
	const [sourceFilter, setSourceFilter] = useState<BacklogSourceFilter>('all');
	const [sortMode, setSortMode] = useState<BacklogSort>('priority');
	const [advancedMode, setAdvancedMode] = useState(false);
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [isPlanComposerOpen, setIsPlanComposerOpen] = useState(false);
	const [isTaskComposerOpen, setIsTaskComposerOpen] = useState(false);
	const [selectedTaskDetailId, setSelectedTaskDetailId] = useState<string | null>(null);
	const [selectedConductorSessionId, setSelectedConductorSessionId] = useState<string | null>(null);
	const [expandedConductorToolLogIds, setExpandedConductorToolLogIds] = useState<Set<string>>(
		() => new Set()
	);
	const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
	const [draftDescription, setDraftDescription] = useState('');
	const [plannerNotes, setPlannerNotes] = useState('');
	const [manualTaskTitle, setManualTaskTitle] = useState('');
	const [manualTaskDescription, setManualTaskDescription] = useState('');
	const [manualTaskPriority, setManualTaskPriority] = useState<ConductorTaskPriority>('medium');
	const [manualTaskParentId, setManualTaskParentId] = useState<string>('');
	const [planningError, setPlanningError] = useState<string | null>(null);
	const [isPlanning, setIsPlanning] = useState(false);
	const [executionError, setExecutionError] = useState<string | null>(null);
	const [isExecuting, setIsExecuting] = useState(false);
	const [reviewError, setReviewError] = useState<string | null>(null);
	const [isReviewing, setIsReviewing] = useState(false);
	const [integrationError, setIntegrationError] = useState<string | null>(null);
	const [isIntegrating, setIsIntegrating] = useState(false);
	const [validationDraft, setValidationDraft] = useState('');
	const [isCreatingPr, setIsCreatingPr] = useState(false);
	const [isResolvingConflict, setIsResolvingConflict] = useState(false);
	const [resourceSnapshot, setResourceSnapshot] = useState<ResourceSnapshot | null>(null);
	const [isCleaningUp, setIsCleaningUp] = useState(false);
	const [leadCommitCount, setLeadCommitCount] = useState<number | null>(null);
	const [gitBootstrapError, setGitBootstrapError] = useState<string | null>(null);
	const [isBootstrappingGit, setIsBootstrappingGit] = useState(false);
	const cancelledTaskIdsRef = useRef<Set<string>>(new Set());
	const boardScrollRef = useRef<HTMLDivElement>(null);
	const lastAutoPlanReadyKeyRef = useRef<string | null>(null);
	const lastAutoRunReadyKeyRef = useRef<string | null>(null);
	const groups = useSessionStore((s) => s.groups);
	const sessions = useSessionStore((s) => s.sessions);
	const threads = useSessionStore((s) => s.threads);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);
	const setSessions = useSessionStore((s) => s.setSessions);
	const setThreads = useSessionStore((s) => s.setThreads);
	const updateSession = useSessionStore((s) => s.updateSession);
	const allTasks = useConductorStore((s) => s.tasks);
	const allRuns = useConductorStore((s) => s.runs);
	const conductor = useConductorStore((s) =>
		s.conductors.find((candidate) => candidate.groupId === groupId)
	);
	const addTask = useConductorStore((s) => s.addTask);
	const setConductor = useConductorStore((s) => s.setConductor);
	const setTasks = useConductorStore((s) => s.setTasks);
	const updateTask = useConductorStore((s) => s.updateTask);
	const deleteTask = useConductorStore((s) => s.deleteTask);
	const replacePlannerTasks = useConductorStore((s) => s.replacePlannerTasks);
	const upsertRun = useConductorStore((s) => s.upsertRun);
	const updateRun = useConductorStore((s) => s.updateRun);

	const group = useMemo(
		() => groups.find((candidate) => candidate.id === groupId) || null,
		[groups, groupId]
	);
	const tasks = useMemo(
		() => allTasks.filter((task) => task.groupId === groupId),
		[allTasks, groupId]
	);
	const runs = useMemo(() => allRuns.filter((run) => run.groupId === groupId), [allRuns, groupId]);
	const groupSessions = useMemo(
		() =>
			sessions.filter(
				(session) =>
					session.groupId === groupId &&
					!session.parentSessionId &&
					!session.conductorMetadata?.isConductorSession &&
					session.toolType !== 'terminal'
			),
		[sessions, groupId]
	);
	const groupSessionsByRuntimeId = useMemo(
		() => new Map(groupSessions.map((session) => [session.runtimeId || session.id, session])),
		[groupSessions]
	);
	const selectedTemplate = useMemo(
		() => {
			const workspaceThreads = threads
				.filter(
					(thread) =>
						thread.workspaceId === groupId &&
						groupSessionsByRuntimeId.has(getRuntimeIdForThread(thread))
				)
				.sort((left, right) => {
					const leftSession = groupSessionsByRuntimeId.get(getRuntimeIdForThread(left));
					const rightSession = groupSessionsByRuntimeId.get(getRuntimeIdForThread(right));
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
				? groupSessionsByRuntimeId.get(getRuntimeIdForThread(workspaceThreads[0])) || null
				: null;
			if (threadLead) {
				return threadLead;
			}

			return [...groupSessions].sort(
				(left, right) => getSessionLastActivity(right) - getSessionLastActivity(left)
			)[0] || null;
		},
		[groupId, groupSessions, groupSessionsByRuntimeId, threads]
	);
	const displayConductorStatus = selectedTemplate
		? conductor?.status === 'needs_setup'
			? 'idle'
			: conductor?.status
		: 'needs_setup';
	const providerRouting = conductor?.providerRouting || {
		default: { primary: 'workspace-lead' as const, fallback: null },
		ui: { primary: 'claude-code' as const, fallback: 'codex' as const },
		backend: { primary: 'codex' as const, fallback: 'claude-code' as const },
		pauseNearLimit: true,
		nearLimitPercent: 88,
	};
	const validationCommand = conductor?.validationCommand || '';
	const latestPlanningRun = useMemo(
		() => runs.find((run) => (run.kind || 'planning') === 'planning') || null,
		[runs]
	);
	const latestExecutionRun = useMemo(
		() => runs.find((run) => run.kind === 'execution') || null,
		[runs]
	);
	const latestIntegrationRun = useMemo(
		() => runs.find((run) => run.kind === 'integration') || null,
		[runs]
	);
	const latestRun = useMemo(() => runs[0] || null, [runs]);
	const pendingRun = useMemo(
		() => runs.find((run) => run.status === 'awaiting_approval') || null,
		[runs]
	);
	const plannerTasks = useMemo(() => tasks.filter((task) => task.source === 'planner'), [tasks]);
	const manualTasks = useMemo(() => tasks.filter((task) => task.source !== 'planner'), [tasks]);
	const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
	const childTasksByParentId = useMemo(() => {
		const map = new Map<string, ConductorTask[]>();
		for (const task of tasks) {
			if (!task.parentTaskId) {
				continue;
			}
			const existing = map.get(task.parentTaskId);
			if (existing) {
				existing.push(task);
			} else {
				map.set(task.parentTaskId, [task]);
			}
		}
		return map;
	}, [tasks]);
	const selectedTaskDetail = useMemo(
		() => (selectedTaskDetailId ? tasksById.get(selectedTaskDetailId) || null : null),
		[selectedTaskDetailId, tasksById]
	);
	const reviewReadyTasks = useMemo(
		() => tasks.filter((task) => task.status === 'needs_review'),
		[tasks]
	);
	const integrationReadyTaskIds = useMemo(() => {
		if (!latestExecutionRun?.taskBranches) {
			return [];
		}

		return latestExecutionRun.taskIds.filter((taskId) => {
			const task = tasksById.get(taskId);
			return task?.status === 'done' && Boolean(latestExecutionRun.taskBranches?.[taskId]);
		});
	}, [latestExecutionRun, tasksById]);
	const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
	const sessionNameById = useMemo(
		() => new Map(sessions.map((session) => [session.id, session.name])),
		[sessions]
	);
	const conductorAgentSessions = useMemo(
		() =>
			sessions.filter(
				(session) =>
					session.conductorMetadata?.isConductorSession && session.conductorMetadata.groupId === groupId
			),
		[sessions, groupId]
	);
	const activeConductorAgentSessions = useMemo(
		() => conductorAgentSessions.filter((session) => session.state === 'busy'),
		[conductorAgentSessions]
	);
	const selectedConductorSession = useMemo(
		() =>
			selectedConductorSessionId
				? sessions.find((session) => session.id === selectedConductorSessionId) || null
				: null,
		[selectedConductorSessionId, sessions]
	);
	const sortedConductorAgentSessions = useMemo(
		() =>
			[...conductorAgentSessions].sort((left, right) => {
				if (left.state === 'busy' && right.state !== 'busy') {
					return -1;
				}
				if (left.state !== 'busy' && right.state === 'busy') {
					return 1;
				}
				return getSessionLastActivity(right) - getSessionLastActivity(left);
			}),
		[conductorAgentSessions]
	);
	const selectedConductorSessionActiveTab = useMemo(() => {
		if (!selectedConductorSession) {
			return null;
		}

		return (
			selectedConductorSession.aiTabs.find((tab) => tab.id === selectedConductorSession.activeTabId) ||
			selectedConductorSession.aiTabs[0] ||
			null
		);
	}, [selectedConductorSession]);
	const selectedConductorConversationLogs = useMemo(() => {
		if (!selectedConductorSession) {
			return [];
		}

		const tabLogs = (selectedConductorSessionActiveTab?.logs || []).filter(isConductorConversationLog);
		const shellNotes = selectedConductorSession.shellLogs.filter(
			(entry) =>
				(entry.source === 'system' || entry.source === 'error' || entry.source === 'stderr') &&
				Boolean(entry.text?.trim()) &&
				!isConductorNoiseLogText(entry.text)
		);

		return [...tabLogs, ...shellNotes].sort((left, right) => left.timestamp - right.timestamp);
	}, [selectedConductorSession, selectedConductorSessionActiveTab]);
	const selectedConductorActivityLogs = useMemo(() => {
		if (!selectedConductorSession) {
			return [];
		}

		const tabActivity = (selectedConductorSessionActiveTab?.logs || []).filter(isConductorActivityLog);
		const shellActivity = selectedConductorSession.shellLogs.filter(isConductorActivityLog);

		return [...tabActivity, ...shellActivity].sort((left, right) => left.timestamp - right.timestamp);
	}, [selectedConductorSession, selectedConductorSessionActiveTab]);
	const selectedConductorVisibleLogCount = useMemo(
		() => selectedConductorConversationLogs.length + selectedConductorActivityLogs.length,
		[selectedConductorConversationLogs, selectedConductorActivityLogs]
	);
	const selectedTaskRelatedRuns = useMemo(
		() =>
			selectedTaskDetail
				? runs.filter((run) => run.taskIds.includes(selectedTaskDetail.id))
				: [],
		[runs, selectedTaskDetail]
	);
	const selectedTaskRecentEvents = useMemo(
		() =>
			selectedTaskDetail
				? selectedTaskRelatedRuns
						.flatMap((run) =>
							run.events
								.filter((event) => eventRelatesToTask(run, event, selectedTaskDetail))
								.map((event) => ({
									event,
									runKind: run.kind || 'planning',
									runStatus: run.status,
								}))
						)
						.sort((left, right) => right.event.createdAt - left.event.createdAt)
						.slice(0, 8)
				: [],
		[selectedTaskDetail, selectedTaskRelatedRuns]
	);
	const selectedTaskParent = useMemo(
		() =>
			selectedTaskDetail?.parentTaskId ? tasksById.get(selectedTaskDetail.parentTaskId) || null : null,
		[selectedTaskDetail, tasksById]
	);
	const selectedTaskChildren = useMemo(
		() => (selectedTaskDetail ? childTasksByParentId.get(selectedTaskDetail.id) || [] : []),
		[selectedTaskDetail, childTasksByParentId]
	);
	const selectedTaskLatestExecution = useMemo(
		() =>
			selectedTaskDetail
				? runs.find(
						(run) =>
							run.kind === 'execution' &&
							run.taskIds.includes(selectedTaskDetail.id) &&
							Boolean(
								run.taskWorktreePaths?.[selectedTaskDetail.id] ||
									run.taskBranches?.[selectedTaskDetail.id]
							)
					) || null
				: null,
		[runs, selectedTaskDetail]
	);

	const taskCounts = useMemo(
		() => ({
			total: tasks.length,
			done: tasks.filter((task) => task.status === 'done').length,
			cancelled: tasks.filter((task) => task.status === 'cancelled').length,
			ready: tasks.filter((task) => task.status === 'ready').length,
			running: tasks.filter((task) => task.status === 'running').length,
			planning: tasks.filter((task) => task.status === 'planning').length,
			needsInput: tasks.filter((task) => task.status === 'needs_input').length,
			blocked: tasks.filter((task) => task.status === 'blocked').length,
			needsReview: tasks.filter((task) => task.status === 'needs_review').length,
			draft: tasks.filter((task) => task.status === 'draft').length,
		}),
		[tasks]
	);
	const tasksNeedingPlanningIds = useMemo(() => {
		const priorityRank = new Map<ConductorTaskPriority, number>([
			['critical', 0],
			['high', 1],
			['medium', 2],
			['low', 3],
		]);

		return [...tasks]
			.filter(
				(task) =>
					task.source !== 'planner' &&
					(task.status === 'ready' || (task.status === 'planning' && !task.plannerSessionId))
			)
			.sort((left, right) => {
				const priorityDiff =
					(priorityRank.get(left.priority) ?? 99) - (priorityRank.get(right.priority) ?? 99);
				if (priorityDiff !== 0) {
					return priorityDiff;
				}
				return left.createdAt - right.createdAt;
			})
			.map((task) => task.id);
	}, [tasks]);
	const dependencyReadyTaskIds = useMemo(() => {
		const completedTaskIds = new Set(
			tasks.filter((task) => task.status === 'done').map((task) => task.id)
		);
		const priorityRank = new Map<ConductorTaskPriority, number>([
			['critical', 0],
			['high', 1],
			['medium', 2],
			['low', 3],
		]);

		return [...tasks]
			.filter(
				(task) =>
					task.source === 'planner' &&
					task.status === 'ready' &&
					task.dependsOn.every((dependencyId) => completedTaskIds.has(dependencyId))
			)
			.sort((left, right) => {
				const priorityDiff =
					(priorityRank.get(left.priority) ?? 99) - (priorityRank.get(right.priority) ?? 99);
				if (priorityDiff !== 0) {
					return priorityDiff;
				}
				return left.createdAt - right.createdAt;
			})
			.map((task) => task.id);
	}, [tasks]);
	const filteredTasks = useMemo(() => {
		const search = taskSearch.trim().toLowerCase();
		const priorityRank = new Map<ConductorTaskPriority, number>([
			['critical', 0],
			['high', 1],
			['medium', 2],
			['low', 3],
		]);

		const matchesSearch = (task: ConductorTask) => {
			if (!search) {
				return true;
			}

			return [
				task.title,
				task.description,
				task.source,
				task.parentTaskId ? tasksById.get(task.parentTaskId)?.title || '' : '',
				...task.scopePaths,
				...(task.changedPaths || []),
				...task.acceptanceCriteria,
			]
				.join(' ')
				.toLowerCase()
				.includes(search);
		};

		return tasks
			.filter((task) => (statusFilter === 'all' ? true : task.status === statusFilter))
			.filter((task) => (sourceFilter === 'all' ? true : task.source === sourceFilter))
			.filter(matchesSearch)
			.sort((left, right) => {
				switch (sortMode) {
					case 'title':
						return left.title.localeCompare(right.title);
					case 'updated_asc':
						return left.updatedAt - right.updatedAt;
					case 'updated_desc':
						return right.updatedAt - left.updatedAt;
					case 'priority':
					default: {
						const priorityDiff =
							(priorityRank.get(left.priority) ?? 99) - (priorityRank.get(right.priority) ?? 99);
						if (priorityDiff !== 0) {
							return priorityDiff;
						}
						return right.updatedAt - left.updatedAt;
					}
				}
			});
	}, [tasks, taskSearch, statusFilter, sourceFilter, sortMode, tasksById]);
	const taskCountsByStatus = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const status of BOARD_COLUMNS) {
			counts[status] = tasks.filter((t) => t.status === status).length;
		}
		return counts;
	}, [tasks]);

	const scrollToColumn = (status: ConductorTaskStatus) => {
		const container = boardScrollRef.current;
		if (!container) return;
		const column = container.querySelector(`[data-column-status="${status}"]`);
		if (column) {
			column.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
		}
	};

	const shippingComplete = Boolean(
		latestIntegrationRun &&
		latestIntegrationRun.status === 'completed' &&
		(conductor?.publishPolicy === 'none' || latestIntegrationRun.prUrl)
	);
	const percentComplete = taskCounts.total
		? Math.round((taskCounts.done / taskCounts.total) * 100)
		: 0;
	const overviewPills = useMemo<
		Array<{
			label: string;
			value: string | number;
			color: string;
			icon: React.ReactNode;
		}>
	>(
		() => {
			const pills: Array<{
				label: string;
				value: string | number;
				color: string;
				icon: React.ReactNode;
			}> = [];

			// Progress — only show when there are tasks
			if (taskCounts.total > 0) {
				pills.push({
					label: `${taskCounts.done}/${taskCounts.total} done`,
					value: `${percentComplete}%`,
					color: percentComplete === 100 ? '#86efac' : '#60a5fa',
					icon: <Activity className="w-3.5 h-3.5" />,
				});
			}

			// Active — only show when something is running
			const activeCount = activeConductorAgentSessions.length || taskCounts.running + taskCounts.planning;
			if (activeCount > 0) {
				pills.push({
					label: activeConductorAgentSessions.length > 0
						? `${activeConductorAgentSessions.length} agent${activeConductorAgentSessions.length === 1 ? '' : 's'} working`
						: `${activeCount} running`,
					value: activeCount,
					color: '#818cf8',
					icon: <Users className="w-3.5 h-3.5" />,
				});
			}

			// Needs input — only show when there's something actionable
			const inputCount = taskCounts.needsInput + taskCounts.blocked + taskCounts.needsReview;
			if (pendingRun) {
				pills.push({
					label: `Plan review · ${pendingRun.taskIds.length} task${pendingRun.taskIds.length === 1 ? '' : 's'}`,
					value: '!',
					color: '#fbbf24',
					icon: <ShieldAlert className="w-3.5 h-3.5" />,
				});
			} else if (inputCount > 0) {
				const parts: string[] = [];
				if (taskCounts.needsInput > 0) parts.push(`${taskCounts.needsInput} need input`);
				if (taskCounts.needsReview > 0) parts.push(`${taskCounts.needsReview} need review`);
				if (taskCounts.blocked > 0) parts.push(`${taskCounts.blocked} blocked`);
				pills.push({
					label: parts.join(' · '),
					value: inputCount,
					color: '#fb923c',
					icon: <ShieldAlert className="w-3.5 h-3.5" />,
				});
			}

			// Shipping — only show when there's progress toward shipping
			if (shippingComplete) {
				pills.push({
					label: latestIntegrationRun?.prUrl ? 'PR opened' : 'Ready to ship',
					value: '✓',
					color: '#86efac',
					icon: <CheckCircle2 className="w-3.5 h-3.5" />,
				});
			} else if (latestIntegrationRun?.status === 'completed') {
				pills.push({
					label: 'Integrated · PR next',
					value: '→',
					color: '#a78bfa',
					icon: <CheckCircle2 className="w-3.5 h-3.5" />,
				});
			} else if (latestExecutionRun?.status === 'completed') {
				pills.push({
					label: 'Execution done · integrating next',
					value: '→',
					color: '#60a5fa',
					icon: <CheckCircle2 className="w-3.5 h-3.5" />,
				});
			}

			return pills;
		},
		[
			latestExecutionRun?.status,
			latestIntegrationRun?.prUrl,
			latestIntegrationRun?.status,
			pendingRun,
			percentComplete,
			shippingComplete,
			taskCounts.blocked,
			taskCounts.done,
			taskCounts.needsInput,
			taskCounts.needsReview,
			taskCounts.planning,
			taskCounts.running,
			taskCounts.total,
			activeConductorAgentSessions.length,
		]
	);
	const recentEvents = useMemo(
		() =>
			[...runs]
				.flatMap((run) =>
					run.events.map((event) => ({
						event,
						runKind: run.kind || 'planning',
						runStatus: run.status,
					}))
				)
				.sort((left, right) => right.event.createdAt - left.event.createdAt)
				.slice(0, 6),
		[runs]
	);

	const resourceGate = useMemo(
		() => evaluateConductorResourceGate(conductor?.resourceProfile || 'aggressive', resourceSnapshot),
		[conductor?.resourceProfile, resourceSnapshot]
	);
	const selectedTemplateSshRemoteId = useMemo(() => {
		if (
			selectedTemplate?.sessionSshRemoteConfig?.enabled &&
			selectedTemplate.sessionSshRemoteConfig.remoteId
		) {
			return selectedTemplate.sessionSshRemoteConfig.remoteId;
		}
		return undefined;
	}, [selectedTemplate]);
	const gitReadiness = useMemo(() => {
		if (!selectedTemplate) {
			return 'missing_agent' as const;
		}
		if (!selectedTemplate.isGitRepo) {
			return 'missing_repo' as const;
		}
		if (leadCommitCount === 0) {
			return 'missing_commit' as const;
		}
		return 'ready' as const;
	}, [leadCommitCount, selectedTemplate]);
	useEffect(() => {
		setValidationDraft(validationCommand);
	}, [validationCommand]);

	useEffect(() => {
		let cancelled = false;

		setGitBootstrapError(null);
		if (!selectedTemplate?.isGitRepo) {
			setLeadCommitCount(null);
			return () => {
				cancelled = true;
			};
		}

		const loadCommitCount = async () => {
			const result = await window.maestro.git.commitCount(
				selectedTemplate.cwd,
				selectedTemplateSshRemoteId
			);
			if (!cancelled) {
				setLeadCommitCount(result.error ? 0 : result.count);
			}
		};

		void loadCommitCount();

		return () => {
			cancelled = true;
		};
	}, [selectedTemplate?.cwd, selectedTemplate?.id, selectedTemplate?.isGitRepo, selectedTemplateSshRemoteId]);

	useEffect(() => {
		let cancelled = false;

		const loadSnapshot = async () => {
			try {
				const snapshot = await window.maestro.system.getResourceSnapshot();
				if (!cancelled) {
					setResourceSnapshot(snapshot);
				}
			} catch {
				if (!cancelled) {
					setResourceSnapshot(null);
				}
			}
		};

		void loadSnapshot();
		const interval = window.setInterval(() => {
			void loadSnapshot();
		}, 10000);

		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, []);

	useEffect(() => {
		if (selectedTaskDetailId && !tasksById.has(selectedTaskDetailId)) {
			setSelectedTaskDetailId(null);
		}
	}, [selectedTaskDetailId, tasksById]);

	useEffect(() => {
		if (selectedConductorSessionId && !sessionById.has(selectedConductorSessionId)) {
			setSelectedConductorSessionId(null);
		}
	}, [selectedConductorSessionId, sessionById]);

	useEffect(() => {
		setExpandedConductorToolLogIds(new Set());
	}, [selectedConductorSessionId]);

	useEffect(() => {
		const readyKey = tasksNeedingPlanningIds.join('|');

		if (!readyKey) {
			lastAutoPlanReadyKeyRef.current = null;
			return;
		}

		if (!selectedTemplate || pendingRun || isPlanning || isExecuting || isReviewing || isIntegrating) {
			return;
		}

		if (lastAutoPlanReadyKeyRef.current === readyKey) {
			return;
		}

		lastAutoPlanReadyKeyRef.current = readyKey;
		void handlePlanTask(tasksNeedingPlanningIds[0]);
	}, [
		tasksNeedingPlanningIds,
		isExecuting,
		isIntegrating,
		isPlanning,
		isReviewing,
		pendingRun,
		selectedTemplate,
	]);

	useEffect(() => {
		const readyKey = dependencyReadyTaskIds.join('|');

		if (!readyKey) {
			lastAutoRunReadyKeyRef.current = null;
			return;
		}

		if (
			!selectedTemplate ||
			gitReadiness !== 'ready' ||
			pendingRun ||
			isPlanning ||
			isExecuting ||
			isReviewing ||
			isIntegrating
		) {
			return;
		}

		if (lastAutoRunReadyKeyRef.current === readyKey) {
			return;
		}

		lastAutoRunReadyKeyRef.current = readyKey;
		void handleRunReadyTasks();
	}, [
		dependencyReadyTaskIds,
		isExecuting,
		gitReadiness,
		isIntegrating,
		isPlanning,
		isReviewing,
		pendingRun,
		selectedTemplate,
	]);

	const handleBootstrapGitRepo = async () => {
		if (!selectedTemplate) {
			return;
		}

		setIsBootstrappingGit(true);
		setGitBootstrapError(null);

		try {
			const result = await window.maestro.git.initializeRepo(
				selectedTemplate.cwd,
				true,
				selectedTemplateSshRemoteId
			);

			if (!result.success) {
				const message = result.error || 'Failed to initialize a git repository for this workspace.';
				setGitBootstrapError(message);
				setExecutionError(message);
				notifyToast({
					type: 'error',
					title: 'Git Setup Failed',
					message,
				});
				return;
			}

			updateSession(selectedTemplate.id, {
				isGitRepo: true,
				gitBranches: result.currentBranch ? [result.currentBranch] : selectedTemplate.gitBranches,
				gitRefsCacheTime: Date.now(),
			});
			setLeadCommitCount(result.createdCommit ? 1 : Math.max(leadCommitCount || 0, 1));
			setExecutionError(null);
			if (conductor?.status === 'attention_required' || conductor?.status === 'needs_setup') {
				setConductor(groupId, { status: 'idle' });
			}
			lastAutoRunReadyKeyRef.current = null;

			notifyToast({
				type: 'success',
				title: 'Git Ready',
				message: result.createdCommit
					? 'Initialized the repository and created an initial commit.'
					: 'The workspace repository is ready for Conductor.',
			});

			if (dependencyReadyTaskIds.length > 0 && !pendingRun && !isPlanning && !isReviewing && !isIntegrating) {
				void handleRunReadyTasks();
			}
		} finally {
			setIsBootstrappingGit(false);
		}
	};

	const handleCopyRemotePath = async (remotePath: string) => {
		const copied = await safeClipboardWrite(remotePath);
		if (copied) {
			notifyToast({
				type: 'success',
				title: 'Remote Path Copied',
				message: remotePath,
			});
			return;
		}

		notifyToast({
			type: 'error',
			title: 'Copy Failed',
			message: 'Failed to copy remote path to the clipboard.',
		});
	};

	const handleTaskStatusMove = (taskId: string, nextStatus: ConductorTaskStatus) => {
		updateTask(taskId, { status: nextStatus });
	};

	const openTaskDetails = (taskId: string) => {
		setSelectedTaskDetailId(taskId);
	};

	const getActiveTaskSessionId = (task: ConductorTask): string | null => {
		if (task.status === 'planning') {
			return task.plannerSessionId || null;
		}
		if (task.status === 'running') {
			return task.workerSessionId || null;
		}
		if (task.status === 'needs_review') {
			const reviewerSession = task.reviewerSessionId ? sessionById.get(task.reviewerSessionId) : null;
			if (reviewerSession?.state === 'busy') {
				return reviewerSession.id;
			}
		}

		return null;
	};

	const getTaskProcessSessionIds = (sessionId: string): string[] => {
		const session = sessionById.get(sessionId);
		const ids = new Set<string>();
		if (session?.activeTabId) {
			ids.add(`${sessionId}-ai-${session.activeTabId}`);
		}
		ids.add(`${sessionId}-ai`);
		return [...ids];
	};

	const handleOpenAgentSession = (sessionId: string) => {
		if (!sessionById.has(sessionId)) {
			return;
		}
		setSelectedConductorSessionId(sessionId);
	};

	const handleCleanupIdleConductorAgents = () => {
		cleanupConductorAgentSessions(
			conductorAgentSessions.filter((session) => session.state !== 'busy').map((session) => session.id)
		);
	};

	const cleanupConductorAgentSessions = (sessionIds: string[]) => {
		if (conductor?.keepConductorAgentSessions || sessionIds.length === 0) {
			return;
		}

		const removableIds = new Set(sessionIds.filter(Boolean));
		if (removableIds.size === 0) {
			return;
		}

		setThreads((previous) =>
			previous.filter(
				(thread) =>
					!removableIds.has(thread.sessionId) && !removableIds.has(thread.runtimeId || thread.sessionId)
			)
		);
		setSessions((previous) => previous.filter((session) => !removableIds.has(session.id)));

		if (removableIds.has(activeSessionId)) {
			const fallbackSessionId =
				selectedTemplate && !removableIds.has(selectedTemplate.id)
					? selectedTemplate.id
					: sessions.find((session) => !removableIds.has(session.id))?.id || '';
			setActiveSessionId(fallbackSessionId);
		}
	};

	const getTaskAgentBadges = (
		task: ConductorTask
	): Array<{
		key: string;
		label: string;
		sessionId: string;
		tone: 'default' | 'accent' | 'success' | 'warning';
	}> => {
		const sessionRefs = [
			{ role: 'planner' as const, sessionId: task.plannerSessionId },
			{ role: 'worker' as const, sessionId: task.workerSessionId },
			{ role: 'reviewer' as const, sessionId: task.reviewerSessionId },
		].flatMap((candidate) =>
			candidate.sessionId ? [{ role: candidate.role, sessionId: candidate.sessionId }] : []
		);

		return sessionRefs.map(({ role, sessionId }) => {
			const session = sessionById.get(sessionId);
			return {
				key: `${task.id}-${role}-${sessionId}`,
				sessionId,
				label: `${formatConductorRoleLabel(role)}: ${
					(role === 'planner'
						? task.plannerSessionName
						: role === 'worker'
							? task.workerSessionName
							: task.reviewerSessionName) ||
					sessionNameById.get(sessionId) ||
					formatConductorRoleLabel(role)
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
	};

	const resetTaskComposer = () => {
		setManualTaskTitle('');
		setManualTaskDescription('');
		setManualTaskPriority('medium');
		setManualTaskParentId('');
	};

	const openTaskComposer = (parentTaskId?: string) => {
		setManualTaskParentId(parentTaskId || '');
		setIsTaskComposerOpen(true);
	};

	const clearTaskFilters = () => {
		setTaskSearch('');
		setStatusFilter('all');
		setSourceFilter('all');
		setSortMode('priority');
	};

	const handleCreateManualTask = () => {
		if (!manualTaskTitle.trim()) {
			return;
		}

		addTask(groupId, {
			title: manualTaskTitle,
			description: manualTaskDescription,
			priority: manualTaskPriority,
			status: 'draft',
			parentTaskId: manualTaskParentId || undefined,
			source: 'manual',
		});
		resetTaskComposer();
		setIsTaskComposerOpen(false);
	};

	const getLatestExecutionForTask = (taskId: string): ConductorRun | null =>
		runs.find(
			(run) =>
				run.kind === 'execution' &&
				run.taskIds.includes(taskId) &&
				Boolean(run.taskWorktreePaths?.[taskId] || run.taskBranches?.[taskId])
		) || null;

	const getLatestRunForTask = (taskId: string): ConductorRun | null =>
		runs.find((run) => run.taskIds.includes(taskId)) || null;

	const handlePlanTask = async (taskId: string) => {
		if (!selectedTemplate) {
			setPlanningError('This workspace needs at least one top-level agent before Conductor can plan.');
			return;
		}

		const task = tasksById.get(taskId);
		if (!task || task.source === 'planner') {
			return;
		}

		const now = Date.now();
		const runId = `conductor-run-${generateId()}`;
		const planningStartedEvent = {
			id: `conductor-run-event-${generateId()}`,
			runId,
			groupId,
			type: 'planning_started' as const,
			message: `Planning started for ${task.title}.`,
			createdAt: now,
		};

		cancelledTaskIdsRef.current.delete(task.id);
		setPlanningError(null);
		setIsPlanning(true);
		updateTask(task.id, { status: 'planning' });
		setConductor(groupId, { status: 'planning' });
		upsertRun({
			id: runId,
			groupId,
			kind: 'planning',
			baseBranch: selectedTemplate.worktreeBranch || '',
			sshRemoteId: selectedTemplateSshRemoteId,
			agentSessionIds: [],
			integrationBranch: '',
			status: 'planning',
			summary: '',
			plannerInput: task.description,
			taskIds: [task.id],
			events: [planningStartedEvent],
			startedAt: now,
		});

		let plannerSessionId: string | undefined;
		let plannerSessionName: string | undefined;
		try {
			const prompt = buildConductorPlannerPrompt({
				groupName: group?.name || 'Unnamed Group',
				templateSession: selectedTemplate,
				manualTasks: [
					{
						title: task.title,
						description: task.description,
						priority: task.priority,
						status: 'ready',
					},
				],
				operatorNotes:
					'Break this task into executable work. If it can stay as one task, return a single execution task.',
			});
			const plannerResult = await runConductorAgentTurn({
				parentSession: selectedTemplate,
				role: 'planner',
				taskTitle: task.title,
				taskDescription: task.description,
				scopePaths: task.scopePaths,
				prompt,
				cwd: selectedTemplate.cwd,
				runId,
				taskId: task.id,
				readOnlyMode: true,
				onSessionReady: (session) => {
					plannerSessionId = session.id;
					plannerSessionName = session.name;
					updateTask(task.id, {
						plannerSessionId: session.id,
						plannerSessionName: session.name,
					});
					updateRun(runId, {
						plannerSessionId: session.id,
						agentSessionIds: [session.id],
					});
				},
			});

			if (cancelledTaskIdsRef.current.has(task.id)) {
				const cancelledAt = Date.now();
				updateRun(runId, {
					status: 'cancelled',
					summary: `Planning was stopped for ${task.title}.`,
					endedAt: cancelledAt,
					events: [
						planningStartedEvent,
						{
							id: `conductor-run-event-${generateId()}`,
							runId,
							groupId,
							type: 'task_cancelled',
							message: `Stopped planning for ${task.title}.`,
							createdAt: cancelledAt,
						},
					],
				});
				setConductor(groupId, { status: 'idle' });
				cleanupConductorAgentSessions([plannerSessionId || '']);
				return;
			}

			const parsedPlan = parseConductorPlannerResponse(plannerResult.response);
			if (parsedPlan.tasks.length === 0) {
				throw new Error('Planner did not return any executable tasks.');
			}

			const updatedAt = Date.now();
			const generatedTaskIds = parsedPlan.tasks.map((plannedTask, index) => ({
				titleKey: plannedTask.title.trim().toLowerCase(),
				id: index === 0 ? task.id : `conductor-task-${generateId()}`,
			}));
			const titleToId = new Map(generatedTaskIds.map((entry) => [entry.titleKey, entry.id]));

			const plannedTasks = parsedPlan.tasks.map((plannedTask, index) => {
				const mappedDependsOn = plannedTask.dependsOn
					.map((dependency) => titleToId.get(dependency.trim().toLowerCase()))
					.filter((dependencyId): dependencyId is string => Boolean(dependencyId));

				return {
					id: titleToId.get(plannedTask.title.trim().toLowerCase())!,
					groupId,
					parentTaskId: plannedTask.parentTitle
						? titleToId.get(plannedTask.parentTitle.trim().toLowerCase()) || task.parentTaskId
						: task.parentTaskId,
					title: plannedTask.title,
					description: plannedTask.description,
					acceptanceCriteria: plannedTask.acceptanceCriteria,
					priority: plannedTask.priority,
					status: 'ready' as const,
					dependsOn:
						index === 0 ? Array.from(new Set([...task.dependsOn, ...mappedDependsOn])) : mappedDependsOn,
					scopePaths: plannedTask.scopePaths,
					changedPaths: [],
					source: 'planner' as const,
					plannerSessionId,
					plannerSessionName,
					createdAt: index === 0 ? task.createdAt : updatedAt,
					updatedAt,
				};
			});

			const [anchorTask, ...extraTasks] = plannedTasks;
			const extraTaskIds = new Set(extraTasks.map((plannedTask) => plannedTask.id));
			setTasks((previousTasks) => [
				...previousTasks.filter(
					(candidate) => candidate.id !== task.id && !extraTaskIds.has(candidate.id)
				),
				anchorTask,
				...extraTasks,
			]);

			const completedAt = Date.now();
			updateRun(runId, {
				status: 'completed',
				summary: parsedPlan.summary,
				taskIds: plannedTasks.map((plannedTask) => plannedTask.id),
				approvedAt: completedAt,
				endedAt: completedAt,
				events: [
					planningStartedEvent,
					{
						id: `conductor-run-event-${generateId()}`,
						runId,
						groupId,
						type: 'plan_generated',
						message: `Planner decomposed ${task.title} into ${plannedTasks.length} executable task${plannedTasks.length === 1 ? '' : 's'}.`,
						createdAt: completedAt,
					},
					{
						id: `conductor-run-event-${generateId()}`,
						runId,
						groupId,
						type: 'plan_approved',
						message: 'Conductor auto-approved the scoped task and queued it for execution.',
						createdAt: completedAt,
					},
				],
			});
			setConductor(groupId, { status: 'idle' });
			cleanupConductorAgentSessions([plannerSessionId || '']);
		} catch (error) {
			const finishedAt = Date.now();
			if (cancelledTaskIdsRef.current.has(task.id)) {
				updateRun(runId, {
					status: 'cancelled',
					summary: `Planning was stopped for ${task.title}.`,
					endedAt: finishedAt,
					events: [
						planningStartedEvent,
						{
							id: `conductor-run-event-${generateId()}`,
							runId,
							groupId,
							type: 'task_cancelled',
							message: `Stopped planning for ${task.title}.`,
							createdAt: finishedAt,
						},
					],
				});
				setConductor(groupId, { status: 'idle' });
				cleanupConductorAgentSessions([plannerSessionId || '']);
				return;
			}

			const message = error instanceof Error ? error.message : 'Plan generation failed.';
			setPlanningError(message);
			updateTask(task.id, { status: 'needs_input' });
			updateRun(runId, {
				status: 'attention_required',
				summary: message,
				endedAt: finishedAt,
				events: [
					planningStartedEvent,
					{
						id: `conductor-run-event-${generateId()}`,
						runId,
						groupId,
						type: 'planning_failed',
						message,
						createdAt: finishedAt,
					},
				],
			});
			setConductor(groupId, { status: 'attention_required' });
			cleanupConductorAgentSessions([plannerSessionId || '']);
		} finally {
			cancelledTaskIdsRef.current.delete(task.id);
			setIsPlanning(false);
		}
	};

	const handleGeneratePlan = async (options?: {
		requestOverride?: string;
		operatorNotesOverride?: string;
		autoExecute?: boolean;
	}) => {
		if (!selectedTemplate) {
			setPlanningError('This workspace needs at least one top-level agent before Conductor can plan.');
			return;
		}

		const requestOverride = options?.requestOverride?.trim() || '';
		const operatorNotes = options?.operatorNotesOverride ?? plannerNotes;
		const planningTasks = requestOverride
			? [
					{
						title: derivePlanTitle(requestOverride),
						description: requestOverride,
						priority: 'medium' as ConductorTaskPriority,
						status: 'ready' as ConductorTaskStatus,
					},
				]
			: manualTasks.map((task) => ({
					title: task.title,
					description: task.description,
					priority: task.priority,
					status: task.status,
				}));

		if (planningTasks.length === 0 && !operatorNotes.trim()) {
			setPlanningError('Add a request before generating a plan.');
			return;
		}

		const now = Date.now();
		const runId = `conductor-run-${generateId()}`;
		const planningStartedEvent = {
			id: `conductor-run-event-${generateId()}`,
			runId,
			groupId,
			type: 'planning_started' as const,
			message: `Planning started with ${planningTasks.length} request item${planningTasks.length === 1 ? '' : 's'}.`,
			createdAt: now,
		};

		setPlanningError(null);
		setIsPlanning(true);
		setConductor(groupId, { status: 'planning' });
		upsertRun({
			id: runId,
			groupId,
			kind: 'planning',
			baseBranch: selectedTemplate.worktreeBranch || '',
			sshRemoteId: selectedTemplateSshRemoteId,
			agentSessionIds: [],
			integrationBranch: '',
			status: 'planning',
			summary: '',
			plannerInput: operatorNotes.trim(),
			taskIds: [],
			events: [planningStartedEvent],
			startedAt: now,
		});

		let plannerSessionId: string | undefined;
		let plannerSessionName: string | undefined;
		try {
			const prompt = buildConductorPlannerPrompt({
				groupName: group?.name || 'Unnamed Group',
				templateSession: selectedTemplate,
				manualTasks: planningTasks,
				operatorNotes,
			});
			const plannerResult = await runConductorAgentTurn({
				parentSession: selectedTemplate,
				role: 'planner',
				taskDescription: planningTasks.map((candidate) => candidate.description).join('\n'),
				providerRouteHint: 'default',
				prompt,
				cwd: selectedTemplate.cwd,
				runId,
				readOnlyMode: true,
				onSessionReady: (session) => {
					plannerSessionId = session.id;
					plannerSessionName = session.name;
					updateRun(runId, {
						plannerSessionId: session.id,
						agentSessionIds: [session.id],
					});
				},
			});
			const parsedPlan = parseConductorPlannerResponse(plannerResult.response);
			const titleToId = new Map<string, string>();
			const plannedTasks = parsedPlan.tasks.map((task) => {
				const taskId = `conductor-task-${generateId()}`;
				titleToId.set(task.title.trim().toLowerCase(), taskId);
				return {
					id: taskId,
					groupId,
					parentTaskId: undefined,
					title: task.title,
					description: task.description,
					acceptanceCriteria: task.acceptanceCriteria,
					priority: task.priority,
					status: 'draft' as const,
					dependsOn: [],
					scopePaths: task.scopePaths,
					changedPaths: [],
					source: 'planner' as const,
					plannerSessionId,
					plannerSessionName,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				};
			});
			const plannedTasksWithDeps = plannedTasks.map((task, index) => ({
				...task,
				parentTaskId: parsedPlan.tasks[index].parentTitle
					? titleToId.get(parsedPlan.tasks[index].parentTitle.trim().toLowerCase())
					: undefined,
				dependsOn: parsedPlan.tasks[index].dependsOn
					.map((dependency) => titleToId.get(dependency.trim().toLowerCase()))
					.filter((dependencyId): dependencyId is string => Boolean(dependencyId)),
			}));
			const planGeneratedEvent = {
				id: `conductor-run-event-${generateId()}`,
				runId,
				groupId,
				type: 'plan_generated' as const,
				message: `Planner proposed ${plannedTasksWithDeps.length} execution task${plannedTasksWithDeps.length === 1 ? '' : 's'}.`,
				createdAt: Date.now(),
			};

			replacePlannerTasks(groupId, plannedTasksWithDeps);
			updateRun(runId, {
				status: 'awaiting_approval',
				summary: parsedPlan.summary,
				taskIds: plannedTasksWithDeps.map((task) => task.id),
				events: [planningStartedEvent, planGeneratedEvent],
			});
			setConductor(groupId, { status: 'awaiting_approval' });
			setActiveTab('overview');
			if (requestOverride) {
				setDraftDescription('');
				setPlannerNotes('');
				setIsPlanComposerOpen(false);
			}
			if (options?.autoExecute) {
				const approved = approvePlanningRun(runId);
				if (approved) {
					window.setTimeout(() => {
						void handleRunReadyTasks();
					}, 0);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Plan generation failed.';
			const failedAt = Date.now();
			setPlanningError(message);
			updateRun(runId, {
				status: 'attention_required',
				summary: message,
				endedAt: failedAt,
				events: [
					planningStartedEvent,
					{
						id: `conductor-run-event-${generateId()}`,
						runId,
						groupId,
						type: 'planning_failed',
						message,
						createdAt: failedAt,
					},
				],
			});
			setConductor(groupId, { status: 'attention_required' });
			cleanupConductorAgentSessions([plannerSessionId || '']);
		} finally {
			setIsPlanning(false);
		}
	};

	const handleRunReadyTasks = async () => {
		if (!selectedTemplate) {
			setExecutionError('This workspace needs at least one top-level agent before Conductor can run tasks.');
			return;
		}
		if (gitReadiness === 'missing_repo') {
			const message = 'Conductor needs a git repository for this workspace before it can start work.';
			setExecutionError(message);
			notifyToast({
				type: 'error',
				title: 'Conductor Needs Git',
				message,
			});
			return;
		}
		if (gitReadiness === 'missing_commit') {
			const message =
				'Conductor needs an initial commit in this workspace before it can create worker worktrees.';
			setExecutionError(message);
			notifyToast({
				type: 'error',
				title: 'Initial Commit Required',
				message,
			});
			return;
		}

		let currentSnapshot = resourceSnapshot;
		try {
			currentSnapshot = await window.maestro.system.getResourceSnapshot();
			setResourceSnapshot(currentSnapshot);
		} catch {
			currentSnapshot = resourceSnapshot;
		}

			const currentResourceGate = evaluateConductorResourceGate(
				conductor?.resourceProfile || 'aggressive',
				currentSnapshot
			);
		if (!currentResourceGate.allowed) {
			const message =
				currentResourceGate.message || 'Conductor execution is paused by resource limits.';
			setExecutionError(message);
			notifyToast({
				type: 'warning',
				title: 'Conductor Is Waiting',
				message,
			});
			return;
		}

		const tasksById = new Map(tasks.map((task) => [task.id, { ...task }]));
		const completedTaskIds = new Set(
			Array.from(tasksById.values())
				.filter((task) => task.status === 'done')
				.map((task) => task.id)
		);
		const blockedTaskIds = new Set<string>();
		const priorityRank = new Map<ConductorTaskPriority, number>([
			['critical', 0],
			['high', 1],
			['medium', 2],
			['low', 3],
		]);
		const sortTasks = (
			left: { priority: ConductorTaskPriority; createdAt: number },
			right: { priority: ConductorTaskPriority; createdAt: number }
		) => {
			const priorityDiff =
				(priorityRank.get(left.priority) ?? 99) - (priorityRank.get(right.priority) ?? 99);
			if (priorityDiff !== 0) {
				return priorityDiff;
			}
			return left.createdAt - right.createdAt;
		};
		const getDependencyReadyTasks = () =>
			Array.from(tasksById.values())
				.filter(
					(task) =>
						task.status === 'ready' &&
						task.dependsOn.every((dependencyId) => completedTaskIds.has(dependencyId))
				)
				.sort(sortTasks);
		const initialCandidates = getDependencyReadyTasks();

		if (initialCandidates.length === 0) {
			setExecutionError('No dependency-ready tasks are available to run.');
			return;
		}

		setExecutionError(null);
		setIsExecuting(true);
		setConductor(groupId, { status: 'running' });

		const runId = `conductor-run-${generateId()}`;
		const sshRemoteId = selectedTemplateSshRemoteId;
		const repoRootResult = await window.maestro.git.getRepoRoot(selectedTemplate.cwd, sshRemoteId);
		if (!repoRootResult.success || !repoRootResult.root) {
			setConductor(groupId, { status: 'attention_required' });
			setIsExecuting(false);
			setExecutionError(repoRootResult.error || 'Conductor execution requires a git repository.');
			return;
		}
		const repoRoot = repoRootResult.root;

		const baseBranchResult = await window.maestro.git.branch(selectedTemplate.cwd, sshRemoteId);
		const baseBranch = baseBranchResult.stdout.trim();
		const startedAt = Date.now();
		const events: ConductorRunEvent[] = [
			{
				id: `conductor-run-event-${generateId()}`,
				runId,
				groupId,
				type: 'execution_started',
				message: `Execution started for ${initialCandidates.length} dependency-ready task${initialCandidates.length === 1 ? '' : 's'}.`,
				createdAt: startedAt,
			},
		];
		const workerBranches: string[] = [];
		const worktreePaths: string[] = [];
		const taskBranches: Record<string, string> = {};
		const taskWorktreePaths: Record<string, string> = {};
		let workerAgentSessionIds: string[] = [];
		const taskWorkerSessionIds: Record<string, string> = {};

		upsertRun({
			id: runId,
			groupId,
			kind: 'execution',
			baseBranch,
			sshRemoteId,
			agentSessionIds: [],
			taskWorkerSessionIds: {},
			workerBranches: [],
			taskBranches: {},
			integrationBranch: '',
			worktreePaths: [],
			taskWorktreePaths: {},
			status: 'running',
			summary: `Executing ${initialCandidates.length} dependency-ready task${initialCandidates.length === 1 ? '' : 's'}.`,
			taskIds: initialCandidates.map((task) => task.id),
			events,
			startedAt,
		});

		let blockedMessage: string | null = null;
		const activeWorkers = new Map<string, Promise<void>>();
		const runningTaskIds = new Set<string>();

		try {
			const launchTask = async (taskId: string) => {
				const task = tasksById.get(taskId);
				if (!task) {
					return;
				}

				const workerTarget = buildConductorWorktreeTarget(
					repoRoot,
					group?.name || 'group',
					`${runId}-${task.id}`
				);
				const workerSetupResult = await window.maestro.git.worktreeSetup(
					repoRoot,
					workerTarget.worktreePath,
					workerTarget.branchName,
					sshRemoteId
				);
				if (!workerSetupResult.success) {
					throw new Error(
						workerSetupResult.error || `Failed to create worktree for ${task.title}.`
					);
				}

				if (!workerBranches.includes(workerTarget.branchName)) {
					workerBranches.push(workerTarget.branchName);
				}
				if (!worktreePaths.includes(workerTarget.worktreePath)) {
					worktreePaths.push(workerTarget.worktreePath);
				}
				taskBranches[task.id] = workerTarget.branchName;
				taskWorktreePaths[task.id] = workerTarget.worktreePath;

				const taskStartedAt = Date.now();
				events.push({
					id: `conductor-run-event-${generateId()}`,
					runId,
					groupId,
					type: 'task_started',
					message: `Started task: ${task.title} in ${workerTarget.branchName}`,
					createdAt: taskStartedAt,
				});
				updateRun(runId, {
					events: [...events],
					workerBranches: [...workerBranches],
					worktreePaths: [...worktreePaths],
					taskBranches: { ...taskBranches },
					taskWorktreePaths: { ...taskWorktreePaths },
					branchName: workerBranches[0],
					worktreePath: worktreePaths[0],
				});
				updateTask(task.id, { status: 'running' });
				tasksById.set(task.id, { ...task, status: 'running', updatedAt: taskStartedAt });

				try {
					const dependencyTitles = task.dependsOn
						.map((dependencyId) => tasksById.get(dependencyId)?.title)
						.filter((title): title is string => Boolean(title));
					const prompt = buildConductorWorkerPrompt(
						group?.name || 'Unnamed Group',
						{ ...selectedTemplate, cwd: workerTarget.worktreePath },
						task,
						dependencyTitles
					);
					const workerResult = await runConductorAgentTurn({
						parentSession: selectedTemplate,
						role: 'worker',
						taskTitle: task.title,
						taskDescription: task.description,
						scopePaths: task.scopePaths,
						prompt,
						cwd: workerTarget.worktreePath,
						branch: workerTarget.branchName,
						runId,
						taskId: task.id,
						readOnlyMode: false,
						onSessionReady: (session) => {
							taskWorkerSessionIds[task.id] = session.id;
							workerAgentSessionIds = Array.from(new Set([...workerAgentSessionIds, session.id]));
							updateTask(task.id, {
								workerSessionId: session.id,
								workerSessionName: session.name,
							});
							tasksById.set(task.id, {
								...task,
								status: 'running',
								workerSessionId: session.id,
								workerSessionName: session.name,
								updatedAt: Date.now(),
							});
							updateRun(runId, {
								taskWorkerSessionIds: { ...taskWorkerSessionIds },
								agentSessionIds: [...workerAgentSessionIds],
							});
						},
					});
					const result = parseConductorWorkerResponse(workerResult.response);
					const finishedAt = Date.now();

					if (result.outcome === 'blocked') {
						const blockedReason = result.blockedReason || result.summary;
						updateTask(task.id, { status: 'needs_input', changedPaths: result.changedPaths });
						tasksById.set(task.id, {
							...task,
							status: 'needs_input',
							changedPaths: result.changedPaths,
							updatedAt: finishedAt,
						});
						blockedTaskIds.add(task.id);
						events.push({
							id: `conductor-run-event-${generateId()}`,
							runId,
							groupId,
							type: 'task_needs_input',
							message: `Task needs input: ${task.title}. ${blockedReason}`,
							createdAt: finishedAt,
						});
						updateRun(runId, { events: [...events] });
						return;
					}

					updateTask(task.id, { status: 'needs_review', changedPaths: result.changedPaths });
					tasksById.set(task.id, {
						...task,
						status: 'needs_review',
						changedPaths: result.changedPaths,
						updatedAt: finishedAt,
					});
					completedTaskIds.add(task.id);

					if (result.followUpTasks.length > 0) {
						setTasks((previousTasks) => [
							...previousTasks,
							...result.followUpTasks.map((followUpTask) => ({
								id: `conductor-task-${generateId()}`,
								groupId,
								parentTaskId: task.id,
								title: followUpTask.title,
								description: followUpTask.description,
								acceptanceCriteria: [],
								priority: followUpTask.priority,
								status: 'draft' as const,
								dependsOn: [],
								scopePaths: [],
								changedPaths: [],
								source: 'worker_followup' as const,
								createdAt: finishedAt,
								updatedAt: finishedAt,
							})),
						]);
					}

					events.push({
						id: `conductor-run-event-${generateId()}`,
						runId,
						groupId,
						type: 'task_completed',
						message:
							result.followUpTasks.length > 0
								? `Completed task: ${task.title}. Sent to review with ${result.followUpTasks.length} follow-up subtask${result.followUpTasks.length === 1 ? '' : 's'} suggested.`
								: `Completed task: ${task.title}. Sent to review. ${result.summary}`,
						createdAt: finishedAt,
					});
					updateRun(runId, { events: [...events] });
				} catch (error) {
					if (cancelledTaskIdsRef.current.has(task.id)) {
						const cancelledAt = Date.now();
						updateTask(task.id, { status: 'cancelled' });
						tasksById.set(task.id, {
							...task,
							status: 'cancelled',
							updatedAt: cancelledAt,
						});
						events.push({
							id: `conductor-run-event-${generateId()}`,
							runId,
							groupId,
							type: 'task_cancelled',
							message: `Stopped task: ${task.title}.`,
							createdAt: cancelledAt,
						});
						updateRun(runId, { events: [...events] });
						return;
					}
					throw error;
				} finally {
					cancelledTaskIdsRef.current.delete(task.id);
					runningTaskIds.delete(task.id);
					activeWorkers.delete(task.id);
				}
			};

			while (true) {
				let launchedWorker = false;

				while (activeWorkers.size < currentResourceGate.maxWorkers) {
					const runningTasks = Array.from(runningTaskIds)
						.map((taskId) => tasksById.get(taskId))
						.filter((task): task is NonNullable<typeof task> => Boolean(task));
					const nextTask = getDependencyReadyTasks().find(
						(task) => !runningTasks.some((runningTask) => tasksConflict(task, runningTask))
					);

					if (!nextTask) {
						break;
					}

					runningTaskIds.add(nextTask.id);
					tasksById.set(nextTask.id, { ...nextTask, status: 'running' });
					const workerPromise = launchTask(nextTask.id);
					activeWorkers.set(nextTask.id, workerPromise);
					launchedWorker = true;
				}

				if (activeWorkers.size === 0) {
					const remainingReady = Array.from(tasksById.values()).filter(
						(task) => task.status === 'ready'
					);
					if (remainingReady.length > 0) {
						blockedMessage =
							blockedTaskIds.size > 0
								? 'Execution finished with blocked tasks. Some remaining tasks could not start because their dependencies are blocked.'
								: 'Execution stopped because remaining ready tasks overlap in scope or are still waiting on dependencies.';
					}
					break;
				}

				if (launchedWorker) {
					await Promise.resolve();
				}

				await Promise.race(Array.from(activeWorkers.values()));
			}

			const endedAt = Date.now();
			const finalBlocked = Boolean(blockedMessage) || blockedTaskIds.size > 0;
			events.push({
				id: `conductor-run-event-${generateId()}`,
				runId,
				groupId,
				type: finalBlocked ? 'execution_failed' : 'execution_completed',
				message:
					blockedMessage ||
					(finalBlocked
						? 'Execution completed with blocked tasks.'
						: 'Execution lane completed all dependency-ready tasks.'),
				createdAt: endedAt,
			});
			updateRun(runId, {
				status: finalBlocked ? 'blocked' : 'completed',
				summary:
					blockedMessage ||
					(finalBlocked
						? 'Execution completed with blocked tasks.'
						: 'Execution lane completed all dependency-ready tasks.'),
				endedAt,
				workerBranches: [...workerBranches],
				worktreePaths: [...worktreePaths],
				taskBranches: { ...taskBranches },
				taskWorktreePaths: { ...taskWorktreePaths },
				branchName: workerBranches[0],
				worktreePath: worktreePaths[0],
				events: [...events],
			});
			setConductor(groupId, {
				status: Array.from(tasksById.values()).some((task) => task.status === 'needs_input')
					? 'attention_required'
					: finalBlocked
						? 'blocked'
						: 'idle',
			});
			if (finalBlocked) {
				setExecutionError(
					blockedMessage ||
						'One or more tasks blocked during execution. Check the event feed for details.'
				);
			}
			cleanupConductorAgentSessions(workerAgentSessionIds);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Execution failed.';
			const failedAt = Date.now();
			events.push({
				id: `conductor-run-event-${generateId()}`,
				runId,
				groupId,
				type: 'execution_failed',
				message,
				createdAt: failedAt,
			});
			updateRun(runId, {
				status: 'attention_required',
				summary: message,
				endedAt: failedAt,
				workerBranches: [...workerBranches],
				worktreePaths: [...worktreePaths],
				taskBranches: { ...taskBranches },
				taskWorktreePaths: { ...taskWorktreePaths },
				branchName: workerBranches[0],
				worktreePath: worktreePaths[0],
				events: [...events],
			});
			setConductor(groupId, { status: 'attention_required' });
			setExecutionError(message);
			cleanupConductorAgentSessions(workerAgentSessionIds);
		} finally {
			setIsExecuting(false);
		}
		};

		const handleRunReviewTasks = async () => {
			if (!selectedTemplate) {
				setReviewError('This workspace needs at least one top-level agent before Conductor can run review.');
				return;
			}

			if (reviewReadyTasks.length === 0) {
				setReviewError('No tasks are waiting in the review lane.');
				return;
			}

			setReviewError(null);
			setIsReviewing(true);
			setConductor(groupId, { status: 'running' });

			const now = Date.now();
			const runId = `conductor-run-${generateId()}`;
			const events: ConductorRunEvent[] = [
				{
					id: `conductor-run-event-${generateId()}`,
					runId,
					groupId,
					type: 'review_started',
					message: `Review started for ${reviewReadyTasks.length} task${reviewReadyTasks.length === 1 ? '' : 's'}.`,
					createdAt: now,
				},
			];

			upsertRun({
				id: runId,
				groupId,
				kind: 'review',
				baseBranch: latestExecutionRun?.baseBranch || selectedTemplate.worktreeBranch || '',
				sshRemoteId: selectedTemplateSshRemoteId,
				agentSessionIds: [],
				taskReviewerSessionIds: {},
				integrationBranch: '',
				status: 'running',
				summary: `Reviewing ${reviewReadyTasks.length} task${reviewReadyTasks.length === 1 ? '' : 's'}.`,
				taskIds: reviewReadyTasks.map((task) => task.id),
				events,
				startedAt: now,
			});

			let reviewAgentSessionIds: string[] = [];
			try {
				let changesRequested = 0;
				const taskReviewerSessionIds: Record<string, string> = {};

				for (const task of reviewReadyTasks) {
					const latestTaskExecution = getLatestExecutionForTask(task.id);
					const reviewCwd =
						latestTaskExecution?.taskWorktreePaths?.[task.id] ||
						latestTaskExecution?.worktreePath ||
						selectedTemplate.cwd;
					const prompt = buildConductorReviewerPrompt(
						group?.name || 'Unnamed Group',
						{ ...selectedTemplate, cwd: reviewCwd },
						task
					);
					try {
						const reviewResult = await runConductorAgentTurn({
							parentSession: selectedTemplate,
							role: 'reviewer',
							taskTitle: task.title,
							taskDescription: task.description,
							scopePaths: task.scopePaths,
							prompt,
							cwd: reviewCwd,
							branch: latestTaskExecution?.taskBranches?.[task.id],
							runId,
							taskId: task.id,
							readOnlyMode: true,
							onSessionReady: (session) => {
								taskReviewerSessionIds[task.id] = session.id;
								reviewAgentSessionIds = Array.from(new Set([...reviewAgentSessionIds, session.id]));
								updateTask(task.id, {
									reviewerSessionId: session.id,
									reviewerSessionName: session.name,
								});
								updateRun(runId, {
									taskReviewerSessionIds: { ...taskReviewerSessionIds },
									agentSessionIds: [...reviewAgentSessionIds],
								});
							},
						});
						const result = parseConductorReviewerResponse(reviewResult.response);
						const reviewedAt = Date.now();

						if (result.decision === 'approved') {
							updateTask(task.id, { status: 'done' });
							events.push({
								id: `conductor-run-event-${generateId()}`,
								runId,
								groupId,
								type: 'review_passed',
								message: `Review passed for ${task.title}. ${result.summary}`,
								createdAt: reviewedAt,
							});
							continue;
						}

						changesRequested += 1;
						updateTask(task.id, { status: 'needs_input' });
						if (result.followUpTasks.length > 0) {
							setTasks((previousTasks) => [
								...previousTasks,
								...result.followUpTasks.map((followUpTask) => ({
									id: `conductor-task-${generateId()}`,
									groupId,
									parentTaskId: task.id,
									title: followUpTask.title,
									description: followUpTask.description,
									acceptanceCriteria: [],
									priority: followUpTask.priority,
									status: 'draft' as const,
									dependsOn: [],
									scopePaths: [],
									changedPaths: [],
									source: 'reviewer_followup' as const,
									createdAt: reviewedAt,
									updatedAt: reviewedAt,
								})),
							]);
						}
						events.push({
							id: `conductor-run-event-${generateId()}`,
							runId,
							groupId,
							type: 'task_needs_input',
							message:
								result.followUpTasks.length > 0
									? `Review requested changes for ${task.title}. ${result.followUpTasks.length} follow-up subtask${result.followUpTasks.length === 1 ? '' : 's'} added.`
									: `Review requested changes for ${task.title}. ${result.summary}`,
							createdAt: reviewedAt,
						});
					} catch (error) {
						if (cancelledTaskIdsRef.current.has(task.id)) {
							const cancelledAt = Date.now();
							updateTask(task.id, { status: 'cancelled' });
							events.push({
								id: `conductor-run-event-${generateId()}`,
								runId,
								groupId,
								type: 'task_cancelled',
								message: `Stopped review for ${task.title}.`,
								createdAt: cancelledAt,
							});
							continue;
						}
						throw error;
					} finally {
						cancelledTaskIdsRef.current.delete(task.id);
					}
				}

				const finishedAt = Date.now();
				updateRun(runId, {
					status: changesRequested > 0 ? 'blocked' : 'completed',
					summary:
						changesRequested > 0
							? `Review finished with ${changesRequested} task${changesRequested === 1 ? '' : 's'} requesting changes.`
							: 'Review lane approved all queued tasks.',
					endedAt: finishedAt,
					events: [...events],
				});
				setConductor(groupId, { status: changesRequested > 0 ? 'attention_required' : 'idle' });
				if (changesRequested > 0) {
					setReviewError(
						`${changesRequested} task${changesRequested === 1 ? '' : 's'} came back with requested changes.`
					);
				}
				cleanupConductorAgentSessions(reviewAgentSessionIds);
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Review failed.';
				const failedAt = Date.now();
				events.push({
					id: `conductor-run-event-${generateId()}`,
					runId,
					groupId,
					type: 'review_failed',
					message,
					createdAt: failedAt,
				});
				updateRun(runId, {
					status: 'attention_required',
					summary: message,
					endedAt: failedAt,
					events: [...events],
				});
				setConductor(groupId, { status: 'attention_required' });
				setReviewError(message);
				cleanupConductorAgentSessions(reviewAgentSessionIds);
			} finally {
				setIsReviewing(false);
			}
		};

		const handleCleanupRunArtifacts = async (run: ConductorRun) => {
			if (!selectedTemplate) {
				setIntegrationError(
					'This workspace needs at least one top-level agent before Conductor can clean up run artifacts.'
				);
				return;
			}

			const worktreePaths = collectRunArtifactPaths(run);
			const workerBranches = collectWorkerBranches(run);
			if (worktreePaths.length === 0 && workerBranches.length === 0) {
				setIntegrationError('No run artifacts were recorded for cleanup.');
				return;
			}

		setIntegrationError(null);
		setIsCleaningUp(true);

		try {
			const sshRemoteId = selectedTemplateSshRemoteId;
			const repoRootResult = await window.maestro.git.getRepoRoot(
				selectedTemplate.cwd,
				sshRemoteId
			);
			if (!repoRootResult.success || !repoRootResult.root) {
				setIntegrationError(repoRootResult.error || 'Cleanup requires a git repository.');
				return;
			}

			const repoRoot = repoRootResult.root;
			const cleanupFailures: string[] = [];
			let cleanedWorktrees = 0;
			let deletedBranches = 0;

			for (const worktreePath of worktreePaths) {
				const cleanupResult = await window.maestro.git.removeWorktree(
					worktreePath,
					true,
					sshRemoteId
				);
				if (!cleanupResult.success) {
					cleanupFailures.push(`${worktreePath}: ${cleanupResult.error || 'cleanup failed'}`);
					continue;
				}
				cleanedWorktrees += 1;
			}

			if (conductor?.deleteWorkerBranchesOnSuccess && workerBranches.length > 0) {
				for (const branchName of workerBranches) {
					const deleteResult = await window.maestro.git.deleteLocalBranch(
						repoRoot,
						branchName,
						true,
						sshRemoteId
					);
					if (!deleteResult.success) {
						cleanupFailures.push(`${branchName}: ${deleteResult.error || 'branch delete failed'}`);
						continue;
					}
					deletedBranches += 1;
				}
			}

			const finishedAt = Date.now();
			const cleanupMessageParts = [
				`Cleaned ${cleanedWorktrees} worktree${cleanedWorktrees === 1 ? '' : 's'}.`,
			];
			if (conductor?.deleteWorkerBranchesOnSuccess) {
				cleanupMessageParts.push(
					`Deleted ${deletedBranches} worker branch${deletedBranches === 1 ? '' : 'es'}.`
				);
			}
			if (cleanupFailures.length > 0) {
				cleanupMessageParts.push(
					`${cleanupFailures.length} cleanup issue${cleanupFailures.length === 1 ? '' : 's'} need attention.`
				);
			}

			updateRun(run.id, {
				status: cleanupFailures.length === 0 ? run.status : 'attention_required',
				events: [
					...run.events,
					{
						id: `conductor-run-event-${generateId()}`,
						runId: run.id,
						groupId,
						type: 'cleanup_completed',
						message: cleanupMessageParts.join(' '),
						createdAt: finishedAt,
					},
				],
			});

			if (cleanupFailures.length > 0) {
				setIntegrationError(cleanupFailures.join('\n'));
			}
		} finally {
			setIsCleaningUp(false);
		}
	};

	const handleIntegrateCompletedWork = async () => {
		if (!selectedTemplate || !latestExecutionRun?.taskBranches) {
			setIntegrationError('Run an execution lane before starting integration.');
			return;
		}

		const completedTaskIds = latestExecutionRun.taskIds.filter(
			(taskId) => tasks.find((task) => task.id === taskId)?.status === 'done'
		);
		const completedBranches = completedTaskIds
			.map((taskId) => latestExecutionRun.taskBranches?.[taskId])
			.filter((branch): branch is string => Boolean(branch));

		if (completedBranches.length === 0) {
			setIntegrationError('No completed worker branches are available to integrate.');
			return;
		}

		const sshRemoteId =
			selectedTemplate.sessionSshRemoteConfig?.enabled &&
			selectedTemplate.sessionSshRemoteConfig.remoteId
				? selectedTemplate.sessionSshRemoteConfig.remoteId
				: undefined;
		const repoRootResult = await window.maestro.git.getRepoRoot(selectedTemplate.cwd, sshRemoteId);
		if (!repoRootResult.success || !repoRootResult.root) {
			setIntegrationError(repoRootResult.error || 'Integration requires a git repository.');
			return;
		}

		setIntegrationError(null);
		setIsIntegrating(true);
		setConductor(groupId, { status: 'integrating' });

		const repoRoot = repoRootResult.root;
		const integrationRunId = `conductor-run-${generateId()}`;
		const integrationTarget = buildConductorIntegrationTarget(
			repoRoot,
			group?.name || 'group',
			integrationRunId
		);
		const setupResult = await window.maestro.git.worktreeSetup(
			repoRoot,
			integrationTarget.worktreePath,
			integrationTarget.branchName,
			sshRemoteId
		);
		if (!setupResult.success) {
			setConductor(groupId, { status: 'attention_required' });
			setIsIntegrating(false);
			setIntegrationError(setupResult.error || 'Failed to create integration worktree.');
			return;
		}

		const startedAt = Date.now();
		const events: ConductorRunEvent[] = [
			{
				id: `conductor-run-event-${generateId()}`,
				runId: integrationRunId,
				groupId,
				type: 'integration_started',
				message: `Integration started for ${completedBranches.length} completed worker branch${completedBranches.length === 1 ? '' : 'es'}.`,
				createdAt: startedAt,
			},
		];

		upsertRun({
			id: integrationRunId,
			groupId,
			kind: 'integration',
			baseBranch: latestExecutionRun.baseBranch,
			sshRemoteId,
			branchName: integrationTarget.branchName,
			workerBranches: [...completedBranches],
			taskBranches: latestExecutionRun.taskBranches,
			integrationBranch: integrationTarget.branchName,
			worktreePath: integrationTarget.worktreePath,
			worktreePaths: [integrationTarget.worktreePath],
			taskWorktreePaths: latestExecutionRun.taskWorktreePaths,
			status: 'integrating',
			summary: `Integrating ${completedBranches.length} completed worker branch${completedBranches.length === 1 ? '' : 'es'}.`,
			taskIds: completedTaskIds,
			events,
			startedAt,
		});

		try {
			for (const taskId of completedTaskIds) {
				const branchName = latestExecutionRun.taskBranches[taskId];
				if (!branchName) {
					continue;
				}

				const mergeResult = await window.maestro.git.mergeBranchIntoWorktree(
					integrationTarget.worktreePath,
					branchName,
					sshRemoteId
				);
				const eventTime = Date.now();

				if (!mergeResult.success) {
					events.push({
						id: `conductor-run-event-${generateId()}`,
						runId: integrationRunId,
						groupId,
						type: 'integration_conflict',
						message: mergeResult.conflicted
							? `Merge conflict while integrating ${branchName}.`
							: `Failed to integrate ${branchName}. ${mergeResult.error || ''}`.trim(),
						createdAt: eventTime,
					});
					updateRun(integrationRunId, {
						status: 'attention_required',
						summary: mergeResult.conflicted
							? `Integration stopped on a merge conflict in ${branchName}.`
							: mergeResult.error || `Failed to integrate ${branchName}.`,
						endedAt: eventTime,
						events: [...events],
					});
					setConductor(groupId, { status: 'attention_required' });
					setIntegrationError(
						mergeResult.conflicted
							? `Merge conflict in ${branchName}. Inspect ${integrationTarget.worktreePath}.`
							: mergeResult.error || `Failed to integrate ${branchName}.`
					);
					return;
				}

				events.push({
					id: `conductor-run-event-${generateId()}`,
					runId: integrationRunId,
					groupId,
					type: 'branch_merged',
					message: `Merged ${branchName} into ${integrationTarget.branchName}.`,
					createdAt: eventTime,
				});
				updateRun(integrationRunId, { events: [...events] });
			}

			if (validationCommand.trim()) {
				const validationStartedAt = Date.now();
				events.push({
					id: `conductor-run-event-${generateId()}`,
					runId: integrationRunId,
					groupId,
					type: 'validation_started',
					message: `Validation started: ${validationCommand.trim()}`,
					createdAt: validationStartedAt,
				});
				updateRun(integrationRunId, { events: [...events] });

				const validationResult = await window.maestro.process.runCommand({
					sessionId: `conductor-validation-${integrationRunId}`,
					command: validationCommand.trim(),
					cwd: integrationTarget.worktreePath,
					sessionSshRemoteConfig: selectedTemplate.sessionSshRemoteConfig,
				});

				if (validationResult.exitCode !== 0) {
					const failedAt = Date.now();
					events.push({
						id: `conductor-run-event-${generateId()}`,
						runId: integrationRunId,
						groupId,
						type: 'validation_failed',
						message: `Validation failed: ${validationCommand.trim()}`,
						createdAt: failedAt,
					});
					updateRun(integrationRunId, {
						status: 'attention_required',
						summary: `Validation failed for integration branch ${integrationTarget.branchName}.`,
						endedAt: failedAt,
						events: [...events],
					});
					setConductor(groupId, { status: 'attention_required' });
					setIntegrationError(
						(validationResult.stderr || validationResult.stdout || '').trim() ||
							`Validation failed: ${validationCommand.trim()}`
					);
					return;
				}

				events.push({
					id: `conductor-run-event-${generateId()}`,
					runId: integrationRunId,
					groupId,
					type: 'validation_passed',
					message: `Validation passed: ${validationCommand.trim()}`,
					createdAt: Date.now(),
				});
				updateRun(integrationRunId, { events: [...events] });
			}

			const workerPathsToClean = Object.values(latestExecutionRun.taskWorktreePaths || {});
			const uniqueWorkerPaths = [...new Set(workerPathsToClean.filter(Boolean))];
			const cleanupFailures: string[] = [];
			for (const worktreePath of uniqueWorkerPaths) {
				const cleanupResult = await window.maestro.git.removeWorktree(
					worktreePath,
					true,
					sshRemoteId
				);
				if (!cleanupResult.success) {
					cleanupFailures.push(`${worktreePath}: ${cleanupResult.error || 'cleanup failed'}`);
				}
			}
			let deletedBranches = 0;
			if (conductor?.deleteWorkerBranchesOnSuccess) {
				for (const branchName of completedBranches) {
					const deleteResult = await window.maestro.git.deleteLocalBranch(
						repoRoot,
						branchName,
						true,
						sshRemoteId
					);
					if (!deleteResult.success) {
						cleanupFailures.push(`${branchName}: ${deleteResult.error || 'branch delete failed'}`);
						continue;
					}
					deletedBranches += 1;
				}
			}
			events.push({
				id: `conductor-run-event-${generateId()}`,
				runId: integrationRunId,
				groupId,
				type: 'cleanup_completed',
				message:
					cleanupFailures.length === 0
						? `Cleaned up ${uniqueWorkerPaths.length} worker worktree${uniqueWorkerPaths.length === 1 ? '' : 's'}${conductor?.deleteWorkerBranchesOnSuccess ? ` and deleted ${deletedBranches} worker branch${deletedBranches === 1 ? '' : 'es'}` : ''}.`
						: `Cleanup finished with ${cleanupFailures.length} issue${cleanupFailures.length === 1 ? '' : 's'}.`,
				createdAt: Date.now(),
			});

			const endedAt = Date.now();
			events.push({
				id: `conductor-run-event-${generateId()}`,
				runId: integrationRunId,
				groupId,
				type: 'integration_completed',
				message: `Integration completed in ${integrationTarget.branchName}.`,
				createdAt: endedAt,
			});
			updateRun(integrationRunId, {
				status: cleanupFailures.length === 0 ? 'completed' : 'attention_required',
				summary:
					cleanupFailures.length === 0
						? `Integration branch ready: ${integrationTarget.branchName}.`
						: `Integration branch ready, but worker cleanup needs attention.`,
				endedAt,
				events: [...events],
			});
			setConductor(groupId, {
				status: cleanupFailures.length === 0 ? 'idle' : 'attention_required',
			});
			if (cleanupFailures.length > 0) {
				setIntegrationError(cleanupFailures.join('\n'));
			}
		} finally {
			setIsIntegrating(false);
		}
	};

	const handleResolveIntegrationConflict = async () => {
		if (!selectedTemplate || !latestIntegrationRun?.worktreePath) {
			setIntegrationError('No conflicted integration worktree is available to resolve.');
			return;
		}

		setIsResolvingConflict(true);
		setIntegrationError(null);

		try {
			const integrationBranch =
				latestIntegrationRun.integrationBranch || latestIntegrationRun.branchName || 'integration';
			const prompt = buildConductorConflictResolutionPrompt({
				groupName: group?.name || 'current group',
				integrationBranch,
				baseBranch: latestIntegrationRun.baseBranch,
				worktreePath: latestIntegrationRun.worktreePath,
				validationCommand,
			});

			await runConductorAgentTurn({
				parentSession: selectedTemplate,
				role: 'worker',
				taskTitle: 'Resolve integration merge conflict',
				taskDescription: `Resolve merge conflict in ${integrationBranch}`,
				scopePaths: [],
				prompt,
				cwd: latestIntegrationRun.worktreePath,
				branch: integrationBranch,
				runId: latestIntegrationRun.id,
				onSessionReady: (session) => {
					setSelectedConductorSessionId(session.id);
					updateRun(latestIntegrationRun.id, {
						agentSessionIds: Array.from(
							new Set([...(latestIntegrationRun.agentSessionIds || []), session.id])
						),
					});
				},
			});

			notifyToast({
				type: 'success',
				title: 'Conflict Resolver Finished',
				message:
					'Conductor opened a helper in the integration worktree. Review the result or rerun integration if more merges remain.',
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Conductor could not resolve the merge conflict.';
			setIntegrationError(message);
			notifyToast({
				type: 'error',
				title: 'Conflict Resolution Failed',
				message,
			});
		} finally {
			setIsResolvingConflict(false);
		}
	};

	const handleCreateIntegrationPr = async () => {
		if (!latestIntegrationRun?.worktreePath || !latestIntegrationRun.baseBranch) {
			setIntegrationError('No completed integration branch is available to publish.');
			return;
		}

		setIsCreatingPr(true);
		try {
			const ghStatus = await window.maestro.git.checkGhCli(undefined, selectedTemplateSshRemoteId);
			if (!ghStatus.installed || !ghStatus.authenticated) {
				setIntegrationError(
					selectedTemplateSshRemoteId
						? 'GitHub CLI is not installed or authenticated on the remote host.'
						: 'GitHub CLI is not installed or authenticated.'
				);
				return;
			}

			const title = `${group?.name || 'Conductor'} integration`;
			const body = [
				`This PR was prepared by Conductor for the ${group?.name || 'current'} group.`,
				'',
				`Integration branch: \`${latestIntegrationRun.integrationBranch || latestIntegrationRun.branchName}\``,
				`Base branch: \`${latestIntegrationRun.baseBranch}\``,
			].join('\n');
			const prResult = await window.maestro.git.createPR(
				latestIntegrationRun.worktreePath,
				latestIntegrationRun.baseBranch,
				title,
				body,
				undefined,
				selectedTemplateSshRemoteId
			);

			if (!prResult.success || !prResult.prUrl) {
				setIntegrationError(prResult.error || 'Failed to create PR.');
				return;
			}

			updateRun(latestIntegrationRun.id, {
				prUrl: prResult.prUrl,
				events: [
					...latestIntegrationRun.events,
					{
						id: `conductor-run-event-${generateId()}`,
						runId: latestIntegrationRun.id,
						groupId,
						type: 'pr_created',
						message: `Created PR: ${prResult.prUrl}`,
						createdAt: Date.now(),
					},
				],
			});
			setIntegrationError(null);
		} finally {
			setIsCreatingPr(false);
		}
	};

	const approvePlanningRun = (runId: string): boolean => {
		const run = runs.find((candidate) => candidate.id === runId);
		if (!run) {
			return false;
		}
		const approvedAt = Date.now();
		setTasks((previousTasks) =>
			previousTasks.map((task) =>
				task.groupId === groupId && task.source === 'planner' && task.status === 'draft'
					? { ...task, status: 'ready', updatedAt: approvedAt }
					: task
			)
		);
		updateRun(run.id, {
			status: 'completed',
			approvedAt,
			endedAt: approvedAt,
			events: [
				...run.events,
				{
					id: `conductor-run-event-${generateId()}`,
					runId: run.id,
					groupId,
					type: 'plan_approved',
					message: 'Operator approved the plan. Planner tasks are now ready for execution.',
					createdAt: approvedAt,
				},
			],
		});
		setConductor(groupId, { status: 'idle' });
		cleanupConductorAgentSessions(run.agentSessionIds || []);
		return true;
	};

	const handleApprovePlan = () => {
		if (!pendingRun) {
			return;
		}

		approvePlanningRun(pendingRun.id);
	};

	const handleStopTask = async (task: ConductorTask) => {
		const sessionId = getActiveTaskSessionId(task);
		if (!sessionId) {
			notifyToast({
				type: 'warning',
				title: 'Nothing To Stop',
				message: `${task.title} does not have an active Conductor helper right now.`,
			});
			return;
		}

		cancelledTaskIdsRef.current.add(task.id);
		updateTask(task.id, { status: 'cancelled' });

		let stopped = false;
		for (const processSessionId of getTaskProcessSessionIds(sessionId)) {
			try {
				const killed = await window.maestro.process.kill(processSessionId);
				if (killed) {
					stopped = true;
					break;
				}
			} catch {
				// Fall through to the next known process identifier.
			}
		}

		const latestRunForTask = getLatestRunForTask(task.id);
		if (latestRunForTask) {
			updateRun(latestRunForTask.id, {
				events: [
					...latestRunForTask.events,
					{
						id: `conductor-run-event-${generateId()}`,
						runId: latestRunForTask.id,
						groupId,
						type: 'task_cancelled',
						message: `Manager stopped ${task.title}.`,
						createdAt: Date.now(),
					},
				],
			});
		}

		notifyToast({
			type: stopped ? 'success' : 'warning',
			title: stopped ? 'Task Stopped' : 'Stop Requested',
			message: stopped
				? `${task.title} has been stopped.`
				: `Marked ${task.title} as stopped, but the helper did not confirm the kill.`,
		});
	};

	const tabButtonClass =
		'px-4 py-2 rounded-lg text-sm font-medium transition-colors border border-transparent';
	const latestIntegrationIsRemote = Boolean(latestIntegrationRun?.sshRemoteId);
	const hasReviewWork = isReviewing || reviewReadyTasks.length > 0;
	const hasIntegrationResults = isIntegrating || integrationReadyTaskIds.length > 0;
	const latestIntegrationHasConflict = hasOutstandingIntegrationConflict(latestIntegrationRun);
	const showResolveConflictAction =
		isResolvingConflict ||
		Boolean(latestIntegrationRun?.worktreePath && latestIntegrationHasConflict && selectedTemplate);
	const showCreatePrAction =
		Boolean(latestIntegrationRun?.worktreePath) &&
		conductor?.publishPolicy !== 'none' &&
		!latestIntegrationRun?.prUrl &&
		!latestIntegrationHasConflict;
	const latestIntegrationPrUrl = latestIntegrationRun?.prUrl || null;
	const showViewPrAction = Boolean(latestIntegrationPrUrl);

	return (
		<div
			className="flex-1 min-w-0 min-h-0 flex flex-col"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			<div
				className="px-6 py-5 flex items-start justify-between gap-6"
				style={{
					...getGlassPanelStyle(theme, {
						tint: 'rgba(255, 255, 255, 0.12)',
						borderColor: 'rgba(255, 255, 255, 0.08)',
						strong: true,
					}),
					borderLeft: 'none',
					borderRight: 'none',
					borderTop: 'none',
					borderRadius: 0,
				}}
			>
				<div>
					<div
						className="text-xs uppercase tracking-[0.18em]"
						style={{ color: theme.colors.textDim }}
					>
						Conductor
					</div>
					<h1 className="text-2xl font-semibold mt-2" style={{ color: theme.colors.textMain }}>
						{group ? `${group.emoji} ${group.name}` : 'Unknown Group'}
					</h1>
					</div>
				<div className="flex items-center gap-3">
					<button
						onClick={() => setIsSettingsOpen(true)}
						className="p-2 rounded-lg border"
						style={{ ...getGlassButtonStyle(theme), color: theme.colors.textMain }}
						aria-label="Open Conductor settings"
						title="Conductor settings"
					>
						<Settings2 className="w-4 h-4" />
					</button>
					<button
						onClick={() => {
							setActiveTab('overview');
							setIsPlanComposerOpen(true);
						}}
						className="px-4 py-2 rounded-lg text-sm font-medium"
						style={getGlassButtonStyle(theme, { accent: true })}
					>
						+ New plan
					</button>
					<div
						className="px-3 py-2 rounded-lg border text-xs font-semibold uppercase"
						style={getGlassPillStyle(theme, 'accent')}
					>
						{formatConductorStatusLabel(displayConductorStatus)}
					</div>
				</div>
			</div>

			<div className="px-6 pt-4">
				<div
					className="inline-flex items-center gap-1 rounded-xl border p-1"
					style={getGlassPanelStyle(theme, {
						tint: 'rgba(255, 255, 255, 0.10)',
						borderColor: 'rgba(255, 255, 255, 0.08)',
					})}
				>
					{(['overview', 'history'] as ConductorTab[]).map((tab) => (
						<button
							key={tab}
							onClick={() => setActiveTab(tab)}
							className={tabButtonClass}
							style={{
								...getGlassButtonStyle(theme, { active: activeTab === tab }),
								background:
									activeTab === tab
										? `linear-gradient(180deg, ${theme.colors.accent}16 0%, rgba(255,255,255,0.07) 100%)`
										: 'transparent',
								borderColor: activeTab === tab ? `${theme.colors.accent}26` : 'transparent',
								boxShadow:
									activeTab === tab
										? `inset 0 -2px 0 0 ${theme.colors.accent}, 0 10px 22px rgba(15, 23, 42, 0.08)`
										: 'none',
							}}
						>
							{tab === 'overview' ? 'Home' : 'Runs'}
						</button>
					))}
				</div>
			</div>

			<div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 scrollbar-thin">
				{!selectedTemplate && (
					<div
						className="rounded-xl border p-5 mb-5"
						style={{
							...getGlassPanelStyle(theme, {
								tint: `${theme.colors.warning}12`,
								borderColor: `${theme.colors.warning}38`,
								strong: true,
							}),
						}}
					>
						<div className="flex items-start gap-3">
							<ShieldAlert className="w-5 h-5 mt-0.5" style={{ color: theme.colors.warning }} />
							<div className="flex-1">
								<div className="font-semibold" style={{ color: theme.colors.textMain }}>
									Add a workspace agent to get Conductor moving
								</div>
								<p className="text-sm mt-1 mb-4" style={{ color: theme.colors.textDim }}>
									Conductor follows this workspace’s primary top-level agent automatically. Once
									the workspace has an agent, it will copy that agent’s repo, tools, model
									settings, and env vars whenever it spins up helpers.
								</p>
								<div className="text-sm" style={{ color: theme.colors.textDim }}>
									Create or move at least one top-level AI agent into this workspace, then return
									here and Conductor will use it automatically.
								</div>
							</div>
						</div>
					</div>
				)}

				{selectedTemplate && (gitReadiness === 'missing_repo' || gitReadiness === 'missing_commit') && (
					<div
						className="rounded-xl border p-5 mb-5"
						style={{
							...getGlassPanelStyle(theme, {
								tint: `${theme.colors.warning}12`,
								borderColor: `${theme.colors.warning}38`,
								strong: true,
							}),
						}}
					>
						<div className="flex items-start gap-3">
							<ShieldAlert className="w-5 h-5 mt-0.5" style={{ color: theme.colors.warning }} />
							<div className="flex-1 min-w-0">
								<div className="font-semibold" style={{ color: theme.colors.textMain }}>
									{gitReadiness === 'missing_repo'
										? 'This workspace needs a git repo before Conductor can work'
										: 'This workspace needs an initial commit before Conductor can branch'}
								</div>
								<p className="text-sm mt-1 mb-4 leading-6" style={{ color: theme.colors.textDim }}>
									{gitReadiness === 'missing_repo'
										? 'Conductor uses git branches and worktrees to spin up worker agents safely. Initialize a repo here and create the first commit so it has something stable to branch from.'
										: 'The repo exists, but it still needs a first commit. Conductor uses that initial commit as the base for worker branches and worktrees.'}
								</p>
								<div className="flex flex-wrap items-center gap-3">
									<button
										onClick={() => void handleBootstrapGitRepo()}
										disabled={isBootstrappingGit}
										className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
										style={getGlassButtonStyle(theme, { accent: true })}
									>
										{isBootstrappingGit ? (
											<Loader2 className="w-4 h-4 animate-spin" />
										) : (
											<FolderKanban className="w-4 h-4" />
										)}
										{isBootstrappingGit
											? 'Preparing git...'
											: gitReadiness === 'missing_repo'
												? 'Initialize repo and first commit'
												: 'Create the first commit'}
									</button>
									<div className="text-xs" style={{ color: theme.colors.textDim }}>
										Lead agent path: {selectedTemplate.cwd}
									</div>
								</div>
								{gitBootstrapError && (
									<div
										className="rounded-lg border p-3 text-sm mt-4"
										style={{
											...getGlassPanelStyle(theme, {
												tint: `${theme.colors.warning}12`,
												borderColor: `${theme.colors.warning}35`,
											}),
											color: theme.colors.warning,
										}}
									>
										{gitBootstrapError}
									</div>
								)}
							</div>
						</div>
					</div>
				)}

				{selectedTemplate &&
					gitReadiness === 'ready' &&
					dependencyReadyTaskIds.length > 0 &&
					!resourceGate.allowed && (
						<div
							className="rounded-xl border p-5 mb-5"
							style={{
								...getGlassPanelStyle(theme, {
									tint: `${theme.colors.warning}12`,
									borderColor: `${theme.colors.warning}38`,
									strong: true,
								}),
							}}
						>
							<div className="flex items-start gap-3">
								<ShieldAlert className="w-5 h-5 mt-0.5" style={{ color: theme.colors.warning }} />
								<div className="flex-1 min-w-0">
									<div className="font-semibold" style={{ color: theme.colors.textMain }}>
										Conductor is holding ready work until this machine settles
									</div>
									<p className="text-sm mt-1 leading-6" style={{ color: theme.colors.textDim }}>
										{resourceGate.message ||
											'Ready tasks are queued, but the current system load or memory headroom is below the launch threshold.'}
									</p>
								</div>
							</div>
						</div>
					)}

				{activeTab === 'overview' && (
					<div className="space-y-5">
						{overviewPills.length > 0 && (
							<div className="flex flex-wrap items-center gap-2">
								{overviewPills.map((pill) => (
									<div
										key={pill.label}
										className="flex items-center gap-2 px-3 py-2 rounded-xl"
										style={{
											backgroundColor: `${pill.color}10`,
											border: `1px solid ${pill.color}25`,
										}}
									>
										<div
											className="flex items-center justify-center w-6 h-6 rounded-lg"
											style={{
												backgroundColor: `${pill.color}18`,
												color: pill.color,
											}}
										>
											{pill.icon}
										</div>
										<span className="text-lg font-semibold" style={{ color: pill.color }}>
											{pill.value}
										</span>
										<span className="text-xs" style={{ color: theme.colors.textDim }}>
											{pill.label}
										</span>
									</div>
								))}
							</div>
						)}

						{/* Action toolbar */}
						<div className="flex flex-wrap items-center gap-1.5">
							{pendingRun && (
								<button
									onClick={handleApprovePlan}
									className="px-3 py-1.5 rounded-lg text-xs font-medium"
									style={getGlassButtonStyle(theme, { accent: true })}
								>
									Approve plan
								</button>
							)}
							<button
								onClick={handleRunReadyTasks}
								disabled={isExecuting || dependencyReadyTaskIds.length === 0 || !!pendingRun}
								className="px-3 py-1.5 rounded-lg text-xs disabled:opacity-40 inline-flex items-center gap-1.5"
								style={getGlassButtonStyle(theme)}
							>
								{isExecuting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
								{isExecuting ? 'Running...' : 'Run'}
							</button>
							{hasReviewWork && (
								<button
									onClick={handleRunReviewTasks}
									disabled={isReviewing}
									className="px-3 py-1.5 rounded-lg text-xs disabled:opacity-40 inline-flex items-center gap-1.5"
									style={getGlassButtonStyle(theme)}
								>
									{isReviewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
									{isReviewing ? 'Reviewing...' : 'QA'}
								</button>
							)}
							{hasIntegrationResults && (
								<button
									onClick={handleIntegrateCompletedWork}
									disabled={isIntegrating}
									className="px-3 py-1.5 rounded-lg text-xs disabled:opacity-40 inline-flex items-center gap-1.5"
									style={getGlassButtonStyle(theme)}
								>
									{isIntegrating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderKanban className="w-3.5 h-3.5" />}
									{isIntegrating ? 'Integrating...' : 'Integrate'}
								</button>
							)}
							{showResolveConflictAction && (
								<button
									onClick={handleResolveIntegrationConflict}
									disabled={isResolvingConflict}
									className="px-3 py-1.5 rounded-lg text-xs disabled:opacity-40 inline-flex items-center gap-1.5"
									style={getGlassButtonStyle(theme)}
								>
									{isResolvingConflict ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldAlert className="w-3.5 h-3.5" />}
									{isResolvingConflict ? 'Resolving...' : 'Resolve conflict'}
								</button>
							)}
							{showCreatePrAction && (
								<button
									onClick={handleCreateIntegrationPr}
									disabled={isCreatingPr || latestIntegrationRun?.status === 'integrating'}
									className="px-3 py-1.5 rounded-lg text-xs disabled:opacity-40 inline-flex items-center gap-1.5"
									style={getGlassButtonStyle(theme)}
								>
									{isCreatingPr ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
									{isCreatingPr ? 'Creating...' : 'PR'}
								</button>
							)}
								{showViewPrAction && latestIntegrationPrUrl && (
									<button
										onClick={() => void window.maestro.shell.openExternal(latestIntegrationPrUrl)}
										className="px-3 py-1.5 rounded-lg text-xs inline-flex items-center gap-1.5"
										style={getGlassButtonStyle(theme)}
									>
									<ExternalLink className="w-3.5 h-3.5" />
									View PR
								</button>
							)}
							{advancedMode && latestIntegrationRun?.worktreePath && (
								<button
									onClick={() => latestIntegrationIsRemote ? void handleCopyRemotePath(latestIntegrationRun.worktreePath!) : void window.maestro.shell.openPath(latestIntegrationRun.worktreePath!)}
									className="px-3 py-1.5 rounded-lg text-xs inline-flex items-center gap-1.5"
									style={getGlassButtonStyle(theme)}
								>
									{latestIntegrationIsRemote ? <Copy className="w-3.5 h-3.5" /> : <FolderOpen className="w-3.5 h-3.5" />}
									{latestIntegrationIsRemote ? 'Copy path' : 'Open folder'}
								</button>
							)}
							{advancedMode && (
								<button
									onClick={() => void handleCleanupRunArtifacts(latestIntegrationRun || latestExecutionRun || latestRun!)}
									disabled={isCleaningUp || (!latestIntegrationRun && !latestExecutionRun && !latestRun) || (latestIntegrationRun ? collectRunArtifactPaths(latestIntegrationRun).length === 0 : latestExecutionRun ? collectRunArtifactPaths(latestExecutionRun).length === 0 : collectRunArtifactPaths(latestRun).length === 0)}
									className="px-3 py-1.5 rounded-lg text-xs disabled:opacity-40 inline-flex items-center gap-1.5"
									style={getGlassButtonStyle(theme)}
								>
									{isCleaningUp ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
									Clean up
								</button>
							)}
							<button
								onClick={handleCleanupIdleConductorAgents}
								disabled={Boolean(conductor?.keepConductorAgentSessions) || conductorAgentSessions.every((s) => s.state === 'busy')}
								className="px-3 py-1.5 rounded-lg text-xs disabled:opacity-40 inline-flex items-center gap-1.5"
								style={getGlassButtonStyle(theme)}
							>
								<Trash2 className="w-3.5 h-3.5" />
								Tidy agents
							</button>
						</div>

						{/* Errors */}
						{(executionError || reviewError || integrationError) && (
							<div
								className="rounded-lg px-3 py-2 text-xs"
								style={{ backgroundColor: `${theme.colors.warning}12`, border: `1px solid ${theme.colors.warning}28`, color: theme.colors.warning }}
							>
								{executionError || reviewError || integrationError}
							</div>
						)}

						{/* Activity feed */}
						<div
							className="rounded-xl overflow-hidden"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								border: '1px solid rgba(255,255,255,0.08)',
								boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
							}}
						>
							<div
								className="flex items-center justify-between px-4 py-2.5"
								style={{
									borderBottom: '1px solid rgba(255,255,255,0.06)',
									backgroundColor: 'rgba(255,255,255,0.03)',
								}}
							>
								<div className="flex items-center gap-2">
									<Activity className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									<span className="text-xs font-semibold uppercase tracking-wider" style={{ color: theme.colors.textDim }}>
										Activity
									</span>
								</div>
								{latestPlanningRun?.summary && (
									<span className="text-[11px] truncate max-w-[50%]" style={{ color: theme.colors.textDim }}>
										Plan: {latestPlanningRun.summary}
									</span>
								)}
							</div>
							<div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
								{recentEvents.length ? (
									recentEvents.map(({ event, runKind }) => {
										const tone = getConductorEventTone(event.type);
										const toneColor =
											tone === 'success' ? theme.colors.success
												: tone === 'warning' ? theme.colors.warning
													: tone === 'accent' ? theme.colors.accent
														: theme.colors.textDim;
										return (
											<div key={event.id} className="flex items-start gap-3 px-4 py-2.5">
												<div
													className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
													style={{ backgroundColor: toneColor }}
												/>
												<div className="min-w-0 flex-1">
													<div className="text-sm leading-snug" style={{ color: theme.colors.textMain }}>
														{event.message}
													</div>
													<div className="text-[11px] mt-0.5" style={{ color: theme.colors.textDim }}>
														{formatLabel(runKind)} · {formatTimestamp(event.createdAt)}
													</div>
												</div>
											</div>
										);
									})
								) : (
									<div className="px-4 py-4 text-xs" style={{ color: theme.colors.textDim }}>
										No activity yet.
									</div>
								)}
							</div>
						</div>

						{/* Team members - compact inline */}
						{sortedConductorAgentSessions.length > 0 && (
							<div
								className="rounded-xl overflow-hidden"
								style={{
									backgroundColor: theme.colors.bgSidebar,
									border: '1px solid rgba(255,255,255,0.08)',
									boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
								}}
							>
								<div
									className="flex items-center justify-between px-4 py-2.5"
									style={{
										borderBottom: '1px solid rgba(255,255,255,0.06)',
										backgroundColor: 'rgba(255,255,255,0.03)',
									}}
								>
									<div className="flex items-center gap-2">
										<Users className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										<span className="text-xs font-semibold uppercase tracking-wider" style={{ color: theme.colors.textDim }}>
											Team
										</span>
									</div>
									<div className="flex items-center gap-2 text-[11px]" style={{ color: theme.colors.textDim }}>
										<span style={{ color: theme.colors.accent }}>{activeConductorAgentSessions.length} active</span>
										<span>· {conductorAgentSessions.length} total</span>
									</div>
								</div>
								<div className="p-2 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
									{sortedConductorAgentSessions.map((session) => (
										<button
											key={session.id}
											type="button"
											onClick={() => handleOpenAgentSession(session.id)}
											className="rounded-lg p-3 text-left transition-colors hover:bg-white/5 flex items-start gap-3"
											style={{
												backgroundColor: session.state === 'busy' ? `${theme.colors.accent}06` : 'transparent',
												border: `1px solid ${session.state === 'busy' ? `${theme.colors.accent}20` : 'rgba(255,255,255,0.06)'}`,
											}}
										>
											<div
												className="w-2 h-2 rounded-full mt-1.5 shrink-0"
												style={{
													backgroundColor: session.state === 'busy' ? theme.colors.accent : theme.colors.textDim,
												}}
											/>
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-2">
													<span
														className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
														style={getGlassPillStyle(theme, session.state === 'busy' ? 'accent' : 'default')}
													>
														{formatConductorRoleLabel(session.conductorMetadata?.role || 'worker')}
													</span>
													<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
														{getProviderDisplayName(session.toolType)}
													</span>
												</div>
												<div className="text-sm font-medium mt-1 truncate" style={{ color: theme.colors.textMain }}>
													{session.name}
												</div>
												{session.conductorMetadata?.taskTitle && (
													<div className="text-xs mt-0.5 truncate" style={{ color: theme.colors.textDim }}>
														{session.conductorMetadata.taskTitle}
													</div>
												)}
											</div>
										</button>
									))}
								</div>
							</div>
						)}

						{/* Kanban / Task board - inline */}
						<div className="space-y-5">
						{pendingRun && (
							<div
								className="rounded-xl border p-5"
								style={{
									...getGlassPanelStyle(theme, {
										tint: `${theme.colors.accent}12`,
										borderColor: `${theme.colors.accent}35`,
										strong: true,
									}),
								}}
							>
								<div className="flex items-start justify-between gap-4">
									<div>
										<div
											className="flex items-center gap-2"
											style={{ color: theme.colors.textMain }}
										>
											<CheckCircle2 className="w-4 h-4" />
											<h2 className="font-semibold">Give this plan a quick okay</h2>
										</div>
										<p className="text-sm mt-2" style={{ color: theme.colors.textDim }}>
											Check that the breakdown looks sane. Once you approve it, Conductor can start
											working through the approved items.
										</p>
										{pendingRun.summary && (
											<div
												className="rounded-lg border p-3 text-sm mt-4"
												style={{ ...getGlassPanelStyle(theme), color: theme.colors.textMain }}
											>
												{pendingRun.summary}
											</div>
										)}
									</div>
									<button
										onClick={handleApprovePlan}
										className="px-4 py-2 rounded-lg text-sm font-medium"
										style={getGlassButtonStyle(theme, { accent: true })}
									>
										Approve this plan
									</button>
								</div>
							</div>
						)}

						<div className="flex justify-end">
							<div className="flex items-center gap-2">
								<button
									onClick={handleRunReadyTasks}
									disabled={isExecuting || dependencyReadyTaskIds.length === 0 || !!pendingRun}
									className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
									style={getGlassButtonStyle(theme, { accent: true })}
								>
									{isExecuting ? (
										<Loader2 className="w-4 h-4 animate-spin" />
									) : (
										<PlayCircle className="w-4 h-4" />
									)}
									{isExecuting ? 'Running...' : 'Start the run'}
								</button>
								{hasReviewWork && (
									<button
										onClick={handleRunReviewTasks}
										disabled={isReviewing}
										className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
										style={getGlassButtonStyle(theme)}
									>
										{isReviewing ? (
											<Loader2 className="w-4 h-4 animate-spin" />
										) : (
											<CheckCircle2 className="w-4 h-4" />
										)}
										{isReviewing ? 'Reviewing...' : 'Run QA'}
									</button>
								)}
								{hasIntegrationResults && (
									<button
										onClick={handleIntegrateCompletedWork}
										disabled={isIntegrating}
										className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
										style={getGlassButtonStyle(theme)}
									>
										{isIntegrating ? (
											<Loader2 className="w-4 h-4 animate-spin" />
										) : (
											<FolderKanban className="w-4 h-4" />
										)}
										{isIntegrating ? 'Integrating...' : 'Pull results together'}
									</button>
								)}
								{showResolveConflictAction && (
									<button
										onClick={handleResolveIntegrationConflict}
										disabled={isResolvingConflict}
										className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
										style={getGlassButtonStyle(theme)}
									>
										{isResolvingConflict ? (
											<Loader2 className="w-4 h-4 animate-spin" />
										) : (
											<ShieldAlert className="w-4 h-4" />
										)}
										{isResolvingConflict ? 'Resolving...' : 'Resolve with agent'}
									</button>
								)}
								{showCreatePrAction && (
									<button
										onClick={handleCreateIntegrationPr}
										disabled={isCreatingPr || latestIntegrationRun?.status === 'integrating'}
										className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
										style={getGlassButtonStyle(theme)}
									>
										{isCreatingPr ? (
											<Loader2 className="w-4 h-4 animate-spin" />
										) : (
											<History className="w-4 h-4" />
										)}
										{isCreatingPr ? 'Creating PR...' : 'Open a PR'}
									</button>
								)}
									{showViewPrAction && latestIntegrationPrUrl && (
										<button
											onClick={() => void window.maestro.shell.openExternal(latestIntegrationPrUrl)}
											className="px-4 py-2 rounded-lg text-sm font-medium inline-flex items-center gap-2"
											style={getGlassButtonStyle(theme)}
										>
										<ExternalLink className="w-4 h-4" />
										View PR
									</button>
								)}
							</div>
						</div>

						<div
							className="rounded-xl border p-5"
							style={getGlassPanelStyle(theme, {
								tint: 'rgba(255,255,255,0.10)',
								borderColor: 'rgba(255,255,255,0.08)',
								strong: true,
							})}
						>
							<div className="flex flex-col gap-4">
								<div className="flex items-center justify-between gap-3">
									<div className="flex items-center gap-2" style={{ color: theme.colors.textMain }}>
										<FolderKanban className="w-4 h-4" />
										<h2 className="text-sm font-medium">Tasks</h2>
									</div>
									<div className="flex items-center gap-1.5">
										<button
											onClick={() => openTaskComposer()}
											className="px-2.5 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5"
											style={getGlassButtonStyle(theme)}
										>
											<ClipboardList className="w-3.5 h-3.5" />
											Add
										</button>
										<button
											onClick={() => setBacklogView('board')}
											className="px-2.5 py-1.5 rounded-lg text-xs inline-flex items-center gap-1.5"
											style={getGlassButtonStyle(theme, { active: backlogView === 'board' })}
										>
											<LayoutGrid className="w-3.5 h-3.5" />
											Board
										</button>
										<button
											onClick={() => setBacklogView('table')}
											className="px-2.5 py-1.5 rounded-lg text-xs inline-flex items-center gap-1.5"
											style={getGlassButtonStyle(theme, { active: backlogView === 'table' })}
										>
											<Rows3 className="w-3.5 h-3.5" />
											List
										</button>
									</div>
								</div>

								<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
									<div
										className="rounded-lg border px-3 py-2 flex items-center gap-2 xl:col-span-2"
										style={{
											...getGlassInputStyle(theme),
										}}
									>
										<Search className="w-4 h-4" style={{ color: theme.colors.textDim }} />
										<input
											value={taskSearch}
											onChange={(e) => setTaskSearch(e.target.value)}
											placeholder="Search title, description, scope, acceptance criteria"
											className="w-full bg-transparent text-sm outline-none"
											style={{ color: theme.colors.textMain }}
										/>
									</div>
									<div className="relative">
										<ListFilter
											className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
											style={{ color: theme.colors.textDim }}
										/>
										<select
											value={statusFilter}
											onChange={(e) => setStatusFilter(e.target.value as BacklogStatusFilter)}
											className="w-full rounded-lg border pl-9 pr-3 py-2 text-sm"
											style={getGlassInputStyle(theme)}
										>
											<option value="all">All statuses</option>
											{STATUS_OPTIONS.map((status) => (
												<option key={status} value={status}>
													{formatTaskStatusLabel(status)}
												</option>
											))}
										</select>
									</div>
									<div className="relative">
										<ListFilter
											className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
											style={{ color: theme.colors.textDim }}
										/>
										<select
											value={sourceFilter}
											onChange={(e) => setSourceFilter(e.target.value as BacklogSourceFilter)}
											className="w-full rounded-lg border pl-9 pr-3 py-2 text-sm"
											style={getGlassInputStyle(theme)}
										>
											<option value="all">All sources</option>
											<option value="manual">{formatTaskSourceLabel('manual')}</option>
											<option value="planner">{formatTaskSourceLabel('planner')}</option>
											<option value="worker_followup">
												{formatTaskSourceLabel('worker_followup')}
											</option>
											<option value="reviewer_followup">
												{formatTaskSourceLabel('reviewer_followup')}
											</option>
										</select>
									</div>
									<div className="relative">
										<ArrowUpDown
											className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
											style={{ color: theme.colors.textDim }}
										/>
										<select
											value={sortMode}
											onChange={(e) => setSortMode(e.target.value as BacklogSort)}
											className="w-full rounded-lg border pl-9 pr-3 py-2 text-sm"
											style={getGlassInputStyle(theme)}
										>
											<option value="priority">Sort by priority</option>
											<option value="updated_desc">Newest updates</option>
											<option value="updated_asc">Oldest updates</option>
											<option value="title">Title A-Z</option>
										</select>
									</div>
								</div>

								{/* Clickable status nav - scrolls to column */}
								<div className="flex items-center gap-1 overflow-x-auto scrollbar-thin">
									{BOARD_COLUMNS.map((status) => {
										const tone = getTaskStatusTone(theme, status);
										const count = taskCountsByStatus[status] ?? 0;
										return (
											<button
												key={status}
												type="button"
												onClick={() => scrollToColumn(status)}
												className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors hover:bg-white/5 shrink-0"
											>
												<span
													className="w-2.5 h-2.5 rounded-full shrink-0"
													style={{ backgroundColor: tone.fg }}
												/>
												<span style={{ color: theme.colors.textMain }}>
													{formatTaskStatusLabel(status)}
												</span>
												<span className="font-semibold" style={{ color: count > 0 ? tone.fg : theme.colors.textDim }}>
													{count}
												</span>
											</button>
										);
									})}
									{(statusFilter !== 'all' || sourceFilter !== 'all' || taskSearch.trim()) && (
										<button
											onClick={clearTaskFilters}
											className="px-2.5 py-1.5 rounded-lg text-xs ml-auto shrink-0"
											style={getGlassButtonStyle(theme)}
										>
											Clear filters
										</button>
									)}
								</div>

								{tasks.length === 0 ? (
									<div
										className="rounded-xl border p-8 text-center"
										style={{ ...getGlassPanelStyle(theme), color: theme.colors.textDim }}
									>
										Your wish list is empty. Add a change you want, then let Conductor turn it into
										a plan.
									</div>
								) : backlogView === 'board' ? (
									<div ref={boardScrollRef} className="overflow-x-auto pb-2 scrollbar-thin">
										<div className="flex gap-3 min-w-[1200px]">
											{BOARD_COLUMNS.map((status) => {
												const columnTasks = filteredTasks.filter((task) => task.status === status);
												const tone = getTaskStatusTone(theme, status);
												return (
													<div
														key={status}
														data-column-status={status}
														className="rounded-xl flex-1 min-w-[200px] min-h-[280px] flex flex-col overflow-hidden"
														onDragOver={(e) => {
															e.preventDefault();
														}}
														onDrop={() => {
															if (draggedTaskId) {
																handleTaskStatusMove(draggedTaskId, status);
																setDraggedTaskId(null);
															}
														}}
														style={{
															backgroundColor: theme.colors.bgSidebar,
															border: `1px solid ${tone.border}`,
															boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
														}}
													>
														{/* Colored top bar */}
														<div
															className="h-1 w-full shrink-0"
															style={{ backgroundColor: tone.fg }}
														/>
														{/* Column header */}
														<div className="flex items-center gap-2 px-3 py-2.5" style={{
															backgroundColor: `${tone.fg}08`,
															borderBottom: `1px solid ${tone.border}`,
														}}>
															<span className="text-sm font-semibold" style={{ color: tone.fg }}>
																{formatTaskStatusLabel(status)}
															</span>
															<span
																className="ml-auto text-[11px] font-medium px-1.5 py-0.5 rounded-full"
																style={{
																	backgroundColor: `${tone.fg}18`,
																	color: tone.fg,
																}}
															>
																{columnTasks.length}
															</span>
														</div>
														{/* Cards */}
														<div className="flex-1 p-2 space-y-2 overflow-y-auto scrollbar-thin">
																{columnTasks.length > 0 ? (
																	columnTasks.map((task) => {
																		const priorityTone = getTaskPriorityTone(theme, task.priority);
																		const parentTask = task.parentTaskId
																			? tasksById.get(task.parentTaskId)
																			: null;
																		const childTasks = childTasksByParentId.get(task.id) || [];
																		const canStopTask = Boolean(getActiveTaskSessionId(task));
																		return (
																		<div
																			key={task.id}
																			draggable
																			onDragStart={() => setDraggedTaskId(task.id)}
																			onDragEnd={() => setDraggedTaskId(null)}
																			onDoubleClick={() => openTaskDetails(task.id)}
																			className="rounded-lg overflow-hidden cursor-grab active:cursor-grabbing group transition-all hover:translate-y-[-1px] hover:shadow-lg"
																			title="Double-click for details"
																			style={{
																				backgroundColor: draggedTaskId === task.id
																					? `${theme.colors.accent}08`
																					: theme.colors.bgMain,
																				border: `1px solid ${draggedTaskId === task.id
																					? `${theme.colors.accent}45`
																					: 'rgba(255,255,255,0.08)'}`,
																				boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08)',
																			}}
																		>
																				<div className="p-2.5">
																				<div className="flex items-start gap-2">
																					<div className="min-w-0 flex-1">
																						{parentTask && (
																							<div
																								className="text-[11px] mb-1 truncate"
																								style={{ color: theme.colors.textDim }}
																							>
																								{parentTask.title}
																							</div>
																						)}
																						<div className="flex items-center gap-2">
																							<div
																								className="w-2 h-2 rounded-full shrink-0"
																								title={`Priority: ${formatLabel(task.priority)}`}
																								style={{ backgroundColor: priorityTone.fg }}
																							/>
																							<div
																								className="text-sm font-medium leading-tight"
																								style={{ color: theme.colors.textMain }}
																							>
																								{task.title}
																							</div>
																						</div>
																						{task.description && (
																							<p
																								className="text-xs mt-1.5 line-clamp-2 leading-relaxed"
																								style={{ color: theme.colors.textDim }}
																							>
																								{task.description}
																							</p>
																						)}
																						{getTaskAgentBadges(task).length > 0 && (
																							<div className="flex flex-wrap gap-1.5 mt-2">
																								{getTaskAgentBadges(task).map((badge) => (
																									<button
																										key={badge.key}
																										onClick={() => handleOpenAgentSession(badge.sessionId)}
																										disabled={!sessionById.has(badge.sessionId)}
																										className="px-1.5 py-0.5 rounded text-[10px] disabled:opacity-70"
																										style={getGlassPillStyle(theme, badge.tone)}
																									>
																										{badge.label}
																									</button>
																								))}
																							</div>
																						)}
																					</div>
																					<button
																						onClick={() => deleteTask(task.id)}
																						className="p-1 rounded hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
																						title="Delete task"
																						style={{ color: theme.colors.textDim }}
																					>
																						<Trash2 className="w-3.5 h-3.5" />
																					</button>
																				</div>

																				{(canStopTask || childTasks.length > 0) && (
																					<div className="flex items-center gap-1.5 mt-2 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
																						{canStopTask && (
																							<button
																								onClick={() => void handleStopTask(task)}
																								className="rounded px-1.5 py-1 text-[11px] inline-flex items-center gap-1 hover:bg-white/10"
																								style={{ color: theme.colors.textDim }}
																							>
																								<Square className="w-3 h-3" />
																								Stop
																							</button>
																						)}
																						{childTasks.length > 0 && (
																							<span className="text-[11px] ml-auto" style={{ color: theme.colors.textDim }}>
																								{childTasks.length} sub
																							</span>
																						)}
																					</div>
																				)}
																			</div>
																		</div>
																	);
																})
															) : (
																<div
																	className="rounded-lg border border-dashed p-4"
																	style={{
																		borderColor: `${tone.fg}20`,
																		minHeight: '60px',
																	}}
																/>
															)}
														</div>
													</div>
												);
											})}
										</div>
									</div>
								) : (
									<div className="overflow-x-auto pb-2 scrollbar-thin">
										<div
											className="rounded-xl border overflow-hidden min-w-[1132px]"
											style={getGlassPanelStyle(theme, {
												tint: 'rgba(255,255,255,0.10)',
												borderColor: 'rgba(255,255,255,0.08)',
											})}
										>
											<div
												className="grid gap-3 px-4 py-3 text-xs uppercase tracking-wide border-b"
												style={{
													gridTemplateColumns:
														'minmax(260px,2fr) 110px 110px 140px 100px 120px 120px 72px',
													borderColor: theme.colors.border,
													color: theme.colors.textDim,
												}}
											>
												<div>Task</div>
												<div>Status</div>
												<div>Priority</div>
												<div>Source</div>
												<div>Deps</div>
												<div>Scope</div>
												<div>Updated</div>
												<div />
											</div>
											<div className="divide-y" style={{ borderColor: theme.colors.border }}>
													{filteredTasks.length > 0 ? (
														filteredTasks.map((task) => {
															const statusTone = getTaskStatusTone(theme, task.status);
															const priorityTone = getTaskPriorityTone(theme, task.priority);
															const parentTask = task.parentTaskId
																? tasksById.get(task.parentTaskId)
																: null;
															const childTasks = childTasksByParentId.get(task.id) || [];
															const canStopTask = Boolean(getActiveTaskSessionId(task));
															return (
															<div
																key={task.id}
																className="grid gap-3 px-4 py-4 items-start"
																onDoubleClick={() => openTaskDetails(task.id)}
																title="Double-click for task details"
																style={{
																	gridTemplateColumns:
																		'minmax(260px,2fr) 110px 110px 140px 100px 120px 120px 72px',
																}}
															>
																	<div className="min-w-0">
																		{parentTask && (
																			<div
																				className="text-[11px] uppercase tracking-[0.16em] mb-2"
																				style={{ color: theme.colors.textDim }}
																			>
																				Subtask of {parentTask.title}
																			</div>
																		)}
																		<div
																			className="font-semibold"
																			style={{ color: theme.colors.textMain }}
																	>
																		{task.title}
																	</div>
																	{task.description && (
																		<div
																			className="text-sm mt-1 line-clamp-2"
																			style={{ color: theme.colors.textDim }}
																		>
																			{task.description}
																		</div>
																	)}
																	{getTaskAgentBadges(task).length > 0 && (
																		<div className="flex flex-wrap gap-2 mt-2">
																			{getTaskAgentBadges(task).map((badge) => (
																				<button
																					key={badge.key}
																					onClick={() => handleOpenAgentSession(badge.sessionId)}
																					disabled={!sessionById.has(badge.sessionId)}
																					className="px-2 py-1 rounded-full border text-[11px] disabled:opacity-70"
																					style={getGlassPillStyle(theme, badge.tone)}
																				>
																					{badge.label}
																				</button>
																			))}
																		</div>
																	)}
																		{task.scopePaths.length > 0 && (
																			<div
																				className="text-xs mt-2"
																				style={{ color: theme.colors.textDim }}
																			>
																				{task.scopePaths.join(', ')}
																			</div>
																		)}
																		{childTasks.length > 0 && (
																			<div className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
																				{childTasks.length} subtask{childTasks.length === 1 ? '' : 's'}
																			</div>
																		)}
																	</div>
																<div>
																	<select
																		value={task.status}
																		onChange={(e) =>
																			handleTaskStatusMove(task.id, e.target.value as ConductorTaskStatus)
																		}
																		className="w-full rounded-lg border px-2 py-2 text-xs"
																		style={{
																			backgroundColor: statusTone.bg,
																			borderColor: statusTone.border,
																			color: statusTone.fg,
																		}}
																	>
																		{STATUS_OPTIONS.map((option) => (
																			<option key={option} value={option}>
																				{formatTaskStatusLabel(option)}
																			</option>
																		))}
																	</select>
																</div>
																<div>
																	<select
																		value={task.priority}
																		onChange={(e) =>
																			updateTask(task.id, {
																				priority: e.target.value as ConductorTaskPriority,
																			})
																		}
																		className="w-full rounded-lg border px-2 py-2 text-xs"
																		style={{
																			backgroundColor: priorityTone.bg,
																			borderColor: priorityTone.border,
																			color: priorityTone.fg,
																		}}
																	>
																		{PRIORITY_OPTIONS.map((option) => (
																			<option key={option} value={option}>
																				{formatLabel(option)}
																			</option>
																		))}
																	</select>
																</div>
																<div className="text-sm" style={{ color: theme.colors.textDim }}>
																	{formatTaskSourceLabel(task.source)}
																</div>
																<div className="text-sm" style={{ color: theme.colors.textMain }}>
																	{task.dependsOn.length}
																</div>
																<div className="text-sm" style={{ color: theme.colors.textMain }}>
																	{task.scopePaths.length}
																</div>
																<div className="text-sm" style={{ color: theme.colors.textDim }}>
																	{new Date(task.updatedAt).toLocaleDateString()}
																</div>
																	<div className="flex justify-end">
																		{canStopTask && (
																			<button
																				onClick={() => void handleStopTask(task)}
																				className="p-2 rounded-lg hover:bg-white/5"
																				title="Stop task"
																				style={{ color: theme.colors.textDim }}
																			>
																				<Square className="w-4 h-4" />
																			</button>
																		)}
																		<button
																			onClick={() => openTaskComposer(task.id)}
																			className="p-2 rounded-lg hover:bg-white/5"
																			title="Add subtask"
																			style={{ color: theme.colors.textDim }}
																		>
																			<ClipboardList className="w-4 h-4" />
																		</button>
																		<button
																			onClick={() => deleteTask(task.id)}
																		className="p-2 rounded-lg hover:bg-white/5"
																		title="Delete task"
																		style={{ color: theme.colors.textDim }}
																	>
																		<Trash2 className="w-4 h-4" />
																	</button>
																</div>
															</div>
														);
													})
												) : (
													<div
														className="px-4 py-10 text-center"
														style={{ color: theme.colors.textDim }}
													>
														No tasks match the current search and filters.
													</div>
												)}
											</div>
										</div>
									</div>
								)}
							</div>
						</div>
						</div>
					</div>
				)}

				{activeTab === 'history' && (
					<div className="space-y-3">
						{runs.length > 0 ? (
							runs.map((run) => (
								<div
									key={run.id}
									className="rounded-xl border p-5"
									style={getGlassPanelStyle(theme, {
										tint: 'rgba(255,255,255,0.10)',
										borderColor: 'rgba(255,255,255,0.08)',
									})}
								>
									<div className="flex items-start justify-between gap-4">
										<div>
											<div className="font-semibold" style={{ color: theme.colors.textMain }}>
												{run.summary || 'Conductor planning run'}
											</div>
											<div className="text-sm mt-2" style={{ color: theme.colors.textDim }}>
												Type:{' '}
												{(run.kind || 'planning').replace(/^\w/, (char) => char.toUpperCase())}
											</div>
											<div className="text-sm mt-2" style={{ color: theme.colors.textDim }}>
												Status: {formatConductorStatusLabel(run.status)}
											</div>
											{advancedMode && run.branchName && (
												<div className="text-sm mt-1" style={{ color: theme.colors.textDim }}>
													Branch: {run.branchName}
												</div>
											)}
											{advancedMode && run.worktreePath && (
												<div
													className="text-sm mt-1 break-all"
													style={{ color: theme.colors.textDim }}
												>
													{run.sshRemoteId ? 'Remote worktree' : 'Worktree'}: {run.worktreePath}
												</div>
											)}
											<div className="text-sm mt-1" style={{ color: theme.colors.textDim }}>
												Started: {formatTimestamp(run.startedAt)}
											</div>
											{run.approvedAt && (
												<div className="text-sm mt-1" style={{ color: theme.colors.textDim }}>
													Approved: {formatTimestamp(run.approvedAt)}
												</div>
											)}
										</div>
										<div className="text-sm" style={{ color: theme.colors.textDim }}>
											{run.taskIds.length} task{run.taskIds.length === 1 ? '' : 's'}
										</div>
									</div>
									<div className="flex flex-wrap gap-2 mt-4">
										{run.prUrl && (
											<button
												onClick={() => void window.maestro.shell.openExternal(run.prUrl!)}
												className="px-3 py-2 rounded-lg text-sm inline-flex items-center gap-2"
												style={getGlassButtonStyle(theme)}
											>
												<ExternalLink className="w-4 h-4" />
												Open pull request
											</button>
										)}
										{advancedMode && run.worktreePath && (
											<button
												onClick={() =>
													run.sshRemoteId
														? void handleCopyRemotePath(run.worktreePath!)
														: void window.maestro.shell.openPath(run.worktreePath!)
												}
												className="px-3 py-2 rounded-lg text-sm inline-flex items-center gap-2"
												style={getGlassButtonStyle(theme)}
											>
												{run.sshRemoteId ? (
													<Copy className="w-4 h-4" />
												) : (
													<FolderOpen className="w-4 h-4" />
												)}
												{run.sshRemoteId ? 'Copy remote folder path' : 'Open local folder'}
											</button>
										)}
										{advancedMode && (
											<button
												onClick={() => void handleCleanupRunArtifacts(run)}
												disabled={isCleaningUp || collectRunArtifactPaths(run).length === 0}
												className="px-3 py-2 rounded-lg text-sm disabled:opacity-50 inline-flex items-center gap-2"
												style={getGlassButtonStyle(theme)}
											>
												{isCleaningUp ? (
													<Loader2 className="w-4 h-4 animate-spin" />
												) : (
													<Trash2 className="w-4 h-4" />
												)}
												Clean up leftovers
											</button>
										)}
									</div>
								</div>
							))
						) : (
							<div
								className="rounded-xl border p-8 text-center"
								style={{ ...getGlassPanelStyle(theme), color: theme.colors.textDim }}
							>
								<div className="flex justify-center mb-3">
									<History className="w-5 h-5" />
								</div>
								<p>No conductor runs recorded yet.</p>
								<p className="text-sm mt-2">
									Generate a plan to create the first run history entry.
								</p>
							</div>
						)}
					</div>
				)}
			</div>

			{isSettingsOpen && (
				<Modal
					theme={theme}
					title="Conductor Settings"
					priority={MODAL_PRIORITIES.SETTINGS + 1}
					onClose={() => setIsSettingsOpen(false)}
					width={860}
					maxHeight="85vh"
					closeOnBackdropClick
				>
					<div className="space-y-5">
						<div
							className="rounded-xl border p-5"
							style={getGlassPanelStyle(theme, {
								tint: 'rgba(255,255,255,0.10)',
								borderColor: 'rgba(255,255,255,0.08)',
								strong: true,
							})}
						>
							<div
								className="flex items-center gap-2 mb-2"
								style={{ color: theme.colors.textMain }}
							>
								<Sparkles className="w-4 h-4" />
								<h2 className="font-semibold">How Conductor works</h2>
							</div>
							<p className="text-sm leading-6 mb-4" style={{ color: theme.colors.textDim }}>
								Conductor is easiest when you treat it like a lead dev for this group: pick one
								trusted agent, describe the changes you want, then decide whether you want to review
								the plan or let it keep moving.
							</p>
							<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
								{SETTINGS_GUIDE_STEPS.map((step, index) => {
									const Icon = step.icon;
									const accentColor =
										step.accent === 'success'
											? theme.colors.success
											: step.accent === 'warning'
												? theme.colors.warning
												: theme.colors.accent;

									return (
										<div
											key={step.key}
											className="rounded-2xl border p-4"
											style={getGlassPanelStyle(theme, {
												tint: `${accentColor}12`,
												borderColor: `${accentColor}2f`,
											})}
										>
											<div className="flex items-start gap-3">
												<div
													className="w-10 h-10 rounded-xl border flex items-center justify-center flex-shrink-0"
													style={{
														backgroundColor: `${accentColor}14`,
														borderColor: `${accentColor}30`,
														color: accentColor,
													}}
												>
													<Icon className="w-4 h-4" />
												</div>
												<div className="min-w-0">
													<div className="flex items-center gap-2 mb-1">
														<span
															className="text-[11px] uppercase tracking-[0.18em]"
															style={{ color: accentColor }}
														>
															Step {index + 1}
														</span>
													</div>
													<div className="font-semibold" style={{ color: theme.colors.textMain }}>
														{step.title}
													</div>
													<p
														className="text-sm leading-6 mt-2"
														style={{ color: theme.colors.textDim }}
													>
														{step.description}
													</p>
												</div>
											</div>
										</div>
									);
								})}
							</div>
						</div>

						<div
							className="rounded-xl border p-5"
							style={getGlassPanelStyle(theme, {
								tint: 'rgba(255,255,255,0.10)',
								borderColor: 'rgba(255,255,255,0.08)',
								strong: true,
							})}
						>
							<div className="flex items-start justify-between gap-3 mb-3">
								<div className="flex items-center gap-2" style={{ color: theme.colors.textMain }}>
									<Settings2 className="w-4 h-4" />
									<h2 className="font-semibold">Lead Setup</h2>
								</div>
								<button
									onClick={() => setAdvancedMode((value) => !value)}
									className="px-3 py-2 rounded-lg text-sm font-medium"
									style={getGlassButtonStyle(theme, { active: advancedMode })}
								>
									{advancedMode ? 'Hide Advanced Mode' : 'Advanced Mode'}
								</button>
							</div>
							<p className="text-sm leading-6 mb-4" style={{ color: theme.colors.textDim }}>
								Conductor automatically uses this workspace’s current lead agent and copies its
								environment before it spins up helpers. Defaults are already selected, so most
								people can leave advanced controls alone.
							</p>
							<div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm mb-4">
								<div className="rounded-2xl border p-4" style={getGlassPanelStyle(theme)}>
									<div style={{ color: theme.colors.textDim }}>Workspace lead</div>
									<div className="font-semibold mt-2" style={{ color: theme.colors.textMain }}>
										{selectedTemplate?.name || 'No workspace agent yet'}
									</div>
								</div>
								<div className="rounded-2xl border p-4" style={getGlassPanelStyle(theme)}>
									<div style={{ color: theme.colors.textDim }}>Work style</div>
									<div className="font-semibold mt-2" style={{ color: theme.colors.textMain }}>
										{formatLabel(conductor?.resourceProfile || 'aggressive')}
									</div>
								</div>
							</div>
							{!advancedMode && (
								<div className="rounded-2xl border p-4 text-sm" style={getGlassPanelStyle(theme)}>
									<div className="font-semibold" style={{ color: theme.colors.textMain }}>
										Defaults selected
									</div>
									<div className="mt-2 leading-6" style={{ color: theme.colors.textDim }}>
										Resource profile: {formatLabel(conductor?.resourceProfile || 'aggressive')}
										<br />
										Publish policy:{' '}
										{conductor?.publishPolicy === 'none' ? 'No publish action' : 'Manual PR'}
										<br />
										Auto execute tasks: {conductor?.autoExecuteOnPlanCreation ? 'On' : 'Off'}
										<br />
										Keep helper agents: {conductor?.keepConductorAgentSessions ? 'On' : 'Off'}
										<br />
										UI provider: {formatProviderChoiceLabel(providerRouting.ui.primary)}
										<br />
										Backend provider: {formatProviderChoiceLabel(providerRouting.backend.primary)}
									</div>
								</div>
							)}
							{advancedMode && (
								<div className="rounded-2xl border p-4" style={getGlassPanelStyle(theme)}>
									<div className="space-y-3 text-sm">
										<div>
											<div className="mb-2" style={{ color: theme.colors.textDim }}>
												Resource profile
											</div>
											<select
												value={conductor?.resourceProfile || 'aggressive'}
												onChange={(e) =>
													setConductor(groupId, {
														resourceProfile: e.target.value as
															| 'conservative'
															| 'balanced'
															| 'aggressive',
													})
												}
												className="w-full rounded-lg border px-3 py-2 text-sm"
												style={getGlassInputStyle(theme)}
											>
												<option value="conservative">Conservative</option>
												<option value="balanced">Balanced</option>
												<option value="aggressive">Aggressive</option>
											</select>
										</div>
										<div>
											<div className="mb-2" style={{ color: theme.colors.textDim }}>
												Publish policy
											</div>
											<select
												value={conductor?.publishPolicy || 'manual_pr'}
												onChange={(e) =>
													setConductor(groupId, {
														publishPolicy: e.target.value as 'none' | 'manual_pr',
													})
												}
												className="w-full rounded-lg border px-3 py-2 text-sm"
												style={getGlassInputStyle(theme)}
											>
												<option value="manual_pr">Manual PR</option>
												<option value="none">No publish action</option>
											</select>
										</div>
										<label
											className="flex items-center gap-2 rounded-lg border px-3 py-2"
											style={{ ...getGlassPanelStyle(theme), color: theme.colors.textMain }}
										>
											<input
												type="checkbox"
												checked={Boolean(conductor?.autoExecuteOnPlanCreation)}
												onChange={(e) =>
													setConductor(groupId, {
														autoExecuteOnPlanCreation: e.target.checked,
													})
												}
											/>
											Auto execute tasks for approved plans
										</label>
										<label
											className="flex items-center gap-2 rounded-lg border px-3 py-2"
											style={{ ...getGlassPanelStyle(theme), color: theme.colors.textMain }}
										>
											<input
												type="checkbox"
												checked={Boolean(conductor?.deleteWorkerBranchesOnSuccess)}
												onChange={(e) =>
													setConductor(groupId, {
														deleteWorkerBranchesOnSuccess: e.target.checked,
													})
												}
											/>
											Delete worker branches after successful integration
										</label>
										<label
											className="flex items-center gap-2 rounded-lg border px-3 py-2"
											style={{ ...getGlassPanelStyle(theme), color: theme.colors.textMain }}
										>
											<input
												type="checkbox"
												checked={Boolean(conductor?.keepConductorAgentSessions)}
												onChange={(e) =>
													setConductor(groupId, {
														keepConductorAgentSessions: e.target.checked,
													})
												}
											/>
											Keep Conductor helper agents after runs finish
										</label>
										<div
											className="rounded-2xl border p-4"
											style={getGlassPanelStyle(theme, {
												tint: `${theme.colors.accent}08`,
												borderColor: `${theme.colors.accent}20`,
											})}
										>
											<div className="font-semibold" style={{ color: theme.colors.textMain }}>
												Provider preference
											</div>
											<p className="text-sm mt-2 leading-6" style={{ color: theme.colors.textDim }}>
												Route UI-heavy work and backend-heavy work to different providers, and let
												Conductor fail over before your subscription gets tight.
											</p>
											<div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
												{([
													['default', 'General work'],
													['ui', 'UI work'],
													['backend', 'Backend work'],
												] as Array<[ConductorProviderRouteKey, string]>).map(([routeKey, label]) => (
													<div key={routeKey} className="space-y-2">
														<div style={{ color: theme.colors.textDim }}>{label}</div>
														<select
															value={providerRouting[routeKey].primary}
															onChange={(e) =>
																setConductor(groupId, {
																	providerRouting: {
																		...providerRouting,
																		[routeKey]: {
																			...providerRouting[routeKey],
																			primary: e.target.value as ConductorProviderChoice,
																		},
																	},
																})
															}
															className="w-full rounded-lg border px-3 py-2 text-sm"
															style={getGlassInputStyle(theme)}
														>
															{CONDUCTOR_PROVIDER_PRIMARY_OPTIONS.map((option) => (
																<option key={`${routeKey}-${option}`} value={option}>
																	Primary: {formatProviderChoiceLabel(option)}
																</option>
															))}
														</select>
														<select
															value={providerRouting[routeKey].fallback || ''}
															onChange={(e) =>
																setConductor(groupId, {
																	providerRouting: {
																		...providerRouting,
																		[routeKey]: {
																			...providerRouting[routeKey],
																			fallback:
																				(e.target.value as ConductorProviderAgent) || null,
																		},
																	},
																})
															}
															className="w-full rounded-lg border px-3 py-2 text-sm"
															style={getGlassInputStyle(theme)}
														>
															<option value="">No fallback</option>
															{CONDUCTOR_PROVIDER_OPTIONS.map((option) => (
																<option key={`${routeKey}-fallback-${option}`} value={option}>
																	Fallback: {getProviderDisplayName(option)}
																</option>
															))}
														</select>
													</div>
												))}
											</div>
											<div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_140px] gap-3 mt-4">
												<label
													className="flex items-center gap-2 rounded-lg border px-3 py-2"
													style={{ ...getGlassPanelStyle(theme), color: theme.colors.textMain }}
												>
													<input
														type="checkbox"
														checked={providerRouting.pauseNearLimit}
														onChange={(e) =>
															setConductor(groupId, {
																providerRouting: {
																	...providerRouting,
																	pauseNearLimit: e.target.checked,
																},
															})
														}
													/>
													Pause or fail over when provider usage gets tight
												</label>
												<div>
													<div className="mb-2" style={{ color: theme.colors.textDim }}>
														Near-limit %
													</div>
													<input
														type="number"
														min={50}
														max={99}
														value={providerRouting.nearLimitPercent}
														onChange={(e) =>
															setConductor(groupId, {
																providerRouting: {
																	...providerRouting,
																	nearLimitPercent: Math.min(
																		99,
																		Math.max(50, Number(e.target.value) || 88)
																	),
																},
															})
														}
														className="w-full rounded-lg border px-3 py-2 text-sm"
														style={getGlassInputStyle(theme)}
													/>
												</div>
											</div>
										</div>
										<div>
											<div className="mb-2" style={{ color: theme.colors.textDim }}>
												Validation command
											</div>
											<div className="flex items-center gap-2">
												<input
													value={validationDraft}
													onChange={(e) => setValidationDraft(e.target.value)}
													placeholder="Optional, e.g. npm test"
													className="flex-1 rounded-lg border px-3 py-2 text-sm"
													style={getGlassInputStyle(theme)}
												/>
												<button
													onClick={() =>
														setConductor(groupId, {
															validationCommand: validationDraft.trim() || undefined,
														})
													}
													className="px-3 py-2 rounded-lg text-sm font-medium"
													style={getGlassButtonStyle(theme)}
												>
													Save
												</button>
											</div>
										</div>
									</div>
								</div>
							)}
						</div>

						<div
							className="rounded-xl border p-5"
							style={getGlassPanelStyle(theme, {
								tint: 'rgba(255,255,255,0.10)',
								borderColor: 'rgba(255,255,255,0.08)',
								strong: true,
							})}
						>
							<div
								className="flex items-center gap-2 mb-3"
								style={{ color: theme.colors.textMain }}
							>
								<FolderKanban className="w-4 h-4" />
								<h2 className="font-semibold">How fast Conductor should go</h2>
							</div>
							<p className="text-sm leading-6 mb-4" style={{ color: theme.colors.textDim }}>
								Conductor slows itself down when your machine is under pressure, so you do not have
								to think about worker counts all day.
							</p>
							<div className="space-y-2 text-sm" style={{ color: theme.colors.textDim }}>
								<div>
									CPU threads:{' '}
									<span style={{ color: theme.colors.textMain }}>
										{resourceSnapshot?.cpuCount || 'Unavailable'}
									</span>
								</div>
								<div>
									1m load:{' '}
									<span style={{ color: theme.colors.textMain }}>
										{resourceSnapshot ? resourceSnapshot.loadAverage[0].toFixed(2) : 'Unavailable'}
									</span>
								</div>
								<div>
									Available memory:{' '}
									<span style={{ color: theme.colors.textMain }}>
										{formatMemorySummary(resourceSnapshot)}
									</span>
								</div>
								{resourceSnapshot?.platform === 'darwin' && (
									<div>
										Raw free memory:{' '}
										<span style={{ color: theme.colors.textMain }}>
											{(resourceSnapshot.freeMemoryMB / 1024).toFixed(1)} GB
										</span>
									</div>
								)}
								<div>
									Launch gate:{' '}
									<span
										style={{
											color: resourceGate.allowed ? theme.colors.textMain : theme.colors.warning,
										}}
									>
										{resourceGate.allowed ? 'Open' : 'Holding'}
									</span>
								</div>
								{resourceGate.message && (
									<div style={{ color: theme.colors.warning }}>{resourceGate.message}</div>
								)}
							</div>
						</div>
					</div>
				</Modal>
			)}

			{selectedConductorSession && (
				<Modal
					theme={theme}
					title={selectedConductorSession.name}
					priority={MODAL_PRIORITIES.SETTINGS + 4}
					onClose={() => setSelectedConductorSessionId(null)}
					width={920}
					maxHeight="88vh"
					closeOnBackdropClick
				>
					<div className="space-y-5">
						<div
							className="rounded-xl border p-5"
							style={getGlassPanelStyle(theme, {
								tint: 'rgba(255,255,255,0.10)',
								borderColor: 'rgba(255,255,255,0.08)',
								strong: true,
							})}
						>
							<div className="flex flex-wrap items-start justify-between gap-4">
								<div className="min-w-0">
									<div className="flex flex-wrap gap-2">
										<span
											className="px-2.5 py-1 rounded-full border text-[11px] uppercase tracking-wide"
											style={getGlassPillStyle(
												theme,
												selectedConductorSession.state === 'busy' ? 'accent' : 'default'
											)}
										>
											{formatConductorRoleLabel(
												selectedConductorSession.conductorMetadata?.role || 'worker'
											)}
										</span>
										<span
											className="px-2.5 py-1 rounded-full border text-[11px]"
											style={getGlassPillStyle(theme, 'default')}
										>
											{getProviderDisplayName(selectedConductorSession.toolType)}
										</span>
										<span
											className="px-2.5 py-1 rounded-full border text-[11px]"
											style={getGlassPillStyle(theme, 'default')}
										>
											{formatLabel(selectedConductorSession.state)}
										</span>
									</div>
									<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 text-sm">
										<div style={{ color: theme.colors.textDim }}>
											Assigned task
											<div className="mt-1" style={{ color: theme.colors.textMain }}>
												{selectedConductorSession.conductorMetadata?.taskTitle || 'General Conductor work'}
											</div>
										</div>
										<div style={{ color: theme.colors.textDim }}>
											Last active
											<div className="mt-1" style={{ color: theme.colors.textMain }}>
												{formatTimestamp(getSessionLastActivity(selectedConductorSession))}
											</div>
										</div>
										<div className="md:col-span-2" style={{ color: theme.colors.textDim }}>
											Working directory
											<div className="mt-1 break-all" style={{ color: theme.colors.textMain }}>
												{selectedConductorSession.cwd}
											</div>
										</div>
									</div>
								</div>
							</div>
						</div>

						<div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,0.9fr)] gap-5">
							<div
								className="rounded-xl border p-5 max-h-[55vh] overflow-y-auto scrollbar-thin"
								style={{
									...getGlassPanelStyle(theme),
									backgroundColor: theme.colors.bgSidebar,
									overscrollBehavior: 'contain',
									WebkitOverflowScrolling: 'touch',
									contain: 'paint',
								}}
							>
								<div className="flex items-center justify-between gap-3 mb-4">
									<div>
										<div className="font-semibold" style={{ color: theme.colors.textMain }}>
											Conversation
										</div>
										<div className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
											Messages and meaningful system notes from this helper.
										</div>
									</div>
									<div className="text-xs" style={{ color: theme.colors.textDim }}>
										{selectedConductorConversationLogs.length} items
									</div>
								</div>
								<div className="space-y-3">
									{selectedConductorConversationLogs.length > 0 ? (
										selectedConductorConversationLogs.map((entry) => (
											<div
												key={entry.id}
												className="rounded-lg border p-3"
												style={getGlassPanelStyle(theme)}
											>
												<div className="flex items-center justify-between gap-3 mb-2">
													<span
														className="px-2 py-1 rounded-full border text-[11px] uppercase tracking-wide"
														style={getGlassPillStyle(theme, getConductorLogTone(entry))}
													>
														{getConductorLogLabel(entry)}
													</span>
													<span className="text-xs" style={{ color: theme.colors.textDim }}>
														{formatTimestamp(entry.timestamp)}
													</span>
												</div>
												<div
													className="text-sm whitespace-pre-wrap break-words leading-6"
													style={{ color: theme.colors.textMain }}
												>
													{entry.text || '(No text recorded)'}
												</div>
											</div>
										))
									) : (
										<div className="text-sm leading-6" style={{ color: theme.colors.textDim }}>
											No conversation messages yet. If this helper is still working, its tool activity
											will appear alongside the conversation on the right.
										</div>
									)}
								</div>
							</div>

							<div
								className="rounded-xl border p-5 max-h-[55vh] overflow-y-auto scrollbar-thin"
								style={{
									...getGlassPanelStyle(theme),
									backgroundColor: theme.colors.bgSidebar,
									overscrollBehavior: 'contain',
									WebkitOverflowScrolling: 'touch',
									contain: 'paint',
								}}
							>
								<div className="flex items-center justify-between gap-3 mb-4">
									<div>
										<div className="font-semibold" style={{ color: theme.colors.textMain }}>
											Activity
										</div>
										<div className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
											Tool calls, shell activity, and lower-level helper events.
										</div>
									</div>
									<div className="text-xs" style={{ color: theme.colors.textDim }}>
										{selectedConductorVisibleLogCount} visible
									</div>
								</div>
								<div className="space-y-3">
									{selectedConductorActivityLogs.length > 0 ? (
										selectedConductorActivityLogs.map((entry) =>
											entry.source === 'tool' ? (
												<ToolActivityBlock
													key={entry.id}
													log={entry}
													theme={theme}
													expanded={expandedConductorToolLogIds.has(entry.id)}
													onToggleExpanded={() =>
														setExpandedConductorToolLogIds((previous) => {
															const next = new Set(previous);
															if (next.has(entry.id)) {
																next.delete(entry.id);
															} else {
																next.add(entry.id);
															}
															return next;
														})
													}
												/>
											) : (
												<div
													key={entry.id}
													className="rounded-lg border p-3"
													style={getGlassPanelStyle(theme)}
												>
													<div className="flex items-center justify-between gap-3 mb-2">
														<span
															className="px-2 py-1 rounded-full border text-[11px] uppercase tracking-wide"
															style={getGlassPillStyle(theme, getConductorLogTone(entry))}
														>
															{getConductorLogLabel(entry)}
														</span>
														<span className="text-xs" style={{ color: theme.colors.textDim }}>
															{formatTimestamp(entry.timestamp)}
														</span>
													</div>
													<div
														className="text-sm whitespace-pre-wrap break-words leading-6"
														style={{ color: theme.colors.textMain }}
													>
														{entry.text || '(No text recorded)'}
													</div>
												</div>
											)
										)
									) : (
										<div className="text-sm leading-6" style={{ color: theme.colors.textDim }}>
											No lower-level activity recorded for this helper yet.
										</div>
									)}
								</div>
							</div>
						</div>
					</div>
				</Modal>
			)}

			{selectedTaskDetail && (() => {
				const detailStatusTone = PASTEL_STATUS_TONES[selectedTaskDetail.status] || PASTEL_STATUS_TONES.draft;
				const detailPriorityTone = getTaskPriorityTone(theme, selectedTaskDetail.priority);
				return (
				<Modal
					theme={theme}
					title=""
					priority={MODAL_PRIORITIES.SETTINGS + 3}
					onClose={() => setSelectedTaskDetailId(null)}
					width={780}
					maxHeight="85vh"
					closeOnBackdropClick
				>
					<div className="space-y-5">
						{/* Editable title */}
						<input
							defaultValue={selectedTaskDetail.title}
							onBlur={(e) => {
								const v = e.target.value.trim();
								if (v && v !== selectedTaskDetail.title) updateTask(selectedTaskDetail.id, { title: v });
							}}
							className="w-full bg-transparent text-xl font-semibold outline-none border-b border-transparent focus:border-current pb-1"
							style={{ color: theme.colors.textMain }}
							placeholder="Task title"
						/>

						{/* Status + Priority + Source row */}
						<div className="flex flex-wrap items-center gap-3">
							<select
								value={selectedTaskDetail.status}
								onChange={(e) =>
									handleTaskStatusMove(selectedTaskDetail.id, e.target.value as ConductorTaskStatus)
								}
								className="rounded-full px-3 py-1.5 text-xs font-medium border outline-none cursor-pointer"
								style={{
									backgroundColor: detailStatusTone.bg,
									borderColor: detailStatusTone.border,
									color: detailStatusTone.fg,
								}}
							>
								{STATUS_OPTIONS.map((option) => (
									<option key={option} value={option}>
										{formatTaskStatusLabel(option)}
									</option>
								))}
							</select>

							<select
								value={selectedTaskDetail.priority}
								onChange={(e) =>
									updateTask(selectedTaskDetail.id, {
										priority: e.target.value as ConductorTaskPriority,
									})
								}
								className="rounded-full px-3 py-1.5 text-xs font-medium border outline-none cursor-pointer"
								style={{
									backgroundColor: detailPriorityTone.bg,
									borderColor: detailPriorityTone.border,
									color: detailPriorityTone.fg,
								}}
							>
								{PRIORITY_OPTIONS.map((option) => (
									<option key={option} value={option}>
										{formatLabel(option)}
									</option>
								))}
							</select>

							<span
								className="px-2.5 py-1 rounded-full text-[11px]"
								style={{
									backgroundColor: 'rgba(255,255,255,0.06)',
									color: theme.colors.textDim,
								}}
							>
								{formatTaskSourceLabel(selectedTaskDetail.source)}
							</span>

							<span className="text-xs ml-auto" style={{ color: theme.colors.textDim }}>
								{formatTimestamp(selectedTaskDetail.updatedAt)}
							</span>

							{Boolean(getActiveTaskSessionId(selectedTaskDetail)) && (
								<button
									onClick={() => void handleStopTask(selectedTaskDetail)}
									className="px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 hover:bg-white/10"
									style={{
										color: theme.colors.warning,
										border: `1px solid ${theme.colors.warning}30`,
									}}
								>
									<Square className="w-3 h-3" />
									Stop
								</button>
							)}
						</div>

						{/* Editable description */}
						<textarea
							defaultValue={selectedTaskDetail.description}
							onBlur={(e) => {
								const v = e.target.value.trim();
								if (v !== (selectedTaskDetail.description || ''))
									updateTask(selectedTaskDetail.id, { description: v });
							}}
							placeholder="Add a description..."
							rows={3}
							className="w-full bg-transparent rounded-xl border px-3.5 py-3 text-sm resize-y outline-none leading-relaxed"
							style={{
								color: theme.colors.textMain,
								borderColor: 'rgba(255,255,255,0.08)',
							}}
						/>

						{/* Acceptance criteria — editable */}
						<div>
							<div className="text-xs font-medium uppercase tracking-wider mb-2" style={{ color: theme.colors.textDim }}>
								Acceptance criteria
							</div>
							<textarea
								defaultValue={selectedTaskDetail.acceptanceCriteria.join('\n')}
								onBlur={(e) => {
									const lines = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean);
									const current = selectedTaskDetail.acceptanceCriteria;
									if (JSON.stringify(lines) !== JSON.stringify(current))
										updateTask(selectedTaskDetail.id, { acceptanceCriteria: lines });
								}}
								placeholder="One criterion per line..."
								rows={2}
								className="w-full bg-transparent rounded-xl border px-3.5 py-2.5 text-sm resize-y outline-none"
								style={{
									color: theme.colors.textMain,
									borderColor: 'rgba(255,255,255,0.08)',
								}}
							/>
						</div>

						<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
							{/* Left column */}
							<div className="space-y-4 min-w-0">
								{/* Git info — only if exists */}
								{(selectedTaskLatestExecution?.taskBranches?.[selectedTaskDetail.id] ||
									selectedTaskLatestExecution?.taskWorktreePaths?.[selectedTaskDetail.id]) && (
									<div
										className="rounded-xl overflow-hidden"
										style={{
											backgroundColor: theme.colors.bgSidebar,
											border: '1px solid rgba(255,255,255,0.08)',
										}}
									>
										<div
											className="px-3.5 py-2 text-xs font-medium uppercase tracking-wider"
											style={{
												color: theme.colors.textDim,
												borderBottom: '1px solid rgba(255,255,255,0.06)',
												backgroundColor: 'rgba(255,255,255,0.03)',
											}}
										>
											Git
										</div>
										<div className="p-3.5 space-y-2.5 text-sm">
											{selectedTaskLatestExecution?.taskBranches?.[selectedTaskDetail.id] && (
												<div className="flex items-center gap-2">
													<GitBranch className="w-3.5 h-3.5 shrink-0" style={{ color: '#a78bfa' }} />
													<span className="break-all" style={{ color: theme.colors.textMain }}>
														{selectedTaskLatestExecution.taskBranches[selectedTaskDetail.id]}
													</span>
												</div>
											)}
											{selectedTaskLatestExecution?.taskWorktreePaths?.[selectedTaskDetail.id] && (
												<div className="flex items-center gap-2">
													<FolderOpen className="w-3.5 h-3.5 shrink-0" style={{ color: '#60a5fa' }} />
													<span className="break-all text-xs font-mono" style={{ color: theme.colors.textDim }}>
														{selectedTaskLatestExecution.taskWorktreePaths[selectedTaskDetail.id]}
													</span>
												</div>
											)}
										</div>
									</div>
								)}

								{/* Agents */}
								{getTaskAgentBadges(selectedTaskDetail).length > 0 && (
									<div
										className="rounded-xl overflow-hidden"
										style={{
											backgroundColor: theme.colors.bgSidebar,
											border: '1px solid rgba(255,255,255,0.08)',
										}}
									>
										<div
											className="px-3.5 py-2 text-xs font-medium uppercase tracking-wider"
											style={{
												color: theme.colors.textDim,
												borderBottom: '1px solid rgba(255,255,255,0.06)',
												backgroundColor: 'rgba(255,255,255,0.03)',
											}}
										>
											Agents
										</div>
										<div className="p-2.5 flex flex-wrap gap-1.5">
											{getTaskAgentBadges(selectedTaskDetail).map((badge) => (
												<button
													key={badge.key}
													onClick={() => handleOpenAgentSession(badge.sessionId)}
													disabled={!sessionById.has(badge.sessionId)}
													className="px-2.5 py-1.5 rounded-lg text-xs inline-flex items-center gap-1.5 disabled:opacity-70 hover:bg-white/5"
													style={getGlassPillStyle(theme, badge.tone)}
												>
													<ExternalLink className="w-3 h-3" />
													{badge.label}
												</button>
											))}
										</div>
									</div>
								)}

								{/* Activity */}
								{selectedTaskRecentEvents.length > 0 && (
									<div
										className="rounded-xl overflow-hidden"
										style={{
											backgroundColor: theme.colors.bgSidebar,
											border: '1px solid rgba(255,255,255,0.08)',
										}}
									>
										<div
											className="px-3.5 py-2 text-xs font-medium uppercase tracking-wider"
											style={{
												color: theme.colors.textDim,
												borderBottom: '1px solid rgba(255,255,255,0.06)',
												backgroundColor: 'rgba(255,255,255,0.03)',
											}}
										>
											Activity
										</div>
										<div className="p-2 space-y-0.5">
											{selectedTaskRecentEvents.map(({ event, runKind }) => {
												const evtTone = getConductorEventTone(event.type);
												const evtColor = evtTone === 'success' ? '#86efac'
													: evtTone === 'warning' ? '#fbbf24'
													: evtTone === 'accent' ? '#818cf8'
													: '#b0b8c4';
												return (
													<div
														key={event.id}
														className="flex items-start gap-2.5 px-2.5 py-2 rounded-lg"
													>
														<div
															className="w-2 h-2 rounded-full mt-1.5 shrink-0"
															style={{ backgroundColor: evtColor }}
														/>
														<div className="min-w-0 flex-1">
															<div className="text-sm" style={{ color: theme.colors.textMain }}>
																{event.message}
															</div>
															<div className="flex items-center gap-2 mt-0.5 text-[11px]" style={{ color: theme.colors.textDim }}>
																<span>{formatLabel(runKind)}</span>
																<span>·</span>
																<span>{formatTimestamp(event.createdAt)}</span>
															</div>
														</div>
													</div>
												);
											})}
										</div>
									</div>
								)}
							</div>

							{/* Right column */}
							<div className="space-y-4">
								{/* Structure — only show items with data */}
								{(selectedTaskParent || selectedTaskChildren.length > 0 || selectedTaskDetail.dependsOn.length > 0) && (
									<div
										className="rounded-xl overflow-hidden"
										style={{
											backgroundColor: theme.colors.bgSidebar,
											border: '1px solid rgba(255,255,255,0.08)',
										}}
									>
										<div
											className="px-3.5 py-2 text-xs font-medium uppercase tracking-wider"
											style={{
												color: theme.colors.textDim,
												borderBottom: '1px solid rgba(255,255,255,0.06)',
												backgroundColor: 'rgba(255,255,255,0.03)',
											}}
										>
											Structure
										</div>
										<div className="p-3.5 space-y-3 text-sm">
											{selectedTaskParent && (
												<div>
													<div className="text-[11px] uppercase tracking-wider mb-1" style={{ color: theme.colors.textDim }}>Parent</div>
													<button
														onClick={() => openTaskDetails(selectedTaskParent.id)}
														className="text-left hover:underline"
														style={{ color: theme.colors.accent }}
													>
														{selectedTaskParent.title}
													</button>
												</div>
											)}
											{selectedTaskChildren.length > 0 && (
												<div>
													<div className="text-[11px] uppercase tracking-wider mb-1" style={{ color: theme.colors.textDim }}>
														Subtasks ({selectedTaskChildren.length})
													</div>
													<div className="space-y-1">
														{selectedTaskChildren.map((child) => {
															const childTone = PASTEL_STATUS_TONES[child.status] || PASTEL_STATUS_TONES.draft;
															return (
																<button
																	key={child.id}
																	onClick={() => openTaskDetails(child.id)}
																	className="flex items-center gap-2 w-full text-left hover:bg-white/5 rounded px-1.5 py-1"
																>
																	<div
																		className="w-2 h-2 rounded-full shrink-0"
																		style={{ backgroundColor: childTone.fg }}
																	/>
																	<span className="text-sm truncate" style={{ color: theme.colors.textMain }}>
																		{child.title}
																	</span>
																</button>
															);
														})}
													</div>
												</div>
											)}
											{selectedTaskDetail.dependsOn.length > 0 && (
												<div>
													<div className="text-[11px] uppercase tracking-wider mb-1" style={{ color: theme.colors.textDim }}>Dependencies</div>
													<div className="space-y-1">
														{selectedTaskDetail.dependsOn.map((depId) => {
															const dep = tasksById.get(depId);
															return (
																<button
																	key={depId}
																	onClick={() => dep && openTaskDetails(dep.id)}
																	className="text-sm text-left hover:underline block"
																	style={{ color: dep ? theme.colors.accent : theme.colors.textDim }}
																>
																	{dep?.title || depId}
																</button>
															);
														})}
													</div>
												</div>
											)}
										</div>
									</div>
								)}

								{/* Scope paths — only if exists */}
								{selectedTaskDetail.scopePaths.length > 0 && (
									<div
										className="rounded-xl overflow-hidden"
										style={{
											backgroundColor: theme.colors.bgSidebar,
											border: '1px solid rgba(255,255,255,0.08)',
										}}
									>
										<div
											className="px-3.5 py-2 text-xs font-medium uppercase tracking-wider"
											style={{
												color: theme.colors.textDim,
												borderBottom: '1px solid rgba(255,255,255,0.06)',
												backgroundColor: 'rgba(255,255,255,0.03)',
											}}
										>
											Scope paths
										</div>
										<div className="p-3.5 space-y-1">
											{selectedTaskDetail.scopePaths.map((p) => (
												<div key={p} className="text-xs break-all font-mono" style={{ color: theme.colors.textMain }}>
													{p}
												</div>
											))}
										</div>
									</div>
								)}

								{/* Changed paths — only if exists */}
								{selectedTaskDetail.changedPaths && selectedTaskDetail.changedPaths.length > 0 && (
									<div
										className="rounded-xl overflow-hidden"
										style={{
											backgroundColor: theme.colors.bgSidebar,
											border: '1px solid rgba(255,255,255,0.08)',
										}}
									>
										<div
											className="px-3.5 py-2 text-xs font-medium uppercase tracking-wider"
											style={{
												color: theme.colors.textDim,
												borderBottom: '1px solid rgba(255,255,255,0.06)',
												backgroundColor: 'rgba(255,255,255,0.03)',
											}}
										>
											Changed files
										</div>
										<div className="p-3.5 space-y-1">
											{selectedTaskDetail.changedPaths.map((p) => (
												<div key={p} className="text-xs break-all font-mono" style={{ color: theme.colors.textMain }}>
													{p}
												</div>
											))}
										</div>
									</div>
								)}

								{/* Runs count — only if exists */}
								{selectedTaskRelatedRuns.length > 0 && (
									<div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl" style={{
										backgroundColor: '#818cf810',
										border: '1px solid #818cf825',
									}}>
										<div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ backgroundColor: '#818cf818', color: '#818cf8' }}>
											<Activity className="w-3.5 h-3.5" />
										</div>
										<span className="text-sm font-medium" style={{ color: '#818cf8' }}>{selectedTaskRelatedRuns.length}</span>
										<span className="text-xs" style={{ color: theme.colors.textDim }}>related run{selectedTaskRelatedRuns.length === 1 ? '' : 's'}</span>
									</div>
								)}
							</div>
						</div>
					</div>
				</Modal>
				);
			})()}

			{isTaskComposerOpen && (
				<Modal
					theme={theme}
					title={manualTaskParentId ? 'Add Subtask' : 'Add Task'}
					priority={MODAL_PRIORITIES.SETTINGS + 2}
					onClose={() => {
						setIsTaskComposerOpen(false);
						resetTaskComposer();
					}}
					width={680}
					maxHeight="85vh"
					closeOnBackdropClick
				>
					<div className="space-y-4">
						<p className="text-sm leading-6" style={{ color: theme.colors.textDim }}>
							Add a task directly to the board. If you attach it to a parent, it becomes a first-class
							subtask that can move through planning, execution, and QA on its own.
						</p>

						<div>
							<div className="mb-2 text-sm" style={{ color: theme.colors.textDim }}>
								Parent task
							</div>
							<select
								value={manualTaskParentId}
								onChange={(e) => setManualTaskParentId(e.target.value)}
								className="w-full rounded-lg border px-3 py-2 text-sm"
								style={getGlassInputStyle(theme)}
							>
								<option value="">No parent, create a top-level task</option>
								{tasks.map((task) => (
									<option key={task.id} value={task.id}>
										{task.title}
									</option>
								))}
							</select>
						</div>

						<input
							value={manualTaskTitle}
							onChange={(e) => setManualTaskTitle(e.target.value)}
							placeholder="Short task title"
							className="w-full rounded-lg border px-3 py-3 text-sm"
							style={getGlassInputStyle(theme)}
						/>

						<textarea
							value={manualTaskDescription}
							onChange={(e) => setManualTaskDescription(e.target.value)}
							placeholder="What needs to happen?"
							rows={4}
							className="w-full rounded-lg border px-3 py-3 text-sm resize-y"
							style={getGlassInputStyle(theme)}
						/>

						<div>
							<div className="mb-2 text-sm" style={{ color: theme.colors.textDim }}>
								Priority
							</div>
							<select
								value={manualTaskPriority}
								onChange={(e) => setManualTaskPriority(e.target.value as ConductorTaskPriority)}
								className="w-full rounded-lg border px-3 py-2 text-sm"
								style={getGlassInputStyle(theme)}
							>
								{PRIORITY_OPTIONS.map((option) => (
									<option key={option} value={option}>
										{formatLabel(option)}
									</option>
								))}
							</select>
						</div>

						<div className="flex items-center justify-between gap-3 pt-2">
							<button
								onClick={() => {
									setIsTaskComposerOpen(false);
									resetTaskComposer();
								}}
								className="px-3 py-2 rounded-lg text-sm font-medium"
								style={getGlassButtonStyle(theme)}
							>
								Cancel
							</button>

							<button
								onClick={handleCreateManualTask}
								disabled={!manualTaskTitle.trim()}
								className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
								style={getGlassButtonStyle(theme, { accent: true })}
							>
								<ClipboardList className="w-4 h-4" />
								{manualTaskParentId ? 'Create subtask' : 'Create task'}
							</button>
						</div>
					</div>
				</Modal>
			)}

			{isPlanComposerOpen && (
				<Modal
					theme={theme}
					title="New Plan"
					priority={MODAL_PRIORITIES.SETTINGS + 2}
					onClose={() => {
						setIsPlanComposerOpen(false);
						setDraftDescription('');
						setPlannerNotes('');
						setPlanningError(null);
					}}
					width={760}
					maxHeight="85vh"
					closeOnBackdropClick
				>
					<div className="space-y-4">
						<p className="text-sm leading-6" style={{ color: theme.colors.textDim }}>
							Write the request in plain English. Conductor will break it down into tasks.
						</p>

						<textarea
							value={draftDescription}
							onChange={(e) => setDraftDescription(e.target.value)}
							placeholder="Example: fix the flaky login issue, tighten the onboarding copy, and make the settings page easier to scan."
							rows={6}
							className="w-full rounded-lg border px-3 py-3 text-sm resize-y"
							style={getGlassInputStyle(theme)}
						/>

						<textarea
							value={plannerNotes}
							onChange={(e) => setPlannerNotes(e.target.value)}
							placeholder="Optional notes: what matters most, what should happen first, what areas to avoid, or how bold the changes should be."
							rows={3}
							className="w-full rounded-lg border px-3 py-2 text-sm resize-y"
							style={getGlassInputStyle(theme)}
						/>

						<label
							className="flex items-center gap-2 text-sm"
							style={{ color: theme.colors.textMain }}
						>
							<input
								type="checkbox"
								checked={Boolean(conductor?.autoExecuteOnPlanCreation)}
								onChange={(e) =>
									setConductor(groupId, {
										autoExecuteOnPlanCreation: e.target.checked,
									})
								}
							/>
							Auto execute tasks for approved plans
						</label>

						{planningError && (
							<div
								className="rounded-lg border p-3 text-sm"
								style={{
									...getGlassPanelStyle(theme, {
										tint: `${theme.colors.warning}12`,
										borderColor: `${theme.colors.warning}35`,
									}),
									color: theme.colors.warning,
								}}
							>
								{planningError}
							</div>
						)}

						<div className="flex items-center justify-between gap-3 pt-2">
							<button
								onClick={() => {
									setIsPlanComposerOpen(false);
									setDraftDescription('');
									setPlannerNotes('');
									setPlanningError(null);
								}}
								className="px-3 py-2 rounded-lg text-sm font-medium"
								style={getGlassButtonStyle(theme)}
							>
								Cancel
							</button>

							<button
								onClick={() =>
									void handleGeneratePlan({
										requestOverride: draftDescription,
										operatorNotesOverride: plannerNotes,
										autoExecute: Boolean(conductor?.autoExecuteOnPlanCreation),
									})
								}
								disabled={isPlanning || !selectedTemplate || !draftDescription.trim()}
								className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
								style={getGlassButtonStyle(theme, { accent: true })}
							>
								{isPlanning ? (
									<Loader2 className="w-4 h-4 animate-spin" />
								) : (
									<Sparkles className="w-4 h-4" />
								)}
								{isPlanning ? 'Planning...' : 'Submit plan'}
							</button>
						</div>
					</div>
				</Modal>
			)}
		</div>
	);
}
