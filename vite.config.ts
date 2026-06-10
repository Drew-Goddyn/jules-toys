import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import fs from "node:fs";
import path from "node:path";

const basePath = "/jules-toys/";

export default defineConfig({
  base: basePath,
  plugins: [svelte(), galleryLcpPreload()],
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});

type ImageVariant = { path: string; width: number };
type GalleryManifest = {
  cardSizes: string;
  items: Array<{
    tier: number;
    title: string;
    image: {
      thumbnails: {
        avif: ImageVariant[];
      };
    };
  }>;
};

function galleryLcpPreload() {
  return {
    name: "gallery-lcp-preload",
    transformIndexHtml(html: string) {
      const preload = buildLcpPreload();
      if (!preload) return html;
      return html.replace("    <title>", `${preload}\n    <title>`);
    }
  };
}

function buildLcpPreload() {
  const manifestPath = path.resolve(".generated", "gallery-manifest.json");
  if (!fs.existsSync(manifestPath)) return "";

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as GalleryManifest;
  const firstItem = manifest.items
    .slice()
    .sort((a, b) => b.tier - a.tier || a.title.localeCompare(b.title))[0];

  if (!firstItem) return "";

  const avifVariants = firstItem.image.thumbnails.avif;
  const largestVariant = avifVariants[avifVariants.length - 1];

  return [
    "    <link",
    "      rel=\"preload\"",
    "      as=\"image\"",
    "      type=\"image/avif\"",
    `      href="${escapeAttribute(assetUrl(largestVariant.path))}"`,
    `      imagesrcset="${escapeAttribute(srcset(avifVariants))}"`,
    `      imagesizes="${escapeAttribute(manifest.cardSizes)}"`,
    "      fetchpriority=\"high\"",
    "    />"
  ].join("\n");
}

function assetUrl(filePath: string) {
  return `${basePath}${filePath}`;
}

function srcset(variants: ImageVariant[]) {
  return variants.map((variant) => `${assetUrl(variant.path)} ${variant.width}w`).join(", ");
}

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
