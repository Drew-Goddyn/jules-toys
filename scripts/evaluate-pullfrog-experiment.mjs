#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import net from "node:net";
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
const modelPlaytestPromptVersion = "pullfrog-playtest-review-v1";
const nvidiaDefaultEndpoint = "https://integrate.api.nvidia.com/v1/chat/completions";
const nvidiaPendingPollAttempts = 5;
const nvidiaPendingPollDelayMs = 1000;
const modelPlaytestReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "goal_guess",
    "first_action_guess",
    "first_action_confidence",
    "observed_feedback",
    "stuck_reason",
    "clarity_score",
    "interaction_confidence",
    "known_gaps",
    "recommendation"
  ],
  properties: {
    goal_guess: { type: "string" },
    first_action_guess: { type: "string" },
    first_action_confidence: { type: "number", minimum: 0, maximum: 1 },
    observed_feedback: { type: "string" },
    stuck_reason: { type: ["string", "null"] },
    clarity_score: { type: "integer", minimum: 1, maximum: 5 },
    interaction_confidence: { type: "number", minimum: 0, maximum: 1 },
    known_gaps: { type: "array", items: { type: "string" } },
    recommendation: {
      type: "string",
      enum: ["accept", "needs-human-review", "reject"]
    }
  }
};

async function main() {
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
  const playtestTrace = await runBrowserPlaytest(candidate?.item);
  const modelPlaytestReview = await runModelPlaytestReview(playtestTrace);
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
    browserSmoke.status !== "fail",
    playtestTrace.mechanical_status !== "fail"
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
      browser_smoke: browserSmoke,
      playtest_trace: playtestTrace
    },
    model_playtest_review: modelPlaytestReview,
    recommendation: {
      mechanical_pass: mechanicalPass,
      deterministic_label: mechanicalPass ? "experiment:accepted" : "experiment:failed",
      known_gaps: collectKnownGaps(scope, registration, screenshot, network, browserSmoke, playtestTrace, modelPlaytestReview, testOutcome)
    }
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote Pullfrog experiment evaluation report to ${path.relative(rootDir, reportPath)}`);
  console.log(`Mechanical result: ${mechanicalPass ? "pass" : "fail"}`);
}

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

async function runBrowserPlaytest(item) {
  if (args.browserSmoke === "false") {
    return skippedPlaytestTrace("Browser playtest disabled by --browser-smoke false.");
  }

  if (!item) {
    return skippedPlaytestTrace("No registered gallery item found.");
  }

  const distDir = path.join(rootDir, "dist");
  if (!fs.existsSync(path.join(distDir, item.path))) {
    return skippedPlaytestTrace("Built dist toy route was not found. Run npm test or npm run build first.");
  }

  const chromePath = findChrome();
  if (!chromePath) {
    return skippedPlaytestTrace("No Chrome or Chromium executable found.");
  }

  const server = http.createServer((request, response) => {
    serveStaticFile(distDir, request, response);
  });
  let cdp = null;
  let chrome = null;
  let userDataDir = null;

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/${item.path}`;
    const debugPort = await reserveLocalPort();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pullfrog-playtest-chrome-"));
    chrome = spawn(chromePath, [
      "--headless=new",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--hide-scrollbars",
      "--run-all-compositor-stages-before-draw",
      "--window-size=1280,900",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      "about:blank"
    ], {
      stdio: "ignore"
    });

    const page = await waitForDebugPage(debugPort, 12000);
    cdp = await DevToolsConnection.connect(page.webSocketDebuggerUrl);
    const observed = captureBrowserObservations(cdp);

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");

    const navigateResult = await cdp.send("Page.navigate", { url });
    const loadStatus = await waitForPageLoad(cdp, navigateResult, 12000);
    const beforeState = await snapshotPageState(cdp);
    const initialScreenshotPath = path.join(outputDir, "playtest-initial.png");
    await captureDevToolsScreenshot(cdp, initialScreenshotPath);
    const beforeScreenshotHash = hashFile(initialScreenshotPath);
    const initialScreenshotAnalysis = await analyzeScreenshot(initialScreenshotPath);
    const action = choosePlaytestAction(beforeState);
    const attemptedInteraction = await performPlaytestAction(cdp, action);

    if (attemptedInteraction.status === "attempted") {
      await delay(900);
    }

    const afterState = await snapshotPageState(cdp);
    const afterScreenshotPath = path.join(outputDir, "playtest-after-interaction.png");
    await captureDevToolsScreenshot(cdp, afterScreenshotPath);
    const afterScreenshotHash = hashFile(afterScreenshotPath);
    const afterScreenshotAnalysis = await analyzeScreenshot(afterScreenshotPath);
    const stateChange = summarizeStateChange(beforeState, afterState, beforeScreenshotHash, afterScreenshotHash);
    const feedback = detectFeedback(beforeState.text_sample, afterState.text_sample);
    const mechanicalStatus = determinePlaytestMechanicalStatus({
      loadStatus,
      observed,
      initialScreenshotAnalysis,
      attemptedInteraction,
      stateChange,
      feedback
    });

    return {
      status: mechanicalStatus === "fail" ? "fail" : "completed",
      load_status: loadStatus,
      console_errors: observed.console_errors,
      page_errors: observed.page_errors,
      initial_screenshot: path.relative(rootDir, initialScreenshotPath),
      candidate_actionable_controls: beforeState.controls,
      attempted_interactions: [attemptedInteraction],
      before_evidence: {
        url: beforeState.url,
        title: beforeState.title,
        text_hash: beforeState.text_hash,
        text_sample: beforeState.text_sample,
        control_count: beforeState.controls.length,
        canvas_count: beforeState.canvases.length,
        screenshot: path.relative(rootDir, initialScreenshotPath),
        screenshot_analysis: initialScreenshotAnalysis
      },
      after_evidence: {
        url: afterState.url,
        title: afterState.title,
        text_hash: afterState.text_hash,
        text_sample: afterState.text_sample,
        control_count: afterState.controls.length,
        canvas_count: afterState.canvases.length,
        screenshot: path.relative(rootDir, afterScreenshotPath),
        screenshot_analysis: afterScreenshotAnalysis
      },
      state_changed: stateChange.changed,
      state_change_reasons: stateChange.reasons,
      feedback_observed: feedback,
      mechanical_status: mechanicalStatus,
      reason: playtestReason(mechanicalStatus, attemptedInteraction, stateChange, feedback)
    };
  } catch (error) {
    return erroredPlaytestTrace(error);
  } finally {
    if (cdp) {
      cdp.close();
    }
    if (chrome && chrome.exitCode === null) {
      chrome.kill("SIGTERM");
      await waitForChildExit(chrome, 2000);
    }
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (userDataDir) {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

function skippedPlaytestTrace(reason) {
  return {
    status: "skipped",
    load_status: { status: "skipped", reason },
    console_errors: [],
    page_errors: [],
    initial_screenshot: null,
    candidate_actionable_controls: [],
    attempted_interactions: [{ type: "none", status: "skipped", reason }],
    before_evidence: null,
    after_evidence: null,
    state_changed: null,
    state_change_reasons: [],
    feedback_observed: {
      success_failure_progress: false,
      keywords: [],
      reason: "No interaction was attempted."
    },
    mechanical_status: "skipped",
    reason
  };
}

function erroredPlaytestTrace(error) {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    status: "error",
    load_status: { status: "unknown", reason },
    console_errors: [],
    page_errors: [{ message: reason }],
    initial_screenshot: null,
    candidate_actionable_controls: [],
    attempted_interactions: [{ type: "none", status: "error", reason }],
    before_evidence: null,
    after_evidence: null,
    state_changed: null,
    state_change_reasons: [],
    feedback_observed: {
      success_failure_progress: false,
      keywords: [],
      reason: "The browser harness errored before interaction."
    },
    mechanical_status: "inconclusive",
    reason
  };
}

function captureBrowserObservations(cdp) {
  const observed = {
    console_errors: [],
    page_errors: []
  };

  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (!["error", "assert"].includes(params.type)) {
      return;
    }
    observed.console_errors.push({
      type: params.type,
      text: (params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").filter(Boolean).join(" ").slice(0, 500)
    });
  });

  cdp.on("Runtime.exceptionThrown", (params) => {
    observed.page_errors.push({
      message: params.exceptionDetails?.text ?? params.exceptionDetails?.exception?.description ?? "Runtime exception",
      line: params.exceptionDetails?.lineNumber ?? null,
      column: params.exceptionDetails?.columnNumber ?? null
    });
  });

  cdp.on("Log.entryAdded", (params) => {
    const entry = params.entry ?? {};
    if (entry.level !== "error") {
      return;
    }
    observed.console_errors.push({
      type: entry.source ?? "log",
      text: String(entry.text ?? "").slice(0, 500),
      url: entry.url ?? null
    });
  });

  return observed;
}

async function waitForPageLoad(cdp, navigateResult, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let readyState = "unknown";

  while (Date.now() < deadline) {
    try {
      const result = await cdp.send("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true
      });
      readyState = result.result?.value ?? "unknown";
      if (readyState === "complete") {
        return {
          status: navigateResult.errorText ? "fail" : "pass",
          ready_state: readyState,
          navigation_error: navigateResult.errorText ?? null
        };
      }
    } catch {
      // Retry until Chrome has created the execution context for the navigated page.
    }
    await delay(100);
  }

  return {
    status: "fail",
    ready_state: readyState,
    navigation_error: navigateResult.errorText ?? "Timed out waiting for document.readyState=complete."
  };
}

async function snapshotPageState(cdp) {
  const expression = `(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
    };
    const labelFor = (element) => {
      const aria = element.getAttribute("aria-label");
      if (aria) return aria;
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        return labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" ").trim();
      }
      return "";
    };
    const controlSelector = "button,a[href],input,select,textarea,[role='button'],[role='link'],[tabindex],summary";
    const controls = Array.from(document.querySelectorAll(controlSelector))
      .filter(visible)
      .slice(0, 20)
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        return {
          index,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          type: element.getAttribute("type"),
          text: (element.innerText || element.value || labelFor(element) || element.title || "").replace(/\\s+/g, " ").trim().slice(0, 120),
          aria_label: element.getAttribute("aria-label"),
          disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
          href: element.href || null,
          center_x: Math.round(rect.left + rect.width / 2),
          center_y: Math.round(rect.top + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      });
    const canvases = Array.from(document.querySelectorAll("canvas"))
      .filter(visible)
      .slice(0, 5)
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        return {
          index,
          center_x: Math.round(rect.left + rect.width / 2),
          center_y: Math.round(rect.top + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      });
    const text = (document.body?.innerText ?? "").replace(/\\s+/g, " ").trim();
    return {
      url: location.href,
      title: document.title,
      ready_state: document.readyState,
      text_sample: text.slice(0, 2000),
      text_length: text.length,
      controls,
      canvases,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
  })()`;
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true
  });
  const value = result.result?.value ?? {};
  return {
    ...value,
    text_hash: hashText(value.text_sample ?? ""),
    controls: value.controls ?? [],
    canvases: value.canvases ?? []
  };
}

async function captureDevToolsScreenshot(cdp, filePath) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false
  });
  fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
}

function choosePlaytestAction(pageState) {
  const control = pageState.controls.find((candidate) => !candidate.disabled && Number.isFinite(candidate.center_x) && Number.isFinite(candidate.center_y));
  if (control) {
    return {
      type: "control-click",
      target: {
        index: control.index,
        tag: control.tag,
        role: control.role,
        type: control.type,
        text: control.text,
        aria_label: control.aria_label
      },
      x: control.center_x,
      y: control.center_y
    };
  }

  const canvas = pageState.canvases.find((candidate) => Number.isFinite(candidate.center_x) && Number.isFinite(candidate.center_y));
  if (canvas) {
    return {
      type: "canvas-center-click",
      target: canvas,
      x: canvas.center_x,
      y: canvas.center_y
    };
  }

  if (pageState.viewport) {
    return {
      type: "viewport-center-click",
      target: { width: pageState.viewport.width, height: pageState.viewport.height },
      x: Math.round(pageState.viewport.width / 2),
      y: Math.round(pageState.viewport.height / 2)
    };
  }

  return null;
}

async function performPlaytestAction(cdp, action) {
  if (!action) {
    return {
      type: "none",
      status: "skipped",
      reason: "No visible actionable control, canvas, or viewport target was available."
    };
  }

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: action.x,
    y: action.y,
    button: "none"
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: action.x,
    y: action.y,
    button: "left",
    clickCount: 1
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: action.x,
    y: action.y,
    button: "left",
    clickCount: 1
  });

  return {
    ...action,
    status: "attempted"
  };
}

function summarizeStateChange(beforeState, afterState, beforeScreenshotHash, afterScreenshotHash) {
  const reasons = [];
  if (beforeState.url !== afterState.url) {
    reasons.push("url_changed");
  }
  if (beforeState.title !== afterState.title) {
    reasons.push("title_changed");
  }
  if (beforeState.text_hash !== afterState.text_hash || beforeState.text_length !== afterState.text_length) {
    reasons.push("text_changed");
  }
  if (beforeState.controls.length !== afterState.controls.length) {
    reasons.push("control_count_changed");
  }
  if (beforeScreenshotHash !== afterScreenshotHash) {
    reasons.push("pixels_changed");
  }

  return {
    changed: reasons.length > 0,
    reasons
  };
}

function detectFeedback(beforeText, afterText) {
  const before = String(beforeText ?? "").toLowerCase();
  const after = String(afterText ?? "").toLowerCase();
  const keywords = [
    "success",
    "complete",
    "completed",
    "solved",
    "correct",
    "incorrect",
    "fail",
    "failed",
    "try again",
    "progress",
    "level",
    "score",
    "next",
    "win",
    "won"
  ].filter((keyword) => after.includes(keyword));
  const newKeywords = keywords.filter((keyword) => !before.includes(keyword));

  return {
    success_failure_progress: newKeywords.length > 0,
    keywords: newKeywords,
    reason: newKeywords.length > 0
      ? "Post-interaction text exposed success, failure, or progress language that was not present before the action."
      : "No new success, failure, or progress language was detected after the action."
  };
}

function determinePlaytestMechanicalStatus({ loadStatus, observed, initialScreenshotAnalysis, attemptedInteraction, stateChange, feedback }) {
  if (loadStatus.status === "fail" || initialScreenshotAnalysis.status === "fail" || observed.page_errors.length > 0) {
    return "fail";
  }

  if (attemptedInteraction.status !== "attempted") {
    return "inconclusive";
  }

  if (stateChange.changed || feedback.success_failure_progress) {
    return "pass";
  }

  return "inconclusive";
}

function playtestReason(mechanicalStatus, attemptedInteraction, stateChange, feedback) {
  if (mechanicalStatus === "pass") {
    return "The page loaded, an interaction was attempted, and deterministic evidence changed or exposed feedback.";
  }
  if (mechanicalStatus === "fail") {
    return "The browser playtest found a load, screenshot, or page-error failure.";
  }
  if (attemptedInteraction.status !== "attempted") {
    return attemptedInteraction.reason;
  }
  if (!stateChange.changed && !feedback.success_failure_progress) {
    return "The first attempted interaction produced no detected state change or success/failure/progress feedback.";
  }
  return "The browser playtest was inconclusive.";
}

async function reserveLocalPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForDebugPage(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const pages = await requestJson(`http://127.0.0.1:${port}/json`);
      const page = pages.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
      if (page) {
        return page;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for Chrome DevTools page${lastError ? `: ${lastError.message}` : ""}`);
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

async function runModelPlaytestReview(playtestTrace) {
  const config = resolveModelPlaytestConfig();

  if (!config.enabled) {
    return {
      status: "skipped",
      provider: config.provider,
      model: config.model,
      reason: "Model playtest review is disabled. Set --model-playtest true or PULLFROG_MODEL_PLAYTEST=true to enable it; legacy --gemini-playtest true remains supported."
    };
  }

  if (config.provider === "gemini") {
    return runGeminiPlaytestReview(playtestTrace, config);
  }

  if (config.provider === "nvidia") {
    return runNvidiaPlaytestReview(playtestTrace, config);
  }

  return {
    status: "failed",
    provider: config.provider,
    model: config.model,
    reason: `Unsupported model playtest provider: ${config.provider}.`
  };
}

function resolveModelPlaytestConfig() {
  const legacyGeminiEnabled = isFlagTrue(args.geminiPlaytest) || isFlagTrue(process.env.PULLFROG_GEMINI_PLAYTEST);
  const genericEnabled = isFlagTrue(args.modelPlaytest) || isFlagTrue(process.env.PULLFROG_MODEL_PLAYTEST);
  const provider = normalizeModelPlaytestProvider(firstNonEmpty(
    args.modelPlaytestProvider,
    process.env.PULLFROG_MODEL_PLAYTEST_PROVIDER,
    "gemini"
  ));

  return {
    enabled: genericEnabled || legacyGeminiEnabled,
    provider,
    model: resolveModelPlaytestModel(provider)
  };
}

function resolveModelPlaytestModel(provider) {
  if (provider === "nvidia") {
    return firstNonEmpty(
      args.modelPlaytestModel,
      process.env.PULLFROG_MODEL_PLAYTEST_MODEL,
      args.nvidiaModel,
      process.env.PULLFROG_NVIDIA_MODEL
    ) ?? null;
  }

  if (provider === "gemini") {
    return firstNonEmpty(
      args.modelPlaytestModel,
      process.env.PULLFROG_MODEL_PLAYTEST_MODEL,
      args.geminiModel,
      process.env.PULLFROG_GEMINI_MODEL,
      "gemini-3.5-flash"
    );
  }

  return firstNonEmpty(
    args.modelPlaytestModel,
    process.env.PULLFROG_MODEL_PLAYTEST_MODEL
  ) ?? null;
}

function normalizeModelPlaytestProvider(value) {
  return String(value ?? "gemini").trim().toLowerCase();
}

function isFlagTrue(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

async function runGeminiPlaytestReview(playtestTrace, config) {
  const apiKey = firstNonEmpty(args.geminiApiKey, process.env.GEMINI_API_KEY);
  if (!apiKey) {
    return {
      status: "skipped",
      provider: "gemini",
      model: config.model,
      reason: "GEMINI_API_KEY is not set."
    };
  }

  const endpoint = firstNonEmpty(
    args.geminiEndpoint,
    process.env.PULLFROG_GEMINI_ENDPOINT,
    `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`
  );

  try {
    const prompt = buildModelPlaytestPrompt(playtestTrace);
    const response = await requestJson(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          responseFormat: {
            text: {
              mimeType: "application/json",
              schema: modelPlaytestReviewSchema
            }
          }
        }
      }),
      timeoutMs: 30000
    });
    const text = extractGeminiText(response);
    const jsonText = normalizeModelPlaytestReviewJson(text, "Gemini");
    const parsed = JSON.parse(jsonText);
    validateModelPlaytestReview(parsed, "Gemini");

    return {
      status: "completed",
      provider: "gemini",
      model: config.model,
      prompt_version: modelPlaytestPromptVersion,
      schema: modelPlaytestPromptVersion,
      endpoint: redactEndpoint(endpoint),
      deterministic_authority: "deterministic.playtest_trace",
      sent_trace_status: playtestTrace.status,
      response: parsed,
      response_json_chars: jsonText.length,
      usage_metadata: sanitizeUsageMetadata(response.usageMetadata)
    };
  } catch (error) {
    return {
      status: "failed",
      provider: "gemini",
      model: config.model,
      prompt_version: modelPlaytestPromptVersion,
      schema: modelPlaytestPromptVersion,
      endpoint: redactEndpoint(endpoint),
      deterministic_authority: "deterministic.playtest_trace",
      sent_trace_status: playtestTrace.status,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runNvidiaPlaytestReview(playtestTrace, config) {
  if (!config.model) {
    return {
      status: "skipped",
      provider: "nvidia",
      model: null,
      reason: "NVIDIA playtest review requires --model-playtest-model, --nvidia-model, PULLFROG_MODEL_PLAYTEST_MODEL, or PULLFROG_NVIDIA_MODEL."
    };
  }

  const apiKey = firstNonEmpty(args.nvidiaApiKey, process.env.NVIDIA_API_KEY);
  if (!apiKey) {
    return {
      status: "skipped",
      provider: "nvidia",
      model: config.model,
      reason: "NVIDIA_API_KEY is not set."
    };
  }

  const endpoint = firstNonEmpty(
    args.nvidiaEndpoint,
    process.env.PULLFROG_NVIDIA_ENDPOINT,
    nvidiaDefaultEndpoint
  );
  const chatEndpoint = nvidiaChatEndpoint(endpoint);

  try {
    const prompt = buildModelPlaytestPrompt(playtestTrace);
    const response = await requestNvidiaChatCompletion(endpoint, apiKey, {
      model: config.model,
      messages: [
        {
          role: "system",
          content: "Return one raw JSON object only, with no Markdown fences, prose, comments, or trailing text. Match the requested schema exactly. Do not decide mechanical pass/fail."
        },
        { role: "user", content: prompt }
      ],
      temperature: 0,
      max_tokens: 1200,
      stream: false
    });
    const text = extractOpenAiCompatibleText(response);
    const jsonText = normalizeModelPlaytestReviewJson(text, "NVIDIA");
    const parsed = JSON.parse(jsonText);
    validateModelPlaytestReview(parsed, "NVIDIA");

    return {
      status: "completed",
      provider: "nvidia",
      model: config.model,
      prompt_version: modelPlaytestPromptVersion,
      schema: modelPlaytestPromptVersion,
      endpoint: redactEndpoint(chatEndpoint),
      deterministic_authority: "deterministic.playtest_trace",
      sent_trace_status: playtestTrace.status,
      response: parsed,
      response_json_chars: jsonText.length,
      usage_metadata: sanitizeOpenAiUsageMetadata(response?.usage)
    };
  } catch (error) {
    return {
      status: "failed",
      provider: "nvidia",
      model: config.model,
      prompt_version: modelPlaytestPromptVersion,
      schema: modelPlaytestPromptVersion,
      endpoint: redactEndpoint(chatEndpoint),
      deterministic_authority: "deterministic.playtest_trace",
      sent_trace_status: playtestTrace.status,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function buildModelPlaytestPrompt(playtestTrace) {
  return [
    "You are reviewing a Pullfrog toy playtest trace captured by a deterministic browser harness.",
    "You are not driving the browser and you are not the source of mechanical pass/fail.",
    "Base every answer only on the trace evidence. If evidence is missing or inconclusive, say so.",
    "Return one raw JSON object only. Do not wrap it in Markdown fences or add prose before or after it.",
    "The raw JSON object must match the supplied schema.",
    "",
    "Required JSON schema:",
    JSON.stringify(modelPlaytestReviewSchema, null, 2),
    "",
    "Trace:",
    JSON.stringify(compactTraceForModel(playtestTrace), null, 2)
  ].join("\n");
}

function compactTraceForModel(playtestTrace) {
  return {
    status: playtestTrace.status,
    mechanical_status: playtestTrace.mechanical_status,
    load_status: playtestTrace.load_status,
    console_error_count: playtestTrace.console_errors?.length ?? 0,
    page_error_count: playtestTrace.page_errors?.length ?? 0,
    candidate_actionable_controls: playtestTrace.candidate_actionable_controls,
    attempted_interactions: playtestTrace.attempted_interactions,
    before_evidence: playtestTrace.before_evidence
      ? {
          url: playtestTrace.before_evidence.url,
          title: playtestTrace.before_evidence.title,
          text_sample: playtestTrace.before_evidence.text_sample,
          control_count: playtestTrace.before_evidence.control_count,
          canvas_count: playtestTrace.before_evidence.canvas_count
        }
      : null,
    after_evidence: playtestTrace.after_evidence
      ? {
          url: playtestTrace.after_evidence.url,
          title: playtestTrace.after_evidence.title,
          text_sample: playtestTrace.after_evidence.text_sample,
          control_count: playtestTrace.after_evidence.control_count,
          canvas_count: playtestTrace.after_evidence.canvas_count
        }
      : null,
    state_changed: playtestTrace.state_changed,
    state_change_reasons: playtestTrace.state_change_reasons,
    feedback_observed: playtestTrace.feedback_observed,
    reason: playtestTrace.reason
  };
}

function extractGeminiText(response) {
  const text = (response.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text)
    .filter((part) => typeof part === "string")
    .join("");

  if (!text.trim()) {
    throw new Error("Gemini response did not include text content.");
  }

  return text;
}

function normalizeModelPlaytestReviewJson(rawText, providerLabel) {
  const text = String(rawText ?? "").trim();
  if (!text) {
    throw new Error(`${providerLabel} review did not include JSON text.`);
  }

  const parsedWhole = parseJsonObjectCandidate(text);
  if (parsedWhole.ok) {
    return text;
  }

  const candidates = extractValidJsonObjectCandidates(text);
  if (candidates.length === 1) {
    return candidates[0].text;
  }

  if (candidates.length > 1) {
    throw new Error(`${providerLabel} review contained multiple valid JSON objects; refusing ambiguous advisory output.`);
  }

  const reason = parsedWhole.error ? ` ${parsedWhole.error.message}` : "";
  throw new Error(`${providerLabel} review did not contain a valid JSON object.${reason}`);
}

function parseJsonObjectCandidate(text) {
  try {
    const value = JSON.parse(text);
    return {
      ok: Boolean(value && typeof value === "object" && !Array.isArray(value)),
      value,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      value: null,
      error
    };
  }
}

function extractValidJsonObjectCandidates(text) {
  const candidates = [];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") {
      continue;
    }

    const end = findJsonObjectEnd(text, index);
    if (end === -1) {
      continue;
    }

    const candidateText = text.slice(index, end + 1).trim();
    const parsed = parseJsonObjectCandidate(candidateText);
    if (parsed.ok) {
      candidates.push({ text: candidateText, value: parsed.value });
    }

    index = end;
  }

  return candidates;
}

function findJsonObjectEnd(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function validateModelPlaytestReview(review, providerLabel) {
  const stringFields = ["goal_guess", "first_action_guess", "observed_feedback", "recommendation"];
  for (const field of stringFields) {
    if (typeof review[field] !== "string" || !review[field].trim()) {
      throw new Error(`${providerLabel} review field ${field} must be a non-empty string.`);
    }
  }

  for (const field of ["first_action_confidence", "interaction_confidence"]) {
    if (typeof review[field] !== "number" || review[field] < 0 || review[field] > 1) {
      throw new Error(`${providerLabel} review field ${field} must be a number from 0 to 1.`);
    }
  }

  if (!Number.isInteger(review.clarity_score) || review.clarity_score < 1 || review.clarity_score > 5) {
    throw new Error(`${providerLabel} review field clarity_score must be an integer from 1 to 5.`);
  }

  if (review.stuck_reason !== null && typeof review.stuck_reason !== "string") {
    throw new Error(`${providerLabel} review field stuck_reason must be a string or null.`);
  }

  if (!Array.isArray(review.known_gaps) || review.known_gaps.some((gap) => typeof gap !== "string")) {
    throw new Error(`${providerLabel} review field known_gaps must be an array of strings.`);
  }

  if (!["accept", "needs-human-review", "reject"].includes(review.recommendation)) {
    throw new Error(`${providerLabel} review field recommendation has an unsupported value.`);
  }
}

function sanitizeUsageMetadata(usageMetadata) {
  if (!usageMetadata || typeof usageMetadata !== "object") {
    return null;
  }

  return {
    promptTokenCount: usageMetadata.promptTokenCount ?? null,
    candidatesTokenCount: usageMetadata.candidatesTokenCount ?? null,
    totalTokenCount: usageMetadata.totalTokenCount ?? null
  };
}

function sanitizeOpenAiUsageMetadata(usageMetadata) {
  if (!usageMetadata || typeof usageMetadata !== "object") {
    return null;
  }

  return {
    prompt_tokens: usageMetadata.prompt_tokens ?? null,
    completion_tokens: usageMetadata.completion_tokens ?? null,
    total_tokens: usageMetadata.total_tokens ?? null
  };
}

function redactEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return "unparseable endpoint";
  }
}

function requestJson(url, options = {}) {
  return requestJsonResponse(url, options).then((response) => {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`HTTP ${response.statusCode}: ${response.raw.slice(0, 500)}`);
    }

    return response.body;
  });
}

function requestJsonResponse(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.request(parsed, {
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      timeout: options.timeoutMs ?? 10000
    }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => {
        let body = null;
        try {
          body = data.trim() ? JSON.parse(data) : null;
        } catch (error) {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            reject(new Error(`Response was not valid JSON: ${error.message}`));
            return;
          }
        }

        resolve({
          statusCode: response.statusCode,
          body,
          raw: data
        });
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error(`Timed out requesting ${redactEndpoint(url)}`));
    });
    request.on("error", reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

async function requestNvidiaChatCompletion(endpoint, apiKey, body) {
  const chatEndpoint = nvidiaChatEndpoint(endpoint);
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`
  };
  const response = await requestJsonResponse(chatEndpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeoutMs: 30000
  });

  if (response.statusCode === 202) {
    return pollNvidiaPendingResponse(response.body, endpoint, headers);
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(nvidiaErrorMessage(response) ?? `HTTP ${response.statusCode}`);
  }

  return response.body;
}

async function pollNvidiaPendingResponse(initialBody, endpoint, headers) {
  const requestId = typeof initialBody?.requestId === "string" ? initialBody.requestId : null;
  if (!requestId) {
    throw new Error("NVIDIA response returned HTTP 202 without a requestId to poll.");
  }

  for (let attempt = 0; attempt < nvidiaPendingPollAttempts; attempt += 1) {
    if (attempt > 0) {
      await delay(nvidiaPendingPollDelayMs);
    }

    const response = await requestJsonResponse(nvidiaStatusEndpoint(endpoint, requestId), {
      method: "GET",
      headers,
      timeoutMs: 30000
    });

    if (response.statusCode === 202) {
      continue;
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(nvidiaErrorMessage(response) ?? `HTTP ${response.statusCode}`);
    }

    return response.body;
  }

  throw new Error(`NVIDIA response remained pending for requestId ${requestId}.`);
}

function nvidiaChatEndpoint(endpoint) {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function nvidiaStatusEndpoint(endpoint, requestId) {
  const chatEndpoint = nvidiaChatEndpoint(endpoint);
  const root = chatEndpoint.slice(0, -"/chat/completions".length);
  return `${root}/status/${encodeURIComponent(requestId)}`;
}

function nvidiaErrorMessage(response) {
  const body = response.body;
  const error = body?.error;

  if (typeof error === "string" && error.trim()) {
    return `HTTP ${response.statusCode}: ${error}`;
  }

  if (error && typeof error === "object" && typeof error.message === "string" && error.message.trim()) {
    return `HTTP ${response.statusCode}: ${error.message}`;
  }

  if (typeof body?.message === "string" && body.message.trim()) {
    return `HTTP ${response.statusCode}: ${body.message}`;
  }

  if (response.raw.trim()) {
    return `HTTP ${response.statusCode}: ${response.raw.slice(0, 500)}`;
  }

  return null;
}

function extractOpenAiCompatibleText(data) {
  const nested = data?.response;
  if (nested && typeof nested === "object") {
    return extractOpenAiCompatibleText(nested);
  }

  const choices = Array.isArray(data?.choices) ? data.choices : [];
  const texts = choices.flatMap((choice) => {
    const message = choice?.message;
    if (typeof message?.content === "string") {
      return [message.content];
    }
    if (Array.isArray(message?.content)) {
      return message.content
        .map((part) => part?.text)
        .filter((part) => typeof part === "string");
    }
    if (typeof choice?.text === "string") {
      return [choice.text];
    }
    return [];
  });
  const text = texts.join("");

  if (!text.trim()) {
    throw new Error("NVIDIA response did not include text content.");
  }

  return text;
}

class DevToolsConnection {
  static connect(webSocketUrl) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(webSocketUrl);
      const socket = net.connect(Number(parsed.port), parsed.hostname);
      const key = crypto.randomBytes(16).toString("base64");
      let buffer = Buffer.alloc(0);

      socket.once("connect", () => {
        socket.write([
          `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
          `Host: ${parsed.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          ""
        ].join("\r\n"));
      });

      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }

        const header = buffer.subarray(0, headerEnd).toString("utf8");
        if (!header.startsWith("HTTP/1.1 101")) {
          reject(new Error(`Chrome DevTools WebSocket handshake failed: ${header.split(/\r?\n/)[0]}`));
          socket.destroy();
          return;
        }

        socket.off("data", onData);
        const connection = new DevToolsConnection(socket);
        const remaining = buffer.subarray(headerEnd + 4);
        if (remaining.length > 0) {
          connection.handleData(remaining);
        }
        resolve(connection);
      };

      socket.on("data", onData);
      socket.once("error", reject);
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.socket.on("data", (chunk) => this.handleData(chunk));
    this.socket.on("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("Chrome DevTools WebSocket closed."));
      }
      this.pending.clear();
    });
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) ?? [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    this.writeFrame(payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for DevTools response to ${method}.`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  close() {
    this.socket.end();
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) {
          return;
        }
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) {
          return;
        }
        const bigLength = this.buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("WebSocket frame is too large.");
        }
        length = Number(bigLength);
        offset += 8;
      }

      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) {
        return;
      }

      let payload = this.buffer.subarray(offset + maskLength, offset + maskLength + length);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.subarray(offset + maskLength + length);

      if (opcode === 1) {
        this.handleMessage(payload.toString("utf8"));
      } else if (opcode === 8) {
        this.close();
      } else if (opcode === 9) {
        this.writeFrame(payload, 10);
      }
    }
  }

  handleMessage(text) {
    const message = JSON.parse(text);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    for (const handler of this.handlers.get(message.method) ?? []) {
      handler(message.params ?? {});
    }
  }

  writeFrame(data, opcode = 1) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | payload.length;
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    header[0] = 0x80 | opcode;

    const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
}

function hashText(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function collectKnownGaps(scope, registration, screenshot, network, browserSmoke, playtestTrace, modelPlaytestReview, testResult) {
  const gaps = [];

  for (const [label, check] of [
    ["CI/test", testResult],
    ["changed-file scope", scope],
    ["gallery registration", registration],
    ["screenshot", screenshot],
    ["external network/dependency", network],
    ["browser smoke", browserSmoke],
    ["browser playtest", playtestTrace]
  ]) {
    if (check.status === "fail") {
      gaps.push(`${label} failed${check.reason ? `: ${check.reason}` : ""}`);
    } else if (check.mechanical_status === "fail") {
      gaps.push(`${label} mechanical failure${check.reason ? `: ${check.reason}` : ""}`);
    } else if (check.mechanical_status === "inconclusive") {
      gaps.push(`${label} inconclusive${check.reason ? `: ${check.reason}` : ""}`);
    } else if (check.status === "skipped") {
      gaps.push(`${label} skipped${check.reason ? `: ${check.reason}` : ""}`);
    }
  }

  if (modelPlaytestReview?.status === "failed") {
    const provider = modelPlaytestReview.provider ? ` (${modelPlaytestReview.provider})` : "";
    gaps.push(`model playtest review failed${provider}${modelPlaytestReview.reason ? `: ${modelPlaytestReview.reason}` : ""}`);
  }

  return gaps;
}

await main();
