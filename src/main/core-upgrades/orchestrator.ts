import { createTaskContract } from './task-contract';
import type { TaskContract, TaskContractInput } from './types';

export class CoreUpgradeOrchestrator {
	createTaskContract(input: TaskContractInput): TaskContract {
		return createTaskContract(input);
	}
}

export const coreUpgradeOrchestrator = new CoreUpgradeOrchestrator();
