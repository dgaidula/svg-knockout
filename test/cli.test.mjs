import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLI = new URL('../svg-knockout.mjs', import.meta.url).pathname;
const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

// The verify rail needs rsvg-convert; without it the CLI refuses to run
// unless --no-verify is passed. Tests adapt so the suite works either way,
// but the render-diff assertions only run when rsvg is present.
let HAVE_RSVG = true;
try {
  execFileSync('rsvg-convert', ['--version'], { stdio: 'pipe' });
} catch {
  HAVE_RSVG = false;
}
const baseArgs = HAVE_RSVG ? [] : ['--no-verify'];

const run = (...args) => execFileSync('node', [CLI, ...baseArgs, ...args], { encoding: 'utf8' });

function inTmp(fixture, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'knockout-'));
  try {
    const file = path.join(dir, fixture);
    copyFileSync(path.join(FIXTURES, fixture), file);
    return fn(dir, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('nesting: white eye becomes an evenodd hole in the head, pupil untouched', () => {
  inTmp('nesting.svg', (dir, file) => {
    const out = run(file);
    assert.match(out, /paths 4 -> 3/);
    assert.match(out, /whites compounded: 1 \(into 1 knockout path\)/);
    if (HAVE_RSVG) assert.match(out, /verify: PASS/); // render-diff proof
    const compound = readFileSync(path.join(dir, 'nesting-compound.svg'), 'utf8');
    // geometric proof of evenodd correctness: the head path gained the eye's
    // subpath and the evenodd rule; the standalone eye path is gone
    const head = compound.match(/<path fill="#000000" d="M200 200[^"]*"[^>]*>/);
    assert.ok(head, 'head path present');
    assert.match(head[0], /fill-rule="evenodd"/);
    assert.match(head[0], /M350 350/); // appended eye subpath
    assert.doesNotMatch(compound, /<path fill="#ffffff" d="M350 350/);
    // the pupil painted on top of the eye must survive as its own path
    assert.match(compound, /<path fill="#000000" d="M450 450h100v100H450z"\/>/);
  });
});

test('partial overlap: white straddling a black is left untouched and counted', () => {
  inTmp('partial.svg', (dir, file) => {
    const out = run(file);
    assert.match(out, /whites left alone \(partial overlap\): 1/);
    assert.match(out, /whites compounded: 0/);
    assert.match(out, /no changes needed, nothing written/);
    assert.ok(!existsSync(path.join(dir, 'partial-compound.svg')));
  });
});

test('redundant same-color removed only when nothing intervenes', () => {
  inTmp('redundant.svg', (dir, file) => {
    const out = run(file);
    assert.match(out, /redundant same-color removed: 1/);
    const compound = readFileSync(path.join(dir, 'redundant-compound.svg'), 'utf8');
    // the black square buried in the big black with nothing between: gone
    assert.doesNotMatch(compound, /M200 200h100v100H200z/);
    // the black square with the intervening gray (bbox+region overlap): kept
    assert.match(compound, /M600 400h100v100H600z/);
    assert.match(compound, /M550 350h200v200H550z/); // the gray itself
  });
});

test('pattern and gradient fills pass through untouched', () => {
  inTmp('patterns.svg', (dir, file) => {
    const original = readFileSync(file, 'utf8');
    const out = run(file);
    // white inside black over the pattern canvas: knocking it out would
    // reveal benday dots, not white -> left alone
    assert.match(out, /whites left alone \(knockout would not reveal white\): 1/);
    // the tiny gradient-filled path is below the speck threshold but url()
    // fills are never speck-removed
    assert.match(out, /specks removed: 0/);
    assert.match(out, /no changes needed, nothing written/);
    assert.ok(!existsSync(path.join(dir, 'patterns-compound.svg')));
    assert.equal(readFileSync(file, 'utf8'), original); // input untouched
  });
});

test('bottom-most full-canvas path is never holed', () => {
  inTmp('canvas.svg', (dir, file) => {
    const out = run(file);
    assert.match(out, /whites compounded: 0/);
    assert.match(out, /no changes needed, nothing written/);
    assert.ok(!existsSync(path.join(dir, 'canvas-compound.svg')));
  });
});

test('speck threshold: default area math and any-color removal', () => {
  inTmp('specks.svg', (dir, file) => {
    // viewBox 1000 -> default min area = (1000/1000)^2 = 1 px²
    const out = run(file);
    assert.match(out, /specks removed: 2 \(min area 1\.0 px²\)/);
    const compound = readFileSync(path.join(dir, 'specks-compound.svg'), 'utf8');
    assert.doesNotMatch(compound, /M100 100h\.5v\.5H100z/); // black speck, area .25
    assert.doesNotMatch(compound, /M550 550h\.6v\.6H550z/); // WHITE speck on black
    assert.match(compound, /M300 300h5v5H300z/); // area 25 >= 1: kept
  });
});

test('--min-area accepts px² and % forms and rejects junk', () => {
  inTmp('specks.svg', (dir, file) => {
    const out = run('--min-area', '30', file);
    assert.match(out, /specks removed: 3 \(min area 30\.0 px²\)/); // 5x5=25 < 30 too
    const compound = readFileSync(path.join(dir, 'specks-compound.svg'), 'utf8');
    assert.doesNotMatch(compound, /M300 300h5v5H300z/);
  });
  inTmp('specks.svg', (dir, file) => {
    // 1% of min(viewBox) = 10px side -> 100 px²
    const out = run('--min-area', '1%', file);
    assert.match(out, /specks removed: 3 \(min area 100\.0 px²\)/);
  });
  assert.throws(
    () => run('--min-area', 'abc', path.join(FIXTURES, 'specks.svg')),
    /--min-area must be a number/);
});

test('trivial groups unwrapped, attributed groups preserved', () => {
  inTmp('groups.svg', (dir, file) => {
    const out = run(file);
    assert.match(out, /trivial groups unwrapped: 2/);
    const compound = readFileSync(path.join(dir, 'groups-compound.svg'), 'utf8');
    assert.doesNotMatch(compound, /<g id="wrapper">/);
    assert.doesNotMatch(compound, /<g>/);
    assert.match(compound, /<g fill="#888">/); // non-trivial group survives
    // paint order preserved: canvas, black square, then the group's path
    const order = [...compound.matchAll(/M(0 0|100 100|300 300)/g)].map((m) => m[1]);
    assert.deepEqual(order, ['0 0', '100 100', '300 300']);
  });
});

test('idempotent skip and --force regenerate', () => {
  inTmp('nesting.svg', (dir, file) => {
    const first = run(file);
    assert.match(first, /wrote .*nesting-compound\.svg/);
    const second = run(file);
    assert.match(second, /skipped \(exists: nesting-compound\.svg; use --force to regenerate\)/);
    const third = run('--force', file);
    assert.match(third, /wrote .*nesting-compound\.svg/);
  });
});

test('folder mode recurses and never reprocesses *-compound.svg outputs', () => {
  inTmp('nesting.svg', (dir) => {
    copyFileSync(path.join(FIXTURES, 'redundant.svg'), path.join(dir, 'redundant.svg'));
    run(dir);
    const second = run(dir); // outputs from run 1 are not inputs for run 2
    assert.doesNotMatch(second, /nesting-compound\.svg:/);
    assert.doesNotMatch(second, /redundant-compound\.svg:/);
    assert.match(second, /nesting\.svg:/);
    assert.match(second, /redundant\.svg:/);
  });
});

test('--dry-run reports but writes nothing', () => {
  inTmp('nesting.svg', (dir, file) => {
    const before = readdirSync(dir).sort();
    const original = readFileSync(file, 'utf8');
    const out = run('--dry-run', file);
    assert.match(out, /whites compounded: 1/);
    assert.match(out, /dry run: nothing written/);
    assert.deepEqual(readdirSync(dir).sort(), before);
    assert.equal(readFileSync(file, 'utf8'), original);
  });
});

test('--in-place overwrites the input', () => {
  inTmp('nesting.svg', (dir, file) => {
    const out = run('--in-place', file);
    assert.match(out, new RegExp(`wrote ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const rewritten = readFileSync(file, 'utf8');
    assert.match(rewritten, /fill-rule="evenodd"/);
    assert.ok(!existsSync(path.join(dir, 'nesting-compound.svg')));
  });
});

test('--help prints only the header block', () => {
  const out = run('--help');
  assert.match(out, /^svg-knockout: turn stacked AI-vectorizer SVG output/);
  assert.match(out, /--min-area/);
  assert.doesNotMatch(out, /----/); // no internal section banners leak
  assert.doesNotMatch(out, /import /);
});
