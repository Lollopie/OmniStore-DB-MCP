import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ReadOnlyDataSource } from "../readOnlyDS";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { serve } from "@hono/node-server";
import { columnOutputSchema, getColumns } from "./tools/getColumns";
import { constraintOutputSchema, getConstraints } from "./tools/getConstraints";
import { MAX_ROWS, executeReadOnly, executeReadOnlyInputSchema, executeReadOnlyOutputSchema } from "./tools/executeReadOnly";
const PORT = 3001; 

function buildServer(): McpServer {
  const server = new McpServer({ name: "omnistore-db-server", version: "1.0.0" });

  server.registerTool(
    "get_schema",
    {
      title: "Get schema",
      description:
        "Lists all tables in the public schema of the OmniStore database with their columns, types, nullability and defaults.",
      outputSchema: columnOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => await getColumns()
  );
  server.registerTool(
    "get_constraints",
    {
      title: "Get constraints",
      description:
        "Lists all constraints for all tables in the public schema of the OmniStore database with their names, types, enforcedness and definition.",
      outputSchema: constraintOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => await getConstraints()
  );
  server.registerTool(
    "query_readonly",
    {
      title: "Run a read-only query",
      description:
        `Runs a query in the public schema of the OmniStore database inside a read-only transaction with a row limit of ${MAX_ROWS} rows.`,
      inputSchema: executeReadOnlyInputSchema,
      outputSchema: executeReadOnlyOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, orgId, userId, warehouseId }) => await executeReadOnly(query, orgId, userId, warehouseId)
  );
  return server;
}
ReadOnlyDataSource.initialize();
const mcpHandler = createMcpHandler(buildServer);

const app = createMcpHonoApp();

app.all("/mcp", (c) => mcpHandler.fetch(c.req.raw));

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, () => {
  console.log(`Streamable HTTP MCP Server listening on http://127.0.0.1:${PORT}/mcp`)
})