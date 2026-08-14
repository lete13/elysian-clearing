'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function applyChain(kind, baseFile) {
  let source = fs.readFileSync(path.join(root, baseFile), 'utf8').replace(/\r\n/g, '\n');
  let sha = crypto.createHash('sha256').update(source).digest('hex');
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'patches.json' : `patches-${n}.json`;
    const file = path.join(root, kind, name);
    if (!fs.existsSync(file)) break;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(spec.baseSha256, sha, `${kind}/${name} continues the chain`);
    for (const [index, patch] of spec.patches.entries()) {
      const count = source.split(patch.find).length - 1;
      assert.strictEqual(count, patch.count || 1, `${kind}/${name} patch ${index + 1} anchor count`);
      source = source.split(patch.find).join(patch.replace);
    }
    sha = crypto.createHash('sha256').update(source).digest('hex');
    assert.strictEqual(spec.expectedSha256, sha, `${kind}/${name} effective hash`);
  }
  return source;
}

function extractFn(source, name) {
  const asyncStart = source.indexOf('async function ' + name + '(');
  const start = asyncStart >= 0 ? asyncStart : source.indexOf('function ' + name + '(');
  assert(start >= 0, 'missing function ' + name);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unclosed function ' + name);
}

function otpPage(options) {
  options = options || {};
  let value = '';
  const calls = [];
  const continueButton = {
    count: async () => options.hasContinue ? 1 : 0,
    click: async () => calls.push('continue.click'),
  };
  const single = {
    count: async () => 1,
    waitFor: async config => calls.push(['otp.waitFor', config.state]),
    click: async () => calls.push('otp.click'),
    fill: async text => { value = text; calls.push(['otp.fill', text]); },
    pressSequentially: async text => {
      value += options.dropSequential ? text.slice(0, -1) : text;
      calls.push(['otp.pressSequentially', text]);
    },
    inputValue: async () => options.neverLands ? '' : value,
    locator: () => ({
      locator: () => ({
        filter: () => ({ first: () => continueButton }),
      }),
    }),
  };
  const never = new Promise(() => {});
  const page = {
    url: () => 'https://www.airbnb.com/login?redirect_url=%2Fhosting',
    locator: selector => {
      assert.strictEqual(selector, '#otp-code-input');
      return { first: () => single };
    },
    keyboard: {
      press: async key => calls.push(['keyboard.press', key]),
      type: async text => { value = options.neverLands ? '' : text; calls.push(['keyboard.type', text]); },
    },
    waitForFunction: async (predicate, arg, config) => {
      calls.push(['waitForFunction', arg, config && config.timeout]);
      if (options.rejectWait) throw new Error('timeout');
      return true;
    },
    waitForURL: (predicate, config) => {
      calls.push(['waitForURL', config && config.timeout]);
      assert.strictEqual(predicate(new URL(page.url())), false, 'redirect query is not a route transition');
      assert.strictEqual(predicate(new URL('https://www.airbnb.com/hosting')), true, 'Hosting pathname is accepted');
      return options.rejectWait ? Promise.reject(new Error('timeout')) : never;
    },
  };
  return { page, calls, getValue: () => value };
}

async function main() {
  const server = applyChain('srv', 'server.js');
  const frontend = applyChain('fe', 'index.html');
  const fillSource = extractFn(server, 'piAirbnbFillOtp');
  const fillContext = {};
  vm.runInNewContext(fillSource + '\nthis.fillOtp = piAirbnbFillOtp;', fillContext);

  const accepted = otpPage();
  assert.strictEqual(await fillContext.fillOtp(accepted.page, '123456'), true);
  assert.strictEqual(accepted.page._piOtpTyped, '123456', 'pressSequentially lands the exact digits');
  assert.strictEqual(accepted.page._piOtpExpected, '123456');
  assert(accepted.calls.some(call => Array.isArray(call) && call[0] === 'waitForFunction' && call[1] === null && call[2] === 15000), 'exact code waits 15 seconds for OTP input transition');
  assert(!accepted.calls.some(call => Array.isArray(call) && call[0] === 'waitForSelector'), 'background password is never an acceptance signal');

  const explicit = otpPage({ hasContinue: true });
  assert.strictEqual(await fillContext.fillOtp(explicit.page, '654321'), true);
  assert(explicit.calls.includes('continue.click'), 'visible Continue in the OTP form is clicked');

  const missed = otpPage({ dropSequential: true, neverLands: true });
  assert.strictEqual(await fillContext.fillOtp(missed.page, '123456'), false);
  assert.strictEqual(missed.page._piOtpTyped, '', 'failed exact typing remains distinguishable for retry-same-code hint');
  assert(!missed.calls.some(call => Array.isArray(call) && call[0] === 'waitForFunction'), 'failed typing returns without falsely waiting for rejection');

  assert(fillSource.includes('}, null, { timeout: 15000 })'), 'OTP transition gets a real 15-second Playwright timeout');
  assert(!fillSource.includes("waitForSelector('input[type=\"password\"]'"), 'mounted password race removed');
  assert(server.includes("input[name=\"password\"]:visible, input[type=\"password\"]:visible"), 'post-OTP password must be visible');

  const verifySource = extractFn(server, 'piAirbnbCaptchaClickIsVerify');
  const verifyContext = {};
  vm.runInNewContext(verifySource + '\nthis.isVerify = piAirbnbCaptchaClickIsVerify;', verifyContext);
  const frame = {
    url: () => 'https://www.google.com/recaptcha/api2/bframe?k=test',
    locator: selector => {
      assert.strictEqual(selector, '#recaptcha-verify-button');
      return {
        first: () => ({
          count: async () => 1,
          isVisible: async () => true,
          boundingBox: async () => ({ x: 100, y: 700, width: 120, height: 45 }),
        }),
      };
    },
  };
  const captchaPage = { frames: () => [frame] };
  assert.strictEqual(await verifyContext.isVerify(captchaPage, 150, 720), true, 'click inside visible Verify bounds is detected');
  assert.strictEqual(await verifyContext.isVerify(captchaPage, 50, 500), false, 'tile click outside Verify bounds stays on fast path');

  const routeStart = server.indexOf("app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/captcha/click'");
  const routeEnd = server.indexOf("app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/otp'", routeStart);
  const route = server.slice(routeStart, routeEnd);
  assert(route.includes('await previousClick.catch(function () {});'), 'CAPTCHA clicks remain serialized');
  assert(route.includes('await job.page.waitForTimeout(400);'), 'tile path waits only 400ms');
  assert(route.includes('if (captchaVerify)'), 'Verify alone takes continuation path');
  assert(route.includes("job.status = 'awaiting_captcha'"), 'tile path remains awaiting CAPTCHA');
  assert(route.includes('captchaVerify: captchaVerify'), 'response identifies tile versus Verify');
  assert(frontend.includes("j.captchaVerify === false"), 'frontend recognizes a fast tile response');
  assert(frontend.includes("if (!(captchaImg && r.job.status === 'awaiting_captcha'))"), 'polling preserves active CAPTCHA image');

  console.log('airbnb auth flow OK: exact OTP typing, bounded acceptance wait, visible Continue/password, fast serialized CAPTCHA tiles');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
