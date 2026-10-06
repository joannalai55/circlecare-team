const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function fixture(t, live = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'circlecare-test-'));
  fs.cpSync(path.join(__dirname, '../team'), path.join(directory, 'team'), { recursive: true });
  const allocator = net.createServer();
  allocator.listen(0, '127.0.0.1');
  await once(allocator, 'listening');
  const port = allocator.address().port;
  await new Promise(resolve => allocator.close(resolve));
  const cli = path.join(directory, 'fake-claude');
  fs.writeFileSync(cli, '#!/usr/bin/env node\nconsole.log(JSON.stringify({result:"Test task complete",total_cost_usd:0,is_error:false}));\n');
  fs.chmodSync(cli, 0o755);
  const child = spawn(process.execPath, [path.join(directory, 'team/server.js')], {
    env: { ...process.env, PORT: String(port), ENABLE_DISPATCH: live ? '1' : '0', CLAUDE_BIN: cli },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', d => logs += d);
  child.stderr.on('data', d => logs += d);
  t.after(async () => {
    if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) return base; } catch {}
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Server did not start: ' + logs);
}

test('preview serves sample data and protects local files and dispatch', async t => {
  const base = await fixture(t);
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.members.length, 5);
  assert.deepEqual(state.recentActivity, []);
  assert.match(await (await fetch(base)).text(), /Team Dashboard/);
  for (const route of ['/server.js', '/shared/team-context.md', '/../README.md']) {
    assert.equal((await fetch(base + route)).status, 404);
  }
  assert.equal((await fetch(base + '/api/dispatch', { method: 'POST' })).status, 403);
  assert.equal((await fetch(base + '/api/state', { headers: { Origin: 'https://example.com' } })).status, 403);
});

test('live dispatch validates input and records a fake CLI result', async t => {
  const base = await fixture(t, true);
  const post = body => fetch(base + '/api/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ memberIds: ['unknown'], task: 'Test' })).status, 400);
  assert.equal((await post({ memberIds: ['ryan'], task: '' })).status, 400);
  assert.equal((await post({ memberIds: ['ryan'], task: 'x'.repeat(70000) })).status, 413);
  assert.equal((await post({ memberIds: ['ryan'], task: 'Sample task' })).status, 200);
  for (let i = 0; i < 100; i++) {
    const runs = await (await fetch(base + '/api/runs')).json();
    if (runs[0]?.status === 'done') {
      assert.equal(runs[0].result, 'Test task complete');
      const state = await (await fetch(base + '/api/state')).json();
      assert.equal(state.members.find(m => m.id === 'ryan').status, 'done');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('Dispatch did not finish');
});
