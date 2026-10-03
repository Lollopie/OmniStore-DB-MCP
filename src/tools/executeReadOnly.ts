import z from "zod";
import { ReadOnlyDataSource } from "../../readOnlyDS";
export const MAX_ROWS = 200;

export const executeReadOnlyInputSchema = z.object({
  query: z.string().describe("Executed query"),
  orgId: z.uuid({ version: "v7" }).optional().describe("Sets app.current_org_id for row-level security"),
  userId: z.uuid({ version: "v7" }).optional().describe("Sets app.current_user_id for row-level security"),
  warehouseId: z.uuid({ version: "v7" }).optional().describe("Sets app.current_warehouse_id for row-level security"),
});

export const executeReadOnlyOutputSchema = z.object({
  rows: z.any(),
  truncated: z.boolean(),
});

export async function executeReadOnly(query: string, orgId?: string, userId?: string, warehouseId?: string) {
    const qr = ReadOnlyDataSource.createQueryRunner();
    const settings: [string, string | undefined][] = [
        ["app.current_org_id", orgId],
        ["app.current_user_id", userId],
        ["app.current_warehouse_id", warehouseId],
    ];
    try {
        await qr.connect();
        await qr.startTransaction();
        await qr.query("SET TRANSACTION READ ONLY");
        await qr.query("SET LOCAL statement_timeout = '5s'");
        for (const [key, value] of settings) {
            if (value) await qr.query("SELECT set_config($1, $2, true)", [key, value]);
        }
        const stream = await qr.stream(query);
        const rows: any[] = [];
        for await (const row of stream) {
            rows.push(row);
            if (rows.length > MAX_ROWS) break;
        }
        const structuredContent = {
            rows: rows.slice(0, MAX_ROWS),
            truncated: rows.length > MAX_ROWS,
        };

        return {
            content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
            structuredContent,
        };
    } finally {
        await qr.rollbackTransaction().catch(() => {});
        await qr.release();
    }
}