// Safety net: integration tests empty tables, so they must never touch a non-test database.
export {};

const url = process.env.DATABASE_URL ?? "";
let databaseName = "";
try {
  databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
} catch {
  databaseName = "";
}
if (!databaseName.endsWith("_test")) {
  throw new Error(
    "Integration tests refused: TEST_DATABASE_URL must point to a database whose name ends with _test " +
      "(run `npm run db:create:test` then `npm run db:migrate:test`).",
  );
}
