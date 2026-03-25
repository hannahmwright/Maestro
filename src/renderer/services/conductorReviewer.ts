import type { ConductorTask, ConductorTaskPriority, Session } from '../types';
import { CONDUCTOR_MAX_REVIEW_FOLLOW_UP_TASKS } from '../../shared/conductorLimits';
import {
	buildConductorNativeSubmissionInstruction,
	type ConductorReviewToolInput,
} from '../../shared/conductorNativeTools';

export const CONDUCTOR_REVIEWER_JSON_ERROR = 'Reviewer did not return a JSON object.';

export interface ConductorReviewerFollowUpDraft {
	title: string;
	description: string;
	priority: ConductorTaskPriority;
}

export interface ConductorReviewerResult {
	decision: 'approved' | 'changes_requested';
	summary: string;
	followUpTasks: ConductorReviewerFollowUpDraft[];
	reviewNotes?: string;
}

interface RawReviewerResponse {
	decision?: unknown;
	summary?: unknown;
	followUpTasks?: unknown;
	reviewNotes?: unknown;
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

function extractJsonBlock(text: string): string {
	const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i);
	if (fencedMatch?.[1]) {
		return fencedMatch[1].trim();
	}

	const genericFencedMatch = text.match(/```\s*([\s\S]*?)```/i);
	if (genericFencedMatch?.[1]) {
		const fencedContent = genericFencedMatch[1].trim();
		if (fencedContent.startsWith('{') && fencedContent.endsWith('}')) {
			return fencedContent;
		}
	}

	const firstBrace = text.indexOf('{');
	const lastBrace = text.lastIndexOf('}');
	if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
		throw new Error(CONDUCTOR_REVIEWER_JSON_ERROR);
	}

	return text.slice(firstBrace, lastBrace + 1).trim();
}

export function buildConductorReviewerPrompt(
	groupName: string,
	templateSession: Session,
	task: ConductorTask
): string {
	const acceptanceCriteria =
		task.acceptanceCriteria.length > 0
			? task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')
			: '- No explicit acceptance criteria provided.';
	const changedPaths =
		task.changedPaths && task.changedPaths.length > 0
			? task.changedPaths.map((path) => `- ${path}`).join('\n')
			: '- Changed paths were not reported.';

	return `You are reviewing one Conductor task for the Maestro group "${groupName}".

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

Reported changed paths:
${changedPaths}

Instructions:
- Review the workspace as it currently exists.
- Approve only if the task appears complete and acceptance criteria are satisfied.
- If changes are still needed, request changes clearly.
- When the same task just needs another pass, leave "followUpTasks" empty and put the requested fixes in "reviewNotes".
- Only return followUpTasks when the remaining work truly splits into separate independent child tasks.
- Do not suggest more than ${CONDUCTOR_MAX_REVIEW_FOLLOW_UP_TASKS} follow-up subtasks.

${buildConductorNativeSubmissionInstruction('reviewer')}

If you need the JSON fallback, return ONLY valid JSON with this exact shape:
{
  "decision": "approved | changes_requested",
  "summary": "short review summary",
  "followUpTasks": [
    {
      "title": "small follow-up subtask",
      "description": "why it is needed",
      "priority": "low | medium | high | critical"
    }
  ],
  "reviewNotes": "optional short reviewer notes"
}`;
}

export function parseConductorReviewerResponse(text: string): ConductorReviewerResult {
	const parsed = JSON.parse(extractJsonBlock(text)) as RawReviewerResponse;
	return normalizeConductorReviewerResult(parsed);
}

export function parseConductorReviewerSubmission(
	submission: ConductorReviewToolInput
): ConductorReviewerResult {
	return normalizeConductorReviewerResult(submission);
}

function normalizeConductorReviewerResult(parsed: {
	decision?: unknown;
	summary?: unknown;
	followUpTasks?: unknown;
	reviewNotes?: unknown;
}): ConductorReviewerResult {
	const followUpTasks = Array.isArray(parsed.followUpTasks)
		? parsed.followUpTasks
				.map((rawTask): ConductorReviewerFollowUpDraft | null => {
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
				.filter((task): task is ConductorReviewerFollowUpDraft => Boolean(task))
				.slice(0, CONDUCTOR_MAX_REVIEW_FOLLOW_UP_TASKS)
		: [];

	const decision = parsed.decision === 'changes_requested' ? 'changes_requested' : 'approved';

	return {
		decision,
		summary:
			typeof parsed.summary === 'string' && parsed.summary.trim()
				? parsed.summary.trim()
				: decision === 'approved'
					? 'Task approved by reviewer.'
					: 'Reviewer requested changes.',
		followUpTasks,
		reviewNotes:
			typeof parsed.reviewNotes === 'string' && parsed.reviewNotes.trim()
				? parsed.reviewNotes.trim()
				: undefined,
	};
}
