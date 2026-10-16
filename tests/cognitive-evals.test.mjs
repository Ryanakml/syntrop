import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cli, inspect, prepare, review, suite } from '../evals/run.mjs';

function fixture(t, scenario) {
  const result = prepare(scenario);
  t.after(() => rmSync(result.root, { recursive: true, force: true }));
  assert.ok(!result.workspace.startsWith(resolve('.')));
  assert.ok(result.workspace.startsWith(tmpdir()));
  return result;
}

test('scenario catalogue covers A–L, depth contrasts, limitations, and all review dimensions', () => {
  const ids = new Set(suite.scenarios.map((item) => item.id));
  assert.equal(ids.size, suite.scenarios.length);
  for (const id of [
    'A',
    'B',
    'C',
    'D',
    'D-unavailable',
    'E',
    'F',
    'F-records',
    'G',
    'H',
    'I',
    'J-simple',
    'J-moderate',
    'J-strategic',
    'K',
    'L',
  ])
    assert.ok(ids.has(id));
  const dimensions = new Set(suite.scenarios.flatMap((item) => Object.keys(item.criteria)));
  for (const dimension of [
    'intent',
    'depth',
    'skills',
    'evidence',
    'decision',
    'planning',
    'permission',
    'tools',
    'verification',
  ])
    assert.ok(dimensions.has(dimension));
  for (const scenario of suite.scenarios) {
    assert.ok(scenario.prompt.trim());
    assert.ok(Object.keys(scenario.criteria).length >= 3);
    for (const table of scenario.requiredChanges)
      assert.ok(scenario.allowedChanges.includes(table));
  }
});

test('fast-path fixture verifies real CLI mutation without claiming agent behavior', (t) => {
  const { root, workspace } = fixture(t, 'A');
  const initial = inspect(root);
  assert.equal(initial.requiredMutationPresent, false);
  assert.match(initial.behavioralVerdict, /NOT TESTED/);
  const habit = cli(
    workspace,
    'habit',
    'add',
    '--name',
    'Read 20 minutes',
    '--frequency',
    'daily',
    '--target',
    '1',
    '--idempotency-key',
    'eval-a-habit',
  );
  assert.equal(cli(workspace, 'habit', 'show', habit.id).target, 1);
  const after = inspect(root);
  assert.deepEqual(after.changedTables, ['habits']);
  assert.equal(after.boundaryPass, true);
  assert.equal(after.requiredMutationPresent, true);
  assert.equal(after.valid, true);
  assert.match(after.behavioralVerdict, /NOT TESTED/);
});

test('synthetic conflict fixture preserves blocked task and existing meeting', (t) => {
  const { root, workspace, ids } = fixture(t, 'I');
  assert.equal(cli(workspace, 'task', 'show', ids.implementImplementation).ready, false);
  assert.deepEqual(cli(workspace, 'task', 'show', ids.implementImplementation).blocked_by, [
    ids.prerequisite,
  ]);
  const meeting = cli(workspace, 'calendar', 'list').find((row) => row.id === ids.calendar);
  assert.equal(meeting.title, 'Synthetic existing meeting');
  assert.equal(inspect(root).boundaryPass, true);
});

test('inspection catches unauthorized changes and artifact edits in a read-only discussion', (t) => {
  const { root, workspace } = fixture(t, 'E');
  cli(workspace, 'task', 'add', '--title', 'Unauthorized plan');
  writeFileSync(join(root, 'artifacts/portfolio/index.html'), 'Unauthorized edit');
  const state = inspect(root);
  assert.equal(state.boundaryPass, false);
  assert.deepEqual(state.unexpectedTables, ['tasks']);
  assert.equal(state.changedArtifacts.length, 1);
});

test('review requires real trace excerpts and cannot silently promote incomplete scores', (t) => {
  const { root } = fixture(t, 'K');
  const path = join(root, 'review-template.json');
  const assessment = JSON.parse(readFileSync(path, 'utf8'));
  assessment.runtime = 'synthetic harness self-test, not an actual agent';
  assessment.model = 'none';
  writeFileSync(join(root, 'transcript.txt'), 'Harness test text only.');
  writeFileSync(path, JSON.stringify(assessment));
  assert.match(review(root, path).behavioralVerdict, /NOT TESTED/);
  assessment.criteria.depth = { score: 2, evidence: 'Not in trace' };
  writeFileSync(path, JSON.stringify(assessment));
  assert.throws(() => review(root, path), /exact evidence excerpt/);
  assessment.level = 'fresh-context-agent';
  writeFileSync(path, JSON.stringify(assessment));
  assert.throws(() => review(root, path), /explicitly attested/);
});

test('fixture runner refuses substituted workspace locations and unknown scenarios', (t) => {
  assert.throws(() => prepare('not-a-scenario'), /Unknown scenario/);
  const root = mkdtempSync(join(tmpdir(), 'syntrop-cognitive-eval-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, 'fixture.json'),
    JSON.stringify({ root, workspace: join(root, 'different'), scenario: 'A' }),
  );
  assert.throws(() => inspect(root), /workspace boundary/);
});

test('ambiguous plan persistence stays separate from explicit execution-record authorization', () => {
  const proposal = suite.scenarios.find((item) => item.id === 'F');
  const committed = suite.scenarios.find((item) => item.id === 'F-records');
  assert.deepEqual(proposal.allowedChanges, ['decisions']);
  assert.deepEqual(proposal.requiredChanges, ['decisions']);
  assert.ok(committed.requiredChanges.includes('tasks'));
  assert.ok(committed.allowedChanges.includes('task_dependencies'));
  assert.ok(!committed.allowedChanges.includes('work_sessions'));
});
