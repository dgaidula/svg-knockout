# svg-knockout

Turn stacked AI-vectorizer SVG output (Recraft and friends) into true
compound-path knockouts, and strip the invisible noise paths that come
with it — with a render-diff safety rail that refuses to ship a file that
doesn't look identical to the original.

A vectorized illustration usually comes back structurally wrong for print.
Where a designer would cut a hole through the black — a compound path, so
the paper shows through — the vectorizer paints a white shape ON TOP of
the black. Open one of these files in Illustrator and you'll also find
piles of sub-visible specks and shapes buried entirely inside solid areas,
contributing nothing but path count. Fixing all that by hand, shape by
shape, is the tedious part. This tool does it in one pass.

## The four transforms

Applied in order, per file:

1. **Trivial group unwrapping** — `<g>` wrappers with no attributes (or
   only an `id`) are removed, preserving paint order exactly.
2. **Speck removal** — paths whose true filled area (curves flattened,
   per-subpath absolute areas summed) is invisible at print size are
   deleted, whatever their fill color. Default threshold: a square of side
   `min(viewBox W,H)/1000` — about 0.5 pt at a typical 4096 px / 600 dpi
   placement, smaller than a coarse halftone dot (see "Calibration").
3. **Redundant same-color removal** — a path fully contained in an
   earlier-painted path of the same solid fill, with nothing painted
   between them that overlaps it, is invisible paint-on-paint and is
   deleted. Any size: this is the "zillions of black-on-black specks" the
   vectorizer buries inside solid areas. If anything between the two could
   be uncovered by the removal, the path is kept.
4. **White → compound knockout** — a white path fully contained in a
   darker solid path painted beneath it becomes extra subpaths of that
   path, the target gets `fill-rule="evenodd"`, and the white is deleted:
   a real hole showing the paper, not white ink over black. Applied to a
   fixpoint so nesting works — a white eye compounded into a black head
   keeps its black pupil, because the pupil is painted after the eye and
   is untouched.

## The guarantee: the magenta render-diff

Restructuring print files on geometry alone is how you ship damage, so
every file is verified: the original and the transformed result are both
rendered (`rsvg-convert`, ~1000 px wide), alpha-composited over a
**magenta backdrop** — which makes accidentally-created transparency
impossible to miss (a hole cut through the bottom canvas isn't paper,
it's a see-through hole) — and pixel-diffed.

A file is accepted only if fewer than **0.05 % of flat-field pixels**
changed. Single-pixel antialiasing seams along edges that already exist
in the original render are tallied separately (capped at 2 %): when the
vectorizer traces a white exactly on top of identical white paint,
removing the duplicate is vector-exact and print-identical, but the
screen rasterizer's edge coverage math shifts by a hair along the shared
boundary. The report prints both numbers.

If verification fails, the tool **bisects**: it re-runs with transform 4
disabled, then 3, then 2, writes only the passing subset, and reports
what was rolled back and why. If `rsvg-convert` is not installed the tool
refuses to run — pass `--no-verify` only if you accept that a bad
transform could ship unnoticed.

## Install

```sh
# run without installing
npx svg-knockout art.svg

# or install globally
npm install -g svg-knockout
svg-knockout art.svg
```

Requires Node 20+ and [librsvg](https://wiki.gnome.org/Projects/LibRsvg)'s
`rsvg-convert` on PATH for the safety rail (`brew install librsvg` /
`dnf install librsvg2-tools`).

## Quick start

```sh
# one file -> writes art-compound.svg alongside it
svg-knockout art.svg

# preview the full report (including the verify result), write nothing
svg-knockout --dry-run art.svg

# a whole folder, recursively; existing *-compound.svg outputs are skipped
svg-knockout exports/
svg-knockout --force exports/      # regenerate them
svg-knockout --in-place exports/   # overwrite the originals
```

Output is a per-file report:

```
art.svg:
  paths 418 -> 215
  specks removed: 2 (min area 16.8 px²)
  redundant same-color removed: 102
  whites compounded: 99 (into 7 knockout paths)
  whites left alone (partial overlap): 34
  whites left alone (blocked by intervening paint): 34
  bytes 224,013 -> 208,415 (-7.0%)
  verify: PASS 0.0000% flat-field pixels changed (max delta 0; 0.6437% single-px AA seams) @1000px over magenta
  wrote art-compound.svg
```

## What is deliberately never touched

- **Pattern and gradient fills** (`fill="url(#...)"`) — never removed,
  never holed, never used as a knockout target. Ben-day dot patterns and
  gradient defs pass through byte-for-byte.
- **The bottom-most full-canvas path** — holing it would create real
  transparency, not paper.
- **Whites that only partially overlap a darker shape** — the "linked to
  a larger white area" case. Cutting those needs clipping, not
  compounding; they are counted in the report and left alone.
- **Whites whose knockout would not reveal white** — if the paint under
  the dark shape is a pattern or another color, a hole would change the
  artwork (ben-day dots showing through a face). Counted and left alone —
  unless you ask for exactly that with `--punch-through` (below).
- **Stroked or transformed paths**, and anything inside a `<g>` that
  carries attributes — treated as opaque obstacles, never edited.

## Punch-through: full-transparency mode

`--punch-through` is the advanced mode for when appearance preservation is
not the goal — **knockout structure is**. By default, a fully-contained
white is only compounded when the hole provably reveals white beneath;
whites sitting on a dark shape that itself sits on a dot pattern (or a
gray) are left painted, because a hole there changes the rendering.

But painted-on whites are a dead end for separation work: you cannot
place your own colored shape *behind* the compound path and have it show
through white paint. `--punch-through` converts those whites into real
evenodd holes anyway. The rendering change is intentional and is the
entire point — drop the compound path over any background in your layout
tool and the background reads through every hole.

```
  whites compounded: 0 (into 0 knockout paths)
  punched through (intentional reveal): 23
  verify: PASS 0.0000% flat-field pixels changed (max delta 0; 0.0037% single-px AA seams) (8.35% masked as intentional punch-through) @1000px over magenta
```

Verification still runs and still means something: the punched whites'
regions are rasterized into a pixel mask (dilated ~2 px for
antialiasing), those pixels are excluded from the diff as the sanctioned
change, and **everything outside the mask must pass the normal gates**.
The report shows how much of the frame was masked.

Only the fully-contained, reveal-blocked whites are punched. Whites
blocked by **intervening paint** stay excluded even under the flag: paint
layered between the dark shape and the white keeps painting over parts of
the hole after the white is deleted, so the result would be neither the
original artwork nor a clean knockout — it needs clipping, not punching.

## Options

| flag | default | meaning |
|---|---|---|
| `--min-area <px²\|N%>` | `0.1%` | speck threshold: absolute area in viewBox px², or `N%` = a square whose side is N % of the shorter viewBox dimension |
| `--punch-through` | off | also hole contained whites whose knockout reveals non-white paint — an intentional rendering change for placing your own paint behind the compound path; verify masks exactly those regions |
| `--in-place` | off | overwrite inputs instead of writing `*-compound.svg` |
| `--force` | off | regenerate existing `*-compound.svg` outputs (default: skip, so re-runs are idempotent) |
| `--dry-run` | off | report only (verify included), write nothing |
| `--no-verify` | off | skip the render-diff safety rail — not recommended |
| `--help` | | print usage |

## Calibration: the speck threshold

The default threshold is a square of side `min(viewBox W,H)/1000`. On a
4096 px canvas placed at 600 dpi that is a 0.17 mm / 0.49 pt square
(16.8 px²) — smaller than a 50 % dot in a coarse halftone and at the edge
of what garment printing reliably reproduces at all, verified during
development by rendering threshold-sized dots at print scale. Real Recraft exports were
measured to have their organic noise floor at roughly 9–40 px² on these
canvases, so the default only removes true dust; `--min-area 0.2%` (4× the
default area) sweeps the smallest vectorizer specks too, if you decide
they're noise for a given piece.

## v1 limitations

- **Partial-overlap whites are left alone.** Turning them into knockouts
  needs the white clipped against the dark shape's outline (path boolean
  ops), not just appended subpaths. v2 territory.
- **Only pure white (`#fff`/`#ffffff`/`white`/`rgb(255,255,255)`) is a
  knockout candidate.** Run
  [svg-color-rinse](https://github.com/dgaidula/svg-color-rinse) first so
  the near-whites (`#fdfcfd`, `#eae9eb`, …) snap to true white — the two
  tools are designed to run in that order.
- **Gray-on-gray knockouts** (a gray fully contained in a darker solid)
  are not compounded, only whites.
- **Solid `fill` attributes only** — `<style>` blocks and `class`-based
  fills are out of scope (Recraft-style exports don't use them for
  shapes).
- The containment and occlusion tests are sampled geometry, deliberately
  conservative; anything ambiguous is left untouched, and the render-diff
  is the final arbiter either way.

## Companions

- [svg-color-rinse](https://github.com/dgaidula/svg-color-rinse) — snap
  the near-blacks/near-whites to clean anchors first.
- [svg-cmyk-pdf](https://github.com/dgaidula/svg-cmyk-pdf) — then convert
  the cleaned SVG to a print-ready single-ink CMYK PDF.
- [lineart-rich-black](https://github.com/dgaidula/lineart-rich-black) —
  the raster-side sibling for B/W line-art PNGs.

## Development

```sh
npm install   # svgpath (geometry), pngjs (verify)
npm test      # node --test against synthetic fixtures in test/
```

## License

MIT
