import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Load the repo root's .env.local (never overrides variables that are already set, e.g. in CI). */
export function loadEnv(): void {
  const file = path.join(REPO_ROOT, ".env.local");
  if (fs.existsSync(file)) dotenv.config({ path: file, quiet: true });
}

/** The named variables, or exit with a list of the missing ones. */
export function requireEnv<const K extends string>(...names: K[]): Record<K, string> {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(
      `Missing ${missing.join(", ")}. Set them in .env.local (see .env.example) or the environment.`
    );
    process.exit(1);
  }
  return Object.fromEntries(names.map((name) => [name, process.env[name]!])) as Record<K, string>;
}

export const hasFlag = (flag: string) => process.argv.includes(flag);
