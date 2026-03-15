import { extractDemoEventOutput } from '../../../shared/demo-artifacts';

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function extractClaudeToolResultOutput(message: unknown): string {
	const outputs: string[] = [];
	const record = asRecord(message);

	const toolUseResult = asRecord(record?.tool_use_result);
	const stdout = asString(toolUseResult?.stdout).trim();
	const stderr = asString(toolUseResult?.stderr).trim();
	if (stdout) {
		outputs.push(stdout);
	}
	if (stderr) {
		outputs.push(stderr);
	}

	const messageRecord = asRecord(record?.message);
	const content = Array.isArray(messageRecord?.content) ? messageRecord.content : [];
	for (const item of content) {
		const block = asRecord(item);
		if (!block || block.type !== 'tool_result') {
			continue;
		}
		const blockContent = asString(block.content).trim();
		if (blockContent) {
			outputs.push(blockContent);
		}
	}

	return outputs.join('\n');
}

export function extractStructuredDemoEventOutput(toolType: string, message: unknown): string {
	if (toolType === 'claude-code') {
		return extractDemoEventOutput(extractClaudeToolResultOutput(message));
	}
	return '';
}
