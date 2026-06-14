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

const rootDir = process.cwd();
const wavePath = path.join(rootDir, "specimens", "pullfrog", "waves", "wave0-framework.json");
const invalidEvidencePath = path.join(rootDir, "tests", "fixtures", "pullfrog-wave", "invalid-missing-scorecard-evidence.json");

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
