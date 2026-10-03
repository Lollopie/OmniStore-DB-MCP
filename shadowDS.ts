import { DataSource } from 'typeorm';
import { config } from 'dotenv';

// Written by `npm run shadow:refresh`. Points at the local shadow copy, never at the real database.
config({
  path: ['.env.shadow'],
  quiet: true,
});

let dataSource: DataSource | undefined;

export async function getShadowDataSource(): Promise<DataSource> {
  if (dataSource?.isInitialized) return dataSource;
  for (const v of ['SHADOW_HOST', 'SHADOW_PORT', 'SHADOW_DATABASE', 'SHADOW_USER', 'SHADOW_PASSWORD']) {
    if (!process.env[v]) throw new Error(`Missing ${v}. Create the shadow database with \`npm run shadow:refresh\`.`);
  }
  dataSource ??= new DataSource({
    type: 'postgres',
    host: process.env.SHADOW_HOST,
    port: Number(process.env.SHADOW_PORT),
    username: process.env.SHADOW_USER,
    password: process.env.SHADOW_PASSWORD,
    database: process.env.SHADOW_DATABASE,
    migrations: undefined,
    entities: undefined,
    // Local container reached through 127.0.0.1 only
    ssl: false,
  });
  await dataSource.initialize();
  return dataSource;
}
