/**
 * Azure / managed Postgres requires TLS when the URL includes sslmode=require.
 * TypeORM does not always honor sslmode from the connection string alone.
 */
export function postgresSslFromUrl(
  databaseUrl: string | undefined,
): { rejectUnauthorized: boolean } | undefined {
  if (!databaseUrl) {
    return undefined;
  }

  if (/[?&]sslmode=(require|verify-ca|verify-full)/i.test(databaseUrl)) {
    return { rejectUnauthorized: false };
  }

  return undefined;
}
