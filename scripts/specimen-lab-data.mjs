import fs from "node:fs";
import path from "node:path";
import { assertSafeRelativePath } from "./gallery-data-loader.mjs";

export const specimenDataPath = path.join("specimens", "pullfrog", "specimens.json");
export const specimenAssetRoot = path.join("specimen-lab", "pullfrog");

export function emptySpecimenLab() {
  return {
    schema_version: 1,
    generated_at: null,
    specimens: []
  };
}

export function loadSpecimenLab(rootDir = process.cwd()) {
  const dataPath = path.join(rootDir, specimenDataPath);
  if (!fs.existsSync(dataPath)) {
    return emptySpecimenLab();
  }

  const lab = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  validateSpecimenLab(lab, rootDir);
  return lab;
}

export function writeSpecimenLab(rootDir, lab) {
  validateSpecimenLab(lab, rootDir, { requireAssets: false });
  const dataPath = path.join(rootDir, specimenDataPath);
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, `${JSON.stringify(lab, null, 2)}\n`);
}

export function updateSpecimenLab(rootDir, { report, judge, artifactDir, prCommentUrl, issueCommentUrl, scorecardMarker, artifactName, qualityThreshold = 3 }) {
  const lab = loadSpecimenLab(rootDir);
  const prNumber = report.pr?.number;
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("Report must include a positive pr.number.");
  }

  const now = new Date().toISOString();
  const existingIndex = lab.specimens.findIndex((specimen) => specimen.pr?.number === prNumber);
  const existing = existingIndex >= 0 ? lab.specimens[existingIndex] : null;
  const registration = report.deterministic?.gallery_registration ?? {};
  const screenshotPath = copyBrowserSmoke(rootDir, artifactDir, prNumber);
  const outcome = deriveOutcome(report, judge, qualityThreshold);
  const knownGaps = collectKnownGaps(report, judge);
  const artifactContents = buildArtifactContents(report);
  const playtest = summarizePlaytestEvidence(report);
  const previousRun = existing?.reruns?.at(-1) ?? null;
  const run = buildRunRecord(report, judge, {
    artifactName,
    prCommentUrl,
    issueCommentUrl,
    finalLabel: outcome.finalLabel,
    status: outcome.status,
    knownGaps,
    playtest
  });
  const reruns = upsertRun([...(existing?.reruns ?? [])], run);
  const previousScore = previousRun?.score ?? null;
  const scoreDelta = Number.isFinite(run.score) && Number.isFinite(previousScore)
    ? run.score - previousScore
    : null;

  const specimen = {
    id: `pullfrog-pr-${prNumber}`,
    title: registration.title ?? report.pr?.title ?? `PR #${prNumber}`,
    slug: registration.slug ?? `pr-${prNumber}`,
    tier: registration.tier ?? null,
    kind: "Pullfrog specimen",
    status: outcome.status,
    score: run.score,
    recommendation: outcome.recommendation,
    issue: {
      number: report.issue?.number ?? null,
      url: report.issue?.url ?? null
    },
    pr: {
      number: prNumber,
      url: report.pr?.url ?? null,
      title: report.pr?.title ?? null,
      head_ref: report.pr?.head_ref ?? null,
      base_ref: report.pr?.base_ref ?? null,
      head_sha: report.pr?.head_sha ?? null
    },
    workflow: report.workflow,
    artifact: {
      name: artifactName,
      workflow_run_url: report.workflow?.run_url ?? null,
      contains: artifactContents
    },
    scorecard: {
      marker: scorecardMarker,
      pr_comment_url: prCommentUrl ?? null,
      issue_comment_url: issueCommentUrl ?? null,
      updated_at: now
    },
    screenshot: {
      path: screenshotPath,
      source: "evaluator-browser-smoke",
      artifact_file: "browser-smoke.png"
    },
    playtest,
    known_gaps: knownGaps,
    comparison: {
      run_count: reruns.length,
      previous_score: previousScore,
      score_delta: scoreDelta,
      mechanical_pass: Boolean(report.recommendation?.mechanical_pass),
      latest_label: outcome.finalLabel,
      previous_run_id: previousRun?.run_id ?? null,
      summary: summarizeComparison(run, previousRun, scoreDelta)
    },
    provenance: {
      source: "pullfrog-evaluator-v2",
      repository: report.repository ?? "Drew-Goddyn/jules-toys",
      free_model: "opencode/big-pickle",
      report_version: report.version,
      report_generated_at: report.generated_at,
      persisted_at: now,
      generated_from: "GitHub Actions evaluator artifact and Pullfrog judge output"
    },
    reruns
  };

  lab.generated_at = now;
  if (existingIndex >= 0) {
    lab.specimens[existingIndex] = specimen;
  } else {
    lab.specimens.push(specimen);
  }
  lab.specimens.sort((a, b) => (b.workflow?.run_id ?? 0) - (a.workflow?.run_id ?? 0));
  writeSpecimenLab(rootDir, lab);
  return specimen;
}

export function validateSpecimenLab(lab, rootDir = process.cwd(), options = {}) {
  const requireAssets = options.requireAssets ?? true;
  if (!lab || typeof lab !== "object") {
    throw new Error("Specimen Lab data must be an object.");
  }

  if (lab.schema_version !== 1) {
    throw new Error("Specimen Lab data schema_version must be 1.");
  }

  if (lab.generated_at !== null && typeof lab.generated_at !== "string") {
    throw new Error("Specimen Lab generated_at must be null or a string.");
  }

  if (!Array.isArray(lab.specimens)) {
    throw new Error("Specimen Lab specimens must be an array.");
  }

  const seen = new Set();
  for (const [index, specimen] of lab.specimens.entries()) {
    validateSpecimen(specimen, index, rootDir, seen, requireAssets);
  }
}

function validateSpecimen(specimen, index, rootDir, seen, requireAssets) {
  if (!specimen || typeof specimen !== "object") {
    throw new Error(`Specimen ${index} must be an object.`);
  }

  for (const field of ["id", "title", "slug", "status"]) {
    if (typeof specimen[field] !== "string" || !specimen[field].trim()) {
      throw new Error(`Specimen ${index} has an invalid ${field}.`);
    }
  }

  if (seen.has(specimen.id)) {
    throw new Error(`Duplicate specimen id: ${specimen.id}`);
  }
  seen.add(specimen.id);

  const prNumber = specimen.pr?.number;
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Specimen ${index} must include a positive pr.number.`);
  }

  if (!["accepted", "failed", "needs-human-review"].includes(specimen.status)) {
    throw new Error(`Specimen ${index} has invalid status ${specimen.status}.`);
  }

  if (!Array.isArray(specimen.reruns) || specimen.reruns.length === 0) {
    throw new Error(`Specimen ${index} must include at least one rerun.`);
  }

  if (!Array.isArray(specimen.known_gaps)) {
    throw new Error(`Specimen ${index} known_gaps must be an array.`);
  }

  const screenshotPath = specimen.screenshot?.path;
  if (typeof screenshotPath !== "string" || !screenshotPath.trim()) {
    throw new Error(`Specimen ${index} must include screenshot.path.`);
  }
  assertSafeRelativePath(screenshotPath, `specimen ${index} screenshot.path`);

  if (requireAssets) {
    const filePath = path.join(rootDir, "public", screenshotPath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Specimen ${index} screenshot asset does not exist: public/${screenshotPath}`);
    }
  }
}

function copyBrowserSmoke(rootDir, artifactDir, prNumber) {
  const source = path.join(artifactDir, "browser-smoke.png");
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`Missing browser smoke artifact: ${source}`);
  }

  const relativePath = path.join(specimenAssetRoot, `pr-${prNumber}`, "browser-smoke.png");
  const destination = path.join(rootDir, "public", relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return relativePath.replaceAll(path.sep, "/");
}

function deriveOutcome(report, judge, qualityThreshold) {
  const mechanicalPass = Boolean(report.recommendation?.mechanical_pass);
  const qualityScore = Number(judge?.quality_score);
  const judgeRejects = judge?.acceptance_recommendation === "reject";
  const qualityPasses = Number.isFinite(qualityScore) ? qualityScore >= qualityThreshold : true;
  const finalLabel = mechanicalPass && qualityPasses && !judgeRejects
    ? "experiment:accepted"
    : "experiment:failed";
  const status = finalLabel === "experiment:accepted"
    ? "accepted"
    : judge?.acceptance_recommendation === "needs-human-review"
      ? "needs-human-review"
      : "failed";

  return {
    finalLabel,
    status,
    recommendation: judge?.acceptance_recommendation ?? (mechanicalPass ? "accept" : "reject")
  };
}

function collectKnownGaps(report, judge) {
  return [
    ...(report.recommendation?.known_gaps ?? []),
    ...(judge?.known_gaps ?? [])
  ].filter((gap, index, gaps) => typeof gap === "string" && gap.trim() && gaps.indexOf(gap) === index);
}

function buildArtifactContents(report) {
  const contains = new Set(["report.json", "browser-smoke.png"]);
  const trace = report.deterministic?.playtest_trace;
  for (const screenshot of [
    trace?.initial_screenshot,
    trace?.after_evidence?.screenshot
  ]) {
    if (typeof screenshot === "string" && screenshot.trim()) {
      contains.add(path.basename(screenshot));
    }
  }
  return [...contains];
}

function summarizePlaytestEvidence(report) {
  const trace = report.deterministic?.playtest_trace;
  const review = report.model_playtest_review;
  if (!trace) {
    return null;
  }

  const firstAttempt = trace.attempted_interactions?.[0] ?? {};
  return {
    trace_status: trace.status ?? null,
    mechanical_status: trace.mechanical_status ?? null,
    load_status: trace.load_status?.status ?? null,
    action_status: firstAttempt.status ?? null,
    action_type: firstAttempt.type ?? null,
    state_changed: trace.state_changed ?? null,
    state_change_reasons: trace.state_change_reasons ?? [],
    feedback_observed: Boolean(trace.feedback_observed?.success_failure_progress),
    candidate_control_count: trace.candidate_actionable_controls?.length ?? 0,
    initial_screenshot: trace.initial_screenshot ?? null,
    after_screenshot: trace.after_evidence?.screenshot ?? null,
    model_review_status: review?.status ?? null,
    model_review_model: review?.model ?? null,
    model_review_recommendation: review?.response?.recommendation ?? null
  };
}

function buildRunRecord(report, judge, options) {
  return {
    run_id: report.workflow?.run_id ?? null,
    run_attempt: report.workflow?.run_attempt ?? null,
    run_url: report.workflow?.run_url ?? null,
    event_name: report.workflow?.event_name ?? null,
    head_sha: report.pr?.head_sha ?? null,
    generated_at: report.generated_at,
    mechanical_pass: Boolean(report.recommendation?.mechanical_pass),
    score: Number.isFinite(Number(judge?.quality_score)) ? Number(judge.quality_score) : null,
    recommendation: judge?.acceptance_recommendation ?? null,
    label: options.finalLabel,
    status: options.status,
    artifact_name: options.artifactName,
    pr_comment_url: options.prCommentUrl ?? null,
    issue_comment_url: options.issueCommentUrl ?? null,
    known_gaps: options.knownGaps,
    playtest: options.playtest
  };
}

function upsertRun(runs, run) {
  const existingIndex = runs.findIndex((candidate) => String(candidate.run_id) === String(run.run_id));
  if (existingIndex >= 0) {
    runs[existingIndex] = run;
  } else {
    runs.push(run);
  }
  return runs.sort((a, b) => Number(a.run_id ?? 0) - Number(b.run_id ?? 0));
}

function summarizeComparison(run, previousRun, scoreDelta) {
  if (!previousRun) {
    return "First v2 evaluator run recorded for this specimen.";
  }

  const scoreText = scoreDelta === null
    ? "score comparison unavailable"
    : scoreDelta === 0
      ? "score unchanged"
      : scoreDelta > 0
        ? `score improved by ${scoreDelta}`
        : `score declined by ${Math.abs(scoreDelta)}`;
  const labelText = previousRun.label === run.label
    ? `label stable at ${run.label}`
    : `label changed from ${previousRun.label} to ${run.label}`;
  return `${scoreText}; ${labelText}.`;
}
