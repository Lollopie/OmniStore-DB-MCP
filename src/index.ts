import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ReadOnlyDataSource } from "../readOnlyDS";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { serve } from "@hono/node-server";
import { columnOutputSchema, getColumns } from "./tools/getColumns";
import { constraintOutputSchema, getConstraints } from "./tools/getConstraints";
import { MAX_ROWS, executeReadOnly, executeReadOnlyInputSchema, executeReadOnlyOutputSchema } from "./tools/executeReadOnly";
import { planMigration, planMigrationInputSchema, planMigrationOutputSchema } from "./tools/planMigration";
import { applyMigration, applyMigrationInputSchema, getMigrationStatus, migrationStatusOutputSchema } from "./tools/applyMigration";
import { startApprovalServer } from "./approval/server";
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
  server.registerTool(
    "plan_migration",
    {
      title: "Creates a migration plan",
      description:
        `Runs a migration inside a transaction on a local shadow copy of the OmniStore database, returns the resulting schema diff and rolls back. Never touches the real database. BEGIN/COMMIT, COPY, SET and similar statements are rejected.`,
      inputSchema: planMigrationInputSchema,
      outputSchema: planMigrationOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name, timestamp, sql }) => await planMigration(name, timestamp, sql)
  );
  server.registerTool(
    "apply_migration",
    {
      title: "Request approval to apply a migration",
      description:
        `Submits a plan from plan_migration for human approval and returns an approvalUrl. Nothing runs until a human opens that page, reviews the SQL and enters an authenticator code. Give the URL to the user, then check the outcome with get_migration_status. Plans must be approved within 30 minutes of planning.`,
      inputSchema: applyMigrationInputSchema,
      outputSchema: migrationStatusOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ planId }) => await applyMigration(planId)
  );
  server.registerTool(
    "get_migration_status",
    {
      title: "Get migration status",
      description:
        `Returns a plan's status: planned, pending_approval, applying, applied, failed, rejected or expired.`,
      inputSchema: applyMigrationInputSchema,
      outputSchema: migrationStatusOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ planId }) => getMigrationStatus(planId)
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
startApprovalServer();