import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildSearchText, loadGalleryItems } from "./gallery-data-loader.mjs";
import { loadSpecimenLab } from "./specimen-lab-data.mjs";

const rootDir = process.cwd();
const generatedDir = path.join(rootDir, ".generated");
const publicGeneratedDir = path.join(rootDir, "public", "generated");
const thumbWidths = [480, 960];
const previewWidth = 1280;
const generationConcurrency = getGenerationConcurrency();

await fs.mkdir(generatedDir, { recursive: true });
await fs.mkdir(publicGeneratedDir, { recursive: true });

const sourceItems = loadGalleryItems(rootDir);
const tierCounts = {};
const generatedItems = [];
let originalScreenshotBytes = 0;
let thumbWebpBytes = 0;

const processedItems = await mapLimit(sourceItems, generationConcurrency, processItem);

for (const { item, sourceBytes, thumbWebpBytes: itemThumbWebpBytes } of processedItems) {
  tierCounts[item.tier] = (tierCounts[item.tier] || 0) + 1;
  originalScreenshotBytes += sourceBytes;
  thumbWebpBytes += itemThumbWebpBytes;
  generatedItems.push(item);
}

async function processItem(item) {
  const screenshotPath = path.join(rootDir, item.screenshot);
  const sourceStats = await fs.stat(screenshotPath);
  const metadata = await sharp(screenshotPath).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error(`Unable to read image dimensions for ${item.screenshot}`);
  }

  let itemThumbWebpBytes = 0;
  const fileStem = `${String(item.tier).padStart(2, "0")}-${safeFileName(item.slug)}`;
  const thumbnails = {
    avif: [],
    webp: []
  };

  for (const width of thumbWidths) {
    thumbnails.avif.push(await writeVariant(screenshotPath, fileStem, "thumb", width, "avif"));
    const webpVariant = await writeVariant(screenshotPath, fileStem, "thumb", width, "webp");
    thumbnails.webp.push(webpVariant);
    if (width === 480) itemThumbWebpBytes += webpVariant.bytes;
  }

  const preview = {
    avif: [await writeVariant(screenshotPath, fileStem, "preview", previewWidth, "avif")],
    webp: [await writeVariant(screenshotPath, fileStem, "preview", previewWidth, "webp")]
  };

  return {
    item: {
      ...item,
      searchText: buildSearchText(item),
      image: {
        width: metadata.width,
        height: metadata.height,
        sourceBytes: sourceStats.size,
        thumbnails,
        preview
      }
    },
    sourceBytes: sourceStats.size,
    thumbWebpBytes: itemThumbWebpBytes
  };
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));

  return results;
}

const generatedAt = new Date().toISOString();
const tierMin = Math.min(...sourceItems.map((item) => item.tier));
const tierMax = Math.max(...sourceItems.map((item) => item.tier));
const manifest = {
  generatedAt,
  chunkSize: 48,
  cardSizes: "(max-width: 760px) calc(100vw - 32px), (max-width: 1100px) calc((100vw - 64px) / 3), 296px",
  stats: {
    total: sourceItems.length,
    tierMin,
    tierMax,
    originalScreenshotBytes,
    thumbWebpBytes
  },
  tierCounts,
  items: generatedItems,
  specimenLab: loadSpecimenLab(rootDir)
};

await fs.writeFile(
  path.join(generatedDir, "gallery-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);

await fs.writeFile(
  path.join(generatedDir, "gallery-manifest.ts"),
  [
    "export type ImageVariant = { path: string; width: number; height: number; bytes: number };",
    "export type SpecimenPlaytest = { trace_status: string | null; mechanical_status: string | null; load_status: string | null; action_status: string | null; action_type: string | null; state_changed: boolean | null; state_change_reasons: string[]; feedback_observed: boolean; candidate_control_count: number; initial_screenshot: string | null; after_screenshot: string | null; model_review_status: string | null; model_review_provider: string | null; model_review_model: string | null; model_review_recommendation: string | null } | null;",
    "export type SpecimenRun = { run_id: number | null; run_attempt: number | null; run_url: string | null; event_name: string | null; head_sha: string | null; generated_at: string | null; mechanical_pass: boolean; score: number | null; recommendation: string | null; label: string; status: string; artifact_name: string; pr_comment_url: string | null; issue_comment_url: string | null; known_gaps: string[]; playtest?: SpecimenPlaytest };",
    "export type SpecimenRecord = { id: string; title: string; slug: string; tier: number | null; kind: string; status: string; score: number | null; recommendation: string; issue: { number: number | null; url: string | null }; pr: { number: number; url: string | null; title: string | null; head_ref: string | null; base_ref: string | null; head_sha: string | null }; workflow: Record<string, unknown>; artifact: { name: string; workflow_run_url: string | null; contains: string[] }; scorecard: { marker: string; pr_comment_url: string | null; issue_comment_url: string | null; updated_at: string }; screenshot: { path: string; source: string; artifact_file: string }; playtest?: SpecimenPlaytest; known_gaps: string[]; comparison: { run_count: number; previous_score: number | null; score_delta: number | null; mechanical_pass: boolean; latest_label: string; previous_run_id: number | null; summary: string }; provenance: { source: string; repository: string; free_model: string; report_version: number; report_generated_at: string; persisted_at: string; generated_from: string }; reruns: SpecimenRun[] };",
    "export type SpecimenLab = { schema_version: 1; generated_at: string | null; specimens: SpecimenRecord[] };",
    "export type GalleryItem = {",
    "  tier: number;",
    "  title: string;",
    "  slug: string;",
    "  path: string;",
    "  screenshot: string;",
    "  kind: string;",
    "  tags: string[];",
    "  oneLine: string;",
    "  searchText: string;",
    "  image: {",
    "    width: number;",
    "    height: number;",
    "    sourceBytes: number;",
    "    thumbnails: { avif: ImageVariant[]; webp: ImageVariant[] };",
    "    preview: { avif: ImageVariant[]; webp: ImageVariant[] };",
    "  };",
    "};",
    "export type GalleryManifest = {",
    "  generatedAt: string;",
    "  chunkSize: number;",
    "  cardSizes: string;",
    "  stats: { total: number; tierMin: number; tierMax: number; originalScreenshotBytes: number; thumbWebpBytes: number };",
    "  tierCounts: Record<string, number>;",
    "  items: GalleryItem[];",
    "  specimenLab: SpecimenLab;",
    "};",
    `export const galleryManifest = ${JSON.stringify(manifest, null, 2)} as GalleryManifest;`,
    "export const galleryItems = galleryManifest.items;",
    "export const galleryStats = galleryManifest.stats;",
    "export const tierCounts = galleryManifest.tierCounts;",
    "export const specimenLab = galleryManifest.specimenLab;",
    ""
  ].join("\n")
);

console.log(`Generated ${generatedItems.length} gallery records.`);
console.log(`Image generation concurrency: ${generationConcurrency}.`);
console.log(`480w WebP thumbnails: ${formatBytes(thumbWebpBytes)} vs source screenshots: ${formatBytes(originalScreenshotBytes)}.`);

async function writeVariant(sourcePath, fileStem, sizeName, width, format) {
  const extension = format === "avif" ? "avif" : "webp";
  const outputName = `${fileStem}-${sizeName}-${width}.${extension}`;
  const outputPath = path.join(publicGeneratedDir, outputName);
  const image = sharp(sourcePath).resize({ width, withoutEnlargement: true });
  const pipeline = format === "avif"
    ? image.avif({ quality: sizeName === "thumb" ? 48 : 54, effort: 3 })
    : image.webp({ quality: sizeName === "thumb" ? 72 : 78, effort: 4 });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  await fs.writeFile(outputPath, data);

  return {
    path: `generated/${outputName}`,
    width: info.width,
    height: info.height,
    bytes: data.length
  };
}

function safeFileName(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function getGenerationConcurrency() {
  const envValue = Number.parseInt(process.env.GALLERY_IMAGE_CONCURRENCY || "", 10);
  if (Number.isFinite(envValue) && envValue > 0) return envValue;

  const available = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;

  return Math.max(2, Math.min(4, available));
}
