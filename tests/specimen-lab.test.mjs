import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { loadSpecimenLab } from "../scripts/specimen-lab-data.mjs";

const repoRoot = process.cwd();
const updaterPath = path.join(repoRoot, "scripts", "update-specimen-lab-data.mjs");
const evaluatorPath = path.join(repoRoot, "scripts", "evaluate-pullfrog-experiment.mjs");

test("Specimen Lab updater upserts one specimen and appends rerun lineage", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "specimen-lab-test-"));
  try {
    fs.mkdirSync(path.join(tempRoot, "specimens", "pullfrog"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "specimens", "pullfrog", "specimens.json"), `${JSON.stringify({
      schema_version: 1,
      generated_at: null,
      specimens: []
    }, null, 2)}\n`);

    runUpdate(tempRoot, 101, 3, ["first gap"]);
    runUpdate(tempRoot, 102, 4, ["second gap"]);

    const lab = loadSpecimenLab(tempRoot);
    assert.equal(lab.specimens.length, 1);
    const specimen = lab.specimens[0];
    assert.equal(specimen.pr.number, 87);
    assert.equal(specimen.score, 4);
    assert.equal(specimen.comparison.run_count, 2);
    assert.equal(specimen.comparison.previous_score, 3);
    assert.equal(specimen.comparison.score_delta, 1);
    assert.deepEqual(specimen.reruns.map((run) => run.run_id), [101, 102]);
    assert.equal(specimen.scorecard.pr_comment_url, "https://github.com/Drew-Goddyn/jules-toys/pull/87#issuecomment-102");
    assert.ok(fs.existsSync(path.join(tempRoot, "public", "specimen-lab", "pullfrog", "pr-87", "browser-smoke.png")));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Evaluator lineage can read Specimen Lab history outside the PR worktree", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "specimen-lab-lineage-test-"));
  try {
    fs.mkdirSync(path.join(tempRoot, "specimens", "pullfrog"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "specimens", "pullfrog", "specimens.json"), `${JSON.stringify({
      schema_version: 1,
      generated_at: null,
      specimens: []
    }, null, 2)}\n`);
    runUpdate(tempRoot, 111, 3, ["baseline gap"]);

    const metadataPath = path.join(tempRoot, "metadata.json");
    fs.writeFileSync(metadataPath, `${JSON.stringify({
      number: 87,
      title: "[Pullfrog experiment] feat: add Lantern Loom Lab T9 light puzzle toy",
      url: "https://github.com/Drew-Goddyn/jules-toys/pull/87",
      body: "Refs #86",
      headRefName: "pullfrog/86-lantern-loom-lab",
      headRefOid: "head-sha",
      baseRefName: "main",
      files: ["gallery-data.js", "tier9/lantern-loom-lab/index.html", "tier9/lantern-loom-lab/screenshot.png"]
    }, null, 2)}\n`);

    const reportPath = path.join(tempRoot, "lineage-report.json");
    const result = spawnSync(process.execPath, [
      evaluatorPath,
      "--pr-number", "87",
      "--issue-number", "86",
      "--metadata", metadataPath,
      "--test-outcome", "success",
      "--browser-smoke", "false",
      "--lineage-root", tempRoot,
      "--output-dir", path.join(tempRoot, "evaluation"),
      "--report", reportPath
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "Drew-Goddyn/jules-toys",
        GITHUB_RUN_ID: "222",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_WORKFLOW: "Evaluate Pullfrog Experiment",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_ACTOR: "github-actions[bot]",
        GITHUB_REF_NAME: "main",
        GITHUB_SHA: "base-sha"
      }
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.lineage.run_sequence, 2);
    assert.equal(report.lineage.previous_run_count, 1);
    assert.equal(report.lineage.rerun_of_run_id, 111);
    assert.deepEqual(report.lineage.previous_runs.map((run) => run.run_id), [111]);
    assert.equal(report.lineage.specimen_data_source.error, null);
    assert.ok(report.lineage.specimen_data_source.generated_at);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function runUpdate(tempRoot, runId, score, gaps) {
  const artifactDir = path.join(tempRoot, `artifact-${runId}`);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "browser-smoke.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const reportPath = path.join(tempRoot, `report-${runId}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(makeReport(runId), null, 2)}\n`);

  const judgePath = path.join(tempRoot, `judge-${runId}.json`);
  fs.writeFileSync(judgePath, `${JSON.stringify({
    quality_score: score,
    acceptance_recommendation: "accept",
    novelty: "novel",
    coherence: "coherent",
    usefulness: "useful",
    review_burden: "low",
    known_gaps: gaps,
    rationale: "test fixture"
  }, null, 2)}\n`);

  const result = spawnSync(process.execPath, [
    updaterPath,
    "--root-dir", tempRoot,
    "--report", reportPath,
    "--judge", judgePath,
    "--artifact-dir", artifactDir,
    "--pr-comment-url", `https://github.com/Drew-Goddyn/jules-toys/pull/87#issuecomment-${runId}`,
    "--issue-comment-url", `https://github.com/Drew-Goddyn/jules-toys/issues/86#issuecomment-${runId}`,
    "--scorecard-marker", "<!-- pullfrog-experiment-evaluator:v2 pr=87 issue=86 -->",
    "--artifact-name", "pullfrog-experiment-evaluation-87",
    "--quality-threshold", "3"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function makeReport(runId) {
  return {
    version: 2,
    generated_at: `2026-06-13T20:${runId}:00.000Z`,
    repository: "Drew-Goddyn/jules-toys",
    workflow: {
      run_id: runId,
      run_attempt: 1,
      run_url: `https://github.com/Drew-Goddyn/jules-toys/actions/runs/${runId}`,
      workflow: "Evaluate Pullfrog Experiment",
      event_name: "workflow_dispatch",
      actor: "github-actions[bot]",
      ref: "main",
      sha: "base-sha",
      artifact_name: "pullfrog-experiment-evaluation-87"
    },
    lineage: {
      canonical_key: "pullfrog-pr-87",
      specimen_data_path: "specimens/pullfrog/specimens.json",
      scorecard_marker: "<!-- pullfrog-experiment-evaluator:v2 pr=87 issue=86 -->",
      run_sequence: 1,
      previous_run_count: 0,
      rerun_of_run_id: null,
      previous_runs: []
    },
    pr: {
      number: 87,
      url: "https://github.com/Drew-Goddyn/jules-toys/pull/87",
      title: "[Pullfrog experiment] feat: add Lantern Loom Lab T9 light puzzle toy",
      head_ref: "pullfrog/86-lantern-loom-lab",
      base_ref: "main",
      head_sha: "7cf63a99c035daa1366e9cf9d3c4fa7f74669371"
    },
    issue: {
      number: 86,
      url: "https://github.com/Drew-Goddyn/jules-toys/issues/86"
    },
    deterministic: {
      ci_test_result: { status: "pass", raw: "success" },
      changed_file_scope: { status: "pass", changed_files: [], unexpected_files: [] },
      gallery_registration: {
        status: "pass",
        registered: true,
        title: "Lantern Loom Lab",
        tier: 9,
        slug: "lantern-loom-lab",
        path: "tier9/lantern-loom-lab/index.html",
        screenshot: "tier9/lantern-loom-lab/screenshot.png",
        reason: null
      },
      screenshot_presence: { status: "pass", path: "tier9/lantern-loom-lab/screenshot.png" },
      external_network_dependency: { status: "pass", references: [], dynamic_apis: [] },
      browser_smoke: { status: "pass", screenshot: "pullfrog-evaluation/browser-smoke.png" }
    },
    recommendation: {
      mechanical_pass: true,
      deterministic_label: "experiment:accepted",
      known_gaps: []
    }
  };
}
