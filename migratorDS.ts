import { DataSource } from 'typeorm';
import { config } from 'dotenv';

config({
  path: [`.env`],
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
export const MigrationDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT),
  username: process.env.MIGRATOR_USER,
  password: process.env.MIGRATOR_PASSWORD,
  database: process.env.DATABASE_NAME,
  migrations: undefined,
  entities: undefined,
});
