#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { updateSpecimenLab } from "./specimen-lab-data.mjs";

const args = parseArgs(process.argv.slice(2));
const rootDir = path.resolve(args.rootDir ?? process.cwd());
const report = readJson(required(args.report, "--report"));
const judge = args.judge ? readJson(args.judge) : parseJson(args.judgeJson, null);
const specimen = updateSpecimenLab(rootDir, {
  report,
  judge,
  artifactDir: path.resolve(rootDir, required(args.artifactDir, "--artifact-dir")),
  prCommentUrl: args.prCommentUrl ?? null,
  issueCommentUrl: args.issueCommentUrl ?? null,
  scorecardMarker: args.scorecardMarker ?? "<!-- pullfrog-experiment-evaluator:v2 -->",
  artifactName: args.artifactName ?? `pullfrog-experiment-evaluation-${report.pr?.number}`,
  qualityThreshold: Number(args.qualityThreshold ?? 3)
});

console.log(`Updated Specimen Lab record for PR #${specimen.pr.number}: ${specimen.status}, ${specimen.comparison.run_count} run(s).`);

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

function required(value, label) {
  if (!value) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function parseJson(value, fallback) {
  if (!value) {
    return fallback;
  }
  return JSON.parse(value);
}
