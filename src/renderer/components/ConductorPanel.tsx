import { useEffect, useMemo, useState } from 'react';
import {
	Activity,
	ArrowRight,
	ArrowUpDown,
	CheckCircle2,
	ClipboardList,
	Copy,
	ExternalLink,
	FolderKanban,
	FolderOpen,
	LayoutGrid,
	ListFilter,
	History,
	Loader2,
	PlayCircle,
	Rows3,
	Search,
	Settings2,
	ShieldAlert,
	Sparkles,
	Trash2,
	Users,
} from 'lucide-react';
import type {
	Theme,
	ConductorRun,
	ConductorTask,
	ConductorTaskStatus,
	ConductorTaskPriority,
	ConductorRunEvent,
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
	buildConductorWorkerPrompt,
	parseConductorWorkerResponse,
} from '../services/conductorWorker';
import {
	buildConductorIntegrationTarget,
	buildConductorWorktreeTarget,
	evaluateConductorResourceGate,
	tasksConflict,
} from '../services/conductorRuntime';
import { Modal } from './ui/Modal';

interface ConductorPanelProps {
	theme: Theme;
	groupId: string;
}

type ConductorTab = 'overview' | 'backlog' | 'history';
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
	'ready',
	'running',
	'blocked',
	'needs_review',
	'done',
];

const PRIORITY_OPTIONS: ConductorTaskPriority[] = ['low', 'medium', 'high', 'critical'];
const BOARD_COLUMNS: ConductorTaskStatus[] = [
	'draft',
	'ready',
	'running',
	'blocked',
	'needs_review',
	'done',
];

const SETTINGS_GUIDE_STEPS = [
	{
		key: 'lead',
		title: 'Choose one lead agent',
		description: 'Conductor copies this agent’s workspace and setup whenever it spins up helpers.',
		icon: Users,
		accent: 'success',
	},
	{
		key: 'plan',
		title: 'Drop in a request',
		description: 'Use + New plan to describe what you want changed. Conductor turns that into task-sized steps.',
		icon: ClipboardList,
		accent: 'accent',
	},
	{
		key: 'approve',
		title: 'Review or auto-run',
		description: 'Keep approvals on if you want to review the task list first, or turn on auto-execute to keep things moving.',
		icon: Sparkles,
		accent: 'warning',
	},
	{
		key: 'ship',
		title: 'Watch progress and ship',
		description: 'Conductor works through the plan, pulls finished work together, and can open a PR when it is ready.',
		icon: CheckCircle2,
		accent: 'accent',
	},
] as const;

const BOARD_COLUMN_HINTS: Record<ConductorTaskStatus, string> = {
	draft: 'Ideas still being shaped or tasks waiting for plan approval.',
	ready: 'Clear, approved work that can start when resources are free.',
	running: 'Active work in motion right now.',
	blocked: 'Needs input, a dependency, or manual intervention.',
	needs_review: 'Follow-ups worth sanity-checking before they run.',
	done: 'Completed work that is ready to integrate or already shipped.',
};

const FRIENDLY_TASK_STATUS_LABELS: Record<ConductorTaskStatus, string> = {
	draft: 'Brainstorm',
	ready: 'Ready',
	running: 'In progress',
	blocked: 'Needs input',
	needs_review: 'Check me',
	done: 'Done',
};

const FRIENDLY_TASK_SOURCE_LABELS: Record<ConductorTask['source'], string> = {
	manual: 'You added this',
	planner: 'Conductor planned this',
	worker_followup: 'Suggested follow-up',
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

function formatConductorStatusLabel(status?: string): string {
	switch (status) {
		case 'needs_setup':
			return 'Needs a lead agent';
		case 'awaiting_approval':
			return 'Waiting for your okay';
		case 'attention_required':
			return 'Needs your attention';
		case 'integrating':
			return 'Pulling results together';
		default:
			return status ? formatLabel(status) : 'Needs a lead agent';
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
		background: 'linear-gradient(180deg, rgba(255,255,255,0.15) 0%, rgba(255,255,255,0.07) 55%, rgba(255,255,255,0.03) 100%)',
		backgroundColor: theme.colors.bgMain,
		border: '1px solid rgba(255,255,255,0.10)',
		color: theme.colors.textMain,
		backdropFilter: 'blur(18px)',
		WebkitBackdropFilter: 'blur(18px)',
		boxShadow: '0 10px 20px rgba(15, 23, 42, 0.05), inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(255,255,255,0.02)',
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

function SummaryCard({
	label,
	value,
	detail,
	icon,
	theme,
	tone = 'default',
}: {
	label: string;
	value: string | number;
	detail?: string;
	icon: React.ReactNode;
	theme: Theme;
	tone?: 'default' | 'accent' | 'success' | 'warning';
}) {
	const toneColor =
		tone === 'success'
			? theme.colors.success
			: tone === 'warning'
				? theme.colors.warning
				: tone === 'accent'
					? theme.colors.accent
					: theme.colors.textDim;

	return (
		<div
			className="rounded-2xl border p-5 flex items-start justify-between gap-4"
			style={getGlassPanelStyle(theme, {
				tint: `${toneColor}12`,
				borderColor: tone === 'default' ? 'rgba(255, 255, 255, 0.10)' : `${toneColor}28`,
				elevated: true,
			})}
		>
			<div className="min-w-0">
				<div className="text-[11px] uppercase tracking-[0.18em]" style={{ color: theme.colors.textDim }}>
					{label}
				</div>
				<div className="text-3xl font-semibold mt-3" style={{ color: theme.colors.textMain }}>
					{value}
				</div>
				{detail && (
					<p className="text-sm mt-2 leading-6" style={{ color: theme.colors.textDim }}>
						{detail}
					</p>
				)}
			</div>
			<div
				className="w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0"
				style={{
					color: tone === 'default' ? theme.colors.accent : toneColor,
					background: `linear-gradient(180deg, ${toneColor}18 0%, rgba(255,255,255,0.06) 100%)`,
					border: `1px solid ${toneColor}24`,
					boxShadow: `0 14px 24px ${toneColor}12, inset 0 1px 0 rgba(255,255,255,0.10)`,
				}}
			>
				{icon}
			</div>
		</div>
	);
}

function getConductorEventTone(
	eventType: ConductorRunEvent['type']
): 'accent' | 'success' | 'warning' | 'default' {
	switch (eventType) {
		case 'task_completed':
		case 'execution_completed':
		case 'integration_completed':
		case 'validation_passed':
		case 'cleanup_completed':
		case 'pr_created':
			return 'success';
		case 'task_blocked':
		case 'planning_failed':
		case 'execution_failed':
		case 'integration_conflict':
		case 'validation_failed':
			return 'warning';
		case 'plan_generated':
		case 'plan_approved':
		case 'execution_started':
		case 'task_started':
		case 'integration_started':
		case 'branch_merged':
		case 'validation_started':
			return 'accent';
		default:
			return 'default';
	}
}

function getConductorEventIcon(
	eventType: ConductorRunEvent['type']
): React.ComponentType<{ className?: string }> {
	switch (eventType) {
		case 'task_completed':
		case 'execution_completed':
		case 'integration_completed':
		case 'validation_passed':
		case 'cleanup_completed':
		case 'pr_created':
			return CheckCircle2;
		case 'task_blocked':
		case 'planning_failed':
		case 'execution_failed':
		case 'integration_conflict':
		case 'validation_failed':
			return ShieldAlert;
		case 'execution_started':
		case 'task_started':
			return PlayCircle;
		case 'plan_generated':
		case 'plan_approved':
		case 'planning_started':
			return Sparkles;
		case 'integration_started':
		case 'branch_merged':
			return ArrowRight;
		default:
			return History;
	}
}

function formatTimestamp(value?: number): string {
	if (!value) {
		return 'Not recorded';
	}

	return new Date(value).toLocaleString();
}

function formatMemorySummary(snapshot: ResourceSnapshot | null): string {
	if (!snapshot) {
		return 'Unavailable';
	}

	const freeGb = ((snapshot.availableMemoryMB ?? snapshot.freeMemoryMB) / 1024).toFixed(1);
	const totalGb = (snapshot.totalMemoryMB / 1024).toFixed(1);
	return `${freeGb} GB available of ${totalGb} GB`;
}

function getTaskStatusTone(theme: Theme, status: ConductorTaskStatus): { bg: string; fg: string; border: string } {
	switch (status) {
		case 'done':
			return {
				bg: `${theme.colors.success}16`,
				fg: theme.colors.success,
				border: `${theme.colors.success}35`,
			};
		case 'blocked':
			return {
				bg: `${theme.colors.warning}16`,
				fg: theme.colors.warning,
				border: `${theme.colors.warning}35`,
			};
		case 'running':
			return {
				bg: `${theme.colors.accent}16`,
				fg: theme.colors.accent,
				border: `${theme.colors.accent}35`,
			};
		case 'needs_review':
			return {
				bg: `${theme.colors.accent}10`,
				fg: theme.colors.textMain,
				border: `${theme.colors.accent}28`,
			};
		default:
			return {
				bg: `${theme.colors.textDim}12`,
				fg: theme.colors.textDim,
				border: `${theme.colors.textDim}24`,
			};
	}
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
	const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
	const [draftDescription, setDraftDescription] = useState('');
	const [plannerNotes, setPlannerNotes] = useState('');
	const [planningError, setPlanningError] = useState<string | null>(null);
	const [isPlanning, setIsPlanning] = useState(false);
	const [executionError, setExecutionError] = useState<string | null>(null);
	const [isExecuting, setIsExecuting] = useState(false);
	const [integrationError, setIntegrationError] = useState<string | null>(null);
	const [isIntegrating, setIsIntegrating] = useState(false);
	const [validationDraft, setValidationDraft] = useState('');
	const [isCreatingPr, setIsCreatingPr] = useState(false);
	const [resourceSnapshot, setResourceSnapshot] = useState<ResourceSnapshot | null>(null);
	const [isCleaningUp, setIsCleaningUp] = useState(false);
	const groups = useSessionStore((s) => s.groups);
	const sessions = useSessionStore((s) => s.sessions);
	const allTasks = useConductorStore((s) => s.tasks);
	const allRuns = useConductorStore((s) => s.runs);
	const conductor = useConductorStore((s) =>
		s.conductors.find((candidate) => candidate.groupId === groupId)
	);
	const setTemplateSession = useConductorStore((s) => s.setTemplateSession);
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
	const tasks = useMemo(() => allTasks.filter((task) => task.groupId === groupId), [allTasks, groupId]);
	const runs = useMemo(() => allRuns.filter((run) => run.groupId === groupId), [allRuns, groupId]);
	const groupSessions = useMemo(
		() => sessions.filter((session) => session.groupId === groupId && !session.parentSessionId),
		[sessions, groupId]
	);
	const selectedTemplate = useMemo(
		() => groupSessions.find((session) => session.id === conductor?.templateSessionId) || null,
		[groupSessions, conductor?.templateSessionId]
	);
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
	const manualTasks = useMemo(
		() => tasks.filter((task) => task.source !== 'planner'),
		[tasks]
	);

	const taskCounts = useMemo(
		() => ({
			total: tasks.length,
			done: tasks.filter((task) => task.status === 'done').length,
			ready: tasks.filter((task) => task.status === 'ready').length,
			running: tasks.filter((task) => task.status === 'running').length,
			blocked: tasks.filter((task) => task.status === 'blocked').length,
			draft: plannerTasks.filter((task) => task.status === 'draft').length,
		}),
		[tasks, plannerTasks]
	);
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
				...task.scopePaths,
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
	}, [tasks, taskSearch, statusFilter, sourceFilter, sortMode]);
	const filteredTaskCountsByStatus = useMemo(
		() =>
			BOARD_COLUMNS.reduce<Record<ConductorTaskStatus, number>>((acc, status) => {
				acc[status] = filteredTasks.filter((task) => task.status === status).length;
				return acc;
			}, {
				draft: 0,
				ready: 0,
				running: 0,
				blocked: 0,
				needs_review: 0,
				done: 0,
			}),
		[filteredTasks]
	);

	const shippingComplete = Boolean(
		latestIntegrationRun &&
			latestIntegrationRun.status === 'completed' &&
			(conductor?.publishPolicy === 'none' || latestIntegrationRun.prUrl)
	);
	const percentComplete = taskCounts.total ? Math.round((taskCounts.done / taskCounts.total) * 100) : 0;
	const overviewCards = useMemo(
		() => [
			{
				label: 'Overall progress',
				value: `${percentComplete}%`,
				detail:
					taskCounts.total > 0
						? `${taskCounts.done} of ${taskCounts.total} tasks finished`
						: 'No tasks yet. Start a plan to give Conductor something to work through.',
				icon: <Activity />,
				tone: (taskCounts.done > 0 ? 'success' : 'default') as const,
			},
			{
				label: 'Active right now',
				value: taskCounts.running,
				detail:
					taskCounts.running > 0
						? `${taskCounts.ready} more waiting in line`
						: taskCounts.ready > 0
							? `${taskCounts.ready} ready to start`
							: 'Nothing is running right now',
				icon: <Users />,
				tone: (taskCounts.running > 0 ? 'accent' : 'default') as const,
			},
			{
				label: 'Needs your input',
				value: pendingRun ? 'Plan review' : taskCounts.blocked,
				detail: pendingRun
					? `${pendingRun.taskIds.length} planned task${pendingRun.taskIds.length === 1 ? '' : 's'} waiting for approval`
					: taskCounts.blocked > 0
						? `${taskCounts.blocked} task${taskCounts.blocked === 1 ? '' : 's'} blocked right now`
						: 'No blockers or approvals waiting on you',
				icon: <ShieldAlert />,
				tone: ((pendingRun || taskCounts.blocked > 0) ? 'warning' : 'default') as const,
			},
			{
				label: 'Shipping status',
				value: shippingComplete ? 'Ready' : latestIntegrationRun?.status === 'completed' ? 'PR next' : 'Not yet',
				detail: latestIntegrationRun?.prUrl
					? 'A pull request has already been opened for the latest result.'
					: latestIntegrationRun?.status === 'completed'
						? 'The latest result is merged together and ready to publish.'
						: latestExecutionRun?.status === 'completed'
							? 'Execution finished. The next step is pulling results together.'
							: 'Nothing ready to ship yet.',
				icon: <CheckCircle2 />,
				tone: (shippingComplete || latestIntegrationRun?.status === 'completed' ? 'success' : 'default') as const,
			},
		],
		[
			latestExecutionRun?.status,
			latestIntegrationRun?.prUrl,
			latestIntegrationRun?.status,
			pendingRun,
			percentComplete,
			shippingComplete,
			taskCounts.blocked,
			taskCounts.done,
			taskCounts.ready,
			taskCounts.running,
			taskCounts.total,
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
	const latestUpdate = recentEvents[0];
	const activeTemplateTab = useMemo(
		() => selectedTemplate?.aiTabs.find((tab) => tab.id === selectedTemplate.activeTabId),
		[selectedTemplate]
	);
	const resourceGate = useMemo(
		() => evaluateConductorResourceGate(conductor?.resourceProfile || 'balanced', resourceSnapshot),
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
	useEffect(() => {
		setValidationDraft(validationCommand);
	}, [validationCommand]);

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

	const clearTaskFilters = () => {
		setTaskSearch('');
		setStatusFilter('all');
		setSourceFilter('all');
		setSortMode('priority');
	};

	const handleGeneratePlan = async (options?: {
		requestOverride?: string;
		operatorNotesOverride?: string;
		autoExecute?: boolean;
	}) => {
		if (!conductor?.templateSessionId || !selectedTemplate) {
			setPlanningError('Pick a template session before generating a plan.');
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
			integrationBranch: '',
			status: 'planning',
			summary: '',
			plannerInput: operatorNotes.trim(),
			taskIds: [],
			events: [planningStartedEvent],
			startedAt: now,
		});

		try {
			const prompt = buildConductorPlannerPrompt({
				groupName: group?.name || 'Unnamed Group',
				templateSession: selectedTemplate,
				manualTasks: planningTasks,
				operatorNotes,
			});
			const response = await window.maestro.context.groomContext(
				selectedTemplate.cwd,
				selectedTemplate.toolType,
				prompt,
				{
					sshRemoteConfig: selectedTemplate.sessionSshRemoteConfig,
						customPath: selectedTemplate.customPath,
						customArgs: selectedTemplate.customArgs,
						customEnvVars: selectedTemplate.customEnvVars,
						customModel: selectedTemplate.customModel,
						reasoningEffort: activeTemplateTab?.reasoningEffort ?? 'default',
					}
				);
			const parsedPlan = parseConductorPlannerResponse(response);
			const titleToId = new Map<string, string>();
			const plannedTasks = parsedPlan.tasks.map((task) => {
				const taskId = `conductor-task-${generateId()}`;
				titleToId.set(task.title.trim().toLowerCase(), taskId);
				return {
					id: taskId,
					groupId,
					title: task.title,
					description: task.description,
					acceptanceCriteria: task.acceptanceCriteria,
					priority: task.priority,
					status: 'draft' as const,
					dependsOn: [],
					scopePaths: task.scopePaths,
					source: 'planner' as const,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				};
			});
			const plannedTasksWithDeps = plannedTasks.map((task, index) => ({
				...task,
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
				setActiveTab('backlog');
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
		} finally {
			setIsPlanning(false);
		}
	};

	const handleRunReadyTasks = async () => {
		if (!conductor?.templateSessionId || !selectedTemplate) {
			setExecutionError('Pick a template session before running tasks.');
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
			conductor.resourceProfile,
			currentSnapshot
		);
		if (!currentResourceGate.allowed) {
			setExecutionError(
				currentResourceGate.message || 'Conductor execution is paused by resource limits.'
			);
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

		upsertRun({
			id: runId,
			groupId,
			kind: 'execution',
			baseBranch,
			sshRemoteId,
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
					throw new Error(workerSetupResult.error || `Failed to create worktree for ${task.title}.`);
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
					const response = await window.maestro.context.groomContext(
						workerTarget.worktreePath,
						selectedTemplate.toolType,
						prompt,
						{
							sshRemoteConfig: selectedTemplate.sessionSshRemoteConfig,
							customPath: selectedTemplate.customPath,
							customArgs: selectedTemplate.customArgs,
							customEnvVars: selectedTemplate.customEnvVars,
							customModel: selectedTemplate.customModel,
							reasoningEffort: activeTemplateTab?.reasoningEffort ?? 'default',
						}
					);
					const result = parseConductorWorkerResponse(response);
					const finishedAt = Date.now();

					if (result.outcome === 'blocked') {
						const blockedReason = result.blockedReason || result.summary;
						updateTask(task.id, { status: 'blocked' });
						tasksById.set(task.id, { ...task, status: 'blocked', updatedAt: finishedAt });
						blockedTaskIds.add(task.id);
						events.push({
							id: `conductor-run-event-${generateId()}`,
							runId,
							groupId,
							type: 'task_blocked',
							message: `Blocked task: ${task.title}. ${blockedReason}`,
							createdAt: finishedAt,
						});
						updateRun(runId, { events: [...events] });
						return;
					}

					updateTask(task.id, { status: 'done' });
					tasksById.set(task.id, { ...task, status: 'done', updatedAt: finishedAt });
					completedTaskIds.add(task.id);

					if (result.followUpTasks.length > 0) {
						setTasks((previousTasks) => [
							...previousTasks,
							...result.followUpTasks.map((followUpTask) => ({
								id: `conductor-task-${generateId()}`,
								groupId,
								title: followUpTask.title,
								description: followUpTask.description,
								acceptanceCriteria: [],
								priority: followUpTask.priority,
								status: 'needs_review' as const,
								dependsOn: [],
								scopePaths: [],
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
								? `Completed task: ${task.title}. ${result.followUpTasks.length} follow-up task${result.followUpTasks.length === 1 ? '' : 's'} suggested.`
								: `Completed task: ${task.title}. ${result.summary}`,
						createdAt: finishedAt,
					});
					updateRun(runId, { events: [...events] });
				} finally {
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
					const remainingReady = Array.from(tasksById.values()).filter((task) => task.status === 'ready');
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
			setConductor(groupId, { status: finalBlocked ? 'blocked' : 'idle' });
			if (finalBlocked) {
				setExecutionError(
					blockedMessage || 'One or more tasks blocked during execution. Check the event feed for details.'
				);
			}
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
		} finally {
			setIsExecuting(false);
		}
	};

	const handleCleanupRunArtifacts = async (run: ConductorRun) => {
		if (!selectedTemplate) {
			setIntegrationError('Pick a template session before cleaning up run artifacts.');
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
			const repoRootResult = await window.maestro.git.getRepoRoot(selectedTemplate.cwd, sshRemoteId);
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
			const cleanupMessageParts = [`Cleaned ${cleanedWorktrees} worktree${cleanedWorktrees === 1 ? '' : 's'}.`];
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
			selectedTemplate.sessionSshRemoteConfig?.enabled && selectedTemplate.sessionSshRemoteConfig.remoteId
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
						message:
							mergeResult.conflicted
								? `Merge conflict while integrating ${branchName}.`
								: `Failed to integrate ${branchName}. ${mergeResult.error || ''}`.trim(),
						createdAt: eventTime,
					});
					updateRun(integrationRunId, {
						status: 'attention_required',
						summary:
							mergeResult.conflicted
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
			setConductor(groupId, { status: cleanupFailures.length === 0 ? 'idle' : 'attention_required' });
			if (cleanupFailures.length > 0) {
				setIntegrationError(cleanupFailures.join('\n'));
			}
		} finally {
			setIsIntegrating(false);
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
		return true;
	};

	const handleApprovePlan = () => {
		if (!pendingRun) {
			return;
		}

		approvePlanningRun(pendingRun.id);
	};

	const tabButtonClass =
		'px-4 py-2 rounded-lg text-sm font-medium transition-colors border border-transparent';
	const latestIntegrationIsRemote = Boolean(latestIntegrationRun?.sshRemoteId);

	return (
		<div className="flex-1 min-w-0 min-h-0 flex flex-col" style={{ backgroundColor: theme.colors.bgMain }}>
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
					<div className="text-xs uppercase tracking-[0.18em]" style={{ color: theme.colors.textDim }}>
						Conductor
					</div>
					<h1 className="text-2xl font-semibold mt-2" style={{ color: theme.colors.textMain }}>
						{group ? `${group.emoji} ${group.name}` : 'Unknown Group'}
					</h1>
					<p className="text-sm mt-2 max-w-3xl" style={{ color: theme.colors.textDim }}>
						Your project foreman for turning loose ideas into a reviewed plan, coordinated execution,
						and one clean branch to ship.
					</p>
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
							setActiveTab('backlog');
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
						{formatConductorStatusLabel(conductor?.status)}
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
					{(['overview', 'backlog', 'history'] as ConductorTab[]).map((tab) => (
						<button
							key={tab}
							onClick={() => setActiveTab(tab)}
							className={tabButtonClass}
							style={{
								...getGlassButtonStyle(theme, { active: activeTab === tab }),
								background: activeTab === tab
									? `linear-gradient(180deg, ${theme.colors.accent}16 0%, rgba(255,255,255,0.07) 100%)`
									: 'transparent',
								borderColor: activeTab === tab ? `${theme.colors.accent}26` : 'transparent',
								boxShadow: activeTab === tab
									? `inset 0 -2px 0 0 ${theme.colors.accent}, 0 10px 22px rgba(15, 23, 42, 0.08)`
									: 'none',
							}}
						>
							{tab === 'overview' ? 'Home' : tab === 'backlog' ? 'Tasks' : 'Runs'}
						</button>
					))}
				</div>
			</div>

			<div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 scrollbar-thin">
				{!conductor?.templateSessionId && (
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
									Pick the lead agent
								</div>
								<p className="text-sm mt-1 mb-4" style={{ color: theme.colors.textDim }}>
									Choose one existing session in this group. Conductor will copy its repo, tools, model
									settings, and env vars whenever it spins up workers.
								</p>
								<div className="flex flex-wrap gap-2">
									{groupSessions.length > 0 ? (
										groupSessions.map((session) => (
											<button
												key={session.id}
												onClick={() => setTemplateSession(groupId, session.id)}
												className="px-3 py-2 rounded-lg border text-sm transition-colors hover:bg-white/5"
												style={{
													borderColor: theme.colors.border,
													color: theme.colors.textMain,
												}}
											>
												{session.name}
											</button>
										))
									) : (
										<div className="text-sm" style={{ color: theme.colors.textDim }}>
											Create or move at least one AI session into this group before configuring
											Conductor.
										</div>
									)}
								</div>
							</div>
						</div>
					</div>
				)}

				{activeTab === 'overview' && (
					<div className="space-y-5">
						<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
							{overviewCards.map((card) => (
								<SummaryCard
									key={card.label}
									label={card.label}
									value={card.value}
									detail={card.detail}
									icon={card.icon}
									theme={theme}
									tone={card.tone}
								/>
							))}
						</div>

						<div
							className="rounded-2xl border p-5"
							style={getGlassPanelStyle(theme, {
								tint: 'rgba(255, 255, 255, 0.10)',
								borderColor: 'rgba(255, 255, 255, 0.08)',
								strong: true,
							})}
						>
							<div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4 mb-5">
								<div>
									<div className="flex items-center gap-2" style={{ color: theme.colors.textMain }}>
										<History className="w-4 h-4" />
										<h2 className="font-semibold">Recent updates</h2>
									</div>
									<p className="text-sm mt-2 leading-6 max-w-2xl" style={{ color: theme.colors.textDim }}>
										The latest plain-English updates from planning, execution, and shipping all show up here.
									</p>
								</div>
								<div className="flex flex-wrap items-center gap-2">
									{pendingRun && (
										<button
											onClick={handleApprovePlan}
											className="px-4 py-2 rounded-lg text-sm font-medium"
											style={getGlassButtonStyle(theme, { accent: true })}
										>
											Approve this plan
										</button>
									)}
									<button
										onClick={handleRunReadyTasks}
										disabled={isExecuting || taskCounts.ready === 0 || !!pendingRun}
										className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
										style={getGlassButtonStyle(theme)}
									>
										{isExecuting ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
										{isExecuting ? 'Running...' : 'Start the run'}
									</button>
									<button
										onClick={handleIntegrateCompletedWork}
										disabled={
											isIntegrating ||
											!latestExecutionRun?.taskBranches ||
											Object.keys(latestExecutionRun.taskBranches).length === 0
										}
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
									<button
										onClick={handleCreateIntegrationPr}
										disabled={
											isCreatingPr ||
											conductor?.publishPolicy === 'none' ||
											!latestIntegrationRun?.worktreePath ||
											latestIntegrationRun.status === 'integrating'
										}
										className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
										style={getGlassButtonStyle(theme)}
									>
										{isCreatingPr ? <Loader2 className="w-4 h-4 animate-spin" /> : <History className="w-4 h-4" />}
										{isCreatingPr ? 'Creating PR...' : 'Open a PR'}
									</button>
									{latestIntegrationRun?.prUrl && (
										<button
											onClick={() => void window.maestro.shell.openExternal(latestIntegrationRun.prUrl!)}
											className="px-4 py-2 rounded-lg text-sm font-medium inline-flex items-center gap-2"
											style={getGlassButtonStyle(theme)}
										>
											<ExternalLink className="w-4 h-4" />
											Open pull request
										</button>
									)}
									{advancedMode && latestIntegrationRun?.worktreePath && (
										<button
											onClick={() =>
												latestIntegrationIsRemote
													? void handleCopyRemotePath(latestIntegrationRun.worktreePath!)
													: void window.maestro.shell.openPath(latestIntegrationRun.worktreePath!)
											}
											className="px-4 py-2 rounded-lg text-sm font-medium inline-flex items-center gap-2"
											style={getGlassButtonStyle(theme)}
										>
											{latestIntegrationIsRemote ? <Copy className="w-4 h-4" /> : <FolderOpen className="w-4 h-4" />}
											{latestIntegrationIsRemote ? 'Copy remote folder path' : 'Open local folder'}
										</button>
									)}
									{advancedMode && (
										<button
											onClick={() =>
												void handleCleanupRunArtifacts(latestIntegrationRun || latestExecutionRun || latestRun!)
											}
											disabled={
												isCleaningUp ||
												(!latestIntegrationRun && !latestExecutionRun && !latestRun) ||
												(latestIntegrationRun
													? collectRunArtifactPaths(latestIntegrationRun).length === 0
													: latestExecutionRun
														? collectRunArtifactPaths(latestExecutionRun).length === 0
														: collectRunArtifactPaths(latestRun).length === 0)
											}
											className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
											style={getGlassButtonStyle(theme)}
										>
											{isCleaningUp ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
											{isCleaningUp ? 'Cleaning...' : 'Clean up leftovers'}
										</button>
									)}
								</div>
							</div>

							<div className="grid grid-cols-1 xl:grid-cols-[1.05fr,1.95fr] gap-4">
								<div className="space-y-4">
									<div
										className="rounded-2xl border p-4"
										style={{
											...getGlassPanelStyle(theme, {
												tint: latestUpdate
													? `${
															getConductorEventTone(latestUpdate.event.type) === 'success'
																? theme.colors.success
																: getConductorEventTone(latestUpdate.event.type) === 'warning'
																	? theme.colors.warning
																	: getConductorEventTone(latestUpdate.event.type) === 'accent'
																		? theme.colors.accent
																		: theme.colors.textDim
														}12`
													: 'rgba(255,255,255,0.10)',
												borderColor: latestUpdate
													? `${
															getConductorEventTone(latestUpdate.event.type) === 'success'
																? theme.colors.success
																: getConductorEventTone(latestUpdate.event.type) === 'warning'
																	? theme.colors.warning
																	: getConductorEventTone(latestUpdate.event.type) === 'accent'
																		? theme.colors.accent
																		: theme.colors.textDim
														}2a`
													: 'rgba(255,255,255,0.10)',
											}),
											background: latestUpdate
												? `linear-gradient(135deg, ${
														getConductorEventTone(latestUpdate.event.type) === 'success'
															? theme.colors.success
															: getConductorEventTone(latestUpdate.event.type) === 'warning'
																? theme.colors.warning
																: getConductorEventTone(latestUpdate.event.type) === 'accent'
																	? theme.colors.accent
																	: theme.colors.textDim
													}10 0%, ${theme.colors.bgMain} 100%)`
												: theme.colors.bgMain,
											borderColor: latestUpdate
												? `${
														getConductorEventTone(latestUpdate.event.type) === 'success'
															? theme.colors.success
															: getConductorEventTone(latestUpdate.event.type) === 'warning'
																? theme.colors.warning
																: getConductorEventTone(latestUpdate.event.type) === 'accent'
																	? theme.colors.accent
																	: theme.colors.textDim
													}2a`
												: theme.colors.border,
										}}
									>
										<div className="text-[11px] uppercase tracking-[0.18em]" style={{ color: theme.colors.textDim }}>
											Latest update
										</div>
										{latestUpdate ? (
											<>
												<div className="font-semibold text-lg mt-3" style={{ color: theme.colors.textMain }}>
													{latestUpdate.event.message}
												</div>
												<div className="text-sm mt-2 leading-6" style={{ color: theme.colors.textDim }}>
													{formatLabel(latestUpdate.runKind)} run · {formatTimestamp(latestUpdate.event.createdAt)}
												</div>
											</>
										) : (
											<p className="text-sm mt-3 leading-6" style={{ color: theme.colors.textDim }}>
												Once you create a plan, Conductor will start narrating the important moments here.
											</p>
										)}
									</div>

									{latestPlanningRun?.summary && (
										<div
										className="rounded-2xl border p-4"
										style={getGlassPanelStyle(theme)}
									>
											<div className="text-[11px] uppercase tracking-[0.18em]" style={{ color: theme.colors.textDim }}>
												Latest plan summary
											</div>
											<p className="text-sm mt-3 leading-6" style={{ color: theme.colors.textMain }}>
												{latestPlanningRun.summary}
											</p>
										</div>
									)}

									{(executionError || integrationError) && (
										<div
										className="rounded-2xl border p-4 text-sm"
										style={{
											...getGlassPanelStyle(theme, {
												tint: `${theme.colors.warning}12`,
												borderColor: `${theme.colors.warning}35`,
											}),
											color: theme.colors.warning,
										}}
										>
											{executionError || integrationError}
										</div>
									)}
								</div>

								<div className="space-y-3">
									{recentEvents.length ? (
										recentEvents.map(({ event, runKind, runStatus }) => {
											const tone = getConductorEventTone(event.type);
											const toneColor =
												tone === 'success'
													? theme.colors.success
													: tone === 'warning'
														? theme.colors.warning
														: tone === 'accent'
															? theme.colors.accent
															: theme.colors.textDim;
											const EventIcon = getConductorEventIcon(event.type);

											return (
												<div
													key={event.id}
													className="rounded-2xl border p-4"
													style={{
														...getGlassPanelStyle(theme, {
															tint: `${toneColor}10`,
															borderColor: tone === 'default' ? 'rgba(255,255,255,0.10)' : `${toneColor}28`,
														}),
													}}
												>
													<div className="flex items-start gap-3">
														<div
															className="w-10 h-10 rounded-xl border flex items-center justify-center flex-shrink-0"
															style={{
																backgroundColor: `${toneColor}12`,
																borderColor: `${toneColor}28`,
																color: toneColor,
															}}
														>
															<EventIcon className="w-4 h-4" />
														</div>
														<div className="min-w-0 flex-1">
															<div className="flex flex-wrap items-center gap-2">
																<span
																	className="px-2.5 py-1 rounded-full text-[11px] uppercase tracking-[0.16em]"
																	style={{
																		backgroundColor: `${toneColor}12`,
																		color: toneColor,
																	}}
																>
																	{formatLabel(runKind)}
																</span>
																<span
																	className="text-[11px] uppercase tracking-[0.16em]"
																	style={{ color: theme.colors.textDim }}
																>
																	{formatConductorStatusLabel(runStatus)}
																</span>
															</div>
															<div className="text-sm mt-3 leading-6" style={{ color: theme.colors.textMain }}>
																{event.message}
															</div>
															<div className="text-xs mt-3" style={{ color: theme.colors.textDim }}>
																{formatTimestamp(event.createdAt)}
															</div>
														</div>
													</div>
												</div>
											);
										})
									) : (
										<div
											className="rounded-2xl border p-6"
											style={getGlassPanelStyle(theme)}
										>
											<div className="font-semibold" style={{ color: theme.colors.textMain }}>
												No updates yet
											</div>
											<p className="text-sm mt-2 leading-6" style={{ color: theme.colors.textDim }}>
												Create a plan and this feed will turn into a clean timeline of planning, work in motion,
												and shipping updates.
											</p>
										</div>
									)}
								</div>
							</div>
						</div>
					</div>
				)}

					{activeTab === 'backlog' && (
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
										<div className="flex items-center gap-2" style={{ color: theme.colors.textMain }}>
											<CheckCircle2 className="w-4 h-4" />
											<h2 className="font-semibold">Give this plan a quick okay</h2>
										</div>
										<p className="text-sm mt-2" style={{ color: theme.colors.textDim }}>
											Check that the breakdown looks sane. Once you approve it, Conductor can start working
											through the approved items.
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
										disabled={isExecuting || taskCounts.ready === 0 || !!pendingRun}
										className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
										style={getGlassButtonStyle(theme, { accent: true })}
									>
										{isExecuting ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
										{isExecuting ? 'Running...' : 'Start the run'}
									</button>
									<button
										onClick={handleIntegrateCompletedWork}
										disabled={
											isIntegrating ||
											!latestExecutionRun?.taskBranches ||
											Object.keys(latestExecutionRun.taskBranches).length === 0
										}
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
									<button
										onClick={handleCreateIntegrationPr}
										disabled={
											isCreatingPr ||
											!latestIntegrationRun?.worktreePath ||
											latestIntegrationRun.status === 'integrating'
										}
										className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
										style={getGlassButtonStyle(theme)}
									>
										{isCreatingPr ? <Loader2 className="w-4 h-4 animate-spin" /> : <History className="w-4 h-4" />}
										{isCreatingPr ? 'Creating PR...' : 'Open a PR'}
									</button>
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
								<div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
									<div>
										<div className="flex items-center gap-2" style={{ color: theme.colors.textMain }}>
											<FolderKanban className="w-4 h-4" />
											<h2 className="font-semibold">Your task space</h2>
										</div>
										<p className="text-sm mt-2" style={{ color: theme.colors.textDim }}>
										Use the board when you want the big picture. Switch to the list when you need to search,
										sort, and tidy up details.
										</p>
									</div>
									<div className="flex items-center gap-2">
										<button
											onClick={() => setBacklogView('board')}
											className="px-3 py-2 rounded-lg text-sm font-medium inline-flex items-center gap-2"
											style={getGlassButtonStyle(theme, { active: backlogView === 'board' })}
										>
											<LayoutGrid className="w-4 h-4" />
											Board view
										</button>
										<button
											onClick={() => setBacklogView('table')}
											className="px-3 py-2 rounded-lg text-sm font-medium inline-flex items-center gap-2"
											style={getGlassButtonStyle(theme, { active: backlogView === 'table' })}
										>
											<Rows3 className="w-4 h-4" />
											List view
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
											<option value="worker_followup">{formatTaskSourceLabel('worker_followup')}</option>
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

								<div className="flex flex-wrap items-center justify-between gap-3">
									<div className="flex flex-wrap items-center gap-2 text-xs">
										<span
											className="px-2.5 py-1 rounded-full border"
											style={{
												backgroundColor: `${theme.colors.accent}10`,
												borderColor: `${theme.colors.accent}30`,
												color: theme.colors.accent,
											}}
										>
											Showing {filteredTasks.length} of {tasks.length}
										</span>
										{BOARD_COLUMNS.map((status) => {
											const tone = getTaskStatusTone(theme, status);
											return (
												<span
													key={status}
													className="px-2.5 py-1 rounded-full border"
													style={{
														backgroundColor: tone.bg,
														borderColor: tone.border,
														color: tone.fg,
													}}
												>
													{formatTaskStatusLabel(status)} {filteredTaskCountsByStatus[status]}
												</span>
											);
										})}
									</div>
									<button
										onClick={clearTaskFilters}
										className="px-3 py-2 rounded-lg text-sm font-medium"
										style={getGlassButtonStyle(theme)}
									>
										Clear filters
									</button>
								</div>

								{tasks.length === 0 ? (
									<div
										className="rounded-xl border p-8 text-center"
										style={{ ...getGlassPanelStyle(theme), color: theme.colors.textDim }}
									>
										Your wish list is empty. Add a change you want, then let Conductor turn it into a plan.
									</div>
								) : backlogView === 'board' ? (
									<div className="overflow-x-auto pb-2 scrollbar-thin">
										<div className="grid grid-cols-1 xl:grid-cols-3 2xl:grid-cols-6 gap-4 min-w-[1200px] 2xl:min-w-0">
										{BOARD_COLUMNS.map((status) => {
											const columnTasks = filteredTasks.filter((task) => task.status === status);
											const tone = getTaskStatusTone(theme, status);
											return (
												<div
													key={status}
													className="rounded-xl border p-3 min-h-[280px]"
													onDragOver={(e) => {
														e.preventDefault();
													}}
													onDrop={() => {
														if (draggedTaskId) {
															handleTaskStatusMove(draggedTaskId, status);
															setDraggedTaskId(null);
														}
													}}
													style={getGlassPanelStyle(theme, {
														tint: `${tone.fg}08`,
														borderColor: tone.border,
													})}
												>
													<div className="flex items-center justify-between gap-2 mb-3">
														<div>
															<div className="font-semibold" style={{ color: theme.colors.textMain }}>
																{formatTaskStatusLabel(status)}
															</div>
															<div className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
																{columnTasks.length} task{columnTasks.length === 1 ? '' : 's'}
															</div>
															<div
																className="text-xs mt-2 leading-5"
																style={{ color: theme.colors.textDim }}
															>
																{BOARD_COLUMN_HINTS[status]}
															</div>
														</div>
														<span
															className="px-2 py-1 rounded-full border text-[11px] uppercase tracking-wide"
															style={{
																backgroundColor: tone.bg,
																borderColor: tone.border,
																color: tone.fg,
															}}
														>
															{formatTaskStatusLabel(status)}
														</span>
													</div>

													<div className="space-y-3">
														{columnTasks.length > 0 ? (
															columnTasks.map((task) => {
																const statusTone = getTaskStatusTone(theme, task.status);
																const priorityTone = getTaskPriorityTone(theme, task.priority);
																return (
																	<div
																		key={task.id}
																		draggable
																		onDragStart={() => setDraggedTaskId(task.id)}
																		onDragEnd={() => setDraggedTaskId(null)}
																		className="rounded-xl border p-3 cursor-grab active:cursor-grabbing"
																		style={getGlassPanelStyle(theme, {
																			tint:
																				draggedTaskId === task.id
																					? `${theme.colors.accent}12`
																					: 'rgba(255,255,255,0.09)',
																			borderColor:
																				draggedTaskId === task.id
																					? `${theme.colors.accent}45`
																					: 'rgba(255,255,255,0.08)',
																		})}
																	>
																		<div className="flex items-start justify-between gap-3">
																			<div className="flex-1 min-w-0">
																				<div className="flex items-start gap-2">
																					<div
																						className="mt-0.5"
																						style={{ color: theme.colors.textDim }}
																					>
																						<Rows3 className="w-4 h-4" />
																					</div>
																					<div className="min-w-0 flex-1">
																						<div
																							className="font-semibold"
																							style={{ color: theme.colors.textMain }}
																						>
																							{task.title}
																						</div>
																						{task.description && (
																							<p
																								className="text-sm mt-2 line-clamp-3"
																								style={{ color: theme.colors.textDim }}
																							>
																								{task.description}
																							</p>
																						)}
																					</div>
																				</div>
																			</div>
																			<button
																				onClick={() => deleteTask(task.id)}
																				className="p-2 rounded-lg hover:bg-white/5"
																				title="Delete task"
																				style={{ color: theme.colors.textDim }}
																			>
																				<Trash2 className="w-4 h-4" />
																			</button>
																		</div>

																		<div className="flex flex-wrap gap-2 mt-3">
																			<span
																				className="px-2 py-1 rounded-full border text-[11px] uppercase tracking-wide"
																				style={{
																					backgroundColor: priorityTone.bg,
																					borderColor: priorityTone.border,
																					color: priorityTone.fg,
																				}}
																			>
																				{task.priority}
																			</span>
																			<span
																				className="px-2 py-1 rounded-full border text-[11px] uppercase tracking-wide"
																				style={{
																					backgroundColor: statusTone.bg,
																					borderColor: statusTone.border,
																					color: statusTone.fg,
																				}}
																			>
																				{formatTaskStatusLabel(task.status)}
																			</span>
																			<span
																				className="px-2 py-1 rounded-full border text-[11px] uppercase tracking-wide"
																				style={{
																					backgroundColor:
																						task.source === 'planner'
																							? `${theme.colors.accent}12`
																							: `${theme.colors.textDim}10`,
																					borderColor:
																						task.source === 'planner'
																							? `${theme.colors.accent}24`
																							: `${theme.colors.textDim}20`,
																					color:
																						task.source === 'planner'
																							? theme.colors.accent
																							: theme.colors.textDim,
																				}}
																			>
																				{formatTaskSourceLabel(task.source)}
																			</span>
																		</div>

																		<div className="grid grid-cols-2 gap-2 mt-3 text-xs">
																			<div
																				className="rounded-lg border px-2 py-2"
																				style={{ ...getGlassPanelStyle(theme), color: theme.colors.textDim }}
																			>
																				<div>Deps</div>
																				<div style={{ color: theme.colors.textMain }}>
																					{task.dependsOn.length}
																				</div>
																			</div>
																			<div
																				className="rounded-lg border px-2 py-2"
																				style={{ ...getGlassPanelStyle(theme), color: theme.colors.textDim }}
																			>
																				<div>Scope</div>
																				<div style={{ color: theme.colors.textMain }}>
																					{task.scopePaths.length}
																				</div>
																			</div>
																		</div>

																		{task.scopePaths.length > 0 && (
																			<div
																				className="text-xs mt-3 line-clamp-2"
																				style={{ color: theme.colors.textDim }}
																			>
																				Scope: {task.scopePaths.join(', ')}
																			</div>
																		)}

																		<div className="flex flex-wrap gap-2 mt-3">
																			<select
																				value={task.status}
																				onChange={(e) =>
																					updateTask(task.id, {
																						status: e.target.value as ConductorTaskStatus,
																					})
																				}
																				className="rounded-lg border px-2 py-2 text-xs"
																				style={getGlassInputStyle(theme)}
																			>
																				{STATUS_OPTIONS.map((option) => (
																					<option key={option} value={option}>
																						{formatTaskStatusLabel(option)}
																					</option>
																				))}
																			</select>
																			<select
																				value={task.priority}
																				onChange={(e) =>
																					updateTask(task.id, {
																						priority: e.target.value as ConductorTaskPriority,
																					})
																				}
																				className="rounded-lg border px-2 py-2 text-xs"
																				style={getGlassInputStyle(theme)}
																			>
																				{PRIORITY_OPTIONS.map((option) => (
																					<option key={option} value={option}>
																						{formatLabel(option)}
																					</option>
																				))}
																			</select>
																		</div>
																	</div>
																);
															})
														) : (
															<div
																className="rounded-lg border border-dashed p-4 text-sm"
																style={{
																	backgroundColor: `${theme.colors.textDim}08`,
																	borderColor: `${theme.colors.textDim}22`,
																	color: theme.colors.textDim,
																}}
															>
																Drop a task here or adjust filters to surface this lane.
															</div>
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
													gridTemplateColumns: 'minmax(260px,2fr) 110px 110px 140px 100px 120px 120px 72px',
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
														return (
															<div
																key={task.id}
																className="grid gap-3 px-4 py-4 items-start"
																style={{
																	gridTemplateColumns:
																		'minmax(260px,2fr) 110px 110px 140px 100px 120px 120px 72px',
																}}
															>
																<div className="min-w-0">
																	<div className="font-semibold" style={{ color: theme.colors.textMain }}>
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
																	{task.scopePaths.length > 0 && (
																		<div className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
																			{task.scopePaths.join(', ')}
																		</div>
																	)}
																</div>
																<div>
																	<select
																		value={task.status}
																		onChange={(e) =>
																			updateTask(task.id, {
																				status: e.target.value as ConductorTaskStatus,
																			})
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
													<div className="px-4 py-10 text-center" style={{ color: theme.colors.textDim }}>
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
													Type: {(run.kind || 'planning').replace(/^\w/, (char) => char.toUpperCase())}
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
													<div className="text-sm mt-1 break-all" style={{ color: theme.colors.textDim }}>
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
											{isCleaningUp ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
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
							<div className="flex items-center gap-2 mb-2" style={{ color: theme.colors.textMain }}>
								<Sparkles className="w-4 h-4" />
								<h2 className="font-semibold">How Conductor works</h2>
							</div>
							<p className="text-sm leading-6 mb-4" style={{ color: theme.colors.textDim }}>
								Conductor is easiest when you treat it like a lead dev for this group: pick one trusted
								agent, describe the changes you want, then decide whether you want to review the plan or
								let it keep moving.
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
													<p className="text-sm leading-6 mt-2" style={{ color: theme.colors.textDim }}>
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
								Use one trusted session as the lead. Conductor copies its environment, then handles the
								rest. Defaults are already selected, so most people can leave advanced controls alone.
							</p>
							<div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm mb-4">
								<div
									className="rounded-2xl border p-4"
									style={getGlassPanelStyle(theme)}
								>
									<div style={{ color: theme.colors.textDim }}>Lead agent</div>
									<div className="font-semibold mt-2" style={{ color: theme.colors.textMain }}>
										{selectedTemplate?.name || 'Not configured'}
									</div>
								</div>
								<div
									className="rounded-2xl border p-4"
									style={getGlassPanelStyle(theme)}
								>
									<div style={{ color: theme.colors.textDim }}>Work style</div>
									<div className="font-semibold mt-2" style={{ color: theme.colors.textMain }}>
										{formatLabel(conductor?.resourceProfile || 'balanced')}
									</div>
								</div>
							</div>
							{!advancedMode && (
								<div
									className="rounded-2xl border p-4 text-sm"
									style={getGlassPanelStyle(theme)}
								>
									<div className="font-semibold" style={{ color: theme.colors.textMain }}>
										Defaults selected
									</div>
									<div className="mt-2 leading-6" style={{ color: theme.colors.textDim }}>
										Resource profile: {formatLabel(conductor?.resourceProfile || 'balanced')}
										<br />
										Publish policy: {conductor?.publishPolicy === 'none' ? 'No publish action' : 'Manual PR'}
										<br />
										Auto execute tasks: {conductor?.autoExecuteOnPlanCreation ? 'On' : 'Off'}
									</div>
								</div>
							)}
							{advancedMode && (
								<div
									className="rounded-2xl border p-4"
									style={getGlassPanelStyle(theme)}
								>
									<div className="space-y-3 text-sm">
										<div>
											<div className="mb-2" style={{ color: theme.colors.textDim }}>
												Resource profile
											</div>
											<select
												value={conductor?.resourceProfile || 'balanced'}
												onChange={(e) =>
													setConductor(groupId, {
														resourceProfile: e.target.value as 'conservative' | 'balanced' | 'aggressive',
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
							<div className="flex items-center gap-2 mb-3" style={{ color: theme.colors.textMain }}>
								<FolderKanban className="w-4 h-4" />
								<h2 className="font-semibold">How fast Conductor should go</h2>
							</div>
							<p className="text-sm leading-6 mb-4" style={{ color: theme.colors.textDim }}>
								Conductor slows itself down when your machine is under pressure, so you do not have to
								think about worker counts all day.
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
								{resourceGate.message && <div style={{ color: theme.colors.warning }}>{resourceGate.message}</div>}
							</div>
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
								disabled={isPlanning || !conductor?.templateSessionId || !draftDescription.trim()}
								className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
								style={getGlassButtonStyle(theme, { accent: true })}
							>
								{isPlanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
								{isPlanning ? 'Planning...' : 'Submit plan'}
							</button>
						</div>
					</div>
				</Modal>
			)}
		</div>
	);
}
