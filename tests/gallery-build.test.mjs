import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { loadGalleryItems } from "../scripts/gallery-data-loader.mjs";

const rootDir = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, ".generated", "gallery-manifest.json"), "utf8"));
const items = loadGalleryItems(rootDir);

test("manifest preserves gallery data and derives search text", () => {
  assert.equal(manifest.items.length, items.length);
  assert.equal(manifest.chunkSize, 48);

  for (const item of manifest.items) {
    assert.equal(typeof item.searchText, "string");
    assert.ok(item.searchText.includes(item.title.toLowerCase()));
    assert.ok(item.searchText.includes(`t${item.tier}`));
  }
});

test("generated thumbnail assets exist and beat source screenshots", () => {
  let sourceTotal = 0;
  let thumb480WebpTotal = 0;

  for (const item of manifest.items) {
    const sourcePath = path.join(rootDir, item.screenshot);
    const sourceBytes = fs.statSync(sourcePath).size;
    const thumb480 = item.image.thumbnails.webp.find((variant) => variant.width <= 480);
    assert.ok(thumb480, `${item.title} has a 480w WebP thumbnail`);

    const thumbPath = path.join(rootDir, "public", thumb480.path);
    assert.ok(fs.existsSync(thumbPath), `${item.title} thumbnail exists`);
    assert.ok(fs.statSync(thumbPath).size < sourceBytes, `${item.title} thumbnail is smaller than source PNG`);

    sourceTotal += sourceBytes;
    thumb480WebpTotal += fs.statSync(thumbPath).size;
  }

  assert.ok(thumb480WebpTotal < sourceTotal * 0.45, "480w thumbnails are materially smaller than source screenshots");
});

test("generated preview assets expose PhotoSwipe-ready dimensions", () => {
  for (const item of manifest.items) {
    for (const format of ["avif", "webp"]) {
      const preview = item.image.preview[format]?.[0];
      assert.ok(preview, `${item.title} has a ${format.toUpperCase()} preview`);
      assert.equal(typeof preview.path, "string");
      assert.ok(preview.width > 0, `${item.title} ${format} preview has width`);
      assert.ok(preview.height > 0, `${item.title} ${format} preview has height`);
      assert.ok(preview.width <= item.image.width, `${item.title} ${format} preview does not exceed source width`);
      assert.ok(preview.height <= item.image.height, `${item.title} ${format} preview does not exceed source height`);
      assert.ok(fs.existsSync(path.join(rootDir, "public", preview.path)), `${item.title} ${format} preview exists`);
    }
  }
});

test("dist preserves every public toy route", () => {
  assert.ok(fs.existsSync(path.join(rootDir, "dist", "index.html")));

  for (const item of items) {
    assert.ok(fs.existsSync(path.join(rootDir, "dist", item.path)), item.path);
  }
});

test("dist exposes the likely LCP thumbnail preload in HTML", () => {
  const html = fs.readFileSync(path.join(rootDir, "dist", "index.html"), "utf8");
  const firstItem = manifest.items
    .slice()
    .sort((a, b) => b.tier - a.tier || a.title.localeCompare(b.title))[0];
  const largestAvif = firstItem.image.thumbnails.avif.at(-1);

  assert.ok(largestAvif, "first card has an AVIF thumbnail");
  assert.match(html, /rel="preload"/);
  assert.match(html, /fetchpriority="high"/);
  assert.ok(html.includes(`/jules-toys/${largestAvif.path}`));
  assert.ok(html.includes("imagesrcset="));
});
