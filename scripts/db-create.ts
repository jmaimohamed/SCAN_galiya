/**
 * Safe, non-destructive database creation.
 *   npm run db:create        -> database named in DATABASE_URL      (e.g. Scann)
 *   npm run db:create:test   -> database named in TEST_DATABASE_URL (must end with _test)
 *
 * Connects to the server's "postgres" maintenance database with the same
 * credentials, checks pg_database and runs CREATE DATABASE only if it is missing.
 * It never drops, resets or alters any database.
 */
import { PrismaClient } from "@prisma/client";
import { databaseName, describeUrl, loadEnv } from "./env";

loadEnv();
const testMode = process.argv.includes("--test");
const url = testMode ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;

async function main() {
  if (!url) throw new Error(`${testMode ? "TEST_DATABASE_URL" : "DATABASE_URL"} n'est pas défini (.env).`);
  const name = databaseName(url);
  if (!/^[A-Za-z0-9_]{1,63}$/.test(name)) throw new Error("Nom de base invalide (A–Z, 0–9, _).");
  if (testMode && !name.endsWith("_test")) throw new Error("La base de test doit se terminer par _test.");

  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  maintenance.search = "";
  const client = new PrismaClient({ datasourceUrl: maintenance.toString() });
  try {
    const rows = await client.$queryRaw<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${name}) AS "exists"`;
    if (rows[0]?.exists) {
      console.log(`Base déjà présente : ${describeUrl(url)} — rien à faire.`);
      return;
    }
    // Identifier validated above; CREATE DATABASE cannot take a bind parameter.
    await client.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    console.log(`Base créée : ${describeUrl(url)}`);
  } finally {
    await client.$disconnect();
  }
}

main().catch((e) => {
  console.error(`Échec : ${e instanceof Error ? e.message.split("\n")[0] : "erreur inconnue"}`);
  process.exit(1);
});
