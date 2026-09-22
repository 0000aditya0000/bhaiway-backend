import 'dotenv/config';
import { DataSource } from 'typeorm';

import { postgresSslFromUrl } from './postgres-url';

const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  ssl: postgresSslFromUrl(process.env.DATABASE_URL),

  entities: ['src/**/*.entity.ts'],

  migrations: ['src/database/migrations/*.ts'],

  // Allow individual migrations to opt out (e.g. PostgreSQL ENUM ADD VALUE).
  migrationsTransactionMode: 'each',

  synchronize: false,
});

export default AppDataSource;
