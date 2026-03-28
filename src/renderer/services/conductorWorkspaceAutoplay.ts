export type ConductorWorkspaceAutoplayAction =
	| 'approve_plan'
	| 'plan_task'
	| 'run_execution'
	| 'run_review'
	| null;

export interface ConductorAutoplayRetryGateInput {
	run:
		| {
				status: string;
				startedAt: number;
				endedAt?: number;
		  }
		| null
		| undefined;
	retryableStatuses: string[];
	taskUpdatedAt?: number | null;
	cooldownMs: number;
	now?: number;
}

export interface ConductorWorkspaceAutoplayInput {
	hasPendingRun: boolean;
	autoExecuteOnPlanCreation: boolean;
	tasksNeedingPlanningCount: number;
	dependencyReadyCount: number;
	reviewReadyCount: number;
	hasSelectedTemplate: boolean;
	gitReady: boolean;
	resourceAllowed: boolean;
	isAutoplayPaused: boolean;
	isPlanning: boolean;
	isExecuting: boolean;
	isReviewing: boolean;
	isIntegrating: boolean;
	hasPlanningLock: boolean;
	hasExecutionLock: boolean;
	hasReviewLock: boolean;
}

export interface ConductorAutoplayReadyKeyTask {
	id: string;
	updatedAt?: number | null;
}

export function deriveConductorWorkspaceAutoplayAction(
	input: ConductorWorkspaceAutoplayInput
): ConductorWorkspaceAutoplayAction {
	const isBusy =
		input.isPlanning || input.isExecuting || input.isReviewing || input.isIntegrating;

	if (
		input.hasPendingRun &&
		input.autoExecuteOnPlanCreation &&
		!input.isAutoplayPaused &&
		!isBusy
	) {
		return 'approve_plan';
	}

	if (
		input.tasksNeedingPlanningCount > 0 &&
		!input.isAutoplayPaused &&
		input.hasSelectedTemplate &&
		!input.hasPendingRun &&
		!isBusy &&
		!input.hasPlanningLock
	) {
		return 'plan_task';
	}

	if (
		input.dependencyReadyCount > 0 &&
		!input.isAutoplayPaused &&
		input.hasSelectedTemplate &&
		input.gitReady &&
		input.resourceAllowed &&
		!input.hasPendingRun &&
		!isBusy &&
		!input.hasExecutionLock
	) {
		return 'run_execution';
	}

	if (
		input.reviewReadyCount > 0 &&
		!input.isAutoplayPaused &&
		input.hasSelectedTemplate &&
		input.resourceAllowed &&
		input.dependencyReadyCount === 0 &&
		!input.hasPendingRun &&
		!isBusy &&
		!input.hasReviewLock
	) {
		return 'run_review';
	}

	return null;
}

export function buildConductorAutoplayReadyKey(
	tasks: readonly ConductorAutoplayReadyKeyTask[]
): string {
	return tasks.map((task) => `${task.id}:${task.updatedAt || 0}`).join('|');
}

export function canConductorAutoplayRetryTask(
	input: ConductorAutoplayRetryGateInput
): boolean {
	if (!input.run || !input.retryableStatuses.includes(input.run.status)) {
		return true;
	}

	const endedAt = input.run.endedAt || input.run.startedAt || 0;
	if ((input.taskUpdatedAt || 0) >= endedAt) {
		return true;
	}

	return (input.now ?? Date.now()) - endedAt >= input.cooldownMs;
}

export function isConductorAutoplayTaskCoolingDown(
	input: ConductorAutoplayRetryGateInput
): boolean {
	return !canConductorAutoplayRetryTask(input);
}

export function deriveConductorWorkspaceResourceHoldUpdate(input: {
	currentHoldReason: string | null | undefined;
	resourceAllowed: boolean;
	resourceHoldMessage: string;
	dependencyReadyCount: number;
	reviewReadyCount: number;
}): string | null | undefined {
	const shouldHold =
		!input.resourceAllowed &&
		(input.dependencyReadyCount > 0 || input.reviewReadyCount > 0);

	if (shouldHold) {
		return input.currentHoldReason === input.resourceHoldMessage
			? undefined
			: input.resourceHoldMessage;
	}

	if (input.currentHoldReason === input.resourceHoldMessage) {
		return null;
	}

	return undefined;
}
