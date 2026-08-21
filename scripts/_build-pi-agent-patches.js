'use strict';
/**
 * Build srv/patches-92.json and fe/patches-128.json for Platform Invoices agent.
 * Run: node scripts/_build-pi-agent-patches.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function applyKind(kind, stopAt) {
  const baseName = kind === 'fe' ? 'index.html' : 'server.js';
  let src = fs.readFileSync(path.join(root, baseName), 'utf8').replace(/\r\n/g, '\n');
  let sha = sha256(src);
  let last = 'base';
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'patches.json' : 'patches-' + n + '.json';
    if (stopAt && name === stopAt) break;
    const file = path.join(root, kind, name);
    if (!fs.existsSync(file)) break;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (spec.baseSha256 !== sha) throw new Error(kind + '/' + name + ' base drift have=' + sha.slice(0, 12));
    for (const p of spec.patches || []) {
      const count = src.split(p.find).length - 1;
      if (count !== (p.count || 1)) throw new Error(kind + '/' + name + ' ' + p.note + ' found ' + count);
      src = src.split(p.find).join(p.replace);
    }
    sha = sha256(src);
    if (sha !== spec.expectedSha256) throw new Error(kind + '/' + name + ' expected sha mismatch');
    last = name;
  }
  return { src, sha, last };
}

function writePatch(kind, n, baseSha, patches, builtAt, assertions) {
  // Stop before this file so regenerating an existing tip stays idempotent.
  let src = applyKind(kind, 'patches-' + n + '.json').src;
  for (const p of patches) {
    const count = src.split(p.find).length - 1;
    if (count !== (p.count || 1)) throw new Error('precheck ' + kind + ' ' + p.note + ': found ' + count);
    src = src.split(p.find).join(p.replace);
  }
  const expected = sha256(src);
  const out = {
    baseSha256: baseSha,
    expectedSha256: expected,
    builtAt: builtAt,
    patches: patches,
    assertions: assertions || [],
  };
  fs.writeFileSync(path.join(root, kind, 'patches-' + n + '.json'), JSON.stringify(out, null, 1) + '\n');
  console.log('wrote', kind + '/patches-' + n + '.json', expected.slice(0, 12));
  return expected;
}

const srv = applyKind('srv', 'patches-92.json');
const fe = applyKind('fe', 'patches-128.json');
console.log('bases', srv.last, srv.sha.slice(0, 12), fe.last, fe.sha.slice(0, 12));

const srvFindRequire =
  "const { buildAccountantXls, fileMetaJson, parseMeta, archiveMonthOf, plannedRefile } = require('./scripts/platform-invoice-accountant-xls');\n" +
  "const { estimateAirbnbInvoices, expectGaps, TINY_PDF_BYTES } = require('./scripts/platform-invoice-expect');\n" +
  'async function piRefileAirbnbByIssueDate() {';

const srvReplaceRequire =
  "const { buildAccountantXls, accountantXlsFilename, fileMetaJson, parseMeta, archiveMonthOf, plannedRefile } = require('./scripts/platform-invoice-accountant-xls');\n" +
  "const { estimateAirbnbInvoices, expectGaps, TINY_PDF_BYTES } = require('./scripts/platform-invoice-expect');\n" +
  "const { reconcileBookingMonth } = require('./scripts/platform-invoice-booking');\n" +
  "const piAccountants = require('./scripts/platform-invoice-accountants');\n" +
  "const piAgent = require('./scripts/platform-invoice-agent');\n" +
  'const PI_ACCOUNTANTS_KEY = piAccountants.ACCOUNTANTS_KEY;\n' +
  "const PI_AGENT_RUNS_KEY = 'pi_agent_runs';\n" +
  'async function piLoadDbApts() {\n' +
  '  if (!pool) return [];\n' +
  '  try {\n' +
  "    const r = await pool.query(\"SELECT data FROM app_data WHERE key='main'\");\n" +
  '    const data = r.rows[0] && r.rows[0].data;\n' +
  '    return (data && Array.isArray(data.apts)) ? data.apts : [];\n' +
  '  } catch (e) { return []; }\n' +
  '}\n' +
  'async function piLoadAccountants() {\n' +
  '  const seeded = piAccountants.seedFromEnv(PLATFORM_INV_ACCOUNTANT);\n' +
  '  if (!pool) return seeded;\n' +
  '  try {\n' +
  '    const r = await pool.query(\'SELECT data FROM app_data WHERE key=$1\', [PI_ACCOUNTANTS_KEY]);\n' +
  '    if (r.rows.length && r.rows[0].data) {\n' +
  '      const parsed = piAccountants.parseAccountantsData(r.rows[0].data);\n' +
  '      if (parsed && parsed.length) return parsed;\n' +
  '    }\n' +
  '  } catch (e) {}\n' +
  '  return seeded;\n' +
  '}\n' +
  'async function piSaveAccountants(list) {\n' +
  '  const cards = (Array.isArray(list) ? list : []).map(piAccountants.normalizeCard).filter(Boolean);\n' +
  '  if (!pool) return cards;\n' +
  '  await pool.query(\n' +
  '    `INSERT INTO app_data (key, data) VALUES ($1, $2::jsonb)\n' +
  '     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,\n' +
  '    [PI_ACCOUNTANTS_KEY, JSON.stringify({ accountants: cards })]\n' +
  '  );\n' +
  '  return cards;\n' +
  '}\n' +
  'async function piLoadVaultRows(month) {\n' +
  '  if (pool) {\n' +
  '    await ensurePlatInvTable();\n' +
  '    try { await piRefileAirbnbByIssueDate(); } catch (eRefile) {}\n' +
  "    const q = await pool.query('SELECT * FROM platform_invoices WHERE month=$1 ORDER BY id', [month]);\n" +
  '    return q.rows;\n' +
  '  }\n' +
  '  try { await piRefileAirbnbByIssueDate(); } catch (eRefile) {}\n' +
  '  return [..._memPlatInv.values()].filter(function (x) { return x.month === month; });\n' +
  '}\n' +
  'async function piPersistAgentReport(report) {\n' +
  '  if (!pool || !report) return;\n' +
  '  try {\n' +
  '    let prev = [];\n' +
  '    const r = await pool.query(\'SELECT data FROM app_data WHERE key=$1\', [PI_AGENT_RUNS_KEY]);\n' +
  '    if (r.rows.length && r.rows[0].data) {\n' +
  '      const d = r.rows[0].data;\n' +
  '      prev = Array.isArray(d) ? d : (d.runs || []);\n' +
  '    }\n' +
  '    prev.unshift(report);\n' +
  '    prev = prev.slice(0, 40);\n' +
  '    await pool.query(\n' +
  '      `INSERT INTO app_data (key, data) VALUES ($1, $2::jsonb)\n' +
  '       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,\n' +
  '      [PI_AGENT_RUNS_KEY, JSON.stringify({ runs: prev })]\n' +
  '    );\n' +
  '  } catch (e) {}\n' +
  '}\n' +
  'const _piAgentJobs = new Map();\n' +
  'function piAgentPublic(job) {\n' +
  '  if (!job) return null;\n' +
  '  return {\n' +
  '    id: job.id, status: job.status, month: job.month, hint: job.hint || null,\n' +
  '    error: job.error || null, report: job.report || null,\n' +
  '    createdAt: job.createdAt, updatedAt: job.updatedAt\n' +
  '  };\n' +
  '}\n' +
  'async function piSendAccountantMail(to, subject, text, attachments) {\n' +
  '  const transporter = nodemailer.createTransport({\n' +
  '    host: EMAIL.host, port: EMAIL.port, secure: EMAIL.secure,\n' +
  '    auth: { user: EMAIL.user, pass: EMAIL.pass },\n' +
  '  });\n' +
  '  return transporter.sendMail({\n' +
  '    from: EMAIL.from, to: to, subject: subject, text: text, attachments: attachments\n' +
  '  });\n' +
  '}\n' +
  'async function piRefileAirbnbByIssueDate() {';

const srvPatches = [];
srvPatches.push({
  note: 'PI agent helpers + accountant loaders',
  find: srvFindRequire,
  replace: srvReplaceRequire,
  count: 1,
});

const xlsFind =
  '    const bks = await piLoadDbBookings();\n' +
  '    const buf = buildAccountantXls(rows, bks);\n' +
  "    const name = 'Airbnb-VAT-' + month + '.xls';";
const xlsReplace =
  '    const bks = await piLoadDbBookings();\n' +
  '    const apts = await piLoadDbApts();\n' +
  '    const recon = reconcileBookingMonth(month, bks, apts, rows);\n' +
  '    const packRows = rows.filter(function (r) {\n' +
  "      const ch = String((r && r.channel) || '').toLowerCase();\n" +
  "      return ch !== 'booking' && ch !== 'bdc';\n" +
  '    }).concat(recon.included || []);\n' +
  '    const buf = buildAccountantXls(packRows, bks, { includeBooking: true });\n' +
  '    const name = accountantXlsFilename(month);';
srvPatches.push({
  note: 'accountant-xls matched Booking + Platform-invoices filename',
  find: xlsFind,
  replace: xlsReplace,
  count: 1,
});

const toFind =
  '    let to = emailSplitAddrs(b.to);\n' +
  '    if (!to.length && scope === \'leased\' && PLATFORM_INV_ACCOUNTANT) to = emailSplitAddrs(PLATFORM_INV_ACCOUNTANT);\n' +
  "    if (!to.length) return res.status(400).json({ error: 'No recipient (set to= or PLATFORM_INVOICE_ACCOUNTANT_EMAIL)' });\n" +
  "    const partner = String(b.partner || '');";
const toReplace =
  '    let to = emailSplitAddrs(b.to);\n' +
  '    let accountantCards = [];\n' +
  '    if (!to.length && scope === \'leased\') {\n' +
  '      accountantCards = await piLoadAccountants();\n' +
  '    }\n' +
  '    if (!to.length && scope === \'leased\' && PLATFORM_INV_ACCOUNTANT) to = emailSplitAddrs(PLATFORM_INV_ACCOUNTANT);\n' +
  "    if (!to.length && !(scope === 'leased' && accountantCards.length)) return res.status(400).json({ error: 'No recipient (set accountant cards, to=, or PLATFORM_INVOICE_ACCOUNTANT_EMAIL)' });\n" +
  "    const partner = String(b.partner || '');";
srvPatches.push({ note: 'Ship loads accountant cards', find: toFind, replace: toReplace, count: 1 });

const shipFind =
  '    let bytes = 0;\n' +
  '    const mailAtts = [];\n' +
  '    const xlsBks = await piLoadDbBookings();\n' +
  '    const xlsBuf = buildAccountantXls(rows, xlsBks);\n' +
  "    mailAtts.push({ filename: 'Airbnb-VAT-' + month + '.xls', content: xlsBuf, contentType: 'application/vnd.ms-excel' });\n" +
  '    bytes += xlsBuf.length;\n' +
  '    for (const r of rows) {\n' +
  '      const buf = Buffer.from(r.data, \'base64\'); bytes += buf.length;\n' +
  "      mailAtts.push({ filename: r.filename || (r.channel + '.pdf'), content: buf, contentType: r.mime || 'application/pdf' });\n" +
  '    }\n' +
  '    if (bytes > EMAIL_MAX_BYTES) return res.status(413).json({ error: \'Pack too large for one email\' });\n' +
  "    const label = scope === 'leased'\n" +
  "      ? ('Elysian leased units — Airbnb/Booking.com invoices ' + month)\n" +
  "      : ('B2B platform invoices ' + month + (partner ? (' — ' + partner) : ''));\n" +
  '    const transporter = nodemailer.createTransport({\n' +
  '      host: EMAIL.host, port: EMAIL.port, secure: EMAIL.secure,\n' +
  '      auth: { user: EMAIL.user, pass: EMAIL.pass },\n' +
  '    });\n' +
  '    const info = await transporter.sendMail({\n' +
  '      from: EMAIL.from,\n' +
  "      to: to.join(', '),\n" +
  '      subject: b.subject || label,\n' +
  "      text: b.text || ('Attached: ' + rows.length + ' platform invoice(s) for ' + month + ' (' + scope + ').\\n\\nThese are Airbnb/Booking.com host invoices (ενδοκοινοτικά), not Greek domestic expenses.\\n\\n— Elysian Clearing'),\n" +
  '      attachments: mailAtts,\n' +
  '    });\n' +
  "    console.log('[platform-invoices] sent', month, scope, rows.length, '→', to.join(','));\n" +
  '    res.json({ ok: true, count: rows.length, messageId: info.messageId, to });';

const shipReplace =
  '    const xlsBks = await piLoadDbBookings();\n' +
  '    const xlsApts = await piLoadDbApts();\n' +
  '    const pack = piAgent.buildMonthPack(month, rows, xlsBks, xlsApts);\n' +
  "    if (scope === 'leased' && pack.blocked) {\n" +
  "      return res.status(409).json({ error: 'Booking reconcile errors — fix stays vs invoices before shipping', errors: pack.errors });\n" +
  '    }\n' +
  "    const label = scope === 'leased'\n" +
  "      ? ('Elysian leased units — Airbnb/Booking.com invoices ' + month)\n" +
  "      : ('B2B platform invoices ' + month + (partner ? (' — ' + partner) : ''));\n" +
  "    if (scope === 'leased' && accountantCards.length && !emailSplitAddrs(b.to).length) {\n" +
  '      const plan = piAgent.planAccountantEmails(accountantCards, pack);\n' +
  '      const emailed = [];\n' +
  '      const skipped = plan.skipped.slice();\n' +
  '      for (const c of plan.sent) {\n' +
  '        const mailAtts = [];\n' +
  '        let bytes = 0;\n' +
  '        if (c.attachExcel && pack.xlsBuf) {\n' +
  "          mailAtts.push({ filename: pack.xlsName, content: pack.xlsBuf, contentType: 'application/vnd.ms-excel' });\n" +
  '          bytes += pack.xlsBuf.length;\n' +
  '        }\n' +
  '        if (c.attachPdfs) {\n' +
  '          for (const r of pack.pdfRows) {\n' +
  "            const buf = Buffer.from(r.data, 'base64'); bytes += buf.length;\n" +
  "            mailAtts.push({ filename: r.filename || (r.channel + '.pdf'), content: buf, contentType: r.mime || 'application/pdf' });\n" +
  '          }\n' +
  '        }\n' +
  "        if (!mailAtts.length) { skipped.push({ email: c.email, reason: 'no attachments' }); continue; }\n" +
  '        if (bytes > EMAIL_MAX_BYTES) return res.status(413).json({ error: \'Pack too large for one email\' });\n' +
  '        const info = await piSendAccountantMail(c.email, b.subject || label, b.text || (\'Attached platform invoices for \' + month + \'\\n\'), mailAtts);\n' +
  '        emailed.push({ email: c.email, pdfs: !!c.attachPdfs, excel: !!c.attachExcel, messageId: info.messageId });\n' +
  '      }\n' +
  "      console.log('[platform-invoices] sent cards', month, emailed.length);\n" +
  '      return res.json({ ok: true, count: pack.pdfRows.length, emailed: emailed, skipped: skipped });\n' +
  '    }\n' +
  '    let bytes = 0;\n' +
  '    const mailAtts = [];\n' +
  "    mailAtts.push({ filename: pack.xlsName, content: pack.xlsBuf, contentType: 'application/vnd.ms-excel' });\n" +
  '    bytes += pack.xlsBuf.length;\n' +
  '    for (const r of pack.pdfRows) {\n' +
  "      const buf = Buffer.from(r.data, 'base64'); bytes += buf.length;\n" +
  "      mailAtts.push({ filename: r.filename || (r.channel + '.pdf'), content: buf, contentType: r.mime || 'application/pdf' });\n" +
  '    }\n' +
  "    if (bytes > EMAIL_MAX_BYTES) return res.status(413).json({ error: 'Pack too large for one email' });\n" +
  '    const info = await piSendAccountantMail(to.join(\', \'), b.subject || label, b.text || (\'Attached: \' + pack.pdfRows.length + \' platform invoice(s) for \' + month + \' (\' + scope + \').\\n\'), mailAtts);\n' +
  "    console.log('[platform-invoices] sent', month, scope, pack.pdfRows.length, '→', to.join(','));\n" +
  '    res.json({ ok: true, count: pack.pdfRows.length, messageId: info.messageId, to });';
srvPatches.push({ note: 'Ship reconciled pack + per-card email', find: shipFind, replace: shipReplace, count: 1 });

const insertAfter = "app.post('/api/platform-invoices/pull-stop', async (req, res) => {";
const apiBlock =
  "app.get('/api/platform-invoices/accountants', async (req, res) => {\n" +
  '  try { res.json({ ok: true, accountants: await piLoadAccountants() }); }\n' +
  '  catch (e) { res.status(500).json({ error: e.message }); }\n' +
  '});\n' +
  "app.put('/api/platform-invoices/accountants', async (req, res) => {\n" +
  '  try {\n' +
  '    const list = (req.body && (req.body.accountants || req.body.cards)) || [];\n' +
  '    res.json({ ok: true, accountants: await piSaveAccountants(list) });\n' +
  '  } catch (e) { res.status(500).json({ error: e.message }); }\n' +
  '});\n' +
  "app.get('/api/platform-invoices/agent/latest', async (req, res) => {\n" +
  '  try {\n' +
  '    if (!pool) return res.json({ ok: true, report: null, runs: [] });\n' +
  "    const r = await pool.query('SELECT data FROM app_data WHERE key=$1', [PI_AGENT_RUNS_KEY]);\n" +
  '    const d = r.rows.length ? r.rows[0].data : null;\n' +
  '    const runs = Array.isArray(d) ? d : ((d && d.runs) || []);\n' +
  '    res.json({ ok: true, report: runs[0] || null, runs: runs.slice(0, 10) });\n' +
  '  } catch (e) { res.status(500).json({ error: e.message }); }\n' +
  '});\n' +
  "app.get('/api/platform-invoices/agent/:jobId', (req, res) => {\n" +
  "  const job = _piAgentJobs.get(String(req.params.jobId || ''));\n" +
  "  if (!job) return res.status(404).json({ error: 'No agent job with that id' });\n" +
  '  res.json({ ok: true, job: piAgentPublic(job) });\n' +
  '});\n' +
  "app.post('/api/platform-invoices/agent', async (req, res) => {\n" +
  '  const b = req.body || {};\n' +
  "  const month = String(b.month || '');\n" +
  "  if (!/^\\d{4}-\\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month' });\n" +
  '  const job = {\n' +
  "    id: 'pia-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),\n" +
  "    status: 'starting', month: month, hint: 'Starting Platform Invoices agent…',\n" +
  '    error: null, report: null, createdAt: Date.now(), updatedAt: Date.now()\n' +
  '  };\n' +
  '  _piAgentJobs.set(job.id, job);\n' +
  '  res.json({ ok: true, job: piAgentPublic(job) });\n' +
  '  setImmediate(async function () {\n' +
  '    try {\n' +
  "      job.status = 'running';\n" +
  '      const leftover = { saved: [], alreadyHave: [], errors: [] };\n' +
  '      if (b.pullLeftovers !== false) {\n' +
  "        job.hint = 'Leftover Airbnb missing-only pull…';\n" +
  '        job.updatedAt = Date.now();\n' +
  '        try {\n' +
  '          const pullJob = {\n' +
  "            id: 'pip-' + Date.now().toString(36),\n" +
  "            status: 'starting', month: month, channel: 'airbnb',\n" +
  '            body: Object.assign({}, b, { month: month, channel: \'airbnb\' }),\n' +
  "            by: 'agent-leftover', hint: null, error: null, saved: [], errors: [],\n" +
  '            createdAt: Date.now(), updatedAt: Date.now()\n' +
  '          };\n' +
  '          _piPullJobs.set(pullJob.id, pullJob);\n' +
  '          await piExecutePullJob(pullJob);\n' +
  '          const pullDeadline = Date.now() + 90 * 60 * 1000;\n' +
  '          while (Date.now() < pullDeadline) {\n' +
  "            if (pullJob.status === 'done' || pullJob.status === 'error' || pullJob.status === 'cancelled') break;\n" +
  '            job.hint = pullJob.hint || job.hint;\n' +
  '            job.updatedAt = Date.now();\n' +
  '            await new Promise(function (r) { setTimeout(r, 1500); });\n' +
  '          }\n' +
  '          leftover.saved = (pullJob.saved || []).map(function (f) { return f.reservationId || f.code || f.filename; });\n' +
  '          leftover.errors = pullJob.errors || [];\n' +
  '          leftover.alreadyHave = Array.isArray(pullJob.alreadyHave) ? pullJob.alreadyHave.slice() : [];\n' +
  "          if (!leftover.alreadyHave.length && pullJob.status === 'done' && !(pullJob.saved || []).length && !(pullJob.errors || []).length) {\n" +
  "            leftover.alreadyHave = ['none-new'];\n" +
  '          }\n' +
  '        } catch (ePull) {\n' +
  '          leftover.errors.push({ error: ePull.message || String(ePull) });\n' +
  '        }\n' +
  '      }\n' +
  "      job.hint = 'Reconciling Booking + building Excel…';\n" +
  '      job.updatedAt = Date.now();\n' +
  '      const rows = await piLoadVaultRows(month);\n' +
  '      const bks = await piLoadDbBookings();\n' +
  '      const apts = await piLoadDbApts();\n' +
  '      const pack = piAgent.buildMonthPack(month, rows, bks, apts);\n' +
  '      const cards = await piLoadAccountants();\n' +
  '      const emailPlan = piAgent.planAccountantEmails(cards, pack);\n' +
  '      const report = piAgent.buildAgentReport({ month: month, pack: pack, leftover: leftover, emailPlan: emailPlan, status: pack.blocked ? \'blocked\' : \'ready\' });\n' +
  '      if (!pack.blocked && emailPlan.sent.length && b.send !== false) {\n' +
  '        if (!emailConfigured()) throw new Error(\'Email is not configured\');\n' +
  "        job.hint = 'Emailing accountants…';\n" +
  '        job.updatedAt = Date.now();\n' +
  '        const emailed = [];\n' +
  '        for (const c of emailPlan.sent) {\n' +
  '          const mailAtts = [];\n' +
  '          if (c.attachExcel && pack.xlsBuf) mailAtts.push({ filename: pack.xlsName, content: pack.xlsBuf, contentType: \'application/vnd.ms-excel\' });\n' +
  '          if (c.attachPdfs) {\n' +
  '            for (const r of pack.pdfRows) {\n' +
  "              mailAtts.push({ filename: r.filename || (r.channel + '.pdf'), content: Buffer.from(r.data, 'base64'), contentType: r.mime || 'application/pdf' });\n" +
  '            }\n' +
  '          }\n' +
  '          if (!mailAtts.length) continue;\n' +
  "          await piSendAccountantMail(c.email, 'PLATFORM INVOICES ' + month, 'Platform invoice pack for ' + month + '.\\n', mailAtts);\n" +
  '          emailed.push({ email: c.email, pdfs: !!c.attachPdfs, excel: !!c.attachExcel });\n' +
  '        }\n' +
  '        report.emailed = emailed;\n' +
  "        report.status = 'sent';\n" +
  '      }\n' +
  '      await piPersistAgentReport(report);\n' +
  '      job.report = report;\n' +
  "      job.status = 'done';\n" +
  "      job.hint = pack.blocked ? 'Blocked by Booking reconcile errors — not emailed' : 'Agent finished';\n" +
  '      job.updatedAt = Date.now();\n' +
  '    } catch (e) {\n' +
  "      job.status = 'error';\n" +
  '      job.error = e.message || String(e);\n' +
  '      job.updatedAt = Date.now();\n' +
  '    }\n' +
  '  });\n' +
  '});\n' +
  insertAfter;

srvPatches.push({ note: 'Accountant + agent APIs', find: insertAfter, replace: apiBlock, count: 1 });

writePatch('srv', 92, srv.sha, srvPatches, '2026-08-21 Platform Invoices agent + accountant cards', [
  { has: "require('./scripts/platform-invoice-accountants')", note: 'accountants helper' },
  { has: "require('./scripts/platform-invoice-agent')", note: 'agent helper' },
  { has: "app.get('/api/platform-invoices/accountants'", note: 'GET accountants' },
  { has: "app.post('/api/platform-invoices/agent'", note: 'POST agent' },
  { has: 'accountantXlsFilename(month)', note: 'neutral xls name' },
  { has: 'piAgent.buildMonthPack', note: 'ship uses month pack' },
  { has: 'Booking reconcile errors', note: 'ship blocked on booking errors' },
]);

// FE
const feFindShip =
  "'<div style=\"margin-top:10px\">Shipping will email the Elysian pack to accountants as the finished product for this month, including the accountant Excel (issue date, invoice number, amount, − on credits, then reservation id / listing / check-in / check-out).</div>' +\n" +
  "      '<div style=\"margin-top:8px\"><button class=\"btn sm\" onclick=\"piDownloadAccountantXls()\">Download accountant Excel</button></div>' +\n" +
  "      '<div style=\"margin-top:8px;color:var(--tx3)\">Open each PDF under PDFs by apartment below.</div>';";

const feReplaceShip =
  "'<div style=\"margin-top:10px\">Run Agent: leftover Airbnb pull → Booking reconcile → Excel → email each accountant card (PDF and/or Excel). Booking stays without invoice (or invoice without stays) block the send.</div>' +\n" +
  "      '<div id=\"pi-accountant-cards\" style=\"margin-top:10px\"></div>' +\n" +
  "      '<div style=\"margin-top:8px;display:flex;gap:8px;flex-wrap:wrap\">' +\n" +
  "      '<button class=\"btn sm\" onclick=\"piDownloadAccountantXls()\">Download Excel</button>' +\n" +
  "      '<button class=\"btn sm\" id=\"pi-agent-btn\" onclick=\"piRunAgent()\">Run Agent</button>' +\n" +
  "      '</div>' +\n" +
  "      '<div id=\"pi-agent-report\" style=\"margin-top:8px;font-size:12px;color:var(--tx2)\"></div>' +\n" +
  "      '<div style=\"margin-top:8px;color:var(--tx3)\">Open each PDF under PDFs by apartment below.</div>';\n" +
  '    try { piRenderAccountantCards(); piLoadAgentLatest(); } catch (eCards) {}';

const feFindDl =
  '  window.piDownloadAccountantXls = function () {\n' +
  '    var month = monthVal();\n' +
  "    window.open('/api/platform-invoices/accountant-xls?month=' + encodeURIComponent(month), '_blank');\n" +
  '  };';

const feReplaceDl =
  feFindDl +
  '\n' +
  '  window.piRenderAccountantCards = async function () {\n' +
  "    var box = document.getElementById('pi-accountant-cards');\n" +
  '    if (!box) return;\n' +
  '    try {\n' +
  "      var j = await fetch('/api/platform-invoices/accountants').then(function (r) { return r.json(); });\n" +
  '      var cards = (j && j.accountants) || [];\n' +
  "      if (!cards.length) { box.innerHTML = '<div style=\"color:var(--tx3)\">No accountant cards yet.</div>'; return; }\n" +
  '      box.innerHTML = cards.map(function (c, i) {\n' +
  "        return '<div class=\"pi-acct-card\" data-i=\"' + i + '\" style=\"border:1px solid var(--bdr);border-radius:10px;padding:10px 12px;margin-bottom:8px;background:var(--bg)\">' +\n" +
  "          '<div style=\"font-weight:600;margin-bottom:6px\">' + (c.name || c.email) + '</div>' +\n" +
  "          '<label style=\"display:block;font-size:12px;margin-bottom:4px\">Email <input data-f=\"email\" value=\"' + String(c.email || '').replace(/\"/g, '&quot;') + '\" style=\"width:100%;margin-top:2px\"></label>' +\n" +
  "          '<label style=\"margin-right:12px;font-size:12px\"><input type=\"checkbox\" data-f=\"receivePdfs\"' + (c.receivePdfs ? ' checked' : '') + '> PDFs</label>' +\n" +
  "          '<label style=\"font-size:12px\"><input type=\"checkbox\" data-f=\"receiveExcel\"' + (c.receiveExcel ? ' checked' : '') + '> Excel</label>' +\n" +
  "          '<input type=\"hidden\" data-f=\"id\" value=\"' + String(c.id || '') + '\">' +\n" +
  "          '<input type=\"hidden\" data-f=\"name\" value=\"' + String(c.name || '').replace(/\"/g, '&quot;') + '\">' +\n" +
  "        '</div>';\n" +
  "      }).join('') + '<button class=\"btn sm\" onclick=\"piSaveAccountantCards()\">Save accountant cards</button>';\n" +
  '    } catch (e) { box.innerHTML = \'<div style=\"color:#b00\">\' + (e.message || e) + \'</div>\'; }\n' +
  '  };\n' +
  '  window.piSaveAccountantCards = async function () {\n' +
  "    var box = document.getElementById('pi-accountant-cards');\n" +
  '    if (!box) return;\n' +
  '    var cards = [];\n' +
  "    box.querySelectorAll('.pi-acct-card').forEach(function (el) {\n" +
  "      var get = function (f) { var n = el.querySelector('[data-f=\"' + f + '\"]'); return n ? n.value : ''; };\n" +
  "      var chk = function (f) { var n = el.querySelector('[data-f=\"' + f + '\"]'); return !!(n && n.checked); };\n" +
  '      cards.push({ id: get(\'id\'), name: get(\'name\') || get(\'email\'), email: get(\'email\'), receivePdfs: chk(\'receivePdfs\'), receiveExcel: chk(\'receiveExcel\') });\n' +
  '    });\n' +
  "    msg('Saving accountant cards…', true);\n" +
  '    try {\n' +
  "      var res = await fetch('/api/platform-invoices/accountants', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountants: cards }) });\n" +
  '      var j = await res.json();\n' +
  "      if (!res.ok) throw new Error((j && j.error) || 'save failed');\n" +
  "      msg('Accountant cards saved', true);\n" +
  '      await piRenderAccountantCards();\n' +
  '    } catch (e) { msg(e.message || String(e), false); }\n' +
  '  };\n' +
  '  window.piLoadAgentLatest = async function () {\n' +
  "    var box = document.getElementById('pi-agent-report');\n" +
  '    if (!box) return;\n' +
  '    try {\n' +
  "      var j = await fetch('/api/platform-invoices/agent/latest').then(function (r) { return r.json(); });\n" +
  '      var r = j && j.report;\n' +
  "      if (!r) { box.textContent = ''; return; }\n" +
  "      box.innerHTML = '<b>Last agent</b> ' + (r.month || '') + ' · ' + (r.status || '') +\n" +
  "        ' · Excel ' + ((r.excel && r.excel.totalRows) || 0) + ' rows' +\n" +
  "        ' · emailed ' + ((r.emailed && r.emailed.length) || 0) +\n" +
  "        ((r.booking && r.booking.errors && r.booking.errors.length) ? (' · Booking errors ' + r.booking.errors.length) : '');\n" +
  '    } catch (e) {}\n' +
  '  };\n' +
  '  window.piRunAgent = async function () {\n' +
  '    var month = monthVal();\n' +
  "    var btn = document.getElementById('pi-agent-btn');\n" +
  '    if (btn) btn.disabled = true;\n' +
  "    msg('Running Platform Invoices agent for ' + month + '…', true);\n" +
  '    try {\n' +
  "      var res = await fetch('/api/platform-invoices/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month: month, send: true }) });\n" +
  '      var j = await res.json();\n' +
  "      if (!res.ok) throw new Error((j && j.error) || 'agent failed');\n" +
  '      var id = j.job && j.job.id;\n' +
  '      var deadline = Date.now() + 95 * 60 * 1000;\n' +
  '      while (id && Date.now() < deadline) {\n' +
  '        await new Promise(function (r) { setTimeout(r, 1500); });\n' +
  "        var st = await fetch('/api/platform-invoices/agent/' + encodeURIComponent(id)).then(function (r) { return r.json(); });\n" +
  '        var job = st && st.job;\n' +
  '        if (!job) break;\n' +
  '        if (job.hint) msg(job.hint, true);\n' +
  "        if (job.status === 'done' || job.status === 'error') {\n" +
  '          if (job.error) throw new Error(job.error);\n' +
  '          var rep = job.report || {};\n' +
  "          msg('Agent ' + (rep.status || 'done') + ' · Excel rows ' + ((rep.excel && rep.excel.totalRows) || 0) +\n" +
  "            ((rep.booking && rep.booking.errors && rep.booking.errors.length) ? (' · blocked: ' + rep.booking.errors.length + ' Booking error(s)') : ''),\n" +
  "            rep.status !== 'blocked' && rep.status !== 'error');\n" +
  '          await piLoadAgentLatest();\n' +
  '          break;\n' +
  '        }\n' +
  '      }\n' +
  '    } catch (e) { msg(e.message || String(e), false); }\n' +
  '    if (btn) btn.disabled = false;\n' +
  '  };';

const fePatches = [
  { note: 'Review: accountant cards + Run Agent', find: feFindShip, replace: feReplaceShip, count: 1 },
  { note: 'FE accountant cards + agent client', find: feFindDl, replace: feReplaceDl, count: 1 },
];

writePatch('fe', 128, fe.sha, fePatches, '2026-08-21 Platform Invoices agent + accountant cards', [
  { has: 'piRenderAccountantCards', note: 'accountant cards renderer' },
  { has: 'piRunAgent', note: 'run agent client' },
  { has: 'pi-accountant-cards', note: 'cards container' },
  { has: '/api/platform-invoices/agent', note: 'agent API used' },
  { has: 'Save accountant cards', note: 'save button' },
]);

console.log('done');
