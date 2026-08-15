'use strict';
/**
 * Local fixture: stay page has no VAT invoice HTML until the total price is clicked
 * (Airbnb Help 438). Does not hit airbnb.com.
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const worker = path.join(root, 'scripts', 'platform-invoice-pull.js');

function stayHtml(code) {
  return `<!doctype html><html><body>
<h1>Stay ${code}</h1>
<p>Guest Alex · check-in 12 Jul · reservation ${code}</p>
<button type="button" id="total">Total €1,234</button>
<script>
document.getElementById('total').addEventListener('click', function () {
  var a = document.createElement('a');
  a.href = '/reservation/vat_invoice/INV99ABC';
  a.textContent = 'VAT invoice';
  document.body.appendChild(a);
  var c = document.createElement('a');
  c.href = '/reservation/vat_invoice/CN88XYZ';
  c.textContent = 'Credit note';
  document.body.appendChild(c);
});
</script>
</body></html>`;
}

function invoiceHtml(id) {
  const credit = /CN/i.test(String(id || ''));
  return `<!doctype html><html><body>
<h1>${credit ? 'Credit note' : 'VAT invoice'}</h1>
<p>${credit ? 'Credit note' : 'Invoice number'} ${id}</p>
<p>Airbnb service fee</p>
</body></html>`;
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      const stay = u.match(/^\/hosting\/stay\/([A-Z0-9]+)/i);
      if (stay) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(stayHtml(stay[1].toUpperCase()));
        return;
      }
      if (/^\/reservation\/vat_invoice\//i.test(u)) {
        const id = u.split('/').pop() || '';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(invoiceHtml(id));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, origin: 'http://127.0.0.1:' + port });
    });
  });
}

function runPull(origin, outDir, reservations, limit) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      PI_AIRBNB_ORIGIN: origin,
      PI_AIRBNB_RESERVATIONS_JSON: JSON.stringify(reservations),
      PI_APARTMENTS_JSON: JSON.stringify([{ aptId: 'apt-1', aptName: 'Birdhouse' }]),
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      PLAYWRIGHT_PROXY_SERVER: '',
    });
    if (limit) env.PI_AIRBNB_LIMIT = String(limit);
    delete env.PI_SESSION_DIR;
    const child = spawn(process.execPath, [worker, '--month=2026-07', '--channel=airbnb', '--out=' + outDir], {
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (e) {}
    }, 90000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = stdout.trim().split('\n').filter(Boolean);
      let parsed = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const j = JSON.parse(lines[i]);
          if (j && j.event !== 'progress') {
            parsed = j;
            break;
          }
        } catch (e) {}
      }
      resolve({ parsed, stdout, stderr, code });
    });
  });
}

(async function main() {
  const { server, origin } = await startServer();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-stay-'));
  try {
    const clickRun = await runPull(origin, path.join(outDir, 'click'), [
      { code: 'HMTEST01', kind: 'invoice', aptName: 'Birdhouse', createdOnChannel: 2000 },
    ]);
    assert(clickRun.parsed, 'worker printed a result JSON\n' + clickRun.stdout + clickRun.stderr);
    assert(clickRun.parsed.ok, 'click path saved a PDF: ' + JSON.stringify(clickRun.parsed));
    const clickPdf = path.join(outDir, 'click', 'Airbnb', '2026-07', 'Birdhouse', 'invoice-HMTEST01-INV99ABC.pdf');
    const clickCredit = path.join(outDir, 'click', 'Airbnb', '2026-07', 'Birdhouse', 'credit_note-HMTEST01-CN88XYZ.pdf');
    const clickDir = path.join(outDir, 'click', 'Airbnb', '2026-07', 'Birdhouse');
    const clickSaved = fs.existsSync(clickDir) ? fs.readdirSync(clickDir).join(', ') : '(missing dir)';
    assert(fs.existsSync(clickPdf), 'stored stay-click debit PDF at ' + clickPdf + ' (have: ' + clickSaved + ')');
    assert(fs.existsSync(clickCredit), 'stored stay-click credit PDF at ' + clickCredit + ' (have: ' + clickSaved + ')');
    assert(fs.statSync(clickPdf).size > 100, 'PDF has bytes');

    const latestRun = await runPull(
      origin,
      path.join(outDir, 'latest'),
      [
        { code: 'HMOLD001', kind: 'invoice', aptName: 'Birdhouse', createdOnChannel: 1000 },
        { code: 'HMMID001', kind: 'invoice', aptName: 'Birdhouse', createdOnChannel: 2000 },
        { code: 'HMNEW001', kind: 'invoice', aptName: 'Birdhouse', createdOnChannel: 9000 },
      ],
      1
    );
    assert(latestRun.parsed, 'latest-N worker printed JSON\n' + latestRun.stdout + latestRun.stderr);
    assert(latestRun.parsed.ok, 'latest-N saved a PDF: ' + JSON.stringify(latestRun.parsed));
    const newPdf = path.join(outDir, 'latest', 'Airbnb', '2026-07', 'Birdhouse', 'invoice-HMNEW001-INV99ABC.pdf');
    const oldPdf = path.join(outDir, 'latest', 'Airbnb', '2026-07', 'Birdhouse', 'invoice-HMOLD001-INV99ABC.pdf');
    assert(fs.existsSync(newPdf), 'limit 1 kept the newest Hosthub id');
    assert(!fs.existsSync(oldPdf), 'limit 1 did not keep the oldest Hosthub id');
    console.log('platform-invoice-stay-click.test.js: ok');
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
