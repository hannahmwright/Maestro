import path from 'path';
import { generateUUID } from '../../shared/uuid';
import type { TaskContract, TaskContractInput, RiskLevel, DoneGateProfile } from './types';

const DEFAULT_ALLOWED_COMMANDS = ['npm test', 'npm run lint', 'npm run build', 'pnpm test'];
const VALID_LANGUAGE_PROFILES = new Set(['ts_js', 'generic']);
const VALID_RISK_LEVELS = new Set<RiskLevel>(['low', 'medium', 'high']);
const VALID_DONE_GATE_PROFILES = new Set<DoneGateProfile>(['quick', 'standard', 'high_risk']);

function normalizeAllowedCommands(commands: string[] | undefined): string[] {
	const source = commands && commands.length > 0 ? commands : DEFAULT_ALLOWED_COMMANDS;
	return [...new Set(source.map((command) => command.trim()).filter(Boolean))];
}

function defaultGateProfile(riskLevel: RiskLevel): DoneGateProfile {
	if (riskLevel === 'high') return 'high_risk';
	if (riskLevel === 'medium') return 'standard';
	return 'quick';
}

function validateTaskContractInput(input: TaskContractInput): void {
	if (!input.goal || !input.goal.trim()) {
		throw new Error('Task contract input missing goal');
	}
	if (!input.repo_root || !input.repo_root.trim()) {
		throw new Error('Task contract input missing repo_root');
	}
	if (input.risk_level && !VALID_RISK_LEVELS.has(input.risk_level)) {
		throw new Error(`Task contract input has invalid risk_level: ${String(input.risk_level)}`);
	}
	if (input.done_gate_profile && !VALID_DONE_GATE_PROFILES.has(input.done_gate_profile)) {
		throw new Error(
			`Task contract input has invalid done_gate_profile: ${String(input.done_gate_profile)}`
		);
	}
	if (input.language_profile && !VALID_LANGUAGE_PROFILES.has(input.language_profile)) {
		throw new Error(
			`Task contract input has invalid language_profile: ${String(input.language_profile)}`
		);
	}
	if (input.allowed_commands && !Array.isArray(input.allowed_commands)) {
		throw new Error('Task contract input allowed_commands must be an array of commands');
	}
}

export function createTaskContract(input: TaskContractInput): TaskContract {
	validateTaskContractInput(input);

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
	if (!VALID_LANGUAGE_PROFILES.has(contract.language_profile)) {
		throw new Error(
			`Task contract has invalid language_profile: ${String(contract.language_profile)}`
		);
	}
	if (!VALID_RISK_LEVELS.has(contract.risk_level)) {
		throw new Error(`Task contract has invalid risk_level: ${String(contract.risk_level)}`);
	}
	if (!VALID_DONE_GATE_PROFILES.has(contract.done_gate_profile)) {
		throw new Error(
			`Task contract has invalid done_gate_profile: ${String(contract.done_gate_profile)}`
		);
	}
	if (contract.allowed_commands.length === 0) {
		throw new Error('Task contract must include at least one allowed command');
	}
	if (
		!contract.allowed_commands.every((command) => typeof command === 'string' && command.trim())
	) {
		throw new Error('Task contract allowed_commands must contain non-empty commands');
	}
	if (contract.max_changed_files < 1) {
		throw new Error('Task contract max_changed_files must be >= 1');
	}
	if (!Number.isFinite(contract.created_at) || contract.created_at <= 0) {
		throw new Error('Task contract created_at must be a positive timestamp');
	}
}
