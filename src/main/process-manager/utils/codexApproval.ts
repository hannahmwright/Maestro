import { isAbsolute, relative, resolve } from 'path';

type JsonRecord = Record<string, unknown>;

export type CodexApprovalResponse = {
	approved: boolean;
	result: JsonRecord;
};

function asRecord(value: unknown): JsonRecord | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

export function getCodexApprovalPolicy(
	isLiveRuntime: boolean,
	isReadOnly: boolean
): 'never' | 'on-request' {
	if (!isLiveRuntime || isReadOnly) {
		return 'never';
	}

	return 'on-request';
}

export function buildCodexApprovalResponse(
	method: string,
	params: JsonRecord | null,
	canApproveInteractiveTools: boolean,
	cwd: string
): CodexApprovalResponse | null {
	switch (method) {
		case 'item/fileChange/requestApproval': {
			const approved =
				canApproveInteractiveTools && canApproveFileChangeRequest(params, cwd);
			return {
				approved,
				result: {
					decision: approved ? 'accept' : 'decline',
				},
			};
		}
		case 'applyPatchApproval': {
			const approved =
				canApproveInteractiveTools && canApproveFileChangeRequest(params, cwd);
			return {
				approved,
				result: {
					decision: approved ? 'approved' : 'denied',
				},
			};
		}
		case 'item/commandExecution/requestApproval': {
			const approved =
				canApproveInteractiveTools && canApproveCommandExecutionRequest(params);
			return {
				approved,
				result: {
					decision: pickCommandExecutionDecision(
						Array.isArray(params?.availableDecisions) ? params.availableDecisions : [],
						approved
					),
				},
			};
		}
		case 'execCommandApproval': {
			const approved = canApproveInteractiveTools;
			return {
				approved,
				result: {
					decision: approved ? 'approved' : 'denied',
				},
			};
		}
		case 'item/permissions/requestApproval': {
			return {
				approved: false,
				result: {
					permissions: {},
					scope: 'turn',
				},
			};
		}
		default:
			return null;
	}
}

function canApproveFileChangeRequest(params: JsonRecord | null, cwd: string): boolean {
	const grantRoot = asString(params?.grantRoot);
	return !grantRoot || isWithinRoot(grantRoot, cwd);
}

function canApproveCommandExecutionRequest(params: JsonRecord | null): boolean {
	if (!params) {
		return false;
	}

	if (params.networkApprovalContext || params.proposedExecpolicyAmendment) {
		return false;
	}
	if (
		Array.isArray(params.proposedNetworkPolicyAmendments) &&
		params.proposedNetworkPolicyAmendments.length > 0
	) {
		return false;
	}

	return !hasRequestedAdditionalPermissions(asRecord(params.additionalPermissions));
}

function hasRequestedAdditionalPermissions(
	permissions: JsonRecord | null
): boolean {
	if (!permissions) {
		return false;
	}

	const network = asRecord(permissions.network);
	if (network && Object.values(network).some((value) => value !== null && value !== false)) {
		return true;
	}

	const fileSystem = asRecord(permissions.fileSystem);
	if (
		fileSystem &&
		['read', 'write'].some((key) => Array.isArray(fileSystem[key]) && fileSystem[key].length > 0)
	) {
		return true;
	}

	const macos = asRecord(permissions.macos);
	return !!(
		macos && Object.values(macos).some((value) => value !== null && value !== false)
	);
}

function pickCommandExecutionDecision(availableDecisions: unknown[], approved: boolean): unknown {
	if (approved) {
		if (availableDecisions.includes('accept')) {
			return 'accept';
		}
		if (availableDecisions.includes('acceptForSession')) {
			return 'acceptForSession';
		}

		const amendmentDecision = availableDecisions.find(
			(decision) => !!asRecord(decision)?.acceptWithExecpolicyAmendment
		);
		if (amendmentDecision) {
			return amendmentDecision;
		}

		const networkDecision = availableDecisions.find(
			(decision) => !!asRecord(decision)?.applyNetworkPolicyAmendment
		);
		if (networkDecision) {
			return networkDecision;
		}

		return 'accept';
	}

	if (availableDecisions.includes('decline')) {
		return 'decline';
	}
	if (availableDecisions.includes('cancel')) {
		return 'cancel';
	}

	return 'decline';
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
	const absoluteRoot = resolve(rootPath);
	const absoluteCandidate = resolve(candidatePath);
	const rel = relative(absoluteRoot, absoluteCandidate);
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
