#!/usr/bin/env node
// svg-knockout: turn stacked AI-vectorizer SVG output into true compound-path
// knockouts, and strip the invisible noise paths that come with it.
//
// Vectorizers (Recraft and friends) build art the lazy way: a white shape
// PAINTED ON TOP of a black shape, instead of a hole cut through it — plus
// piles of sub-visible specks and paths buried entirely inside solid areas.
// For print work those stacked whites are not knockouts and the specks are
// pure noise. This tool applies four transforms, in order, per file:
//
//   1. unwrap trivial <g> wrappers (no attributes, or only an id), keeping
//      paint order exactly
//   2. remove speck paths whose true filled area is invisible at print size
//      (default threshold: a square of side min(viewBox W,H)/1000; any fill
//      color; see --min-area)
//   3. remove redundant same-color paths: a path fully contained in an
//      earlier path of the same solid fill, with nothing painted between
//      them that overlaps it (removing it could uncover that paint) — the
//      fully-occluded junk vectorizers bury inside solid areas
//   4. compound-path knockouts: a white path fully contained in a darker
//      solid path beneath it becomes extra subpaths of that path (with
//      fill-rule="evenodd") and is deleted — a real hole showing the paper
//      through, not paint over paint. Applied repeatedly so nesting works
//      (white eye in a black head keeps its black pupil painted on top).
//
// Safety rail: after transforming, the original and the result are BOTH
// rendered (rsvg-convert, ~1000px wide), composited over a magenta backdrop
// (which exposes accidentally-created transparency), and pixel-diffed. A
// file is only accepted if fewer than 0.05% of flat-field pixels changed
// (single-pixel antialiasing seams along edges that already exist in the
// original render are tallied separately: removing a shape traced exactly
// over identical paint is print-identical, but shifts edge-pixel coverage
// on screen). On failure the tool bisects: transform 4 is dropped, then 3,
// then 2, and only the passing subset is written — the report says what
// was rolled back. rsvg-convert must be installed unless you accept the
// risk with --no-verify.
//
// Never touched: pattern/gradient (url(#...)) fills, both as the white and
// as the target; the bottom-most full-canvas path (holing it would create
// real transparency, not paper); whites only partially overlapping darker
// shapes (counted in the report); stroked or transformed paths.
//
// --punch-through (advanced): also hole the fully-contained whites whose
// knockout would NOT reveal white (ben-day dots or gray under the dark
// shape). That rendering change is intentional — it gives you true
// knockout structure so you can place your own paint behind the compound
// path and have it show through the holes. Verification still runs, with
// exactly the punched regions masked out of the diff; everything outside
// the mask must pass the normal gates. Whites blocked by intervening
// paint are still left alone even with this flag.
//
// Usage:
//   svg-knockout art.svg [more.svg dirs/ ...]   # writes art-compound.svg
//   svg-knockout --in-place exports/            # overwrite, recursive
//   svg-knockout --dry-run exports/             # report only, write nothing
//
// Options:
//   --min-area <px2|N%>  speck threshold: an absolute area in viewBox px²,
//                        or N% = a square whose side is N% of the shorter
//                        viewBox dimension (default 0.1%)
//   --punch-through      also hole contained whites whose knockout reveals
//                        non-white paint (intentional change; see above)
//   --in-place           overwrite inputs instead of writing *-compound.svg
//   --force              regenerate existing *-compound.svg outputs
//                        (default: skip them, so re-runs are idempotent)
//   --dry-run            report (including the verify result), write nothing
//   --no-verify          skip the render-diff safety rail (risk: a bad
//                        transform ships unnoticed; only for environments
//                        without rsvg-convert)
//   --cheat              print a short card of common invocations in tldr page
//                        format and exit
//   --help               print this usage

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import svgpath from 'svgpath';
import { PNG } from 'pngjs';

// ---- colors -----------------------------------------------------------------

// Returns [r,g,b], or null for anything that is not a plain solid color.
function parseColor(str) {
  if (str === undefined) return [0, 0, 0]; // missing fill = black, per SVG
  const s = String(str).trim().toLowerCase();
  if (s === 'black') return [0, 0, 0];
  if (s === 'white') return [255, 255, 255];
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = s.match(/^#([0-9a-f]{6})$/);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = s.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/);
  if (m) return [m[1], m[2], m[3]].map((v) => Math.min(Number(v), 255));
  return null;
}

const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const isWhite = (rgb) => rgb !== null && rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255;
const sameColor = (a, b) => a !== null && b !== null && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

// ---- minimal SVG parsing with source offsets ---------------------------------
// The output is produced by splicing byte ranges out of (or into) the original
// text, so untouched content survives byte-for-byte. Elements record where
// their open tag, children, and close tag live in the source.

function parseAttrs(s) {
  const attrs = {};
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[m[1]] = m[2] ?? m[3];
  }
  return attrs;
}

function parseSvg(text) {
  // Mask comments/CDATA/PIs with spaces so tag offsets stay valid.
  const masked = text.replace(
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/g,
    (m) => ' '.repeat(m.length));
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  const stack = [root];
  for (const m of masked.matchAll(tagRe)) {
    const [full, close, tag, attrStr, selfClose] = m;
    if (close) {
      if (stack.length > 1) {
        const node = stack.pop();
        node.closeStart = m.index;
        node.end = m.index + full.length;
      }
      continue;
    }
    const node = {
      tag, attrStr, attrs: parseAttrs(attrStr), children: [],
      parent: stack[stack.length - 1],
      start: m.index, openEnd: m.index + full.length,
      closeStart: null, end: m.index + full.length,
    };
    node.parent.children.push(node);
    if (!selfClose) stack.push(node);
  }
  const svg = root.children.find((n) => n.tag === 'svg');
  if (!svg) throw new Error('no <svg> root element found');
  return svg;
}

// ---- transforms (matrix [a b c d e f]) ---------------------------------------

const matMul = (A, B) => [ // apply B first, then A
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
];

// Parse an SVG transform list into a matrix; null if it uses anything odd.
function parseTransform(str) {
  if (!str || !str.trim()) return [1, 0, 0, 1, 0, 0];
  let m = [1, 0, 0, 1, 0, 0];
  let found = 0;
  for (const t of str.matchAll(/(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g)) {
    found++;
    const v = t[2].trim().split(/[\s,]+/).map(Number);
    if (v.some(Number.isNaN)) return null;
    if (t[1] === 'matrix' && v.length === 6) m = matMul(m, v);
    else if (t[1] === 'translate') m = matMul(m, [1, 0, 0, 1, v[0], v[1] ?? 0]);
    else if (t[1] === 'scale') m = matMul(m, [v[0], 0, 0, v[1] ?? v[0], 0, 0]);
    else if (t[1] === 'rotate') {
      const r = (v[0] * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
      let rm = [cos, sin, -sin, cos, 0, 0];
      if (v.length === 3) rm = matMul(matMul([1, 0, 0, 1, v[1], v[2]], rm), [1, 0, 0, 1, -v[1], -v[2]]);
      m = matMul(m, rm);
    } else return null;
  }
  return found === 0 ? null : m;
}

const IDENTITY = [1, 0, 0, 1, 0, 0];
const isIdentity = (m) => m && m.every((v, i) => v === IDENTITY[i]);

// ---- path flattening ----------------------------------------------------------
// svgpath normalizes (abs/unshort/unarc: only M/L/H/V/C/Q/Z remain), then
// curves are flattened adaptively by recursive subdivision against `tol`.

function flattenCubic(pts, x0, y0, x1, y1, x2, y2, x3, y3, tol, depth) {
  // flatness: control-point distance from the chord
  const dx = x3 - x0, dy = y3 - y0;
  const d1 = Math.abs((x1 - x0) * dy - (y1 - y0) * dx);
  const d2 = Math.abs((x2 - x0) * dy - (y2 - y0) * dx);
  const chord2 = dx * dx + dy * dy;
  if (depth > 16 || (d1 + d2) * (d1 + d2) <= tol * tol * chord2 || chord2 < tol * tol) {
    pts.push(x3, y3);
    return;
  }
  const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2;
  const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2;
  const x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
  const xa = (x01 + x12) / 2, ya = (y01 + y12) / 2;
  const xb = (x12 + x23) / 2, yb = (y12 + y23) / 2;
  const xm = (xa + xb) / 2, ym = (ya + yb) / 2;
  flattenCubic(pts, x0, y0, x01, y01, xa, ya, xm, ym, tol, depth + 1);
  flattenCubic(pts, xm, ym, xb, yb, x23, y23, x3, y3, tol, depth + 1);
}

// d string (+ optional transform string) -> { subpaths, bbox, absArea }
// where each subpath is { pts: [x0,y0,x1,y1,...], area (signed), bbox }.
function flattenPathData(d, transformStr, tol) {
  let p = svgpath(d);
  if (transformStr) p = p.transform(transformStr);
  p = p.abs().unshort().unarc();
  const subpaths = [];
  let pts = null;
  let sx = 0, sy = 0; // subpath start
  const begin = (x, y) => { pts = [x, y]; subpaths.push(pts); sx = x; sy = y; };
  p.iterate((seg, i, x, y) => {
    switch (seg[0]) {
      case 'M': begin(seg[1], seg[2]); break;
      case 'L': pts.push(seg[1], seg[2]); break;
      case 'H': pts.push(seg[1], y); break;
      case 'V': pts.push(x, seg[1]); break;
      case 'C': flattenCubic(pts, x, y, seg[1], seg[2], seg[3], seg[4], seg[5], seg[6], tol, 0); break;
      case 'Q': { // elevate to cubic, then flatten
        const [, qx, qy, ex, ey] = seg;
        flattenCubic(pts,
          x, y,
          x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
          ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey),
          ex, ey, tol, 0);
        break;
      }
      case 'Z': pts.push(sx, sy); break;
      default: break; // A never survives unarc(); anything else is ignored
    }
  });
  const out = { subpaths: [], bbox: [Infinity, Infinity, -Infinity, -Infinity], absArea: 0 };
  for (const raw of subpaths) {
    if (raw.length < 6) continue; // degenerate: fewer than 3 points
    // fills auto-close: drop an explicit duplicate closing point
    const n0 = raw.length;
    const closed = raw[0] === raw[n0 - 2] && raw[1] === raw[n0 - 1] ? raw.slice(0, -2) : raw;
    if (closed.length < 6) continue;
    let area = 0;
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    const n = closed.length;
    for (let i = 0; i < n; i += 2) {
      const x1 = closed[i], y1 = closed[i + 1];
      const x2 = closed[(i + 2) % n], y2 = closed[(i + 3) % n];
      area += x1 * y2 - x2 * y1;
      if (x1 < bbox[0]) bbox[0] = x1;
      if (y1 < bbox[1]) bbox[1] = y1;
      if (x1 > bbox[2]) bbox[2] = x1;
      if (y1 > bbox[3]) bbox[3] = y1;
    }
    area /= 2;
    out.subpaths.push({ pts: closed, area, bbox });
    out.absArea += Math.abs(area);
    out.bbox = [
      Math.min(out.bbox[0], bbox[0]), Math.min(out.bbox[1], bbox[1]),
      Math.max(out.bbox[2], bbox[2]), Math.max(out.bbox[3], bbox[3]),
    ];
  }
  return out;
}

// ---- point-in-region queries ---------------------------------------------------
// A y-bucketed edge index per flattened path makes winding/parity/distance
// queries cheap enough to run thousands of times per file.

function buildEdgeIndex(flat) {
  const edges = []; // x1,y1,x2,y2 quads
  for (const sp of flat.subpaths) {
    const p = sp.pts, n = p.length;
    for (let i = 0; i < n; i += 2) {
      edges.push(p[i], p[i + 1], p[(i + 2) % n], p[(i + 3) % n]);
    }
  }
  const nEdges = edges.length / 4;
  const y0 = flat.bbox[1], y1 = flat.bbox[3];
  const nb = Math.max(1, Math.min(256, Math.floor(Math.sqrt(nEdges))));
  const span = Math.max(y1 - y0, 1e-9);
  const buckets = Array.from({ length: nb }, () => []);
  const bucketOf = (y) => Math.max(0, Math.min(nb - 1, Math.floor(((y - y0) / span) * nb)));
  for (let e = 0; e < nEdges; e++) {
    const ey0 = edges[e * 4 + 1], ey1 = edges[e * 4 + 3];
    const b0 = bucketOf(Math.min(ey0, ey1)), b1 = bucketOf(Math.max(ey0, ey1));
    for (let b = b0; b <= b1; b++) buckets[b].push(e);
  }
  return { edges, buckets, nb, y0, span, bucketOf };
}

// winding number and crossing parity at (px,py)
function windingAt(idx, px, py) {
  let winding = 0, parity = 0;
  const { edges, buckets, bucketOf } = idx;
  for (const e of buckets[bucketOf(py)]) {
    const x1 = edges[e * 4], y1 = edges[e * 4 + 1], x2 = edges[e * 4 + 2], y2 = edges[e * 4 + 3];
    if (y1 <= py ? y2 > py : y2 <= py) {
      const xi = x1 + ((py - y1) / (y2 - y1)) * (x2 - x1);
      if (xi > px) { winding += y2 > y1 ? 1 : -1; parity ^= 1; }
    }
  }
  return { winding, parity };
}

function distToBoundary2(idx, px, py, eps) {
  const { edges, buckets, nb, y0, span } = idx;
  const b0 = Math.max(0, Math.min(nb - 1, Math.floor(((py - eps - y0) / span) * nb)));
  const b1 = Math.max(0, Math.min(nb - 1, Math.floor(((py + eps - y0) / span) * nb)));
  let best = Infinity;
  const seen = new Set();
  for (let b = b0; b <= b1; b++) {
    for (const e of buckets[b]) {
      if (seen.has(e)) continue;
      seen.add(e);
      const x1 = edges[e * 4], y1 = edges[e * 4 + 1], x2 = edges[e * 4 + 2], y2 = edges[e * 4 + 3];
      const dx = x2 - x1, dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
      const ex = x1 + t * dx - px, ey = y1 + t * dy - py;
      const d2 = ex * ex + ey * ey;
      if (d2 < best) best = d2;
    }
  }
  return best;
}

const insideRegion = (idx, fillRule, px, py) => {
  const w = windingAt(idx, px, py);
  return fillRule === 'evenodd' ? w.parity === 1 : w.winding !== 0;
};

const insideOrNear = (idx, fillRule, px, py, eps) =>
  insideRegion(idx, fillRule, px, py) || distToBoundary2(idx, px, py, eps) <= eps * eps;

// A point strictly inside one subpath: the midpoint of the first span a
// horizontal scanline cuts through it. Tries a few scanline heights.
function interiorPoint(sp) {
  const p = sp.pts, n = p.length;
  for (let k = 1; k <= 5; k++) {
    const y = sp.bbox[1] + ((sp.bbox[3] - sp.bbox[1]) * k) / 6;
    const xs = [];
    for (let i = 0; i < n; i += 2) {
      const y1 = p[i + 1], y2 = p[(i + 3) % n];
      if (y1 <= y ? y2 > y : y2 <= y) {
        xs.push(p[i] + ((y - y1) / (y2 - y1)) * (p[(i + 2) % n] - p[i]));
      }
    }
    if (xs.length >= 2) {
      xs.sort((a, b) => a - b);
      if (xs[1] - xs[0] > 1e-9) return [(xs[0] + xs[1]) / 2, y];
    }
  }
  return null;
}

// ---- the per-file model ---------------------------------------------------------

const NON_RENDERED = new Set(['defs', 'pattern', 'linearGradient', 'radialGradient',
  'clipPath', 'mask', 'symbol', 'marker', 'style', 'metadata', 'title', 'desc', 'filter']);
const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line']);

const isTrivialGroup = (node) => {
  const keys = Object.keys(node.attrs);
  return keys.length === 0 || (keys.length === 1 && keys[0] === 'id');
};

// A null bbox means "unknown geometry" and conservatively intersects everything.
function bboxIntersect(a, b) {
  if (a === null || b === null) return true;
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

// Collect rendered drawables in paint order. Each entry knows enough to be a
// candidate for the transforms, or failing that, at least a paint-order
// blocker with a bbox.
function collectDrawables(svg, tol) {
  const drawables = [];
  const groups = []; // every <g> in rendered content, for transform 1
  const walk = (node, groupChain) => {
    for (const child of node.children) {
      if (NON_RENDERED.has(child.tag)) continue;
      if (child.tag === 'g') {
        groups.push(child);
        walk(child, [...groupChain, child]);
        continue;
      }
      if (!SHAPE_TAGS.has(child.tag) && !['use', 'image', 'text', 'switch', 'foreignObject', 'a'].includes(child.tag)) continue;
      const a = child.attrs;
      const d = {
        el: child, tag: child.tag, attrs: a,
        alive: true, groupChain,
        trivialContext: groupChain.every(isTrivialGroup),
        hasStroke: a.stroke !== undefined && a.stroke !== 'none',
        fillStr: a.fill,
        fill: null, fillKind: 'unknown',
        fillRule: a['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero',
        transformStr: a.transform ?? null,
        curD: a.d ?? null,
        modified: false,
        flat: null, index: null, eoSafeCache: null, sampleCache: null,
      };
      if (child.tag === 'path') {
        if (a.fill !== undefined && /^url\(/.test(a.fill.trim())) {
          d.fillKind = 'paint-server';
        } else if (a.fill === 'none') {
          d.fillKind = 'none';
        } else {
          const rgb = parseColor(a.fill);
          if (rgb !== null && d.trivialContext) { d.fill = rgb; d.fillKind = 'solid'; }
        }
      }
      // geometry: paths get full flattening (lazily); simple shapes get a bbox
      if (child.tag === 'path' && d.curD) {
        const tm = parseTransform(d.transformStr ?? '');
        d.geomKnown = d.transformStr === null || tm !== null;
      } else if (child.tag === 'rect' && a.transform === undefined) {
        const x = Number(a.x ?? 0), y = Number(a.y ?? 0), w = Number(a.width), h = Number(a.height);
        d.bboxOnly = [x, y, x + w, y + h];
        d.geomKnown = Number.isFinite(w) && Number.isFinite(h);
      } else if ((child.tag === 'ellipse' || child.tag === 'circle') && a.transform === undefined) {
        const cx = Number(a.cx ?? 0), cy = Number(a.cy ?? 0);
        const rx = Number(child.tag === 'circle' ? a.r : a.rx), ry = Number(child.tag === 'circle' ? a.r : a.ry);
        d.bboxOnly = [cx - rx, cy - ry, cx + rx, cy + ry];
        d.geomKnown = Number.isFinite(rx) && Number.isFinite(ry);
      } else {
        d.geomKnown = false; // unknown geometry: treated as intersecting everything
      }
      d.tol = tol;
      drawables.push(d);
    }
  };
  walk(svg, []);
  drawables.forEach((d, i) => { d.index = i; });
  return { drawables, groups };
}

function geom(d) {
  if (d.flat === null && d.tag === 'path' && d.curD && d.geomKnown) {
    const flat = flattenPathData(d.curD, d.transformStr, d.tol);
    d.flat = { ...flat, idx: buildEdgeIndex(flat) };
  }
  return d.flat;
}

const bboxOf = (d) => {
  if (d.tag === 'path' && d.geomKnown) { const g = geom(d); return g && g.subpaths.length ? g.bbox : null; }
  return d.bboxOnly ?? null; // null = unknown = intersects everything
};

// Something that paints nothing can never occlude or intervene.
const paintsNothing = (d) => !d.hasStroke && (
  d.fillKind === 'none'
  || (d.tag === 'path' && d.geomKnown && (!geom(d) || geom(d).subpaths.length === 0)));

// Containment samples: ALL flattened vertices + points along every edge +
// per-subpath interior points. No cap, and long edges are subdivided: a
// straight polyline edge has no intermediate vertices, so without
// subdivision it can cut across a notch in the container's boundary between
// two perfectly-inside samples (this bit on real files — vectorizer whites
// overhang their neighbors in exactly such local bands).
function samplesOf(d) {
  if (d.sampleCache) return d.sampleCache;
  const g = geom(d);
  if (!g) return (d.sampleCache = []);
  const step = d.tol * 4;
  const out = [];
  for (const sp of g.subpaths) {
    const p = sp.pts, n = p.length;
    for (let i = 0; i < n; i += 2) {
      const x1 = p[i], y1 = p[i + 1], x2 = p[(i + 2) % n], y2 = p[(i + 3) % n];
      out.push(x1, y1); // vertex
      const len = Math.hypot(x2 - x1, y2 - y1);
      const pieces = Math.min(1024, Math.max(2, Math.ceil(len / step)));
      for (let k = 1; k < pieces; k++) {
        out.push(x1 + ((x2 - x1) * k) / pieces, y1 + ((y2 - y1) * k) / pieces);
      }
    }
    const c = interiorPoint(sp);
    if (c) out.push(c[0], c[1]);
  }
  return (d.sampleCache = out);
}

// Every sample of `inner` inside (or within eps of the boundary of) `outer`.
function contains(outer, inner, eps) {
  const og = geom(outer);
  if (!og || og.subpaths.length === 0) return false;
  if (!bboxIntersect(og.bbox, bboxOf(inner))) return false;
  const s = samplesOf(inner);
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i += 2) {
    if (!insideOrNear(og.idx, outer.fillRule, s[i], s[i + 1], eps)) return false;
  }
  return true;
}

// Do two paths' painted regions actually overlap? Two-way sampled test: any
// sample of one inside the other. Bboxes intersecting is necessary but far
// from sufficient in dense art — this is what lets a merely-grazing path
// stop counting as "intervening paint".
function regionsIntersect(a, b) {
  const ag = geom(a), bg = geom(b);
  if (!ag || !bg) return true; // unknown geometry: assume overlap
  if (!bboxIntersect(ag.bbox, bg.bbox)) return false;
  // only samples inside the bbox overlap rectangle can be inside the other
  const rx0 = Math.max(ag.bbox[0], bg.bbox[0]), ry0 = Math.max(ag.bbox[1], bg.bbox[1]);
  const rx1 = Math.min(ag.bbox[2], bg.bbox[2]), ry1 = Math.min(ag.bbox[3], bg.bbox[3]);
  const scan = (samples, idx, fillRule) => {
    for (let i = 0; i < samples.length; i += 2) {
      const x = samples[i], y = samples[i + 1];
      if (x < rx0 || x > rx1 || y < ry0 || y > ry1) continue;
      if (insideRegion(idx, fillRule, x, y)) return true;
    }
    return false;
  };
  return scan(samplesOf(b), ag.idx, a.fillRule) || scan(samplesOf(a), bg.idx, b.fillRule);
}

// Would switching this path's fill-rule to evenodd change what it paints?
// Safe when subpaths are disjoint islands, or when winding and parity agree
// at an interior point of every subpath (donut holes agree; same-winding
// overlaps disagree and are rejected).
function eoSafe(d) {
  if (d.eoSafeCache !== null) return d.eoSafeCache;
  const g = geom(d);
  if (!g || g.subpaths.length === 0) return (d.eoSafeCache = false);
  if (d.fillRule === 'evenodd') return (d.eoSafeCache = true);
  if (g.subpaths.length > 1) {
    let overlaps = false;
    for (let i = 0; i < g.subpaths.length && !overlaps; i++) {
      for (let j = i + 1; j < g.subpaths.length; j++) {
        if (bboxIntersect(g.subpaths[i].bbox, g.subpaths[j].bbox)) { overlaps = true; break; }
      }
    }
    if (overlaps) {
      for (const sp of g.subpaths) {
        const p = interiorPoint(sp);
        if (!p) return (d.eoSafeCache = false);
        const w = windingAt(g.idx, p[0], p[1]);
        if ((w.winding !== 0) !== (w.parity === 1)) return (d.eoSafeCache = false);
      }
    }
  }
  return (d.eoSafeCache = true);
}

// What paint shows at (px,py) considering only drawables below `belowIndex`?
// Returns 'white' | 'other' | 'transparent'.
function revealAt(drawables, belowIndex, px, py) {
  for (let j = belowIndex - 1; j >= 0; j--) {
    const d = drawables[j];
    if (!d.alive || paintsNothing(d)) continue;
    const bb = bboxOf(d);
    if (bb && (px < bb[0] || px > bb[2] || py < bb[1] || py > bb[3])) continue;
    if (d.tag !== 'path' || !d.geomKnown) return 'other'; // cannot test: assume covered
    const g = geom(d);
    if (!g || !insideRegion(g.idx, d.fillRule, px, py)) continue;
    return d.fillKind === 'solid' && isWhite(d.fill) && !d.hasStroke ? 'white' : 'other';
  }
  return 'transparent';
}

// Sample points for the reveal check: scanline span midpoints, strictly
// interior to the path's own painted region (boundary vertices would sit
// knife-edge on identically-traced boundaries of the paint beneath).
function revealSamples(d) {
  const g = geom(d);
  const out = [];
  for (const sp of g.subpaths) {
    const p = sp.pts, n = p.length;
    for (let k = 1; k <= 5; k++) {
      const y = sp.bbox[1] + ((sp.bbox[3] - sp.bbox[1]) * k) / 6;
      const xs = [];
      for (let i = 0; i < n; i += 2) {
        const y1 = p[i + 1], y2 = p[(i + 3) % n];
        if (y1 <= y ? y2 > y : y2 <= y) {
          xs.push(p[i] + ((y - y1) / (y2 - y1)) * (p[(i + 2) % n] - p[i]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const mx = (xs[i] + xs[i + 1]) / 2;
        // keep only points inside the path's actual painted region (skips
        // the interiors of its hole subpaths, where nothing is revealed)
        if (insideRegion(g.idx, d.fillRule, mx, y)) out.push(mx, y);
      }
    }
  }
  return out;
}

// ---- the four transforms ----------------------------------------------------------

// Which drawable is the bottom-most full-canvas path (never to be holed)?
function findCanvasBase(drawables, vb) {
  const first = drawables.find((d) => d.alive && !paintsNothing(d));
  if (!first) return null;
  const bb = bboxOf(first);
  if (!bb) return null;
  const [x, y, w, h] = vb;
  const covers = bb[0] <= x + w * 0.01 && bb[1] <= y + h * 0.01
    && bb[2] >= x + w * 0.99 && bb[3] >= y + h * 0.99;
  return covers ? first : null;
}

const eligible = (d) =>
  d.alive && d.tag === 'path' && d.fillKind === 'solid' && !d.hasStroke
  && d.trivialContext && d.geomKnown && d.curD;

function transform1Groups(groups, stats) {
  const unwrapped = [];
  for (const g of groups) {
    if (isTrivialGroup(g)) { unwrapped.push(g); stats.groupsUnwrapped++; }
  }
  return unwrapped;
}

function transform2Specks(drawables, canvasBase, minArea, stats) {
  for (const d of drawables) {
    if (!eligible(d) || d === canvasBase) continue;
    const g = geom(d);
    if (!g) continue;
    if (g.absArea < minArea) { d.alive = false; stats.specksRemoved++; }
  }
}

// Walking down from P, the first alive drawable whose painted region truly
// overlaps P's decides: same solid fill and fully containing -> P is
// redundant paint; anything else -> it intervenes, and removing P could
// uncover it. Drawables whose bbox merely grazes P's are stepped over.
function transform3Redundant(drawables, canvasBase, eps, stats) {
  for (const p of drawables) {
    if (!eligible(p) || p === canvasBase) continue;
    const pb = bboxOf(p);
    if (!pb) continue;
    for (let j = p.index - 1; j >= 0; j--) {
      const b = drawables[j];
      if (!b.alive || paintsNothing(b)) continue;
      if (!bboxIntersect(bboxOf(b), pb)) continue;
      if (b.tag !== 'path' || !b.geomKnown) break; // unknown geometry blocks
      if (eligible(b) && sameColor(b.fill, p.fill) && !p.transformStr && !b.transformStr
          && contains(b, p, eps)) {
        p.alive = false;
        stats.redundantRemoved++;
        break;
      }
      if (regionsIntersect(b, p)) break; // real intervening paint
      // bbox graze only: keep walking down
    }
  }
}

function transform4Knockouts(drawables, canvasBase, eps, stats, punchThrough) {
  let changed = true;
  const blockedReveal = new Set(), partial = new Set(), blockedOther = new Set();
  while (changed) {
    changed = false;
    for (const w of drawables) {
      if (!eligible(w) || w === canvasBase || w.transformStr) continue;
      if (!isWhite(w.fill)) continue;
      const wb = bboxOf(w);
      if (!wb) continue;
      for (let j = w.index - 1; j >= 0; j--) {
        const b = drawables[j];
        if (!b.alive || paintsNothing(b)) continue;
        if (!bboxIntersect(bboxOf(b), wb)) continue;
        if (b.tag !== 'path' || !b.geomKnown) { blockedOther.add(w); break; }
        // first drawable whose region truly overlaps W's decides
        const darkerSolid = eligible(b) && !b.transformStr
          && b.fillKind === 'solid' && luma(b.fill) < luma(w.fill);
        if (darkerSolid && b !== canvasBase && contains(b, w, eps)) {
          if (!eoSafe(b) || !eoSafe(w)) { blockedOther.add(w); break; }
          const rs = revealSamples(w);
          let revealsWhite = rs.length > 0;
          for (let i = 0; i < rs.length && revealsWhite; i += 2) {
            if (revealAt(drawables, b.index, rs[i], rs[i + 1]) !== 'white') revealsWhite = false;
          }
          // --punch-through is the sanctioned override of the reveal check:
          // the hole exposing non-white paint (or nothing) is the point —
          // the designer places their own paint behind the compound path.
          // The punched region is recorded so verify can mask exactly it.
          if (!revealsWhite && !punchThrough) { blockedReveal.add(w); break; }
          // compound: append W's subpaths (absolute, rounded to 0.01px so
          // re-serialization does not balloon the file) into B, evenodd,
          // delete W
          if (revealsWhite) {
            stats.whitesCompounded++;
            stats.knockoutTargets.add(b);
          } else {
            stats.punched++;
            stats.punchedRegions.push({ flat: geom(w), fillRule: w.fillRule });
          }
          b.curD = b.curD + svgpath(w.curD).abs().round(2).toString();
          b.fillRule = 'evenodd';
          b.modified = true;
          b.flat = null; b.eoSafeCache = null; b.sampleCache = null;
          w.alive = false;
          blockedReveal.delete(w); partial.delete(w); blockedOther.delete(w);
          changed = true;
          break;
        }
        if (regionsIntersect(b, w)) {
          // real overlap: a darker solid that doesn't contain W is the
          // owner's "linked to a larger area" partial case. These stay out
          // even under --punch-through: paint between the target and the
          // white (or a white lapping outside its dark shape) would keep
          // painting over parts of the hole, so the result would be neither
          // the original nor a clean knockout.
          (darkerSolid ? partial : blockedOther).add(w);
          break;
        }
        // bbox graze only: keep walking down
      }
    }
  }
  stats.whitesPartial = partial.size;
  stats.whitesBlockedReveal = blockedReveal.size;
  stats.whitesBlockedOther = blockedOther.size;
}

// ---- splice-based output -------------------------------------------------------

function setAttrInTag(tagText, name, value) {
  const re = new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*')`);
  if (re.test(tagText)) return tagText.replace(re, (m, pre) => `${pre}"${value}"`);
  return tagText.replace(/(\/?)>$/, (m, slash) => ` ${name}="${value}"${slash}>`);
}

function buildOutput(text, drawables, unwrappedGroups) {
  const edits = []; // { start, end, insert }
  for (const d of drawables) {
    if (!d.alive) {
      edits.push({ start: d.el.start, end: d.el.end, insert: '' });
    } else if (d.modified) {
      let tag = text.slice(d.el.start, d.el.openEnd);
      tag = setAttrInTag(tag, 'd', d.curD);
      tag = setAttrInTag(tag, 'fill-rule', d.fillRule);
      edits.push({ start: d.el.start, end: d.el.openEnd, insert: tag });
    }
  }
  for (const g of unwrappedGroups) {
    edits.push({ start: g.start, end: g.openEnd, insert: '' });
    if (g.closeStart !== null && g.closeStart !== undefined && g.end > g.openEnd) {
      edits.push({ start: g.closeStart, end: g.end, insert: '' });
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.insert + out.slice(e.end);
  return out;
}

// ---- transform runner -------------------------------------------------------------

function viewBoxOf(svg) {
  const vb = (svg.attrs.viewBox ?? '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every((v) => !Number.isNaN(v)) && vb[2] > 0 && vb[3] > 0) return vb;
  const w = Number.parseFloat(svg.attrs.width), h = Number.parseFloat(svg.attrs.height);
  if (w > 0 && h > 0) return [0, 0, w, h];
  throw new Error('cannot determine canvas size (need viewBox or width/height)');
}

function resolveMinArea(spec, vb) {
  const minDim = Math.min(vb[2], vb[3]);
  if (spec === null) { const side = minDim / 1000; return side * side; }
  const pm = String(spec).match(/^([\d.]+)%$/);
  if (pm) { const side = (Number(pm[1]) / 100) * minDim; return side * side; }
  const n = Number(spec);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--min-area must be a number (px²) or N%, got "${spec}"`);
  return n;
}

// Run the enabled subset of transforms over the file text. enabled is a Set
// of transform numbers (1..4).
function runTransforms(text, enabled, minAreaSpec, punchThrough = false) {
  const svg = parseSvg(text);
  const vb = viewBoxOf(svg);
  // Flattening tolerance and the containment epsilon must resolve sub-pixel
  // detail AT RENDER SCALE: vectorizers hug region boundaries with thin
  // seam-cover fringes that overhang their neighbor by a pixel or two, and a
  // coarse tolerance classifies them as "contained", whose removal then
  // exposes hairline seams along every edge (seen on real files). /8192 is
  // ~0.5px on a 4096 canvas; eps=tol only absorbs knife-edge samples sitting
  // exactly on shared boundaries.
  const tol = Math.min(vb[2], vb[3]) / 8192;
  const eps = tol;
  const minArea = resolveMinArea(minAreaSpec, vb);
  const { drawables, groups } = collectDrawables(svg, tol);
  const stats = {
    pathsBefore: drawables.filter((d) => d.tag === 'path').length,
    groupsUnwrapped: 0, specksRemoved: 0, redundantRemoved: 0,
    whitesCompounded: 0, whitesPartial: 0, whitesBlockedReveal: 0, whitesBlockedOther: 0,
    punched: 0, punchedRegions: [], knockoutTargets: new Set(), minArea, vb,
  };
  const canvasBase = findCanvasBase(drawables, vb);
  const unwrapped = enabled.has(1) ? transform1Groups(groups, stats) : [];
  if (enabled.has(2)) transform2Specks(drawables, canvasBase, minArea, stats);
  if (enabled.has(3)) transform3Redundant(drawables, canvasBase, eps, stats);
  if (enabled.has(4)) transform4Knockouts(drawables, canvasBase, eps, stats, punchThrough);
  stats.pathsAfter = drawables.filter((d) => d.tag === 'path' && d.alive).length;
  stats.knockoutCount = stats.knockoutTargets.size;
  const out = buildOutput(text, drawables, unwrapped);
  stats.changed = out !== text;
  return { out, stats };
}

// ---- verify: render both over magenta, pixel-diff ------------------------------------

const VERIFY_WIDTH = 1000;
const VERIFY_MAX_CHANGED = 0.0005; // 0.05% of flat-field pixels
const VERIFY_MAX_EDGE_CHANGED = 0.02; // sanity cap for AA-seam pixels
const VERIFY_CHANNEL_TOL = 8;
const VERIFY_EDGE_GRAD = 24; // original-render gradient that marks an edge px

function rsvgAvailable() {
  try {
    execFileSync('rsvg-convert', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function renderOverMagenta(file) {
  const png = PNG.sync.read(execFileSync('rsvg-convert',
    ['-w', String(VERIFY_WIDTH), file], { maxBuffer: 256 * 1024 * 1024 }));
  const { width, height, data } = png;
  const out = Buffer.alloc(width * height * 3);
  const bg = [255, 0, 255]; // magenta exposes accidentally-created transparency
  for (let i = 0, o = 0; i < data.length; i += 4, o += 3) {
    const a = data[i + 3];
    out[o] = Math.round((data[i] * a + bg[0] * (255 - a)) / 255);
    out[o + 1] = Math.round((data[i + 1] * a + bg[1] * (255 - a)) / 255);
    out[o + 2] = Math.round((data[i + 2] * a + bg[2] * (255 - a)) / 255);
  }
  return { width, height, px: out };
}

// Edge mask from the ORIGINAL render: a pixel whose 8-neighborhood carries a
// significant gradient (plus one dilation). Deltas confined to this mask are
// single-pixel antialiasing seams: a duplicated white traced exactly over a
// white beneath it leaves (1-a)^2 background residue on its shared edge
// where a single paint leaves (1-a) — removing the duplicate is
// vector-exact and print-identical, but shows up as a delta-<=64 hairline in
// a screen-resolution render. Real damage (exposed pattern dots, deleted
// visible shapes, transparency over the magenta) lands in flat field and is
// judged strictly.
function edgeMask(img) {
  const { width, height, px } = img;
  const mark = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      let g = 0;
      for (let dy = -1; dy <= 1 && g <= VERIFY_EDGE_GRAD; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = (ny * width + nx) * 3;
          g = Math.max(g,
            Math.abs(px[i] - px[j]), Math.abs(px[i + 1] - px[j + 1]), Math.abs(px[i + 2] - px[j + 2]));
          if (g > VERIFY_EDGE_GRAD) break;
        }
      }
      if (g > VERIFY_EDGE_GRAD) mark[y * width + x] = 1;
    }
  }
  const dilated = new Uint8Array(mark);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mark[y * width + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height) dilated[ny * width + nx] = 1;
        }
      }
    }
  }
  return dilated;
}

// Rasterize the punched whites' regions at verify resolution, dilated ~2px
// for antialiasing at the hole edges. Pixels under this mask are EXCLUDED
// from the diff entirely — the rendering change there is the sanctioned,
// intentional point of --punch-through. Everything outside the mask is
// still judged by the standard gates, so the mask cannot blind the rail to
// unrelated damage.
function buildPunchMask(punched, width, height) {
  const [minX, minY, vbW, vbH] = punched.vb;
  const sx = width / vbW, sy = height / vbH;
  let mask = new Uint8Array(width * height);
  for (const reg of punched.regions) {
    const g = reg.flat;
    if (!g || g.subpaths.length === 0) continue;
    const px0 = Math.max(0, Math.floor((g.bbox[0] - minX) * sx) - 1);
    const px1 = Math.min(width - 1, Math.ceil((g.bbox[2] - minX) * sx) + 1);
    const py0 = Math.max(0, Math.floor((g.bbox[1] - minY) * sy) - 1);
    const py1 = Math.min(height - 1, Math.ceil((g.bbox[3] - minY) * sy) + 1);
    for (let y = py0; y <= py1; y++) {
      const vy = (y + 0.5) / sy + minY;
      for (let x = px0; x <= px1; x++) {
        if (insideRegion(g.idx, reg.fillRule, (x + 0.5) / sx + minX, vy)) mask[y * width + x] = 1;
      }
    }
  }
  for (const [dx, dy] of [[1, 0], [0, 1]]) { // separable dilation, radius 2
    const grown = new Uint8Array(mask);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!mask[y * width + x]) continue;
        for (let d = -2; d <= 2; d++) {
          const nx = x + d * dx, ny = y + d * dy;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height) grown[ny * width + nx] = 1;
        }
      }
    }
    mask = grown;
  }
  return mask;
}

function verifyPair(origFile, outText, punched = null) {
  const dir = mkdtempSync(path.join(tmpdir(), 'svg-knockout-'));
  try {
    const outFile = path.join(dir, 'candidate.svg');
    writeFileSync(outFile, outText);
    const a = renderOverMagenta(origFile);
    const b = renderOverMagenta(outFile);
    if (a.width !== b.width || a.height !== b.height) {
      return { pass: false, changedPct: 100, edgeChangedPct: 0, maskedPct: 0, maxDelta: 255, note: 'render size mismatch' };
    }
    const mask = edgeMask(a);
    const pmask = punched && punched.regions.length > 0
      ? buildPunchMask(punched, a.width, a.height)
      : null;
    let changed = 0, edgeChanged = 0, masked = 0, maxDelta = 0;
    for (let i = 0, p = 0; i < a.px.length; i += 3, p++) {
      if (pmask && pmask[p]) { masked++; continue; } // intentional punch region
      const d = Math.max(
        Math.abs(a.px[i] - b.px[i]),
        Math.abs(a.px[i + 1] - b.px[i + 1]),
        Math.abs(a.px[i + 2] - b.px[i + 2]));
      if (d > VERIFY_CHANNEL_TOL) {
        if (mask[p]) edgeChanged++;
        else { changed++; if (d > maxDelta) maxDelta = d; }
      }
    }
    const total = a.px.length / 3;
    const frac = changed / total, edgeFrac = edgeChanged / total;
    return {
      pass: frac < VERIFY_MAX_CHANGED && edgeFrac < VERIFY_MAX_EDGE_CHANGED,
      changedPct: frac * 100, edgeChangedPct: edgeFrac * 100,
      maskedPct: (masked / total) * 100, maxDelta, changed, total,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- per-file pipeline with bisect ---------------------------------------------------

const LEVELS = [
  { enabled: [1, 2, 3, 4], dropped: null },
  { enabled: [1, 2, 3], dropped: 'white knockouts (4)' },
  { enabled: [1, 2], dropped: 'white knockouts (4) + redundant removal (3)' },
  { enabled: [1], dropped: 'all but group unwrapping (4+3+2)' },
];

function processFile(file, opts) {
  const text = readFileSync(file, 'utf8');
  console.log(`${path.basename(file)}:`);

  const dest = opts.inPlace
    ? file
    : path.join(path.dirname(file), path.basename(file, '.svg') + '-compound.svg');
  if (!opts.inPlace && !opts.force && !opts.dryRun && existsSync(dest)) {
    console.log(`  skipped (exists: ${path.basename(dest)}; use --force to regenerate)`);
    return { status: 'skipped' };
  }

  let result = null, verify = null, rolledBack = null;
  for (const level of LEVELS) {
    let r;
    try {
      r = runTransforms(text, new Set(level.enabled), opts.minArea, opts.punchThrough);
    } catch (e) {
      console.log(`  error: ${e.message}`);
      return { status: 'error' };
    }
    if (opts.noVerify) { result = r; break; }
    if (!r.stats.changed) { result = r; verify = { pass: true, changedPct: 0, maxDelta: 0, trivial: true }; break; }
    const v = verifyPair(file, r.out, { regions: r.stats.punchedRegions, vb: r.stats.vb });
    if (v.pass) { result = r; verify = v; rolledBack = level.dropped; break; }
    console.log(
      `  verify FAILED with ${level.dropped === null ? 'all transforms' : `transforms {${level.enabled.join(',')}}`}: ` +
      `${v.changedPct.toFixed(4)}% flat-field pixels changed (max delta ${v.maxDelta}; ` +
      `${v.edgeChangedPct.toFixed(4)}% on AA edges)` +
      `${v.note ? ` — ${v.note}` : ''} — bisecting`);
  }
  if (result === null) {
    console.log('  FAIL: no transform subset passed verification — nothing written');
    return { status: 'failed' };
  }

  const s = result.stats;
  console.log(`  paths ${s.pathsBefore} -> ${s.pathsAfter}`);
  if (s.groupsUnwrapped) console.log(`  trivial groups unwrapped: ${s.groupsUnwrapped}`);
  console.log(`  specks removed: ${s.specksRemoved} (min area ${s.minArea.toFixed(1)} px²)`);
  console.log(`  redundant same-color removed: ${s.redundantRemoved}`);
  console.log(`  whites compounded: ${s.whitesCompounded} (into ${s.knockoutCount} knockout path${s.knockoutCount === 1 ? '' : 's'})`);
  if (opts.punchThrough) console.log(`  punched through (intentional reveal): ${s.punched}`);
  if (s.whitesPartial) console.log(`  whites left alone (partial overlap): ${s.whitesPartial}`);
  if (s.whitesBlockedReveal) console.log(`  whites left alone (knockout would not reveal white): ${s.whitesBlockedReveal}`);
  if (s.whitesBlockedOther) console.log(`  whites left alone (blocked by intervening paint): ${s.whitesBlockedOther}`);
  console.log(`  bytes ${text.length.toLocaleString()} -> ${result.out.length.toLocaleString()}` +
    ` (${((result.out.length / text.length - 1) * 100).toFixed(1)}%)`);
  if (opts.noVerify) {
    console.log('  verify: SKIPPED (--no-verify)');
  } else if (verify.trivial) {
    console.log('  verify: PASS (no changes needed)');
  } else {
    console.log(`  verify: PASS ${verify.changedPct.toFixed(4)}% flat-field pixels changed` +
      ` (max delta ${verify.maxDelta}; ${verify.edgeChangedPct.toFixed(4)}% single-px AA seams)` +
      (verify.maskedPct > 0 ? ` (${verify.maskedPct.toFixed(2)}% masked as intentional punch-through)` : '') +
      ` @${VERIFY_WIDTH}px over magenta`);
  }
  if (rolledBack) console.log(`  rolled back: ${rolledBack} — render diff exceeded ${VERIFY_MAX_CHANGED * 100}%`);

  if (opts.dryRun) {
    console.log('  dry run: nothing written');
    return { status: 'ok' };
  }
  if (!s.changed) {
    console.log('  no changes needed, nothing written');
    return { status: 'ok' };
  }
  writeFileSync(dest, result.out);
  console.log(`  wrote ${dest}`);
  return { status: 'ok' };
}

const CHEAT = `# svg-knockout

> Turn stacked vectorizer SVG output into true compound-path knockouts and strip invisible noise paths.
> More information: svg-knockout --help.

- Simulate on a folder, running the render check but writing nothing:

\`svg-knockout --dry-run {{path/to/directory}}\`

- Write *-compound.svg copies beside the originals:

\`svg-knockout {{path/to/file1.svg path/to/file2.svg ...}}\`

- Overwrite every SVG in a folder, recursively:

\`svg-knockout --in-place {{path/to/directory}}\`

- Set the speck threshold as a share of the viewBox:

\`svg-knockout --min-area {{0.1%}} {{path/to/file.svg}}\`

- Also hole whites that reveal other paint underneath:

\`svg-knockout --punch-through {{path/to/file.svg}}\``;

// ---- CLI -------------------------------------------------------------------------------

function collectSvgs(p, out) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const e of readdirSync(p).sort()) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      collectSvgs(path.join(p, e), out);
    }
  } else if (p.toLowerCase().endsWith('.svg') && !p.toLowerCase().endsWith('-compound.svg')) {
    out.push(p);
  }
}

function main() {
  const { values, positionals } = parseArgs({
    options: {
      'min-area': { type: 'string' },
      'punch-through': { type: 'boolean', default: false },
      'in-place': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'no-verify': { type: 'boolean', default: false },
      cheat: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.cheat && !values.help) {
    console.log(CHEAT);
    return;
  }

  if (values.help || positionals.length === 0) {
    const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n');
    const header = [];
    for (const l of lines.slice(1)) { // skip shebang, stop at first code line
      if (!l.startsWith('//')) break;
      header.push(l.slice(3));
    }
    console.log(header.join('\n'));
    process.exit(positionals.length === 0 && !values.help ? 1 : 0);
  }

  const opts = {
    minArea: values['min-area'] ?? null,
    punchThrough: values['punch-through'],
    inPlace: values['in-place'],
    force: values.force,
    dryRun: values['dry-run'],
    noVerify: values['no-verify'],
  };
  if (opts.minArea !== null) {
    try {
      resolveMinArea(opts.minArea, [0, 0, 1000, 1000]); // validate the format early
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }

  if (!opts.noVerify && !rsvgAvailable()) {
    console.error('rsvg-convert not found: the render-diff safety rail cannot run.');
    console.error('Install librsvg (brew install librsvg / dnf install librsvg2-tools),');
    console.error('or pass --no-verify to proceed WITHOUT verification (transforms could');
    console.error('ship visual damage unnoticed — not recommended for production art).');
    process.exit(1);
  }

  const files = [];
  for (const p of positionals) {
    if (!existsSync(p)) { console.error(`not found: ${p}`); process.exit(1); }
    collectSvgs(p, files);
  }
  if (files.length === 0) {
    console.error('no SVG files found');
    process.exit(1);
  }
  let failed = 0;
  for (const f of files) {
    const r = processFile(f, opts);
    if (r.status === 'failed' || r.status === 'error') failed++;
  }
  if (failed > 0) process.exit(1);
}

main();
