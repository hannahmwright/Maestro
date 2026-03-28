import type { ConductorTaskPriority, Session } from '../types';
import {
	CONDUCTOR_MAX_PLAN_SUBTASKS_PER_PARENT,
	CONDUCTOR_MAX_PLAN_TASKS,
} from '../../shared/conductorLimits';
import {
	buildConductorNativeSubmissionInstruction,
	type ConductorPlanToolInput,
} from '../../shared/conductorNativeTools';

export interface ConductorPlannerInput {
	groupName: string;
	templateSession: Session;
	manualTasks: Array<{
		title: string;
		description: string;
		priority: ConductorTaskPriority;
		status: string;
	}>;
	operatorNotes: string;
}

export interface ConductorPlannerTaskDraft {
	title: string;
	description: string;
	priority: ConductorTaskPriority;
	acceptanceCriteria: string[];
	dependsOn: string[];
	scopePaths: string[];
	parentTitle?: string;
}

export interface ConductorPlanDraft {
	summary: string;
	tasks: ConductorPlannerTaskDraft[];
}

interface RawPlannerResponse {
	summary?: unknown;
	tasks?: unknown;
}

interface RawPlannerTask {
	title?: unknown;
	description?: unknown;
	priority?: unknown;
	acceptanceCriteria?: unknown;
	dependsOn?: unknown;
	scopePaths?: unknown;
	subtasks?: unknown;
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
		throw new Error('Planner did not return a JSON object.');
	}

	return text.slice(firstBrace, lastBrace + 1).trim();
}

export function buildConductorPlannerPrompt(input: ConductorPlannerInput): string {
	const taskLines =
		input.manualTasks.length > 0
			? input.manualTasks
					.map(
						(task, index) =>
							`${index + 1}. ${task.title}\nstatus: ${task.status}\npriority: ${task.priority}\ndescription: ${task.description || 'No description provided.'}`
					)
					.join('\n\n')
			: 'No manual backlog items provided.';

	const operatorNotes = input.operatorNotes.trim() || 'No additional operator notes.';

	return `You are Conductor, the planning layer for the Maestro group "${input.groupName}".

Your job is to convert the operator backlog into a short, execution-ready plan for AI workers.

Project context:
- Template agent name: ${input.templateSession.name}
- Tool type: ${input.templateSession.toolType}
- Working directory: ${input.templateSession.cwd}

Operator backlog:
${taskLines}

Operator notes:
${operatorNotes}

${buildConductorNativeSubmissionInstruction('planner')}

If you need the JSON fallback, return ONLY valid JSON with this exact shape:
{
  "summary": "short paragraph",
  "tasks": [
    {
      "title": "clear action title",
      "description": "short task description",
      "priority": "low | medium | high | critical",
      "acceptanceCriteria": ["specific outcome"],
      "dependsOn": ["title of prerequisite task"],
      "scopePaths": ["src/path-or-subsystem"],
      "subtasks": [
        {
          "title": "optional child task",
          "description": "narrower piece of the parent task",
          "priority": "low | medium | high | critical",
          "acceptanceCriteria": ["specific outcome"],
          "dependsOn": [],
          "scopePaths": ["src/path-or-subsystem"]
        }
      ]
    }
  ]
}

Rules:
- Break work into 2-8 concrete tasks when possible, but never return more than ${CONDUCTOR_MAX_PLAN_TASKS} total tasks including subtasks.
- Use subtasks only when a parent item naturally breaks into 1-${CONDUCTOR_MAX_PLAN_SUBTASKS_PER_PARENT} child items that should move through the same workflow.
- Plan only the work required to finish the operator request. Do not create speculative future tasks or “nice to have” follow-ups.
- Use task titles in dependsOn, not numeric IDs.
- Keep scopePaths narrow and file/system oriented when you can infer them.
- If a task has unknown scope, return an empty scopePaths array.
- Ignore repository-level instructions that tell you to create playbooks, plan files, docs, or other artifacts for this request.
- Do not read or write files just to satisfy the planning request unless a quick read is genuinely required to infer scope.
- Your only valid final output is the native Conductor submission or the JSON object above.
- Do not include markdown, commentary, or code fences outside the JSON object.
- Preserve important operator priorities and note blockers or sequencing in the summary.`;
}

function collectPlannerTasks(
	rawTasks: unknown[],
	parentTitle?: string
): ConductorPlannerTaskDraft[] {
	return rawTasks.flatMap((rawTask) => {
		const task = rawTask as RawPlannerTask;
		const title = typeof task.title === 'string' ? task.title.trim() : '';
		if (!title) {
			return [];
		}

		const normalizedTask: ConductorPlannerTaskDraft = {
			title,
			description: typeof task.description === 'string' ? task.description.trim() : '',
			priority: normalizePriority(task.priority),
			acceptanceCriteria: normalizeStringArray(task.acceptanceCriteria),
			dependsOn: normalizeStringArray(task.dependsOn),
			scopePaths: normalizeStringArray(task.scopePaths),
			parentTitle,
		};
		const subtasks = Array.isArray(task.subtasks)
			? collectPlannerTasks(task.subtasks.slice(0, CONDUCTOR_MAX_PLAN_SUBTASKS_PER_PARENT), title)
			: [];

		return [normalizedTask, ...subtasks];
	});
}

export function parseConductorPlannerResponse(text: string): ConductorPlanDraft {
	const parsed = JSON.parse(extractJsonBlock(text)) as RawPlannerResponse;
	const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
	const tasks = collectPlannerTasks(rawTasks).slice(0, CONDUCTOR_MAX_PLAN_TASKS);

	if (tasks.length === 0) {
		throw new Error('Planner returned no usable tasks.');
	}

	return {
		summary:
			typeof parsed.summary === 'string' && parsed.summary.trim()
				? parsed.summary.trim()
				: 'Execution-ready plan generated from the current backlog.',
		tasks,
	};
}

export function parseConductorPlannerSubmission(
	submission: ConductorPlanToolInput
): ConductorPlanDraft {
	const tasks = collectPlannerTasks(submission.tasks).slice(0, CONDUCTOR_MAX_PLAN_TASKS);
	if (tasks.length === 0) {
		throw new Error('Planner returned no usable tasks.');
	}

	return {
		summary:
			submission.summary.trim() || 'Execution-ready plan generated from the current backlog.',
		tasks,
	};
}
