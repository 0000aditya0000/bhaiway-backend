
import 'dotenv/config';
import { DataSource } from 'typeorm';

import { postgresSslFromUrl } from './postgres-url';

const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  ssl: postgresSslFromUrl(process.env.DATABASE_URL),

  // Supports both TypeScript source and compiled JavaScript.
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],

  migrations: [__dirname + '/migrations/*{.ts,.js}'],

  // Allow individual migrations to opt out when necessary.
  migrationsTransactionMode: 'each',

  synchronize: false,
});

export default AppDataSource;
