import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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

test('punch fixture: default run leaves the no-white-reveal white alone', () => {
  inTmp('punch.svg', (dir, file) => {
    const out = run(file);
    assert.match(out, /whites left alone \(knockout would not reveal white\): 1/);
    assert.doesNotMatch(out, /punched through/); // line only exists under the flag
    assert.match(out, /no changes needed, nothing written/);
    assert.ok(!existsSync(path.join(dir, 'punch-compound.svg')));
  });
});

test('--punch-through converts category-2 whites into evenodd holes', () => {
  inTmp('punch.svg', (dir, file) => {
    const out = run('--punch-through', file);
    assert.match(out, /punched through \(intentional reveal\): 1/);
    assert.match(out, /whites compounded: 0/); // categories stay consistent
    assert.doesNotMatch(out, /knockout would not reveal white/);
    if (HAVE_RSVG) {
      // masked verify: the intentional region is excluded, the rest passes
      assert.match(out, /verify: PASS 0\.0000% flat-field/);
      assert.match(out, /masked as intentional punch-through/);
    }
    const compound = readFileSync(path.join(dir, 'punch-compound.svg'), 'utf8');
    const black = compound.match(/<path fill="#000" d="M250 250[^"]*"[^>]*>/);
    assert.ok(black, 'black target present');
    assert.match(black[0], /fill-rule="evenodd"/);
    assert.match(black[0], /M400 400/); // punched white's subpath appended
    assert.doesNotMatch(compound, /<path fill="#fff" d="M400 400/); // white gone
    assert.match(compound, /M150 150h700v700H150z/); // gray field untouched
  });
});

test('--punch-through mask does not blind verify to damage outside it', (t) => {
  if (!HAVE_RSVG) return t.skip('needs rsvg-convert');
  inTmp('punch.svg', (dir, file) => {
    // --min-area 1000 deliberately deletes a visible 30x30 gray dot far from
    // the punched region: verify must fail on that flat-field damage even
    // though a punch mask is active, and bisect must strip everything back.
    const out = run('--punch-through', '--min-area', '1000', file);
    assert.match(out, /verify FAILED with all transforms/);
    assert.match(out, /verify FAILED with transforms \{1,2\}/);
    assert.match(out, /no changes needed, nothing written/);
    assert.ok(!existsSync(path.join(dir, 'punch-compound.svg')));
  });
});

test('--help prints only the header block', () => {
  const out = run('--help');
  assert.match(out, /^svg-knockout: turn stacked AI-vectorizer SVG output/);
  assert.match(out, /--min-area/);
  assert.match(out, /--punch-through/);
  assert.doesNotMatch(out, /----/); // no internal section banners leak
  assert.doesNotMatch(out, /import /);
});

// ---- --cheat card ----------------------------------------------------------------

// Parse a --cheat card as a tldr page, throwing a message that names the first
// rule it breaks. The shape is the one the CHEAT comment in the tool spells out:
// "# name", blank, "> " lines ending "> More information: name --help.", blank,
// then 3 to 6 examples of "- what it does:", blank, "`name args`", blank-separated.
// Copy this into an adopted tool's tests to prove its card is a page.
function parseCheat(text) {
  const fail = (m) => { throw new Error(`cheat card: ${m}`); };
  if (!text.endsWith('\n') || text.endsWith('\n\n')) fail('must end with exactly one newline');
  const lines = text.slice(0, -1).split('\n');
  const title = /^# (\S+)$/.exec(lines[0]);
  if (!title) fail('line 1 must be "# <tool-name>"');
  const name = title[1];
  if (lines[1] !== '') fail('line 2 must be blank');
  let i = 2;
  const description = [];
  while (i < lines.length && lines[i].startsWith('> ')) description.push(lines[i++].slice(2));
  if (description.length < 2) fail('the description block needs a purpose line and a "More information" line');
  if (description.at(-1) !== `More information: ${name} --help.`) fail('the description block must end "More information: <tool-name> --help."');
  const examples = [];
  while (i < lines.length) {
    if (lines[i] !== '') fail(`line ${i + 1} must be blank before an example`);
    const [what, gap, cmd] = lines.slice(i + 1, i + 4);
    if (!/^- [A-Z].*:$/.test(what ?? '')) fail(`line ${i + 2} must be "- Sentence-case description:"`);
    if (gap !== '') fail(`line ${i + 3} must be blank between the description and the command`);
    const m = /^`([\x20-\x7e]+)`$/.exec(cmd ?? '');
    if (!m) fail(`line ${i + 4} must be the command in backticks, in plain ASCII`);
    if (m[1] !== name && !m[1].startsWith(`${name} `)) fail(`line ${i + 4} must start with the tool name "${name}"`);
    if ((m[1].match(/\{\{/g) ?? []).length !== (m[1].match(/\}\}/g) ?? []).length) fail(`line ${i + 4} has unbalanced {{placeholders}}`);
    examples.push({ what: what.slice(2), cmd: m[1] });
    i += 4;
  }
  if (examples.length < 3 || examples.length > 6) fail(`needs 3 to 6 examples, has ${examples.length}`);
  return { name, description, examples };
}

test('--cheat prints a tldr page titled with the command name, exits 0, and prints nothing else', () => {
  const r = spawnSync('node', [CLI, '--cheat'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const page = parseCheat(r.stdout);
  assert.equal(page.name, 'svg-knockout');
  assert.ok(page.examples.length >= 3);
});
