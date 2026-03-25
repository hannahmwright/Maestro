import type { ConductorTask, ConductorTaskPriority, Session } from '../types';
import { CONDUCTOR_MAX_WORKER_FOLLOW_UP_TASKS } from '../../shared/conductorLimits';
import {
	buildConductorNativeSubmissionInstruction,
	type ConductorWorkToolInput,
} from '../../shared/conductorNativeTools';

export interface ConductorWorkerFollowUpDraft {
	title: string;
	description: string;
	priority: ConductorTaskPriority;
}

export interface ConductorWorkerResult {
	outcome: 'completed' | 'blocked';
	summary: string;
	changedPaths: string[];
	followUpTasks: ConductorWorkerFollowUpDraft[];
	blockedReason?: string;
}

interface RawWorkerResponse {
	outcome?: unknown;
	summary?: unknown;
	changedPaths?: unknown;
	followUpTasks?: unknown;
	blockedReason?: unknown;
}

interface RawFollowUpTask {
	title?: unknown;
	description?: unknown;
	priority?: unknown;
}

const PRIORITY_ORDER: ConductorTaskPriority[] = ['low', 'medium', 'high', 'critical'];

function normalizePriority(value: unknown): ConductorTaskPriority {
	if (typeof value !== 'string') {
		return 'medium';
	}

	const normalized = value.trim().toLowerCase();
	return PRIORITY_ORDER.includes(normalized as ConductorTaskPriority)
		? (normalized as ConductorTaskPriority)
		: 'medium';
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter((item): item is string => typeof item === 'string')
		.map((item) => item.trim())
		.filter(Boolean);
}

function extractJsonBlock(text: string): string {
	const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i);
	if (fencedMatch?.[1]) {
		return fencedMatch[1].trim();
	}

	const firstBrace = text.indexOf('{');
	const lastBrace = text.lastIndexOf('}');
	if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
		throw new Error('Worker did not return a JSON object.');
	}

	return text.slice(firstBrace, lastBrace + 1).trim();
}

export function buildConductorWorkerPrompt(
	groupName: string,
	templateSession: Session,
	task: ConductorTask,
	dependencyTitles: string[],
	revisionRequest?: string | null
): string {
	const acceptanceCriteria =
		task.acceptanceCriteria.length > 0
			? task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')
			: '- No explicit acceptance criteria provided.';
	const scopeLines =
		task.scopePaths.length > 0
			? task.scopePaths.map((path) => `- ${path}`).join('\n')
			: '- Scope unknown; stay as narrow as possible.';
	const dependencyLines =
		dependencyTitles.length > 0
			? dependencyTitles.map((title) => `- ${title}`).join('\n')
			: '- No task dependencies.';
	const revisionLines = revisionRequest?.trim()
		? `\nRevision guidance:\n- ${revisionRequest.trim()}\n`
		: '';

	return `You are executing one Conductor task for the Maestro group "${groupName}".

Template agent:
- Name: ${templateSession.name}
- Tool type: ${templateSession.toolType}
- Working directory: ${templateSession.cwd}

Task:
- Title: ${task.title}
- Priority: ${task.priority}
- Description: ${task.description || 'No description provided.'}

Acceptance criteria:
${acceptanceCriteria}

Dependencies already completed:
${dependencyLines}

${revisionLines}

Expected scope:
${scopeLines}

Instructions:
- Perform the task in the repository if you can complete it safely.
- Keep changes scoped to the task.
- If you cannot complete it, explain the blocker clearly.
- Suggest follow-up subtasks only for genuinely separate net-new work, not for polish needed to finish this same task.
- Do not invent more than ${CONDUCTOR_MAX_WORKER_FOLLOW_UP_TASKS} follow-up subtasks.

${buildConductorNativeSubmissionInstruction('worker')}

If you need the JSON fallback, return ONLY valid JSON with this exact shape:
{
  "outcome": "completed | blocked",
  "summary": "short outcome summary",
  "changedPaths": ["path/to/file"],
  "followUpTasks": [
    {
      "title": "small follow-up task",
      "description": "why it is needed",
      "priority": "low | medium | high | critical"
    }
  ],
  "blockedReason": "only when blocked"
}`;
}

export function parseConductorWorkerResponse(text: string): ConductorWorkerResult {
	const parsed = JSON.parse(extractJsonBlock(text)) as RawWorkerResponse;
	return normalizeConductorWorkerResult(parsed);
}

export function parseConductorWorkerSubmission(
	submission: ConductorWorkToolInput
): ConductorWorkerResult {
	return normalizeConductorWorkerResult(submission);
}

function normalizeConductorWorkerResult(parsed: {
	outcome?: unknown;
	summary?: unknown;
	changedPaths?: unknown;
	followUpTasks?: unknown;
	blockedReason?: unknown;
}): ConductorWorkerResult {
	const outcome = parsed.outcome === 'blocked' ? 'blocked' : 'completed';
	const followUpTasks = Array.isArray(parsed.followUpTasks)
		? parsed.followUpTasks
				.map((rawTask): ConductorWorkerFollowUpDraft | null => {
					const task = rawTask as RawFollowUpTask;
					const title = typeof task.title === 'string' ? task.title.trim() : '';
					if (!title) {
						return null;
					}

					return {
						title,
						description: typeof task.description === 'string' ? task.description.trim() : '',
						priority: normalizePriority(task.priority),
					};
				})
				.filter((task): task is ConductorWorkerFollowUpDraft => Boolean(task))
				.slice(0, CONDUCTOR_MAX_WORKER_FOLLOW_UP_TASKS)
		: [];

	return {
		outcome,
		summary:
			typeof parsed.summary === 'string' && parsed.summary.trim()
				? parsed.summary.trim()
				: outcome === 'blocked'
					? 'Task blocked during execution.'
					: 'Task completed.',
		changedPaths: normalizeStringArray(parsed.changedPaths),
		followUpTasks,
		blockedReason:
			typeof parsed.blockedReason === 'string' && parsed.blockedReason.trim()
				? parsed.blockedReason.trim()
				: undefined,
	};
}
