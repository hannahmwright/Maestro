import type { ConductorRun, ConductorRunEvent } from '../../shared/types';
import { generateId } from '../utils/ids';

export interface ConductorRunJournalStoreActions {
	upsertRun: (run: ConductorRun) => void;
	updateRun: (runId: string, updates: Partial<ConductorRun>) => void;
}

export interface ConductorRunJournal {
	getRun: () => ConductorRun;
	getEvents: () => ConductorRunEvent[];
	appendEvent: (
		type: ConductorRunEvent['type'],
		message: string,
		createdAt?: number
	) => ConductorRunEvent;
	sync: (updates?: Partial<ConductorRun>) => ConductorRun;
	finalize: (updates?: Partial<ConductorRun>) => ConductorRun;
}

function syncRun(
	currentRun: ConductorRun,
	updates: Partial<ConductorRun> | undefined,
	actions: ConductorRunJournalStoreActions
): ConductorRun {
	const { events: _ignoredEvents, ...restUpdates } = updates || {};
	const nextRun = {
		...currentRun,
		...restUpdates,
		events: [...currentRun.events],
	};
	actions.updateRun(currentRun.id, {
		...restUpdates,
		events: [...nextRun.events],
	});
	return nextRun;
}

export function createConductorRunJournal(
	initialRun: ConductorRun,
	actions: ConductorRunJournalStoreActions
): ConductorRunJournal {
	let currentRun: ConductorRun = {
		...initialRun,
		events: [...initialRun.events],
	};

	actions.upsertRun(currentRun);

	return {
		getRun: () => currentRun,
		getEvents: () => [...currentRun.events],
		appendEvent: (type, message, createdAt = Date.now()) => {
			const event: ConductorRunEvent = {
				id: `conductor-run-event-${generateId()}`,
				runId: currentRun.id,
				groupId: currentRun.groupId,
				type,
				message,
				createdAt,
			};
			currentRun = {
				...currentRun,
				events: [...currentRun.events, event],
			};
			actions.updateRun(currentRun.id, { events: [...currentRun.events] });
			return event;
		},
		sync: (updates) => {
			currentRun = syncRun(currentRun, updates, actions);
			return currentRun;
		},
		finalize: (updates) => {
			currentRun = syncRun(currentRun, updates, actions);
			return currentRun;
		},
	};
}
