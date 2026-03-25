import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CONDUCTOR_CODEX_MCP_SERVER_NAME,
	CONDUCTOR_PLAN_RESULT_TOOL_NAME,
	CONDUCTOR_REVIEW_RESULT_TOOL_NAME,
	CONDUCTOR_WORK_RESULT_TOOL_NAME,
	conductorPlanToolInputShape,
	conductorReviewToolInputShape,
	conductorWorkToolInputShape,
} from '../../shared/conductorNativeTools';

const server = new McpServer({
	name: CONDUCTOR_CODEX_MCP_SERVER_NAME,
	version: '1.0.0',
});

server.registerTool(
	CONDUCTOR_PLAN_RESULT_TOOL_NAME,
	{
		description: 'Submit the final structured planning result for a Conductor planning turn.',
		inputSchema: conductorPlanToolInputShape,
	},
	async () => ({
		content: [{ type: 'text', text: 'Conductor plan submission captured.' }],
	})
);

server.registerTool(
	CONDUCTOR_WORK_RESULT_TOOL_NAME,
	{
		description: 'Submit the final structured execution result for a Conductor worker turn.',
		inputSchema: conductorWorkToolInputShape,
	},
	async () => ({
		content: [{ type: 'text', text: 'Conductor work submission captured.' }],
	})
);

server.registerTool(
	CONDUCTOR_REVIEW_RESULT_TOOL_NAME,
	{
		description: 'Submit the final structured review result for a Conductor QA turn.',
		inputSchema: conductorReviewToolInputShape,
	},
	async () => ({
		content: [{ type: 'text', text: 'Conductor review submission captured.' }],
	})
);

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((error) => {
	console.error('[ConductorResultMcpServer] Failed to start MCP server:', error);
	process.exit(1);
});
