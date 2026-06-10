import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const requiredFields = ["tier", "title", "slug", "path", "screenshot", "kind", "tags", "oneLine"];

export function loadGalleryItems(rootDir = process.cwd()) {
  const dataPath = path.join(rootDir, "gallery-data.js");
  const source = fs.readFileSync(dataPath, "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: dataPath });
  const items = sandbox.window.galleryItems;

  if (!Array.isArray(items)) {
    throw new Error("gallery-data.js must assign window.galleryItems to an array.");
  }

  const seenSlugs = new Set();
  const normalized = items.map((item, index) => {
    validateItem(item, index, rootDir, seenSlugs);
    return {
      tier: item.tier,
      title: item.title,
      slug: item.slug,
      path: item.path,
      screenshot: item.screenshot,
      kind: item.kind,
      tags: [...item.tags],
      oneLine: item.oneLine
    };
  });

  return normalized;
}

function validateItem(item, index, rootDir, seenSlugs) {
  if (!item || typeof item !== "object") {
    throw new Error(`Gallery item ${index} must be an object.`);
  }

  for (const field of requiredFields) {
    if (item[field] === undefined || item[field] === null) {
      throw new Error(`Gallery item ${index} is missing ${field}.`);
    }
  }

  if (!Number.isFinite(item.tier)) {
    throw new Error(`Gallery item ${index} has an invalid tier.`);
  }

  for (const field of ["title", "slug", "path", "screenshot", "kind", "oneLine"]) {
    if (typeof item[field] !== "string" || !item[field].trim()) {
      throw new Error(`Gallery item ${index} has an invalid ${field}.`);
    }
  }

  if (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== "string" || !tag.trim())) {
    throw new Error(`Gallery item ${index} has invalid tags.`);
  }

  const slugKey = `${item.tier}:${item.slug}`;
  if (seenSlugs.has(slugKey)) {
    throw new Error(`Duplicate gallery slug within tier: ${slugKey}.`);
  }
  seenSlugs.add(slugKey);

  assertSafeRelativePath(item.path, `item ${index} path`);
  assertSafeRelativePath(item.screenshot, `item ${index} screenshot`);

  for (const field of ["path", "screenshot"]) {
    const filePath = path.join(rootDir, item[field]);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Gallery item ${index} ${field} does not exist: ${item[field]}`);
    }
  }
}

export function assertSafeRelativePath(value, label) {
  if (path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} must be a safe relative path.`);
  }

  const normalized = path.normalize(value);
  if (normalized.startsWith("..") || normalized.includes(`${path.sep}..${path.sep}`)) {
    throw new Error(`${label} must not escape the repository root.`);
  }
}

export function tierName(tier) {
  return `T${tier}`;
}

export function buildSearchText(item) {
  return [
    item.tier,
    tierName(item.tier),
    item.title,
    item.slug,
    item.kind,
    item.path,
    item.oneLine,
    ...item.tags
  ].join(" ").toLowerCase();
}
