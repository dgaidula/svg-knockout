# svg-knockout — maintainer notes

Agent-facing notes for future Claude sessions working on this repo. The
README is for users; this file is for whoever next touches
`svg-knockout.mjs`. Read the whole thing before changing geometry code —
every rule below was paid for with a real-file failure.

## Architecture in one pass

Everything lives in `svg-knockout.mjs`. Per file, `processFile` drives:

1. `runTransforms(text, enabledSet, minAreaSpec)` — parse, model, apply
   the enabled subset of transforms 1–4, splice the output text.
2. `verifyPair(origFile, outText)` — render both with rsvg-convert,
   composite over magenta, masked pixel diff.
3. On verify failure, bisect down `LEVELS` ({1,2,3,4} → {1,2,3} → {1,2} →
   {1}), writing only the passing subset and reporting the rollback.

Key internal stages of `runTransforms`:

- `parseSvg` — minimal tag-tree parser that records **source byte
  offsets** per element (`start`, `openEnd`, `closeStart`, `end`).
  Comments/CDATA are masked with spaces first so offsets stay valid. The
  output is produced by `buildOutput` splicing ranges out of the original
  text — untouched content survives byte-for-byte. Don't replace this
  with a DOM library and a re-serializer; byte fidelity is the point.
- `collectDrawables` — rendered elements in paint order. Every drawable
  is either *eligible* (plain `<path>`, solid fill, no stroke, no
  transform, only trivial `<g>` ancestors) or an *obstacle* that can
  block transforms but is never edited. Unknown geometry (`<text>`,
  unparsable transforms) has a `null` bbox, and **null bbox means
  "intersects everything"** — see `bboxIntersect`.
- Geometry per path (`geom`): svgpath normalize (`abs/unshort/unarc`),
  adaptive cubic flattening (`flattenCubic`) at `tol = min(vb)/8192`,
  shoelace areas, and a y-bucketed edge index (`buildEdgeIndex`) that
  makes winding/parity/distance queries ~O(√E).

## The four transforms and their invariants

Order is 1 → 2 → 3 → 4 and matters: unwrapping first, then dead-weight
removal, so transform 4's occlusion walks see the already-thinned list
(`alive` flags — removed paths stop being blockers, which is what lets a
single ascending pass plus the T4 fixpoint loop cascade correctly).

**T2 specks** (`transform2Specks`): `absArea = Σ|subpath areas|` (holes
overcount, which errs toward keeping). Never the canvas base, never
url() fills (some exports use tiny gradient-filled shapes that must
survive — hard requirement), never strokes.

**T3 redundant** (`transform3Redundant`): walk down from P; the first
alive drawable whose *painted region* truly overlaps P decides — same
solid fill and `contains(B, P)` → P is invisible paint-on-paint, remove;
anything else → it could be uncovered, keep P and stop. Drawables whose
bbox merely grazes are stepped over (`regionsIntersect`), which is what
unlocked dense art; pure-bbox intervening tests blocked nearly
everything on real files.

**T4 knockouts** (`transform4Knockouts`): same walk shape for a white W.
The deciding drawable must be an eligible darker solid that `contains` W
and is not the canvas base; then three more gates:

- `eoSafe(B)` and `eoSafe(W)` — flipping to evenodd must not change what
  the path itself paints. Disjoint-island subpaths are safe; when
  subpath bboxes overlap, winding and parity must agree at an interior
  point of every subpath (donut holes agree; same-winding overlaps
  disagree → refuse).
- **the reveal check** — every interior sample of W must render WHITE in
  the stack strictly below B (`revealAt`). This is the load-bearing
  safety rule this repo adds over the naive "white in black → hole"
  model: in the inverted/ben-day files the paint under the dark
  silhouette is the dot pattern, and a hole would show dots where the
  art shows solid white. Those whites are counted
  ("knockout would not reveal white") and left. Reveal samples are
  scanline span midpoints (`revealSamples`) — strictly interior, because
  W's boundary vertices sit knife-edge on identically-traced boundaries
  of the paint beneath. **The invariant guards the DEFAULT;
  `--punch-through` is its one sanctioned override** (below) — never
  weaken the check itself, route intentional overrides through the flag
  so verify knows exactly which regions were allowed to change.
- compounding appends `svgpath(w.curD).abs().round(2).toString()` to
  B's `d` (round(2), or re-serialization balloons files ~40 %), sets
  `fill-rule="evenodd"`, kills W, and invalidates B's caches so the next
  fixpoint pass sees B's updated region (nested whites test against the
  holed geometry — that's why iteration converges correctly).

Whites are only ever *sources* (they're never darker than anything), so
a compounded W can't have been someone's target; B *can* receive
multiple whites, and later containment tests correctly exclude the holes
already cut.

## `--punch-through` (1.1.0): the sanctioned reveal override

The flag converts exactly the **category-2** whites (fully contained,
every other T4 gate passed, only the reveal check failed) into evenodd
holes anyway. The rendering change is intentional: real holes let a
designer place their own paint behind the compound path, which
painted-on whites forbid. Mechanics:

- Same compound code path; the white is tallied as `stats.punched` (not
  `whitesCompounded` — categories stay disjoint) and its flattened
  geometry is pushed to `stats.punchedRegions` before deletion.
- **Category-3 (blocked by intervening paint) stays excluded even under
  the flag.** Intervening paint sits above B and below W: delete W and
  hole B, and that paint still renders over parts of the hole — the
  result is neither the original nor a clean knockout. Punching those
  needs the intervening paint resolved first (clipping), so they wait
  for the partial-overlap v2 machinery. Same for partial-overlap whites.
- **Masked verify** (`buildPunchMask`): the punched regions are
  rasterized at verify resolution (point-in-region per pixel center in
  viewBox coords, mapped through width/height vs viewBox — this handles
  `preserveAspectRatio="none"` stretch), dilated 2 px separably for hole-
  edge antialiasing, and those pixels are EXCLUDED from the diff (their
  area is reported as masked %). Everything outside still faces the
  normal flat-field/edge gates — the `--min-area`-corruption test in the
  suite proves the mask cannot blind the rail to unrelated damage.
- Fixpoint cascades are expected and correct: punching a white deletes
  an intervening blocker and may unblock further whites; a white whose
  reveal used to be a now-punched white re-classifies as punched itself
  (the model always matches the intended OUTPUT rendering, and each
  punched white contributes its own mask region). So real-file punched
  counts can exceed the default run's "knockout would not reveal white"
  count — that is cascade, not a bug.

## Geometry lessons paid for on real files (do not regress)

1. **Sampling density.** `samplesOf` = ALL flattened vertices + points
   every `4*tol` along every edge + per-subpath interior points, no cap.
   Two real-file bugs live here: (a) a capped/strided sample set skipped
   exactly the short local band where a white overhangs its container;
   (b) long straight polyline edges have no vertices, so without edge
   subdivision a straight edge "cuts the corner" across a notch in the
   container's boundary between two perfectly-inside samples.
2. **eps is knife-edge tolerance, not a containment buffer.**
   `eps = tol` (~0.5 px on a 4096 canvas). It exists because vectorizers
   retrace shared boundaries exactly, and samples on those edges are
   numerically on the line. Anything bigger starts classifying thin
   seam-cover fringes (which genuinely overhang their neighbor by a
   pixel or two, by design) as contained.
3. **The AA-seam mask in verify.** A duplicate white traced exactly over
   white paint renders with (1-a)² background residue on its shared edge
   vs (1-a) after removal — up to delta ~64 per edge pixel at preview
   resolution while being print-identical (vector-exact). `verifyPair`
   therefore builds an edge mask from the ORIGINAL render (gradient >
   `VERIFY_EDGE_GRAD` in the 8-neighborhood, dilated 1 px) and judges
   masked pixels separately (< 2 % sanity cap) from flat-field pixels
   (< 0.05 % hard gate). Real damage — pattern dots through a hole,
   deleted visible shapes, magenta showing through created transparency —
   lands in flat field. Removing the mask makes every heavy file fail on
   physics, not on correctness; loosening the flat-field gate instead
   would blind the rail. Don't do either.

## Why evenodd (and when it's refused)

Nonzero + reversed-winding subpaths could express holes without a rule
flip, but the vectorizer's winding directions are arbitrary, so evenodd
+ appended subpaths is the only orientation-independent way to cut a
hole — it's also what Illustrator's "Make Compound Path" produces, i.e.,
what the owner's manual process created. The cost is that flipping B's
rule can change B itself if its own subpaths overlap; `eoSafe` is the
gate, and refusing is always safe (the white just stays stacked).

## The bisect-rollback flow

`LEVELS` in `processFile`. Transforms are dropped in reverse order of
risk: 4 (restructures geometry) → 3 (removes occluded paint) → 2
(removes sub-visible paint) → {1} alone. Each level re-runs
`runTransforms` from the ORIGINAL text — levels are not incremental
patches. If even {1} fails verification, nothing is written and the file
is reported as failed. `--no-verify` short-circuits to the full set.

## Test strategy

`test/cli.test.mjs` is black-box (execFileSync against the CLI), same as
svg-color-rinse. Fixtures in `test/fixtures/` are SMALL SYNTHETIC files,
one concern each, on a 1000×1000 viewBox (default speck area = 1 px²
exactly, which makes threshold assertions readable). Never add real
artwork to the repo, and never reference the owner's real filenames in
any committed content. Real-file validation is manual, outputs to /tmp,
and NEVER committed.

The suite auto-detects rsvg-convert: with it, verify PASS lines are
asserted (render-diff proof of evenodd correctness); without it, tests
run with `--no-verify` and the geometric assertions still hold.

## v2 ideas and where they'd slot

- **Partial-overlap clipping**: intersect W with B's outline (path
  booleans — this needs a real clipper lib or a polygon clipper on the
  flattened geometry + curve refit) and compound only the inside piece,
  leaving the outside piece painted. Slot: a new branch in
  `transform4Knockouts` where `darkerSolid && !contains && regionsIntersect`
  currently files the white under `partial`.
- **Gray-level knockouts**: same machinery as T4 with W = any solid
  strictly lighter than B and the reveal check demanding W's own color
  below B instead of white. `revealAt` already returns a classification —
  extend it to return the actual color. The knockout target must then
  keep painting W's color... it can't — a hole shows what's beneath, so
  this ONLY works where the beneath-color equals W's color. That
  equality test is the whole feature.
- **Occluded-by-later removal**: a path fully covered by LATER opaque
  paint is dead weight too (T3 only handles earlier same-color
  containers). Needs a "union of later covers" test — sampled union
  walk, same infrastructure. Slot: a T3b pass after `transform3Redundant`.
- **`--optimize` svgo pass-through** like svg-color-rinse, after the
  verify (never before — verify must see our exact output).

## Publishing

The owner publishes manually — never run `npm publish`, `git push`, or
create GitHub repos from a session. Preflight: `npm test` green,
`npm pack --dry-run` ships only `svg-knockout.mjs` + README + LICENSE +
package.json, semver bump, and this file updated if invariants moved.
