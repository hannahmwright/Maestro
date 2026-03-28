import type { Conductor, ConductorStatus } from './types';

export type ConductorWorkspaceMachineEvent =
	| { type: 'SETUP_COMPLETED' }
	| { type: 'RESET_TO_IDLE' }
	| { type: 'PLANNING_STARTED' }
	| { type: 'PLAN_AWAITING_APPROVAL' }
	| { type: 'PLANNING_COMPLETED' }
	| { type: 'PLANNING_FAILED'; pause?: boolean; holdReason?: string | null }
	| { type: 'EXECUTION_STARTED' }
	| {
			type: 'EXECUTION_RESOLVED';
			nextStatus: Extract<ConductorStatus, 'idle' | 'blocked' | 'attention_required'>;
			holdReason?: string | null;
			pause?: boolean;
	  }
	| { type: 'REVIEW_STARTED' }
	| {
			type: 'REVIEW_RESOLVED';
			nextStatus: Extract<ConductorStatus, 'idle' | 'attention_required'>;
			holdReason?: string | null;
			pause?: boolean;
	  }
	| { type: 'INTEGRATION_STARTED' }
	| {
			type: 'INTEGRATION_RESOLVED';
			nextStatus: Extract<ConductorStatus, 'idle' | 'attention_required'>;
			holdReason?: string | null;
	  }
	| { type: 'PAUSE'; holdReason?: string | null }
	| { type: 'RESUME' }
	| { type: 'SET_HOLD_REASON'; holdReason: string | null };

export function transitionConductorWorkspace(
	conductor: Conductor,
	event: ConductorWorkspaceMachineEvent,
	updatedAt = Date.now()
): Conductor {
	switch (event.type) {
		case 'SETUP_COMPLETED':
			return {
				...conductor,
				status: conductor.status === 'needs_setup' ? 'idle' : conductor.status,
				updatedAt,
			};
		case 'RESET_TO_IDLE':
		case 'PLANNING_COMPLETED':
			return {
				...conductor,
				status: 'idle',
				isPaused: false,
				holdReason: null,
				updatedAt,
			};
		case 'PLANNING_STARTED':
			return {
				...conductor,
				status: 'planning',
				isPaused: false,
				holdReason: null,
				updatedAt,
			};
		case 'PLAN_AWAITING_APPROVAL':
			return {
				...conductor,
				status: 'awaiting_approval',
				isPaused: false,
				holdReason: null,
				updatedAt,
			};
		case 'PLANNING_FAILED':
			return {
				...conductor,
				status: 'attention_required',
				isPaused: Boolean(event.pause),
				holdReason: event.pause ? (event.holdReason ?? null) : null,
				updatedAt,
			};
		case 'EXECUTION_STARTED':
		case 'REVIEW_STARTED':
			return {
				...conductor,
				status: 'running',
				holdReason: null,
				updatedAt,
			};
		case 'EXECUTION_RESOLVED':
		case 'REVIEW_RESOLVED':
			return {
				...conductor,
				status: event.nextStatus,
				isPaused: Boolean(event.pause),
				holdReason: event.holdReason ?? null,
				updatedAt,
			};
		case 'INTEGRATION_STARTED':
			return {
				...conductor,
				status: 'integrating',
				holdReason: null,
				updatedAt,
			};
		case 'INTEGRATION_RESOLVED':
			return {
				...conductor,
				status: event.nextStatus,
				holdReason: event.holdReason ?? null,
				updatedAt,
			};
		case 'PAUSE':
			return {
				...conductor,
				isPaused: true,
				holdReason: event.holdReason ?? conductor.holdReason ?? null,
				updatedAt,
			};
		case 'RESUME':
			return {
				...conductor,
				isPaused: false,
				holdReason: null,
				updatedAt,
			};
		case 'SET_HOLD_REASON':
			return {
				...conductor,
				holdReason: event.holdReason,
				updatedAt,
			};
		default: {
			const exhaustive: never = event;
			return exhaustive;
		}
	}
}
