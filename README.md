# OmniStore DB MCP server

An [MCP](https://modelcontextprotocol.io) server that gives AI assistants such as Claude Code read-only access to the OmniStore PostgreSQL database. It can describe the schema and run `SELECT` queries.

Queries usually come from an AI model, so the server assumes any query might be wrong or hostile. This README explains the security choices that follow from that: what the server protects against, how each protection works, how to check it, and what is still open.

_Last verified on 2026-10-03 against the Render database (PostgreSQL 18.6)._

## Tools

| Tool | What it does | Arguments |
|---|---|---|
| `get_schema` | Lists the tables in the `public` schema with their columns, types, nullability and defaults. | none |
| `get_constraints` | Lists each table's constraints with their full SQL definition. | none |
| `query_readonly` | Runs one SQL query in a read-only transaction and returns at most 200 rows. | `query`; optional `orgId`, `userId`, `warehouseId` |

All three tools connect as the same low-privilege database role. `get_schema` only lists columns that this role may read, so hidden columns such as `user.password` don't appear at all, and neither does `migrations`. `get_constraints` reads the system catalog and covers every table, so constraint definitions can name hidden columns, but never show their data.

## Setup

1. Install dependencies: `npm install`
2. Create the database role as described in [Database role](#database-role).
3. Create the env files in the project root. All `.env*` files are git-ignored; never commit them.
   ```
   # .env — connection details, shared
   DATABASE_HOST=...
   DATABASE_PORT=...
   DATABASE_NAME=...

   # .env.readonly — loaded by the server
   READONLY_USER=mcp_readonly
   READONLY_PASSWORD=...

   # .env.migrator — loaded only by migratorDS.ts, never by the server
   MIGRATOR_USER=...
   MIGRATOR_PASSWORD=...
   ```
4. Start the server: `npm start`. It listens on `http://127.0.0.1:3001/mcp`.
5. Claude Code finds the server in `.mcp.json` as `omnistore-db` and asks for approval the first time.

## Threat model

- **Queries are untrusted.** They are usually written by an AI model, which can make mistakes or be manipulated through prompt injection, for example by text stored in the database that it reads back. Every limit is therefore enforced by the server code or by the database. Nothing relies on the tool descriptions, the `readOnlyHint` annotations or what a query claims to do.
- **Anything the tool can read can leave the database.** Query results go into the model's context and are sent to the model provider. The database privileges below decide what data can end up there.
- **The server runs on a developer machine** and should only be reachable from that machine.

Out of scope: attackers who already control the machine, the env files or a database admin account.

## Protections at a glance

| Risk | Protection | Where |
|---|---|---|
| Changing data | Read-only transaction that is always rolled back; role is read-only by default; `SELECT`-only grants | [executeReadOnly.ts](src/tools/executeReadOnly.ts), database role |
| Escaping the read-only transaction with `…; COMMIT; …` | Queries are sent in a way Postgres only accepts as a single statement | `qr.stream()` in [executeReadOnly.ts](src/tools/executeReadOnly.ts) |
| Slow or endless queries | 5-second `statement_timeout`, set per transaction and on the role | both |
| Huge results | At most 200 rows are returned, flagged with `truncated: true` | [executeReadOnly.ts](src/tools/executeReadOnly.ts) |
| Reading secrets or personal data | Column-level grants hide passwords, email addresses, invite token hashes, contact messages and Stripe IDs | database role |
| SQL injection through `orgId`, `userId` or `warehouseId` | Validated as UUID v7, then passed as bound parameters | [executeReadOnly.ts](src/tools/executeReadOnly.ts) |
| Calls from other machines or malicious websites | Listens on `127.0.0.1` only; `Host` and `Origin` headers are checked | [index.ts](src/index.ts) |
| Leaked or intercepted credentials | Env files are git-ignored; the server only loads the read-only credentials; database connections use TLS with certificate checks | [.gitignore](.gitignore), [readOnlyDS.ts](readOnlyDS.ts) |

Row-level security also limits a query to one organization, user or warehouse, but it is **not** access control. See [Row-level security](#row-level-security).

## How each protection works

### Read-only at two levels

Every `query_readonly` call:

1. takes a connection from the pool and starts a transaction with `SET TRANSACTION READ ONLY`,
2. runs the query,
3. ends with `ROLLBACK` in a `finally` block, so nothing is ever committed, even when the query succeeds.

A read-only transaction rejects `INSERT`, `UPDATE`, `DELETE`, every `CREATE`, `ALTER` and `DROP` (including temporary tables), and sequence changes such as `nextval()`.

Independently of the code, the database role:

- only has `SELECT` grants, so a write would also fail with a permission error,
- has `default_transaction_read_only = on`, so even a connection opened outside this server with the same credentials starts read-only.

Functions that run with their owner's rights (`SECURITY DEFINER`) could get around both, so the role can only execute two of them: `is_org_admin` and `is_warehouse_admin`, which only read data. All other functions can only be executed by the app's role.

### One statement per call

When a query is sent with Postgres's simple protocol, one string can hold several statements. A query like this:

```sql
SELECT 1; COMMIT; SET default_transaction_read_only = off; SET statement_timeout = 0; …
```

would end the read-only transaction and switch off both role defaults. Role settings are only defaults, and any session may override them. A plain `SET` also outlasts the transaction, so it would affect later calls that reuse the same pooled connection.

To prevent this, `executeReadOnly` runs the query with `qr.stream()`. That uses `pg-query-stream`, which sends the query with the extended protocol. With the extended protocol, Postgres accepts exactly one statement and rejects anything more with `cannot insert multiple commands into a prepared statement`.

> **Don't replace `qr.stream(query)` with `qr.query(query)`.** Without parameters, `qr.query` uses the simple protocol, and the hole is back.

### Resource limits

- **Time:** each transaction runs `SET LOCAL statement_timeout = '5s'`, and the role has the same value as its default. Rows are fetched in batches and Postgres restarts the timer for each batch, so one call can take somewhat longer than 5 seconds in total.
- **Rows:** the server stops reading after 201 rows, returns the first 200 and sets `truncated: true`. Rows are streamed in batches as they're read, so the rest of a large result is never transferred.
- **Requests:** the MCP SDK's Hono app rejects request bodies over 4 MiB.

### Database role

The server connects as `mcp_readonly` (the `READONLY_USER`). This SQL is equivalent to its current setup:

```sql
CREATE ROLE mcp_readonly LOGIN PASSWORD '...';
ALTER ROLE mcp_readonly SET default_transaction_read_only = on;
ALTER ROLE mcp_readonly SET statement_timeout = '5s';

GRANT USAGE ON SCHEMA public TO mcp_readonly;
GRANT SELECT ON inventory, user_org_role, user_warehouse_role, warehouse TO mcp_readonly;

-- Column-level grants: the columns left out stay hidden
GRANT SELECT (user_id, username, created_at) ON "user" TO mcp_readonly;            -- not email, password
GRANT SELECT (org_id, name, created_at, subscription) ON organization TO mcp_readonly; -- not stripe_subscription_id
GRANT SELECT (invite_id, org_id, warehouse_id, role, expires_at, consumed_at, created_at)
  ON invite TO mcp_readonly;                                                        -- not email, token_hash
GRANT SELECT (id, f_name, l_name, created_at) ON contact TO mcp_readonly;           -- not email, message

-- No access to migrations

-- The row-level security policies call these functions
GRANT EXECUTE ON FUNCTION is_org_admin(uuid, uuid), is_warehouse_admin(uuid, uuid) TO mcp_readonly;
```

The role is deliberately **not**:

- a superuser, or allowed to create roles or databases,
- allowed to bypass row-level security (`BYPASSRLS`),
- a member of any other role, including `pg_read_all_data`, which would override the column-level grant,
- allowed to create objects in the database or in the `public` schema.

Consequences:

- `SELECT *` on `user`, `organization`, `invite` or `contact` fails with a permission error. Name the allowed columns instead.
- New tables can't be read until you grant `SELECT` on them. At the same time, decide whether they need row-level security and whether any column must stay hidden.

The only installed extension is `plpgsql`. Extensions such as `dblink` or `postgres_fdw` would let a query connect to another database, where this transaction's read-only setting doesn't apply. Don't install them, or at least don't let this role use them.

### Row-level security

Most tables have row-level security policies that filter rows by the session settings `app.current_org_id`, `app.current_user_id` and `app.current_warehouse_id`. The app sets the same settings. This role can't bypass the policies, so without these settings the tool sees no rows in those tables.

`query_readonly` takes optional `orgId`, `userId` and `warehouseId` arguments and applies them to the query:

- zod checks that each one is a UUID v7 before anything reaches the database.
- Each one is set with `SELECT set_config($1, $2, true)`. The values are bound parameters, never pasted into the SQL. The `true` limits them to the current transaction, so they disappear with the rollback and never carry over to the next call on the same connection.

> **These IDs are not authentication.** The caller chooses them. Any caller can see any organization's data by passing its ID, or use the ID of any user, including an organization owner. The IDs make a query see what the app would show that user. They don't limit what the caller can see. If the server ever needs to restrict callers, the IDs must come from something the caller can't control, such as server configuration or the MCP client's authentication.

Which IDs each table needs:

| Table | Visible rows |
|---|---|
| `organization`, `warehouse` | Rows of the organization in `orgId` |
| `inventory` | Rows of the warehouse in `warehouseId` |
| `user_org_role` | With `userId`: that user's own rows. If that user is also an owner or admin of the organization in `orgId`: all of that organization's rows. |
| `user_warehouse_role` | With `userId`: that user's own rows. If that user is also an owner or admin of `orgId`: the rows of that organization's warehouses. If that user is an admin of `warehouseId`: that warehouse's rows. |
| `invite` | Rows of `orgId`, if `userId` is an owner or admin of it |
| `contact` | None: row-level security is forced and there is only an `INSERT` policy |
| `user` | All rows, since the table has no row-level security (allowed columns only) |
| `migrations` | None: the role has no access |

Without the IDs a table needs, a query returns no rows rather than failing.

### Network access

The server listens on `127.0.0.1:3001` only, so other machines can't reach it. `createMcpHonoApp()` from the MCP SDK also checks two headers on every request and answers `403` if either check fails:

- **`Host`** must be `localhost`, `127.0.0.1` or `[::1]`. This blocks DNS rebinding, where a malicious website points its own domain at `127.0.0.1` to reach local servers through the browser.
- **`Origin`**, which browsers send, must be a localhost origin. Requests without an `Origin` header, such as those from Claude Code, pass.

There is no authentication, so any program on the same machine can call the server.

If you ever expose the server beyond localhost, add authentication and pass `allowedHosts` to `createMcpHonoApp`. In [index.ts](src/index.ts), `serve({ hostname })` decides where the server listens, while `createMcpHonoApp({ host })` (default `127.0.0.1`) decides which header checks apply. Keep the two in sync.

### Credentials

- Credentials are split by role. The server ([readOnlyDS.ts](readOnlyDS.ts)) loads only `.env` and `.env.readonly`, so the migrator's credentials never reach its process. Only [migratorDS.ts](migratorDS.ts) loads `.env.migrator`.
- `.gitignore` covers `.env` and every `.env.*` file.
- The server refuses to start if any `READONLY_*` or `DATABASE_*` variable is missing.
- Both connections use TLS (`ssl: true`). node-postgres hands this to Node's TLS defaults, which verify the server's certificate and hostname. Don't set `NODE_TLS_REJECT_UNAUTHORIZED=0` to get around certificate errors, because that turns the check off.

## Verifying

Run these through `query_readonly`. Each should give the result shown.

| Query | Expected result |
|---|---|
| `SELECT 1; SELECT 2` | `cannot insert multiple commands into a prepared statement` |
| `INSERT INTO migrations ("timestamp", name) SELECT 0, 'x' WHERE false` | `cannot execute INSERT in a read-only transaction` |
| `CREATE TEMP TABLE t AS SELECT 1` | `cannot execute … in a read-only transaction` |
| `SELECT nextval('migrations_id_seq')` | `permission denied for sequence migrations_id_seq` |
| `SELECT pg_sleep(7)` | `canceling statement due to statement timeout` |
| `SELECT g FROM generate_series(1, 500) g` | 200 rows and `truncated: true` |
| `SELECT password FROM "user"` | `permission denied for table user` |
| `SELECT current_setting('app.current_org_id', true)`, run right after a call with `orgId` | An empty value, so the ID didn't carry over |
| Any query with `orgId: "abc"` | An input validation error, before anything reaches the database |

The write tests use `WHERE false`, so they wouldn't change anything even if they got through.

To check the role itself:

```sql
SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolconfig,
       pg_has_role(oid, 'pg_read_all_data', 'MEMBER') AS read_all_data
FROM pg_roles WHERE rolname = current_user;
-- Expected: false, false, false, false,
--           {statement_timeout=5s,default_transaction_read_only=on}, false
```

To check the header validation (both commands should print `403`):

```sh
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: evil.example" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  http://127.0.0.1:3001/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://evil.example" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  http://127.0.0.1:3001/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Rules for changes

- Run the caller's query through `qr.stream()`, never through `qr.query()`.
- Pass tool arguments to SQL only as bound parameters (`$1`, `$2`, …), never by building strings.
- Keep `SET TRANSACTION READ ONLY` and `SET LOCAL statement_timeout` before the query, and the `ROLLBACK` in `finally`.
- Use `set_config(…, true)` or `SET LOCAL` for per-call settings, never a plain `SET`. Otherwise the setting carries over to the next call on the pooled connection.
- Don't import `migratorDS.ts` into the server, and don't add `.env.migrator` to the server's `config()` paths.
- For a new table, grant `SELECT` explicitly, decide on row-level security, and hide sensitive columns with a column-level grant.
- For a new `SECURITY DEFINER` function, revoke `EXECUTE` from `PUBLIC`, grant it only to the roles that need it, and set a fixed `search_path` (the existing functions use `pg_catalog, public, pg_temp`).
- Read `NULLIF(current_setting('app.…', true), '')::uuid` in policies, never `current_setting(…)::uuid` directly. On a reused connection an unset value comes back as `''`, which fails the cast.
- The `user_warehouse_role` select policy relies on `warehouse`'s row-level security to limit organization admins to their own organization's warehouses. If you change the `warehouse` policy, check that this still holds.
- Before exposing the server beyond localhost, add authentication and `allowedHosts`.

## Known gaps

These were still open at the last check.

### Server

- **No authentication.** Any program on the same machine can call the server. The localhost binding and header checks keep out other machines and websites, but not local programs.
- **No limit on result size in bytes.** Results are capped at 200 rows, but a single row can be huge. For example, `SELECT repeat('x', 100000000)` returns about 100 MB, and a few such rows could exhaust the server's memory. Stopping once the JSON output passes a fixed size would fix this.

### Database

- **`user` has no row-level security.** The tool can list every user's ID, username and creation date. Decide whether that is acceptable.
