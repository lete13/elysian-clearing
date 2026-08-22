'use strict';
/**
 * Build srv/patches-103.json: Platform Invoices agent hardening.
 * - one agent/pull per month (single-flight, no duplicate Chromium workers)
 * - a failed/cancelled leftover Airbnb pull blocks the send (force overrides)
 * - agent mail loop respects EMAIL_MAX_BYTES and persists who was already
 *   emailed when a send fails mid-loop, so a retry never re-sends a pack
 * - a stored empty accountant list stays empty (no default resurrection),
 *   and the leased send no longer falls back to the env default addresses
 * - Ship per-card loop skips an oversized card instead of aborting mid-loop
 * - piExecutePullJob resolves its promise on every exit path (a cancelled
 *   pull used to leave the awaiting agent hung at status running forever)
 * - booking-zip dedupe keys on the zip entry name from stored meta and on
 *   the legacy hash-less filename, matching content-hash invoice filenames
 * Run: node scripts/_build-pi-agent-hardening.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function applySrv(untilName) {
  let src = fs.readFileSync(path.join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'patches.json' : 'patches-' + n + '.json';
    if (name === untilName) break;
    const file = path.join(root, 'srv', name);
    if (!fs.existsSync(file)) break;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (spec.baseSha256 && sha256(src) !== spec.baseSha256) throw new Error(name + ' base drift');
    for (const p of spec.patches || []) {
      const parts = src.split(p.find);
      if (parts.length - 1 !== (p.count || 1)) throw new Error(name + ' anchor: ' + p.note);
      src = parts.join(p.replace);
    }
    if (spec.expectedSha256 && sha256(src) !== spec.expectedSha256) throw new Error(name + ' expected sha');
  }
  return src;
}

const src = applySrv('patches-103.json');

const patches = [];

patches.push({
  note: 'A stored empty accountant list is a real configuration, not "unset"',
  find:
    "      const parsed = piAccountants.parseAccountantsData(r.rows[0].data);\n" +
    '      if (parsed && parsed.length) return parsed;',
  replace:
    "      const parsed = piAccountants.parseAccountantsData(r.rows[0].data);\n" +
    '      if (parsed) return parsed;',
  count: 1,
});

patches.push({
  note: 'Leased send uses accountant cards only — no env default fallback',
  find:
    "    if (!to.length && scope === 'leased' && PLATFORM_INV_ACCOUNTANT) to = emailSplitAddrs(PLATFORM_INV_ACCOUNTANT);\n" +
    "    if (!to.length && !(scope === 'leased' && accountantCards.length)) return res.status(400).json({ error: 'No recipient (set accountant cards, to=, or PLATFORM_INVOICE_ACCOUNTANT_EMAIL)' });",
  replace:
    "    if (!to.length && scope === 'leased' && !accountantCards.length) {\n" +
    "      return res.status(400).json({ error: 'No accountant cards configured — add cards under Accountants before shipping' });\n" +
    '    }\n' +
    "    if (!to.length && !(scope === 'leased' && accountantCards.length)) return res.status(400).json({ error: 'No recipient (set accountant cards or to=)' });",
  count: 1,
});

patches.push({
  note: 'Ship skips an oversized card instead of aborting after earlier sends',
  find:
    "        if (!mailAtts.length) { skipped.push({ email: c.email, reason: 'no attachments' }); continue; }\n" +
    "        if (bytes > EMAIL_MAX_BYTES) return res.status(413).json({ error: 'Pack too large for one email' });\n" +
    "        const info = await piSendAccountantMail(c.email, b.subject || label, b.text || ('Attached platform invoices for ' + month + '\\n'), mailAtts);",
  replace:
    "        if (!mailAtts.length) { skipped.push({ email: c.email, reason: 'no attachments' }); continue; }\n" +
    "        if (bytes > EMAIL_MAX_BYTES) { skipped.push({ email: c.email, reason: 'pack too large for one email (' + Math.round(bytes / 1048576) + ' MB > 20 MB)' }); continue; }\n" +
    "        const info = await piSendAccountantMail(c.email, b.subject || label, b.text || ('Attached platform invoices for ' + month + '\\n'), mailAtts);",
  count: 1,
});

patches.push({
  note: 'One agent per month; the agent does not race a running pull',
  find:
    "app.post('/api/platform-invoices/agent', async (req, res) => {\n" +
    '  const b = req.body || {};\n' +
    "  const month = String(b.month || '');\n" +
    "  if (!/^\\d{4}-\\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month' });\n" +
    '  const job = {',
  replace:
    "app.post('/api/platform-invoices/agent', async (req, res) => {\n" +
    '  const b = req.body || {};\n' +
    "  const month = String(b.month || '');\n" +
    "  if (!/^\\d{4}-\\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month' });\n" +
    '  for (const existing of _piAgentJobs.values()) {\n' +
    "    if (existing && existing.month === month && (existing.status === 'starting' || existing.status === 'running')) {\n" +
    "      return res.status(409).json({ error: 'Agent already running for ' + month, job: piAgentPublic(existing) });\n" +
    '    }\n' +
    '  }\n' +
    '  for (const existingPull of _piPullJobs.values()) {\n' +
    "    if (existingPull && existingPull.month === month && (existingPull.status === 'starting' || existingPull.status === 'running' || existingPull.status === 'cancelling')) {\n" +
    "      return res.status(409).json({ error: 'A pull is already running for ' + month + ' — wait for it or stop it before running the agent' });\n" +
    '    }\n' +
    '  }\n' +
    '  const job = {',
  count: 1,
});

patches.push({
  note: 'Leftover pull failure/cancel is recorded, not silently dropped',
  find:
    '          leftover.saved = (pullJob.saved || []).map(function (f) { return f.reservationId || f.code || f.filename; });\n' +
    '          leftover.errors = pullJob.errors || [];',
  replace:
    '          leftover.saved = (pullJob.saved || []).map(function (f) { return f.reservationId || f.code || f.filename; });\n' +
    '          leftover.errors = (pullJob.errors || []).slice();\n' +
    '          if (pullJob.error) leftover.errors.push({ error: pullJob.error });\n' +
    "          if (pullJob.status && pullJob.status !== 'done') leftover.pullStatus = pullJob.status;",
  count: 1,
});

patches.push({
  note: 'Agent send: pull failure blocks, size cap per card, partial-send persisted',
  find:
    '      const cards = await piLoadAccountants();\n' +
    '      const emailPlan = piAgent.planAccountantEmails(cards, b.force ? Object.assign({}, pack, { blocked: false }) : pack);\n' +
    "      const report = piAgent.buildAgentReport({ month: month, pack: pack, leftover: leftover, emailPlan: emailPlan, status: pack.blocked ? 'blocked' : 'ready' });\n" +
    '      if ((!pack.blocked || b.force) && emailPlan.sent.length && b.send !== false) {\n' +
    "        if (!emailConfigured()) throw new Error('Email is not configured');\n" +
    "        job.hint = 'Emailing accountants…';\n" +
    '        job.updatedAt = Date.now();\n' +
    '        const emailed = [];\n' +
    '        for (const c of emailPlan.sent) {\n' +
    '          const sub = piAgent.packForCard(pack, c);\n' +
    "          if (sub.empty) { report.skipped.push({ id: c.id, email: c.email, reason: 'no_rows_for_listed_apartments' }); continue; }\n" +
    '          const mailAtts = [];\n' +
    "          if (c.attachExcel && sub.xlsBuf) mailAtts.push({ filename: sub.xlsName, content: sub.xlsBuf, contentType: 'application/vnd.ms-excel' });\n" +
    '          if (c.attachPdfs) {\n' +
    '            for (const r of sub.pdfRows) {\n' +
    "              mailAtts.push({ filename: r.filename || (r.channel + '.pdf'), content: Buffer.from(r.data, 'base64'), contentType: r.mime || 'application/pdf' });\n" +
    '            }\n' +
    '          }\n' +
    '          if (!mailAtts.length) continue;\n' +
    "          await piSendAccountantMail(c.email, 'PLATFORM INVOICES ' + month, 'Platform invoice pack for ' + month + '.\\n', mailAtts);\n" +
    '          emailed.push({ email: c.email, pdfs: !!c.attachPdfs, excel: !!c.attachExcel, rows: sub.pdfRows.length });\n' +
    '        }\n' +
    '        report.emailed = emailed;\n' +
    "        report.status = 'sent';\n" +
    '      }\n' +
    '      await piPersistAgentReport(report);\n' +
    '      job.report = report;\n' +
    "      job.status = 'done';\n" +
    "      job.hint = pack.blocked && !b.force ? 'Blocked by Booking reconcile errors — not emailed' : 'Agent finished';",
  replace:
    '      const cards = await piLoadAccountants();\n' +
    '      const pullFailed = !!leftover.pullStatus || (leftover.errors || []).length > 0;\n' +
    '      const sendBlocked = (pack.blocked || pullFailed) && !b.force;\n' +
    '      const emailPlan = piAgent.planAccountantEmails(cards, Object.assign({}, pack, { blocked: sendBlocked }));\n' +
    "      const report = piAgent.buildAgentReport({ month: month, pack: pack, leftover: leftover, emailPlan: emailPlan, status: sendBlocked ? 'blocked' : 'ready' });\n" +
    "      if (pullFailed) report.pullFailed = leftover.pullStatus || 'errors';\n" +
    '      job.report = report;\n' +
    '      if (!sendBlocked && emailPlan.sent.length && b.send !== false) {\n' +
    "        if (!emailConfigured()) throw new Error('Email is not configured');\n" +
    "        job.hint = 'Emailing accountants…';\n" +
    '        job.updatedAt = Date.now();\n' +
    '        const emailed = [];\n' +
    '        report.emailed = emailed;\n' +
    '        try {\n' +
    '          for (const c of emailPlan.sent) {\n' +
    '            const sub = piAgent.packForCard(pack, c);\n' +
    "            if (sub.empty) { report.skipped.push({ id: c.id, email: c.email, reason: 'no_rows_for_listed_apartments' }); continue; }\n" +
    '            const mailAtts = [];\n' +
    '            let mailBytes = 0;\n' +
    "            if (c.attachExcel && sub.xlsBuf) { mailAtts.push({ filename: sub.xlsName, content: sub.xlsBuf, contentType: 'application/vnd.ms-excel' }); mailBytes += sub.xlsBuf.length; }\n" +
    '            if (c.attachPdfs) {\n' +
    '              for (const r of sub.pdfRows) {\n' +
    "                const pdfBuf = Buffer.from(r.data, 'base64');\n" +
    '                mailBytes += pdfBuf.length;\n' +
    "                mailAtts.push({ filename: r.filename || (r.channel + '.pdf'), content: pdfBuf, contentType: r.mime || 'application/pdf' });\n" +
    '              }\n' +
    '            }\n' +
    '            if (!mailAtts.length) continue;\n' +
    "            if (mailBytes > EMAIL_MAX_BYTES) { report.skipped.push({ id: c.id, email: c.email, reason: 'pack_too_large_for_one_email' }); continue; }\n" +
    "            await piSendAccountantMail(c.email, 'PLATFORM INVOICES ' + month, 'Platform invoice pack for ' + month + '.\\n', mailAtts);\n" +
    '            emailed.push({ email: c.email, pdfs: !!c.attachPdfs, excel: !!c.attachExcel, rows: sub.pdfRows.length });\n' +
    '          }\n' +
    "          report.status = 'sent';\n" +
    '        } catch (eSend) {\n' +
    "          report.status = emailed.length ? 'partial' : 'error';\n" +
    '          report.sendError = eSend.message || String(eSend);\n' +
    '          try { await piPersistAgentReport(report); } catch (ePersist) {}\n' +
    '          throw eSend;\n' +
    '        }\n' +
    '      }\n' +
    '      await piPersistAgentReport(report);\n' +
    '      job.report = report;\n' +
    "      job.status = 'done';\n" +
    '      job.hint = sendBlocked\n' +
    "        ? (pack.blocked ? 'Blocked by Booking reconcile errors — not emailed' : 'Blocked: leftover Airbnb pull did not finish cleanly — not emailed')\n" +
    "        : 'Agent finished';",
  count: 1,
});

patches.push({
  note: 'Cancelled pull resolves the awaited promise (agent no longer hangs)',
  find:
    "        if (job.cancelled && !diskFiles.length && !(job.saved && job.saved.length)) {\n" +
    "          job.status = 'cancelled';\n" +
    '          job.error = null;\n' +
    "          job.hint = 'Pull stopped';\n" +
    '          job.updatedAt = Date.now();\n' +
    '          return;\n' +
    '        }',
  replace:
    "        if (job.cancelled && !diskFiles.length && !(job.saved && job.saved.length)) {\n" +
    "          job.status = 'cancelled';\n" +
    '          job.error = null;\n' +
    "          job.hint = 'Pull stopped';\n" +
    '          job.updatedAt = Date.now();\n' +
    '          resolvePull();\n' +
    '          return;\n' +
    '        }',
  count: 1,
});

patches.push({
  note: 'Failed pull result resolves the awaited promise',
  find:
    '      if (!Array.isArray(result.files)) {\n' +
    "        job.status = 'error';\n" +
    "        job.error = result.error || 'Pull failed';\n" +
    '        job.errors = result.errors || [];\n' +
    '        job.updatedAt = Date.now();\n' +
    '        return;\n' +
    '      }',
  replace:
    '      if (!Array.isArray(result.files)) {\n' +
    "        job.status = 'error';\n" +
    "        job.error = result.error || 'Pull failed';\n" +
    '        job.errors = result.errors || [];\n' +
    '        job.updatedAt = Date.now();\n' +
    '        resolvePull();\n' +
    '        return;\n' +
    '      }',
  count: 1,
});

patches.push({
  note: 'Spawn error resolves the awaited promise',
  find:
    "    job.status = 'error';\n" +
    '    job.error = eSpawn.message || String(eSpawn);\n' +
    '    job.updatedAt = Date.now();\n' +
    '  });',
  replace:
    "    job.status = 'error';\n" +
    '    job.error = eSpawn.message || String(eSpawn);\n' +
    '    job.updatedAt = Date.now();\n' +
    '    resolvePull();\n' +
    '  });',
  count: 1,
});

patches.push({
  note: 'Zip dedupe knows the stored zip entry name',
  find:
    '    seen[piBooking.bookingZipDupKey({\n' +
    '      bookingHotelId: meta.bookingHotelId || meta.reservationId,\n' +
    '      invoiceNumber: meta.invoiceNumber,\n' +
    '      filename: row.filename\n' +
    '    })] = true;',
  replace:
    '    seen[piBooking.bookingZipDupKey({\n' +
    '      bookingHotelId: meta.bookingHotelId || meta.reservationId,\n' +
    '      invoiceNumber: meta.invoiceNumber,\n' +
    '      zipName: meta.zipName,\n' +
    '      filename: row.filename\n' +
    '    })] = true;',
  count: 1,
});

patches.push({
  note: 'Zip dedupe also matches rows stored before content-hash filenames',
  find:
    '    const dup = piBooking.bookingZipDupKey(f);\n' +
    "    const fileKey = 'file:' + String(f.filename || '').replace(/\\\\/g, '/');\n" +
    '    if (seen[dup] || seen[fileKey]) {',
  replace:
    '    const dup = piBooking.bookingZipDupKey(f);\n' +
    "    const fileKey = 'file:' + String(f.filename || '').replace(/\\\\/g, '/');\n" +
    "    const legacyKey = !f.invoiceNumber ? fileKey.replace(/-[0-9a-f]{10}\\.pdf$/i, '.pdf') : fileKey;\n" +
    '    if (seen[dup] || seen[fileKey] || seen[legacyKey]) {',
  count: 1,
});

let out = src;
for (const [i, p] of patches.entries()) {
  const parts = out.split(p.find);
  if (parts.length - 1 !== (p.count || 1)) {
    throw new Error('patch ' + (i + 1) + ' (' + p.note + '): anchor count ' + (parts.length - 1));
  }
  out = parts.join(p.replace);
}

const cfg = {
  baseSha256: sha256(src),
  expectedSha256: sha256(out),
  builtAt: '2026-08-22 Platform Invoices agent hardening',
  patches: patches,
  assertions: [
    { has: "res.status(409).json({ error: 'Agent already running for '", note: 'agent single-flight' },
    { has: 'leftover.pullStatus = pullJob.status', note: 'pull failure recorded' },
    { has: 'const sendBlocked = (pack.blocked || pullFailed) && !b.force;', note: 'pull failure blocks send' },
    { has: 'mailBytes > EMAIL_MAX_BYTES', note: 'agent mail size cap' },
    { has: "report.status = emailed.length ? 'partial' : 'error';", note: 'partial send persisted' },
    { has: 'if (parsed) return parsed;', note: 'empty accountant list honored' },
    { has: 'resolvePull();\n          return;', note: 'cancel path resolves pull promise' },
    { has: 'legacyKey', note: 'legacy dedupe key' },
  ],
};

fs.writeFileSync(path.join(root, 'srv', 'patches-103.json'), JSON.stringify(cfg, null, 1) + '\n');
console.log('wrote srv/patches-103.json', cfg.expectedSha256);
