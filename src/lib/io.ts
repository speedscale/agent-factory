import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function resolveFromRepo(...parts: string[]): string {
  return path.join(repoRoot, ...parts);
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, payload, "utf8");
}
