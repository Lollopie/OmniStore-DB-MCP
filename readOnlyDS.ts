import { DataSource } from 'typeorm';
import { config } from 'dotenv';

config({
  path: [`.env`],
});
for (const v of [
  'DATABASE_HOST',
  'READONLY_USER',
  'READONLY_PASSWORD',
  'DATABASE_NAME',
  'DATABASE_PORT',
]) {
  if (!process.env[v]) throw new Error(`Missing required env var: ${v}`);
}
export const ReadOnlyDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT),
  username: process.env.READONLY_USER,
  password: process.env.READONLY_PASSWORD,
  database: process.env.DATABASE_NAME,
  migrations: undefined,
  entities: undefined,
  ssl: true
});
