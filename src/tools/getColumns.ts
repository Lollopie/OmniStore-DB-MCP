import { z } from "zod";
import { ReadOnlyDataSource } from "../../readOnlyDS";

export const columnSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
  default: z.string().nullable(),
});

export const columnOutputSchema = z.object({
  tables: z.array(
    z.object({
      name: z.string(),
      columns: z.array(columnSchema),
    })
  ),
});

export async function getColumns() {
    const rows = await ReadOnlyDataSource.query(`
        SELECT c.table_name, c.column_name, c.column_default,
                c.is_nullable, c.data_type, c.udt_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name, c.ordinal_position
    `);

    const byTable = new Map<string, z.infer<typeof columnSchema>[]>();
        for (const r of rows) {
        if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
        byTable.get(r.table_name)!.push({
            name: r.column_name,
            type: r.data_type === "USER-DEFINED" ? r.udt_name : r.data_type,
            nullable: r.is_nullable === "YES",
            default: r.column_default
        });
    }

    const structuredContent = {
        tables: [...byTable].map(([name, columns]) => ({ name, columns })),
    };

    return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
    };
}