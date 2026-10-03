import z from "zod";
import { getShadowDataSource } from "../../shadowDS";
import * as crypto from 'crypto';
import { QueryRunner } from "typeorm";
import { parse } from "libpg-query";
import { columnSchema } from "./getColumns";
class UserFacingError extends Error {}

enum PlanStatus {
    planned='planned',
    executed='executed',
    rejected='rejected',
}

export interface Plan {
    id: string, 
    name: string, 
    timestamp: string, 
    sql: string, 
    diff: string, 
    createdAt: number, 
    status: PlanStatus
}

export const planMigrationInputSchema = z.object({
    name: z.string().describe('Migration name'),
    timestamp: z.string().regex(/^\d{1,18}$/).describe('Migration timestamp (digits only)'),
    sql: z.string().describe('Migration sql'),
});

export const planMigrationOutputSchema = z.object({
    planId: z.string(),
    diff: z.string(),
    snapshotTakenAt: z.string().nullable().describe('When the shadow copy was taken from the real database'),
});

interface column {
    name: string,
    type: string,
    nullable: boolean,
    default: string | null,
}

interface schemaType {
    tables: {
        name: string;
        columns: column[];
    }[];
}

const plans = new Map<string, Plan>();

// Statement types a migration may contain. Everything else, in particular BEGIN/COMMIT/ROLLBACK,
// COPY, SET, CREATE EXTENSION and role changes, is rejected before anything reaches the database.
const ALLOWED_STATEMENTS = new Set([
    'CreateStmt', 'AlterTableStmt', 'DropStmt', 'RenameStmt', 'IndexStmt',
    'CreateEnumStmt', 'AlterEnumStmt', 'CompositeTypeStmt', 'CreateDomainStmt', 'AlterDomainStmt',
    'CreateSeqStmt', 'AlterSeqStmt', 'ViewStmt', 'CreateTableAsStmt', 'RefreshMatViewStmt',
    'CreateFunctionStmt', 'CreateTrigStmt', 'CreatePolicyStmt', 'AlterPolicyStmt',
    'GrantStmt', 'CommentStmt', 'DoStmt',
    'InsertStmt', 'UpdateStmt', 'DeleteStmt', 'SelectStmt',
]);

async function assertAllowedStatements(sql: string) {
    let ast: Awaited<ReturnType<typeof parse>>;
    try {
        ast = await parse(sql);
    } catch (e) {
        throw new UserFacingError(`Migration SQL doesn't parse: ${e instanceof Error ? e.message : e}`);
    }
    if (!ast.stmts?.length) throw new UserFacingError('Migration SQL contains no statements.');
    for (const { stmt } of ast.stmts) {
        const type = Object.keys(stmt ?? {})[0];
        if (type === 'TransactionStmt') {
            throw new UserFacingError('Migration SQL must not contain BEGIN, COMMIT, ROLLBACK or SAVEPOINT. The migration already runs in a transaction.');
        }
        if (type === 'IndexStmt' && (stmt as { IndexStmt: { concurrent?: boolean } }).IndexStmt.concurrent) {
            throw new UserFacingError('CREATE INDEX CONCURRENTLY can\'t run inside a transaction, so it can\'t be planned.');
        }
        if (!ALLOWED_STATEMENTS.has(type)) {
            throw new UserFacingError(`Statement type ${type} isn't allowed in a migration.`);
        }
    }
}

// Runs against the local shadow copy (see shadow-db/), never against the real database.
export async function planMigration(name: string, timestamp: string, sql: string) {
  await assertAllowedStatements(sql);
  const qr = (await getShadowDataSource()).createQueryRunner();
  try {
    await qr.connect();
    await qr.startTransaction();
    await qr.query("SET LOCAL statement_timeout = '30s'");
    await assertNotApplied(qr, name, timestamp);
    const before = await snapshotSchema(qr);
    await qr.query(sql);
    await recordMigration(qr, name, timestamp);
    const diff = diffSchemas(before, await snapshotSchema(qr));
    const snapshotTakenAt = await getSnapshotTime(qr);
    const id = crypto.createHash('sha256').update(`${name}|${timestamp}|${sql}`).digest('hex');
    plans.set(id, { id, name, timestamp, sql, diff, createdAt: Date.now(), status: PlanStatus.planned });
    const structuredContent = { planId: id, diff, snapshotTakenAt };
    return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
    };
  } finally {
    await qr.rollbackTransaction().catch(() => {});
    await qr.release();
  }
}

async function assertNotApplied(qr: QueryRunner, name: string, timestamp: string) {
    const isMigrationInDB = await qr.query('SELECT name FROM migrations WHERE name = $1', [name]);
    const latestTimestamp: { timestamp: string }[] = await qr.query('SELECT timestamp FROM migrations ORDER BY timestamp DESC LIMIT 1');
    if (isMigrationInDB.length > 0) {
        throw new UserFacingError(`A migration with the name ${name} is already applied.`)
    }
    if (latestTimestamp.length > 0 && BigInt(latestTimestamp[0].timestamp) >= BigInt(timestamp)) {
        throw new UserFacingError(`A migration with the same or a newer timestamp is already applied.
                                   Use a timestamp later than the latest applied migration.`)
    }
}

// Set by `npm run shadow:refresh`, so callers can see how old the copy is.
async function getSnapshotTime(qr: QueryRunner): Promise<string | null> {
    const [row] = await qr.query(`SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = current_database()`);
    return row?.comment?.replace(/^snapshot:/, '') ?? null;
}

async function snapshotSchema(qr: QueryRunner): Promise<schemaType> {
    const rows = await qr.query(`
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
    return structuredContent;
}

async function recordMigration(qr: QueryRunner, name: string, timestamp: string) {
    await qr.query('INSERT INTO migrations(timestamp, name) VALUES ($1, $2)', [timestamp, name]);
}


function diffSchemas(before: schemaType, after: schemaType): string {
    let output = "";
    for (const table of after.tables) {
        const beforeTableList = before.tables.filter((t) => t.name === table.name);
        if (beforeTableList.length === 0) {
            output += `+TABLE ${table.name}\n`;
            continue;
        }
        const beforeTable = beforeTableList[0];
        for (const column of table.columns) {
            const beforeColumnList = beforeTable.columns.filter((c) => c.name === column.name);
            if (beforeColumnList.length === 0) {
                output += `TABLE ${table.name}\n+COLUMN name:${column.name}, type:${column.type}, nullable:${column.nullable}, default:${column.default}\n`;
                continue;
            }
            const beforeColumn = beforeColumnList[0];
            let columnAdded = "";
            let columnRemoved = "";
            let key: keyof typeof column;
            for (key in column) {
                if (column[key] != beforeColumn[key]) {
                    columnAdded += `${key}: ${column[key]}, `
                    columnRemoved += `${key}: ${beforeColumn[key]}, `
                }
            }
            if (columnAdded.length > 0) {
                columnAdded = columnAdded.slice(0, -2);
                columnRemoved = columnRemoved.slice(0, -2);
                output += `TABLE ${table.name} COLUMN ${column.name}\n+${columnAdded}\n-${columnRemoved}\n`;
            }
            
        }
    }
    for (const table of before.tables) {
        const afterTableList = after.tables.filter((t) => t.name === table.name);
        if (afterTableList.length === 0) {
            output += `-TABLE ${table.name}\n`;
            continue;
        }
        const afterTable = afterTableList[0];
        for (const column of table.columns) {
            const afterColumnList = afterTable.columns.filter((c) => c.name === column.name);
            if (afterColumnList.length === 0) {
                output += `TABLE ${table.name}\n-COLUMN name:${column.name}, type:${column.type}, nullable:${column.nullable}, default:${column.default}\n`;
                continue;
            }
        }
    }
    return output;
}