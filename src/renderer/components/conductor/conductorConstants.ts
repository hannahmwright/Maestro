import type { ConductorTaskStatus, ConductorTaskPriority } from '../../../shared/types';

export interface KanbanLane {
	key: string;
	label: string;
	statuses: ConductorTaskStatus[];
	dropDefault: ConductorTaskStatus;
	color: string;
}

export const KANBAN_LANES: KanbanLane[] = [
	{ key: 'backlog', label: 'Backlog', statuses: ['draft', 'planning', 'ready'], dropDefault: 'ready', color: '#60a5fa' },
	{ key: 'in_progress', label: 'In Progress', statuses: ['running'], dropDefault: 'running', color: '#818cf8' },
	{ key: 'needs_attention', label: 'Needs Attention', statuses: ['needs_input', 'needs_proof', 'blocked', 'needs_revision'], dropDefault: 'needs_input', color: '#fb7185' },
	{ key: 'in_qa', label: 'In QA', statuses: ['needs_review'], dropDefault: 'needs_review', color: '#22d3ee' },
	{ key: 'complete', label: 'Complete', statuses: ['done', 'cancelled'], dropDefault: 'done', color: '#22c55e' },
];

export const BOARD_COLUMNS: ConductorTaskStatus[] = [
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

export const FRIENDLY_TASK_STATUS_LABELS: Record<ConductorTaskStatus, string> = {
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

export const STATUS_LABELS: Record<ConductorTaskStatus, string> = FRIENDLY_TASK_STATUS_LABELS;

export const PRIORITY_OPTIONS: ConductorTaskPriority[] = ['low', 'medium', 'high', 'critical'];

export function formatLabel(value: string): string {
	return value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
