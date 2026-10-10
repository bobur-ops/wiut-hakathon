import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const storageDirectory =
  process.env.DOCUMENT_STORAGE_DIR ?? join(process.cwd(), ".data", "uploads");

export async function storeUpload(storageKey: string, contents: Buffer) {
  const path = join(storageDirectory, storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  return path;
}

export function getStoredFilePath(storageKey: string) {
  return join(storageDirectory, storageKey);
}
