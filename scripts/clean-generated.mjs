import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();

await Promise.all([
  fs.rm(path.join(rootDir, ".generated"), { recursive: true, force: true }),
  fs.rm(path.join(rootDir, "public", "generated"), { recursive: true, force: true })
]);
