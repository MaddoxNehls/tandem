export const ADMIN_URL = process.env.TANDEM_ADMIN_DATABASE_URL ?? 'postgres://tandem:tandem@localhost:5448/tandem';
export const TEST_DB_URL = process.env.TANDEM_TEST_DATABASE_URL ?? 'postgres://tandem:tandem@localhost:5448/tandem_test';
