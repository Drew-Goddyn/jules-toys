import fs from "node:fs";
import path from "node:path";
import { loadGalleryItems } from "./gallery-data-loader.mjs";
import { loadSpecimenLab, specimenDataPath } from "./specimen-lab-data.mjs";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");
const manifestPath = path.join(rootDir, ".generated", "gallery-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const items = loadGalleryItems(rootDir);
const specimenLab = loadSpecimenLab(rootDir);

assertFile(path.join(distDir, "index.html"), "built gallery index");
assertFile(path.join(distDir, "gallery-data.js"), "copied gallery data");
assertFile(path.join(distDir, specimenDataPath), "copied Specimen Lab data");
assertFile(path.join(distDir, ".nojekyll"), "GitHub Pages .nojekyll marker");

for (const item of items) {
  assertFile(path.join(distDir, item.path), `toy route ${item.path}`);
}

for (const item of manifest.items) {
  for (const variant of [
    ...item.image.thumbnails.avif,
    ...item.image.thumbnails.webp,
    ...item.image.preview.avif,
    ...item.image.preview.webp
  ]) {
    assertFile(path.join(distDir, variant.path), `generated image ${variant.path}`);
  }
}

if (manifest.items.length !== items.length) {
  throw new Error(`Manifest item count ${manifest.items.length} does not match gallery data ${items.length}.`);
}

if (manifest.specimenLab.specimens.length !== specimenLab.specimens.length) {
  throw new Error(`Manifest specimen count ${manifest.specimenLab.specimens.length} does not match source data ${specimenLab.specimens.length}.`);
}

for (const specimen of specimenLab.specimens) {
  assertFile(path.join(distDir, specimen.screenshot.path), `Specimen Lab screenshot ${specimen.screenshot.path}`);
}

console.log(`Validated dist for ${items.length} gallery items and ${specimenLab.specimens.length} Pullfrog specimens.`);

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Missing ${label}: ${path.relative(rootDir, filePath)}`);
  }
}
