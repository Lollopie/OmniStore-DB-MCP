// Recreates the local shadow database that plan_migration runs migrations against:
//   1. copies the real database's roles (without dangerous attributes) into a fresh container,
//   2. streams a pg_dump of the real database straight into pg_restore (nothing is written to disk),
//   3. lets only the migrator role log in over TCP, as a non-superuser,
//   4. writes its connection details to .env.shadow.
// Run with `npm run shadow:refresh`. Uses the migrator credentials, so it never runs inside the server.
import { config } from 'dotenv';
import { Client } from 'pg';
import { spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';

config({ path: ['.env', '.env.migrator'], quiet: true });
for (const v of ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'MIGRATOR_USER', 'MIGRATOR_PASSWORD']) {
  if (!process.env[v]) throw new Error(`Missing required env var: ${v}`);
}
const { DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, MIGRATOR_USER, MIGRATOR_PASSWORD } = process.env as Record<string, string>;

const SHADOW_PORT = '5433';
const CONTAINER = 'omnistore-shadow-db';
const PG_IMAGE = 'postgres:18-alpine';
// Predefined roles whose membership is copied. All others are skipped, in particular
// pg_execute_server_program, pg_read_server_files and pg_write_server_files.
const COPIED_PREDEFINED_ROLES = ['pg_read_all_data', 'pg_write_all_data'];

const plannerPassword = randomBytes(24).toString('hex');
const composeEnv = {
  ...process.env,
  SHADOW_SUPERUSER_PASSWORD: randomBytes(24).toString('hex'),
  SHADOW_DATABASE: DATABASE_NAME,
  SHADOW_PORT,
};

function run(cmd: string, args: string[], input?: string, env: NodeJS.ProcessEnv = process.env): string {
  const r = spawnSync(cmd, args, { input, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed with exit code ${r.status}`);
  return r.stdout;
}

const compose = (...args: string[]) => run('docker', ['compose', '-f', 'shadow-db/compose.yaml', ...args], undefined, composeEnv);

// Runs trusted SQL from this script as the container's superuser over the local socket.
const asSuperuser = (sql: string) =>
  run('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', DATABASE_NAME, '-v', 'ON_ERROR_STOP=1', '-qAt'], sql);

function dumpIntoShadow(): Promise<void> {
  const dump = spawn('docker', [
    'run', '--rm',
    // Values come from this process's environment, so the password never appears in a command line
    '-e', 'PGPASSWORD', '-e', 'PGSSLMODE=verify-full', '-e', 'PGSSLROOTCERT=system',
    PG_IMAGE, 'pg_dump',
    '-h', DATABASE_HOST, '-p', DATABASE_PORT, '-U', MIGRATOR_USER, '-d', DATABASE_NAME,
    '--format=custom', '--no-subscriptions', '--no-publications',
    // `contact` forces row-level security, even for its owner, so a dump with RLS off fails.
    // With RLS on, tables like that come out empty; schema and the other tables are complete.
    '--enable-row-security',
  ], { env: { ...process.env, PGPASSWORD: MIGRATOR_PASSWORD }, stdio: ['ignore', 'pipe', 'inherit'] });
  const restore = spawn('docker', [
    'exec', '-i', CONTAINER,
    'pg_restore', '-U', 'postgres', '-d', DATABASE_NAME, '--exit-on-error', '--single-transaction',
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  dump.stdout.pipe(restore.stdin);
  const exit = (p: ReturnType<typeof spawn>, what: string) =>
    new Promise<void>((resolve, reject) =>
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${what} failed with exit code ${code}`)))));
  return Promise.all([exit(dump, 'pg_dump'), exit(restore, 'pg_restore')]).then(() => {});
}

async function main() {
  const source = new Client({
    host: DATABASE_HOST, port: Number(DATABASE_PORT), database: DATABASE_NAME,
    user: MIGRATOR_USER, password: MIGRATOR_PASSWORD, ssl: true,
  });
  await source.connect();
  const id = (name: string) => source.escapeIdentifier(name);
  let setupSql: string;
  try {
    const roles = await source.query<{ rolname: string; rolbypassrls: boolean }>(
      `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname`);
    const memberships = await source.query<{ role: string; member: string }>(`
      SELECT r.rolname AS role, m.rolname AS member
      FROM pg_auth_members am
      JOIN pg_roles r ON r.oid = am.roleid
      JOIN pg_roles m ON m.oid = am.member
      WHERE m.rolname !~ '^pg_' AND (r.rolname !~ '^pg_' OR r.rolname = ANY($1))`, [COPIED_PREDEFINED_ROLES]);
    const { rows: [{ owner }] } = await source.query<{ owner: string }>(
      `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()`);

    // Every role is recreated without superuser, role/database creation or replication rights,
    // whatever it has in the real database. Only the migrator may log in.
    setupSql = [
      ...roles.rows
        .filter((r) => r.rolname !== 'postgres')
        .map((r) => `CREATE ROLE ${id(r.rolname)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION ${r.rolbypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS'} NOLOGIN;`),
      ...memberships.rows.map((m) => `GRANT ${id(m.role)} TO ${id(m.member)};`),
      `ALTER ROLE ${id(MIGRATOR_USER)} LOGIN PASSWORD ${source.escapeLiteral(plannerPassword)};`,
      `ALTER DATABASE ${id(DATABASE_NAME)} OWNER TO ${id(owner)};`,
    ].join('\n');
  } finally {
    await source.end();
  }

  console.log('Recreating the shadow containers...');
  compose('down', '--volumes', '--remove-orphans');
  compose('up', '--detach', '--wait');

  console.log('Creating roles...');
  asSuperuser(setupSql);

  console.log('Copying the database (pg_dump | pg_restore)...');
  await dumpIntoShadow();
  const snapshotTakenAt = new Date().toISOString();
  asSuperuser(`COMMENT ON DATABASE ${id(DATABASE_NAME)} IS ${quoteLiteral(`snapshot:${snapshotTakenAt}`)};`);

  // Superuser: local socket only. Migrator: TCP with password, this database only. Everyone else: rejected.
  run('docker', ['exec', '-i', CONTAINER, 'sh', '-c', 'cat > "$PGDATA/pg_hba.conf"'], [
    'local all postgres trust',
    'local all all reject',
    `host ${hbaName(DATABASE_NAME)} ${hbaName(MIGRATOR_USER)} all scram-sha-256`,
    'host all all all reject',
    '',
  ].join('\n'));
  asSuperuser('SELECT pg_reload_conf();');

  // Fail loudly if the migrator could run programs or touch files on the server
  const check = asSuperuser(`
    SELECT rolsuper OR rolcreaterole OR rolreplication
        OR pg_has_role(oid, 'pg_execute_server_program', 'USAGE')
        OR pg_has_role(oid, 'pg_read_server_files', 'USAGE')
        OR pg_has_role(oid, 'pg_write_server_files', 'USAGE')
    FROM pg_roles WHERE rolname = ${quoteLiteral(MIGRATOR_USER)};`).trim();
  if (check !== 'f') throw new Error(`Unexpected privileges for ${MIGRATOR_USER} in the shadow database (check returned "${check}")`);

  writeFileSync('.env.shadow', [
    '# Written by `npm run shadow:refresh`. Local throwaway database, regenerated on every refresh.',
    'SHADOW_HOST=127.0.0.1',
    `SHADOW_PORT=${SHADOW_PORT}`,
    `SHADOW_DATABASE=${DATABASE_NAME}`,
    `SHADOW_USER=${MIGRATOR_USER}`,
    `SHADOW_PASSWORD=${plannerPassword}`,
    '',
  ].join('\n'));
  console.log(`Shadow database ready on 127.0.0.1:${SHADOW_PORT} (snapshot ${snapshotTakenAt}). Restart the MCP server to reconnect.`);
}

function quoteLiteral(s: string) {
  return `'${s.replace(/'/g, "''")}'`;
}

function hbaName(s: string) {
  if (/["\s]/.test(s)) throw new Error(`Unsupported name for pg_hba.conf: ${s}`);
  return `"${s}"`;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
