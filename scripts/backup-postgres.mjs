import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL to a PostgreSQL connection URL.");

const parsedUrl = new URL(databaseUrl);
if (parsedUrl.protocol !== "postgres:" && parsedUrl.protocol !== "postgresql:") {
  throw new Error("DATABASE_URL must use the postgres or postgresql protocol.");
}
// Prisma's schema= parameter is not a libpq option; backups contain the whole database.
parsedUrl.searchParams.delete("schema");

const backupDirectory = resolve(process.env.BACKUP_DIR || "./backups");
mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
try { chmodSync(backupDirectory, 0o700); } catch { /* Windows uses inherited directory ACLs. */ }
process.umask(0o077);

const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
const backupFile = resolve(backupDirectory, `nexus-${timestamp}-${randomBytes(4).toString("hex")}.dump`);

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} exited with code ${result.status ?? "unknown"}.`);
  }
  return result.stdout;
}

try {
  run("pg_dump", ["--dbname", parsedUrl.toString(), "--format=custom", "--no-owner", "--no-acl", `--file=${backupFile}`]);
  if (!existsSync(backupFile) || statSync(backupFile).size === 0) {
    throw new Error("pg_dump did not create a non-empty backup archive.");
  }
  run("pg_restore", ["--list", backupFile]);
  process.stdout.write(`Created and checked backup archive: ${backupFile}\n`);
} catch (error) {
  if (existsSync(backupFile)) rmSync(backupFile);
  throw error;
}
