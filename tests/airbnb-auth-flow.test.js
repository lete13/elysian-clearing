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
  function button(enabled, name) {
    return {
      count: async () => enabled ? 1 : 0,
      click: async () => {
        calls.push(name + '.click');
        if (options.buttonClickFails) throw new Error('covered');
      },
    };
  }
  function buttonList(candidate) {
    return {
      filter: () => ({ first: () => candidate }),
    };
  }
  function ancestor(candidate) {
    return {
      count: async () => candidate ? 1 : 0,
      locator: () => buttonList(candidate || button(false, 'none')),
    };
  }
  const modalButton = button(options.modalContinue, 'modalContinue');
  const dialogButton = button(options.hasContinue, 'dialogContinue');
  const globalButton = button(options.globalContinue, 'globalContinue');
  const alerts = {
    allInnerTexts: async () => options.validationError ? ['The verification code is invalid. Try again.'] : [],
  };
  const single = {
    count: async () => 1,
    isVisible: async () => options.inputVisible !== false,
    waitFor: async config => calls.push(['otp.waitFor', config.state]),
    click: async () => calls.push('otp.click'),
    fill: async text => { value = text; calls.push(['otp.fill', text]); },
    pressSequentially: async text => {
      value += options.dropSequential ? text.slice(0, -1) : text;
      calls.push(['otp.pressSequentially', text]);
    },
    press: async key => calls.push(['otp.press', key]),
    inputValue: async () => options.neverLands ? '' : value,
    evaluate: async callback => callback({ form: options.formExists ? {} : null }),
    locator: selector => {
      if (selector.indexOf('@id="dls-modal-container"') >= 0) return ancestor(options.modalContinue ? modalButton : null);
      if (selector.indexOf('@role="dialog"') >= 0) return ancestor(options.hasContinue ? dialogButton : null);
      if (selector.indexOf('ancestor::form') >= 0) return ancestor(null);
      throw new Error('unexpected OTP-relative selector: ' + selector);
    },
  };
  const never = new Promise(() => {});
  const page = {
    url: () => 'https://www.airbnb.com/login?redirect_url=%2Fhosting',
    locator: selector => {
      if (selector === '#otp-code-input') return { count: async () => 1, first: () => single };
      if (selector.indexOf('[role="alert"]') >= 0) return alerts;
      if (selector.indexOf('button:visible') >= 0) return buttonList(globalButton);
      throw new Error('unexpected page selector: ' + selector);
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

function resendPage(options) {
  options = options || {};
  const calls = [];
  const page = {
    _piEmailOtpResponses: 4,
    _piEmailOtpOk: 2,
    _piEmailOtpLast: 200,
    locator: selector => {
      if (selector === 'body') {
        return { innerText: async () => options.cooldown ? 'Wait 1 minute before requesting a code' : 'Send a new code' };
      }
      assert(selector.includes('send a new code'));
      return {
        first: () => ({
          count: async () => options.missing ? 0 : 1,
          isVisible: async () => !options.hidden,
          click: async () => {
            calls.push('resend.click');
            if (options.clickFails) throw new Error('covered');
            if (!options.noResponse) {
              page._piEmailOtpResponses++;
              page._piEmailOtpLast = options.status == null ? 200 : options.status;
              if (page._piEmailOtpLast === 200) page._piEmailOtpOk++;
            }
          },
        }),
      };
    },
    waitForTimeout: async ms => calls.push(['wait', ms]),
  };
  return { page, calls };
}

async function main() {
  const server = applyChain('srv', 'server.js');
  const frontend = applyChain('fe', 'index.html');
  const captureSource = extractFn(server, 'piAirbnbCaptureOtpDiagnostic');
  const fillSource = extractFn(server, 'piAirbnbFillOtp');
  const fillContext = {};
  vm.runInNewContext(captureSource + '\n' + fillSource + '\nthis.fillOtp = piAirbnbFillOtp;', fillContext);

  const accepted = otpPage();
  assert.strictEqual(await fillContext.fillOtp(accepted.page, '123456'), true);
  assert.strictEqual(accepted.page._piOtpTyped, '123456', 'pressSequentially lands the exact digits');
  assert.strictEqual(accepted.page._piOtpExpected, '123456');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(accepted.page._piOtpDiagnostic.dom)), {
    inputVisible: true, inputCount: 1, formExists: false, submitMethod: 'enter', validation: false,
  }, 'post-submit diagnostic contains only actual DOM facts');
  assert(accepted.calls.some(call => Array.isArray(call) && call[0] === 'waitForFunction' && call[1] === null && call[2] === 15000), 'exact code waits 15 seconds for OTP input transition');
  assert(!accepted.calls.some(call => Array.isArray(call) && call[0] === 'waitForSelector'), 'background password is never an acceptance signal');

  const explicit = otpPage({ hasContinue: true });
  assert.strictEqual(await fillContext.fillOtp(explicit.page, '654321'), true);
  assert(explicit.calls.includes('dialogContinue.click'), 'visible Continue in the OTP dialog is clicked');

  const sibling = otpPage({ modalContinue: true, rejectWait: true });
  assert.strictEqual(await fillContext.fillOtp(sibling.page, '112233'), true);
  assert(sibling.calls.includes('modalContinue.click'), 'sibling Continue in the active login modal is clicked');
  assert.strictEqual(sibling.page._piOtpSubmitMethod, 'button');

  const global = otpPage({ globalContinue: true, rejectWait: true });
  assert.strictEqual(await fillContext.fillOtp(global.page, '223344'), true);
  assert(global.calls.includes('globalContinue.click'), 'global visible enabled Continue is clicked when no modal ancestor is exposed');
  assert.strictEqual(global.page._piOtpSubmitMethod, 'button');

  const enter = otpPage({ rejectWait: true });
  assert.strictEqual(await fillContext.fillOtp(enter.page, '334455'), true);
  assert(enter.calls.some(call => Array.isArray(call) && call[0] === 'otp.press' && call[1] === 'Enter'), 'Enter is pressed from the OTP input when no button is usable');
  assert.strictEqual(enter.page._piOtpSubmitMethod, 'enter');

  const coveredButton = otpPage({ modalContinue: true, buttonClickFails: true, rejectWait: true });
  assert.strictEqual(await fillContext.fillOtp(coveredButton.page, '334466'), true);
  assert(coveredButton.calls.some(call => Array.isArray(call) && call[0] === 'otp.press' && call[1] === 'Enter'), 'Enter fallback runs when a visible button cannot be clicked');
  assert.strictEqual(coveredButton.page._piOtpSubmitMethod, 'enter');

  const rejected = otpPage({ validationError: true, rejectWait: true });
  assert.strictEqual(await fillContext.fillOtp(rejected.page, '445566'), true);
  assert.strictEqual(rejected.page._piOtpValidationError, true, 'visible Airbnb code error is distinguished from unchanged OTP UI');
  assert.strictEqual(rejected.page._piOtpDiagnostic.dom.validation, true, 'actual validation bool reaches diagnostics');

  const missed = otpPage({ dropSequential: true, neverLands: true });
  assert.strictEqual(await fillContext.fillOtp(missed.page, '123456'), false);
  assert.strictEqual(missed.page._piOtpTyped, '', 'failed exact typing remains distinguishable for retry-same-code hint');
  assert.strictEqual(missed.page._piOtpDiagnostic.dom.submitMethod, 'none', 'failed typing reports no submit');
  assert(!missed.calls.some(call => Array.isArray(call) && call[0] === 'waitForFunction'), 'failed typing returns without falsely waiting for rejection');

  assert(fillSource.includes('}, null, { timeout: 15000 })'), 'OTP transition gets a real 15-second Playwright timeout');
  assert(!fillSource.includes("waitForSelector('input[type=\"password\"]'"), 'mounted password race removed');
  assert(fillSource.includes(':visible:not([disabled]):not([aria-disabled="true"])'), 'OTP submit excludes hidden and disabled controls');
  assert(server.includes('Airbnb is still showing the code screen without an invalid-code message'), 'unchanged OTP UI is not called a rejection');
  assert(server.includes('Airbnb says that code is invalid or expired'), 'visible validation error gets an accurate hint');
  assert(server.includes("input[name=\"password\"]:visible, input[type=\"password\"]:visible"), 'post-OTP password must be visible');
  assert(server.includes('const PI_LOGIN_TTL_MS = 30 * 60 * 1000;'), 'Connect job survives CAPTCHA work for 30 minutes');

  const publicSource = extractFn(server, 'piOtpDiagnosticPublic');
  const publicContext = {};
  vm.runInNewContext(publicSource + '\nthis.clean = piOtpDiagnosticPublic;', publicContext);
  const publicDiag = JSON.parse(JSON.stringify(publicContext.clean({
    events: [{
      path: '/api/v2/auth/login?email=private@example.com#secret',
      method: 'POST',
      status: 422,
      timestamp: 1234,
      submitMethod: 'button',
      body: { otp: '123456' },
      headers: { cookie: 'secret' },
    }],
    dom: { inputVisible: true, inputCount: 1, formExists: true, submitMethod: 'button', validation: false },
    email: 'private@example.com',
  })));
  assert.deepStrictEqual(publicDiag.events[0], {
    path: '/api/v2/auth/login', method: 'POST', status: 422, timestamp: 1234, submitMethod: 'button',
  }, 'public diagnostic serializes only path, method, status, timestamp and submit method');
  assert(!JSON.stringify(publicDiag).includes('private@example.com') && !JSON.stringify(publicDiag).includes('123456'),
    'public diagnostic cannot leak email, query, code, body or headers');

  const authPathSource = extractFn(server, 'piAirbnbAuthPath');
  const authRequestSource = extractFn(server, 'piAirbnbRecordOtpAuthRequest');
  const authResponseSource = extractFn(server, 'piAirbnbRecordOtpAuthResponse');
  const authContext = { URL };
  vm.runInNewContext(authPathSource + '\n' + authRequestSource + '\n' + authResponseSource +
    '\nthis.recordRequest = piAirbnbRecordOtpAuthRequest; this.recordResponse = piAirbnbRecordOtpAuthResponse;', authContext);
  const diagPage = { _piOtpCollecting: true, _piOtpSubmitMethod: 'button', _piOtpAuthEvents: [] };
  const authRequest = {
    url: () => 'https://www.airbnb.com/api/v2/auth/login?otp=123456&email=private%40example.com',
    method: () => 'POST',
  };
  authContext.recordRequest(diagPage, authRequest);
  authContext.recordResponse(diagPage, {
    url: authRequest.url,
    request: () => authRequest,
    status: () => 422,
  });
  assert.strictEqual(diagPage._piOtpAuthEvents.length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(diagPage._piOtpAuthEvents[0])), {
    path: '/api/v2/auth/login', method: 'POST', status: 422,
    timestamp: diagPage._piOtpAuthEvents[0].timestamp, submitMethod: 'button',
  }, 'runtime tracker retains only sanitized auth metadata');
  assert.strictEqual(authContext.recordRequest(diagPage, {
    url: () => 'https://www.airbnb.com/sgtm/g/collect?secret=yes', method: () => 'POST',
  }), undefined);
  assert.strictEqual(diagPage._piOtpAuthEvents.length, 1, 'non-auth telemetry is excluded');

  const resendSource = extractFn(server, 'piAirbnbResendCode');
  const resendContext = {};
  vm.runInNewContext(resendSource + '\nthis.resend = piAirbnbResendCode;', resendContext);
  const resendAccepted = resendPage({ status: 200 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await resendContext.resend(resendAccepted.page))),
    { ok: true, cooldown: false, status: 200 }, 'resend requires Airbnb HTTP 200');
  assert(resendAccepted.calls.includes('resend.click'));
  const resendBlocked = resendPage({ status: 420 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await resendContext.resend(resendBlocked.page))),
    { ok: false, cooldown: false, status: 420 }, 'Airbnb block cannot be reported as an emailed code');
  const resendClickFailed = resendPage({ clickFails: true });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await resendContext.resend(resendClickFailed.page))),
    { ok: false, cooldown: false, status: 0 }, 'failed resend click cannot report success');
  assert(!resendSource.includes("sendNew.click({ force: true"), 'resend no longer force-clicks and ignores failure');

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
  assert(route.includes("verifyHint !== undefined && typeof verifyHint !== 'boolean'"), 'server validates optional Verify hint');
  assert(route.includes("verifyHint === true || await piAirbnbCaptchaClickIsVerify"), 'explicit frontend Verify hint wins over bad frame coordinates');
  assert(route.includes("job.status = 'awaiting_captcha'"), 'tile path remains awaiting CAPTCHA');
  assert(route.includes('captchaVerify: captchaVerify'), 'response identifies tile versus Verify');
  assert(frontend.includes("j.captchaVerify === false"), 'frontend recognizes a fast tile response');
  assert(frontend.includes("if (!(captchaImg && r.job.status === 'awaiting_captcha'))"), 'polling preserves active CAPTCHA image');
  assert(frontend.includes('OTP diagnostic: input visible='), 'Connect panel renders the OTP diagnostic line');
  assert(frontend.includes('captchaVerify: captchaVerify'), 'frontend sends Verify-region classification');

  console.log('airbnb auth flow OK: sanitized OTP diagnostics, 30-minute jobs, active submit controls, confirmed resend, robust CAPTCHA Verify');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
