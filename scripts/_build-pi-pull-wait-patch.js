'use strict';
/**
 * SRV tip patch: track already_have from worker stdout; await child close in pull.
 * Run after srv/patches-92.json exists: node scripts/_build-pi-pull-wait-patch.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const sha = (s) => crypto.createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex');

function applySrv(stopAt) {
  let src = fs.readFileSync(path.join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'patches.json' : 'patches-' + n + '.json';
    if (stopAt && name === stopAt) break;
    const p = path.join(root, 'srv', name);
    if (!fs.existsSync(p)) break;
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const patch of cfg.patches || []) {
      if (!src.includes(patch.find)) throw new Error('miss find in ' + name + ' :: ' + patch.note);
      src = src.split(patch.find).join(patch.replace);
    }
  }
  return src;
}

const src = applySrv('patches-93.json');
const base = sha(src);

const findPublic =
  '    saved: job.saved || [],\n' +
  '    errors: job.errors || [],\n' +
  '    progress: job.progress || null,\n';

const replacePublic =
  '    saved: job.saved || [],\n' +
  '    alreadyHave: job.alreadyHave || [],\n' +
  '    errors: job.errors || [],\n' +
  '    progress: job.progress || null,\n';

const findConsume =
  'function piPullConsumeStdoutLine(job, line) {\n' +
  '  try {\n' +
  '    const j = JSON.parse(line);\n' +
  "    if (j && j.event === 'progress') {\n" +
  "      job.progress = { done: j.done || 0, total: j.total || 0, saved: j.saved || 0, code: j.code || '', skipped: !!j.skipped };\n" +
  "      job.hint = (String(job.channel || '').toLowerCase() === 'booking' ? 'Pulling Booking.com ' : 'Pulling Airbnb ') + (j.done || 0) + '/' + (j.total || 0) +\n" +
  "        (j.code ? (' · ' + j.code) : '') +\n" +
  "        (j.skipped ? ' · already in vault' : '') +\n" +
  "        (j.saved ? (' · ' + j.saved + ' PDF(s) so far') : '') + '…';\n" +
  '      job.updatedAt = Date.now();\n' +
  "    } else if (j && j.event === 'saved' && j.path) {\n" +
  '      job.updatedAt = Date.now();\n';

// Only extend the progress branch; keep saved branch intact by replacing a unique prefix.
const replaceConsume =
  'function piPullConsumeStdoutLine(job, line) {\n' +
  '  try {\n' +
  '    const j = JSON.parse(line);\n' +
  "    if (j && j.event === 'progress') {\n" +
  "      job.progress = { done: j.done || 0, total: j.total || 0, saved: j.saved || 0, code: j.code || '', skipped: !!j.skipped };\n" +
  "      job.hint = (String(job.channel || '').toLowerCase() === 'booking' ? 'Pulling Booking.com ' : 'Pulling Airbnb ') + (j.done || 0) + '/' + (j.total || 0) +\n" +
  "        (j.code ? (' · ' + j.code) : '') +\n" +
  "        (j.skipped ? ' · already in vault' : '') +\n" +
  "        (j.saved ? (' · ' + j.saved + ' PDF(s) so far') : '') + '…';\n" +
  '      job.updatedAt = Date.now();\n' +
  "    } else if (j && j.event === 'already_have' && j.code) {\n" +
  '      if (!Array.isArray(job.alreadyHave)) job.alreadyHave = [];\n' +
  '      if (job.alreadyHave.indexOf(j.code) < 0) job.alreadyHave.push(j.code);\n' +
  '      job.updatedAt = Date.now();\n' +
  "    } else if (j && j.event === 'saved' && j.path) {\n" +
  '      job.updatedAt = Date.now();\n';

const findClose =
  "  const { spawn } = require('child_process');\n" +
  "  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });\n" +
  '  job.child = child;\n' +
  "  let stdout = '', stderr = '', carry = '';\n" +
  '  const timer = setTimeout(function () {\n' +
  "    try { child.kill('SIGTERM'); } catch (e) {}\n";

const replaceClose =
  "  const { spawn } = require('child_process');\n" +
  '  return await new Promise(function (resolvePull) {\n' +
  "  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });\n" +
  '  job.child = child;\n' +
  "  let stdout = '', stderr = '', carry = '';\n" +
  '  const timer = setTimeout(function () {\n' +
  "    try { child.kill('SIGTERM'); } catch (e) {}\n";

const findResolve =
  '      job.updatedAt = Date.now();\n' +
  '    } catch (eClose) {\n' +
  "      job.status = 'error';\n" +
  '      job.error = eClose.message || String(eClose);\n' +
  '      job.updatedAt = Date.now();\n' +
  '    }\n' +
  '  });\n' +
  '}\n' +
  '\n' +
  "app.post('/api/platform-invoices/pull', async (req, res) => {\n";

const replaceResolve =
  '      job.updatedAt = Date.now();\n' +
  '    } catch (eClose) {\n' +
  "      job.status = 'error';\n" +
  '      job.error = eClose.message || String(eClose);\n' +
  '      job.updatedAt = Date.now();\n' +
  '    }\n' +
  '    resolvePull();\n' +
  '  });\n' +
  '  });\n' +
  '}\n' +
  '\n' +
  "app.post('/api/platform-invoices/pull', async (req, res) => {\n";

for (const [label, find] of [
  ['findPublic', findPublic],
  ['findConsume', findConsume],
  ['findClose', findClose],
  ['findResolve', findResolve],
]) {
  const count = src.split(find).length - 1;
  if (count !== 1) throw new Error(label + ' count=' + count);
}

let next = src;
next = next.split(findPublic).join(replacePublic);
next = next.split(findConsume).join(replaceConsume);
next = next.split(findClose).join(replaceClose);
next = next.split(findResolve).join(replaceResolve);

const cfg = {
  baseSha256: base,
  expectedSha256: sha(next),
  builtAt: '2026-08-21 Pull already_have + await worker close',
  patches: [
    { note: 'Expose alreadyHave on pull job', find: findPublic, replace: replacePublic, count: 1 },
    { note: 'Track already_have worker events', find: findConsume, replace: replaceConsume, count: 1 },
    { note: 'piExecutePullJob awaits child close', find: findClose, replace: replaceClose, count: 1 },
    { note: 'Resolve pull promise after harvest', find: findResolve, replace: replaceResolve, count: 1 },
  ],
  assertions: [
    { has: "j.event === 'already_have'", note: 'already_have tracked' },
    { has: 'alreadyHave: job.alreadyHave || []', note: 'public alreadyHave' },
    { has: 'return await new Promise(function (resolvePull)', note: 'await worker' },
    { has: 'resolvePull();', note: 'resolve after close' },
  ],
};

fs.writeFileSync(path.join(root, 'srv', 'patches-93.json'), JSON.stringify(cfg, null, 1) + '\n');
console.log('wrote srv/patches-93.json', cfg.expectedSha256);
