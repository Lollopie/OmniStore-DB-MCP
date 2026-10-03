import { z } from "zod";
import { ReadOnlyDataSource } from "../../readOnlyDS";

export const constraintSchema = z.object({
  name: z.string(),
  enforced: z.boolean(),
  definition: z.string(),
});

export const constraintOutputSchema = z.object({
  tables: z.array(
    z.object({
      name: z.string(),
      constraints: z.array(constraintSchema),
    })
  ),
});

export async function getConstraints() {
    const rows = await ReadOnlyDataSource.query(`
        SELECT rel.relname AS table_name,
                con.conname AS constraint_name,
                con.conenforced AS enforced,
                pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid AND rel.relkind = 'r'
        JOIN pg_namespace n ON n.oid = rel.relnamespace AND n.nspname = 'public'
        LEFT JOIN pg_class frel ON frel.oid = con.confrelid
        WHERE con.contype <> 'n'
        ORDER BY rel.relname, con.conname
    `);

    const byTable = new Map<string, z.infer<typeof constraintSchema>[]>();
    for (const r of rows) {
        if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
        byTable.get(r.table_name)!.push({
            name: r.constraint_name,
            enforced: Boolean(r.enforced),
            definition: r.definition
        });
    }

    const structuredContent = {
        tables: [...byTable].map(([name, constraints]) => ({ name, constraints })),
    };

    return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
    };
}