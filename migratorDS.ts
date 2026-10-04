import { DataSource } from 'typeorm';
import { config } from 'dotenv';

// Write access to the real database. In the server, only executeMigration uses this,
// and only after a human approved the plan with a TOTP code.
let dataSource: DataSource | undefined;

export async function getMigrationDataSource(): Promise<DataSource> {
  if (dataSource?.isInitialized) return dataSource;
  config({
    path: [`.env`, '.env.migrator'],
    quiet: true,
  });
  for (const v of [
    'DATABASE_HOST',
    'MIGRATOR_USER',
    'MIGRATOR_PASSWORD',
    'DATABASE_NAME',
    'DATABASE_PORT',
  ]) {
    if (!process.env[v]) throw new Error(`Missing required env var: ${v}`);
  }
  dataSource ??= new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    username: process.env.MIGRATOR_USER,
    password: process.env.MIGRATOR_PASSWORD,
    database: process.env.DATABASE_NAME,
    migrations: undefined,
    entities: undefined,
    ssl: true,
  });
  await dataSource.initialize();
  return dataSource;
}
