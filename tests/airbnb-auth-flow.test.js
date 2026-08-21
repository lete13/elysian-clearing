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
  assert(frontend.includes("document.getElementById('pi-airbnb-browser')"), 'polling soft-updates the live Airbnb browser');
  assert(frontend.includes('OTP diagnostic: input visible='), 'Connect panel still has the OTP diagnostic helper');
  assert(frontend.includes('captchaVerify: captchaVerify'), 'frontend sends Verify-region classification');
  assert(frontend.includes('Operate Airbnb directly'), 'Connect asks the user to operate the server-owned browser');
  assert(frontend.includes('id="pi-airbnb-browser-text"'), 'Connect has a type box for the live Airbnb fields');
  assert(frontend.includes("st === 'awaiting_otp' || st === 'awaiting_captcha' || st === 'interactive'"), 'OTP, CAPTCHA and leftover login share one browser panel');
  assert(frontend.includes("if (!(captchaImg && r.job.status === 'awaiting_captcha'))"), 'legacy CAPTCHA poll skip remains in source');

  const loginPublicSource = extractFn(server, 'piLoginPublic');
  const loginPublicCtx = { piOtpDiagnosticPublic: () => null };
  vm.runInNewContext(loginPublicSource + '\nthis.pub = piLoginPublic;', loginPublicCtx);
  const closedPageJob = {
    id: 'al1', channel: 'airbnb', status: 'interactive', createdAt: 1, updatedAt: 2,
    interactiveRev: 4,
    page: { url: () => { throw new Error('Target page, context or browser has been closed'); } },
  };
  const publicJob = JSON.parse(JSON.stringify(loginPublicCtx.pub(closedPageJob)));
  assert.deepStrictEqual(publicJob.interactive, {
    width: 1440, height: 900, rev: 4, url: '',
  }, 'closed Playwright pages cannot break Connect status JSON');
  assert.strictEqual(publicJob.sessionSaved, false, 'unsaved jobs report sessionSaved false');
  const liveJob = loginPublicCtx.pub({
    id: 'al2', channel: 'airbnb', status: 'awaiting_otp', createdAt: 1, updatedAt: 2,
    interactiveRev: 1,
    _piSessionSaved: true,
    page: { url: () => 'https://www.airbnb.com/login?redirect_url=%2Fhosting&code=secret' },
  });
  assert.strictEqual(liveJob.interactive.url, 'https://www.airbnb.com/login', 'interactive URL drops query secrets');
  assert.strictEqual(liveJob.sessionSaved, true, 'saved cookies are visible to the Connect panel');

  const snapshotSource = extractFn(server, 'piAirbnbInteractiveSnapshot');
  const advanceSource = extractFn(server, 'piAirbnbInteractiveAdvance');
  const advanceCtx = {
    Date,
    saved: [],
    liveSaved: [],
    piAirbnbPageLooksLoggedIn: async page => !!page.loggedIn,
    piAirbnbPageLooksReadyToSave: async page => !!page.readyToSave,
    piAirbnbHasHumanCheck: async page => !!page.human,
    piAirbnbNeedsOtp: async page => !!page.otp,
    async piAirbnbSaveLiveSession(job) {
      if (job.page && job.page.saveSession === false) return false;
      job._piSessionSaved = true;
      advanceCtx.liveSaved.push(job.id);
      return true;
    },
    async piAirbnbFinishAndSave(job) {
      if (job.page && job.page.failSave) throw new Error('Hosting was not confirmed');
      advanceCtx.saved.push(job.id);
      job.status = 'connected';
    },
  };
  vm.runInNewContext(
    snapshotSource + '\n' + advanceSource + '\nthis.advance = piAirbnbInteractiveAdvance;',
    advanceCtx
  );
  function browserPage(flags) {
    flags = flags || {};
    return {
      loggedIn: !!flags.loggedIn,
      readyToSave: !!flags.readyToSave,
      human: !!flags.human,
      otp: !!flags.otp,
      failSave: !!flags.failSave,
      saveSession: flags.saveSession,
      isClosed: () => false,
      locator: selector => ({
        count: async () => (selector.indexOf('#otp-code-input') >= 0 && flags.otpInput) ? 1 : 0,
      }),
    };
  }
  const hostingJob = { id: 'h1', page: browserPage({ loggedIn: true }), status: 'interactive' };
  await advanceCtx.advance(hostingJob);
  assert.strictEqual(hostingJob.status, 'connected');
  assert.deepStrictEqual(advanceCtx.saved, ['h1'], 'Hosting in the live browser saves the server-owned session');
  assert.deepStrictEqual(advanceCtx.liveSaved, ['h1'], 'cookies are dumped before Hosting navigation');

  const idleAfterOtp = { id: 'h2', page: browserPage({ readyToSave: true, failSave: true }), status: 'awaiting_otp' };
  await advanceCtx.advance(idleAfterOtp);
  assert.strictEqual(idleAfterOtp.status, 'connected', 'idle logged-in browser is connected even if Hosting URL is missing');
  assert.strictEqual(idleAfterOtp._piSessionSaved, true);
  assert(idleAfterOtp.hint.includes('You can Pull now'), 'saved cookies tell the user to Pull');

  const failedHost = { id: 'h3', page: browserPage({ loggedIn: true, failSave: true, saveSession: false }), status: 'awaiting_otp' };
  await advanceCtx.advance(failedHost);
  assert.strictEqual(failedHost.status, 'interactive');
  assert.strictEqual(failedHost._piFinishing, false);
  assert.strictEqual(failedHost._piOtpAccepted, false);
  assert(failedHost.hint.includes('Keep operating Airbnb'), 'failed Hosting save leaves the browser open');

  const captchaJob = { id: 'c1', page: browserPage({ human: true, otp: true }), status: 'interactive' };
  await advanceCtx.advance(captchaJob);
  assert.strictEqual(captchaJob.status, 'awaiting_captcha', 'visible human check wins over OTP copy');

  const otpJob = { id: 'o1', page: browserPage({ otpInput: true }), status: 'interactive' };
  await advanceCtx.advance(otpJob);
  assert.strictEqual(otpJob.status, 'awaiting_otp');

  const leftoverJob = { id: 'l1', page: browserPage(), status: 'starting' };
  await advanceCtx.advance(leftoverJob);
  assert.strictEqual(leftoverJob.status, 'interactive', 'unknown Airbnb pages stay user-operated');

  assert(server.includes("app.get('/api/platform-invoices/sessions/airbnb/login/:jobId/browser.png'"), 'live screenshot route exists');
  assert(server.includes("app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/browser/click'"), 'click relay exists');
  assert(server.includes("app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/browser/type'"), 'type relay exists');
  assert(server.includes("app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/browser/key'"), 'key relay exists');
  assert(server.includes("job.status === 'logging_in' || job.status === 'interactive'"), 'Connect resumes an active interactive browser');
  assert(server.includes('await piAirbnbInteractiveAdvance(job);'), 'status polls detect Hosting without another click');
  assert(!server.includes('job.hint = text'), 'typed secrets never become job hints');
  const interactiveReturn = server.indexOf("Operate Airbnb directly below. Complete password/code prompts until Hosting opens.");
  const leftoverFail = server.indexOf('Airbnb is still on login (no email code screen)');
  assert(interactiveReturn >= 0 && leftoverFail > interactiveReturn, 'leftover login becomes user-operated before the old hard-fail');

  const typeRouteStart = server.indexOf("app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/browser/type'");
  const typeRouteEnd = server.indexOf("app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/browser/key'", typeRouteStart);
  const typeRoute = server.slice(typeRouteStart, typeRouteEnd);
  assert(typeRoute.includes('keyboard.type(text, { delay: 45 })'), 'typed characters go to Playwright only');
  assert(!/console\.log/.test(typeRoute), 'type route does not log keystrokes');

  const looksSrc = extractFn(server, 'piAirbnbPageLooksLoggedIn');
  const readySrc = extractFn(server, 'piAirbnbPageLooksReadyToSave');
  const needsSrc = extractFn(server, 'piAirbnbNeedsOtp');
  const harvestSrc = extractFn(server, 'piAirbnbHarvestLiveJobs');
  const lookCtx = {
    piAirbnbHasHumanCheck: async page => !!page.human,
  };
  vm.runInNewContext(
    looksSrc + '\n' + readySrc + '\n' + needsSrc +
    '\nthis.looks = piAirbnbPageLooksLoggedIn; this.ready = piAirbnbPageLooksReadyToSave; this.needs = piAirbnbNeedsOtp;',
    lookCtx
  );
  function airPage(opts) {
    opts = opts || {};
    return {
      human: !!opts.human,
      url: () => opts.url || 'https://www.airbnb.com/',
      locator: selector => {
        if (selector === 'body') {
          return { innerText: async () => opts.text || 'Welcome back' };
        }
        if (selector.indexOf('header-avatar') >= 0 || selector.indexOf('headernav-profile') >= 0) {
          return { count: async () => opts.avatar ? 1 : 0 };
        }
        if (selector.indexOf('password') >= 0 || selector.indexOf('otp-code-input') >= 0 || selector.indexOf('phone-or-email') >= 0) {
          if (selector.indexOf(':visible') >= 0) return { count: async () => opts.visibleLogin ? 1 : 0 };
          return { count: async () => opts.hiddenLogin ? 1 : 0 };
        }
        return { count: async () => 0 };
      },
    };
  }
  assert.strictEqual(await lookCtx.looks(airPage({
    url: 'https://www.airbnb.com/hosting', hiddenLogin: true,
  })), true, 'Hosting with leftover hidden password/OTP is logged in');
  assert.strictEqual(await lookCtx.looks(airPage({
    url: 'https://www.airbnb.com/login', hiddenLogin: true, text: 'Hosting',
  })), false, 'login URL is never logged in even when the footer says Hosting');
  assert.strictEqual(await lookCtx.looks(airPage({
    url: 'https://www.airbnb.com/', avatar: true,
  })), true, 'logged-in homepage avatar counts');
  assert.strictEqual(await lookCtx.looks(airPage({
    url: 'https://www.airbnb.com/', text: 'Hosting reservations calendar',
  })), false, 'body-text Hosting still does not count');
  assert.strictEqual(await lookCtx.ready(airPage({
    url: 'https://www.airbnb.com/login?redirect_url=%2Fhosting', hiddenLogin: true,
  })), true, 'post-2FA login URL with no visible fields is ready to save');
  assert.strictEqual(await lookCtx.ready(airPage({
    url: 'https://www.airbnb.com/login', visibleLogin: true,
  })), false, 'visible password/OTP/email is not ready to save');
  assert.strictEqual(await lookCtx.ready(airPage({
    url: 'https://www.airbnb.com/', human: true,
  })), false, 'picture check is not ready to save');
  assert.strictEqual(await lookCtx.needs(airPage({
    url: 'https://www.airbnb.com/login', visibleLogin: true, text: 'Enter the code we sent',
  })), true, 'visible OTP field still needs a code');
  assert.strictEqual(await lookCtx.needs(airPage({
    url: 'https://www.airbnb.com/', hiddenLogin: true, text: 'Enter the code we sent. Hosting',
  })), false, 'hidden leftover OTP copy does not block save');

  const harvestCtx = {
    _piLoginJobs: new Map(),
    savedSessions: [],
    async piAirbnbRunBrowserAction(job, fn) { return fn(); },
    async piAirbnbHasHumanCheck(page) { return !!page.human; },
    async piAirbnbPageLooksLoggedIn(page) { return !!page.loggedIn; },
    async piAirbnbPageLooksReadyToSave(page) { return !!page.readyToSave; },
    async piAirbnbSaveLiveSession(job) {
      harvestCtx.savedSessions.push(job.id);
      job._piSessionSaved = true;
      return true;
    },
    async piAirbnbFinishAndSave(job) {
      if (job.page && job.page.failSave) throw new Error('Hosting was not confirmed');
      job.status = 'connected';
    },
  };
  vm.runInNewContext(harvestSrc + '\nthis.harvest = piAirbnbHarvestLiveJobs;', harvestCtx);
  const liveIdle = {
    id: 'live1', status: 'awaiting_otp',
    page: { readyToSave: true, failSave: true },
    context: {},
  };
  const captchaLive = {
    id: 'cap1', status: 'awaiting_captcha',
    page: { human: true, readyToSave: true },
    context: {},
  };
  const bookingLive = {
    id: 'bdc1', status: 'interactive', channel: 'booking',
    page: { readyToSave: true, loggedIn: true },
    context: {},
  };
  harvestCtx._piLoginJobs.set(liveIdle.id, liveIdle);
  harvestCtx._piLoginJobs.set(captchaLive.id, captchaLive);
  harvestCtx._piLoginJobs.set(bookingLive.id, bookingLive);
  assert.strictEqual(await harvestCtx.harvest(), true);
  assert.deepStrictEqual(harvestCtx.savedSessions, ['live1'], 'Pull harvests the idle logged-in browser and skips CAPTCHA and Booking.com');
  assert.strictEqual(liveIdle.status, 'connected');
  assert.strictEqual(captchaLive.status, 'awaiting_captcha');
  assert.strictEqual(bookingLive.status, 'interactive', 'Airbnb harvest leaves Booking.com Connect alone');

  assert(server.includes('try { await piAirbnbHarvestLiveJobs(); } catch (eHarvest) {}'), 'Pull harvests live Connect cookies first');
  assert(server.includes("app.post('/api/platform-invoices/sessions/airbnb/login/:jobId/browser/save'"), 'manual save route exists');
  assert(frontend.includes('Save session for Pull'), 'Connect has Save session for Pull');
  assert(frontend.includes('piAirbnbBrowserSave'), 'Save session is wired');
  assert(frontend.includes('reuses this live browser'), 'copy says Pull reuses the live browser');

  const parseSrc = extractFn(server, 'piPullParseWorkerStdout');
  const parseCtx = {};
  vm.runInNewContext(parseSrc + '\nthis.parse = piPullParseWorkerStdout;', parseCtx);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(parseCtx.parse(
    '{"event":"progress","done":1,"total":322}\n{"ok":true,"files":[{"filename":"a.pdf"}],"errors":[]}\n'
  ))), { ok: true, files: [{ filename: 'a.pdf' }], errors: [] }, 'final worker JSON wins over progress lines');
  assert.strictEqual(parseCtx.parse('{"event":"progress","done":2}\nnot json\n'), null, 'progress-only stdout is not a result');
  assert(server.includes("app.get('/api/platform-invoices/pull/:jobId'"), 'Pull status poll route exists');
  assert(server.includes('async function piExecutePullJob'), 'Pull harvest+worker run after the HTTP response');
  assert(server.includes('90 * 60 * 1000'), 'background worker is allowed enough time for a full Hosthub month');
  const pullPost = server.slice(
    server.indexOf("app.post('/api/platform-invoices/pull'"),
    server.indexOf("app.get('/api/platform-invoices/pull/:jobId'")
  );
  assert(pullPost.includes('setImmediate'), 'POST returns a job id without waiting for Playwright');
  assert(!pullPost.includes("child.on('close'"), 'the HTTP handler does not wait on the worker');
  assert(frontend.includes('piWatchPullJob'), 'Collect polls background Pull');
  assert(frontend.includes('upstream error'), 'proxy cutoff is explained instead of a JSON parse crash');
  assert(frontend.includes("channel: 'airbnb'"), 'Pull still posts Airbnb Hosthub codes');

  const bookingLooksSrc = extractFn(server, 'piBookingPageLooksLoggedIn');
  const bookingLookCtx = { URL: URL };
  vm.runInNewContext(bookingLooksSrc + '\nthis.looks = piBookingPageLooksLoggedIn;', bookingLookCtx);
  function bdcPage(opts) {
    opts = opts || {};
    return {
      url: () => opts.url || 'https://admin.booking.com/',
      locator: selector => {
        if (selector.indexOf('password') >= 0 || selector.indexOf('loginname') >= 0) {
          return { count: async () => opts.visibleLogin ? 1 : 0 };
        }
        return { count: async () => 0 };
      },
    };
  }
  assert.strictEqual(await bookingLookCtx.looks(bdcPage({
    url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/home.html',
  })), true, 'Extranet home is logged in');
  assert.strictEqual(await bookingLookCtx.looks(bdcPage({
    url: 'https://admin.booking.com/groups/invoices',
  })), true, 'group invoices path is logged in');
  assert.strictEqual(await bookingLookCtx.looks(bdcPage({
    url: 'https://account.booking.com/sign-in?op_token=secret',
    visibleLogin: true,
  })), false, 'account.booking.com sign-in is never logged in');
  assert.strictEqual(await bookingLookCtx.looks(bdcPage({
    url: 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/home.html',
    visibleLogin: true,
  })), false, 'visible login fields are not logged in');
  assert(server.includes("app.post('/api/platform-invoices/sessions/booking/login'"), 'Booking.com in-app login route exists');
  assert(server.includes('try { await piBookingHarvestLiveJobs(); } catch (eBdcHarvest) {}'), 'Pull harvests live Booking.com Connect cookies');
  assert(server.includes('inAppConnectBooking: !!playwrightOk'), 'status advertises Booking in-app Connect without requiring env passwords');
  assert(frontend.includes('piConnectBookingInApp()'), 'Connect Booking is in-app');
  assert(frontend.includes('id="pi-booking-connect"'), 'Collect has Booking.com connect panel');
  assert(frontend.includes('piBookingBrowserSave'), 'Booking Save session is wired');
  assert(frontend.includes('Operate Booking.com Extranet'), 'Booking interactive title');
  assert(!frontend.includes("onclick=\"piConnectSession('booking')\""), 'Connect Booking no longer opens the JSON prompt');
  assert(frontend.includes("if (channel === 'booking' || channel === 'bdc') return piConnectBookingInApp();"), 'leftover Connect Booking still goes in-app');

  const blockedSrc = extractFn(server, 'piBookingLooksBlockedText');
  const blockedCtx = {};
  vm.runInNewContext(blockedSrc + '\nthis.blocked = piBookingLooksBlockedText;', blockedCtx);
  assert.strictEqual(blockedCtx.blocked('Sign-in failed. Please try again later.'), true, 'Booking.com try-again-later is a block');
  assert.strictEqual(blockedCtx.blocked('Sign in to manage your property'), false, 'normal Extranet login copy is not a block');
  assert.strictEqual(blockedCtx.blocked('Username Also known as Login name'), false, 'username field copy is not a block');
  assert.strictEqual(blockedCtx.blocked("Let's make sure you're human"), false, 'human check is not the Try-again-later block');
  const humanSrc = extractFn(server, 'piBookingLooksHumanCheckText');
  const humanCtx = {};
  vm.runInNewContext(humanSrc + '\nthis.human = piBookingLooksHumanCheckText;', humanCtx);
  assert.strictEqual(humanCtx.human("Let's make sure you're human"), true, 'human-check copy is detected');
  const bookingCtxSrc = extractFn(server, 'piBookingNewContext');
  assert(!/Chrome\/122/.test(bookingCtxSrc), 'Booking Connect does not spoof Chrome 122');
  assert(!/userAgent:/.test(bookingCtxSrc), 'Booking Connect uses the real browser user-agent');
  const launchSrc = extractFn(server, 'piBookingLaunchBrowser');
  assert(launchSrc.includes('headless: false'), 'Booking Connect launches headed Chrome');
  assert(!launchSrc.includes('headless: true'), 'Booking Connect does not fall back to headless');
  assert(!launchSrc.includes('falling back to headless'), 'no silent HeadlessChrome fallback');
  assert(server.includes('Server started HeadlessChrome'), 'HeadlessChrome is refused before login');
  assert(server.includes('browserKind: job.browserKind'), 'job exposes browser kind');
  assert(server.includes('piBookingEnsureDisplay'), 'Booking Connect starts Xvfb when DISPLAY is missing');
  assert(server.includes("existsSync('/tmp/.X11-unix/X'"), 'Xvfb starts even when DISPLAY=:99 is pre-set');
  assert(server.includes('piBookingHumanType'), 'Booking Type focuses the username field');
  assert(server.includes('not(#hidden-password)'), 'Booking Type ignores the hidden password decoy');
  assert(server.includes("ignoreDefaultArgs: ['--enable-automation']"), 'Booking Chrome launch drops --enable-automation');
  assert(server.includes("if (process.env.BOOKING_CONNECT_AUTOFILL === '1') await piBookingTryFillLogin(page);"), 'Connect does not auto-submit Booking.com login');
  assert(frontend.includes('Booking.com blocked this attempt'), 'Collect shows a banner when Booking.com blocks sign-in');
  assert(/wait for the password field/i.test(frontend), 'Collect says wait after username');
  assert(frontend.includes('it is filled for you') || frontend.includes('it goes into the username field'), 'Collect says Type fills username');
  assert(frontend.includes('Server browser:'), 'Collect shows which Chrome launched');
  assert(frontend.includes('Do not retry now'), 'Collect tells the host not to retry a Booking.com network block');
  assert(frontend.includes('blocked this server network'), 'Collect names the server-network block');
  assert(!frontend.includes('wait a minute, Cancel, and Connect Booking again'), 'Collect does not tell the host to retry in a minute');
  assert(server.includes('piBookingMarkNetworkBlocked'), 'Booking Connect records a server-IP block');
  assert(server.includes('BOOKING_CONNECT_COOLDOWN_MS'), 'Booking Connect cooldown is configurable');
  const hintSrc = extractFn(server, 'piBookingBlockedHint');
  const hintCtx = {};
  vm.runInNewContext(hintSrc + '\nthis.hint = piBookingBlockedHint;', hintCtx);
  assert(hintCtx.hint().includes('Do not retry now'), 'blocked hint says do not retry');
  assert(!hintCtx.hint().includes('Wait one minute'), 'blocked hint does not say wait one minute');
  const cdSrc = extractFn(server, 'piBookingCooldownMs');
  const cdCtx = { process: { env: {} } };
  vm.runInNewContext(cdSrc + '\nthis.ms = piBookingCooldownMs;', cdCtx);
  assert.strictEqual(cdCtx.ms(), 4 * 60 * 60 * 1000, 'default Booking Connect cooldown is 4 hours');
  const cdZero = { process: { env: { BOOKING_CONNECT_COOLDOWN_MS: '0' } } };
  vm.runInNewContext(cdSrc + '\nthis.ms = piBookingCooldownMs;', cdZero);
  assert.strictEqual(cdZero.ms(), 0, 'BOOKING_CONNECT_COOLDOWN_MS=0 disables cooldown');
  const blockedPub = loginPublicCtx.pub({
    id: 'bk1', channel: 'booking', status: 'blocked', networkBlocked: true, cooldownUntil: 99,
    createdAt: 1, updatedAt: 2,
  });
  assert.strictEqual(blockedPub.networkBlocked, true, 'public job exposes networkBlocked');
  assert.strictEqual(blockedPub.cooldownUntil, 99, 'public job exposes cooldownUntil');
  assert(server.includes("require('./scripts/platform-invoice-booking-block')"), 'Connect persists the block via the shared module');
  assert(server.includes('await piBookingReadBlockedUntil'), 'Connect cooldown is awaited from Postgres');
  assert(server.includes('await piBookingMarkNetworkBlocked'), 'Connect block persist is awaited');
  assert(server.includes('attachPageWatch'), 'Connect watches Booking.com HTTP 403/429');
  assert(server.includes('Pull will not password-login from this IP'), 'Pull spawn skips password-login while blocked');
  assert(!server.includes('PI_BOOKING_BLOCK_FILE'), 'Connect no longer stores cooldown only in /tmp');

  console.log('airbnb auth flow OK: interactive in-app browser, background Pull harvest, sanitized OTP diagnostics, Booking.com in-app Connect');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
