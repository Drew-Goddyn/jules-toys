import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");
const entries = await fs.readdir(rootDir, { withFileTypes: true });

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  if (!/^tier\d+$/.test(entry.name) && entry.name !== "tier-lib") continue;

  await fs.cp(path.join(rootDir, entry.name), path.join(distDir, entry.name), {
    recursive: true,
    force: true
  });
}

await fs.copyFile(path.join(rootDir, "gallery-data.js"), path.join(distDir, "gallery-data.js"));
