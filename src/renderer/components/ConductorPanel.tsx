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
	MessageSquarePlus,
	PauseCircle,
	PlayCircle,
	Rows3,
	Search,
	Settings2,
	ShieldAlert,
	Square,
	Trash2,
	Users,
} from 'lucide-react';
import type {
	Theme,
	ConductorRun,
	ConductorTask,
	ConductorAgentRole,
	ConductorTaskAgentHistoryEntry,
	ConductorTaskAttentionRequest,
	ConductorProviderAgent,
	ConductorProviderChoice,
	ConductorProviderRouteKey,
	ConductorTaskStatus,
	ConductorTaskPriority,
	ConductorTaskCompletionProofRequirement,
	ConductorTaskCompletionProofStatus,
	ConductorRunEvent,
	LogEntry,
	Session,
} from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useSessionStore } from '../stores/sessionStore';
import { useConductorStore } from '../stores/conductorStore';
import { generateId } from '../utils/ids';
import { notifyToast } from '../stores/notificationStore';
import { getModalActions } from '../stores/modalStore';
import { safeClipboardWrite } from '../utils/clipboard';
import {
	buildConductorPlannerPrompt,
	parseConductorPlannerSubmission,
	parseConductorPlannerResponse,
} from '../services/conductorPlanner';
import {
	CONDUCTOR_REVIEWER_JSON_ERROR,
	buildConductorReviewerPrompt,
	parseConductorReviewerSubmission,
	parseConductorReviewerResponse,
} from '../services/conductorReviewer';
import { ConductorAgentRunError, runConductorAgentTurn } from '../services/conductorAgentRuntime';
import {
	buildConductorWorkerPrompt,
	parseConductorWorkerSubmission,
	parseConductorWorkerResponse,
} from '../services/conductorWorker';
import { buildConductorProofPrompt } from '../services/conductorProof';
import {
	buildConductorIntegrationTarget,
	buildConductorWorktreeTarget,
	evaluateConductorResourceGate,
	tasksConflict,
} from '../services/conductorRuntime';
import { getRuntimeIdForThread, getSessionLastActivity } from '../utils/workspaceThreads';
import { getProviderDisplayName } from '../utils/sessionValidation';
import { Modal } from './ui/Modal';
import { DemoCardPanel } from './DemoCardPanel';
import { DemoViewerModal } from './DemoViewerModal';
import { ToolActivityBlock } from './ToolActivityBlock';
import { ConductorTeamPanel, type ConductorTeamMember } from './conductor/ConductorTeamPanel';
import { ConductorOrchestratorPanel } from './conductor/ConductorOrchestratorPanel';
import { ConductorUpdatesPanel } from './conductor/ConductorUpdatesPanel';
import { KANBAN_LANES, PRIORITY_OPTIONS, formatLabel } from './conductor/conductorConstants';
import { ConductorAttentionBanner, type AttentionItem } from './conductor/ConductorAttentionBanner';
import { ConductorTaskComposer } from './conductor/ConductorTaskComposer';
import { ConductorPlanComposer } from './conductor/ConductorPlanComposer';
import {
	getGlassPanelStyle,
	getGlassButtonStyle,
	getGlassInputStyle,
	getGlassPillStyle,
	PASTEL_STATUS_TONES,
	getTaskStatusTone,
	getTaskPriorityTone,
} from './conductor/conductorStyles';
import {
	buildConductorChildTaskMap,
	buildDefaultConductorTaskCompletionProof,
	buildDefaultConductorTaskCompletionProofRequirement,
	CONDUCTOR_QA_QUARANTINE_FAILURE_COUNT,
	eventRelatesToConductorTask,
	formatConductorOperatorMessage,
	hasConductorTaskApprovedCompletionProof,
	getConductorTaskAttentionBlockers,
	getConductorTaskQaFailureState,
	getConductorTaskVisibleAttention,
	isConductorTaskAgentRevision,
	isConductorCompletionProofAttentionRequestId,
	isConductorTaskOperatorActionRequired,
	isConductorTaskRunnableByAgent,
	getConductorTaskOpenFollowUps,
	getConductorTaskProgress,
	getConductorTaskRollupStatus,
	getEffectiveConductorTaskAttentionRequest,
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
import type { DemoCard, DemoDetail } from '../../shared/demo-artifacts';
import { isCompletedDemoCapture } from '../../shared/demo-artifacts';

interface ConductorPanelProps {
	theme: Theme;
	groupId: string;
}

type ConductorTab = 'overview' | 'history';
type BacklogView = 'board' | 'table';
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
	'needs_revision',
	'needs_input',
	'blocked',
	'needs_review',
	'needs_proof',
	'cancelled',
	'done',
];

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
	'needs_review',
	'needs_proof',
	'needs_revision',
	'needs_input',
	'blocked',
	'cancelled',
	'done',
];
const CONDUCTOR_BOARD_MAX_HEIGHT = 'clamp(320px, 62vh, 760px)';
const CONDUCTOR_STALE_TASK_RECOVERY_MS = 90_000;
const CONDUCTOR_AUTOPLAY_RETRY_COOLDOWN_MS = 5 * 60_000;
const conductorAutoplayLocks = {
	planning: new Set<string>(),
	execution: new Set<string>(),
	review: new Set<string>(),
};


const FRIENDLY_TASK_STATUS_LABELS: Record<ConductorTaskStatus, string> = {
	draft: 'Brainstorm',
	planning: 'Planning',
	ready: 'Ready',
	running: 'In progress',
	needs_revision: 'Agents revising',
	needs_input: 'Waiting on you',
	needs_proof: 'Needs proof',
	blocked: 'Blocked',
	needs_review: 'In QA',
	cancelled: 'Stopped',
	done: 'Done',
};

const COMPLETION_PROOF_STATUS_OPTIONS: ConductorTaskCompletionProofStatus[] = [
	'missing',
	'capturing',
	'captured',
	'approved',
	'rejected',
];

const COMPLETION_PROOF_STATUS_LABELS: Record<ConductorTaskCompletionProofStatus, string> = {
	missing: 'Missing',
	capturing: 'Capturing',
	captured: 'Captured',
	approved: 'Approved',
	rejected: 'Rejected',
};

type CompletionProofTone = 'warning' | 'accent' | 'success' | 'error';

interface CompletionProofCardState {
	label: string;
	tone: CompletionProofTone;
}

function getCompletionProofCardState(
	task: ConductorTask,
	rolledUpStatus: ConductorTaskStatus
): CompletionProofCardState | null {
	if (!requiresConductorTaskCompletionProof(task)) {
		return null;
	}

	switch (task.completionProof?.status || 'missing') {
		case 'approved':
			return { label: 'Proof approved', tone: 'success' };
		case 'captured':
			return { label: 'Proof captured', tone: 'accent' };
		case 'capturing':
			return { label: 'Capturing proof', tone: 'accent' };
		case 'rejected':
			return { label: 'Proof rejected', tone: 'error' };
		case 'missing':
		default:
			return rolledUpStatus === 'needs_proof'
				? { label: 'Proof required', tone: 'warning' }
				: null;
	}
}

function getCompletionProofTint(theme: Theme, tone: CompletionProofTone): string {
	switch (tone) {
		case 'success':
			return theme.colors.success;
		case 'warning':
			return theme.colors.warning;
		case 'error':
			return theme.colors.error;
		case 'accent':
		default:
			return theme.colors.accent;
	}
}

const FRIENDLY_TASK_SOURCE_LABELS: Record<ConductorTask['source'], string> = {
	manual: 'You added this',
	planner: 'Conductor planned this',
	worker_followup: 'Suggested follow-up',
	reviewer_followup: 'Reviewer follow-up',
};


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
		case 'paused':
			return 'Paused';
		case 'pausing':
			return 'Pausing after current work';
		case 'holding':
			return 'Waiting to resume';
		default:
			return status ? formatLabel(status) : 'Needs a workspace agent';
	}
}

function satisfiesConductorTaskCompletionProofRequirement(
	demoCard: DemoCard,
	requirement: ConductorTaskCompletionProofRequirement
): boolean {
	return (
		isCompletedDemoCapture(demoCard) &&
		(!requirement.requireVideo || Boolean(demoCard.videoArtifact)) &&
		demoCard.stepCount >= Math.max(0, requirement.minScreenshots || 0)
	);
}

const USER_PAUSED_MESSAGE = 'Paused by you.';
const USER_PAUSING_MESSAGE = 'Pausing after the current work finishes.';
const RESOURCE_HOLD_MESSAGE = 'Conductor is waiting for system resources.';
const PROVIDER_LIMIT_HOLD_PATTERN =
	/(you(?:'|')ve hit your limit|resets?\s+\d|quota|rate limit|out of credits|no credits|subscription.*exhausted)/i;

function isConductorProviderLimitMessage(message: string | null | undefined): boolean {
	return Boolean(message && PROVIDER_LIMIT_HOLD_PATTERN.test(message));
}

function normalizeConductorTaskDuplicateKey(task: ConductorTask): string {
	return `${task.parentTaskId || 'root'}::${task.title.trim().toLowerCase().replace(/\s+/g, ' ')}`;
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
		case 'task_needs_proof':
		case 'task_needs_revision':
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

const OPERATOR_BLOCK_REASON_PATTERN =
	/\b(user|operator|approval|approve|confirm|credentials?|token|api key|access|permission|subscription|billing|design preference|preference|which option|what should|do you want|external dependency)\b/i;

function shouldRouteWorkerBlockToOperator(blockedReason: string): boolean {
	return OPERATOR_BLOCK_REASON_PATTERN.test(blockedReason);
}

function buildConductorWorkerClarificationPrompt(input: {
	groupName: string;
	task: ConductorTask;
	templateSession: Session;
	dependencyTitles: string[];
	blockedReason: string;
}): string {
	const acceptanceCriteria =
		input.task.acceptanceCriteria.length > 0
			? input.task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')
			: '- No explicit acceptance criteria provided.';
	const dependencyLines =
		input.dependencyTitles.length > 0
			? input.dependencyTitles.map((title) => `- ${title}`).join('\n')
			: '- No task dependencies.';
	const scopeLines =
		input.task.scopePaths.length > 0
			? input.task.scopePaths.map((path) => `- ${path}`).join('\n')
			: '- Scope unknown; stay narrow and follow nearby patterns.';

	return [
		`You are Conductor for the Maestro group "${input.groupName}".`,
		'A worker paused on a technical clarification that should be answered from existing task context, not escalated to the operator.',
		`Working directory: ${input.templateSession.cwd}`,
		`Task: ${input.task.title}`,
		`Description: ${input.task.description || 'No description provided.'}`,
		'Acceptance criteria:',
		acceptanceCriteria,
		'Completed dependencies:',
		dependencyLines,
		'Expected scope:',
		scopeLines,
		`Worker clarification: ${input.blockedReason}`,
		'Respond with a short actionable answer for the worker.',
		'Do not ask the operator anything.',
		'If the worker should make a reasonable assumption, state the assumption clearly and keep scope narrow.',
		'Return plain text only.',
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
	const [statusFilter, setStatusFilter] = useState<ConductorTaskStatus[]>([]);
	const [sourceFilter, setSourceFilter] = useState<BacklogSourceFilter>('all');
	const [sortMode, setSortMode] = useState<BacklogSort>('priority');
	const [advancedMode, setAdvancedMode] = useState(false);
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [isPlanComposerOpen, setIsPlanComposerOpen] = useState(false);
	const [isTaskComposerOpen, setIsTaskComposerOpen] = useState(false);
	const [selectedTaskDetailId, setSelectedTaskDetailId] = useState<string | null>(null);
	const [selectedTaskProofDemo, setSelectedTaskProofDemo] = useState<DemoDetail | null>(null);
	const [openProofDemoId, setOpenProofDemoId] = useState<string | null>(null);
	const [capturingProofTaskId, setCapturingProofTaskId] = useState<string | null>(null);
	const [selectedConductorSessionId, setSelectedConductorSessionId] = useState<string | null>(null);
	const [selectedConductorThreadMember, setSelectedConductorThreadMember] = useState<ConductorTeamMember | null>(null);
	const [orchestratorPanelContext, setOrchestratorPanelContext] =
		useState<ConductorOrchestratorContext | null>(null);
	const [expandedConductorToolLogIds, setExpandedConductorToolLogIds] = useState<Set<string>>(
		() => new Set()
	);
	const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
	const [dragOverLaneKey, setDragOverLaneKey] = useState<string | null>(null);
	const [attentionDismissedAt, setAttentionDismissedAt] = useState(0);
	const [, setDraftDescription] = useState('');
	const [plannerNotes, setPlannerNotes] = useState('');
	const [manualTaskParentId, setManualTaskParentId] = useState<string>('');
	const [taskResponseDrafts, setTaskResponseDrafts] = useState<Record<string, string>>({});
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
	const lastAutoReviewReadyKeyRef = useRef<string | null>(null);
	const autoplayPauseRef = useRef(false);
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
	const setRuns = useConductorStore((s) => s.setRuns);
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
	const duplicateAutoplayWinnerByKey = useMemo(() => {
		const statusRank = new Map<ConductorTaskStatus, number>([
			['needs_review', 8],
			['needs_proof', 7],
			['running', 6],
			['planning', 5],
			['needs_revision', 4],
			['needs_input', 3],
			['blocked', 2],
			['ready', 1],
			['draft', 0],
			['cancelled', -1],
			['done', -1],
		]);
		const winners = new Map<string, ConductorTask>();
		for (const task of tasks) {
			if (task.status === 'done' || task.status === 'cancelled') {
				continue;
			}

			const key = normalizeConductorTaskDuplicateKey(task);
			const currentWinner = winners.get(key);
			if (!currentWinner) {
				winners.set(key, task);
				continue;
			}

			const taskRank = statusRank.get(task.status) ?? 0;
			const currentRank = statusRank.get(currentWinner.status) ?? 0;
			if (
				taskRank > currentRank ||
				(taskRank === currentRank &&
					(task.updatedAt > currentWinner.updatedAt ||
						(task.updatedAt === currentWinner.updatedAt &&
							task.createdAt > currentWinner.createdAt)))
			) {
				winners.set(key, task);
			}
		}

		return new Map(Array.from(winners.entries()).map(([key, task]) => [key, task.id]));
	}, [tasks]);
	const latestRunByTaskAndKind = useMemo(() => {
		const map = new Map<string, ConductorRun>();
		const orderedRuns = [...runs].sort(
			(left, right) =>
				(right.endedAt || right.startedAt || 0) - (left.endedAt || left.startedAt || 0)
		);
		for (const run of orderedRuns) {
			const kind = run.kind || 'planning';
			for (const taskId of run.taskIds) {
				const key = `${kind}:${taskId}`;
				if (!map.has(key)) {
					map.set(key, run);
				}
			}
		}
		return map;
	}, [runs]);
	const autoplaySuppressedDuplicateCount = useMemo(
		() =>
			tasks.filter((task) => {
				if (task.status === 'done' || task.status === 'cancelled') {
					return false;
				}
				return duplicateAutoplayWinnerByKey.get(normalizeConductorTaskDuplicateKey(task)) !== task.id;
			}).length,
		[duplicateAutoplayWinnerByKey, tasks]
	);
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
	const isAutoplayPaused = Boolean(conductor?.isPaused);
	const autoplayPauseMessage =
		isPlanning || isExecuting || isReviewing || isIntegrating
			? USER_PAUSING_MESSAGE
			: USER_PAUSED_MESSAGE;
	const providerRouting = conductor?.providerRouting || {
		default: { primary: 'workspace-lead' as const, fallback: null },
		ui: { primary: 'claude-code' as const, fallback: 'codex' as const },
		backend: { primary: 'codex' as const, fallback: 'claude-code' as const },
		pauseNearLimit: true,
		nearLimitPercent: 88,
	};
	const validationCommand = conductor?.validationCommand || '';
	const conductorWorktreeBasePath = selectedTemplate?.worktreeConfig?.basePath?.trim() || '';
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
	const childTasksByParentId = useMemo(() => buildConductorChildTaskMap(tasks), [tasks]);
	const topLevelTasks = useMemo(() => getTopLevelConductorTasks(tasks), [tasks]);
	const rolledUpTaskStatusById = useMemo(() => {
		const entries = tasks.map((task) => [
			task.id,
			getConductorTaskRollupStatus(task, childTasksByParentId, runs),
		] as const);
		return new Map(entries);
	}, [childTasksByParentId, runs, tasks]);
	const effectiveAttentionByTaskId = useMemo(() => {
		const entries = tasks.map((task) => [
			task.id,
			getEffectiveConductorTaskAttentionRequest(task, runs),
		] as const);
		return new Map(entries);
	}, [runs, tasks]);
	const visibleAttentionByTaskId = useMemo(() => {
		const entries = tasks.map((task) => [
			task.id,
			getConductorTaskVisibleAttention(task, childTasksByParentId, runs),
		] as const);
		return new Map(entries);
	}, [childTasksByParentId, runs, tasks]);
	const qaFailureStateByTaskId = useMemo(() => {
		const entries = tasks.map((task) => [task.id, getConductorTaskQaFailureState(task, runs)] as const);
		return new Map(entries);
	}, [runs, tasks]);
	const openFollowUpsByTaskId = useMemo(() => {
		const entries = tasks.map((task) => [
			task.id,
			getConductorTaskOpenFollowUps(task, childTasksByParentId),
		] as const);
		return new Map(entries);
	}, [childTasksByParentId, tasks]);
	const selectedTaskDetail = useMemo(
		() => (selectedTaskDetailId ? tasksById.get(selectedTaskDetailId) || null : null),
		[selectedTaskDetailId, tasksById]
	);
	const reviewReadyTasks = useMemo(
		() =>
			tasks.filter(
				(task) => {
					if (task.status !== 'needs_review' || qaFailureStateByTaskId.get(task.id)?.isQuarantined) {
						return false;
					}
					if (
						duplicateAutoplayWinnerByKey.get(normalizeConductorTaskDuplicateKey(task)) !== task.id
					) {
						return false;
					}

					const latestRun = latestRunByTaskAndKind.get(`review:${task.id}`);
					if (
						latestRun &&
						(latestRun.status === 'attention_required' || latestRun.status === 'blocked')
					) {
						const endedAt = latestRun.endedAt || latestRun.startedAt || 0;
						return Date.now() - endedAt >= CONDUCTOR_AUTOPLAY_RETRY_COOLDOWN_MS;
					}

					return true;
				}
			),
		[duplicateAutoplayWinnerByKey, latestRunByTaskAndKind, qaFailureStateByTaskId, tasks]
	);
	const quarantinedReviewTasks = useMemo(
		() =>
			tasks.filter(
				(task) => task.status === 'needs_review' && Boolean(qaFailureStateByTaskId.get(task.id)?.isQuarantined)
			),
		[qaFailureStateByTaskId, tasks]
	);
	const autoplayCooldownTaskCount = useMemo(() => {
		const now = Date.now();
		return tasks.filter((task) => {
			if (task.status === 'done' || task.status === 'cancelled') {
				return false;
			}
			const relevantKinds: Array<'planning' | 'execution' | 'review'> = [];
			if (task.source !== 'planner' && (task.status === 'ready' || task.status === 'planning')) {
				relevantKinds.push('planning');
			}
			if (task.source !== 'manual' && isConductorTaskRunnableByAgent(task, childTasksByParentId, runs)) {
				relevantKinds.push('execution');
			}
			if (task.status === 'needs_review') {
				relevantKinds.push('review');
			}
			return relevantKinds.some((kind) => {
				const latestRun = latestRunByTaskAndKind.get(`${kind}:${task.id}`);
				if (!latestRun || (latestRun.status !== 'attention_required' && latestRun.status !== 'blocked')) {
					return false;
				}
				const endedAt = latestRun.endedAt || latestRun.startedAt || 0;
				return now - endedAt < CONDUCTOR_AUTOPLAY_RETRY_COOLDOWN_MS;
			});
		}).length;
	}, [childTasksByParentId, latestRunByTaskAndKind, runs, tasks]);
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
								.filter((event) =>
									eventRelatesToConductorTask(run, event, selectedTaskDetail)
								)
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
	const selectedTaskOpenFollowUps = useMemo(
		() =>
			selectedTaskDetail
				? getConductorTaskOpenFollowUps(selectedTaskDetail, childTasksByParentId)
				: [],
		[selectedTaskDetail, childTasksByParentId]
	);
	const selectedTaskAttentionBlockers = useMemo(
		() =>
			selectedTaskDetail
				? getConductorTaskAttentionBlockers(selectedTaskDetail, childTasksByParentId, runs)
				: [],
		[selectedTaskDetail, childTasksByParentId, runs]
	);
	const selectedTaskNeedsOperatorAttention = useMemo(
		() =>
			selectedTaskDetail
				? (() => {
						const visibleAttention = visibleAttentionByTaskId.get(selectedTaskDetail.id);
						return visibleAttention
							? isConductorTaskOperatorActionRequired(
									visibleAttention.task,
									childTasksByParentId,
									runs
								)
							: false;
					})()
				: false,
		[selectedTaskDetail, visibleAttentionByTaskId, childTasksByParentId, runs]
	);
	const selectedTaskRolledUpStatus = useMemo(
		() =>
			selectedTaskDetail
				? rolledUpTaskStatusById.get(selectedTaskDetail.id) || selectedTaskDetail.status
				: null,
		[rolledUpTaskStatusById, selectedTaskDetail]
	);
	const selectedTaskProgress = useMemo(
		() =>
			selectedTaskDetail
				? getConductorTaskProgress(selectedTaskDetail, childTasksByParentId)
				: { totalSubtasks: 0, completedSubtasks: 0, openSubtasks: 0, completionRatio: 0 },
		[selectedTaskDetail, childTasksByParentId]
	);
	const selectedTaskEffectiveAttention = useMemo(
		() =>
			selectedTaskDetail ? visibleAttentionByTaskId.get(selectedTaskDetail.id)?.attentionRequest || null : null,
		[selectedTaskDetail, visibleAttentionByTaskId]
	);
	const selectedTaskAttentionTarget = useMemo(
		() => (selectedTaskDetail ? visibleAttentionByTaskId.get(selectedTaskDetail.id)?.task || null : null),
		[selectedTaskDetail, visibleAttentionByTaskId]
	);
	const selectedTaskQaFailureState = useMemo(
		() => (selectedTaskDetail ? qaFailureStateByTaskId.get(selectedTaskDetail.id) || null : null),
		[qaFailureStateByTaskId, selectedTaskDetail]
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
	const staleTaskRecoveryIds = useMemo(() => {
		if (
			isPlanning ||
			isExecuting ||
			isReviewing ||
			conductorAutoplayLocks.planning.has(groupId) ||
			conductorAutoplayLocks.execution.has(groupId) ||
			conductorAutoplayLocks.review.has(groupId)
		) {
			return [];
		}

		const now = Date.now();
		return tasks
			.filter((task) => task.status === 'planning' || task.status === 'running')
			.filter((task) => {
				if (cancelledTaskIdsRef.current.has(task.id)) {
					return false;
				}

				const sessionId =
					task.status === 'planning' ? task.plannerSessionId : task.workerSessionId;
				const session = sessionId ? sessionById.get(sessionId) : null;
				if (session?.state === 'busy') {
					return false;
				}

				const taskAgeMs = Math.max(0, now - (task.updatedAt || task.createdAt || now));
				return taskAgeMs >= CONDUCTOR_STALE_TASK_RECOVERY_MS;
			})
			.map((task) => task.id);
	}, [groupId, isExecuting, isPlanning, isReviewing, sessionById, tasks]);
	const staleRunRecoveryIds = useMemo(() => {
		if (
			isPlanning ||
			isExecuting ||
			isReviewing ||
			conductorAutoplayLocks.planning.has(groupId) ||
			conductorAutoplayLocks.execution.has(groupId) ||
			conductorAutoplayLocks.review.has(groupId)
		) {
			return [];
		}

		const now = Date.now();
		return runs
			.filter((run) => run.status === 'running' || run.status === 'planning')
			.filter((run) => {
				if (Math.max(0, now - (run.startedAt || now)) < CONDUCTOR_STALE_TASK_RECOVERY_MS) {
					return false;
				}

				const runSessionIds = new Set<string>([
					run.plannerSessionId,
					...(run.agentSessionIds || []),
					...Object.values(run.taskWorkerSessionIds || {}),
					...Object.values(run.taskReviewerSessionIds || {}),
				].filter((sessionId): sessionId is string => Boolean(sessionId)));
				const hasBusySession = Array.from(runSessionIds).some(
					(sessionId) => sessionById.get(sessionId)?.state === 'busy'
				);
				if (hasBusySession) {
					return false;
				}

				if (run.kind === 'planning') {
					return run.taskIds.every((taskId) => tasksById.get(taskId)?.status !== 'planning');
				}
				if (run.kind === 'execution') {
					return run.taskIds.every((taskId) => tasksById.get(taskId)?.status !== 'running');
				}
				if (run.kind === 'review') {
					return run.taskIds.every((taskId) => tasksById.get(taskId)?.status !== 'needs_review');
				}

				return false;
			})
			.map((run) => run.id);
	}, [groupId, isExecuting, isPlanning, isReviewing, runs, sessionById, tasksById]);

	useEffect(() => {
		if (!selectedTaskDetail || !selectedTaskAttentionTarget) {
			return;
		}

		setTaskResponseDrafts((previous) => {
			if (previous[selectedTaskAttentionTarget.id] !== undefined) {
				return previous;
			}

			return {
				...previous,
				[selectedTaskAttentionTarget.id]: selectedTaskEffectiveAttention?.response || '',
			};
		});
	}, [selectedTaskAttentionTarget, selectedTaskDetail, selectedTaskEffectiveAttention]);

	useEffect(() => {
		const demoId = selectedTaskDetail?.completionProof?.demoId;
		if (!demoId) {
			setSelectedTaskProofDemo(null);
			return;
		}

		let cancelled = false;
		void window.maestro.artifacts.getDemo(demoId).then((demoDetail) => {
			if (!cancelled) {
				setSelectedTaskProofDemo(demoDetail);
			}
		});

		return () => {
			cancelled = true;
		};
	}, [selectedTaskDetail?.completionProof?.demoId]);

	const taskCounts = useMemo(() => {
		const topLevelStatuses = topLevelTasks.map(
			(task) => rolledUpTaskStatusById.get(task.id) || task.status
		);
		return {
			total: topLevelTasks.length,
			done: topLevelStatuses.filter((status) => status === 'done').length,
			cancelled: topLevelStatuses.filter((status) => status === 'cancelled').length,
			ready: topLevelStatuses.filter((status) => status === 'ready').length,
			running: topLevelStatuses.filter((status) => status === 'running').length,
			planning: topLevelStatuses.filter((status) => status === 'planning').length,
			needsRevision: topLevelStatuses.filter((status) => status === 'needs_revision').length,
			needsInput: topLevelStatuses.filter((status) => status === 'needs_input').length,
			needsProof: topLevelStatuses.filter((status) => status === 'needs_proof').length,
			blocked: topLevelStatuses.filter((status) => status === 'blocked').length,
			needsReview: topLevelStatuses.filter((status) => status === 'needs_review').length,
			draft: topLevelStatuses.filter((status) => status === 'draft').length,
		};
	}, [rolledUpTaskStatusById, topLevelTasks]);
	const tasksNeedingPlanningIds = useMemo(() => {
		const now = Date.now();
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
			.filter(
				(task) =>
					duplicateAutoplayWinnerByKey.get(normalizeConductorTaskDuplicateKey(task)) === task.id
			)
			.filter((task) => {
				const latestRun = latestRunByTaskAndKind.get(`planning:${task.id}`);
				if (!latestRun || latestRun.status !== 'attention_required') {
					return true;
				}
				const endedAt = latestRun.endedAt || latestRun.startedAt || 0;
				return now - endedAt >= CONDUCTOR_AUTOPLAY_RETRY_COOLDOWN_MS;
			})
			.sort((left, right) => {
				const priorityDiff =
					(priorityRank.get(left.priority) ?? 99) - (priorityRank.get(right.priority) ?? 99);
				if (priorityDiff !== 0) {
					return priorityDiff;
				}
				return left.createdAt - right.createdAt;
			})
			.map((task) => task.id);
	}, [duplicateAutoplayWinnerByKey, latestRunByTaskAndKind, tasks]);
	const dependencyReadyTaskIds = useMemo(() => {
		const now = Date.now();
		const completedTaskIds = new Set(
			tasks
				.filter((task) => (rolledUpTaskStatusById.get(task.id) || task.status) === 'done')
				.map((task) => task.id)
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
						task.source !== 'manual' &&
						isConductorTaskRunnableByAgent(task, childTasksByParentId, runs) &&
						task.dependsOn.every((dependencyId) => completedTaskIds.has(dependencyId))
				)
				.filter(
					(task) =>
						duplicateAutoplayWinnerByKey.get(normalizeConductorTaskDuplicateKey(task)) === task.id
				)
				.filter((task) => {
					const latestRun = latestRunByTaskAndKind.get(`execution:${task.id}`);
					if (
						!latestRun ||
						(latestRun.status !== 'attention_required' && latestRun.status !== 'blocked')
					) {
						return true;
					}
					const endedAt = latestRun.endedAt || latestRun.startedAt || 0;
					return now - endedAt >= CONDUCTOR_AUTOPLAY_RETRY_COOLDOWN_MS;
				})
				.sort((left, right) => {
					const priorityDiff =
						(priorityRank.get(left.priority) ?? 99) - (priorityRank.get(right.priority) ?? 99);
				if (priorityDiff !== 0) {
					return priorityDiff;
				}
					return left.createdAt - right.createdAt;
				})
				.map((task) => task.id);
	}, [childTasksByParentId, duplicateAutoplayWinnerByKey, latestRunByTaskAndKind, rolledUpTaskStatusById, runs, tasks]);
	const runIsLiveById = useMemo(() => {
		const map = new Map<string, boolean>();
		const planningStillMatters =
			Boolean(pendingRun) ||
			conductor?.status === 'planning' ||
			conductor?.status === 'awaiting_approval' ||
			tasksNeedingPlanningIds.length > 0;

		for (const run of runs) {
			const kind = run.kind || 'planning';
			let isLive = false;

			switch (kind) {
				case 'planning':
					isLive = Boolean(
						(run.status === 'awaiting_approval' && pendingRun?.id === run.id) ||
							(planningStillMatters && latestPlanningRun?.id === run.id)
					);
					break;
				case 'review':
					isLive =
						run.status === 'running' ||
						run.taskIds.some((taskId) => tasksById.get(taskId)?.status === 'needs_review');
					break;
				case 'execution':
					isLive =
						run.status === 'running' ||
						run.taskIds.some((taskId) => tasksById.get(taskId)?.status === 'running');
					break;
				case 'integration':
					isLive = Boolean(
						latestIntegrationRun?.id === run.id &&
							(conductor?.status === 'integrating' || hasOutstandingIntegrationConflict(run))
					);
					break;
				default:
					isLive = false;
			}

			map.set(run.id, isLive);
		}

		return map;
	}, [
		conductor?.status,
		latestIntegrationRun,
		latestPlanningRun,
		pendingRun,
		runs,
		tasksById,
		tasksNeedingPlanningIds.length,
	]);
	const visiblePlanningSummary = useMemo(() => {
		if (!latestPlanningRun?.summary || !runIsLiveById.get(latestPlanningRun.id)) {
			return null;
		}

		return formatConductorOperatorMessage(latestPlanningRun.summary);
	}, [latestPlanningRun, runIsLiveById]);
	const runDisabledReason = useMemo(() => {
		if (isAutoplayPaused) {
			return conductor?.holdReason || autoplayPauseMessage;
		}
		if (isExecuting) {
			return 'Workers are already running.';
		}
		if (isReviewing) {
			return 'QA is already running.';
		}
		if (pendingRun) {
			return 'Conductor is waiting to approve the current plan.';
		}
		if (dependencyReadyTaskIds.length > 0) {
			return null;
		}

		const readyTasks = tasks.filter(
			(task) =>
				task.source !== 'manual' &&
				isConductorTaskRunnableByAgent(task, childTasksByParentId, runs)
		);
		const blockedReadyTask = readyTasks.find((task) =>
			task.dependsOn.some((dependencyId) => (rolledUpTaskStatusById.get(dependencyId) || tasksById.get(dependencyId)?.status) !== 'done')
		);
		if (blockedReadyTask) {
			const unresolvedDependencies = blockedReadyTask.dependsOn
				.map((dependencyId) => tasksById.get(dependencyId))
				.filter(
					(dependencyTask): dependencyTask is ConductorTask => dependencyTask != null
				);
			const incompleteDependencies = unresolvedDependencies.filter(
				(dependencyTask) =>
					(rolledUpTaskStatusById.get(dependencyTask.id) || dependencyTask.status) !== 'done'
			);
			const qaDependency = incompleteDependencies.find(
				(dependencyTask) =>
					(rolledUpTaskStatusById.get(dependencyTask.id) || dependencyTask.status) === 'needs_review'
			);
			if (qaDependency) {
				return `"${blockedReadyTask.title}" is queued behind "${qaDependency.title}", which is still in QA.`;
			}
			const proofDependency = incompleteDependencies.find(
				(dependencyTask) =>
					(rolledUpTaskStatusById.get(dependencyTask.id) || dependencyTask.status) === 'needs_proof'
			);
			if (proofDependency) {
				return `"${blockedReadyTask.title}" is queued behind "${proofDependency.title}", which is still waiting on proof of completion.`;
			}
			if (incompleteDependencies.length > 0) {
				return `"${blockedReadyTask.title}" is still waiting on ${incompleteDependencies
					.slice(0, 2)
					.map((dependencyTask) => `"${dependencyTask.title}"`)
					.join(' and ')}.`;
			}
		}

		if (reviewReadyTasks.length > 0) {
			return `QA is queued for ${reviewReadyTasks.length} task${reviewReadyTasks.length === 1 ? '' : 's'}.`;
		}

		if (quarantinedReviewTasks.length > 0) {
			return `QA is paused for ${quarantinedReviewTasks.length} task${quarantinedReviewTasks.length === 1 ? '' : 's'} after repeated malformed reviewer replies.`;
		}

		if (autoplayCooldownTaskCount > 0) {
			return `Conductor is waiting a few minutes before retrying ${autoplayCooldownTaskCount} recently-failed task${autoplayCooldownTaskCount === 1 ? '' : 's'}.`;
		}

		const operatorAttentionCount = tasks.filter((task) =>
			isConductorTaskOperatorActionRequired(task, childTasksByParentId, runs)
		).length;
		if (operatorAttentionCount > 0) {
			return `Conductor is waiting on you for ${operatorAttentionCount} task${operatorAttentionCount === 1 ? '' : 's'}.`;
		}

		const revisionCount = tasks.filter((task) =>
			isConductorTaskAgentRevision(task, childTasksByParentId, runs)
		).length;
		if (revisionCount > 0) {
			return `Agents are revising ${revisionCount} task${revisionCount === 1 ? '' : 's'}. Execution will resume when a follow-up task is ready.`;
		}

		if (autoplaySuppressedDuplicateCount > 0) {
			return `Conductor is ignoring ${autoplaySuppressedDuplicateCount} duplicate task${autoplaySuppressedDuplicateCount === 1 ? '' : 's'} until you decide which copy to keep.`;
		}

		return 'No runnable tasks are available yet.';
	}, [
		autoplayCooldownTaskCount,
		autoplayPauseMessage,
		autoplaySuppressedDuplicateCount,
		childTasksByParentId,
		conductor?.holdReason,
		dependencyReadyTaskIds.length,
		isExecuting,
		isAutoplayPaused,
		isReviewing,
		pendingRun,
		quarantinedReviewTasks.length,
		reviewReadyTasks.length,
		rolledUpTaskStatusById,
		runs,
		tasks,
		tasksById,
	]);
	const baseFilteredTasks = useMemo(() => {
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
			const childTasks = childTasksByParentId.get(task.id) || [];

			return [
				task.title,
				task.description,
				task.source,
				task.parentTaskId ? tasksById.get(task.parentTaskId)?.title || '' : '',
				...childTasks.map((childTask) => `${childTask.title} ${childTask.description}`),
				...task.scopePaths,
				...(task.changedPaths || []),
				...task.acceptanceCriteria,
			]
				.join(' ')
				.toLowerCase()
				.includes(search);
		};

		return topLevelTasks
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
	}, [childTasksByParentId, sourceFilter, sortMode, taskSearch, tasksById, topLevelTasks]);
	const filteredTasks = useMemo(
		() =>
			baseFilteredTasks.filter((task) =>
				statusFilter.length === 0
					? true
					: statusFilter.includes(rolledUpTaskStatusById.get(task.id) || task.status)
			),
		[baseFilteredTasks, rolledUpTaskStatusById, statusFilter]
	);
	const taskCountsByStatus = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const status of BOARD_COLUMNS) {
			counts[status] = baseFilteredTasks.filter(
				(task) => (rolledUpTaskStatusById.get(task.id) || task.status) === status
			).length;
		}
		return counts;
	}, [baseFilteredTasks, rolledUpTaskStatusById]);
	const scrollToColumn = (status: string) => {
		const container = boardScrollRef.current;
		if (!container) return;

		window.requestAnimationFrame(() => {
			const column = container.querySelector(`[data-column-status="${status}"]`);
			if (column instanceof HTMLElement) {
				const targetLeft = Math.max(column.offsetLeft - 12, 0);
				container.scrollTo({ left: targetLeft, behavior: 'smooth' });
			}
		});
	};

	const shippingComplete = Boolean(
		latestIntegrationRun &&
		latestIntegrationRun.status === 'completed' &&
		(conductor?.publishPolicy === 'none' || latestIntegrationRun.prUrl)
	);
	const percentComplete = taskCounts.total
		? Math.round((taskCounts.done / taskCounts.total) * 100)
		: 0;
	// ── "Since last visit" delta tracking ──────────────────────────────
	const lastVisitKey = `conductor-last-visit-${groupId}`;
	const [lastVisitTimestamp] = useState<number>(() => {
		try {
			const stored = localStorage.getItem(lastVisitKey);
			return stored ? Number(stored) : 0;
		} catch {
			return 0;
		}
	});

	useEffect(() => {
		// Record the current visit timestamp when leaving the page
		return () => {
			try {
				localStorage.setItem(lastVisitKey, String(Date.now()));
			} catch {
				// localStorage may be unavailable
			}
		};
	}, [lastVisitKey]);

	const sinceLastVisitDeltas = useMemo(() => {
		if (!lastVisitTimestamp) {
			return { newTasks: 0, updatedTasks: 0, newRuns: 0 };
		}
		const newTasks = tasks.filter(
			(task) => task.createdAt && task.createdAt > lastVisitTimestamp
		).length;
		const updatedTasks = tasks.filter(
			(task) =>
				task.updatedAt &&
				task.updatedAt > lastVisitTimestamp &&
				(!task.createdAt || task.createdAt <= lastVisitTimestamp)
		).length;
		const newRuns = runs.filter(
			(run) => run.startedAt && run.startedAt > lastVisitTimestamp
		).length;
		return { newTasks, updatedTasks, newRuns };
	}, [lastVisitTimestamp, tasks, runs]);

	const overviewPills = useMemo<
		Array<{
			label: string;
			value: string | number;
			color: string;
			icon: React.ReactNode;
			delta?: number;
		}>
	>(
		() => {
			const pills: Array<{
				label: string;
				value: string | number;
				color: string;
				icon: React.ReactNode;
				delta?: number;
			}> = [];

			// Progress — only show when there are tasks
			if (taskCounts.total > 0) {
				pills.push({
					label: `${taskCounts.done}/${taskCounts.total} done`,
					value: `${percentComplete}%`,
					color: percentComplete === 100 ? '#86efac' : '#60a5fa',
					icon: <Activity className="w-3.5 h-3.5" />,
					delta: sinceLastVisitDeltas.newTasks || undefined,
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
			const inputCount =
				taskCounts.needsInput +
				taskCounts.needsProof +
				taskCounts.needsRevision +
				taskCounts.blocked +
				taskCounts.needsReview;
			if (pendingRun) {
				pills.push({
					label: `Plan review · ${pendingRun.taskIds.length} task${pendingRun.taskIds.length === 1 ? '' : 's'}`,
					value: '!',
					color: '#fbbf24',
					icon: <ShieldAlert className="w-3.5 h-3.5" />,
				});
			} else if (inputCount > 0) {
				const parts: string[] = [];
				if (taskCounts.needsInput > 0) parts.push(`${taskCounts.needsInput} waiting on you`);
				if (taskCounts.needsProof > 0) parts.push(`${taskCounts.needsProof} waiting on proof`);
				if (taskCounts.needsRevision > 0) parts.push(`${taskCounts.needsRevision} in revision`);
				if (taskCounts.needsReview > 0) parts.push(`${taskCounts.needsReview} in QA`);
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
			taskCounts.needsProof,
			taskCounts.needsRevision,
			taskCounts.needsReview,
			taskCounts.planning,
			taskCounts.running,
			taskCounts.total,
			activeConductorAgentSessions.length,
			sinceLastVisitDeltas,
		]
	);
	const conductorTeamMembers = useMemo<ConductorTeamMember[]>(
		() => {
			const byKey = new Map<
				string,
				{
					member: ConductorTeamMember;
					priority: number;
				}
			>();

			const getStatusPriority = (status: ConductorTeamMember['status']): number => {
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

			for (const session of sortedConductorAgentSessions) {
				const providerToolType =
					session.toolType === 'terminal' ? 'claude-code' : session.toolType;
				const identity = resolveConductorRosterIdentity(providerToolType, session.name);
				const assignedTask = session.conductorMetadata?.taskId
					? tasksById.get(session.conductorMetadata.taskId) || null
					: null;
				const parentTask =
					assignedTask?.parentTaskId ? tasksById.get(assignedTask.parentTaskId) || assignedTask : assignedTask;
				const rolledUpStatus = parentTask
					? getConductorTaskRollupStatus(parentTask, childTasksByParentId, runs)
					: null;
				const status: ConductorTeamMember['status'] =
					session.state === 'busy'
						? 'working'
						: session.state === 'error' || Boolean(session.agentError)
							? 'error'
							: rolledUpStatus &&
								  ['needs_revision', 'needs_review', 'needs_input', 'needs_proof', 'blocked'].includes(rolledUpStatus)
								? 'waiting'
								: 'idle';
				const isActivelyWorking = session.state === 'busy';
				const member: ConductorTeamMember = {
					sessionId: session.id,
					name: identity.name,
					emoji: identity.emoji,
					providerLabel: getProviderDisplayName(session.toolType),
					status,
					parentTaskId: isActivelyWorking ? parentTask?.id : undefined,
					parentTaskTitle: isActivelyWorking ? parentTask?.title : undefined,
					threadTargets:
						session.aiTabs.length > 0
							? session.aiTabs.map((tab, index) => ({
									sessionId: session.id,
									tabId: tab.id,
									label:
										session.conductorMetadata?.taskTitle ||
										tab.name?.trim() ||
										`Thread ${index + 1}`,
							  }))
							: [
									{
										sessionId: session.id,
										label: 'Conversation',
									},
							  ],
					lastActiveAt: getSessionLastActivity(session),
				};
				const key = `${providerToolType}:${identity.name}`;
				const existing = byKey.get(key);
				if (!existing) {
					byKey.set(key, { member, priority: getStatusPriority(status) });
					continue;
				}

				const nextPriority = getStatusPriority(status);
				const mergedThreadTargets = [...existing.member.threadTargets];
				for (const target of member.threadTargets) {
					if (
						!mergedThreadTargets.some(
							(existingTarget) =>
								existingTarget.sessionId === target.sessionId &&
								existingTarget.tabId === target.tabId &&
								existingTarget.label === target.label
						)
					) {
						mergedThreadTargets.push(target);
					}
				}

				const shouldReplacePrimary =
					nextPriority > existing.priority ||
					(nextPriority === existing.priority && member.lastActiveAt > existing.member.lastActiveAt);

				byKey.set(key, {
					priority: Math.max(existing.priority, nextPriority),
					member: {
						...(shouldReplacePrimary ? member : existing.member),
						threadTargets: mergedThreadTargets,
						parentTaskId:
							existing.member.parentTaskId || member.parentTaskId,
						parentTaskTitle:
							existing.member.parentTaskTitle || member.parentTaskTitle,
						lastActiveAt: Math.max(existing.member.lastActiveAt, member.lastActiveAt),
					},
				});
			}

			return [...byKey.values()]
				.map((entry) => entry.member)
				.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
		},
		[childTasksByParentId, runs, sortedConductorAgentSessions, tasksById]
	);
	const orchestratorUpdates = useMemo(
		() =>
			buildConductorOrchestratorUpdates({
				runs,
				tasksById,
				runIsLiveById,
				limit: 8,
			}),
		[runs, runIsLiveById, tasksById]
	);

	const resourceGate = useMemo(
		() => evaluateConductorResourceGate(conductor?.resourceProfile || 'aggressive', resourceSnapshot),
		[conductor?.resourceProfile, resourceSnapshot]
	);
	const hasQueuedAutoplayWork =
		dependencyReadyTaskIds.length > 0 || reviewReadyTasks.length > 0 || Boolean(pendingRun);
	const resourceHoldMessage = resourceGate.message || RESOURCE_HOLD_MESSAGE;
	const isSystemHolding = !isAutoplayPaused && hasQueuedAutoplayWork && !resourceGate.allowed;
	const displayConductorStatus = selectedTemplate
		? isAutoplayPaused
			? isPlanning || isExecuting || isReviewing || isIntegrating
				? 'pausing'
				: 'paused'
			: isSystemHolding
				? 'holding'
				: conductor?.status === 'needs_setup'
					? 'idle'
					: conductor?.status
		: 'needs_setup';
	const rawControlStatusMessage =
		(isAutoplayPaused ? conductor?.holdReason || autoplayPauseMessage : null) ||
		(isSystemHolding ? resourceHoldMessage : null) ||
		(runDisabledReason === 'No runnable tasks are available yet.' ? null : runDisabledReason);
	const controlStatusMessage = rawControlStatusMessage
		? formatConductorOperatorMessage(rawControlStatusMessage)
		: null;
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
		autoplayPauseRef.current = isAutoplayPaused;
	}, [isAutoplayPaused]);

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
		if (staleTaskRecoveryIds.length === 0) {
			return;
		}

		const staleTaskIdSet = new Set(staleTaskRecoveryIds);
		const recoveredAt = Date.now();
		setTasks((previousTasks) => {
			let changed = false;
			const nextTasks = previousTasks.map((task) => {
				if (!staleTaskIdSet.has(task.id)) {
					return task;
				}
				changed = true;
				return {
					...task,
					status: 'ready' as const,
					plannerSessionId: task.status === 'planning' ? undefined : task.plannerSessionId,
					plannerSessionName: task.status === 'planning' ? undefined : task.plannerSessionName,
					workerSessionId: task.status === 'running' ? undefined : task.workerSessionId,
					workerSessionName: task.status === 'running' ? undefined : task.workerSessionName,
					updatedAt: recoveredAt,
				};
			});
			return changed ? nextTasks : previousTasks;
		});
		setRuns((previousRuns) =>
			previousRuns.map((run) => {
				if (
					run.groupId !== groupId ||
					(run.status !== 'running' && run.status !== 'planning') ||
					!run.taskIds.some((taskId) => staleTaskIdSet.has(taskId))
				) {
					return run;
				}

				const eventType = run.kind === 'planning' ? 'planning_failed' : 'execution_failed';
				const staleTitles = run.taskIds
					.map((taskId) => tasksById.get(taskId)?.title)
					.filter((title): title is string => Boolean(title));
				return {
					...run,
					status: 'cancelled',
					summary:
						staleTitles.length > 0
							? `Recovered stale ${run.kind || 'conductor'} work for ${staleTitles.join(', ')}.`
							: `Recovered stale ${run.kind || 'conductor'} work.`,
					endedAt: recoveredAt,
					events: [
						...run.events,
						{
							id: `conductor-run-event-${generateId()}`,
							runId: run.id,
							groupId,
							type: eventType,
							message:
								staleTitles.length > 0
									? `Recovered stale ${run.kind || 'conductor'} work for ${staleTitles.join(', ')} after the helper session disappeared.`
									: `Recovered stale ${run.kind || 'conductor'} work after the helper session disappeared.`,
							createdAt: recoveredAt,
						},
					],
				};
			})
		);
		if (conductor?.status === 'running' || conductor?.status === 'planning') {
			setConductor(groupId, { status: 'idle', holdReason: null });
		}
		lastAutoRunReadyKeyRef.current = null;
		lastAutoPlanReadyKeyRef.current = null;
		lastAutoReviewReadyKeyRef.current = null;
	}, [conductor?.status, groupId, setConductor, setRuns, setTasks, staleTaskRecoveryIds, tasksById]);

	useEffect(() => {
		if (staleRunRecoveryIds.length === 0) {
			return;
		}

		const staleRunIdSet = new Set(staleRunRecoveryIds);
		const recoveredAt = Date.now();
		setRuns((previousRuns) =>
			previousRuns.map((run) => {
				if (!staleRunIdSet.has(run.id)) {
					return run;
				}

				return {
					...run,
					status: 'cancelled',
					summary: `Recovered stale ${run.kind || 'conductor'} run after its helper sessions disappeared.`,
					endedAt: recoveredAt,
					events: [
						...run.events,
						{
							id: `conductor-run-event-${generateId()}`,
							runId: run.id,
							groupId,
							type:
								run.kind === 'planning'
									? 'planning_failed'
									: run.kind === 'review'
										? 'review_failed'
										: 'execution_failed',
							message: `Recovered stale ${run.kind || 'conductor'} run after its helper sessions disappeared.`,
							createdAt: recoveredAt,
						},
					],
				};
			})
		);
		if (conductor?.status === 'running' || conductor?.status === 'planning') {
			setConductor(groupId, { status: 'idle', holdReason: null });
		}
		lastAutoRunReadyKeyRef.current = null;
		lastAutoPlanReadyKeyRef.current = null;
		lastAutoReviewReadyKeyRef.current = null;
	}, [conductor?.status, groupId, setConductor, setRuns, staleRunRecoveryIds]);

	useEffect(() => {
		setExpandedConductorToolLogIds(new Set());
	}, [selectedConductorSessionId]);

	useEffect(() => {
		const readyKey = tasksNeedingPlanningIds.join('|');

		if (!readyKey) {
			lastAutoPlanReadyKeyRef.current = null;
			return;
		}

		if (isAutoplayPaused) {
			lastAutoPlanReadyKeyRef.current = null;
			return;
		}

		if (!selectedTemplate || pendingRun || isPlanning || isExecuting || isReviewing || isIntegrating) {
			return;
		}

		if (conductorAutoplayLocks.planning.has(groupId)) {
			return;
		}

			if (lastAutoPlanReadyKeyRef.current === readyKey) {
				return;
			}

			lastAutoPlanReadyKeyRef.current = readyKey;
			void handlePlanTask(tasksNeedingPlanningIds[0]);
		}, [
			tasksNeedingPlanningIds,
			isAutoplayPaused,
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

		if (isAutoplayPaused) {
			lastAutoRunReadyKeyRef.current = null;
			return;
		}

		if (!resourceGate.allowed) {
			if (conductor?.holdReason !== resourceHoldMessage) {
				setConductor(groupId, { holdReason: resourceHoldMessage });
			}
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

		if (conductorAutoplayLocks.execution.has(groupId)) {
			return;
		}

		if (lastAutoRunReadyKeyRef.current === readyKey) {
			return;
		}

		if (conductor?.holdReason === resourceHoldMessage) {
			setConductor(groupId, { holdReason: null });
		}
		lastAutoRunReadyKeyRef.current = readyKey;
		void handleRunReadyTasks();
	}, [
		conductor?.holdReason,
		dependencyReadyTaskIds,
		groupId,
		isAutoplayPaused,
		isExecuting,
		gitReadiness,
		isIntegrating,
		isPlanning,
		isReviewing,
		pendingRun,
		resourceGate.allowed,
		resourceHoldMessage,
		selectedTemplate,
		setConductor,
	]);

	useEffect(() => {
		const reviewKey = reviewReadyTasks.map((task) => task.id).join('|');

		if (!reviewKey) {
			lastAutoReviewReadyKeyRef.current = null;
			return;
		}

		if (isAutoplayPaused) {
			lastAutoReviewReadyKeyRef.current = null;
			return;
		}

		if (!resourceGate.allowed) {
			if (conductor?.holdReason !== resourceHoldMessage) {
				setConductor(groupId, { holdReason: resourceHoldMessage });
			}
			lastAutoReviewReadyKeyRef.current = null;
			return;
		}

		if (
			!selectedTemplate ||
			pendingRun ||
			isPlanning ||
			isExecuting ||
			isReviewing ||
			isIntegrating ||
			dependencyReadyTaskIds.length > 0
		) {
			return;
		}

		if (conductorAutoplayLocks.review.has(groupId)) {
			return;
		}

		if (lastAutoReviewReadyKeyRef.current === reviewKey) {
			return;
		}

		if (conductor?.holdReason === resourceHoldMessage) {
			setConductor(groupId, { holdReason: null });
		}
		lastAutoReviewReadyKeyRef.current = reviewKey;
		void handleRunReviewTasks();
	}, [
		conductor?.holdReason,
		dependencyReadyTaskIds.length,
		groupId,
		isAutoplayPaused,
		isExecuting,
		isIntegrating,
		isPlanning,
		isReviewing,
		pendingRun,
		resourceGate.allowed,
		resourceHoldMessage,
		reviewReadyTasks,
		selectedTemplate,
		setConductor,
	]);

	useEffect(() => {
		if (
			!pendingRun ||
			isAutoplayPaused ||
			isPlanning ||
			isExecuting ||
			isReviewing ||
			isIntegrating ||
			conductor?.autoExecuteOnPlanCreation === false
		) {
			return;
		}

		const approved = approvePlanningRun(pendingRun.id, { approvedBy: 'conductor' });
		if (!approved) {
			return;
		}

		window.setTimeout(() => {
			if (dependencyReadyTaskIds.length > 0) {
				void handleRunReadyTasks();
				return;
			}
			if (reviewReadyTasks.length > 0) {
				void handleRunReviewTasks();
			}
		}, 0);
	}, [
		conductor?.autoExecuteOnPlanCreation,
		dependencyReadyTaskIds.length,
		isAutoplayPaused,
		isExecuting,
		isIntegrating,
		isPlanning,
		isReviewing,
		pendingRun,
		reviewReadyTasks.length,
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

			if (
				!isAutoplayPaused &&
				dependencyReadyTaskIds.length > 0 &&
				!pendingRun &&
				!isPlanning &&
				!isReviewing &&
				!isIntegrating
			) {
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
		const task = tasksById.get(taskId);
		if (!task) {
			return;
		}
		const currentAttention = effectiveAttentionByTaskId.get(taskId) || null;
		const isProofAttention = isConductorCompletionProofAttentionRequestId(currentAttention?.id);

		const nextAttentionRequest =
			nextStatus === 'needs_input' || nextStatus === 'needs_proof'
				? currentAttention
				: isProofAttention
					? null
				: currentAttention?.status === 'open'
					? {
							...currentAttention,
							status: 'resolved' as const,
							updatedAt: Date.now(),
							resolvedAt: Date.now(),
					  }
					: currentAttention;

		updateTask(taskId, {
			status: nextStatus,
			attentionRequest: nextAttentionRequest,
		});
	};

	const handleTaskCompletionProofRequirementChange = (
		task: ConductorTask,
		enabled: boolean
	) => {
		const now = Date.now();
		const nextRequirement = enabled
			? task.completionProofRequirement || buildDefaultConductorTaskCompletionProofRequirement()
			: undefined;
		const nextProof = enabled
			? task.completionProof || buildDefaultConductorTaskCompletionProof(now)
			: undefined;
		updateTask(task.id, {
			status: enabled
				? task.status === 'done' &&
				  !hasConductorTaskApprovedCompletionProof({
						...task,
						completionProofRequirement: nextRequirement,
						completionProof: nextProof,
				  })
					? 'needs_proof'
					: task.status
				: task.status === 'needs_proof'
					? 'done'
					: task.status,
			attentionRequest: !enabled ? null : task.attentionRequest,
			completionProofRequirement: nextRequirement,
			completionProof: nextProof,
		});
	};

	const handleTaskCompletionProofStatusChange = (
		task: ConductorTask,
		nextStatus: ConductorTaskCompletionProofStatus
	) => {
		const now = Date.now();
		const currentProof = task.completionProof || buildDefaultConductorTaskCompletionProof(now);
		const nextTaskStatus =
			nextStatus === 'approved'
				? task.status === 'needs_proof'
					? 'done'
					: task.status
				: task.status === 'done' && requiresConductorTaskCompletionProof(task)
					? 'needs_proof'
					: task.status;
		updateTask(task.id, {
			status: nextTaskStatus,
			attentionRequest:
				nextTaskStatus === 'done' ? null : task.attentionRequest,
			completionProof: {
				...currentProof,
				status: nextStatus,
				requestedAt: currentProof.requestedAt || now,
				capturedAt:
					nextStatus === 'captured' || nextStatus === 'approved'
						? currentProof.capturedAt || now
						: undefined,
				approvedAt: nextStatus === 'approved' ? currentProof.approvedAt || now : undefined,
				rejectedAt: nextStatus === 'rejected' ? now : undefined,
			},
		});
	};

	const handleResolveTaskAttention = (task: ConductorTask) => {
		const response = (taskResponseDrafts[task.id] || '').trim();
		const currentAttention = effectiveAttentionByTaskId.get(task.id) || null;
		const nextDescription = response
			? [task.description.trim(), `Operator follow-up:\n${response}`].filter(Boolean).join('\n\n')
			: task.description;

		updateTask(task.id, {
			description: nextDescription,
			status: 'ready',
			attentionRequest: currentAttention
				? {
						...currentAttention,
						status: 'resolved',
						response,
						updatedAt: Date.now(),
						resolvedAt: Date.now(),
				  }
				: null,
		});
	};

	const openTaskDetails = (taskId: string) => {
		setSelectedTaskDetailId(taskId);
	};

	const openOrchestratorPanel = (context?: ConductorOrchestratorContext) => {
		setOrchestratorPanelContext(context || { scope: 'board' });
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

	const handleNavigateToAgentThread = (sessionId: string, tabId?: string) => {
		const session = sessionById.get(sessionId);
		if (!session) {
			return;
		}

		if (tabId && session.activeTabId !== tabId) {
			updateSession(sessionId, { activeTabId: tabId, activeFileTabId: null, inputMode: 'ai' });
		}

		setActiveSessionId(sessionId);
		setSelectedConductorThreadMember(null);
	};

	const handleOpenTeamMember = (member: ConductorTeamMember) => {
		if (member.threadTargets.length <= 1) {
			const target = member.threadTargets[0];
			handleNavigateToAgentThread(target?.sessionId || member.sessionId, target?.tabId);
			return;
		}

		setSelectedConductorThreadMember(member);
	};

	const handleConfigureConductorWorktreeStorage = () => {
		if (!selectedTemplate) {
			notifyToast({
				type: 'warning',
				title: 'No workspace lead yet',
				message: 'Add a workspace lead agent first so Conductor knows where to store worktrees.',
			});
			return;
		}

		setActiveSessionId(selectedTemplate.id);
		getModalActions().setWorktreeConfigModalOpen(true);
	};

	const handleAskAboutUpdate = (update: ConductorOrchestratorUpdate) => {
		openOrchestratorPanel({ scope: 'update', updateId: update.id });
	};

	const handleAskAboutTeamMember = (member: ConductorTeamMember) => {
		openOrchestratorPanel({ scope: 'member', memberName: member.name });
	};

	const handleOpenTeamMemberByName = (memberName: string) => {
		const member = conductorTeamMembers.find((candidate) => candidate.name === memberName);
		if (!member) {
			return;
		}
		handleOpenTeamMember(member);
	};

	const handleCleanupIdleConductorAgents = () => {
		cleanupConductorAgentSessions(
			conductorAgentSessions.filter((session) => session.state !== 'busy').map((session) => session.id),
			{ force: true }
		);
	};

	const cleanupConductorAgentSessions = (
		sessionIds: string[],
		options?: {
			force?: boolean;
			preserveWhilePaused?: boolean;
		}
	) => {
		const force = options?.force ?? false;
		const preserveWhilePaused = options?.preserveWhilePaused ?? true;

		if (
			(!force && conductor?.keepConductorAgentSessions) ||
			(!force && preserveWhilePaused && autoplayPauseRef.current) ||
			sessionIds.length === 0
		) {
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

	const recordTaskAgentHistory = (
		taskId: string,
		role: ConductorAgentRole,
		sessionId: string,
		sessionName: string | undefined,
		runId?: string
	) => {
		setTasks((previousTasks) =>
			previousTasks.map((task) => {
				if (task.id !== taskId) {
					return task;
				}

				const existingHistory = task.agentHistory || [];
				if (
					existingHistory.some(
						(entry) =>
							entry.role === role && entry.sessionId === sessionId && entry.runId === (runId || undefined)
					)
				) {
					return task;
				}

				const nextEntry: ConductorTaskAgentHistoryEntry = {
					id: `conductor-task-agent-${generateId()}`,
					role,
					sessionId,
					sessionName,
					runId,
					createdAt: Date.now(),
				};

				return {
					...task,
					agentHistory: [...existingHistory, nextEntry],
					updatedAt: Date.now(),
				};
			})
		);
	};

	const buildTaskAttentionRequest = (input: {
		kind: ConductorTaskAttentionRequest['kind'];
		summary: string;
		requestedAction: string;
		requestedByRole: ConductorTaskAttentionRequest['requestedByRole'];
		requestedBySessionId?: string;
		suggestedResponse?: string;
		runId?: string;
	}): ConductorTaskAttentionRequest => {
		const now = Date.now();
		return {
			id: `conductor-task-attention-${generateId()}`,
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
			{
				role: 'planner' as const,
				sessionId: task.plannerSessionId,
				sessionName: task.plannerSessionName,
			},
			{
				role: 'worker' as const,
				sessionId: task.workerSessionId,
				sessionName: task.workerSessionName,
			},
			{
				role: 'reviewer' as const,
				sessionId: task.reviewerSessionId,
				sessionName: task.reviewerSessionName,
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
		const historyRefs = (task.agentHistory || []).map((entry) => ({
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
			const session = sessionById.get(sessionId);
			return {
				key: `${task.id}-${role}-${sessionId}`,
				sessionId,
				label: `${formatConductorRoleLabel(role)}: ${
					sessionName ||
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


	const openTaskComposer = (parentTaskId?: string) => {
		setManualTaskParentId(parentTaskId || '');
		setIsTaskComposerOpen(true);
	};

	const clearTaskFilters = () => {
		setTaskSearch('');
		setStatusFilter([]);
		setSourceFilter('all');
		setSortMode('priority');
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

	const resolveProofExecutionContext = async (
		task: ConductorTask
	): Promise<{ cwd: string; branch: string | null }> => {
		const latestTaskExecution = getLatestExecutionForTask(task.id);
		const candidateContexts = [
			{
				cwd: latestTaskExecution?.taskWorktreePaths?.[task.id] || null,
				branch: latestTaskExecution?.taskBranches?.[task.id] || null,
			},
			{
				cwd: latestTaskExecution?.worktreePath || null,
				branch: latestTaskExecution?.branchName || null,
			},
			{
				cwd: selectedTemplate?.cwd || null,
				branch: null,
			},
		];

		for (const candidate of candidateContexts) {
			if (!candidate.cwd) {
				continue;
			}

			try {
				const stat = await window.maestro.fs.stat(candidate.cwd);
				if (stat.isDirectory) {
					return {
						cwd: candidate.cwd,
						branch: candidate.branch,
					};
				}
			} catch {
				// Fall through to the next candidate path.
			}
		}

		return {
			cwd: selectedTemplate?.cwd || task.scopePaths[0] || '',
			branch: null,
		};
	};

	const handleCaptureTaskCompletionProof = async (task: ConductorTask) => {
		if (!selectedTemplate) {
			notifyToast({
				type: 'error',
				title: 'Proof Capture Unavailable',
				message: 'This workspace needs a top-level agent before Conductor can capture proof.',
			});
			return;
		}

		if (capturingProofTaskId === task.id || !requiresConductorTaskCompletionProof(task)) {
			return;
		}

		const now = Date.now();
		const proofRequirement =
			task.completionProofRequirement || buildDefaultConductorTaskCompletionProofRequirement();
		const previousProof = task.completionProof || buildDefaultConductorTaskCompletionProof(now);
		const { cwd: proofCwd, branch: proofBranch } = await resolveProofExecutionContext(task);
		const requestedAt = previousProof.requestedAt || now;

		setCapturingProofTaskId(task.id);
		updateTask(task.id, {
			status: 'needs_proof',
			completionProof: {
				...previousProof,
				status: 'capturing',
				requestedAt,
				approvedAt: undefined,
				rejectedAt: undefined,
			},
		});

		try {
			const proofResult = await runConductorAgentTurn({
				parentSession: selectedTemplate,
				role: 'reviewer',
				taskTitle: task.title,
				taskDescription: task.description,
				scopePaths: task.scopePaths,
				providerRouteHint: 'ui',
				prompt: buildConductorProofPrompt(group?.name || 'Unnamed Group', { ...selectedTemplate, cwd: proofCwd }, task),
				cwd: proofCwd,
				branch: proofBranch,
				taskId: task.id,
				readOnlyMode: false,
				demoCapture: { enabled: true },
				onSessionReady: (session) => {
					recordTaskAgentHistory(task.id, 'reviewer', session.id, session.name);
					updateTask(task.id, {
						reviewerSessionId: session.id,
						reviewerSessionName: session.name,
					});
				},
			});

			if (
				!proofResult.demoCard ||
				!satisfiesConductorTaskCompletionProofRequirement(proofResult.demoCard, proofRequirement)
			) {
				throw new ConductorAgentRunError(
					'Proof capture finished without the required recording and screenshots.',
					{
						demoCard: proofResult.demoCard,
					}
				);
			}

			const capturedAt = Date.now();
			updateTask(task.id, {
				status: 'needs_proof',
				completionProof: {
					...previousProof,
					status: 'captured',
					demoId: proofResult.demoCard.demoId,
					captureRunId: proofResult.demoCard.captureRunId,
					screenshotCount: proofResult.demoCard.stepCount,
					videoArtifactId: proofResult.demoCard.videoArtifact?.id,
					requestedAt,
					capturedAt,
					approvedAt: undefined,
					rejectedAt: undefined,
				},
			});

			const persistedDemo = await window.maestro.artifacts.getDemo(proofResult.demoCard.demoId);
			setSelectedTaskProofDemo(persistedDemo);
			notifyToast({
				type: 'success',
				title: 'Proof Captured',
				message: `Captured completion proof for ${task.title}.`,
			});
		} catch (error) {
			const failedDemo =
				error instanceof ConductorAgentRunError ? error.demoCard : undefined;
			const hadExistingApprovedProof =
				previousProof.demoId &&
				(previousProof.status === 'captured' || previousProof.status === 'approved');

			if (hadExistingApprovedProof) {
				updateTask(task.id, {
					status: 'needs_proof',
					completionProof: previousProof,
				});
			} else if (failedDemo) {
				const rejectedAt = Date.now();
				updateTask(task.id, {
					status: 'needs_proof',
					completionProof: {
						...previousProof,
						status: 'rejected',
						demoId: failedDemo.demoId,
						captureRunId: failedDemo.captureRunId,
						screenshotCount: failedDemo.stepCount,
						videoArtifactId: failedDemo.videoArtifact?.id,
						requestedAt,
						capturedAt: undefined,
						approvedAt: undefined,
						rejectedAt,
					},
				});
				const persistedFailedDemo = await window.maestro.artifacts.getDemo(failedDemo.demoId);
				setSelectedTaskProofDemo(persistedFailedDemo);
			} else {
				updateTask(task.id, {
					status: 'needs_proof',
					completionProof: {
						...previousProof,
						status: previousProof.status === 'capturing' ? 'missing' : previousProof.status,
						requestedAt,
						approvedAt: previousProof.status === 'approved' ? previousProof.approvedAt : undefined,
						rejectedAt: previousProof.status === 'rejected' ? previousProof.rejectedAt : undefined,
					},
				});
			}

			notifyToast({
				type: 'error',
				title: 'Proof Capture Failed',
				message: error instanceof Error ? error.message : 'Proof capture did not complete.',
			});
		} finally {
			setCapturingProofTaskId((currentTaskId) =>
				currentTaskId === task.id ? null : currentTaskId
			);
		}
	};

	const handlePlanTask = async (taskId: string) => {
		if (!selectedTemplate) {
			setPlanningError('This workspace needs at least one top-level agent before Conductor can plan.');
			return;
		}

		const task = tasksById.get(taskId);
		if (!task || task.source === 'planner') {
			return;
		}

		if (conductorAutoplayLocks.planning.has(groupId)) {
			return;
		}
		conductorAutoplayLocks.planning.add(groupId);

		try {
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
			setConductor(groupId, { status: 'planning', holdReason: null });
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
					expectedSubmissionKind: 'planner',
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
				setConductor(groupId, { status: 'idle', holdReason: null });
				cleanupConductorAgentSessions([plannerSessionId || '']);
				return;
			}

				const parsedPlan =
					plannerResult.structuredSubmission?.kind === 'planner'
						? parseConductorPlannerSubmission(plannerResult.structuredSubmission.payload)
						: parseConductorPlannerResponse(plannerResult.response);
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
				setConductor(groupId, { status: 'idle', holdReason: null });
				cleanupConductorAgentSessions([plannerSessionId || '']);
				return;
			}

				const message = error instanceof Error ? error.message : 'Plan generation failed.';
				const isProviderLimit = isConductorProviderLimitMessage(message);
				setPlanningError(message);
				updateTask(task.id, { status: isProviderLimit ? 'ready' : 'needs_input' });
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
					setConductor(groupId, {
						status: 'attention_required',
						isPaused: isProviderLimit,
						holdReason: isProviderLimit ? message : null,
					});
				cleanupConductorAgentSessions([plannerSessionId || '']);
			} finally {
				cancelledTaskIdsRef.current.delete(task.id);
				setIsPlanning(false);
			}
		} finally {
			conductorAutoplayLocks.planning.delete(groupId);
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
		setConductor(groupId, { status: 'planning', holdReason: null });
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
				expectedSubmissionKind: 'planner',
				onSessionReady: (session) => {
					plannerSessionId = session.id;
					plannerSessionName = session.name;
					updateRun(runId, {
						plannerSessionId: session.id,
						agentSessionIds: [session.id],
					});
				},
			});
			const parsedPlan =
				plannerResult.structuredSubmission?.kind === 'planner'
					? parseConductorPlannerSubmission(plannerResult.structuredSubmission.payload)
					: parseConductorPlannerResponse(plannerResult.response);
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
					attentionRequest: null,
					agentHistory: plannerSessionId
						? [
								{
									id: `conductor-task-agent-${generateId()}`,
									role: 'planner' as const,
									sessionId: plannerSessionId,
									sessionName: plannerSessionName,
									runId,
									createdAt: Date.now(),
								},
							]
						: [],
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
				setConductor(groupId, { status: 'awaiting_approval', holdReason: null });
			setActiveTab('overview');
			if (requestOverride) {
				setDraftDescription('');
				setPlannerNotes('');
				setIsPlanComposerOpen(false);
			}
				if (options?.autoExecute) {
					const approved = approvePlanningRun(runId, { approvedBy: 'conductor' });
				if (approved) {
					window.setTimeout(() => {
						void handleRunReadyTasks();
					}, 0);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Plan generation failed.';
			const isProviderLimit = isConductorProviderLimitMessage(message);
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
			setConductor(groupId, {
				status: 'attention_required',
				isPaused: isProviderLimit,
				holdReason: isProviderLimit ? message : null,
			});
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
		if (isAutoplayPaused) {
			setExecutionError(conductor?.holdReason || autoplayPauseMessage);
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

		if (conductorAutoplayLocks.execution.has(groupId)) {
			return;
		}
		conductorAutoplayLocks.execution.add(groupId);

		try {
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
				currentResourceGate.message || RESOURCE_HOLD_MESSAGE;
			setExecutionError(message);
			setConductor(groupId, { holdReason: message });
			notifyToast({
				type: 'warning',
				title: 'Conductor Is Waiting',
				message,
			});
				return;
			}

			const tasksById = new Map(tasks.map((task) => [task.id, { ...task }]));
		const executionChildTasksByParentId = buildConductorChildTaskMap(Array.from(tasksById.values()));
		const completedTaskIds = new Set(
			Array.from(tasksById.values())
				.filter(
					(task) =>
						getConductorTaskRollupStatus(task, executionChildTasksByParentId, runs) === 'done'
				)
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
						task.source !== 'manual' &&
						isConductorTaskRunnableByAgent(task, executionChildTasksByParentId, runs) &&
						task.dependsOn.every((dependencyId) => completedTaskIds.has(dependencyId))
				)
				.sort(sortTasks);
		const initialCandidates = getDependencyReadyTasks();

			if (initialCandidates.length === 0) {
			setExecutionError('No runnable tasks are available to run yet.');
			return;
			}

			setExecutionError(null);
			setIsExecuting(true);
			setConductor(groupId, { status: 'running', holdReason: null });

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
					message: `Execution started for ${initialCandidates.length} runnable task${initialCandidates.length === 1 ? '' : 's'}.`,
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
				summary: `Executing ${initialCandidates.length} runnable task${initialCandidates.length === 1 ? '' : 's'}.`,
			taskIds: initialCandidates.map((task) => task.id),
			events,
			startedAt,
		});

			let blockedMessage: string | null = null;
			let pausedByUser = false;
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
					`${runId}-${task.id}`,
					conductorWorktreeBasePath || undefined
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
						const revisionRequest = getEffectiveConductorTaskAttentionRequest(task, runs);
						const prompt = buildConductorWorkerPrompt(
							group?.name || 'Unnamed Group',
							{ ...selectedTemplate, cwd: workerTarget.worktreePath },
							task,
							dependencyTitles,
							revisionRequest?.status === 'open' ? revisionRequest.requestedAction : null
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
						expectedSubmissionKind: 'worker',
						onSessionReady: (session) => {
							taskWorkerSessionIds[task.id] = session.id;
							workerAgentSessionIds = Array.from(new Set([...workerAgentSessionIds, session.id]));
							recordTaskAgentHistory(task.id, 'worker', session.id, session.name, runId);
							updateTask(task.id, {
								workerSessionId: session.id,
								workerSessionName: session.name,
								attentionRequest: null,
							});
							tasksById.set(task.id, {
								...task,
								status: 'running',
								workerSessionId: session.id,
								workerSessionName: session.name,
								attentionRequest: null,
								updatedAt: Date.now(),
							});
							updateRun(runId, {
								taskWorkerSessionIds: { ...taskWorkerSessionIds },
								agentSessionIds: [...workerAgentSessionIds],
							});
						},
					});
					const result =
						workerResult.structuredSubmission?.kind === 'worker'
							? parseConductorWorkerSubmission(workerResult.structuredSubmission.payload)
							: parseConductorWorkerResponse(workerResult.response);
					const finishedAt = Date.now();

					if (result.outcome === 'blocked') {
						const blockedReason = result.blockedReason || result.summary;
						if (!shouldRouteWorkerBlockToOperator(blockedReason)) {
							let clarificationSessionId: string | undefined;
							let clarificationGuidance = `Make the narrowest reasonable assumption that fits the task description, acceptance criteria, and nearby code patterns. Keep scope tight and avoid introducing extra work.`;

							try {
								const clarificationResult = await runConductorAgentTurn({
									parentSession: selectedTemplate,
									role: 'planner',
									taskTitle: task.title,
									taskDescription: task.description,
									scopePaths: task.scopePaths,
									prompt: buildConductorWorkerClarificationPrompt({
										groupName: group?.name || 'Unnamed Group',
										task,
										templateSession: { ...selectedTemplate, cwd: workerTarget.worktreePath },
										dependencyTitles,
										blockedReason,
									}),
									cwd: workerTarget.worktreePath,
									branch: workerTarget.branchName,
									runId,
									taskId: task.id,
									readOnlyMode: true,
									onSessionReady: (session) => {
										clarificationSessionId = session.id;
										workerAgentSessionIds = Array.from(
											new Set([...workerAgentSessionIds, session.id])
										);
										recordTaskAgentHistory(task.id, 'planner', session.id, session.name, runId);
										updateRun(runId, {
											agentSessionIds: [...workerAgentSessionIds],
										});
									},
								});
								if (clarificationResult.response.trim()) {
									clarificationGuidance = clarificationResult.response.trim();
								}
							} catch {
								// Fall back to a narrow default guidance note so the worker can keep moving.
							}

							const attentionRequest = buildTaskAttentionRequest({
								kind: 'clarification',
								summary: 'Conductor answered an agent clarification and queued another pass.',
								requestedAction: `Worker asked: ${blockedReason}\n\nConductor guidance: ${clarificationGuidance}`,
								requestedByRole: 'planner',
								requestedBySessionId: clarificationSessionId,
								runId,
							});
							updateTask(task.id, {
								status: 'needs_revision',
								changedPaths: result.changedPaths,
								attentionRequest,
							});
							tasksById.set(task.id, {
								...task,
								status: 'needs_revision',
								changedPaths: result.changedPaths,
								attentionRequest,
								updatedAt: finishedAt,
							});
							events.push({
								id: `conductor-run-event-${generateId()}`,
								runId,
								groupId,
								type: 'task_needs_revision',
								message: `Conductor answered a worker clarification for ${task.title} and queued another pass.`,
								createdAt: finishedAt,
							});
							updateRun(runId, { events: [...events] });
							return;
						}

						const attentionRequest = buildTaskAttentionRequest({
							kind: 'blocked',
							summary: blockedReason,
							requestedAction: blockedReason,
							requestedByRole: 'worker',
							requestedBySessionId: taskWorkerSessionIds[task.id],
							suggestedResponse:
								'Clarify what should happen next, then move the task back to Ready so Conductor can retry it.',
							runId,
						});
						updateTask(task.id, {
							status: 'needs_input',
							changedPaths: result.changedPaths,
							attentionRequest,
						});
						tasksById.set(task.id, {
							...task,
							status: 'needs_input',
							changedPaths: result.changedPaths,
							attentionRequest,
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

					updateTask(task.id, {
						status: 'needs_review',
						changedPaths: result.changedPaths,
						attentionRequest: null,
					});
					tasksById.set(task.id, {
						...task,
						status: 'needs_review',
						changedPaths: result.changedPaths,
						attentionRequest: null,
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
								status: 'ready' as const,
								dependsOn: [],
								scopePaths: task.scopePaths,
								changedPaths: [],
								source: 'worker_followup' as const,
								attentionRequest: null,
								agentHistory: [],
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

					while (activeWorkers.size < currentResourceGate.maxWorkers && !autoplayPauseRef.current) {
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
						if (autoplayPauseRef.current) {
							pausedByUser = true;
							blockedMessage = USER_PAUSED_MESSAGE;
							break;
						}
						const remainingReady = Array.from(tasksById.values()).filter(
							(task) =>
								isConductorTaskRunnableByAgent(task, executionChildTasksByParentId, runs) &&
								task.dependsOn.every((dependencyId) => completedTaskIds.has(dependencyId))
						);
						if (remainingReady.length > 0) {
							blockedMessage =
								blockedTaskIds.size > 0
									? 'Execution finished with blocked tasks. Some remaining tasks could not start because their dependencies are blocked.'
									: 'Execution stopped because remaining runnable tasks overlap in scope or are still waiting on dependencies.';
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
					type: finalBlocked && !pausedByUser ? 'execution_failed' : 'execution_completed',
					message:
						blockedMessage ||
						(finalBlocked
							? 'Execution completed with blocked tasks.'
							: 'Execution lane completed all runnable tasks.'),
					createdAt: endedAt,
				});
				updateRun(runId, {
					status: pausedByUser ? 'cancelled' : finalBlocked ? 'blocked' : 'completed',
					summary:
						blockedMessage ||
						(finalBlocked
							? 'Execution completed with blocked tasks.'
							: 'Execution lane completed all runnable tasks.'),
					endedAt,
					workerBranches: [...workerBranches],
				worktreePaths: [...worktreePaths],
				taskBranches: { ...taskBranches },
				taskWorktreePaths: { ...taskWorktreePaths },
				branchName: workerBranches[0],
					worktreePath: worktreePaths[0],
					events: [...events],
				});
				const needsOperatorAttention = Array.from(tasksById.values()).some((task) =>
					isConductorTaskOperatorActionRequired(task, executionChildTasksByParentId, runs)
				);
				setConductor(groupId, {
					status: pausedByUser
						? 'idle'
						: needsOperatorAttention
							? 'attention_required'
							: finalBlocked
								? 'blocked'
								: 'idle',
					holdReason: pausedByUser
						? USER_PAUSED_MESSAGE
						: finalBlocked
							? blockedMessage
							: null,
				});
				if (finalBlocked && !pausedByUser) {
					setExecutionError(
						blockedMessage ||
							'One or more tasks blocked during execution. Check the event feed for details.'
					);
				}
				cleanupConductorAgentSessions(workerAgentSessionIds);
			} catch (error) {
			const message = error instanceof Error ? error.message : 'Execution failed.';
			const isProviderLimit = isConductorProviderLimitMessage(message);
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
			setConductor(groupId, {
				status: 'attention_required',
				isPaused: isProviderLimit,
				holdReason: isProviderLimit ? message : null,
			});
			setExecutionError(message);
			cleanupConductorAgentSessions(workerAgentSessionIds);
			} finally {
				setIsExecuting(false);
			}
		} finally {
			conductorAutoplayLocks.execution.delete(groupId);
		}
	};

	const handleRunReviewTasks = async () => {
		if (!selectedTemplate) {
			setReviewError('This workspace needs at least one top-level agent before Conductor can run review.');
			return;
		}
		if (isAutoplayPaused) {
			setReviewError(conductor?.holdReason || autoplayPauseMessage);
			return;
		}

		if (reviewReadyTasks.length === 0) {
			setReviewError('No tasks are waiting in the review lane.');
			return;
		}

		const currentResourceGate = evaluateConductorResourceGate(
			conductor?.resourceProfile || 'aggressive',
			resourceSnapshot
		);
		if (!currentResourceGate.allowed) {
			const message = currentResourceGate.message || RESOURCE_HOLD_MESSAGE;
			setReviewError(message);
			setConductor(groupId, { holdReason: message });
			return;
		}

		if (conductorAutoplayLocks.review.has(groupId)) {
			return;
		}
		conductorAutoplayLocks.review.add(groupId);

		try {
			setReviewError(null);
			setIsReviewing(true);
			setConductor(groupId, { status: 'running', holdReason: null });

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
				let malformedResponses = 0;
				let queuedRevisionCount = 0;
				let pausedByUser = false;
				const taskReviewerSessionIds: Record<string, string> = {};
				const runReviewerAttempt = async (
					task: ConductorTask,
					prompt: string,
					reviewCwd: string,
					branch?: string | null
				) => {
					const reviewResult = await runConductorAgentTurn({
						parentSession: selectedTemplate,
						role: 'reviewer',
						taskTitle: task.title,
						taskDescription: task.description,
						scopePaths: task.scopePaths,
						prompt,
						cwd: reviewCwd,
						branch,
						runId,
						taskId: task.id,
						readOnlyMode: true,
						expectedSubmissionKind: 'reviewer',
						onSessionReady: (session) => {
							taskReviewerSessionIds[task.id] = session.id;
							reviewAgentSessionIds = Array.from(new Set([...reviewAgentSessionIds, session.id]));
							recordTaskAgentHistory(task.id, 'reviewer', session.id, session.name, runId);
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

					return reviewResult;
				};

				for (const task of reviewReadyTasks) {
					if (autoplayPauseRef.current) {
						pausedByUser = true;
						break;
					}
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
						const reviewBranch = latestTaskExecution?.taskBranches?.[task.id];
						let reviewAttempt = await runReviewerAttempt(task, prompt, reviewCwd, reviewBranch);
						let result;
						try {
							result =
								reviewAttempt.structuredSubmission?.kind === 'reviewer'
									? parseConductorReviewerSubmission(reviewAttempt.structuredSubmission.payload)
									: parseConductorReviewerResponse(reviewAttempt.response);
						} catch (error) {
							const shouldRetry =
								error instanceof Error && error.message === CONDUCTOR_REVIEWER_JSON_ERROR;
							if (!shouldRetry) {
								throw error;
							}

							const retryPrompt = `${prompt}

IMPORTANT:
- Return exactly one JSON object and nothing else.
- Do not include markdown code fences.
- Do not include commentary before or after the JSON.
- The first character of your response must be { and the last character must be }.`;
							reviewAttempt = await runReviewerAttempt(task, retryPrompt, reviewCwd, reviewBranch);
							result =
								reviewAttempt.structuredSubmission?.kind === 'reviewer'
									? parseConductorReviewerSubmission(reviewAttempt.structuredSubmission.payload)
									: parseConductorReviewerResponse(reviewAttempt.response);
						}
						const reviewedAt = Date.now();

						if (result.decision === 'approved') {
							const requiresProof = requiresConductorTaskCompletionProof(task);
							const hasApprovedProof = hasConductorTaskApprovedCompletionProof(task);
							if (requiresProof && !hasApprovedProof) {
								const nextProof =
									task.completionProof || buildDefaultConductorTaskCompletionProof(reviewedAt);
								updateTask(task.id, {
									status: 'needs_proof',
									attentionRequest: null,
									completionProof: {
										...nextProof,
										requestedAt: nextProof.requestedAt || reviewedAt,
									},
								});
								tasksById.set(task.id, {
									...task,
									status: 'needs_proof',
									attentionRequest: null,
									completionProof: {
										...nextProof,
										requestedAt: nextProof.requestedAt || reviewedAt,
									},
									updatedAt: reviewedAt,
								});
								events.push({
									id: `conductor-run-event-${generateId()}`,
									runId,
									groupId,
									type: 'task_needs_proof',
									message: `Review passed for ${task.title}, but proof of completion is still required before it can move into Done.`,
									createdAt: reviewedAt,
								});
								continue;
							}

							updateTask(task.id, { status: 'done', attentionRequest: null });
							tasksById.set(task.id, {
								...task,
								status: 'done',
								attentionRequest: null,
								updatedAt: reviewedAt,
							});
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
							const followUpTasks = result.followUpTasks;
							const revisionAttentionRequest =
								followUpTasks.length === 0
									? buildTaskAttentionRequest({
											kind: 'review_changes',
											summary: result.summary,
											requestedAction: result.reviewNotes || result.summary,
											requestedByRole: 'reviewer',
											requestedBySessionId: taskReviewerSessionIds[task.id],
											suggestedResponse:
												'Conductor will send this task back to a worker automatically with the reviewer notes attached.',
											runId,
									  })
									: null;
							const createdFollowUpTasks = followUpTasks.map((followUpTask) => ({
								id: `conductor-task-${generateId()}`,
								groupId,
							parentTaskId: task.id,
							title: followUpTask.title,
							description: followUpTask.description,
							acceptanceCriteria: [],
							priority: followUpTask.priority,
							status: 'ready' as const,
							dependsOn: [],
							scopePaths: task.scopePaths,
							changedPaths: [],
							source: 'reviewer_followup' as const,
							attentionRequest: null,
							agentHistory: [],
								createdAt: reviewedAt,
								updatedAt: reviewedAt,
							}));
							queuedRevisionCount += createdFollowUpTasks.length > 0 ? createdFollowUpTasks.length : 1;
							updateTask(task.id, {
								status: 'needs_revision',
								attentionRequest: revisionAttentionRequest,
							});
							tasksById.set(task.id, {
								...task,
								status: 'needs_revision',
								attentionRequest: revisionAttentionRequest,
								updatedAt: reviewedAt,
							});
							for (const followUpTask of createdFollowUpTasks) {
								tasksById.set(followUpTask.id, followUpTask);
							}
							if (createdFollowUpTasks.length > 0) {
								setTasks((previousTasks) => [
									...previousTasks,
									...createdFollowUpTasks,
								]);
							}
							events.push({
								id: `conductor-run-event-${generateId()}`,
								runId,
								groupId,
								type: 'task_needs_revision',
								message:
									followUpTasks.length > 0
										? `Review sent ${task.title} back to revision. ${followUpTasks.length} follow-up task${followUpTasks.length === 1 ? '' : 's'} queued for agents.`
										: `Review sent ${task.title} back for another pass. ${result.summary}`,
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
						const message = error instanceof Error ? error.message : 'Review failed.';
						if (message === CONDUCTOR_REVIEWER_JSON_ERROR) {
							malformedResponses += 1;
							events.push({
								id: `conductor-run-event-${generateId()}`,
								runId,
								groupId,
								type: 'review_failed',
								message: `Review output for ${task.title} was not valid JSON after retry. Task remains in QA.`,
								createdAt: Date.now(),
							});
							continue;
						}
						throw error;
					} finally {
						cancelledTaskIdsRef.current.delete(task.id);
					}
				}

				const finishedAt = Date.now();
				const nextReviewRun: ConductorRun = {
					id: runId,
					groupId,
					kind: 'review',
					baseBranch: latestExecutionRun?.baseBranch || selectedTemplate.worktreeBranch || '',
					sshRemoteId: selectedTemplateSshRemoteId,
					agentSessionIds: [...reviewAgentSessionIds],
					taskReviewerSessionIds: { ...taskReviewerSessionIds },
					integrationBranch: '',
					status: 'running',
					summary: '',
					taskIds: reviewReadyTasks.map((task) => task.id),
					events: [...events],
					startedAt: now,
					endedAt: finishedAt,
				};
				const nextRuns = [...runs.filter((run) => run.id !== runId), nextReviewRun];
				const quarantinedMalformedTaskIds = reviewReadyTasks
					.filter((task) => getConductorTaskQaFailureState(tasksById.get(task.id) || task, nextRuns).isQuarantined)
					.map((task) => task.id);
				const remainingMalformedResponses = Math.max(
					0,
					malformedResponses - quarantinedMalformedTaskIds.length
				);
				const postReviewTasks = Array.from(tasksById.values());
				const postReviewChildTaskMap = buildConductorChildTaskMap(postReviewTasks);
				const completedTaskIds = new Set(
					postReviewTasks
						.filter(
							(task) =>
								getConductorTaskRollupStatus(task, postReviewChildTaskMap, nextRuns) === 'done'
						)
						.map((task) => task.id)
				);
				const dependencyReadyAfterReview = postReviewTasks.filter(
					(task) =>
						task.source !== 'manual' &&
						isConductorTaskRunnableByAgent(task, postReviewChildTaskMap, nextRuns) &&
						task.dependsOn.every((dependencyId) => completedTaskIds.has(dependencyId))
				);
				const needsAttention = remainingMalformedResponses > 0;
				const summary =
					pausedByUser
						? USER_PAUSED_MESSAGE
						: remainingMalformedResponses > 0
						? `Review finished with ${remainingMalformedResponses} malformed response${remainingMalformedResponses === 1 ? '' : 's'} left in QA${quarantinedMalformedTaskIds.length > 0 ? ` after quarantining ${quarantinedMalformedTaskIds.length} task${quarantinedMalformedTaskIds.length === 1 ? '' : 's'}` : ''}${changesRequested > 0 ? ` and ${changesRequested} task${changesRequested === 1 ? '' : 's'} sent to revision` : ''}.`
						: quarantinedMalformedTaskIds.length > 0
							? `Review paused QA for ${quarantinedMalformedTaskIds.length} task${quarantinedMalformedTaskIds.length === 1 ? '' : 's'} after repeated malformed reviewer replies${changesRequested > 0 ? ` and sent ${changesRequested} task${changesRequested === 1 ? '' : 's'} to revision` : ''}.`
						: changesRequested > 0
							? `Review finished with ${changesRequested} task${changesRequested === 1 ? '' : 's'} sent to revision.`
							: 'Review lane approved all queued tasks.';
				updateRun(runId, {
					status: pausedByUser ? 'cancelled' : remainingMalformedResponses > 0 ? 'attention_required' : 'completed',
					summary,
					endedAt: finishedAt,
					events: [...events],
				});
				setConductor(groupId, {
					status: pausedByUser ? 'idle' : needsAttention ? 'attention_required' : 'idle',
					holdReason: pausedByUser ? USER_PAUSED_MESSAGE : null,
				});
				if (pausedByUser) {
					setReviewError(null);
				} else if (remainingMalformedResponses > 0) {
					setReviewError(summary);
				} else {
					setReviewError(null);
					lastAutoRunReadyKeyRef.current = null;
					if (!autoplayPauseRef.current) {
						window.setTimeout(() => {
							if (dependencyReadyAfterReview.length > 0) {
								void handleRunReadyTasks();
							}
						}, 0);
					}
				}
				cleanupConductorAgentSessions(reviewAgentSessionIds);
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Review failed.';
				const isProviderLimit = isConductorProviderLimitMessage(message);
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
				setConductor(groupId, {
					status: 'attention_required',
					isPaused: isProviderLimit,
					holdReason: isProviderLimit ? message : null,
				});
				setReviewError(message);
				cleanupConductorAgentSessions(reviewAgentSessionIds);
			} finally {
				setIsReviewing(false);
			}
		} finally {
			conductorAutoplayLocks.review.delete(groupId);
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
			integrationRunId,
			conductorWorktreeBasePath || undefined
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

	const approvePlanningRun = (
		runId: string,
		options?: {
			approvedBy?: 'operator' | 'conductor';
		}
	): boolean => {
		const run = runs.find((candidate) => candidate.id === runId);
		if (!run) {
			return false;
		}
		const approvedBy = options?.approvedBy || 'operator';
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
						message:
							approvedBy === 'conductor'
								? 'Conductor approved the plan automatically and queued it for execution.'
								: 'You approved the plan. Planner tasks are now ready for execution.',
						createdAt: approvedAt,
					},
				],
			});
		setConductor(groupId, { status: 'idle', holdReason: null });
		cleanupConductorAgentSessions(run.agentSessionIds || []);
		return true;
	};

	const handleApprovePlan = () => {
		if (!pendingRun) {
			return;
		}

		approvePlanningRun(pendingRun.id);
	};

	const handleSetAutoplayPaused = (nextPaused: boolean) => {
		lastAutoPlanReadyKeyRef.current = null;
		lastAutoRunReadyKeyRef.current = null;
		lastAutoReviewReadyKeyRef.current = null;
		setConductor(groupId, {
			isPaused: nextPaused,
			holdReason: nextPaused ? autoplayPauseMessage : null,
		});
	};

	const handleToggleAutoplay = () => {
		handleSetAutoplayPaused(!isAutoplayPaused);
	};

	const handleApplyOrchestratorAction = (action: ConductorOrchestratorAction) => {
		switch (action.type) {
			case 'pause_board':
				if (!isAutoplayPaused) {
					handleSetAutoplayPaused(true);
				}
				notifyToast({
					type: 'success',
					title: 'Conductor Paused',
					message: 'New helper work is paused until you resume it.',
				});
				return;
			case 'resume_board':
				if (isAutoplayPaused) {
					handleSetAutoplayPaused(false);
				}
				notifyToast({
					type: 'success',
					title: 'Conductor Resumed',
					message: 'Queued work can start moving again.',
				});
				return;
			case 'prioritize_task': {
				const task = tasksById.get(action.taskId);
				if (!task || task.priority === action.priority) {
					return;
				}
				updateTask(action.taskId, { priority: action.priority });
				notifyToast({
					type: 'success',
					title: 'Priority Updated',
					message: `${task.title} is now ${formatLabel(action.priority)} priority.`,
				});
				return;
			}
			case 'set_task_group_priority': {
				const matchingTasks = action.taskIds
					.map((taskId) => tasksById.get(taskId))
					.filter((task): task is ConductorTask => Boolean(task))
					.filter((task) => task.priority !== action.priority);
				if (matchingTasks.length === 0) {
					return;
				}
				for (const task of matchingTasks) {
					updateTask(task.id, { priority: action.priority });
				}
				notifyToast({
					type: 'success',
					title: 'Workstream Reprioritized',
					message: `${action.summary} Updated ${matchingTasks.length} task${matchingTasks.length === 1 ? '' : 's'}.`,
				});
				return;
			}
			case 'rebalance_task_groups': {
				const raiseTasks = action.raiseTaskIds
					.map((taskId) => tasksById.get(taskId))
					.filter((task): task is ConductorTask => Boolean(task))
					.filter((task) => task.priority !== action.raisePriority);
				const lowerTasks = action.lowerTaskIds
					.map((taskId) => tasksById.get(taskId))
					.filter((task): task is ConductorTask => Boolean(task))
					.filter((task) => task.priority !== action.lowerPriority);
				for (const task of raiseTasks) {
					updateTask(task.id, { priority: action.raisePriority });
				}
				for (const task of lowerTasks) {
					updateTask(task.id, { priority: action.lowerPriority });
				}
				if (raiseTasks.length === 0 && lowerTasks.length === 0) {
					return;
				}
				notifyToast({
					type: 'success',
					title: 'Priority Plan Applied',
					message: `${action.summary} Updated ${raiseTasks.length + lowerTasks.length} task${
						raiseTasks.length + lowerTasks.length === 1 ? '' : 's'
					}.`,
				});
				return;
			}
			case 'pause_task': {
				const task = tasksById.get(action.taskId);
				if (!task) {
					return;
				}
				handleTaskStatusMove(task.id, 'blocked');
				notifyToast({
					type: 'success',
					title: 'Task Paused',
					message: `${task.title} is paused for now.`,
				});
				return;
			}
			case 'resume_task': {
				const task = tasksById.get(action.taskId);
				if (!task) {
					return;
				}
				handleTaskStatusMove(task.id, 'ready');
				notifyToast({
					type: 'success',
					title: 'Task Resumed',
					message: `${task.title} is back in the queue.`,
				});
				return;
			}
			case 'requeue_task': {
				const task = tasksById.get(action.taskId);
				if (!task) {
					return;
				}
				handleTaskStatusMove(task.id, 'ready');
				notifyToast({
					type: 'success',
					title: 'Task Re-Queued',
					message: `${task.title} is ready for another agent pass.`,
				});
				return;
			}
			case 'open_task':
			case 'open_member':
			default:
				return;
		}
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

	const attentionItems = useMemo<AttentionItem[]>(() => {
		const items: AttentionItem[] = [];

		// Pending plan approval
		if (pendingRun) {
			items.push({
				id: `plan-${pendingRun.id}`,
				kind: 'plan_approval',
				title: `Plan ready for review · ${pendingRun.taskIds.length} task${pendingRun.taskIds.length === 1 ? '' : 's'}`,
				summary: pendingRun.summary || '',
				actionLabel: 'Approve plan',
				onAction: handleApprovePlan,
			});
		}

		// Integration conflicts
		if (latestIntegrationHasConflict && latestIntegrationRun) {
			items.push({
				id: `conflict-${latestIntegrationRun.id}`,
				kind: 'integration_conflict',
				title: 'Merge conflict needs resolution',
				summary: 'Integration branch has conflicts that need to be resolved before continuing.',
				actionLabel: 'Resolve',
				onAction: handleResolveIntegrationConflict,
			});
		}

		// Tasks needing operator action
		for (const task of topLevelTasks) {
			const rolledUpStatus = rolledUpTaskStatusById.get(task.id) || task.status;
			if (
				rolledUpStatus !== 'needs_input' &&
				rolledUpStatus !== 'needs_proof' &&
				rolledUpStatus !== 'blocked'
			) {
				continue;
			}
			const visibleAttention = visibleAttentionByTaskId.get(task.id);
			if (
				visibleAttention?.attentionRequest.status === 'open' &&
				isConductorTaskOperatorActionRequired(
					visibleAttention.task,
					childTasksByParentId,
					runs
				)
			) {
				items.push({
					id: `task-${task.id}`,
					kind: 'operator_action',
					title: task.title,
					summary: formatConductorOperatorMessage(
						visibleAttention.attentionRequest.requestedAction
					),
					actionLabel: rolledUpStatus === 'needs_proof' ? 'Review proof' : 'Respond',
					onAction: () => openTaskDetails(task.id),
				});
			}
		}

		return items;
	}, [
		childTasksByParentId,
		handleApprovePlan,
		handleResolveIntegrationConflict,
		latestIntegrationHasConflict,
		latestIntegrationRun,
		pendingRun,
		rolledUpTaskStatusById,
		runs,
		topLevelTasks,
		visibleAttentionByTaskId,
	]);

	const showAttentionBanner = attentionItems.length > 0 && (
		attentionDismissedAt === 0 ||
		attentionItems.some((item) => !item.id.startsWith('task-') || true)
	);

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

			<div className="flex-1 min-h-0 flex">
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
									Conductor follows this workspace's primary top-level agent automatically. Once
									the workspace has an agent, it will copy that agent's repo, tools, model
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
						hasQueuedAutoplayWork &&
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
											Conductor is holding queued work until this machine settles
										</div>
										<p className="text-sm mt-1 leading-6" style={{ color: theme.colors.textDim }}>
											{resourceGate.message ||
												'Queued work is ready, but the current system load or memory headroom is below the launch threshold.'}
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
										className="relative flex items-center gap-2 px-3 py-2 rounded-xl"
										style={{
											backgroundColor: `${pill.color}10`,
											border: `1px solid ${pill.color}25`,
										}}
									>
										{pill.delta && pill.delta > 0 && (
											<span
												className="absolute -top-1.5 -right-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none"
												style={{
													backgroundColor: pill.color,
													color: theme.colors.bgMain,
												}}
											>
												+{pill.delta}
											</span>
										)}
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

						{/* Attention banner */}
						{showAttentionBanner && (
							<ConductorAttentionBanner
								theme={theme}
								items={attentionItems}
								onDismiss={() => setAttentionDismissedAt(Date.now())}
							/>
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
									onClick={handleToggleAutoplay}
									title={controlStatusMessage || undefined}
									className="px-3 py-1.5 rounded-lg text-xs disabled:opacity-40 inline-flex items-center gap-1.5"
									style={getGlassButtonStyle(theme, { accent: !isAutoplayPaused })}
								>
									{isAutoplayPaused ? (
										<PlayCircle className="w-3.5 h-3.5" />
									) : isExecuting || isReviewing ? (
										<Loader2 className="w-3.5 h-3.5 animate-spin" />
									) : (
										<PauseCircle className="w-3.5 h-3.5" />
									)}
									{isAutoplayPaused ? 'Resume' : 'Pause'}
								</button>
								<button
									onClick={() => openOrchestratorPanel({ scope: 'board' })}
									className="px-3 py-1.5 rounded-lg text-xs inline-flex items-center gap-1.5"
									style={getGlassButtonStyle(theme)}
								>
									<MessageSquarePlus className="w-3.5 h-3.5" />
									Ask Orchestrator
								</button>
								{controlStatusMessage && (
									<div className="text-[11px] ml-1" style={{ color: theme.colors.textDim }}>
										{controlStatusMessage}
									</div>
								)}
							{hasIntegrationResults && (
								<button
									onClick={handleIntegrateCompletedWork}
									disabled={isIntegrating}
									title="Merge completed worker worktrees into one integration branch"
									className="px-3 py-1.5 rounded-lg text-xs disabled:opacity-40 inline-flex items-center gap-1.5"
									style={getGlassButtonStyle(theme)}
								>
									{isIntegrating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderKanban className="w-3.5 h-3.5" />}
									{isIntegrating ? 'Merging...' : 'Merge worktrees'}
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
								disabled={conductorAgentSessions.length === 0 || conductorAgentSessions.every((s) => s.state === 'busy')}
								className="px-3 py-1.5 rounded-lg text-xs disabled:opacity-40 inline-flex items-center gap-1.5"
								style={getGlassButtonStyle(theme)}
							>
								<Trash2 className="w-3.5 h-3.5" />
								End helper agents
							</button>
						</div>

						{/* Errors */}
						{(executionError || reviewError || integrationError) && (
							<div
								className="rounded-lg px-3 py-2 text-xs"
								style={{ backgroundColor: `${theme.colors.warning}12`, border: `1px solid ${theme.colors.warning}28`, color: theme.colors.warning }}
							>
								{formatConductorOperatorMessage(
									executionError || reviewError || integrationError
								)}
							</div>
						)}

						<div className="grid grid-cols-1 xl:grid-cols-[280px_1fr] gap-4 items-start">
							<ConductorTeamPanel
								theme={theme}
								members={conductorTeamMembers}
								onOpenMember={handleOpenTeamMember}
								onOpenTask={openTaskDetails}
								onAskMember={handleAskAboutTeamMember}
							/>

							<ConductorUpdatesPanel
								theme={theme}
								updates={orchestratorUpdates}
								planningSummary={visiblePlanningSummary}
								onOpenTask={openTaskDetails}
								onAskUpdate={handleAskAboutUpdate}
							/>
						</div>

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
												{formatConductorOperatorMessage(pendingRun.summary)}
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

						<div
							className="rounded-xl border p-5"
							style={{
								background: `linear-gradient(180deg, ${theme.colors.bgSidebar}f2 0%, ${theme.colors.bgMain}fa 100%)`,
								backgroundColor: theme.colors.bgSidebar,
								border: '1px solid rgba(255,255,255,0.08)',
								boxShadow:
									'0 20px 38px rgba(15, 23, 42, 0.12), 0 8px 18px rgba(15, 23, 42, 0.07), inset 0 1px 0 rgba(255,255,255,0.08)',
								isolation: 'isolate',
								overflow: 'hidden',
							}}
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
											value={statusFilter.length === 1 ? statusFilter[0] : 'all'}
											onChange={(e) =>
												setStatusFilter(
													e.target.value === 'all'
														? []
														: [e.target.value as ConductorTaskStatus]
												)
											}
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

								{/* Clickable status nav */}
								<div className="flex items-center gap-1 overflow-x-auto scrollbar-thin">
									{backlogView === 'board' ? (
										<>
											{KANBAN_LANES.map((lane) => {
												const laneCount = lane.statuses.reduce(
													(sum, s) => sum + (taskCountsByStatus[s] ?? 0),
													0
												);
												return (
													<button
														key={lane.key}
														type="button"
														onClick={() => scrollToColumn(lane.key)}
														className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors hover:bg-white/5 shrink-0"
														style={getGlassButtonStyle(theme)}
													>
														<span
															className="w-2.5 h-2.5 rounded-full shrink-0"
															style={{ backgroundColor: lane.color }}
														/>
														<span style={{ color: theme.colors.textMain }}>
															{lane.label}
														</span>
														<span className="font-semibold" style={{ color: laneCount > 0 ? lane.color : theme.colors.textDim }}>
															{laneCount}
														</span>
													</button>
												);
											})}
										</>
									) : (
										<>
											{BOARD_COLUMNS.map((status) => {
												const tone = getTaskStatusTone(theme, status);
												const count = taskCountsByStatus[status] ?? 0;
												const isActive = statusFilter.includes(status);
												return (
													<button
														key={status}
														type="button"
														onClick={() => {
															setStatusFilter((current) =>
																current.includes(status)
																	? current.filter((candidate) => candidate !== status)
																	: [...current, status]
															);
														}}
														className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors hover:bg-white/5 shrink-0"
														style={getGlassButtonStyle(theme, { active: isActive })}
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
										</>
									)}
									{(statusFilter.length > 0 || sourceFilter !== 'all' || taskSearch.trim()) && (
										<button
											onClick={clearTaskFilters}
											className="px-2.5 py-1.5 rounded-lg text-xs ml-auto shrink-0"
											style={getGlassButtonStyle(theme)}
										>
											Clear filters
										</button>
									)}
								</div>

								{topLevelTasks.length === 0 ? (
									<div
										className="rounded-xl border p-8 text-center"
										style={{ ...getGlassPanelStyle(theme), color: theme.colors.textDim }}
									>
										Your wish list is empty. Add a change you want, then let Conductor turn it into
										a plan.
									</div>
								) : backlogView === 'board' ? (
									<div
										ref={boardScrollRef}
										className="overflow-x-auto pb-2 scrollbar-thin"
										style={{
											overflowY: 'hidden',
											backgroundColor: theme.colors.bgMain,
											backfaceVisibility: 'hidden',
											transform: 'translateZ(0)',
											overscrollBehaviorX: 'contain',
											maxHeight: CONDUCTOR_BOARD_MAX_HEIGHT,
										}}
									>
										<div className="flex items-start gap-3 min-h-0">
											{KANBAN_LANES.map((lane) => {
												const laneTasks = filteredTasks.filter(
													(task) => lane.statuses.includes(rolledUpTaskStatusById.get(task.id) || task.status)
												);
												const isEmptyLane = laneTasks.length === 0;
												const isExpandedForDrop = dragOverLaneKey === lane.key;
												const isCollapsedLane = isEmptyLane && !isExpandedForDrop;
												const subCounts = lane.statuses
													.map((s) => {
														const count = laneTasks.filter(
															(t) => (rolledUpTaskStatusById.get(t.id) || t.status) === s
														).length;
														return count > 0 ? `${count} ${formatTaskStatusLabel(s).toLowerCase()}` : null;
													})
													.filter(Boolean);
												return (
													<div
														key={lane.key}
														data-column-status={lane.key}
														className="rounded-xl min-h-[280px] flex flex-col overflow-hidden transition-[width,min-width,flex-basis] duration-200 ease-out"
														onDragEnter={(e) => {
															e.preventDefault();
															if (draggedTaskId) {
																setDragOverLaneKey(lane.key);
															}
														}}
														onDragOver={(e) => {
															e.preventDefault();
															if (draggedTaskId && dragOverLaneKey !== lane.key) {
																setDragOverLaneKey(lane.key);
															}
														}}
														onDragLeave={(e) => {
															const relatedTarget = e.relatedTarget;
															if (
																relatedTarget instanceof Node &&
																e.currentTarget.contains(relatedTarget)
															) {
																return;
															}
															if (dragOverLaneKey === lane.key) {
																setDragOverLaneKey(null);
															}
														}}
														onDrop={() => {
															if (draggedTaskId) {
																handleTaskStatusMove(draggedTaskId, lane.dropDefault);
																setDraggedTaskId(null);
															}
															setDragOverLaneKey(null);
														}}
														style={{
															backgroundColor: theme.colors.bgSidebar,
															border: `1px solid ${lane.color}3d`,
															boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
															flex: isCollapsedLane ? '0 0 56px' : '1 1 0%',
															minWidth: isCollapsedLane ? '56px' : '180px',
															height: isCollapsedLane ? undefined : CONDUCTOR_BOARD_MAX_HEIGHT,
															maxHeight: isCollapsedLane ? undefined : CONDUCTOR_BOARD_MAX_HEIGHT,
														}}
													>
														{/* Colored top bar */}
														<div
															className="h-1 w-full shrink-0"
															style={{ backgroundColor: lane.color }}
														/>
														{/* Lane header */}
														<div
															className={`px-3 py-2.5 ${isCollapsedLane ? 'flex flex-col items-center justify-start text-center gap-1.5 px-1.5 py-3 min-h-[140px]' : 'flex flex-col gap-1'}`}
															style={{
																backgroundColor: `${lane.color}0d`,
																borderBottom: isCollapsedLane ? 'none' : `1px solid ${lane.color}3d`,
															}}
														>
															<div className={isCollapsedLane ? 'flex flex-col items-center gap-1.5' : 'flex items-center gap-2'}>
																<span
																	className="text-sm font-semibold"
																	style={{
																		color: lane.color,
																		writingMode: isCollapsedLane ? 'vertical-rl' : undefined,
																		letterSpacing: isCollapsedLane ? '0.08em' : undefined,
																	}}
																>
																	{lane.label}
																</span>
																<span
																	className="text-[11px] font-medium px-1.5 py-0.5 rounded-full ml-auto"
																	style={{
																		backgroundColor: `${lane.color}1a`,
																		color: lane.color,
																	}}
																>
																	{laneTasks.length}
																</span>
															</div>
															{!isCollapsedLane && subCounts.length > 1 && (
																<div className="text-[11px]" style={{ color: theme.colors.textDim }}>
																	{subCounts.join(' · ')}
																</div>
															)}
															{isCollapsedLane && draggedTaskId && (
																<span
																	className="text-[11px]"
																	style={{ color: theme.colors.textDim }}
																>
																	Drop here
																</span>
															)}
														</div>
														{/* Cards */}
														<div
															className="flex-1 p-2 space-y-2 overflow-y-auto scrollbar-thin"
															style={{
																display: isCollapsedLane ? 'none' : undefined,
																minHeight: 0,
																maxHeight: '100%',
																overscrollBehavior: 'contain',
																backfaceVisibility: 'hidden',
																backgroundColor: theme.colors.bgSidebar,
															}}
														>
																{laneTasks.length > 0 ? (
																	laneTasks.map((task) => {
																		const taskStatus = rolledUpTaskStatusById.get(task.id) || task.status;
																		const priorityTone = getTaskPriorityTone(theme, task.priority);
																		const statusTone = getTaskStatusTone(theme, taskStatus);
																		const completionProofCardState = getCompletionProofCardState(
																			task,
																			taskStatus
																		);
																		const completionProofTint = completionProofCardState
																			? getCompletionProofTint(theme, completionProofCardState.tone)
																			: null;
																		const childTasks = childTasksByParentId.get(task.id) || [];
																		const taskProgress = getConductorTaskProgress(
																			task,
																			childTasksByParentId
																		);
																		const canStopTask = Boolean(getActiveTaskSessionId(task));
																		return (
																		<div
																			key={task.id}
																			draggable
																			onDragStart={() => setDraggedTaskId(task.id)}
																			onDragEnd={() => {
																				setDraggedTaskId(null);
																				setDragOverLaneKey(null);
																			}}
																			onClick={() => openTaskDetails(task.id)}
																			className="rounded-lg overflow-hidden cursor-grab active:cursor-grabbing group transition-all hover:translate-y-[-1px] hover:shadow-lg"
																			style={{
																				backgroundColor: draggedTaskId === task.id
																					? `${theme.colors.accent}08`
																					: theme.colors.bgMain,
																				border: `1px solid ${draggedTaskId === task.id
																					? `${theme.colors.accent}45`
																					: 'rgba(255,255,255,0.08)'}`,
																				boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08)',
																				borderLeft: lane.statuses.length > 1 ? `3px solid ${statusTone.fg}` : undefined,
																			}}
																		>
																				<div className="p-2.5">
																				<div className="flex items-start gap-2">
																					<div className="min-w-0 flex-1">
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
																						{lane.statuses.length > 1 && (
																							<span
																								className="inline-block text-[11px] mt-1 px-1.5 py-0.5 rounded"
																								style={{ backgroundColor: statusTone.bg, color: statusTone.fg }}
																							>
																								{formatTaskStatusLabel(taskStatus)}
																							</span>
																						)}
																							{task.description && (
																								<p
																									className="text-xs mt-1.5 line-clamp-2 leading-relaxed"
																									style={{ color: theme.colors.textDim }}
																								>
																									{task.description}
																								</p>
																							)}
																							{completionProofCardState && (
																								<div className="flex flex-wrap gap-1.5 mt-2">
																									<span
																										className="px-1.5 py-0.5 rounded text-[11px] font-medium"
																										style={{
																											backgroundColor: `${completionProofTint}14`,
																											border: `1px solid ${completionProofTint}28`,
																											color: completionProofTint || theme.colors.textDim,
																										}}
																									>
																										{completionProofCardState.label}
																									</span>
																									{task.completionProof?.demoId ? (
																										<button
																											onClick={(e) => {
																												e.stopPropagation();
																												setOpenProofDemoId(task.completionProof?.demoId || null);
																											}}
																											className="px-1.5 py-0.5 rounded text-[11px] inline-flex items-center gap-1 hover:bg-white/10"
																											style={{
																												color: theme.colors.textMain,
																												border: '1px solid rgba(255,255,255,0.10)',
																											}}
																										>
																											<PlayCircle className="w-3 h-3" />
																											Review proof
																										</button>
																									) : null}
																								</div>
																							)}
																							{(visibleAttentionByTaskId.get(task.id)?.attentionRequest.status === 'open' ||
																								(taskStatus === 'needs_revision' && Boolean(openFollowUpsByTaskId.get(task.id)?.length))) && (
																							<p
																								className="text-[11px] mt-2 leading-relaxed"
																								style={{ color: theme.colors.warning }}
																							>
																								{visibleAttentionByTaskId.get(task.id) &&
																									isConductorTaskOperatorActionRequired(
																										visibleAttentionByTaskId.get(task.id)!.task,
																										childTasksByParentId,
																										runs
																									)
																										? formatConductorOperatorMessage(
																											visibleAttentionByTaskId.get(task.id)?.attentionRequest.requestedAction
																										)
																										: openFollowUpsByTaskId.get(task.id)?.[0]?.title || 'Agents are handling review changes.'}
																							</p>
																						)}
																						{taskProgress.totalSubtasks > 0 && (
																							<div className="mt-2 space-y-1.5">
																								<div className="flex items-center justify-between gap-2 text-[11px]">
																									<span style={{ color: theme.colors.textDim }}>
																										Subtasks
																									</span>
																									<span style={{ color: theme.colors.textMain }}>
																										{taskProgress.completedSubtasks}/{taskProgress.totalSubtasks}
																									</span>
																								</div>
																								<div
																									className="h-1.5 rounded-full overflow-hidden"
																									style={{ backgroundColor: 'rgba(255,255,255,0.08)' }}
																								>
																									<div
																										className="h-full rounded-full"
																										style={{
																											width: `${Math.round(taskProgress.completionRatio * 100)}%`,
																											backgroundColor: priorityTone.fg,
																										}}
																									/>
																								</div>
																							</div>
																						)}
																						{getTaskAgentBadges(task).length > 0 && (
																							<div className="flex flex-wrap gap-1.5 mt-2">
																								{getTaskAgentBadges(task).map((badge) => (
																									<button
																										key={badge.key}
																										onClick={(e) => { e.stopPropagation(); handleOpenAgentSession(badge.sessionId); }}
																										disabled={!sessionById.has(badge.sessionId)}
																										className="px-1.5 py-0.5 rounded text-[11px] disabled:opacity-70"
																										style={getGlassPillStyle(theme, badge.tone)}
																									>
																										{badge.label}
																									</button>
																								))}
																							</div>
																						)}
																					</div>
																					<button
																						onClick={(e) => { e.stopPropagation(); deleteTask(task.id); }}
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
																								onClick={(e) => { e.stopPropagation(); void handleStopTask(task); }}
																								className="rounded px-1.5 py-1 text-[11px] inline-flex items-center gap-1 hover:bg-white/10"
																								style={{ color: theme.colors.textDim }}
																							>
																								<Square className="w-3 h-3" />
																								Stop
																							</button>
																						)}
																						{childTasks.length > 0 && (
																							<span className="text-[11px] ml-auto" style={{ color: theme.colors.textDim }}>
																								{taskProgress.openSubtasks} open
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
																		borderColor: `${lane.color}20`,
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
									<div className="space-y-3">
										{filteredTasks.length > 0 ? (
											<>
												<div
													className="hidden lg:block rounded-xl border overflow-hidden"
													style={getGlassPanelStyle(theme, {
														tint: 'rgba(255,255,255,0.08)',
														borderColor: 'rgba(255,255,255,0.08)',
													})}
												>
													<div className="overflow-x-auto scrollbar-thin">
														<table
															className="w-full text-sm"
															style={{ borderCollapse: 'separate', borderSpacing: 0, minWidth: 960 }}
														>
															<colgroup>
																<col style={{ width: '42%' }} />
																<col style={{ width: '12%' }} />
																<col style={{ width: '12%' }} />
																<col style={{ width: '7%' }} />
																<col style={{ width: '8%' }} />
																<col style={{ width: '11%' }} />
																<col style={{ width: '8%' }} />
															</colgroup>
															<thead>
																<tr
																	style={{
																		backgroundColor: 'rgba(255,255,255,0.04)',
																	}}
																>
																	{['Task', 'Priority', 'Source', 'Deps', 'Scope', 'Updated', 'Actions'].map((label) => (
																		<th
																			key={label}
																			className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide"
																			style={{
																				color: theme.colors.textDim,
																				borderBottom: '1px solid rgba(255,255,255,0.08)',
																			}}
																		>
																			{label}
																		</th>
																	))}
																</tr>
															</thead>
															{BOARD_COLUMNS.map((status) => {
																const sectionTasks = filteredTasks.filter(
																	(task) => (rolledUpTaskStatusById.get(task.id) || task.status) === status
																);
																if (sectionTasks.length === 0) {
																	return null;
																}

																const tone = getTaskStatusTone(theme, status);
																return (
																	<tbody key={status}>
																		<tr>
																			<td
																				colSpan={7}
																				className="px-4 py-2.5"
																				style={{
																					backgroundColor: `${tone.fg}10`,
																					borderTop: '1px solid rgba(255,255,255,0.06)',
																					borderBottom: '1px solid rgba(255,255,255,0.06)',
																				}}
																			>
																				<div className="flex items-center justify-between gap-3">
																					<div className="flex items-center gap-2">
																						<span
																							className="w-2.5 h-2.5 rounded-full shrink-0"
																							style={{ backgroundColor: tone.fg }}
																						/>
																						<span
																							className="text-xs font-semibold uppercase tracking-wide"
																							style={{ color: tone.fg }}
																						>
																							{formatTaskStatusLabel(status)}
																						</span>
																					</div>
																					<span
																						className="text-[11px] font-medium"
																						style={{ color: theme.colors.textDim }}
																					>
																						{sectionTasks.length}
																					</span>
																				</div>
																			</td>
																		</tr>
																		{sectionTasks.map((task) => {
																			const priorityTone = getTaskPriorityTone(theme, task.priority);
																			const taskStatus =
																				rolledUpTaskStatusById.get(task.id) || task.status;
																			const completionProofCardState = getCompletionProofCardState(
																				task,
																				taskStatus
																			);
																			const completionProofTint = completionProofCardState
																				? getCompletionProofTint(theme, completionProofCardState.tone)
																				: null;
																			const childTasks = childTasksByParentId.get(task.id) || [];
																			const taskProgress = getConductorTaskProgress(task, childTasksByParentId);
																			const canStopTask = Boolean(getActiveTaskSessionId(task));
																			const visibleAttention = visibleAttentionByTaskId.get(task.id);
																			const attentionText =
																				visibleAttention?.attentionRequest.status === 'open'
																					? isConductorTaskOperatorActionRequired(
																						visibleAttention.task,
																						childTasksByParentId,
																						runs
																					)
																						? formatConductorOperatorMessage(
																							visibleAttention.attentionRequest.requestedAction
																						)
																						: openFollowUpsByTaskId.get(task.id)?.[0]?.title ||
																							'Agents are handling review changes.'
																					: null;
																			return (
																				<tr
																					key={task.id}
																					onClick={() => openTaskDetails(task.id)}
																					className="hover:bg-white/5 cursor-pointer"
																				>
																					<td
																						className="px-4 py-3 align-top"
																						style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
																					>
																						<div
																							className="font-medium"
																							style={{ color: theme.colors.textMain }}
																						>
																							{task.title}
																						</div>
																						{attentionText && (
																							<div
																								className="text-xs mt-1 line-clamp-1"
																								title={attentionText}
																								style={{ color: theme.colors.warning }}
																							>
																								{attentionText}
																							</div>
																						)}
																							{childTasks.length > 0 && (
																								<div
																									className="text-[11px] mt-1"
																									style={{ color: theme.colors.textDim }}
																								>
																									{taskProgress.completedSubtasks}/{taskProgress.totalSubtasks} subtasks complete
																								</div>
																							)}
																							{completionProofCardState && (
																								<div className="flex flex-wrap gap-1.5 mt-2">
																									<span
																										className="px-1.5 py-0.5 rounded text-[11px] font-medium"
																										style={{
																											backgroundColor: `${completionProofTint}14`,
																											border: `1px solid ${completionProofTint}28`,
																											color: completionProofTint || theme.colors.textDim,
																										}}
																									>
																										{completionProofCardState.label}
																									</span>
																									{task.completionProof?.demoId ? (
																										<button
																											onClick={(event) => {
																												event.stopPropagation();
																												setOpenProofDemoId(task.completionProof?.demoId || null);
																											}}
																											className="px-1.5 py-0.5 rounded text-[11px] inline-flex items-center gap-1 hover:bg-white/10"
																											style={{
																												color: theme.colors.textMain,
																												border: '1px solid rgba(255,255,255,0.10)',
																											}}
																										>
																											<PlayCircle className="w-3 h-3" />
																											Review proof
																										</button>
																									) : null}
																								</div>
																							)}
																						</td>
																					<td
																						className="px-4 py-3 align-top"
																						style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
																					>
																						<select
																							value={task.priority}
																							onChange={(e) =>
																								updateTask(task.id, {
																									priority: e.target.value as ConductorTaskPriority,
																								})
																							}
																							className="w-full rounded-lg border px-2 py-1.5 text-xs"
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
																					</td>
																					<td
																						className="px-4 py-3 align-top text-xs"
																						style={{
																							color: theme.colors.textDim,
																							borderBottom: '1px solid rgba(255,255,255,0.05)',
																						}}
																					>
																						{formatTaskSourceLabel(task.source)}
																					</td>
																					<td
																						className="px-4 py-3 align-top text-xs"
																						style={{
																							color: theme.colors.textMain,
																							borderBottom: '1px solid rgba(255,255,255,0.05)',
																						}}
																					>
																						{task.dependsOn.length}
																					</td>
																					<td
																						className="px-4 py-3 align-top text-xs"
																						style={{
																							color: theme.colors.textMain,
																							borderBottom: '1px solid rgba(255,255,255,0.05)',
																						}}
																					>
																						{task.scopePaths.length}
																					</td>
																					<td
																						className="px-4 py-3 align-top text-xs"
																						style={{
																							color: theme.colors.textDim,
																							borderBottom: '1px solid rgba(255,255,255,0.05)',
																						}}
																					>
																						{new Date(task.updatedAt).toLocaleDateString()}
																					</td>
																					<td
																						className="px-4 py-3 align-top"
																						style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
																					>
																						<div className="flex justify-end items-center gap-1">
																							{canStopTask && (
																								<button
																									onClick={() => void handleStopTask(task)}
																									className="p-1.5 rounded-lg hover:bg-white/5"
																									title="Stop task"
																									style={{ color: theme.colors.textDim }}
																								>
																									<Square className="w-4 h-4" />
																								</button>
																							)}
																							<button
																								onClick={() => openTaskComposer(task.id)}
																								className="p-1.5 rounded-lg hover:bg-white/5"
																								title="Add subtask"
																								style={{ color: theme.colors.textDim }}
																							>
																								<ClipboardList className="w-4 h-4" />
																							</button>
																							<button
																								onClick={() => deleteTask(task.id)}
																								className="p-1.5 rounded-lg hover:bg-white/5"
																								title="Delete task"
																								style={{ color: theme.colors.textDim }}
																							>
																								<Trash2 className="w-4 h-4" />
																							</button>
																						</div>
																					</td>
																				</tr>
																			);
																		})}
																	</tbody>
																);
															})}
														</table>
													</div>
												</div>

												<div className="lg:hidden space-y-3">
													{BOARD_COLUMNS.map((status) => {
														const sectionTasks = filteredTasks.filter(
															(task) => (rolledUpTaskStatusById.get(task.id) || task.status) === status
														);
														if (sectionTasks.length === 0) {
															return null;
														}

														const tone = getTaskStatusTone(theme, status);
														return (
															<div
																key={status}
																className="rounded-xl border overflow-hidden"
																style={getGlassPanelStyle(theme, {
																	tint: 'rgba(255,255,255,0.08)',
																	borderColor: tone.border,
																})}
															>
																<div
																	className="flex items-center justify-between gap-3 px-4 py-3"
																	style={{
																		borderBottom: `1px solid ${tone.border}`,
																		backgroundColor: `${tone.fg}10`,
																	}}
																>
																	<div className="flex items-center gap-2">
																		<span
																			className="w-2.5 h-2.5 rounded-full shrink-0"
																			style={{ backgroundColor: tone.fg }}
																		/>
																		<div
																			className="text-sm font-semibold"
																			style={{ color: theme.colors.textMain }}
																		>
																			{formatTaskStatusLabel(status)}
																		</div>
																	</div>
																	<div
																		className="px-2 py-1 rounded-full text-[11px] font-medium"
																		style={{
																			backgroundColor: `${tone.fg}18`,
																			color: tone.fg,
																		}}
																	>
																		{sectionTasks.length}
																	</div>
																</div>
																<div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
																	{sectionTasks.map((task) => {
																		const canStopTask = Boolean(getActiveTaskSessionId(task));
																		const visibleAttention = visibleAttentionByTaskId.get(task.id);
																		const attentionText =
																			visibleAttention?.attentionRequest.status === 'open'
																				? formatConductorOperatorMessage(
																					visibleAttention.attentionRequest.requestedAction
																				)
																				: null;
																		return (
																			<div
																				key={task.id}
																				className="px-4 py-3"
																				onClick={() => openTaskDetails(task.id)}
																				style={{ cursor: 'pointer' }}
																			>
																				<div className="flex items-start justify-between gap-3">
																					<div className="min-w-0">
																						<div
																							className="text-sm font-medium"
																							style={{ color: theme.colors.textMain }}
																						>
																							{task.title}
																						</div>
																						{attentionText && (
																							<div
																								className="text-xs mt-1"
																								style={{ color: theme.colors.warning }}
																							>
																								{attentionText}
																							</div>
																						)}
																					</div>
																					<div className="flex items-center gap-1">
																						{canStopTask && (
																							<button
																								onClick={() => void handleStopTask(task)}
																								className="p-1.5 rounded-lg hover:bg-white/5"
																								title="Stop task"
																								style={{ color: theme.colors.textDim }}
																							>
																								<Square className="w-4 h-4" />
																							</button>
																						)}
																						<button
																							onClick={() => openTaskComposer(task.id)}
																							className="p-1.5 rounded-lg hover:bg-white/5"
																							title="Add subtask"
																							style={{ color: theme.colors.textDim }}
																						>
																							<ClipboardList className="w-4 h-4" />
																						</button>
																						<button
																							onClick={() => deleteTask(task.id)}
																							className="p-1.5 rounded-lg hover:bg-white/5"
																							title="Delete task"
																							style={{ color: theme.colors.textDim }}
																						>
																							<Trash2 className="w-4 h-4" />
																						</button>
																					</div>
																				</div>
																			</div>
																		);
																	})}
																</div>
															</div>
														);
													})}
												</div>
											</>
										) : (
											<div
												className="rounded-xl border px-4 py-10 text-center"
												style={{ ...getGlassPanelStyle(theme), color: theme.colors.textDim }}
											>
												No tasks match the current search and filters.
											</div>
										)}
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
											<div className="flex items-center gap-2">
												<div className="font-semibold" style={{ color: theme.colors.textMain }}>
													{formatConductorOperatorMessage(run.summary) || 'Conductor planning run'}
												</div>
												{!runIsLiveById.get(run.id) && run.endedAt && (
													<span
														className="px-1.5 py-0.5 rounded-full text-[11px] uppercase tracking-wide"
														style={{
															backgroundColor: 'rgba(255,255,255,0.06)',
															color: theme.colors.textDim,
														}}
													>
														History
													</span>
												)}
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

			{orchestratorPanelContext && (
				<ConductorOrchestratorPanel
					theme={theme}
					groupName={group?.name || 'Conductor'}
					isOpen
					context={orchestratorPanelContext}
					conductor={conductor}
					tasksById={tasksById}
					childTasksByParentId={childTasksByParentId}
					runs={runs}
					updates={orchestratorUpdates}
					teamMembers={conductorTeamMembers}
					onOpenTask={openTaskDetails}
					onOpenMember={handleOpenTeamMemberByName}
					onApplyAction={handleApplyOrchestratorAction}
					onClose={() => setOrchestratorPanelContext(null)}
				/>
			)}
			</div>

			{isSettingsOpen && (
				<Modal
					theme={theme}
					title="Settings"
					priority={MODAL_PRIORITIES.SETTINGS + 1}
					onClose={() => setIsSettingsOpen(false)}
					width={620}
					maxHeight="85vh"
					closeOnBackdropClick
				>
					<div className="space-y-4 text-sm">
						{/* ── Workspace lead (read-only) ── */}
						<div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
							style={{ borderColor: 'rgba(255,255,255,0.08)', backgroundColor: `${theme.colors.bgSidebar}80` }}
						>
							<span style={{ color: theme.colors.textDim }}>Workspace lead</span>
							<span className="font-medium" style={{ color: theme.colors.textMain }}>
								{selectedTemplate?.name || 'None'}
							</span>
						</div>

						{/* ── Core controls (2-col grid) ── */}
						<div className="grid grid-cols-2 gap-3">
							<div>
								<div className="mb-1.5 text-xs" style={{ color: theme.colors.textDim }}>Resource profile</div>
								<select
									value={conductor?.resourceProfile || 'aggressive'}
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
								<div className="mb-1.5 text-xs" style={{ color: theme.colors.textDim }}>Publish policy</div>
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
									<option value="none">None</option>
								</select>
							</div>
						</div>

						{/* ── Validation command ── */}
						<div>
							<div className="mb-1.5 text-xs" style={{ color: theme.colors.textDim }}>Validation command</div>
							<div className="flex items-center gap-2">
								<input
									value={validationDraft}
									onChange={(e) => setValidationDraft(e.target.value)}
									placeholder="e.g. npm test"
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

						{/* ── Toggle switches ── */}
						<div className="space-y-1">
							<label
								className="flex items-center gap-2.5 rounded-lg px-3 py-2 cursor-pointer"
								style={{ color: theme.colors.textMain }}
							>
								<input
									type="checkbox"
									checked={Boolean(conductor?.autoExecuteOnPlanCreation)}
									onChange={(e) =>
										setConductor(groupId, { autoExecuteOnPlanCreation: e.target.checked })
									}
								/>
								Autoplay approved plans
							</label>
							<label
								className="flex items-center gap-2.5 rounded-lg px-3 py-2 cursor-pointer"
								style={{ color: theme.colors.textMain }}
							>
								<input
									type="checkbox"
									checked={Boolean(conductor?.deleteWorkerBranchesOnSuccess)}
									onChange={(e) =>
										setConductor(groupId, { deleteWorkerBranchesOnSuccess: e.target.checked })
									}
								/>
								Delete worker branches on success
							</label>
							<label
								className="flex items-center gap-2.5 rounded-lg px-3 py-2 cursor-pointer"
								style={{ color: theme.colors.textMain }}
							>
								<input
									type="checkbox"
									checked={Boolean(conductor?.keepConductorAgentSessions)}
									onChange={(e) =>
										setConductor(groupId, { keepConductorAgentSessions: e.target.checked })
									}
								/>
								Keep helper agents after runs
							</label>
							<label
								className="flex items-center gap-2.5 rounded-lg px-3 py-2 cursor-pointer"
								style={{ color: theme.colors.textMain }}
							>
								<input
									type="checkbox"
									checked={advancedMode}
									onChange={(e) => setAdvancedMode(e.target.checked)}
								/>
								Show advanced details in UI
							</label>
						</div>

						{/* ── Worktree storage ── */}
						<div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
							style={{ borderColor: 'rgba(255,255,255,0.08)', backgroundColor: `${theme.colors.bgSidebar}80` }}
						>
							<div className="min-w-0">
								<span className="text-xs" style={{ color: theme.colors.textDim }}>Worktrees</span>
								<div className="text-xs mt-0.5 truncate" style={{ color: theme.colors.textMain }}>
									{conductorWorktreeBasePath || 'Beside the repo'}
								</div>
							</div>
							<button
								onClick={handleConfigureConductorWorktreeStorage}
								className="px-2.5 py-1.5 rounded-lg text-xs shrink-0 inline-flex items-center gap-1.5"
								style={getGlassButtonStyle(theme)}
							>
								<FolderOpen className="w-3 h-3" />
								Change
							</button>
						</div>

						{/* ── Provider routing ── */}
						<div className="rounded-lg border p-3"
							style={{ borderColor: 'rgba(255,255,255,0.08)', backgroundColor: `${theme.colors.bgSidebar}80` }}
						>
							<div className="text-xs mb-3" style={{ color: theme.colors.textDim }}>Provider routing</div>
							<div className="grid grid-cols-3 gap-3">
								{([
									['default', 'General'],
									['ui', 'UI'],
									['backend', 'Backend'],
								] as Array<[ConductorProviderRouteKey, string]>).map(([routeKey, label]) => (
									<div key={routeKey} className="space-y-1.5">
										<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>{label}</div>
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
											className="w-full rounded-lg border px-2 py-1.5 text-xs"
											style={getGlassInputStyle(theme)}
										>
											{CONDUCTOR_PROVIDER_PRIMARY_OPTIONS.map((option) => (
												<option key={`${routeKey}-${option}`} value={option}>
													{formatProviderChoiceLabel(option)}
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
															fallback: (e.target.value as ConductorProviderAgent) || null,
														},
													},
												})
											}
											className="w-full rounded-lg border px-2 py-1.5 text-xs"
											style={getGlassInputStyle(theme)}
										>
											<option value="">No fallback</option>
											{CONDUCTOR_PROVIDER_OPTIONS.map((option) => (
												<option key={`${routeKey}-fb-${option}`} value={option}>
													{getProviderDisplayName(option)}
												</option>
											))}
										</select>
									</div>
								))}
							</div>
							<div className="flex items-center gap-3 mt-3">
								<label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: theme.colors.textMain }}>
									<input
										type="checkbox"
										checked={providerRouting.pauseNearLimit}
										onChange={(e) =>
											setConductor(groupId, {
												providerRouting: { ...providerRouting, pauseNearLimit: e.target.checked },
											})
										}
									/>
									Pause near limit
								</label>
								<div className="flex items-center gap-1.5">
									<span className="text-xs" style={{ color: theme.colors.textDim }}>at</span>
									<input
										type="number"
										min={50}
										max={99}
										value={providerRouting.nearLimitPercent}
										onChange={(e) =>
											setConductor(groupId, {
												providerRouting: {
													...providerRouting,
													nearLimitPercent: Math.min(99, Math.max(50, Number(e.target.value) || 88)),
												},
											})
										}
										className="w-16 rounded-lg border px-2 py-1 text-xs text-center"
										style={getGlassInputStyle(theme)}
									/>
									<span className="text-xs" style={{ color: theme.colors.textDim }}>%</span>
								</div>
							</div>
						</div>

						{/* ── System resources (compact footer) ── */}
						<div
							className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs rounded-lg border px-3 py-2"
							style={{ borderColor: 'rgba(255,255,255,0.06)', color: theme.colors.textDim }}
						>
							<span>CPU: <span style={{ color: theme.colors.textMain }}>{resourceSnapshot?.cpuCount || '–'}</span></span>
							<span>Load: <span style={{ color: theme.colors.textMain }}>{resourceSnapshot ? resourceSnapshot.loadAverage[0].toFixed(2) : '–'}</span></span>
							<span>Mem: <span style={{ color: theme.colors.textMain }}>{formatMemorySummary(resourceSnapshot)}</span></span>
							<span>Gate:{' '}
								<span style={{ color: resourceGate.allowed ? theme.colors.success : theme.colors.warning }}>
									{resourceGate.allowed ? 'Open' : 'Holding'}
								</span>
							</span>
							{resourceGate.message && (
								<span style={{ color: theme.colors.warning }}>{resourceGate.message}</span>
							)}
						</div>
					</div>
				</Modal>
			)}

			{selectedConductorThreadMember && selectedConductorThreadMember.threadTargets.length > 1 && (
				<Modal
					theme={theme}
					title="Choose a thread"
					priority={MODAL_PRIORITIES.SETTINGS + 4}
					onClose={() => setSelectedConductorThreadMember(null)}
					width={520}
					maxHeight="70vh"
					closeOnBackdropClick
				>
					<div className="space-y-3">
						<div className="text-sm" style={{ color: theme.colors.textDim }}>
							Pick the conversation you want to open for {selectedConductorThreadMember.name}.
						</div>
						<div className="space-y-2">
							{selectedConductorThreadMember.threadTargets.map((target, index) => (
								<button
									key={`${target.sessionId}-${target.tabId || index}`}
									type="button"
									onClick={() => handleNavigateToAgentThread(target.sessionId, target.tabId)}
									className="w-full rounded-lg border px-3 py-3 text-left hover:bg-white/5"
									style={{
										backgroundColor:
											selectedConductorThreadMember.sessionId === target.sessionId
												? `${theme.colors.accent}08`
												: 'rgba(255,255,255,0.02)',
										borderColor:
											selectedConductorThreadMember.sessionId === target.sessionId
												? `${theme.colors.accent}26`
												: 'rgba(255,255,255,0.08)',
									}}
								>
									<div className="flex items-center justify-between gap-3">
										<div className="min-w-0">
											<div className="text-sm font-medium truncate" style={{ color: theme.colors.textMain }}>
												{target.label || `Thread ${index + 1}`}
											</div>
										</div>
										{selectedConductorThreadMember.sessionId === target.sessionId && (
											<span
												className="px-2 py-1 rounded-full text-[11px] uppercase tracking-wide"
												style={getGlassPillStyle(theme, 'accent')}
											>
												Current
											</span>
										)}
									</div>
								</button>
							))}
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
				const detailStatus =
					selectedTaskRolledUpStatus || selectedTaskDetail.status;
				const detailStatusTone = PASTEL_STATUS_TONES[detailStatus] || PASTEL_STATUS_TONES.draft;
				const detailPriorityTone = getTaskPriorityTone(theme, selectedTaskDetail.priority);
				const isTopLevelTask = !selectedTaskDetail.parentTaskId;
				const completionProofRequired = requiresConductorTaskCompletionProof(selectedTaskDetail);
				const completionProofRequirement =
					selectedTaskDetail.completionProofRequirement ||
					buildDefaultConductorTaskCompletionProofRequirement();
				const completionProofStatus =
					selectedTaskDetail.completionProof?.status || 'missing';
				const showProofResponseUi =
					detailStatus !== 'needs_proof' &&
					!isConductorCompletionProofAttentionRequestId(selectedTaskEffectiveAttention?.id);
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

							{detailStatus !== selectedTaskDetail.status && (
								<span
									className="px-2.5 py-1 rounded-full text-[11px]"
									style={{
										backgroundColor: `${detailStatusTone.fg}12`,
										color: detailStatusTone.fg,
									}}
								>
									Board: {formatTaskStatusLabel(detailStatus)}
								</span>
							)}

							<button
								onClick={() => openOrchestratorPanel({ scope: 'task', taskId: selectedTaskDetail.id })}
								className="px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 hover:bg-white/10"
								style={{
									color: theme.colors.textDim,
									border: '1px solid rgba(255,255,255,0.10)',
								}}
							>
								<MessageSquarePlus className="w-3.5 h-3.5" />
								Ask orchestrator
							</button>

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

						{isTopLevelTask && (
							<div
								className="rounded-xl border p-4 space-y-3"
								style={{
									backgroundColor: theme.colors.bgSidebar,
									borderColor: 'rgba(255,255,255,0.08)',
								}}
							>
								<div className="flex items-start justify-between gap-4">
									<div>
										<div
											className="text-xs font-medium uppercase tracking-wider"
											style={{ color: theme.colors.textDim }}
										>
											Completion Proof
										</div>
										<div className="text-sm mt-1" style={{ color: theme.colors.textMain }}>
											Require a screen recording and screenshots before this task can move into Done.
										</div>
									</div>
									<label
										className="inline-flex items-center gap-2 text-sm"
										style={{ color: theme.colors.textMain }}
									>
										<input
											type="checkbox"
											checked={completionProofRequired}
											onChange={(event) =>
												handleTaskCompletionProofRequirementChange(
													selectedTaskDetail,
													event.target.checked
												)
											}
										/>
										Require proof
									</label>
								</div>
								{completionProofRequired && (
									<div className="space-y-3">
										<div className="flex flex-wrap items-center gap-3">
											<select
												value={completionProofStatus}
												onChange={(event) =>
													handleTaskCompletionProofStatusChange(
														selectedTaskDetail,
														event.target.value as ConductorTaskCompletionProofStatus
													)
												}
												className="rounded-full px-3 py-1.5 text-xs font-medium border outline-none cursor-pointer"
												style={{
													backgroundColor: `${theme.colors.accent}14`,
													borderColor: `${theme.colors.accent}28`,
													color: theme.colors.accent,
												}}
											>
												{COMPLETION_PROOF_STATUS_OPTIONS.map((option) => (
													<option key={option} value={option}>
														{COMPLETION_PROOF_STATUS_LABELS[option]}
													</option>
												))}
											</select>
											<button
												type="button"
												onClick={() => void handleCaptureTaskCompletionProof(selectedTaskDetail)}
												disabled={capturingProofTaskId === selectedTaskDetail.id}
												className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium border transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
												style={{
													backgroundColor: `${theme.colors.success}12`,
													borderColor: `${theme.colors.success}28`,
													color: theme.colors.success,
												}}
											>
												{capturingProofTaskId === selectedTaskDetail.id ? (
													<Loader2 className="h-3.5 w-3.5 animate-spin" />
												) : (
													<Activity className="h-3.5 w-3.5" />
												)}
												{selectedTaskProofDemo ? 'Recapture proof' : 'Capture proof'}
											</button>
											{selectedTaskProofDemo && (
												<button
													type="button"
													onClick={() => setOpenProofDemoId(selectedTaskProofDemo.demoId)}
													className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium border hover:bg-white/5"
													style={{
														backgroundColor: 'transparent',
														borderColor: 'rgba(255,255,255,0.12)',
														color: theme.colors.textMain,
													}}
												>
													<ExternalLink className="h-3.5 w-3.5" />
													View proof
												</button>
											)}
											{completionProofStatus === 'captured' && (
												<button
													type="button"
													onClick={() =>
														handleTaskCompletionProofStatusChange(selectedTaskDetail, 'approved')
													}
													className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium border hover:bg-white/5"
													style={{
														backgroundColor: `${theme.colors.success}10`,
														borderColor: `${theme.colors.success}22`,
														color: theme.colors.success,
													}}
												>
													<CheckCircle2 className="h-3.5 w-3.5" />
													Approve proof
												</button>
											)}
										</div>
										<div className="text-xs leading-5" style={{ color: theme.colors.textDim }}>
											Required artifacts: {completionProofRequirement.requireVideo ? 'screen recording' : 'capture artifacts'}
											{completionProofRequirement.minScreenshots > 0
												? ` + ${completionProofRequirement.minScreenshots} screenshot${completionProofRequirement.minScreenshots === 1 ? '' : 's'}`
												: ''}
											.
											{selectedTaskDetail.completionProof?.capturedAt
												? ` Captured ${formatTimestamp(selectedTaskDetail.completionProof.capturedAt)}.`
												: ''}
										</div>
										{selectedTaskProofDemo && (
											<DemoCardPanel
												theme={theme}
												demoCard={selectedTaskProofDemo}
												onOpen={() => setOpenProofDemoId(selectedTaskProofDemo.demoId)}
											/>
										)}
									</div>
								)}
							</div>
						)}

						{selectedTaskProgress.totalSubtasks > 0 && (
							<div
								className="rounded-xl border p-4"
								style={{
									backgroundColor: theme.colors.bgSidebar,
									borderColor: 'rgba(255,255,255,0.08)',
								}}
							>
								<div className="flex items-center justify-between gap-3">
									<div>
										<div className="text-xs font-medium uppercase tracking-wider" style={{ color: theme.colors.textDim }}>
											Subtask Progress
										</div>
										<div className="text-sm mt-1" style={{ color: theme.colors.textMain }}>
											{selectedTaskProgress.completedSubtasks}/{selectedTaskProgress.totalSubtasks} nested tasks complete
										</div>
									</div>
									<div className="text-xs" style={{ color: theme.colors.textDim }}>
										{selectedTaskProgress.openSubtasks} open
									</div>
								</div>
								<div
									className="mt-3 h-2 rounded-full overflow-hidden"
									style={{ backgroundColor: 'rgba(255,255,255,0.08)' }}
								>
									<div
										className="h-full rounded-full"
										style={{
											width: `${Math.round(selectedTaskProgress.completionRatio * 100)}%`,
											backgroundColor: detailPriorityTone.fg,
										}}
									/>
								</div>
							</div>
						)}

						{selectedTaskQaFailureState?.isQuarantined && (
							<div
								className="rounded-xl border p-4 space-y-3"
								style={{
									backgroundColor: `${theme.colors.warning}10`,
									borderColor: `${theme.colors.warning}30`,
								}}
							>
								<div className="flex items-center justify-between gap-3">
									<div>
										<div className="text-xs font-medium uppercase tracking-wider" style={{ color: theme.colors.warning }}>
											QA Paused For This Task
										</div>
										<div className="text-sm mt-1" style={{ color: theme.colors.textMain }}>
											Conductor stopped auto-retrying QA after {selectedTaskQaFailureState.malformedFailureCount} malformed reviewer response{selectedTaskQaFailureState.malformedFailureCount === 1 ? '' : 's'} so unrelated work can keep moving.
										</div>
									</div>
									<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
										Threshold {CONDUCTOR_QA_QUARANTINE_FAILURE_COUNT}
									</span>
								</div>
								{selectedTaskQaFailureState.lastFailureEvent?.message && (
									<div className="text-sm leading-6" style={{ color: theme.colors.textDim }}>
										{selectedTaskQaFailureState.lastFailureEvent.message}
									</div>
								)}
							</div>
						)}

						{(selectedTaskEffectiveAttention?.status === 'open' ||
							(selectedTaskOpenFollowUps.length > 0 &&
								(selectedTaskDetail.status === 'needs_revision' ||
									isConductorTaskAgentRevision(selectedTaskDetail, childTasksByParentId, runs)))) && (
							<div
								className="rounded-xl border p-4 space-y-3"
								style={{
									backgroundColor: `${theme.colors.warning}10`,
									borderColor: `${theme.colors.warning}30`,
								}}
							>
								<div className="flex items-center justify-between gap-3">
									<div>
										<div className="text-xs font-medium uppercase tracking-wider" style={{ color: theme.colors.warning }}>
											{detailStatus === 'needs_proof'
												? 'Proof Required'
												: selectedTaskNeedsOperatorAttention
													? 'Waiting On You'
													: 'Agents Revising'}
										</div>
										<div className="text-sm mt-1" style={{ color: theme.colors.textMain }}>
											{selectedTaskNeedsOperatorAttention
												? selectedTaskEffectiveAttention?.summary
												: selectedTaskEffectiveAttention?.summary || 'Reviewer feedback has already been turned into agent follow-up work.'}
										</div>
										{selectedTaskAttentionTarget &&
											selectedTaskAttentionTarget.id !== selectedTaskDetail.id && (
											<div className="text-[11px] mt-1" style={{ color: theme.colors.textDim }}>
												From subtask: {selectedTaskAttentionTarget.title}
											</div>
										)}
									</div>
									{selectedTaskEffectiveAttention && (
										<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
											{formatLabel(selectedTaskEffectiveAttention.kind)}
										</span>
									)}
								</div>
								{selectedTaskEffectiveAttention?.requestedAction && (
									<div className="text-sm leading-6" style={{ color: theme.colors.textDim }}>
										{formatConductorOperatorMessage(
											selectedTaskEffectiveAttention.requestedAction
										)}
									</div>
								)}
								{selectedTaskNeedsOperatorAttention &&
									selectedTaskEffectiveAttention?.suggestedResponse && (
									<div className="text-xs leading-5" style={{ color: theme.colors.textDim }}>
										Suggested: {selectedTaskEffectiveAttention.suggestedResponse}
									</div>
								)}
								{selectedTaskOpenFollowUps.length > 0 && (
									<div className="space-y-2">
										<div className="text-[11px] uppercase tracking-wider" style={{ color: theme.colors.textDim }}>
											Requested Changes
										</div>
										<div className="space-y-2">
											{selectedTaskOpenFollowUps.map((followUpTask) => (
												<button
													key={followUpTask.id}
													onClick={() => openTaskDetails(followUpTask.id)}
													className="w-full rounded-lg px-3 py-2 text-left border hover:bg-white/5"
													style={{
														borderColor: 'rgba(255,255,255,0.08)',
														backgroundColor: 'rgba(255,255,255,0.03)',
													}}
												>
													<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
														{followUpTask.title}
													</div>
													{followUpTask.description && (
														<div className="text-xs mt-1 leading-5" style={{ color: theme.colors.textDim }}>
															{followUpTask.description}
														</div>
													)}
												</button>
											))}
										</div>
									</div>
								)}
								{selectedTaskNeedsOperatorAttention && showProofResponseUi && (
									<>
										<textarea
											value={
												selectedTaskAttentionTarget
													? taskResponseDrafts[selectedTaskAttentionTarget.id] || ''
													: ''
											}
											onChange={(event) =>
												setTaskResponseDrafts((previous) => ({
													...previous,
													[(selectedTaskAttentionTarget || selectedTaskDetail).id]: event.target.value,
												}))
											}
											placeholder="Write the answer or clarification the next agent run should use."
											rows={4}
											className="w-full bg-transparent rounded-xl border px-3.5 py-3 text-sm resize-y outline-none leading-relaxed"
											style={{
												color: theme.colors.textMain,
												borderColor: `${theme.colors.warning}28`,
											}}
										/>
										<div className="flex items-center justify-end">
											<button
												onClick={() =>
													handleResolveTaskAttention(selectedTaskAttentionTarget || selectedTaskDetail)
												}
												className="px-3 py-2 rounded-lg text-xs font-medium"
												style={{
													backgroundColor: `${theme.colors.accent}18`,
													border: `1px solid ${theme.colors.accent}30`,
													color: theme.colors.accent,
												}}
											>
												Save Response And Return To Ready
											</button>
										</div>
									</>
								)}
							</div>
						)}

						{selectedTaskEffectiveAttention?.status !== 'open' &&
							selectedTaskAttentionBlockers.length > 0 && (
								<div
									className="rounded-xl border p-4 space-y-3"
									style={{
										backgroundColor: `${theme.colors.warning}08`,
										borderColor: `${theme.colors.warning}24`,
									}}
								>
									<div>
										<div
											className="text-xs font-medium uppercase tracking-wider"
											style={{ color: theme.colors.warning }}
										>
											Nested Tasks Waiting
										</div>
										<div className="text-sm mt-1" style={{ color: theme.colors.textMain }}>
											This parent task is waiting because one or more subtasks were sent back with requested changes.
										</div>
									</div>
									<div className="space-y-3">
										{selectedTaskAttentionBlockers.map(({ task: blockerTask, attentionRequest, followUpTasks }) => {
											const blockerTone =
												PASTEL_STATUS_TONES[blockerTask.status] || PASTEL_STATUS_TONES.needs_input;
											return (
												<div
													key={blockerTask.id}
													className="rounded-lg border px-3.5 py-3 space-y-2"
													style={{
														borderColor: 'rgba(255,255,255,0.08)',
														backgroundColor: 'rgba(255,255,255,0.03)',
													}}
												>
													<div className="flex items-start justify-between gap-3">
														<button
															onClick={() => openTaskDetails(blockerTask.id)}
															className="text-left hover:underline"
															style={{ color: theme.colors.textMain }}
														>
															{blockerTask.title}
														</button>
														<span
															className="text-[11px] px-2 py-1 rounded-full shrink-0"
															style={{
																backgroundColor: blockerTone.bg,
																color: blockerTone.fg,
															}}
														>
															{FRIENDLY_TASK_STATUS_LABELS[blockerTask.status]}
														</span>
													</div>
													<div className="text-xs leading-5" style={{ color: theme.colors.textDim }}>
														{formatConductorOperatorMessage(attentionRequest?.requestedAction) ||
															'This subtask is waiting for follow-up changes before it can continue.'}
													</div>
													{followUpTasks.length > 0 && (
														<div className="space-y-1.5">
															<div className="text-[11px] uppercase tracking-wider" style={{ color: theme.colors.textDim }}>
																Requested Changes
															</div>
															<div className="space-y-1.5">
																{followUpTasks.slice(0, 3).map((followUpTask) => (
																	<button
																		key={followUpTask.id}
																		onClick={() => openTaskDetails(followUpTask.id)}
																		className="w-full text-left rounded-lg px-2.5 py-2 hover:bg-white/5"
																		style={{ backgroundColor: 'rgba(255,255,255,0.02)' }}
																	>
																		<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
																			{followUpTask.title}
																		</div>
																		{followUpTask.description && (
																			<div className="text-[11px] mt-1 leading-5" style={{ color: theme.colors.textDim }}>
																				{followUpTask.description}
																			</div>
																		)}
																	</button>
																))}
																{followUpTasks.length > 3 && (
																	<div className="text-[11px]" style={{ color: theme.colors.textDim }}>
																		+{followUpTasks.length - 3} more requested change{followUpTasks.length - 3 === 1 ? '' : 's'}
																	</div>
																)}
															</div>
														</div>
													)}
												</div>
											);
										})}
									</div>
								</div>
							)}

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
																{formatConductorOperatorMessage(event.message)}
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

			{openProofDemoId && (
				<DemoViewerModal
					theme={theme}
					demoId={openProofDemoId}
					onClose={() => setOpenProofDemoId(null)}
				/>
			)}

			{isTaskComposerOpen && (
				<ConductorTaskComposer
					theme={theme}
					tasks={tasks}
					initialParentId={manualTaskParentId}
					onCreateTask={({ parentId, title, description, priority, completionProofRequired }) => {
						addTask(groupId, {
							title,
							description,
							priority,
							status: 'draft',
							parentTaskId: parentId || undefined,
							source: 'manual',
							completionProofRequired,
						});
						setIsTaskComposerOpen(false);
					}}
					onClose={() => setIsTaskComposerOpen(false)}
				/>
			)}

			{isPlanComposerOpen && (
				<ConductorPlanComposer
					theme={theme}
					conductor={conductor}
					selectedTemplate={selectedTemplate}
					isPlanning={isPlanning}
					planningError={planningError}
					onSetAutoExecute={(value) =>
						setConductor(groupId, { autoExecuteOnPlanCreation: value })
					}
					onSubmitPlan={(input) =>
						void handleGeneratePlan({
							requestOverride: input.requestOverride,
							operatorNotesOverride: input.operatorNotesOverride,
							autoExecute: input.autoExecute,
						})
					}
					onClose={() => {
						setIsPlanComposerOpen(false);
						setPlanningError(null);
					}}
				/>
			)}
		</div>
	);
}
