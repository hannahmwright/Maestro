/**
 * Query-complete listener.
 * Forwards turn completion events to renderer clients.
 */

import type { ProcessManager } from '../process-manager';
import type { QueryCompleteData } from '../process-manager/types';
import type { ProcessListenerDependencies } from './types';

export function setupQueryCompleteListener(
	processManager: ProcessManager,
	deps: Pick<ProcessListenerDependencies, 'safeSend'>
): void {
	const { safeSend } = deps;

	processManager.on('query-complete', (sessionId: string, queryData: QueryCompleteData) => {
		safeSend('process:query-complete', sessionId, queryData);
	});
}
