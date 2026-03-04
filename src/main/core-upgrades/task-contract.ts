import path from 'path';
import { generateUUID } from '../../shared/uuid';
import type { TaskContract, TaskContractInput, RiskLevel, DoneGateProfile } from './types';

const DEFAULT_ALLOWED_COMMANDS = ['npm test', 'npm run lint', 'npm run build', 'pnpm test'];

function normalizeAllowedCommands(commands: string[] | undefined): string[] {
	const source = commands && commands.length > 0 ? commands : DEFAULT_ALLOWED_COMMANDS;
	return [...new Set(source.map((command) => command.trim()).filter(Boolean))];
}

function defaultGateProfile(riskLevel: RiskLevel): DoneGateProfile {
	if (riskLevel === 'high') return 'high_risk';
	if (riskLevel === 'medium') return 'standard';
	return 'quick';
}

export function createTaskContract(input: TaskContractInput): TaskContract {
	const riskLevel = input.risk_level || 'medium';
	const gateProfile = input.done_gate_profile || defaultGateProfile(riskLevel);

	const contract: TaskContract = {
		task_id: input.task_id || `task-${generateUUID()}`,
		goal: input.goal.trim(),
		repo_root: path.resolve(input.repo_root),
		language_profile: input.language_profile || 'ts_js',
		risk_level: riskLevel,
		allowed_commands: normalizeAllowedCommands(input.allowed_commands),
		done_gate_profile: gateProfile,
		max_changed_files: Math.max(1, input.max_changed_files || (riskLevel === 'high' ? 8 : 5)),
		created_at: Date.now(),
		metadata: input.metadata,
	};

	validateTaskContract(contract);
	return contract;
}

export function validateTaskContract(contract: TaskContract): void {
	if (!contract.task_id?.trim()) throw new Error('Task contract missing task_id');
	if (!contract.goal?.trim()) throw new Error('Task contract missing goal');
	if (!path.isAbsolute(contract.repo_root)) {
		throw new Error('Task contract repo_root must be an absolute path');
	}
	if (contract.allowed_commands.length === 0) {
		throw new Error('Task contract must include at least one allowed command');
	}
	if (contract.max_changed_files < 1) {
		throw new Error('Task contract max_changed_files must be >= 1');
	}
}
