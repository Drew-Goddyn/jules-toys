# Pullfrog Fleet Framework

Wave 0 hardens the Specimen Lab into a controlled learning framework. It does not launch toys, dispatch Pullfrog, create issues, create PRs, or edit `specimens/pullfrog/specimens.json` by hand.

## Vocabulary

- `wave`: one bounded learning question with a stop condition. A wave is not successful because it ran many cells; it is successful only when its synthesis changes what the next wave should do.
- `cell`: one prompt, model, workflow, and specimen target variant. A cell may be `planned`, `running`, `passed`, `failed`, `blocked`, or `rejected`.
- `specimen`: the source issue, build PR, evaluator run, artifact, screenshot, deterministic report, scorecard, observables, and final disposition for one cell.
- `run`: one execution of a cell. Reruns are separate runs and must keep their lineage visible.
- `scorecard`: eight dimension scores with citations. The dimensions are `mechanics_depth`, `onboarding_clarity`, `goal_state`, `replay_value`, `visual_polish`, `browser_correctness`, `prompt_adherence`, and `review_burden`.
- `synthesis`: the durable comparison after a wave. It separates prompt, model, workflow, and specimen-topic effects before recommending the next smallest useful wave.

## Cell Tuple

Every cell must name the full specimen tuple:

- `source_issue`
- `build_pr`
- `evaluation_run`
- `model`
- `prompt_variant`
- `artifact_name`
- `browser_screenshot`
- `deterministic_report`
- `scorecard`
- `observables`
- `final_disposition`

Blocked cells may use null artifact, screenshot, report, and score values only when the cell and each null score include a concrete `blocked_reason`. Passed, failed, or rejected cells must cite real artifact, screenshot, deterministic report, and scorecard evidence.

## Scorecard Rules

Each dimension uses a 1-5 integer score:

- `1`: unusable or misleading.
- `3`: acceptable but clearly limited.
- `5`: strong enough to raise the future quality bar.

Every scored dimension must include a short rationale and at least one machine-readable evidence pointer. Pointers use prefixes such as `report:`, `screenshot:`, `scorecard:`, `observation:`, `manifest:`, `issue:`, `pr:`, `artifact:`, `workflow:`, or `synthesis:`.

## Worker Report Tasks

Small-worker assignments should be bounded to report extraction, not open-ended judging:

- extract known gaps from deterministic report, judge output, screenshots, and review notes
- classify failure modes against the framework vocabulary
- compare scorecard deltas across reruns or prompt variants
- summarize evidence with citations
- mark `BLOCKED` honestly when required inputs are missing

Jules is optional throughput only. A Jules assignment may cover at most one cell or one report extraction task, must produce the requested structured output, and must take the explicit BLOCKED path if GitHub, artifacts, screenshots, or reports are unavailable.

## Rejection Criteria

A cell or wave result is rejected when any of these occur:

- missing artifact
- missing browser screenshot
- missing deterministic evaluator report
- unparseable scorecard
- uncited claim
- duplicate or ambiguous cell identity
- manual specimen-data repair masquerading as evaluator persistence
- missing synthesis

Rejected work may still be useful evidence, but it does not count as a quality or process win.

## Synthesis Procedure

After every wave:

1. Compare cells by scorecard dimension and deterministic checks.
2. Identify repeated failure modes and one-off specimen-topic effects.
3. Separate prompt effects, model effects, workflow effects, and specimen-topic effects.
4. Record killed hypotheses and why the evidence killed them.
5. Recommend the next smallest useful wave, or stop if the measurement contract is still not trustworthy.

Future wave synthesis should live under `docs/pullfrog-fleet/synthesis/`. Wave 0's inert manifest points at `docs/pullfrog-fleet/synthesis/wave0-framework.md` as the first durable synthesis target.
