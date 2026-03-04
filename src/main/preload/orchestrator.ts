import { ipcRenderer } from 'electron';
import type { TaskContract, TaskContractInput } from '../core-upgrades/types';

export function createOrchestratorApi() {
	return {
		createTaskContract: (input: TaskContractInput): Promise<TaskContract> =>
			ipcRenderer.invoke('orchestrator:createTaskContract', input),
	};
}

export type OrchestratorApi = ReturnType<typeof createOrchestratorApi>;
