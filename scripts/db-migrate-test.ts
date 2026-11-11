/** Apply migrations to the TEST database only (prisma migrate deploy — non-destructive). */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { databaseName, describeUrl, loadEnv } from "./env";

loadEnv();
const url = process.env.TEST_DATABASE_URL;
if (!url || !databaseName(url).endsWith("_test")) {
  console.error("TEST_DATABASE_URL absent ou nom de base ne finissant pas par _test.");
  process.exit(1);
}
console.log(`Migrations sur ${describeUrl(url)}`);
const cli = path.resolve("node_modules", "prisma", "build", "index.js");
const r = spawnSync(process.execPath, [cli, "migrate", "deploy"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(r.status ?? 1);
