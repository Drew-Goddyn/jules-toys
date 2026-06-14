# Wave 0.5 Dry Rehearsal Synthesis

This dry rehearsal uses only the existing accepted Specimen Lab records. The cells below are pseudo-cells for measurement rehearsal, not controlled prompt variants and not new Pullfrog runs.

## Comparison Matrix

- W05-PR79 / PR #79 / Signal Cabinet Relay: score 3, six known gaps, artifact `pullfrog-experiment-evaluation-79`, screenshot `specimen-lab/pullfrog/pr-79/browser-smoke.png`, deterministic report `report.json`, weakest dimensions `goal_state` and `replay_value`. [manifest:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/cells/W05-PR79] [pr:https://github.com/Drew-Goddyn/jules-toys/pull/79] [workflow:https://github.com/Drew-Goddyn/jules-toys/actions/runs/27480430420]
- W05-PR85 / PR #85 / Clockwork Canal Locks: score 3, eight known gaps, artifact `pullfrog-experiment-evaluation-85`, screenshot `specimen-lab/pullfrog/pr-85/browser-smoke.png`, deterministic report `report.json`, weakest dimensions `onboarding_clarity`, `visual_polish`, and `review_burden`. [manifest:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/cells/W05-PR85] [pr:https://github.com/Drew-Goddyn/jules-toys/pull/85] [workflow:https://github.com/Drew-Goddyn/jules-toys/actions/runs/27480568238]
- W05-PR87 / PR #87 / Lantern Loom Lab: score 3, five known gaps, artifact `pullfrog-experiment-evaluation-87`, screenshot `specimen-lab/pullfrog/pr-87/browser-smoke.png`, deterministic report `report.json`, weakest dimensions `goal_state`, `replay_value`, and `visual_polish`. [manifest:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/cells/W05-PR87] [pr:https://github.com/Drew-Goddyn/jules-toys/pull/87] [workflow:https://github.com/Drew-Goddyn/jules-toys/actions/runs/27479860208]
- The single accepted score of 3 hides useful differences: W05-PR79 is weakest on goal/replay structure, W05-PR85 has the highest review burden, and W05-PR87 has the fewest gaps but still misses progression and visual intent. [scorecard:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/cells] [manifest:specimens/pullfrog/specimens.json]

## Repeated Failure Modes

- mechanics_depth repeats as a failure mode because every dry cell records shallow or simplified mechanics: linear signal traversal for W05-PR79, simplified lock timing for W05-PR85, and one static beam puzzle for W05-PR87. [manifest:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/cells]
- onboarding_clarity repeats as a failure mode because W05-PR85 lacks tutorials or hints, W05-PR87 has a limited hint button, and W05-PR79 lacks richer affordances even though it does not show first-action confusion. [manifest:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/cells]
- visual_polish repeats as a failure mode because W05-PR85 is functional but not engaging and W05-PR87 misses the requested dark observatory aesthetic; W05-PR79 has weaker screenshot evidence because the captured image is an approximation. [screenshot:specimen-lab/pullfrog/pr-85/browser-smoke.png] [screenshot:specimen-lab/pullfrog/pr-87/browser-smoke.png] [manifest:specimens/pullfrog/specimens.json]
- review_burden repeats as a failure mode because every accepted specimen still carries five or more known gaps, and W05-PR85 reaches eight gaps before any controlled Wave 1 comparison begins. [manifest:specimens/pullfrog/specimens.json]

## Effects Separation

- prompt effects cannot be proven from this dry data because all three records are existing accepted specimens rather than controlled prompt variants; the dry synthesis can only show which dimensions future prompt variants must measure. [manifest:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/source_specimen_snapshot]
- model effects cannot be separated because every dry pseudo-cell uses the same allowed model path, `opencode/big-pickle`, and no alternate model cell exists in the specimen set. [manifest:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/cells]
- workflow effects are visible only as measurement-contract checks: all three dry cells have artifacts, screenshots, reports, and workflow run ids, but this does not prove concurrent persistence behavior under live dispatch pressure. [workflow:https://github.com/Drew-Goddyn/jules-toys/actions/runs/27480430420] [workflow:https://github.com/Drew-Goddyn/jules-toys/actions/runs/27480568238] [workflow:https://github.com/Drew-Goddyn/jules-toys/actions/runs/27479860208]
- specimen-topic effects likely explain some differences: signal relays naturally expose routing/progression gaps, canal locks expose control/onboarding gaps, and beam puzzles expose mirror-rule and aesthetic gaps. [manifest:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/cells]

## Killed Hypotheses

- The single 1-5 score is enough for next-wave decisions is killed because all three specimens scored 3 while their dimension-level failure profiles diverge materially. [scorecard:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/cells]
- A synthesis without citations is acceptable is killed because the quality gate rejects uncited material bullets and this synthesis carries citations on every comparison, failure-mode, hypothesis, blocker, and recommendation claim. [synthesis:docs/pullfrog-fleet/synthesis/wave05-dry-rehearsal.md] [manifest:tests/fixtures/pullfrog-synthesis/invalid-missing-citation.md]
- Existing specimen data is sufficient to compare real prompt variants is killed because the dry cells are explicitly non-experimental mappings from prior accepted specimens. [manifest:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/source_specimen_snapshot]
- A missing artifact, screenshot, or deterministic report can be ignored during synthesis is killed because every dry cell must carry those references and the completed-cell validator rejects missing ones. [artifact:pullfrog-experiment-evaluation-79] [screenshot:specimen-lab/pullfrog/pr-79/browser-smoke.png] [report:pullfrog-experiment-evaluation-79/report.json]

## Non-Killable Hypotheses

- Whether onboarding-heavy, mechanics-depth, or visual-polish prompts outperform baseline remains non-killable because no dry cell was generated from one of those controlled prompt variants. [manifest:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/source_specimen_snapshot]
- Whether Pullfrog behavior has changed since these specimens were generated remains non-killable because the dry wave launches no new Pullfrog runs. [workflow:https://github.com/Drew-Goddyn/jules-toys/actions/runs/27480430420] [workflow:https://github.com/Drew-Goddyn/jules-toys/actions/runs/27480568238] [workflow:https://github.com/Drew-Goddyn/jules-toys/actions/runs/27479860208]
- Whether the GitHub Actions persistence queue works under real concurrent dispatch pressure remains non-killable because the dry wave performs no workflow dispatches. [manifest:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/launch_authorization]

## Recommendation

- Recommendation: ready for a tiny live Wave 1, limited to one baseline cell plus one focused onboarding-heavy variant cell; add a rerun-variance cell only if Drew explicitly wants variance measured immediately. [synthesis:docs/pullfrog-fleet/synthesis/wave05-dry-rehearsal.md#Recommendation] [manifest:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/synthesis]

## Live Wave 1 Blockers

- Live Wave 1 remains blocked until Drew explicitly authorizes creating toy issues, generated PRs, and evaluator workflow dispatches for the selected tiny wave cells. [manifest:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/launch_authorization]
- Live Wave 1 should stay blocked if any selected cell cannot produce an artifact, browser screenshot, deterministic report, scorecard, and cited synthesis record. [manifest:specimens/pullfrog/waves/wave05-dry-rehearsal.json#/rejection_criteria]
- Live Wave 1 should stay blocked if the operator intends to compare more than the smallest falsifiable baseline-plus-one-variant shape before synthesizing the first result. [synthesis:docs/pullfrog-fleet/synthesis/wave05-dry-rehearsal.md#Recommendation]
