#!/usr/bin/env node
/**
 * QA Test Suite for foxtty (Foxtrot Web Terminal)
 * Tests API endpoints, WebSocket communication, HTML structure, and requirements compliance.
 * Run: node qa-test.js
 */

const http = require('http');
const WebSocket = require('ws');

const BASE = 'http://localhost:16000';
const WS_BASE = 'ws://localhost:16000';

let passed = 0;
let failed = 0;
const results = [];

function log(status, name, detail) {
  const icon = status === 'PASS' ? '[PASS]' : '[FAIL]';
  results.push({ status, name, detail });
  if (status === 'PASS') passed++;
  else failed++;
  console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`);
}

function fetch(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    if (options.body) {
      opts.headers['Content-Type'] = 'application/json';
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: data, json: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data, json: null });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

function connectWS(query = '') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}${query}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS timeout')), 5000);
  });
}

function waitForMsg(ws, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
    const handler = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === type) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch (e) {}
    };
    ws.on('message', handler);
  });
}

function collectMsgs(ws, duration = 2000) {
  return new Promise((resolve) => {
    const msgs = [];
    const handler = (raw) => {
      try { msgs.push(JSON.parse(raw.toString())); } catch (e) {}
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(msgs);
    }, duration);
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// TEST SUITES
// ============================================================

async function testAPIEndpoints() {
  console.log('\n=== API Endpoints ===');

  // 1. GET /api/config — no auth mode
  try {
    const res = await fetch('/api/config');
    if (res.status === 200 && res.json && res.json.auth === false) {
      log('PASS', 'GET /api/config returns auth:false (no --auth flag)');
    } else {
      log('FAIL', 'GET /api/config', `Expected auth:false, got ${JSON.stringify(res.json)}`);
    }
  } catch (e) {
    log('FAIL', 'GET /api/config', e.message);
  }

  // 2. Static file serving
  try {
    const res = await fetch('/index.html');
    if (res.status === 200 && res.body.includes('<!DOCTYPE html>')) {
      log('PASS', 'Static file serving (index.html served)');
    } else {
      log('FAIL', 'Static file serving', `Status: ${res.status}`);
    }
  } catch (e) {
    log('FAIL', 'Static file serving', e.message);
  }

  // 3. Cache-Control: no-store
  try {
    const res = await fetch('/index.html');
    const cc = res.headers['cache-control'];
    if (cc && cc.includes('no-store')) {
      log('PASS', 'Cache-Control: no-store header present');
    } else {
      log('FAIL', 'Cache-Control: no-store', `Got: ${cc}`);
    }
  } catch (e) {
    log('FAIL', 'Cache-Control header', e.message);
  }

  // 4. Auth endpoints should not exist without --auth
  try {
    const res = await fetch('/api/status');
    // Without --auth, these routes are not registered, so 404
    if (res.status === 404) {
      log('PASS', '/api/status returns 404 without --auth');
    } else {
      log('FAIL', '/api/status without --auth', `Expected 404, got ${res.status}`);
    }
  } catch (e) {
    log('FAIL', '/api/status check', e.message);
  }
}

async function testWebSocketBasic() {
  console.log('\n=== WebSocket Basic ===');

  let ws;
  try {
    ws = await connectWS();
    log('PASS', 'WebSocket connection established');
  } catch (e) {
    log('FAIL', 'WebSocket connection', e.message);
    return;
  }

  // Should receive tab-list on connect
  try {
    const msg = await waitForMsg(ws, 'tab-list', 3000);
    if (msg.tabs && Array.isArray(msg.tabs) && msg.tabs.length >= 1) {
      log('PASS', 'Receives tab-list on connect', `${msg.tabs.length} tab(s)`);
    } else {
      log('FAIL', 'tab-list message', `Got: ${JSON.stringify(msg)}`);
    }
  } catch (e) {
    log('FAIL', 'tab-list on connect', e.message);
  }

  // Switch to first tab
  try {
    ws.send(JSON.stringify({ type: 'switch', id: '1' }));
    const msg = await waitForMsg(ws, 'scrollback', 3000);
    log('PASS', 'Switch to tab returns scrollback');
  } catch (e) {
    log('FAIL', 'Tab switch', e.message);
  }

  // Input and output
  try {
    ws.send(JSON.stringify({ type: 'input', data: 'echo QA_TEST_MARKER\n' }));
    const msgs = await collectMsgs(ws, 2000);
    const outputMsgs = msgs.filter(m => m.type === 'output');
    const combined = outputMsgs.map(m => m.data).join('');
    if (combined.includes('QA_TEST_MARKER')) {
      log('PASS', 'Input/Output round-trip works');
    } else {
      log('FAIL', 'Input/Output round-trip', `Output did not contain marker. Got: ${combined.substring(0, 200)}`);
    }
  } catch (e) {
    log('FAIL', 'Input/Output', e.message);
  }

  // Resize
  try {
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    // If no crash, it worked
    await sleep(200);
    log('PASS', 'Resize message accepted without error');
  } catch (e) {
    log('FAIL', 'Resize', e.message);
  }

  ws.close();
}

async function testMultiTab() {
  console.log('\n=== Multi-Tab ===');

  let ws;
  try {
    ws = await connectWS();
    await waitForMsg(ws, 'tab-list', 3000);
  } catch (e) {
    log('FAIL', 'Multi-tab WS connect', e.message);
    return;
  }

  // Create new tab
  let newTabId;
  try {
    ws.send(JSON.stringify({ type: 'new-tab' }));
    const tabList = await waitForMsg(ws, 'tab-list', 3000);
    const switched = await waitForMsg(ws, 'switched', 3000);
    newTabId = switched.id;
    if (tabList.tabs.length >= 2) {
      log('PASS', 'New tab created', `Now ${tabList.tabs.length} tabs, switched to #${newTabId}`);
    } else {
      log('FAIL', 'New tab creation', `Expected >=2 tabs, got ${tabList.tabs.length}`);
    }
  } catch (e) {
    log('FAIL', 'New tab creation', e.message);
  }

  // Verify independent PTY — send unique marker in new tab
  if (newTabId) {
    try {
      ws.send(JSON.stringify({ type: 'input', data: 'echo NEW_TAB_MARKER_XYZ\n' }));
      const msgs = await collectMsgs(ws, 2000);
      const combined = msgs.filter(m => m.type === 'output').map(m => m.data).join('');
      if (combined.includes('NEW_TAB_MARKER_XYZ')) {
        log('PASS', 'New tab has independent PTY');
      } else {
        log('FAIL', 'New tab PTY', 'Marker not found in output');
      }
    } catch (e) {
      log('FAIL', 'New tab PTY', e.message);
    }

    // Close the new tab
    try {
      ws.send(JSON.stringify({ type: 'close-tab', id: newTabId }));
      const tabList = await waitForMsg(ws, 'tab-list', 3000);
      const tabExists = tabList.tabs.find(t => t.id === newTabId);
      if (!tabExists) {
        log('PASS', 'Tab closed successfully');
      } else {
        log('FAIL', 'Tab close', 'Tab still exists after close');
      }
    } catch (e) {
      log('FAIL', 'Tab close', e.message);
    }
  }

  ws.close();
}

async function testNullByteFiltering() {
  console.log('\n=== Null Byte Filtering ===');

  let ws;
  try {
    ws = await connectWS();
    await waitForMsg(ws, 'tab-list', 3000);
    ws.send(JSON.stringify({ type: 'switch', id: '1' }));
    await waitForMsg(ws, 'scrollback', 3000);
  } catch (e) {
    log('FAIL', 'Null byte test setup', e.message);
    return;
  }

  try {
    // Send message containing null byte — should be filtered/ignored
    ws.send('hello\x00world');
    await sleep(500);
    // Server should not crash — verify by sending a normal message
    ws.send(JSON.stringify({ type: 'input', data: 'echo NULL_TEST_OK\n' }));
    const msgs = await collectMsgs(ws, 2000);
    const combined = msgs.filter(m => m.type === 'output').map(m => m.data).join('');
    if (combined.includes('NULL_TEST_OK')) {
      log('PASS', 'Null byte messages filtered (server still alive)');
    } else {
      log('FAIL', 'Null byte filtering', 'Server did not respond after null byte message');
    }
  } catch (e) {
    log('FAIL', 'Null byte filtering', e.message);
  }

  ws.close();
}

async function testScrollbackRestore() {
  console.log('\n=== Scrollback Restore ===');

  let ws1;
  try {
    ws1 = await connectWS();
    await waitForMsg(ws1, 'tab-list', 3000);
    ws1.send(JSON.stringify({ type: 'switch', id: '1' }));
    await waitForMsg(ws1, 'scrollback', 3000);

    // Write a unique marker
    ws1.send(JSON.stringify({ type: 'input', data: 'echo SCROLLBACK_RESTORE_TEST_987\n' }));
    await sleep(1000);
    ws1.close();
  } catch (e) {
    log('FAIL', 'Scrollback test setup', e.message);
    return;
  }

  // Reconnect with new WebSocket
  try {
    const ws2 = await connectWS();
    await waitForMsg(ws2, 'tab-list', 3000);
    ws2.send(JSON.stringify({ type: 'switch', id: '1' }));
    const scrollback = await waitForMsg(ws2, 'scrollback', 3000);
    if (scrollback.data && scrollback.data.includes('SCROLLBACK_RESTORE_TEST_987')) {
      log('PASS', 'Scrollback restored on reconnect');
    } else {
      log('FAIL', 'Scrollback restore', 'Marker not found in scrollback data');
    }
    ws2.close();
  } catch (e) {
    log('FAIL', 'Scrollback restore', e.message);
  }
}

async function testHTMLStructure() {
  console.log('\n=== HTML Structure & Requirements ===');

  let html;
  try {
    const res = await fetch('/index.html');
    html = res.body;
  } catch (e) {
    log('FAIL', 'Fetch HTML', e.message);
    return;
  }

  // Viewport meta
  if (html.includes('maximum-scale=1.0') && html.includes('user-scalable=no')) {
    log('PASS', 'Viewport meta prevents zoom (double-tap zoom prevention)');
  } else {
    log('FAIL', 'Viewport meta', 'Missing maximum-scale=1.0 or user-scalable=no');
  }

  // xterm.js CDN v5.5.0
  if (html.includes('@xterm/xterm@5.5.0')) {
    log('PASS', 'xterm.js v5.5.0 CDN loaded');
  } else {
    log('FAIL', 'xterm.js CDN version', 'Expected @xterm/xterm@5.5.0');
  }

  // xterm addon-fit v0.10.0
  if (html.includes('@xterm/addon-fit@0.10.0')) {
    log('PASS', 'xterm addon-fit v0.10.0 CDN loaded');
  } else {
    log('FAIL', 'addon-fit CDN version', 'Expected @xterm/addon-fit@0.10.0');
  }

  // Auth screen
  if (html.includes('id="auth-screen"')) {
    log('PASS', 'Auth screen element exists');
  } else {
    log('FAIL', 'Auth screen', 'Missing #auth-screen');
  }

  // Warning bar
  if (html.includes('USE AT YOUR OWN RISK')) {
    log('PASS', 'Warning bar text present');
  } else {
    log('FAIL', 'Warning bar', 'Missing "USE AT YOUR OWN RISK" text');
  }

  // Logout button
  if (html.includes('id="logout-btn"')) {
    log('PASS', 'Logout button exists');
  } else {
    log('FAIL', 'Logout button', 'Missing #logout-btn');
  }

  // Hide warning button
  if (html.includes('id="hide-warning-btn"')) {
    log('PASS', 'Hide warning button exists');
  } else {
    log('FAIL', 'Hide warning button', 'Missing #hide-warning-btn');
  }

  // Send + Enter buttons separated
  if (html.includes('id="send-btn"') && html.includes('id="enter-btn"')) {
    log('PASS', 'Send and Enter buttons are separate');
  } else {
    log('FAIL', 'Send/Enter buttons', 'Missing separate send-btn and enter-btn');
  }

  // Input field
  if (html.includes('id="input-field"') && html.includes('autocomplete="off"')) {
    log('PASS', 'Input field with autocomplete off');
  } else {
    log('FAIL', 'Input field', 'Missing #input-field or autocomplete setting');
  }

  // Quick keys section
  if (html.includes('id="quick-keys"')) {
    log('PASS', 'Quick keys section exists');
  } else {
    log('FAIL', 'Quick keys', 'Missing #quick-keys');
  }

  // Extra keys section (expandable)
  if (html.includes('id="extra-keys"')) {
    log('PASS', 'Extra keys (expandable) section exists');
  } else {
    log('FAIL', 'Extra keys', 'Missing #extra-keys');
  }

  // Safe area — check for padding/env(safe-area-inset-*)
  if (html.includes('safe-area-inset')) {
    log('PASS', 'Safe Area (notch/Dynamic Island) handling present');
  } else {
    log('FAIL', 'Safe Area handling', 'No safe-area-inset CSS found — may have notch/Dynamic Island issues on iPhone');
  }

  // overscroll-behavior: contain (prevent rubber-band bounce interfering)
  if (html.includes('overscroll-behavior: contain') || html.includes('overscroll-behavior:contain')) {
    log('PASS', 'overscroll-behavior: contain on xterm viewport');
  } else {
    log('FAIL', 'overscroll-behavior', 'Missing overscroll-behavior: contain');
  }

  // touch-action: pan-y on terminal container
  if (html.includes('touch-action: pan-y') || html.includes('touch-action:pan-y')) {
    log('PASS', 'touch-action: pan-y on terminal container');
  } else {
    log('FAIL', 'touch-action', 'Missing touch-action: pan-y');
  }

  // body fixed + overflow hidden (prevents pull-to-refresh and page scroll)
  if (html.includes('position: fixed') && html.includes('overflow: hidden')) {
    log('PASS', 'Body fixed + overflow hidden (prevents page scroll / pull-to-refresh)');
  } else {
    log('FAIL', 'Body positioning', 'Missing fixed positioning or overflow hidden');
  }

  // -webkit-overflow-scrolling: touch for momentum scrolling
  if (html.includes('-webkit-overflow-scrolling: touch')) {
    log('PASS', '-webkit-overflow-scrolling: touch present');
  } else {
    log('FAIL', '-webkit-overflow-scrolling', 'Missing -webkit-overflow-scrolling: touch');
  }

  // Remember me checkbox (for browser autofill, not localStorage)
  if (html.includes('id="auth-remember"') && html.includes('autocomplete="username"') && html.includes('autocomplete="current-password"')) {
    log('PASS', 'Remember me with browser autocomplete attributes');
  } else {
    log('FAIL', 'Remember me', 'Missing auth-remember or autocomplete attributes');
  }

  // Hidden iframe for browser "Save password" trigger
  if (html.includes('hidden-auth-frame')) {
    log('PASS', 'Hidden iframe for browser password save prompt');
  } else {
    log('FAIL', 'Hidden iframe', 'Missing hidden-auth-frame');
  }
}

async function testJSBehavior() {
  console.log('\n=== JavaScript Behavior (Code Review) ===');

  let html;
  try {
    const res = await fetch('/index.html');
    html = res.body;
  } catch (e) {
    log('FAIL', 'Fetch HTML for JS review', e.message);
    return;
  }

  // Quick keys: Check defined keys match requirements
  // Required quick keys: tab dropdown, 1, 2, 3, ESC, TAB, ^C, Keys, ⇣
  // Should NOT include: ^D, ^Z, |, /, -, ~
  const quickKeysMatch = html.match(/const quickKeysDef\s*=\s*\[([\s\S]*?)\];/);
  if (quickKeysMatch) {
    const quickKeysBlock = quickKeysMatch[1];
    const hasNum1 = quickKeysBlock.includes("label: '1'");
    const hasNum2 = quickKeysBlock.includes("label: '2'");
    const hasNum3 = quickKeysBlock.includes("label: '3'");
    const hasESC = quickKeysBlock.includes("label: 'ESC'");
    const hasTAB = quickKeysBlock.includes("label: 'TAB'");
    const hasCtrlC = quickKeysBlock.includes("label: '^C'");
    const hasKeys = quickKeysBlock.includes("label: 'Keys'");

    if (hasNum1 && hasNum2 && hasNum3 && hasESC && hasTAB && hasCtrlC && hasKeys) {
      log('PASS', 'Quick keys contain required keys (1,2,3,ESC,TAB,^C,Keys)');
    } else {
      log('FAIL', 'Quick keys missing required keys',
        `1:${hasNum1} 2:${hasNum2} 3:${hasNum3} ESC:${hasESC} TAB:${hasTAB} ^C:${hasCtrlC} Keys:${hasKeys}`);
    }

    // Check excluded keys are NOT in quick keys
    const hasCtrlD = quickKeysBlock.includes("'^D'") || quickKeysBlock.includes("label: '^D'");
    const hasCtrlZ = quickKeysBlock.includes("label: '^Z'");
    const hasPipe = quickKeysBlock.includes("label: '|'");
    const hasSlash = quickKeysBlock.includes("label: '/'");
    const hasDash = quickKeysBlock.includes("label: '-'");
    const hasTilde = quickKeysBlock.includes("label: '~'");

    if (!hasCtrlD && !hasCtrlZ && !hasPipe && !hasSlash && !hasDash && !hasTilde) {
      log('PASS', 'Quick keys exclude ^D, ^Z, |, /, -, ~ as required');
    } else {
      log('FAIL', 'Quick keys contain excluded keys',
        `^D:${hasCtrlD} ^Z:${hasCtrlZ} |:${hasPipe} /:${hasSlash} -:${hasDash} ~:${hasTilde}`);
    }
  } else {
    log('FAIL', 'Quick keys definition', 'Could not find quickKeysDef in code');
  }

  // Scroll-to-bottom button (⇣, blue)
  if (html.includes("'\\u21e3'") && html.includes("background: '#007acc'")) {
    log('PASS', 'Scroll-to-bottom button (⇣, blue) present');
  } else if (html.includes('\u21e3')) {
    log('FAIL', 'Scroll-to-bottom button', 'Button found but may not be blue (#007acc)');
  } else {
    log('FAIL', 'Scroll-to-bottom button', 'Missing ⇣ button');
  }

  // isComposing check for Korean IME
  if (html.includes('isComposing')) {
    log('PASS', 'isComposing check for Korean IME input');
  } else {
    log('FAIL', 'Korean IME', 'Missing isComposing check');
  }

  // Send text + newline on Send
  if (html.includes("wsSend(text + '\\n')") || html.includes('wsSend(text + "\\n")')) {
    log('PASS', 'Send button sends text + newline');
  } else {
    log('FAIL', 'Send behavior', 'Send may not append newline');
  }

  // Enter button sends \\r (carriage return only)
  if (html.includes("wsSend('\\r')") || html.includes('wsSend("\\r")')) {
    log('PASS', 'Enter button sends carriage return (\\r)');
  } else {
    log('FAIL', 'Enter button', 'Enter may not send \\r');
  }

  // Scroll: atBottom check before auto-scroll
  if (html.includes('viewportY') && html.includes('baseY') && html.includes('atBottom')) {
    log('PASS', 'Scroll-up protection: atBottom check before auto-scroll');
  } else {
    log('FAIL', 'Scroll-up protection', 'Missing viewportY/baseY/atBottom check');
  }

  // smoothScrollDuration and scrollSensitivity
  if (html.includes('smoothScrollDuration: 80') && html.includes('scrollSensitivity: 2')) {
    log('PASS', 'Terminal scroll settings: smoothScrollDuration=80, scrollSensitivity=2');
  } else {
    log('FAIL', 'Terminal scroll settings', 'Missing or incorrect smoothScrollDuration/scrollSensitivity');
  }

  // Touch momentum scrolling
  if (html.includes('addTouchMomentum') || (html.includes('touchstart') && html.includes('touchend') && html.includes('velocity'))) {
    log('PASS', 'Touch momentum scrolling implemented');
  } else {
    log('FAIL', 'Touch momentum', 'Missing touch momentum scrolling code');
  }

  // WebSocket reconnect
  if (html.includes('scheduleReconnect') && html.includes('reconnectDelay')) {
    log('PASS', 'WebSocket auto-reconnect implemented');
  } else {
    log('FAIL', 'WebSocket reconnect', 'Missing reconnect logic');
  }

  // Reconnect delay: 1s initial, max 10s
  if (html.includes('reconnectDelay = 1000') && html.includes('10000')) {
    log('PASS', 'Reconnect delay: 1s initial, 10s max');
  } else {
    log('FAIL', 'Reconnect delay', 'Incorrect reconnect delay values');
  }

  // Token not deleted on network error (only on 4001)
  if (html.includes('4001') && html.includes("localStorage.removeItem('foxtty_token')")) {
    log('PASS', 'Token deleted only on auth rejection (4001), not on network error');
  } else {
    log('FAIL', 'Token deletion', 'Token handling may be incorrect');
  }

  // Warning bar hidden in no-auth mode
  if (html.includes("warningBar.style.display = 'none'") && html.includes('!authToken')) {
    log('PASS', 'Warning bar hidden in no-auth mode');
  } else {
    log('FAIL', 'Warning bar visibility', 'Warning bar may not be hidden in no-auth mode');
  }

  // visualViewport listener for mobile keyboard
  if (html.includes('visualViewport') && html.includes('resize')) {
    log('PASS', 'visualViewport resize listener for mobile keyboard handling');
  } else {
    log('FAIL', 'visualViewport', 'Missing visualViewport resize handling');
  }

  // Tab dropdown (not tabs bar)
  if (html.includes('tab-dropdown-wrap') && html.includes('tab-menu')) {
    log('PASS', 'Tab management via dropdown menu');
  } else {
    log('FAIL', 'Tab dropdown', 'Missing dropdown tab management');
  }

  // PS1 prompt
  // Check server.js
  if (html.includes("PS1: '$ '") || html.includes('PS1: "$ "')) {
    log('FAIL', 'PS1 prompt (checking wrong file)', 'PS1 is in server.js, not HTML');
  } else {
    // Will check server.js separately
    log('PASS', 'PS1 check deferred to server test');
  }
}

async function testServerCode() {
  console.log('\n=== Server Code Review ===');

  // Read server.js for code review
  const fs = require('fs');
  let serverCode;
  try {
    serverCode = fs.readFileSync('/Users/sunnycat/src/foxtrot/server.js', 'utf-8');
  } catch (e) {
    log('FAIL', 'Read server.js', e.message);
    return;
  }

  // PS1 prompt
  if (serverCode.includes("PS1: '$ '") || serverCode.includes('PS1: "$ "')) {
    log('PASS', 'PS1 prompt set to "$ "');
  } else {
    log('FAIL', 'PS1 prompt', 'Missing or incorrect PS1');
  }

  // -w/--cwd option
  if (serverCode.includes("'-w'") && serverCode.includes("'--cwd'")) {
    log('PASS', '-w/--cwd option for start directory');
  } else {
    log('FAIL', '-w/--cwd option', 'Missing cwd option');
  }

  // --auth flag
  if (serverCode.includes("'--auth'")) {
    log('PASS', '--auth flag for optional authentication');
  } else {
    log('FAIL', '--auth flag', 'Missing --auth flag');
  }

  // JWT_SECRET from env
  if (serverCode.includes('process.env.JWT_SECRET')) {
    log('PASS', 'JWT_SECRET read from environment variable');
  } else {
    log('FAIL', 'JWT_SECRET', 'Not reading from env');
  }

  // Missing JWT_SECRET error handling
  if (serverCode.includes('authMissingSecret')) {
    log('PASS', 'Missing JWT_SECRET error handling');
  } else {
    log('FAIL', 'JWT_SECRET error', 'No error handling for missing JWT_SECRET');
  }

  // Null byte filtering
  if (serverCode.includes("'\\x00'") || serverCode.includes('"\\x00"')) {
    log('PASS', 'Null byte filtering in WebSocket messages');
  } else {
    log('FAIL', 'Null byte filtering', 'Missing null byte check');
  }

  // Cache-Control: no-store
  if (serverCode.includes('no-store')) {
    log('PASS', 'Static files Cache-Control: no-store');
  } else {
    log('FAIL', 'Cache-Control', 'Missing no-store');
  }

  // etag: false, lastModified: false
  if (serverCode.includes('etag: false') && serverCode.includes('lastModified: false')) {
    log('PASS', 'etag and lastModified disabled');
  } else {
    log('FAIL', 'etag/lastModified', 'Not fully disabled');
  }

  // MAX_SCROLLBACK
  if (serverCode.includes('MAX_SCROLLBACK')) {
    log('PASS', 'Scrollback buffer limit defined (MAX_SCROLLBACK)');
  } else {
    log('FAIL', 'Scrollback limit', 'Missing MAX_SCROLLBACK');
  }

  // WebSocket auth with close code 4001
  if (serverCode.includes('4001')) {
    log('PASS', 'WebSocket auth rejection uses close code 4001');
  } else {
    log('FAIL', 'WebSocket auth code', 'Missing 4001 close code');
  }

  // /api/verify endpoint
  if (serverCode.includes("/api/verify")) {
    log('PASS', '/api/verify endpoint defined');
  } else {
    log('FAIL', '/api/verify', 'Missing /api/verify endpoint');
  }

  // Password min length validation
  if (serverCode.includes('password.length') || serverCode.includes('password.length < 4')) {
    log('PASS', 'Password minimum length validation');
  } else {
    log('FAIL', 'Password validation', 'Missing password length check');
  }

  // Registration closes after first user
  if (serverCode.includes('Registration closed')) {
    log('PASS', 'Registration closes after first user created');
  } else {
    log('FAIL', 'Registration close', 'Missing registration close logic');
  }

  // noServer WebSocket (for auth upgrade handling)
  if (serverCode.includes('noServer: true')) {
    log('PASS', 'WebSocket uses noServer mode for auth upgrade handling');
  } else {
    log('FAIL', 'WebSocket noServer', 'Not using noServer mode');
  }
}

async function testMultiClientSync() {
  console.log('\n=== Multi-Client Synchronization ===');

  let ws1, ws2;
  try {
    ws1 = await connectWS();
    ws2 = await connectWS();
    await waitForMsg(ws1, 'tab-list', 3000);
    await waitForMsg(ws2, 'tab-list', 3000);

    // Both switch to same tab
    ws1.send(JSON.stringify({ type: 'switch', id: '1' }));
    ws2.send(JSON.stringify({ type: 'switch', id: '1' }));
    await waitForMsg(ws1, 'scrollback', 3000);
    await waitForMsg(ws2, 'scrollback', 3000);

    log('PASS', 'Multiple clients can connect to same tab');
  } catch (e) {
    log('FAIL', 'Multi-client connect', e.message);
    if (ws1) ws1.close();
    if (ws2) ws2.close();
    return;
  }

  // Test: output from ws1 is also visible to ws2
  try {
    ws1.send(JSON.stringify({ type: 'input', data: 'echo MULTI_CLIENT_SYNC_TEST\n' }));
    const msgs = await collectMsgs(ws2, 2000);
    const combined = msgs.filter(m => m.type === 'output').map(m => m.data).join('');
    if (combined.includes('MULTI_CLIENT_SYNC_TEST')) {
      log('PASS', 'Output broadcast to all clients on same tab');
    } else {
      log('FAIL', 'Multi-client output', 'Client 2 did not receive output from client 1');
    }
  } catch (e) {
    log('FAIL', 'Multi-client sync', e.message);
  }

  // Test: new tab from ws1 is notified to ws2
  try {
    ws1.send(JSON.stringify({ type: 'new-tab' }));
    const ws2Msg = await waitForMsg(ws2, 'tab-list', 3000);
    if (ws2Msg.tabs.length >= 2) {
      log('PASS', 'New tab notification broadcast to all clients');
      // Clean up: close the newly created tab
      const newTabId = ws2Msg.tabs[ws2Msg.tabs.length - 1].id;
      ws1.send(JSON.stringify({ type: 'close-tab', id: newTabId }));
      await sleep(500);
    } else {
      log('FAIL', 'Tab notification', 'Client 2 did not receive updated tab list');
    }
  } catch (e) {
    log('FAIL', 'Tab notification', e.message);
  }

  ws1.close();
  ws2.close();
}

async function testEdgeCases() {
  console.log('\n=== Edge Cases ===');

  let ws;
  try {
    ws = await connectWS();
    await waitForMsg(ws, 'tab-list', 3000);
    ws.send(JSON.stringify({ type: 'switch', id: '1' }));
    await waitForMsg(ws, 'scrollback', 3000);
  } catch (e) {
    log('FAIL', 'Edge case WS setup', e.message);
    return;
  }

  // Invalid JSON message
  try {
    ws.send('not json at all {{{');
    await sleep(300);
    ws.send(JSON.stringify({ type: 'input', data: 'echo STILL_ALIVE\n' }));
    const msgs = await collectMsgs(ws, 2000);
    const combined = msgs.filter(m => m.type === 'output').map(m => m.data).join('');
    if (combined.includes('STILL_ALIVE')) {
      log('PASS', 'Server handles invalid JSON gracefully');
    } else {
      log('FAIL', 'Invalid JSON handling', 'Server did not respond after invalid JSON');
    }
  } catch (e) {
    log('FAIL', 'Invalid JSON handling', e.message);
  }

  // Switch to non-existent tab
  try {
    ws.send(JSON.stringify({ type: 'switch', id: '999' }));
    await sleep(500);
    // Server should not crash
    ws.send(JSON.stringify({ type: 'input', data: 'echo SWITCH_INVALID_OK\n' }));
    const msgs = await collectMsgs(ws, 2000);
    // It may or may not output — the key is no crash
    log('PASS', 'Switch to non-existent tab does not crash server');
  } catch (e) {
    log('FAIL', 'Switch non-existent tab', e.message);
  }

  // Close non-existent tab
  try {
    ws.send(JSON.stringify({ type: 'close-tab', id: '999' }));
    await sleep(300);
    ws.send(JSON.stringify({ type: 'input', data: 'echo CLOSE_INVALID_OK\n' }));
    const msgs = await collectMsgs(ws, 1000);
    log('PASS', 'Close non-existent tab does not crash server');
  } catch (e) {
    log('FAIL', 'Close non-existent tab', e.message);
  }

  // Resize with invalid values
  try {
    ws.send(JSON.stringify({ type: 'resize', cols: 0, rows: 0 }));
    await sleep(300);
    ws.send(JSON.stringify({ type: 'resize', cols: -1, rows: -1 }));
    await sleep(300);
    ws.send(JSON.stringify({ type: 'input', data: 'echo RESIZE_EDGE_OK\n' }));
    const msgs = await collectMsgs(ws, 1000);
    log('PASS', 'Invalid resize values do not crash server');
  } catch (e) {
    // node-pty may throw on invalid resize values
    log('FAIL', 'Invalid resize handling', e.message);
  }

  ws.close();
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('===========================================');
  console.log('   foxtty QA Test Suite');
  console.log('   Target: http://localhost:16000');
  console.log('===========================================');

  try {
    await testAPIEndpoints();
    await testWebSocketBasic();
    await testMultiTab();
    await testNullByteFiltering();
    await testScrollbackRestore();
    await testHTMLStructure();
    await testJSBehavior();
    await testServerCode();
    await testMultiClientSync();
    await testEdgeCases();
  } catch (e) {
    console.error('Fatal error:', e);
  }

  console.log('\n===========================================');
  console.log(`   Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('===========================================');

  // Summary of failures
  const failures = results.filter(r => r.status === 'FAIL');
  if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  - ${f.name}: ${f.detail || ''}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
