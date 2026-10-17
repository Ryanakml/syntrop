import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve('.');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const skills = [
  'research',
  'reasoning',
  'planning',
  'scheduling',
  'habits',
  'reflection',
  'calendar-presentation',
];
const adapters = [
  'CLAUDE.md',
  'GEMINI.md',
  '.cursor/rules/syntrop.mdc',
  '.github/copilot-instructions.md',
];

// These are instruction-integrity alarms, not tests of whether an LLM obeys
// the instructions. Scenario trace review is a separate evidence layer.
test('all runtime adapters discover the same canonical cognitive contract', () => {
  for (const path of adapters) {
    const text = read(path);
    assert.match(text, /AGENTS\.md/, `${path} must point to the canonical contract`);
    assert.doesNotMatch(text, /skills\/lifeos-/, `${path} references retired skill paths`);
  }
});

test('specialist skills have matching frontmatter, reachable links, and canonical routing', () => {
  for (const skill of skills) {
    const path = `skills/syntrop-${skill}/SKILL.md`;
    const text = read(path);
    const frontmatter = text.match(/^---\n([\s\S]+?)\n---\n/);
    assert.ok(frontmatter, `${path}: frontmatter missing`);
    assert.match(frontmatter[1], new RegExp(`^name: syntrop-${skill}$`, 'm'));
    assert.match(frontmatter[1], /^description: \S.+/m);
    assert.match(text, /\]\(\.\.\/\.\.\/AGENTS\.md\)/, `${path}: no canonical link`);
    assert.doesNotMatch(text, /skills\/lifeos-/);
    for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(https?:|#)/.test(target)) continue;
      assert.ok(
        existsSync(resolve(dirname(resolve(root, path)), target.split('#')[0])),
        `${path}: broken link ${target}`,
      );
    }
  }
});

test('canonical contract retains per-intent readiness, fast path, and reversible proposal scope', () => {
  const text = read('AGENTS.md');
  for (const state of [
    'READY',
    'NEEDS_EVIDENCE',
    'NEEDS_DECISION',
    'NEEDS_AUTHORIZATION',
    'BLOCKED',
  ]) {
    assert.match(text, new RegExp(`\\b${state}\\b`), `missing readiness branch ${state}`);
  }
  assert.match(text, /per workstream|each workstream|independent workstreams/i);
  assert.match(text, /not database fields|not.*(?:SQLite|schema)/i);
  assert.match(text, /low-risk|fast.path|act directly/i);
  assert.match(text, /plan[^.\n]*(?:proposal|not persistence)/i);
  assert.match(text, /provisional[^.\n]*(?:assumptions|draft)|draft[^.\n]*assumptions/i);
});

test('canonical contract protects evidence, research exceptions, tool boundaries, and optional delegation', () => {
  const text = read('AGENTS.md');
  assert.match(text, /(?:inspect|reconnaissance)[\s\S]*portfolio/i);
  assert.match(
    text,
    /(?:unavailable|could not be checked)[^.\n]*(?:invent|findings)|do not invent current findings/i,
  );
  assert.match(text, /stop[^.\n]*(?:evidence|decision)/i);
  assert.match(text, /(?:human interviews|timeboxed research)[^.\n]*legitimate/i);
  assert.match(text, /never edit SQLite directly/i);
  assert.match(text, /untrusted data[^.\n]*never instructions/i);
  assert.match(text, /--idempotency-key/);
  assert.match(text, /--expected-version/);
  assert.match(text, /validate[^.\n]*read back|read back[^.\n]*validate/i);
  assert.match(text, /(?:if the runtime supports delegation|optional delegation)/i);
  assert.match(text, /(?:parallel investigations|delegat)[^.\n]*must not mutate shared user data/i);
  assert.match(text, /(?:otherwise work sequentially|sequential)/i);
});

test('planning keeps both anti-premature-planning checks and legitimate investigation tasks', () => {
  const text = read('skills/syntrop-planning/SKILL.md');
  assert.match(text, /(?:unknown|readiness|evidence)/i);
  assert.match(text, /research|investigat/i);
  assert.match(text, /(?:human|timebox)/i);
  assert.match(text, /(?:authoriz|commit)/i);
  assert.match(text, /(?:provisional|proposal|draft)/i);
  assert.match(text, /(?:dependency|dependencies|prerequisite)/i);
});

test('public documentation and adapters have reachable local file links', async () => {
  const { readdirSync } = await import('node:fs');
  function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (
        directory === root &&
        entry.isDirectory() &&
        !['docs', 'skills', 'evals', '.github', '.cursor'].includes(entry.name)
      )
        return [];
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? walk(path) : /\.(md|mdc)$/.test(entry.name) ? [path] : [];
    });
  }
  for (const path of walk(root)) {
    const text = readFileSync(path, 'utf8');
    for (const [, raw] of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(raw)) continue;
      const target = decodeURIComponent(raw.split('#')[0]);
      assert.ok(existsSync(resolve(dirname(path), target)), `${path}: broken local link ${raw}`);
    }
  }
});
