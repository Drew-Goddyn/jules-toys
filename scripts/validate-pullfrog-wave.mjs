#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCORECARD_DIMENSIONS = [
  "mechanics_depth",
  "onboarding_clarity",
  "goal_state",
  "replay_value",
  "visual_polish",
  "browser_correctness",
  "prompt_adherence",
  "review_burden"
];

export const CELL_TYPES = [
  "baseline_prompt",
  "onboarding_heavy_prompt",
  "mechanics_depth_prompt",
  "visual_polish_prompt",
  "rerun_variance"
];

export const CELL_STATUSES = [
  "planned",
  "running",
  "passed",
  "failed",
  "blocked",
  "rejected"
];

export const ALLOWED_MODELS = [
  "opencode/big-pickle"
];

export const REQUIRED_REPORT_TASKS = [
  "extract_known_gaps",
  "classify_failure_modes",
  "compare_scorecard_deltas",
  "summarize_evidence",
  "mark_blocked_honestly"
];

export const REQUIRED_REJECTION_CRITERIA = [
  "missing_artifact",
  "missing_screenshot",
  "missing_deterministic_report",
  "unparseable_scorecard",
  "uncited_claim",
  "duplicate_or_ambiguous_cell_identity",
  "manual_specimen_data_repair",
  "missing_synthesis"
];

const REQUIRED_SYNTHESIS_STEPS = [
  "compare_cells",
  "identify_repeated_failure_modes",
  "separate_effects",
  "record_killed_hypotheses",
  "recommend_next_smallest_wave"
];

const EVIDENCE_PATTERN = /^(?:report|screenshot|scorecard|observation|manifest|issue|pr|artifact|workflow|synthesis):.+/;

export function loadPullfrogWaveManifest(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

export function validatePullfrogWaveManifest(manifest) {
  const errors = [];
  validateManifest(manifest, errors);
  if (errors.length > 0) {
    throw new Error(`Pullfrog wave manifest is invalid:\n- ${errors.join("\n- ")}`);
  }
  return true;
}

function validateManifest(manifest, errors) {
  requireObject(manifest, "manifest", errors);
  if (errors.length > 0) return;

  if (manifest.schema_version !== 1) {
    errors.push("schema_version must be 1.");
  }
  requireNonEmptyString(manifest.wave_id, "wave_id", errors);
  requireNonEmptyString(manifest.title, "title", errors);
  requireNonEmptyString(manifest.learning_question, "learning_question", errors);

  requireArray(manifest.cell_types_supported, "cell_types_supported", errors);
  for (const cellType of CELL_TYPES) {
    if (!manifest.cell_types_supported?.includes(cellType)) {
      errors.push(`cell_types_supported must include ${cellType}.`);
    }
  }

  requireArray(manifest.cells, "cells", errors);
  validateCells(manifest.cells ?? [], errors);
  validateWorkerReportContract(manifest.worker_report_contract, errors);
  validateRejectionCriteria(manifest.rejection_criteria, errors);
  validateSynthesis(manifest.synthesis, errors);
  validatePersistenceSafety(manifest.persistence_safety, errors);
}

function validateCells(cells, errors) {
  const cellIds = new Set();
  const tupleKeys = new Set();

  for (const [index, cell] of cells.entries()) {
    const label = `cells[${index}]`;
    requireObject(cell, label, errors);
    if (!cell || typeof cell !== "object") continue;

    requireNonEmptyString(cell.cell_id, `${label}.cell_id`, errors);
    requireNonEmptyString(cell.wave_id, `${label}.wave_id`, errors);
    requireNonEmptyString(cell.question, `${label}.question`, errors);

    if (cellIds.has(cell.cell_id)) {
      errors.push(`Duplicate cell_id: ${cell.cell_id}.`);
    }
    cellIds.add(cell.cell_id);

    if (!CELL_TYPES.includes(cell.cell_type)) {
      errors.push(`${label}.cell_type must be one of ${CELL_TYPES.join(", ")}.`);
    }
    if (!CELL_STATUSES.includes(cell.status)) {
      errors.push(`${label}.status must be one of ${CELL_STATUSES.join(", ")}.`);
    }

    validatePromptVariant(cell.prompt_variant, `${label}.prompt_variant`, errors);
    if (!ALLOWED_MODELS.includes(cell.model)) {
      errors.push(`${label}.model must be one of ${ALLOWED_MODELS.join(", ")}.`);
    }
    validateEvidenceArray(cell.evidence, `${label}.evidence`, errors);
    requireNonEmptyString(cell.final_disposition, `${label}.final_disposition`, errors);

    if (cell.status === "blocked") {
      requireNonEmptyString(cell.blocked_reason, `${label}.blocked_reason`, errors);
    }

    validateReference(cell.source_issue, `${label}.source_issue`, cell, errors);
    validateReference(cell.build_pr, `${label}.build_pr`, cell, errors);
    validateReference(cell.evaluation_run, `${label}.evaluation_run`, cell, errors);
    validateArtifactName(cell, label, errors);
    validateArtifactReference(cell.browser_screenshot, `${label}.browser_screenshot`, cell, errors);
    validateArtifactReference(cell.deterministic_report, `${label}.deterministic_report`, cell, errors);
    validateScorecard(cell.scorecard, `${label}.scorecard`, cell, errors);
    validateSynthesisReference(cell.synthesis_reference, `${label}.synthesis_reference`, cell, errors);
    validateObservables(cell.observables, `${label}.observables`, errors);

    const tupleKey = [
      cell.wave_id,
      cell.cell_type,
      cell.prompt_variant?.id,
      cell.model,
      refIdentity(cell.source_issue),
      refIdentity(cell.build_pr),
      refIdentity(cell.evaluation_run),
      cell.artifact_name ?? "artifact:null",
      cell.final_disposition
    ].join("|");
    if (tupleKeys.has(tupleKey)) {
      errors.push(`Duplicate or ambiguous cell tuple for ${cell.cell_id}.`);
    }
    tupleKeys.add(tupleKey);
  }
}

function validatePromptVariant(value, label, errors) {
  requireObject(value, label, errors);
  if (!value || typeof value !== "object") return;
  requireNonEmptyString(value.id, `${label}.id`, errors);
  requireNonEmptyString(value.summary, `${label}.summary`, errors);
}

function validateReference(value, label, cell, errors) {
  requireObject(value, label, errors);
  if (!value || typeof value !== "object") return;

  requireNonEmptyString(value.status, `${label}.status`, errors);
  validateEvidenceArray(value.evidence, `${label}.evidence`, errors);

  const hasNumber = Number.isInteger(value.number) && value.number > 0;
  const hasRunId = Number.isInteger(value.run_id) && value.run_id > 0;
  const hasConcreteId = hasNumber || hasRunId;
  if (cell.status !== "blocked" && !hasConcreteId) {
    errors.push(`${label} must include a positive number or run_id unless the cell is blocked.`);
  }
  if (cell.status === "blocked") {
    requireNonEmptyString(value.blocked_reason, `${label}.blocked_reason`, errors);
  }
}

function validateArtifactName(cell, label, errors) {
  if (typeof cell.artifact_name === "string" && cell.artifact_name.trim()) {
    return;
  }
  if (cell.status === "blocked" && cell.blocked_reason) {
    return;
  }
  errors.push(`${label}.artifact_name must be non-empty unless the cell is blocked.`);
}

function validateArtifactReference(value, label, cell, errors) {
  requireObject(value, label, errors);
  if (!value || typeof value !== "object") return;

  requireNonEmptyString(value.status, `${label}.status`, errors);
  validateEvidenceArray(value.evidence, `${label}.evidence`, errors);

  const hasPath = typeof value.path === "string" && value.path.trim();
  if (cell.status !== "blocked" && !hasPath) {
    errors.push(`${label}.path must be non-empty unless the cell is blocked.`);
  }
  if (cell.status === "blocked") {
    requireNonEmptyString(value.blocked_reason, `${label}.blocked_reason`, errors);
  }
}

function validateScorecard(scorecard, label, cell, errors) {
  requireObject(scorecard, label, errors);
  if (!scorecard || typeof scorecard !== "object") return;

  requireNonEmptyString(scorecard.status, `${label}.status`, errors);
  requireObject(scorecard.dimensions, `${label}.dimensions`, errors);
  if (!scorecard.dimensions || typeof scorecard.dimensions !== "object") return;

  for (const dimension of SCORECARD_DIMENSIONS) {
    const entry = scorecard.dimensions[dimension];
    const entryLabel = `${label}.dimensions.${dimension}`;
    requireObject(entry, entryLabel, errors);
    if (!entry || typeof entry !== "object") continue;

    if (entry.score === null) {
      if (cell.status !== "blocked") {
        errors.push(`${entryLabel}.score may be null only when the cell status is blocked.`);
      }
      requireNonEmptyString(cell.blocked_reason, `${label}.blocked_reason`, errors);
      requireNonEmptyString(entry.blocked_reason, `${entryLabel}.blocked_reason`, errors);
    } else if (!Number.isInteger(entry.score) || entry.score < 1 || entry.score > 5) {
      errors.push(`${entryLabel}.score must be an integer from 1 to 5, or null for blocked cells.`);
    }

    requireNonEmptyString(entry.rationale, `${entryLabel}.rationale`, errors);
    validateEvidenceArray(entry.evidence, `${entryLabel}.evidence`, errors);
  }

  const extraDimensions = Object.keys(scorecard.dimensions).filter((dimension) => !SCORECARD_DIMENSIONS.includes(dimension));
  for (const dimension of extraDimensions) {
    errors.push(`${label}.dimensions has unsupported dimension ${dimension}.`);
  }
}

function validateSynthesisReference(value, label, cell, errors) {
  if (cell.status === "blocked" && value === undefined) {
    return;
  }

  requireObject(value, label, errors);
  if (!value || typeof value !== "object") return;

  requireNonEmptyString(value.status, `${label}.status`, errors);
  requireNonEmptyString(value.path, `${label}.path`, errors);
  validateEvidenceArray(value.evidence, `${label}.evidence`, errors);
}

function validateObservables(value, label, errors) {
  requireArray(value, label, errors);
  for (const [index, observable] of (value ?? []).entries()) {
    requireNonEmptyString(observable, `${label}[${index}]`, errors);
  }
}

function validateWorkerReportContract(contract, errors) {
  requireObject(contract, "worker_report_contract", errors);
  if (!contract || typeof contract !== "object") return;

  requireArray(contract.tasks, "worker_report_contract.tasks", errors);
  const taskTypes = new Set((contract.tasks ?? []).map((task) => task?.task_type));
  for (const taskType of REQUIRED_REPORT_TASKS) {
    if (!taskTypes.has(taskType)) {
      errors.push(`worker_report_contract.tasks must include ${taskType}.`);
    }
  }

  requireObject(contract.jules_policy, "worker_report_contract.jules_policy", errors);
  if (contract.jules_policy && typeof contract.jules_policy === "object") {
    if (contract.jules_policy.required !== false) {
      errors.push("worker_report_contract.jules_policy.required must be false.");
    }
    if (contract.jules_policy.max_cells_per_assignment !== 1) {
      errors.push("worker_report_contract.jules_policy.max_cells_per_assignment must be 1.");
    }
    requireNonEmptyString(contract.jules_policy.blocked_path, "worker_report_contract.jules_policy.blocked_path", errors);
  }
}

function validateRejectionCriteria(criteria, errors) {
  requireArray(criteria, "rejection_criteria", errors);
  const ids = new Set((criteria ?? []).map((criterion) => criterion?.id));
  for (const id of REQUIRED_REJECTION_CRITERIA) {
    if (!ids.has(id)) {
      errors.push(`rejection_criteria must include ${id}.`);
    }
  }
}

function validateSynthesis(synthesis, errors) {
  requireObject(synthesis, "synthesis", errors);
  if (!synthesis || typeof synthesis !== "object") return;

  requireNonEmptyString(synthesis.path, "synthesis.path", errors);
  requireArray(synthesis.procedure, "synthesis.procedure", errors);
  const stepIds = new Set((synthesis.procedure ?? []).map((step) => step?.id));
  for (const id of REQUIRED_SYNTHESIS_STEPS) {
    if (!stepIds.has(id)) {
      errors.push(`synthesis.procedure must include ${id}.`);
    }
  }
}

function validatePersistenceSafety(safety, errors) {
  requireObject(safety, "persistence_safety", errors);
  if (!safety || typeof safety !== "object") return;

  if (safety.guard !== "github_actions_job_concurrency") {
    errors.push("persistence_safety.guard must be github_actions_job_concurrency.");
  }
  if (safety.job !== "persist-specimen-lab") {
    errors.push("persistence_safety.job must be persist-specimen-lab.");
  }
  requireNonEmptyString(safety.group, "persistence_safety.group", errors);
  if (safety.cancel_in_progress !== false) {
    errors.push("persistence_safety.cancel_in_progress must be false.");
  }
}

function validateEvidenceArray(value, label, errors) {
  requireArray(value, label, errors);
  if (!Array.isArray(value)) return;
  if (value.length === 0) {
    errors.push(`${label} must include at least one evidence pointer.`);
  }
  for (const [index, pointer] of value.entries()) {
    if (typeof pointer !== "string" || !EVIDENCE_PATTERN.test(pointer)) {
      errors.push(`${label}[${index}] must be a machine-readable evidence pointer.`);
    }
  }
}

function refIdentity(ref) {
  if (!ref || typeof ref !== "object") return "missing";
  return [
    ref.number ?? ref.run_id ?? "null",
    ref.url ?? "url:null",
    ref.status ?? "status:null"
  ].join(":");
}

function requireObject(value, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
  }
}

function requireArray(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
  }
}

function requireNonEmptyString(value, label, errors) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label} must be a non-empty string.`);
  }
}

function main() {
  const manifestPath = process.argv[2] ?? path.join("specimens", "pullfrog", "waves", "wave0-framework.json");
  const manifest = loadPullfrogWaveManifest(manifestPath);
  validatePullfrogWaveManifest(manifest);
  console.log(`Validated Pullfrog wave manifest: ${manifestPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
