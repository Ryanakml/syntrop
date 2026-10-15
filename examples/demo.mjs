import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const workspace = join(mkdtempSync(join(tmpdir(), 'lifeos-demo-')), 'my-life');
const cli = resolve('src/cli.ts');
function life(...args) {
  const result = spawnSync(process.execPath, [cli, '--workspace', workspace, '--json', ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

life('init', '--timezone', 'Asia/Jakarta');
const project = life('project', 'add', '--title', 'Example project');
const task = life(
  'task',
  'add',
  '--project',
  project.id,
  '--title',
  'Write the first contribution',
  '--status',
  'todo',
);
life(
  'schedule',
  'add',
  '--task',
  task.id,
  '--start',
  '2026-10-15T09:00+07:00',
  '--end',
  '2026-10-15T10:00+07:00',
);
const habit = life('habit', 'add', '--name', 'Read documentation');
life('habit', 'log', habit.id, '--date', '2026-10-15', '--outcome', 'completed');
const today = life('today', '--date', '2026-10-15');
const check = life('validate');
console.log(
  JSON.stringify(
    { workspace, project_id: project.id, task_id: task.id, today, validation: check },
    null,
    2,
  ),
);
