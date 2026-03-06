const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT = process.env.PORT || 3000;

let state = {
  // Event info
  eventName:   'Garmin Winter Festival',
  logoBase64:  '',          // base64 PNG/JPG przesłane z admina

  // Rider mode
  riderMode:   1,
  timerEnabled: false,

  // Ready flags
  judgeReady:  false,
  tvReady:     false,
  goSignalGiven: false,

  // Riders
  currentRider1: '',
  currentRider2: '',
  nextRider1:    '',
  nextRider2:    '',

  // Run counter
  runCurrent:  0,
  runTotal:    0,

  // Timer
  timerRunning: false,
  timerStart:   null,
  timerElapsed: 0,         // ms zapisane przy pauzie

  // Message from admin to judge/tv
  adminMessage: '',

  // History
  history: [],             // [{time, rider1, rider2, run}]

  _autoResetTimer: null,
};

let sseClients = [];

function publicState() {
  return {
    eventName:     state.eventName,
    logoBase64:    state.logoBase64,
    riderMode:     state.riderMode,
    judgeReady:    state.judgeReady,
    tvReady:       state.tvReady,
    goSignalGiven: state.goSignalGiven,
    currentRider1: state.currentRider1,
    currentRider2: state.currentRider2,
    nextRider1:    state.nextRider1,
    nextRider2:    state.nextRider2,
    runCurrent:    state.runCurrent,
    runTotal:      state.runTotal,
    timerRunning:  state.timerRunning,
    timerStart:    state.timerStart,
    timerElapsed:  state.timerElapsed,
    timerEnabled:  state.timerEnabled,
    adminMessage:  state.adminMessage,
    history:       state.history,
    ts:            Date.now(),
  };
}

function broadcast() {
  const payload = 'data: ' + JSON.stringify(publicState()) + '\n\n';
  sseClients.forEach(r => { try { r.write(payload); } catch(e){} });
}

function scheduleAutoReset() {
  if (state._autoResetTimer) clearTimeout(state._autoResetTimer);
  if (state.judgeReady && state.tvReady) {
    state._autoResetTimer = setTimeout(() => {
      resetRound(false);
      console.log('[AUTO-RESET] 20s elapsed');
      broadcast();
    }, 20000);
  }
}

function resetRound(keepRiders) {
  if (state._autoResetTimer) clearTimeout(state._autoResetTimer);
  state.judgeReady    = false;
  state.tvReady       = false;
  state.goSignalGiven = false;
  state.timerRunning  = false;
  state.timerStart    = null;
  state.timerElapsed  = 0;
  if (!keepRiders) {
    // przesuń "next" → "current", wyczyść "next"
    state.currentRider1 = state.nextRider1 || '';
    state.currentRider2 = state.nextRider2 || '';
    state.nextRider1    = '';
    state.nextRider2    = '';
  }
}

// ── body parser ──────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 5e6) req.destroy(); });
    req.on('end',  () => { try { resolve(JSON.parse(body || '{}')); } catch(e){ resolve({}); } });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
};

const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── SSE ─────────────────────────────────────────────────────────
  if (pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('data: ' + JSON.stringify(publicState()) + '\n\n');
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }

  // ── API STATE ────────────────────────────────────────────────────
  if (pathname === '/api/state') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(publicState())); return;
  }

  // ── API JUDGE ────────────────────────────────────────────────────
  if (pathname === '/api/judge' && req.method === 'POST') {
    state.judgeReady = !state.judgeReady;
    if (!state.judgeReady) state.goSignalGiven = false;
    scheduleAutoReset(); broadcast();
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true})); return;
  }

  // ── API TV ───────────────────────────────────────────────────────
  if (pathname === '/api/tv' && req.method === 'POST') {
    state.tvReady = !state.tvReady;
    if (!state.tvReady) state.goSignalGiven = false;
    scheduleAutoReset(); broadcast();
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true})); return;
  }

  // ── API GO ───────────────────────────────────────────────────────
  if (pathname === '/api/go' && req.method === 'POST') {
    if (state.judgeReady && state.tvReady) {
      state.goSignalGiven = true;
      if (state._autoResetTimer) clearTimeout(state._autoResetTimer);
      // zapisz do historii
      if (state.runCurrent > 0 || state.currentRider1) {
        state.history.unshift({
          time:    new Date().toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit',second:'2-digit'}),
          rider1:  state.currentRider1,
          rider2:  state.currentRider2,
          run:     state.runCurrent,
        });
        if (state.history.length > 20) state.history.pop();
      }
      if (state.runCurrent > 0) state.runCurrent++;
      // uruchom timer
      state.timerRunning = true;
      state.timerStart   = Date.now();
      state.timerElapsed = 0;
      broadcast();
      // auto-reset po 5s
      state._autoResetTimer = setTimeout(() => {
        resetRound(false);
        broadcast();
      }, 5000);
    }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true})); return;
  }

  // ── API RESET ────────────────────────────────────────────────────
  if (pathname === '/api/reset' && req.method === 'POST') {
    resetRound(false); broadcast();
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true})); return;
  }

  // ── API ADMIN UPDATE ─────────────────────────────────────────────
  if (pathname === '/api/admin' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.eventName   !== undefined) state.eventName   = body.eventName;
    if (body.logoBase64  !== undefined) state.logoBase64  = body.logoBase64;
    if (body.riderMode   !== undefined) state.riderMode   = parseInt(body.riderMode) || 1;
    if (body.runTotal    !== undefined) state.runTotal    = parseInt(body.runTotal)   || 0;
    if (body.runCurrent  !== undefined) state.runCurrent  = parseInt(body.runCurrent) || 0;
    if (body.adminMessage!== undefined) state.adminMessage= body.adminMessage;
    if (body.timerEnabled !== undefined) state.timerEnabled = !!body.timerEnabled;
    broadcast();
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true})); return;
  }

  // ── API RIDERS (from starter) ────────────────────────────────────
  if (pathname === '/api/riders' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.currentRider1 !== undefined) state.currentRider1 = body.currentRider1;
    if (body.currentRider2 !== undefined) state.currentRider2 = body.currentRider2;
    if (body.nextRider1    !== undefined) state.nextRider1    = body.nextRider1;
    if (body.nextRider2    !== undefined) state.nextRider2    = body.nextRider2;
    broadcast();
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true})); return;
  }

  // ── STATIC FILES ─────────────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  if (pathname === '/judge')    filePath = '/judge.html';
  if (pathname === '/tv')       filePath = '/tv.html';
  if (pathname === '/operator') filePath = '/operator.html';
  if (pathname === '/admin')    filePath = '/admin.html';

  const fullPath = path.join(__dirname, 'public', filePath);
  fs.readFile(fullPath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found: ' + filePath); return; }
    res.writeHead(200, {'Content-Type': MIME[path.extname(filePath)] || 'text/plain'});
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ifaces = require('os').networkInterfaces();
  let ip = 'localhost';
  Object.values(ifaces).forEach(i => i.forEach(d => { if (d.family==='IPv4' && !d.internal) ip=d.address; }));
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║      RACE READY SYSTEM — uruchomiony!               ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  ADMIN/PODGLĄD:    http://${ip}:${PORT}/admin   ║`);
  console.log(`║  SĘDZIA:           http://${ip}:${PORT}/judge   ║`);
  console.log(`║  TV / REŻYSER:     http://${ip}:${PORT}/tv      ║`);
  console.log(`║  OPERATOR:         http://${ip}:${PORT}/operator║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');
});
