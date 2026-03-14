import type { ConductorTask, ConductorTaskPriority, Session } from '../types';

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

	const firstBrace = text.indexOf('{');
	const lastBrace = text.lastIndexOf('}');
	if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
		throw new Error('Reviewer did not return a JSON object.');
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
- If changes are still needed, request changes clearly and suggest at most 3 follow-up subtasks.

Return ONLY valid JSON with this exact shape:
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
