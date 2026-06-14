#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_SYNTHESIS_SECTIONS = [
  "Comparison Matrix",
  "Repeated Failure Modes",
  "Effects Separation",
  "Killed Hypotheses",
  "Non-Killable Hypotheses",
  "Recommendation",
  "Live Wave 1 Blockers"
];

export const ALLOWED_RECOMMENDATIONS = [
  "ready for a tiny live Wave 1",
  "needs more framework hardening",
  "should stop because the measurement contract is still not trustworthy"
];

const CITATION_PATTERN = /\[(?:report|screenshot|scorecard|observation|manifest|issue|pr|artifact|workflow|synthesis):[^\]]+\]/;
const REQUIRED_FAILURE_MODE_TERMS = [
  "mechanics_depth",
  "onboarding_clarity",
  "visual_polish",
  "review_burden"
];
const REQUIRED_EFFECT_TERMS = [
  "prompt",
  "model",
  "workflow",
  "specimen-topic"
];

export function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

export function loadMarkdown(filePath) {
  return fs.readFileSync(path.resolve(filePath), "utf8");
}

export function validatePullfrogSynthesis(manifest, markdown) {
  const errors = [];
  const sections = parseSections(markdown);

  for (const sectionName of REQUIRED_SYNTHESIS_SECTIONS) {
    if (!sections.has(sectionName)) {
      errors.push(`synthesis must include section "${sectionName}".`);
    }
  }

  validateComparisonSection(manifest, sections.get("Comparison Matrix") ?? [], errors);
  validateRepeatedFailureModes(sections.get("Repeated Failure Modes") ?? [], errors);
  validateEffectsSeparation(sections.get("Effects Separation") ?? [], errors);
  validateHypothesisSection("Killed Hypotheses", sections.get("Killed Hypotheses") ?? [], errors);
  validateHypothesisSection("Non-Killable Hypotheses", sections.get("Non-Killable Hypotheses") ?? [], errors);
  validateRecommendation(sections.get("Recommendation") ?? [], errors);
  validateBlockers(sections.get("Live Wave 1 Blockers") ?? [], errors);
  validateMaterialClaimsAreCited(sections, errors);

  if (errors.length > 0) {
    throw new Error(`Pullfrog synthesis is invalid:\n- ${errors.join("\n- ")}`);
  }
  return true;
}

function validateComparisonSection(manifest, lines, errors) {
  const text = lines.join("\n");
  const cells = Array.isArray(manifest?.cells) ? manifest.cells : [];

  for (const cell of cells) {
    if (!text.includes(cell.cell_id)) {
      errors.push(`Comparison Matrix must compare cell ${cell.cell_id}.`);
    }
    const prNumber = cell.build_pr?.number;
    if (Number.isInteger(prNumber) && !text.includes(`PR #${prNumber}`)) {
      errors.push(`Comparison Matrix must cite PR #${prNumber}.`);
    }
  }
}

function validateRepeatedFailureModes(lines, errors) {
  const text = lines.join("\n");
  for (const term of REQUIRED_FAILURE_MODE_TERMS) {
    if (!text.includes(term)) {
      errors.push(`Repeated Failure Modes must classify ${term}.`);
    }
  }
}

function validateEffectsSeparation(lines, errors) {
  const text = lines.join("\n").toLowerCase();
  for (const term of REQUIRED_EFFECT_TERMS) {
    if (!text.includes(term)) {
      errors.push(`Effects Separation must address ${term} effects.`);
    }
  }
}

function validateHypothesisSection(sectionName, lines, errors) {
  if (!bulletLines(lines).length) {
    errors.push(`${sectionName} must include at least one cited bullet.`);
  }
}

function validateRecommendation(lines, errors) {
  const recommendations = bulletLines(lines).filter((line) => line.includes("Recommendation:"));
  if (recommendations.length !== 1) {
    errors.push("Recommendation must include exactly one Recommendation bullet.");
    return;
  }

  const matchingRecommendations = ALLOWED_RECOMMENDATIONS.filter((recommendation) => (
    recommendations[0].includes(recommendation)
  ));
  if (matchingRecommendations.length !== 1) {
    errors.push(`Recommendation must state exactly one of: ${ALLOWED_RECOMMENDATIONS.join("; ")}.`);
  }
}

function validateBlockers(lines, errors) {
  const text = lines.join("\n").toLowerCase();
  if (!bulletLines(lines).length || !text.includes("block")) {
    errors.push("Live Wave 1 Blockers must state what still blocks live Wave 1.");
  }
}

function validateMaterialClaimsAreCited(sections, errors) {
  for (const sectionName of REQUIRED_SYNTHESIS_SECTIONS) {
    for (const line of bulletLines(sections.get(sectionName) ?? [])) {
      if (!CITATION_PATTERN.test(line)) {
        errors.push(`${sectionName} contains an uncited material claim: ${line}`);
      }
    }
  }
}

function parseSections(markdown) {
  const sections = new Map();
  let currentSection = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      currentSection = heading[1].trim();
      sections.set(currentSection, []);
      continue;
    }
    if (currentSection) {
      sections.get(currentSection).push(line);
    }
  }

  return sections;
}

function bulletLines(lines) {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
}

function main() {
  const manifestPath = process.argv[2] ?? path.join("specimens", "pullfrog", "waves", "wave05-dry-rehearsal.json");
  const synthesisPath = process.argv[3] ?? path.join("docs", "pullfrog-fleet", "synthesis", "wave05-dry-rehearsal.md");
  validatePullfrogSynthesis(loadJson(manifestPath), loadMarkdown(synthesisPath));
  console.log(`Validated Pullfrog synthesis: ${synthesisPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
