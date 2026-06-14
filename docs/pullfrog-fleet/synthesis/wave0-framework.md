# Wave 0 Framework Synthesis

## Evidence

- Branch `codex/pullfrog-specimen-lab-wave0-framework` was created from refreshed `origin/main` before repo edits.
- Local and live Specimen Lab JSON matched before editing: schema version 1, three accepted specimens, all scored 3 on `opencode/big-pickle`.
- The Wave 0 manifest is inert: it names Wave 1 cells but blocks issue creation, PR creation, workflow dispatch, and manual specimen-data edits.
- The validator and tests reject duplicate cell identity, missing scorecard evidence, null scores outside BLOCKED cells, and missing rejection criteria.
- The `persist-specimen-lab` job now has a job-level concurrency group with `cancel-in-progress: false`.

## Killed Hypotheses

- "A bigger batch alone will teach us more" is not accepted. A wave without cited scorecards and synthesis is rejected.
- "The single 1-5 quality score is enough" is not accepted. Future cells must use the eight-dimension scorecard.
- "Missing artifacts can be patched later" is not accepted. Missing artifact, screenshot, deterministic report, or parseable scorecard rejects the cell.
- "Manual specimen JSON repair is equivalent to persistence" is not accepted. Evaluator persistence remains the only approved specimen-data writer.

## Next Smallest Wave

Authorize only a tiny Wave 1 after reviewing this framework:

- `W1-BL`: baseline current prompt/path.
- `W1-ON`: onboarding-heavy prompt.
- `W1-MD`: mechanics-depth prompt.
- `W1-VP`: visual-polish prompt.
- `W1-RV`: rerun/variance cell.

Stop after one run per authorized cell. Reject incomplete reports. Synthesize before launching additional cells.
