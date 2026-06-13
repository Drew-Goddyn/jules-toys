#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { loadGalleryItems } from "./gallery-data-loader.mjs";
import { loadSpecimenLab, specimenDataPath } from "./specimen-lab-data.mjs";

const rootDir = path.resolve(process.cwd());
const args = parseArgs(process.argv.slice(2));
const outputDir = path.resolve(args.outputDir ?? ".pullfrog-evaluation");
const reportPath = path.resolve(args.report ?? path.join(outputDir, "report.json"));
const lineageRootDir = path.resolve(args.lineageRoot ?? process.env.PULLFROG_SPECIMEN_LAB_ROOT ?? rootDir);
const metadata = readJson(args.metadata);
const prNumber = Number(args.prNumber ?? metadata?.number);
const issueNumber = Number(args.issueNumber ?? inferIssueNumber(metadata));
const testOutcome = normalizeOutcome(args.testOutcome);

if (!Number.isInteger(prNumber) || prNumber <= 0) {
  throw new Error("A positive --pr-number is required.");
}

fs.mkdirSync(outputDir, { recursive: true });

const changedFiles = getChangedFiles(metadata);
const toyDirs = findToyDirs(changedFiles);
const gallery = loadGallerySafely();
const candidate = selectCandidateToy(toyDirs, gallery.items);
const scope = evaluateChangedFileScope(changedFiles, toyDirs);
const registration = evaluateGalleryRegistration(candidate, gallery.error);
const screenshot = evaluateScreenshot(candidate?.item);
const network = evaluateExternalNetwork(candidate?.item);
const browserSmoke = await runBrowserSmoke(candidate?.item);
const specimenLab = loadSpecimenLabSafely(lineageRootDir);
const workflow = buildWorkflowMetadata();
const scorecardMarker = `<!-- pullfrog-experiment-evaluator:v2 pr=${prNumber} issue=${Number.isInteger(issueNumber) && issueNumber > 0 ? issueNumber : "unknown"} -->`;
const lineage = buildLineage(prNumber, specimenLab, workflow, scorecardMarker, lineageRootDir);
const mechanicalPass = [
  testOutcome.status === "pass",
  scope.status === "pass",
  registration.status === "pass",
  screenshot.status === "pass",
  network.status === "pass",
  browserSmoke.status !== "fail"
].every(Boolean);

const report = {
  version: 2,
  generated_at: new Date().toISOString(),
  repository: process.env.GITHUB_REPOSITORY ?? "Drew-Goddyn/jules-toys",
  workflow,
  lineage,
  pr: {
    number: prNumber,
    url: metadata?.url ?? `https://github.com/Drew-Goddyn/jules-toys/pull/${prNumber}`,
    title: metadata?.title ?? null,
    head_ref: metadata?.headRefName ?? null,
    base_ref: metadata?.baseRefName ?? null,
    head_sha: metadata?.headRefOid ?? null
  },
  issue: {
    number: Number.isInteger(issueNumber) && issueNumber > 0 ? issueNumber : null,
    url: Number.isInteger(issueNumber) && issueNumber > 0
      ? `https://github.com/Drew-Goddyn/jules-toys/issues/${issueNumber}`
      : null
  },
  deterministic: {
    ci_test_result: testOutcome,
    changed_file_scope: scope,
    gallery_registration: registration,
    screenshot_presence: screenshot,
    external_network_dependency: network,
    browser_smoke: browserSmoke
  },
  recommendation: {
    mechanical_pass: mechanicalPass,
    deterministic_label: mechanicalPass ? "experiment:accepted" : "experiment:failed",
    known_gaps: collectKnownGaps(scope, registration, screenshot, network, browserSmoke, testOutcome)
  }
};

fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote Pullfrog experiment evaluation report to ${path.relative(rootDir, reportPath)}`);
console.log(`Mechanical result: ${mechanicalPass ? "pass" : "fail"}`);

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = "true";
    } else {
      parsed[key] = next;
      index += 1;
    }
  }

  return parsed;
}

function readJson(filePath) {
  if (!filePath) {
    return null;
  }

  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function normalizeOutcome(value) {
  const raw = String(value ?? "unknown").toLowerCase();
  if (["success", "passed", "pass"].includes(raw)) {
    return { status: "pass", raw };
  }

  if (["failure", "failed", "fail", "cancelled", "timed_out"].includes(raw)) {
    return { status: "fail", raw };
  }

  return { status: "unknown", raw };
}

function inferIssueNumber(prMetadata) {
  const body = prMetadata?.body;
  if (typeof body !== "string") {
    return null;
  }

  const match = body.match(/(?:issues\/|#)(\d+)/i);
  return match ? Number(match[1]) : null;
}

function getChangedFiles(prMetadata) {
  const files = prMetadata?.files;
  if (Array.isArray(files) && files.length > 0) {
    return files.map((file) => typeof file === "string" ? file : file.path).filter(Boolean);
  }

  const result = spawnSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
    cwd: rootDir,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    return [];
  }

  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function findToyDirs(files) {
  const dirs = new Set();

  for (const file of files) {
    const match = file.match(/^(tier\d+\/[^/]+)\/(?:index\.html|screenshot\.png)$/);
    if (match) {
      dirs.add(match[1]);
    }
  }

  return [...dirs].sort();
}

function loadGallerySafely() {
  try {
    return { items: loadGalleryItems(rootDir), error: null };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function loadSpecimenLabSafely(sourceRoot) {
  try {
    return loadSpecimenLab(sourceRoot);
  } catch (error) {
    return {
      ...emptyLineageSource(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function emptyLineageSource() {
  return {
    schema_version: 1,
    generated_at: null,
    specimens: []
  };
}

function buildWorkflowMetadata() {
  const repository = process.env.GITHUB_REPOSITORY ?? "Drew-Goddyn/jules-toys";
  const runId = parsePositiveInteger(process.env.GITHUB_RUN_ID);
  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";

  return {
    run_id: runId,
    run_attempt: parsePositiveInteger(process.env.GITHUB_RUN_ATTEMPT),
    run_url: runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : null,
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    event_name: process.env.GITHUB_EVENT_NAME ?? null,
    actor: process.env.GITHUB_ACTOR ?? null,
    ref: process.env.GITHUB_REF_NAME ?? process.env.GITHUB_REF ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    artifact_name: `pullfrog-experiment-evaluation-${prNumber}`
  };
}

function buildLineage(prNumber, specimenLab, workflow, scorecardMarker, sourceRoot) {
  const previousSpecimen = specimenLab.specimens?.find((specimen) => specimen.pr?.number === prNumber);
  const previousRuns = (previousSpecimen?.reruns ?? [])
    .filter((run) => String(run.run_id) !== String(workflow.run_id))
    .map((run) => ({
      run_id: run.run_id ?? null,
      run_attempt: run.run_attempt ?? null,
      run_url: run.run_url ?? null,
      generated_at: run.generated_at ?? null,
      head_sha: run.head_sha ?? null,
      score: run.score ?? null,
      label: run.label ?? null,
      status: run.status ?? null
    }));
  const priorRun = previousRuns.at(-1) ?? null;

  return {
    canonical_key: `pullfrog-pr-${prNumber}`,
    specimen_data_path: specimenDataPath,
    specimen_data_source: {
      root: path.relative(rootDir, sourceRoot) || ".",
      generated_at: specimenLab.generated_at ?? null,
      error: specimenLab.error ?? null
    },
    scorecard_marker: scorecardMarker,
    run_sequence: previousRuns.length + 1,
    previous_run_count: previousRuns.length,
    rerun_of_run_id: priorRun?.run_id ?? null,
    previous_runs: previousRuns
  };
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function selectCandidateToy(dirs, items) {
  if (dirs.length !== 1) {
    return null;
  }

  const dir = dirs[0];
  const item = items.find((galleryItem) => galleryItem.path === `${dir}/index.html`);
  return { dir, item: item ?? null };
}

function evaluateChangedFileScope(files, dirs) {
  const allowedFilePattern = /^(?:gallery-data\.js|tier\d+\/[^/]+\/(?:index\.html|screenshot\.png))$/;
  const packageChanges = files.filter((file) => /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file));
  const unexpected = files.filter((file) => !allowedFilePattern.test(file));
  const status = files.length > 0 && dirs.length === 1 && unexpected.length === 0 && packageChanges.length === 0
    ? "pass"
    : "fail";

  return {
    status,
    changed_files: files,
    toy_directories: dirs,
    unexpected_files: unexpected,
    package_dependency_changes: packageChanges
  };
}

function evaluateGalleryRegistration(candidate, galleryError) {
  if (galleryError) {
    return {
      status: "fail",
      registered: false,
      reason: galleryError
    };
  }

  if (!candidate?.dir) {
    return {
      status: "fail",
      registered: false,
      reason: "Expected exactly one changed toy directory."
    };
  }

  if (!candidate.item) {
    return {
      status: "fail",
      registered: false,
      reason: `No gallery-data.js entry points at ${candidate.dir}/index.html.`
    };
  }

  const expectedScreenshot = `${candidate.dir}/screenshot.png`;
  const screenshotMatches = candidate.item.screenshot === expectedScreenshot;

  return {
    status: screenshotMatches ? "pass" : "fail",
    registered: true,
    title: candidate.item.title,
    tier: candidate.item.tier,
    slug: candidate.item.slug,
    path: candidate.item.path,
    screenshot: candidate.item.screenshot,
    reason: screenshotMatches ? null : `Gallery screenshot should be ${expectedScreenshot}.`
  };
}

function evaluateScreenshot(item) {
  if (!item) {
    return {
      status: "fail",
      path: null,
      reason: "No registered gallery item found."
    };
  }

  const screenshotPath = path.join(rootDir, item.screenshot);
  const exists = fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).isFile();
  const bytes = exists ? fs.statSync(screenshotPath).size : 0;
  const signature = exists ? fs.readFileSync(screenshotPath, { start: 0, end: 7 }) : Buffer.alloc(0);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const isPng = signature.length >= 8 && signature.subarray(0, 8).equals(pngSignature);

  return {
    status: exists && isPng && bytes > 0 ? "pass" : "fail",
    path: item.screenshot,
    exists,
    is_png: isPng,
    bytes,
    reason: exists && isPng && bytes > 0 ? null : "Screenshot must exist and be a non-empty PNG."
  };
}

function evaluateExternalNetwork(item) {
  if (!item) {
    return {
      status: "fail",
      references: [],
      dynamic_apis: [],
      reason: "No registered gallery item found."
    };
  }

  const htmlPath = path.join(rootDir, item.path);
  const html = fs.readFileSync(htmlPath, "utf8");
  const references = [...new Set(html.match(/\b(?:https?:)?\/\/[^\s"'<>`)]+/g) ?? [])]
    .filter((url) => !/^https?:\/\/(?:www\.)?w3\.org\//i.test(url));
  const dynamicApis = [
    ["fetch", /\bfetch\s*\(/],
    ["XMLHttpRequest", /\bXMLHttpRequest\b/],
    ["WebSocket", /\bWebSocket\s*\(/],
    ["EventSource", /\bEventSource\s*\(/],
    ["sendBeacon", /\bsendBeacon\s*\(/]
  ].filter(([, pattern]) => pattern.test(html)).map(([name]) => name);

  return {
    status: references.length === 0 && dynamicApis.length === 0 ? "pass" : "fail",
    references,
    dynamic_apis: dynamicApis,
    reason: references.length === 0 && dynamicApis.length === 0
      ? null
      : "Toy appears to reference external network resources or browser network APIs."
  };
}

async function runBrowserSmoke(item) {
  if (args.browserSmoke === "false") {
    return {
      status: "skipped",
      reason: "Browser smoke disabled by --browser-smoke false."
    };
  }

  if (!item) {
    return {
      status: "skipped",
      reason: "No registered gallery item found."
    };
  }

  const distDir = path.join(rootDir, "dist");
  if (!fs.existsSync(path.join(distDir, item.path))) {
    return {
      status: "skipped",
      reason: "Built dist toy route was not found. Run npm test or npm run build first."
    };
  }

  const chromePath = findChrome();
  if (!chromePath) {
    return {
      status: "skipped",
      reason: "No Chrome or Chromium executable found."
    };
  }

  const server = http.createServer((request, response) => {
    serveStaticFile(distDir, request, response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/${item.path}`;
  const screenshotPath = path.join(outputDir, "browser-smoke.png");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pullfrog-eval-chrome-"));

  const result = await runChrome(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--hide-scrollbars",
    "--run-all-compositor-stages-before-draw",
    "--window-size=1280,900",
    `--user-data-dir=${userDataDir}`,
    `--screenshot=${screenshotPath}`,
    url
  ], 25000);

  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const screenshotExists = fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).size > 0;
  const screenshotAnalysis = screenshotExists
    ? await analyzeScreenshot(screenshotPath)
    : { status: "fail", nonblank: false, reason: "Chrome did not write a screenshot." };
  const chromeCompleted = result.status === 0 || (result.timed_out && screenshotExists);
  const passed = chromeCompleted && screenshotExists && screenshotAnalysis.nonblank;

  return {
    status: passed ? "pass" : "fail",
    url,
    screenshot: path.relative(rootDir, screenshotPath),
    chrome: chromePath,
    exit_code: result.status,
    timed_out_after_screenshot: result.timed_out && screenshotExists,
    screenshot_analysis: screenshotAnalysis,
    stderr_tail: trimTail(result.stderr),
    reason: passed ? null : "Headless browser smoke did not produce a nonblank rendered screenshot."
  };
}

function runChrome(chromePath, chromeArgs, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(chromePath, chromeArgs, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 2000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      resolve({
        status: null,
        signal: null,
        timed_out: timedOut,
        error: error.message,
        stdout,
        stderr
      });
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      resolve({
        status: code,
        signal,
        timed_out: timedOut,
        error: null,
        stdout,
        stderr
      });
    });
  });
}

async function analyzeScreenshot(screenshotPath) {
  try {
    const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
    const { default: sharp } = await import(requireFromRoot.resolve("sharp"));
    const stats = await sharp(screenshotPath).stats();
    const channels = stats.channels.slice(0, 3).map((channel) => ({
      min: channel.min,
      max: channel.max,
      mean: round(channel.mean),
      stdev: round(channel.stdev)
    }));
    const maxStdev = Math.max(...channels.map((channel) => channel.stdev));
    const tonalRange = Math.max(...channels.map((channel) => channel.max - channel.min));
    const nonblank = maxStdev >= 3 || tonalRange >= 16;

    return {
      status: nonblank ? "pass" : "fail",
      nonblank,
      max_stdev: round(maxStdev),
      tonal_range: tonalRange,
      channels
    };
  } catch (error) {
    return {
      status: "fail",
      nonblank: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && fs.existsSync(candidate)) {
      return candidate;
    }

    const result = spawnSync("sh", ["-c", "command -v \"$1\"", "sh", candidate], {
      encoding: "utf8"
    });
    const resolved = result.stdout.trim();
    if (result.status === 0 && resolved) {
      return resolved;
    }
  }

  return null;
}

function serveStaticFile(distDir, request, response) {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const decodedPath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
  const relativePath = decodedPath.endsWith("/") ? `${decodedPath}index.html` : decodedPath;
  const normalized = path.normalize(relativePath);

  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  const filePath = path.join(distDir, normalized || "index.html");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404).end("Not found");
    return;
  }

  response.writeHead(200, { "content-type": contentType(filePath) });
  fs.createReadStream(filePath).pipe(response);
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".svg": "image/svg+xml"
  }[ext] ?? "application/octet-stream";
}

function trimTail(text) {
  if (!text) {
    return "";
  }

  return text.split(/\r?\n/).slice(-8).join("\n").trim();
}

function collectKnownGaps(scope, registration, screenshot, network, browserSmoke, testResult) {
  const gaps = [];

  for (const [label, check] of [
    ["CI/test", testResult],
    ["changed-file scope", scope],
    ["gallery registration", registration],
    ["screenshot", screenshot],
    ["external network/dependency", network],
    ["browser smoke", browserSmoke]
  ]) {
    if (check.status === "fail") {
      gaps.push(`${label} failed${check.reason ? `: ${check.reason}` : ""}`);
    } else if (check.status === "skipped") {
      gaps.push(`${label} skipped${check.reason ? `: ${check.reason}` : ""}`);
    }
  }

  return gaps;
}
