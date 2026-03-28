import { z } from 'zod/v4';
import {
	CONDUCTOR_MAX_PLAN_SUBTASKS_PER_PARENT,
	CONDUCTOR_MAX_PLAN_TASKS,
	CONDUCTOR_MAX_REVIEW_FOLLOW_UP_TASKS,
	CONDUCTOR_MAX_WORKER_FOLLOW_UP_TASKS,
} from './conductorLimits';

export const CONDUCTOR_CLAUDE_MCP_SERVER_NAME = 'maestro_conductor_results';
export const CONDUCTOR_CODEX_MCP_SERVER_NAME = 'maestro_conductor_results';

export const CONDUCTOR_PLAN_RESULT_TOOL_NAME = 'submit_conductor_plan';
export const CONDUCTOR_WORK_RESULT_TOOL_NAME = 'submit_conductor_work';
export const CONDUCTOR_REVIEW_RESULT_TOOL_NAME = 'submit_conductor_review';

export type ConductorStructuredSubmissionKind = 'planner' | 'worker' | 'reviewer';

const conductorPrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);

const conductorPlannerTaskInputSchema: z.ZodType<{
	title: string;
	description: string;
	priority: 'low' | 'medium' | 'high' | 'critical';
	acceptanceCriteria: string[];
	dependsOn: string[];
	scopePaths: string[];
	subtasks?: Array<{
		title: string;
		description: string;
		priority: 'low' | 'medium' | 'high' | 'critical';
		acceptanceCriteria: string[];
		dependsOn: string[];
		scopePaths: string[];
		subtasks?: unknown[];
	}>;
}> = z.lazy(() =>
	z.object({
		title: z.string().trim().min(1),
		description: z.string().trim().default(''),
		priority: conductorPrioritySchema.default('medium'),
		acceptanceCriteria: z.array(z.string().trim().min(1)).default([]),
		dependsOn: z.array(z.string().trim().min(1)).default([]),
		scopePaths: z.array(z.string().trim().min(1)).default([]),
		subtasks: z
			.array(conductorPlannerTaskInputSchema)
			.max(CONDUCTOR_MAX_PLAN_SUBTASKS_PER_PARENT)
			.default([]),
	})
);

const conductorFollowUpTaskInputSchema = z.object({
	title: z.string().trim().min(1),
	description: z.string().trim().default(''),
	priority: conductorPrioritySchema.default('medium'),
});

const conductorEvidenceItemInputSchema = z.object({
	kind: z.enum(['demo', 'file', 'url', 'note']).default('note'),
	label: z.string().trim().min(1),
	summary: z.string().trim().optional(),
	path: z.string().trim().optional(),
	url: z.string().trim().optional(),
	demoId: z.string().trim().optional(),
	captureRunId: z.string().trim().optional(),
});

export const conductorPlanToolInputShape = {
	summary: z.string().trim().min(1),
	tasks: z.array(conductorPlannerTaskInputSchema).min(1).max(CONDUCTOR_MAX_PLAN_TASKS),
};

export const conductorWorkToolInputShape = {
	outcome: z.enum(['completed', 'blocked']),
	summary: z.string().trim().min(1),
	changedPaths: z.array(z.string().trim().min(1)).default([]),
	evidence: z.array(conductorEvidenceItemInputSchema).default([]),
	followUpTasks: z
		.array(conductorFollowUpTaskInputSchema)
		.max(CONDUCTOR_MAX_WORKER_FOLLOW_UP_TASKS)
		.default([]),
	blockedReason: z.string().trim().optional(),
};

export const conductorReviewToolInputShape = {
	decision: z.enum(['approved', 'changes_requested']),
	summary: z.string().trim().min(1),
	followUpTasks: z
		.array(conductorFollowUpTaskInputSchema)
		.max(CONDUCTOR_MAX_REVIEW_FOLLOW_UP_TASKS)
		.default([]),
	reviewNotes: z.string().trim().optional(),
};

export const conductorPlanToolInputSchema = z.object(conductorPlanToolInputShape);
export const conductorWorkToolInputSchema = z.object(conductorWorkToolInputShape);
export const conductorReviewToolInputSchema = z.object(conductorReviewToolInputShape);

export type ConductorPlanToolInput = z.infer<typeof conductorPlanToolInputSchema>;
export type ConductorWorkToolInput = z.infer<typeof conductorWorkToolInputSchema>;
export type ConductorReviewToolInput = z.infer<typeof conductorReviewToolInputSchema>;

export type ConductorStructuredSubmission =
	| {
			kind: 'planner';
			toolName: typeof CONDUCTOR_PLAN_RESULT_TOOL_NAME;
			payload: ConductorPlanToolInput;
	  }
	| {
			kind: 'worker';
			toolName: typeof CONDUCTOR_WORK_RESULT_TOOL_NAME;
			payload: ConductorWorkToolInput;
	  }
	| {
			kind: 'reviewer';
			toolName: typeof CONDUCTOR_REVIEW_RESULT_TOOL_NAME;
			payload: ConductorReviewToolInput;
	  };

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function extractToolArguments(state: unknown): unknown {
	const stateRecord = asRecord(state);
	if (!stateRecord) {
		return undefined;
	}
	const input = asRecord(stateRecord.input);
	if (input && 'arguments' in input) {
		return input.arguments;
	}
	return stateRecord.input;
}

export function getConductorResultToolName(
	kind: ConductorStructuredSubmissionKind
): ConductorStructuredSubmission['toolName'] {
	switch (kind) {
		case 'planner':
			return CONDUCTOR_PLAN_RESULT_TOOL_NAME;
		case 'reviewer':
			return CONDUCTOR_REVIEW_RESULT_TOOL_NAME;
		case 'worker':
		default:
			return CONDUCTOR_WORK_RESULT_TOOL_NAME;
	}
}

export function supportsNativeConductorToolSubmission(toolType: string): boolean {
	return toolType === 'claude-code' || toolType === 'codex';
}

export function parseConductorStructuredSubmissionFromToolExecution(
	toolName: string,
	state: unknown
): ConductorStructuredSubmission | null {
	const args = extractToolArguments(state);

	switch (toolName) {
		case CONDUCTOR_PLAN_RESULT_TOOL_NAME: {
			const parsed = conductorPlanToolInputSchema.safeParse(args);
			if (!parsed.success) {
				return null;
			}
			return {
				kind: 'planner',
				toolName,
				payload: parsed.data,
			};
		}
		case CONDUCTOR_WORK_RESULT_TOOL_NAME: {
			const parsed = conductorWorkToolInputSchema.safeParse(args);
			if (!parsed.success) {
				return null;
			}
			return {
				kind: 'worker',
				toolName,
				payload: parsed.data,
			};
		}
		case CONDUCTOR_REVIEW_RESULT_TOOL_NAME: {
			const parsed = conductorReviewToolInputSchema.safeParse(args);
			if (!parsed.success) {
				return null;
			}
			return {
				kind: 'reviewer',
				toolName,
				payload: parsed.data,
			};
		}
		default:
			return null;
	}
}

export function buildConductorNativeSubmissionInstruction(
	kind: ConductorStructuredSubmissionKind
): string {
	const toolName = getConductorResultToolName(kind);
	return `If the native tool "${toolName}" is available, call it exactly once with your final result. You may include reasoning in the normal transcript, but Conductor will only trust the tool call for state updates. If "${toolName}" is unavailable, fall back to the JSON response format below.`;
}
