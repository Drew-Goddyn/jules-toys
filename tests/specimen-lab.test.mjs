import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
    assert.deepEqual(specimen.artifact.contains, ["report.json", "browser-smoke.png", "playtest-initial.png", "playtest-after-interaction.png"]);
    assert.equal(specimen.playtest.mechanical_status, "pass");
    assert.equal(specimen.playtest.state_changed, true);
    assert.equal(specimen.playtest.model_review_status, "skipped");
    assert.equal(specimen.playtest.model_review_provider, "gemini");
    assert.equal(specimen.reruns[1].playtest.action_type, "control-click");
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
      title: "[Pullfrog experiment] feat: add Lunar Postcards T3 toy",
      url: "https://github.com/Drew-Goddyn/jules-toys/pull/87",
      body: "Refs #86",
      headRefName: "pullfrog/86-lunar-postcards",
      headRefOid: "head-sha",
      baseRefName: "main",
      files: ["gallery-data.js", "tier3/lunar-postcards/index.html", "tier3/lunar-postcards/screenshot.png"]
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
    assert.equal(report.deterministic.playtest_trace.status, "skipped");
    assert.equal(report.deterministic.playtest_trace.mechanical_status, "skipped");
    assert.equal(report.deterministic.playtest_trace.attempted_interactions[0].status, "skipped");
    assert.equal(report.model_playtest_review.status, "skipped");
    assert.equal(report.model_playtest_review.provider, "gemini");
    assert.equal(report.recommendation.mechanical_pass, true);
    assert.ok(report.recommendation.known_gaps.some((gap) => gap.includes("browser playtest skipped")));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Evaluator records a mocked Gemini playtest review separately from deterministic acceptance", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pullfrog-gemini-review-test-"));
  const requests = [];
  const server = await startGeminiMockServer((body, request) => {
    requests.push({ body, apiKey: request.headers["x-goog-api-key"] });
    return {
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              goal_guess: "Flip the postcards and inspect the scene.",
              first_action_guess: "Click the first visible control or card.",
              first_action_confidence: 0.4,
              observed_feedback: "The trace was skipped, so feedback evidence is insufficient.",
              stuck_reason: "No browser interaction trace was captured in this fixture.",
              clarity_score: 2,
              interaction_confidence: 0.2,
              known_gaps: ["Trace skipped by test fixture."],
              recommendation: "needs-human-review"
            })
          }]
        }
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30
      }
    };
  });

  try {
    const metadataPath = writeEvaluatorMetadata(tempRoot);
    const reportPath = path.join(tempRoot, "gemini-report.json");
    const result = await runNode([
      evaluatorPath,
      "--pr-number", "87",
      "--issue-number", "86",
      "--metadata", metadataPath,
      "--test-outcome", "success",
      "--browser-smoke", "false",
      "--gemini-playtest", "true",
      "--gemini-api-key", "test-key",
      "--gemini-endpoint", server.url,
      "--output-dir", path.join(tempRoot, "evaluation"),
      "--report", reportPath
    ], { cwd: repoRoot });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].apiKey, "test-key");
    assert.equal(requests[0].body.generationConfig.responseFormat.text.mimeType, "application/json");
    assert.equal(requests[0].body.generationConfig.responseFormat.text.schema.required.includes("clarity_score"), true);

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.recommendation.mechanical_pass, true);
    assert.equal(report.model_playtest_review.status, "completed");
    assert.equal(report.model_playtest_review.provider, "gemini");
    assert.equal(report.model_playtest_review.response.recommendation, "needs-human-review");
    assert.equal(report.model_playtest_review.deterministic_authority, "deterministic.playtest_trace");
    assert.equal(report.model_playtest_review.usage_metadata.totalTokenCount, 30);
  } finally {
    await server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Evaluator keeps mechanical failure failed even when mocked Gemini recommends accept", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pullfrog-gemini-mechanical-fail-test-"));
  const server = await startGeminiMockServer(() => ({
    candidates: [{
      content: {
        parts: [{
          text: JSON.stringify({
            goal_guess: "Play the toy.",
            first_action_guess: "Click the visible target.",
            first_action_confidence: 0.9,
            observed_feedback: "Looks clear from the limited evidence.",
            stuck_reason: null,
            clarity_score: 5,
            interaction_confidence: 0.9,
            known_gaps: [],
            recommendation: "accept"
          })
        }]
      }
    }]
  }));

  try {
    const metadataPath = writeEvaluatorMetadata(tempRoot);
    const reportPath = path.join(tempRoot, "mechanical-fail-report.json");
    const result = await runNode([
      evaluatorPath,
      "--pr-number", "87",
      "--issue-number", "86",
      "--metadata", metadataPath,
      "--test-outcome", "failure",
      "--browser-smoke", "false",
      "--gemini-playtest", "true",
      "--gemini-api-key", "test-key",
      "--gemini-endpoint", server.url,
      "--output-dir", path.join(tempRoot, "evaluation"),
      "--report", reportPath
    ], { cwd: repoRoot });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.model_playtest_review.status, "completed");
    assert.equal(report.model_playtest_review.response.recommendation, "accept");
    assert.equal(report.recommendation.mechanical_pass, false);
    assert.equal(report.recommendation.deterministic_label, "experiment:failed");
    assert.ok(report.recommendation.known_gaps.some((gap) => gap.includes("CI/test failed")));
  } finally {
    await server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Evaluator records malformed Gemini playtest JSON without failing deterministic evaluation", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pullfrog-gemini-malformed-test-"));
  const server = await startGeminiMockServer(() => ({
    candidates: [{
      content: {
        parts: [{ text: "{not json" }]
      }
    }]
  }));

  try {
    const metadataPath = writeEvaluatorMetadata(tempRoot);
    const reportPath = path.join(tempRoot, "malformed-gemini-report.json");
    const result = await runNode([
      evaluatorPath,
      "--pr-number", "87",
      "--issue-number", "86",
      "--metadata", metadataPath,
      "--test-outcome", "success",
      "--browser-smoke", "false",
      "--gemini-playtest", "true",
      "--gemini-api-key", "test-key",
      "--gemini-endpoint", server.url,
      "--output-dir", path.join(tempRoot, "evaluation"),
      "--report", reportPath
    ], { cwd: repoRoot });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.recommendation.mechanical_pass, true);
    assert.equal(report.model_playtest_review.status, "failed");
    assert.match(report.model_playtest_review.reason, /JSON/);
    assert.ok(report.recommendation.known_gaps.some((gap) => gap.includes("model playtest review failed (gemini)")));
  } finally {
    await server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Evaluator skips NVIDIA playtest review without NVIDIA_API_KEY while deterministic acceptance remains authoritative", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pullfrog-nvidia-missing-key-test-"));
  try {
    const metadataPath = writeEvaluatorMetadata(tempRoot);
    const reportPath = path.join(tempRoot, "nvidia-missing-key-report.json");
    const result = await runNode([
      evaluatorPath,
      "--pr-number", "87",
      "--issue-number", "86",
      "--metadata", metadataPath,
      "--test-outcome", "success",
      "--browser-smoke", "false",
      "--model-playtest", "true",
      "--model-playtest-provider", "nvidia",
      "--model-playtest-model", "moonshotai/kimi-k2.6",
      "--output-dir", path.join(tempRoot, "evaluation"),
      "--report", reportPath
    ], {
      cwd: repoRoot,
      env: withoutEnv(process.env, ["NVIDIA_API_KEY"])
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.recommendation.mechanical_pass, true);
    assert.equal(report.model_playtest_review.status, "skipped");
    assert.equal(report.model_playtest_review.provider, "nvidia");
    assert.equal(report.model_playtest_review.model, "moonshotai/kimi-k2.6");
    assert.match(report.model_playtest_review.reason, /NVIDIA_API_KEY/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Evaluator records mocked NVIDIA review after polling a 202 pending response", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pullfrog-nvidia-review-test-"));
  const requests = [];
  let statusPolls = 0;
  const server = await startNvidiaMockServer((body, request) => {
    if (request.url === "/v1/chat/completions") {
      requests.push({ body, authorization: request.headers.authorization });
      return { status: 202, body: { requestId: "pending-review-1" } };
    }

    assert.equal(request.url, "/v1/status/pending-review-1");
    statusPolls += 1;
    return nvidiaChatResponse(reviewPayload({
      recommendation: "needs-human-review",
      known_gaps: ["Trace skipped by test fixture."]
    }), {
      prompt_tokens: 11,
      completion_tokens: 22,
      total_tokens: 33
    });
  });

  try {
    const metadataPath = writeEvaluatorMetadata(tempRoot);
    const reportPath = path.join(tempRoot, "nvidia-report.json");
    const result = await runNode([
      evaluatorPath,
      "--pr-number", "87",
      "--issue-number", "86",
      "--metadata", metadataPath,
      "--test-outcome", "success",
      "--browser-smoke", "false",
      "--model-playtest", "true",
      "--model-playtest-provider", "nvidia",
      "--model-playtest-model", "moonshotai/kimi-k2.6",
      "--nvidia-api-key", "test-key",
      "--nvidia-endpoint", server.url,
      "--output-dir", path.join(tempRoot, "evaluation"),
      "--report", reportPath
    ], { cwd: repoRoot });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requests.length, 1);
    assert.equal(statusPolls, 1);
    assert.equal(requests[0].authorization, "Bearer test-key");
    assert.equal(requests[0].body.model, "moonshotai/kimi-k2.6");
    assert.equal(requests[0].body.stream, false);
    assert.equal(requests[0].body.temperature, 0);
    assert.ok(requests[0].body.messages.some((message) => String(message.content).includes("deterministic browser harness")));
    assert.ok(requests[0].body.messages.some((message) => String(message.content).includes("raw JSON object only")));
    assert.ok(requests[0].body.messages.some((message) => String(message.content).includes("\"goal_guess\"")));

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.recommendation.mechanical_pass, true);
    assert.equal(report.model_playtest_review.status, "completed");
    assert.equal(report.model_playtest_review.provider, "nvidia");
    assert.equal(report.model_playtest_review.model, "moonshotai/kimi-k2.6");
    assert.equal(report.model_playtest_review.deterministic_authority, "deterministic.playtest_trace");
    assert.equal(report.model_playtest_review.response.recommendation, "needs-human-review");
    assert.equal(report.model_playtest_review.usage_metadata.total_tokens, 33);
  } finally {
    await server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Evaluator accepts fenced NVIDIA playtest JSON", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pullfrog-nvidia-fenced-json-test-"));
  const review = reviewPayload({
    recommendation: "needs-human-review",
    known_gaps: ["The model wrapped the advisory JSON in a Markdown fence."]
  });
  const server = await startNvidiaMockServer(() => nvidiaChatTextResponse([
    "```json",
    JSON.stringify(review),
    "```"
  ].join("\n")));

  try {
    const report = await runNvidiaReviewFixture(tempRoot, server, "nvidia-fenced-report.json");

    assert.equal(report.recommendation.mechanical_pass, true);
    assert.equal(report.model_playtest_review.status, "completed");
    assert.equal(report.model_playtest_review.provider, "nvidia");
    assert.equal(report.model_playtest_review.response.recommendation, "needs-human-review");
    assert.deepEqual(report.model_playtest_review.response.known_gaps, ["The model wrapped the advisory JSON in a Markdown fence."]);
  } finally {
    await server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Evaluator accepts plain-fenced NVIDIA playtest JSON", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pullfrog-nvidia-plain-fenced-json-test-"));
  const review = reviewPayload({
    recommendation: "needs-human-review",
    known_gaps: ["The model wrapped the advisory JSON in a plain Markdown fence."]
  });
  const server = await startNvidiaMockServer(() => nvidiaChatTextResponse([
    "```",
    JSON.stringify(review),
    "```"
  ].join("\n")));

  try {
    const report = await runNvidiaReviewFixture(tempRoot, server, "nvidia-plain-fenced-report.json");

    assert.equal(report.recommendation.mechanical_pass, true);
    assert.equal(report.model_playtest_review.status, "completed");
    assert.equal(report.model_playtest_review.provider, "nvidia");
    assert.equal(report.model_playtest_review.response.recommendation, "needs-human-review");
    assert.deepEqual(report.model_playtest_review.response.known_gaps, ["The model wrapped the advisory JSON in a plain Markdown fence."]);
  } finally {
    await server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Evaluator accepts prose-wrapped single NVIDIA playtest JSON object", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pullfrog-nvidia-prose-json-test-"));
  const review = reviewPayload({
    recommendation: "reject",
    known_gaps: ["The trace does not prove the first interaction is understandable."]
  });
  const server = await startNvidiaMockServer(() => nvidiaChatTextResponse([
    "Here is the advisory review based only on the trace:",
    JSON.stringify(review),
    "I am not changing the deterministic pass/fail result."
  ].join("\n")));

  try {
    const report = await runNvidiaReviewFixture(tempRoot, server, "nvidia-prose-report.json");

    assert.equal(report.recommendation.mechanical_pass, true);
    assert.equal(report.model_playtest_review.status, "completed");
    assert.equal(report.model_playtest_review.provider, "nvidia");
    assert.equal(report.model_playtest_review.response.recommendation, "reject");
    assert.deepEqual(report.model_playtest_review.response.known_gaps, ["The trace does not prove the first interaction is understandable."]);
  } finally {
    await server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Evaluator keeps mechanical failure failed even when mocked NVIDIA recommends accept", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pullfrog-nvidia-mechanical-fail-test-"));
  const server = await startNvidiaMockServer(() => nvidiaChatResponse(reviewPayload({
    recommendation: "accept",
    clarity_score: 5,
    interaction_confidence: 0.9
  })));

  try {
    const metadataPath = writeEvaluatorMetadata(tempRoot);
    const reportPath = path.join(tempRoot, "nvidia-mechanical-fail-report.json");
    const result = await runNode([
      evaluatorPath,
      "--pr-number", "87",
      "--issue-number", "86",
      "--metadata", metadataPath,
      "--test-outcome", "failure",
      "--browser-smoke", "false",
      "--model-playtest", "true",
      "--model-playtest-provider", "nvidia",
      "--model-playtest-model", "nvidia/nemotron-3-super-120b-a12b",
      "--nvidia-api-key", "test-key",
      "--nvidia-endpoint", server.url,
      "--output-dir", path.join(tempRoot, "evaluation"),
      "--report", reportPath
    ], { cwd: repoRoot });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.model_playtest_review.status, "completed");
    assert.equal(report.model_playtest_review.provider, "nvidia");
    assert.equal(report.model_playtest_review.model, "nvidia/nemotron-3-super-120b-a12b");
    assert.equal(report.model_playtest_review.response.recommendation, "accept");
    assert.equal(report.recommendation.mechanical_pass, false);
    assert.equal(report.recommendation.deterministic_label, "experiment:failed");
    assert.ok(report.recommendation.known_gaps.some((gap) => gap.includes("CI/test failed")));
  } finally {
    await server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Evaluator records ambiguous NVIDIA playtest JSON without failing deterministic evaluation", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pullfrog-nvidia-ambiguous-json-test-"));
  const server = await startNvidiaMockServer(() => nvidiaChatTextResponse([
    JSON.stringify(reviewPayload({ recommendation: "accept" })),
    JSON.stringify(reviewPayload({ recommendation: "reject" }))
  ].join("\n")));

  try {
    const report = await runNvidiaReviewFixture(tempRoot, server, "ambiguous-nvidia-report.json");

    assert.equal(report.recommendation.mechanical_pass, true);
    assert.equal(report.model_playtest_review.status, "failed");
    assert.equal(report.model_playtest_review.provider, "nvidia");
    assert.match(report.model_playtest_review.reason, /multiple valid JSON objects/i);
    assert.ok(report.recommendation.known_gaps.some((gap) => gap.includes("model playtest review failed (nvidia)")));
  } finally {
    await server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Evaluator records malformed NVIDIA playtest JSON without failing deterministic evaluation", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pullfrog-nvidia-malformed-test-"));
  const server = await startNvidiaMockServer(() => ({
    choices: [{
      message: { content: "{not json" }
    }]
  }));

  try {
    const metadataPath = writeEvaluatorMetadata(tempRoot);
    const reportPath = path.join(tempRoot, "malformed-nvidia-report.json");
    const result = await runNode([
      evaluatorPath,
      "--pr-number", "87",
      "--issue-number", "86",
      "--metadata", metadataPath,
      "--test-outcome", "success",
      "--browser-smoke", "false",
      "--model-playtest", "true",
      "--model-playtest-provider", "nvidia",
      "--model-playtest-model", "moonshotai/kimi-k2.6",
      "--nvidia-api-key", "test-key",
      "--nvidia-endpoint", server.url,
      "--output-dir", path.join(tempRoot, "evaluation"),
      "--report", reportPath
    ], { cwd: repoRoot });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.recommendation.mechanical_pass, true);
    assert.equal(report.model_playtest_review.status, "failed");
    assert.equal(report.model_playtest_review.provider, "nvidia");
    assert.match(report.model_playtest_review.reason, /JSON/);
    assert.ok(report.recommendation.known_gaps.some((gap) => gap.includes("model playtest review failed (nvidia)")));
  } finally {
    await server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Specimen Lab updater remains compatible with legacy v2 reports without playtest evidence", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "specimen-lab-legacy-test-"));
  try {
    fs.mkdirSync(path.join(tempRoot, "specimens", "pullfrog"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "specimens", "pullfrog", "specimens.json"), `${JSON.stringify({
      schema_version: 1,
      generated_at: null,
      specimens: []
    }, null, 2)}\n`);

    const artifactDir = path.join(tempRoot, "artifact-legacy");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "browser-smoke.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const reportPath = path.join(tempRoot, "legacy-report.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(makeLegacyReport(333), null, 2)}\n`);
    const judgePath = path.join(tempRoot, "legacy-judge.json");
    fs.writeFileSync(judgePath, `${JSON.stringify({
      quality_score: 3,
      acceptance_recommendation: "accept",
      novelty: "novel",
      coherence: "coherent",
      usefulness: "useful",
      review_burden: "low",
      known_gaps: [],
      rationale: "legacy fixture"
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      updaterPath,
      "--root-dir", tempRoot,
      "--report", reportPath,
      "--judge", judgePath,
      "--artifact-dir", artifactDir,
      "--pr-comment-url", "https://github.com/Drew-Goddyn/jules-toys/pull/87#issuecomment-333",
      "--issue-comment-url", "https://github.com/Drew-Goddyn/jules-toys/issues/86#issuecomment-333",
      "--scorecard-marker", "<!-- pullfrog-experiment-evaluator:v2 pr=87 issue=86 -->",
      "--artifact-name", "pullfrog-experiment-evaluation-87",
      "--quality-threshold", "3"
    ], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const lab = loadSpecimenLab(tempRoot);
    assert.equal(lab.specimens[0].playtest, null);
    assert.deepEqual(lab.specimens[0].artifact.contains, ["report.json", "browser-smoke.png"]);
    assert.equal(lab.specimens[0].reruns[0].playtest, null);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function runUpdate(tempRoot, runId, score, gaps) {
  const artifactDir = path.join(tempRoot, `artifact-${runId}`);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "browser-smoke.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(artifactDir, "playtest-initial.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(artifactDir, "playtest-after-interaction.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

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

async function startGeminiMockServer(handler) {
  const server = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      const payload = handler(body, request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify(payload)}\n`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/v1beta/models/gemini-3.5-flash:generateContent`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function startNvidiaMockServer(handler) {
  const server = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      const handled = handler(body, request);
      const status = handled?.status ?? 200;
      const payload = handled?.body ?? handled;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(`${JSON.stringify(payload)}\n`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function reviewPayload(overrides = {}) {
  return {
    goal_guess: "Play the toy and inspect the first interaction.",
    first_action_guess: "Click the first visible control.",
    first_action_confidence: 0.7,
    observed_feedback: "The trace fixture provides limited feedback evidence.",
    stuck_reason: null,
    clarity_score: 3,
    interaction_confidence: 0.5,
    known_gaps: [],
    recommendation: "needs-human-review",
    ...overrides
  };
}

function nvidiaChatResponse(review, usage = {}) {
  return nvidiaChatTextResponse(JSON.stringify(review), usage);
}

function nvidiaChatTextResponse(content, usage = {}) {
  return {
    choices: [{
      message: {
        content
      }
    }],
    usage
  };
}

function withoutEnv(env, keys) {
  const next = { ...env };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function runNode(args, options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function writeEvaluatorMetadata(tempRoot) {
  const metadataPath = path.join(tempRoot, "metadata.json");
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    number: 87,
    title: "[Pullfrog experiment] feat: add Lunar Postcards T3 toy",
    url: "https://github.com/Drew-Goddyn/jules-toys/pull/87",
    body: "Refs #86",
    headRefName: "pullfrog/86-lunar-postcards",
    headRefOid: "head-sha",
    baseRefName: "main",
    files: ["gallery-data.js", "tier3/lunar-postcards/index.html", "tier3/lunar-postcards/screenshot.png"]
  }, null, 2)}\n`);
  return metadataPath;
}

async function runNvidiaReviewFixture(tempRoot, server, reportName, options = {}) {
  const metadataPath = writeEvaluatorMetadata(tempRoot);
  const reportPath = path.join(tempRoot, reportName);
  const result = await runNode([
    evaluatorPath,
    "--pr-number", "87",
    "--issue-number", "86",
    "--metadata", metadataPath,
    "--test-outcome", options.testOutcome ?? "success",
    "--browser-smoke", "false",
    "--model-playtest", "true",
    "--model-playtest-provider", "nvidia",
    "--model-playtest-model", options.model ?? "moonshotai/kimi-k2.6",
    "--nvidia-api-key", "test-key",
    "--nvidia-endpoint", server.url,
    "--output-dir", path.join(tempRoot, "evaluation"),
    "--report", reportPath
  ], { cwd: repoRoot });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(fs.readFileSync(reportPath, "utf8"));
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
      browser_smoke: { status: "pass", screenshot: "pullfrog-evaluation/browser-smoke.png" },
      playtest_trace: makePlaytestTrace()
    },
    model_playtest_review: {
      status: "skipped",
      provider: "gemini",
      model: "gemini-3.5-flash",
      reason: "Gemini playtest review is disabled."
    },
    recommendation: {
      mechanical_pass: true,
      deterministic_label: "experiment:accepted",
      known_gaps: []
    }
  };
}

function makeLegacyReport(runId) {
  const report = makeReport(runId);
  delete report.deterministic.playtest_trace;
  delete report.model_playtest_review;
  return report;
}

function makePlaytestTrace() {
  return {
    status: "completed",
    load_status: {
      status: "pass",
      ready_state: "complete",
      navigation_error: null
    },
    console_errors: [],
    page_errors: [],
    initial_screenshot: "pullfrog-evaluation/playtest-initial.png",
    candidate_actionable_controls: [{
      index: 0,
      tag: "button",
      role: null,
      type: "button",
      text: "Start",
      aria_label: null,
      disabled: false,
      href: null,
      center_x: 100,
      center_y: 100,
      width: 80,
      height: 32
    }],
    attempted_interactions: [{
      type: "control-click",
      status: "attempted",
      target: {
        index: 0,
        tag: "button",
        role: null,
        type: "button",
        text: "Start",
        aria_label: null
      },
      x: 100,
      y: 100
    }],
    before_evidence: {
      url: "http://127.0.0.1/example",
      title: "Example",
      text_hash: "before",
      text_sample: "Start",
      control_count: 1,
      canvas_count: 0,
      screenshot: "pullfrog-evaluation/playtest-initial.png",
      screenshot_analysis: { status: "pass", nonblank: true }
    },
    after_evidence: {
      url: "http://127.0.0.1/example",
      title: "Example",
      text_hash: "after",
      text_sample: "Level complete",
      control_count: 1,
      canvas_count: 0,
      screenshot: "pullfrog-evaluation/playtest-after-interaction.png",
      screenshot_analysis: { status: "pass", nonblank: true }
    },
    state_changed: true,
    state_change_reasons: ["text_changed", "pixels_changed"],
    feedback_observed: {
      success_failure_progress: true,
      keywords: ["complete"],
      reason: "Post-interaction text exposed success, failure, or progress language that was not present before the action."
    },
    mechanical_status: "pass",
    reason: "The page loaded, an interaction was attempted, and deterministic evidence changed or exposed feedback."
  };
}
