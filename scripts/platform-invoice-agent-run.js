'use strict';
/**
 * Trigger Platform Invoices agent for one or more months.
 *
 * Usage:
 *   node scripts/platform-invoice-agent-run.js 2026-01 2026-02
 *   PI_BASE_URL=https://… PI_AUTH_USER=… PI_AUTH_PASS=… node scripts/platform-invoice-agent-run.js 2026-01..2026-07
 *
 * Does not password-login Booking.com. Leftover Airbnb pull uses the saved session.
 */
const fetch = require('node-fetch');

const base = String(process.env.PI_BASE_URL || process.env.APP_BASE_URL || '').replace(/\/$/, '');
const user = process.env.PI_AUTH_USER || process.env.APP_USER || '';
const pass = process.env.PI_AUTH_PASS || process.env.APP_PASSWORD || '';

function expandArgs(args) {
  const out = [];
  (args || []).forEach(function (a) {
    const m = String(a).match(/^(\d{4}-\d{2})\.\.(\d{4}-\d{2})$/);
    if (!m) {
      if (/^\d{4}-\d{2}$/.test(a)) out.push(a);
      return;
    }
    let [y, mo] = m[1].split('-').map(Number);
    const [ey, emo] = m[2].split('-').map(Number);
    while (y < ey || (y === ey && mo <= emo)) {
      out.push(y + '-' + String(mo).padStart(2, '0'));
      mo += 1;
      if (mo > 12) {
        mo = 1;
        y += 1;
      }
    }
  });
  return out;
}

async function waitJob(auth, id) {
  const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(base + '/api/platform-invoices/agent/' + encodeURIComponent(id), {
      headers: auth ? { Authorization: auth } : {},
    });
    const j = await res.json();
    const job = j && j.job;
    if (!job) throw new Error('job missing');
    if (job.status === 'done' || job.status === 'error') return job;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('timeout waiting for agent ' + id);
}

async function main() {
  const months = expandArgs(process.argv.slice(2));
  if (!months.length) {
    console.error('Usage: node scripts/platform-invoice-agent-run.js 2026-01..2026-07');
    process.exit(2);
  }
  if (!base) {
    console.log(JSON.stringify({ ok: false, error: 'Set PI_BASE_URL to the live app', months: months }, null, 2));
    process.exit(0);
  }
  const auth = user || pass ? 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') : '';
  const reports = [];
  for (const month of months) {
    const res = await fetch(base + '/api/platform-invoices/agent', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth ? { Authorization: auth } : {}),
      body: JSON.stringify({ month: month, send: true, pullLeftovers: true }),
    });
    const j = await res.json();
    if (!res.ok) {
      reports.push({ month: month, error: (j && j.error) || res.statusText });
      continue;
    }
    const job = await waitJob(auth, j.job.id);
    reports.push({ month: month, status: job.status, error: job.error || null, report: job.report || null });
  }
  console.log(JSON.stringify({ ok: true, reports: reports }, null, 2));
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
