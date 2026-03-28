import type {
	ConductorTask,
	ConductorTaskEvidenceItem,
	ConductorTaskPriority,
	Session,
} from '../types';
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
	evidence: ConductorTaskEvidenceItem[];
	followUpTasks: ConductorWorkerFollowUpDraft[];
	blockedReason?: string;
}

interface RawWorkerResponse {
	outcome?: unknown;
	summary?: unknown;
	changedPaths?: unknown;
	evidence?: unknown;
	followUpTasks?: unknown;
	blockedReason?: unknown;
}

interface RawFollowUpTask {
	title?: unknown;
	description?: unknown;
	priority?: unknown;
}

interface RawEvidenceItem {
	kind?: unknown;
	label?: unknown;
	summary?: unknown;
	path?: unknown;
	url?: unknown;
	demoId?: unknown;
	captureRunId?: unknown;
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

function normalizeEvidenceItems(value: unknown): ConductorTaskEvidenceItem[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((rawItem): ConductorTaskEvidenceItem | null => {
			const item = rawItem as RawEvidenceItem;
			const label = typeof item.label === 'string' ? item.label.trim() : '';
			if (!label) {
				return null;
			}

			const kind =
				typeof item.kind === 'string' &&
				['demo', 'file', 'url', 'note'].includes(item.kind.trim().toLowerCase())
					? (item.kind.trim().toLowerCase() as ConductorTaskEvidenceItem['kind'])
					: 'note';

			return {
				kind,
				label,
				summary: typeof item.summary === 'string' ? item.summary.trim() || undefined : undefined,
				path: typeof item.path === 'string' ? item.path.trim() || undefined : undefined,
				url: typeof item.url === 'string' ? item.url.trim() || undefined : undefined,
				demoId: typeof item.demoId === 'string' ? item.demoId.trim() || undefined : undefined,
				captureRunId:
					typeof item.captureRunId === 'string'
						? item.captureRunId.trim() || undefined
						: undefined,
			};
		})
		.filter((item): item is ConductorTaskEvidenceItem => Boolean(item));
}

function extractJsonBlock(text: string): string {
	const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i);
	if (fencedMatch?.[1]) {
		return fencedMatch[1].trim();
	}

	const candidates: string[] = [];
	let startIndex = -1;
	let depth = 0;
	let inString = false;
	let isEscaped = false;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (isEscaped) {
				isEscaped = false;
				continue;
			}
			if (char === '\\') {
				isEscaped = true;
				continue;
			}
			if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === '{') {
			if (depth === 0) {
				startIndex = index;
			}
			depth += 1;
			continue;
		}

		if (char !== '}' || depth === 0) {
			continue;
		}

		depth -= 1;
		if (depth === 0 && startIndex >= 0) {
			candidates.push(text.slice(startIndex, index + 1).trim());
			startIndex = -1;
		}
	}

	if (candidates.length === 0) {
		throw new Error('Worker did not return a JSON object.');
	}

	let firstParseError: Error | null = null;
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as RawWorkerResponse;
			const hasWorkerShape =
				typeof parsed.outcome === 'string' ||
				'changedPaths' in parsed ||
				'followUpTasks' in parsed ||
				'blockedReason' in parsed;
			if (hasWorkerShape || candidates.length === 1) {
				return candidate;
			}
		} catch (error) {
			if (!firstParseError && error instanceof Error) {
				firstParseError = error;
			}
		}
	}

	if (firstParseError) {
		throw firstParseError;
	}

	return candidates[candidates.length - 1];
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
- Report concrete evidence of completion whenever you have it. For browser, UI, or verification tasks, include the URL, demo capture, artifact paths, or other workspace-visible proof instead of a vague claim.
- Suggest follow-up subtasks only for genuinely separate net-new work, not for polish needed to finish this same task.
- Do not invent more than ${CONDUCTOR_MAX_WORKER_FOLLOW_UP_TASKS} follow-up subtasks.

${buildConductorNativeSubmissionInstruction('worker')}

If you need the JSON fallback, return ONLY valid JSON with this exact shape:
{
  "outcome": "completed | blocked",
  "summary": "short outcome summary",
  "changedPaths": ["path/to/file"],
  "evidence": [
    {
      "kind": "demo | file | url | note",
      "label": "short evidence label",
      "summary": "optional details",
      "path": "optional workspace path",
      "url": "optional URL",
      "demoId": "optional demo id",
      "captureRunId": "optional capture run id"
    }
  ],
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
	evidence?: unknown;
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
		evidence: normalizeEvidenceItems(parsed.evidence),
		followUpTasks,
		blockedReason:
			typeof parsed.blockedReason === 'string' && parsed.blockedReason.trim()
				? parsed.blockedReason.trim()
				: undefined,
	};
}
