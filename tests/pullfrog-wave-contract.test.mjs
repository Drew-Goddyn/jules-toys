import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_MODELS,
  CELL_TYPES,
  REQUIRED_REJECTION_CRITERIA,
  SCORECARD_DIMENSIONS,
  loadPullfrogWaveManifest,
  validatePullfrogWaveManifest
} from "../scripts/validate-pullfrog-wave.mjs";
import {
  loadJson,
  loadMarkdown,
  validatePullfrogSynthesis
} from "../scripts/validate-pullfrog-synthesis.mjs";

const rootDir = process.cwd();
const wavePath = path.join(rootDir, "specimens", "pullfrog", "waves", "wave0-framework.json");
const dryWavePath = path.join(rootDir, "specimens", "pullfrog", "waves", "wave05-dry-rehearsal.json");
const drySynthesisPath = path.join(rootDir, "docs", "pullfrog-fleet", "synthesis", "wave05-dry-rehearsal.md");
const validCompletedPath = path.join(rootDir, "tests", "fixtures", "pullfrog-wave", "valid-completed-cell.json");
const invalidEvidencePath = path.join(rootDir, "tests", "fixtures", "pullfrog-wave", "invalid-missing-scorecard-evidence.json");
const invalidSynthesisPath = path.join(rootDir, "tests", "fixtures", "pullfrog-synthesis", "invalid-missing-citation.md");

test("Wave 0 manifest is inert and covers the required future cell types", () => {
  const manifest = loadPullfrogWaveManifest(wavePath);

  assert.doesNotThrow(() => validatePullfrogWaveManifest(manifest));
  assert.equal(manifest.launch_authorization.toy_issue_creation, false);
  assert.equal(manifest.launch_authorization.toy_pr_creation, false);
  assert.equal(manifest.launch_authorization.workflow_dispatch, false);
  assert.equal(manifest.launch_authorization.specimen_data_manual_edits, false);
  assert.deepEqual(new Set(manifest.cell_types_supported), new Set(CELL_TYPES));
  assert.deepEqual(new Set(manifest.cells.map((cell) => cell.cell_type)), new Set(CELL_TYPES));
});

test("Wave 0 scorecard declares every required dimension with evidence", () => {
  const manifest = loadPullfrogWaveManifest(wavePath);

  for (const cell of manifest.cells) {
    assert.equal(cell.status, "blocked");
    assert.ok(cell.blocked_reason);
    assert.deepEqual(new Set(Object.keys(cell.scorecard.dimensions)), new Set(SCORECARD_DIMENSIONS));
    for (const dimension of SCORECARD_DIMENSIONS) {
      const entry = cell.scorecard.dimensions[dimension];
      assert.equal(entry.score, null);
      assert.ok(entry.blocked_reason);
      assert.ok(entry.evidence.length > 0);
    }
  }
});

test("validator rejects duplicate cell identity", () => {
  const manifest = clone(loadPullfrogWaveManifest(wavePath));
  manifest.cells[1].cell_id = manifest.cells[0].cell_id;

  assert.throws(
    () => validatePullfrogWaveManifest(manifest),
    /Duplicate cell_id/
  );

  const ambiguous = clone(loadPullfrogWaveManifest(wavePath));
  const duplicate = clone(ambiguous.cells[0]);
  duplicate.cell_id = "W1-DUP";
  ambiguous.cells.push(duplicate);

  assert.throws(
    () => validatePullfrogWaveManifest(ambiguous),
    /Duplicate or ambiguous cell tuple/
  );
});

test("validator accepts a completed-cell fixture with artifact, report, screenshot, scores, and synthesis", () => {
  const manifest = loadPullfrogWaveManifest(validCompletedPath);

  assert.doesNotThrow(() => validatePullfrogWaveManifest(manifest));
  assert.equal(manifest.cells[0].status, "passed");
  assert.ok(manifest.cells[0].artifact_name);
  assert.ok(manifest.cells[0].browser_screenshot.path);
  assert.ok(manifest.cells[0].deterministic_report.path);
  assert.ok(manifest.cells[0].synthesis_reference.path);
  for (const dimension of SCORECARD_DIMENSIONS) {
    assert.match(String(manifest.cells[0].scorecard.dimensions[dimension].score), /^[1-5]$/);
  }
});

for (const { name, mutate, pattern } of [
  {
    name: "missing artifact",
    mutate: (manifest) => {
      manifest.cells[0].artifact_name = null;
    },
    pattern: /artifact_name must be non-empty/
  },
  {
    name: "missing screenshot",
    mutate: (manifest) => {
      manifest.cells[0].browser_screenshot.path = null;
    },
    pattern: /browser_screenshot\.path must be non-empty/
  },
  {
    name: "missing deterministic report",
    mutate: (manifest) => {
      manifest.cells[0].deterministic_report.path = null;
    },
    pattern: /deterministic_report\.path must be non-empty/
  },
  {
    name: "missing synthesis reference",
    mutate: (manifest) => {
      delete manifest.cells[0].synthesis_reference;
    },
    pattern: /synthesis_reference must be an object/
  },
  {
    name: "missing synthesis procedure",
    mutate: (manifest) => {
      delete manifest.synthesis;
    },
    pattern: /synthesis must be an object/
  }
]) {
  test(`validator rejects completed cells with ${name}`, () => {
    const manifest = clone(loadPullfrogWaveManifest(validCompletedPath));
    mutate(manifest);

    assert.throws(
      () => validatePullfrogWaveManifest(manifest),
      pattern
    );
  });
}

test("validator rejects models outside the allowed free-model path", () => {
  const manifest = clone(loadPullfrogWaveManifest(wavePath));
  assert.deepEqual(ALLOWED_MODELS, ["opencode/big-pickle"]);
  manifest.cells[0].model = "gpt-5.5";

  assert.throws(
    () => validatePullfrogWaveManifest(manifest),
    /model must be one of opencode\/big-pickle/
  );
});

test("validator rejects scorecard dimensions without evidence pointers", () => {
  const manifest = loadPullfrogWaveManifest(invalidEvidencePath);

  assert.throws(
    () => validatePullfrogWaveManifest(manifest),
    /scorecard\.dimensions\.mechanics_depth\.evidence must include at least one evidence pointer/
  );
});

test("validator allows null scores only for blocked cells with reasons", () => {
  const manifest = clone(loadPullfrogWaveManifest(wavePath));
  manifest.cells[0].status = "failed";

  assert.throws(
    () => validatePullfrogWaveManifest(manifest),
    /score may be null only when the cell status is blocked/
  );

  const missingReason = clone(loadPullfrogWaveManifest(wavePath));
  delete missingReason.cells[0].scorecard.dimensions.mechanics_depth.blocked_reason;

  assert.throws(
    () => validatePullfrogWaveManifest(missingReason),
    /scorecard\.dimensions\.mechanics_depth\.blocked_reason/
  );
});

test("validator rejects manifests without the full rejection criteria set", () => {
  const manifest = clone(loadPullfrogWaveManifest(wavePath));
  manifest.rejection_criteria = manifest.rejection_criteria.filter((criterion) => criterion.id !== "missing_synthesis");

  assert.throws(
    () => validatePullfrogWaveManifest(manifest),
    /rejection_criteria must include missing_synthesis/
  );
  assert.deepEqual(new Set(REQUIRED_REJECTION_CRITERIA).has("manual_specimen_data_repair"), true);
});

test("validating the framework does not mutate live specimen data", () => {
  const before = fs.readFileSync(path.join(rootDir, "specimens", "pullfrog", "specimens.json"), "utf8");

  validatePullfrogWaveManifest(loadPullfrogWaveManifest(wavePath));

  const after = fs.readFileSync(path.join(rootDir, "specimens", "pullfrog", "specimens.json"), "utf8");
  assert.equal(after, before);
});

test("Wave 0.5 dry rehearsal manifest validates existing specimen-derived cells without mutating live specimens", () => {
  const before = fs.readFileSync(path.join(rootDir, "specimens", "pullfrog", "specimens.json"), "utf8");
  const manifest = loadPullfrogWaveManifest(dryWavePath);

  assert.doesNotThrow(() => validatePullfrogWaveManifest(manifest));
  assert.equal(manifest.status, "dry_rehearsal");
  assert.deepEqual(
    manifest.cells.map((cell) => cell.build_pr.number).sort((a, b) => a - b),
    [79, 85, 87]
  );

  const after = fs.readFileSync(path.join(rootDir, "specimens", "pullfrog", "specimens.json"), "utf8");
  assert.equal(after, before);
});

test("dry synthesis quality gate accepts the cited Wave 0.5 synthesis", () => {
  assert.doesNotThrow(() => validatePullfrogSynthesis(
    loadJson(dryWavePath),
    loadMarkdown(drySynthesisPath)
  ));
});

test("dry synthesis quality gate rejects uncited material claims", () => {
  assert.throws(
    () => validatePullfrogSynthesis(
      loadJson(dryWavePath),
      loadMarkdown(invalidSynthesisPath)
    ),
    /uncited material claim/
  );
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
