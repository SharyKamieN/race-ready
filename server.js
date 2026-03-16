const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 8080;

// ── PROFILES & AUTH DATA ────────────────────────────────────────
// Stored in memory (persists until server restart)
// On Railway: resets on redeploy — profiles saved in JSON file

const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch(e) {}
  return {
    admins: [{ login: 'admin', password: 'ledcity1063', role: 'superadmin', email: 'grzesiek.bog2004@gmail.com', blocked: false }],
    profiles: [],
    savedState: null
  };
}

function saveData() {
  try {
    const saved = Object.assign({}, appData, {
      lastState: {
        eventName:   state.eventName,
        language:    state.language,
        logoBase64:  state.logoBase64,
        riderMode:   state.riderMode,
        timerEnabled:state.timerEnabled,
        showRun:     state.showRun,
        showRiders:  state.showRiders,
        systemActive:state.systemActive,
        runTotal:    state.runTotal,
        theme:       state.theme,
        accentColor: state.accentColor,
        history:     state.history,
      }
    });
    appData._lastSave = new Date().toISOString();
    fs.writeFileSync(DATA_FILE, JSON.stringify(saved, null, 2));
  } catch(e) {}
}

// Auto-save every 30 seconds
setInterval(saveData, 30000);

let appData = loadData();

// Restore last state from saved data
if (appData.lastState) {
  const ls = appData.lastState;
  if (ls.eventName   !== undefined) state.eventName   = ls.eventName;
  if (ls.language    !== undefined) state.language    = ls.language;
  if (ls.logoBase64  !== undefined) state.logoBase64  = ls.logoBase64;
  if (ls.riderMode   !== undefined) state.riderMode   = ls.riderMode;
  if (ls.timerEnabled!== undefined) state.timerEnabled= ls.timerEnabled;
  if (ls.showRun     !== undefined) state.showRun     = ls.showRun;
  if (ls.showRiders  !== undefined) state.showRiders  = ls.showRiders;
  if (ls.runTotal    !== undefined) state.runTotal    = ls.runTotal;
  if (ls.theme       !== undefined) state.theme       = ls.theme;
  if (ls.accentColor !== undefined) state.accentColor = ls.accentColor;
  if (ls.history     !== undefined) state.history     = ls.history;
  // systemActive always starts false for safety
}

// Helper: find admin by login
function findAdmin(login) {
  return appData.admins.find(a => a.login === login);
}
function checkAuth(login, password) {
  const a = findAdmin(login);
  if (!a || a.blocked) return null;
  return a.password === password ? a : null;
}

// ── STATE ───────────────────────────────────────────────────────
let state = {
  eventName:    '',
  language:     'pl',
  logoBase64:   '',
  riderMode:    1,
  timerEnabled: false,
  showRun:      false,
  systemActive: false,
  judgeReady:   false,
  tvReady:      false,
  goSignalGiven:false,
  currentRider1:'',
  currentRider2:'',
  nextRider1:   '',
  nextRider2:   '',
  runCurrent:   1,
  runTotal:     0,
  timerRunning: false,
  timerStart:   null,
  timerElapsed: 0,
  adminMessage: '',
  msgColor:     '',
  theme:        'dark',
  accentColor:  '#00C8FF',
  appName:      'RACE READY',
  showRiders:   true,
  history:      [],
  _autoReset:   null,
};

let clients = [];

// ── AUTH ────────────────────────────────────────────────────────
const sessions = new Map(); // token -> { login, lastActivity }
const SESSION_TTL = 8 * 60 * 60 * 1000;

function genToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── RESET TOKENS ────────────────────────────────────────────────
const resetTokens = new Map(); // token -> { login, expires }

function genCode() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code
}

// Send email via Gmail SMTP using raw HTTP (no nodemailer needed)
function sendResetEmail(toEmail, code) {
  return new Promise((resolve, reject) => {
    const https  = require('https');
    const crypto = require('crypto');

    // Use Gmail API via fetch-like HTTPS with basic auth (App Password)
    const GMAIL_USER = process.env.GMAIL_USER || 'grzesiek.bog2004@gmail.com';
    const GMAIL_PASS = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '');

    // Build raw email
    const boundary = crypto.randomBytes(8).toString('hex');
    const rawEmail = [
      'From: Race Ready System <' + GMAIL_USER + '>',
      'To: ' + toEmail,
      'Subject: =?UTF-8?B?' + Buffer.from('Kod resetowania hasla - Race Ready').toString('base64') + '?=',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:20px;background:#0A0C0F;color:#F0F4FF;border-radius:12px;">',
      '<h2 style="color:#00C8FF;letter-spacing:0.1em;">RACE READY SYSTEM</h2>',
      '<p>Otrzymalismy prosbe o reset hasla.</p>',
      '<div style="font-size:36px;font-weight:900;letter-spacing:0.3em;color:#FFD200;text-align:center;padding:20px;background:#111418;border-radius:8px;margin:16px 0;">'+code+'</div>',
      '<p style="color:#7A8090;font-size:12px;">Kod wazny przez <strong style="color:#F0F4FF;">15 minut</strong>. Jesli nie prosiłes o reset - zignoruj tego maila.</p>',
      '</div>'
    ].join('\r\n');

    const encodedEmail = Buffer.from(rawEmail).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');

    const postData = JSON.stringify({ raw: encodedEmail });

    const options = {
      hostname: 'gmail.googleapis.com',
      path: '/gmail/v1/users/me/messages/send',
      method: 'POST',
    };

    // Fallback: use SMTP directly via net/tls — simpler approach
    // Actually use smtp directly
    sendViaSMTP(GMAIL_USER, GMAIL_PASS, toEmail, code).then(resolve).catch(reject);
  });
}

function sendViaSMTP(user, pass, to, code) {
  return new Promise((resolve, reject) => {
    const tls  = require('tls');
    const sock = tls.connect(465, 'smtp.gmail.com', { rejectUnauthorized: false }, () => {
      let step = 0;
      const auth = Buffer.from('\0' + user + '\0' + pass).toString('base64');
      const subject = 'Kod resetowania hasla - Race Ready';
      const body = [
        '<div style="font-family:Arial,sans-serif;padding:20px;background:#0A0C0F;color:#F0F4FF;">',
        '<h2 style="color:#00C8FF;">RACE READY SYSTEM</h2>',
        '<p>Kod do resetu hasla:</p>',
        '<div style="font-size:40px;font-weight:900;letter-spacing:0.3em;color:#FFD200;text-align:center;padding:20px;background:#111418;border-radius:8px;">'+code+'</div>',
        '<p style="color:#7A8090;font-size:12px;">Wazny 15 minut. Jesli nie prosiłes - zignoruj.</p>',
        '</div>'
      ].join('');

      const lines = [
        null,
        'EHLO race-ready',
        'AUTH PLAIN ' + auth,
        'MAIL FROM:<' + user + '>',
        'RCPT TO:<' + to + '>',
        'DATA',
        'From: Race Ready <' + user + '>\r\nTo: ' + to + '\r\nSubject: ' + subject + '\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n' + body + '\r\n.',
        'QUIT'
      ];

      sock.on('data', d => {
        const r = d.toString();
        // console.log('SMTP <<', r.trim());
        if (step < lines.length - 1) {
          step++;
          if (lines[step] !== null) sock.write(lines[step] + '\r\n');
        } else if (r.includes('221') || r.includes('250 2.0.0')) {
          sock.end();
          resolve();
        }
      });

      sock.on('error', e => reject(e));
      sock.on('close', () => resolve());
    });
    sock.on('error', e => reject(e));
    setTimeout(() => reject(new Error('SMTP timeout')), 15000);
  });
}


setInterval(() => {
  const now = Date.now();
  for (const [token, d] of sessions) {
    if (now - d.lastActivity > SESSION_TTL) sessions.delete(token);
  }
}, 30 * 60 * 1000);

function getCookie(req, name) {
  const h = req.headers.cookie || '';
  const m = h.split(';').map(c=>c.trim()).find(c=>c.startsWith(name+'='));
  return m ? m.slice(name.length+1) : null;
}

function isAuthed(req) {
  const token = getCookie(req, 'rr_session');
  if (!token || !sessions.has(token)) return false;
  const d = sessions.get(token);
  if (Date.now() - d.lastActivity > SESSION_TTL) { sessions.delete(token); return false; }
  d.lastActivity = Date.now();
  return true;
}

function getSessionAdmin(req) {
  const token = getCookie(req, 'rr_session');
  if (!token || !sessions.has(token)) return null;
  const d = sessions.get(token);
  if (Date.now() - d.lastActivity > SESSION_TTL) { sessions.delete(token); return null; }
  d.lastActivity = Date.now();
  return findAdmin(d.login);
}

function isSuperAdmin(req) {
  const a = getSessionAdmin(req);
  return a && a.role === 'superadmin';
}

// ── PUB / BROADCAST ─────────────────────────────────────────────
function pub() {
  return {
    eventName:    state.eventName,
    language:     state.language,
    logoBase64:   state.logoBase64,
    riderMode:    state.riderMode,
    timerEnabled: state.timerEnabled,
    showRun:      state.showRun,
    systemActive: state.systemActive,
    judgeReady:   state.judgeReady,
    tvReady:      state.tvReady,
    goSignalGiven:state.goSignalGiven,
    currentRider1:state.currentRider1,
    currentRider2:state.currentRider2,
    nextRider1:   state.nextRider1,
    nextRider2:   state.nextRider2,
    runCurrent:   state.runCurrent,
    runTotal:     state.runTotal,
    timerRunning: state.timerRunning,
    timerStart:   state.timerStart,
    timerElapsed: state.timerElapsed,
    adminMessage: state.adminMessage,
    msgColor:     state.msgColor,
    theme:        state.theme,
    accentColor:  state.accentColor,
    appName:      state.appName,
    showRiders:   state.showRiders,
    history:      state.history,
    ts:           Date.now(),
  };
}

function broadcast() {
  const msg = 'data: ' + JSON.stringify(pub()) + '\n\n';
  clients.forEach(r => { try { r.write(msg); } catch(e){} });
}

function resetRound() {
  if (state._autoReset) clearTimeout(state._autoReset);
  state.judgeReady    = false;
  state.tvReady       = false;
  state.goSignalGiven = false;
  state.currentRider1 = state.nextRider1 || '';
  state.currentRider2 = state.nextRider2 || '';
  state.nextRider1    = '';
  state.nextRider2    = '';
}

function autoReset() {
  if (state._autoReset) clearTimeout(state._autoReset);
  if (state.judgeReady && state.tvReady) {
    state._autoReset = setTimeout(() => { resetRound(); broadcast(); }, 20000);
  }
}

function body(req) {
  return new Promise(res => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end',  () => { try { res(JSON.parse(d||'{}')); } catch(e){ res({}); } });
  });
}

function json(res, code, obj) {
  res.writeHead(code, {'Content-Type':'application/json'});
  res.end(JSON.stringify(obj));
}

const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};
const DIR = __dirname;

http.createServer(async (req, res) => {
  const p = url.parse(req.url).pathname;
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── SSE ──
  if (p==='/events') {
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
    res.write('data: '+JSON.stringify(pub())+'\n\n');
    clients.push(res);
    const hb = setInterval(() => { try { res.write(':ping\n\n'); } catch(e){} }, 25000);
    req.on('close',()=>{ clearInterval(hb); clients=clients.filter(c=>c!==res); });
    return;
  }

  // ── SYSTEM GUARD ──
  if (!state.systemActive && ['/api/judge','/api/tv','/api/go','/api/riders'].includes(p)) {
    json(res,403,{ok:false,reason:'System offline'}); return;
  }


  // ── STATUS / PING ────────────────────────────────────────────
  if (p === '/api/status' && req.method === 'GET') {
    json(res, 200, {
      ok: true,
      connectedClients: clients.length,
      uptime: Math.floor(process.uptime()),
      serverTime: Date.now(),
    });
    return;
  }

  if (p==='/api/state') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(pub())); return; }

  // ── JUDGE / TV / GO / RESET ──
  if (p==='/api/judge' && req.method==='POST') {
    state.judgeReady=!state.judgeReady;
    if(!state.judgeReady) state.goSignalGiven=false;
    autoReset(); broadcast();
    json(res,200,{ok:true}); return;
  }

  if (p==='/api/tv' && req.method==='POST') {
    state.tvReady=!state.tvReady;
    if(!state.tvReady) state.goSignalGiven=false;
    autoReset(); broadcast();
    json(res,200,{ok:true}); return;
  }

  if (p==='/api/go' && req.method==='POST') {
    if (state.judgeReady && state.tvReady && !state.goSignalGiven) {
      state.goSignalGiven=true;
      if(state._autoReset) clearTimeout(state._autoReset);
      state.runCurrent++;
      if(state.timerEnabled){ state.timerRunning=true; state.timerStart=Date.now(); state.timerElapsed=0; }
      state.history.unshift({time:new Date().toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit',second:'2-digit'}),rider1:state.currentRider1,rider2:state.currentRider2,run:state.runCurrent});
      if(state.history.length>20) state.history.pop();
      broadcast();
      state._autoReset=setTimeout(()=>{ resetRound(); broadcast(); },5000);
    }
    json(res,200,{ok:true}); return;
  }

  if (p==='/api/reset' && req.method==='POST') {
    resetRound(); broadcast();
    json(res,200,{ok:true}); return;
  }

  if (p==='/api/timer/stop' && req.method==='POST') {
    if (state.timerRunning && state.timerStart) {
      state.timerElapsed = Date.now() - state.timerStart + (state.timerElapsed || 0);
    }
    state.timerRunning = false; state.timerStart = null;
    broadcast(); json(res,200,{ok:true}); return;
  }

  if (p==='/api/timer/reset' && req.method==='POST') {
    state.timerRunning = false; state.timerStart = null; state.timerElapsed = 0;
    broadcast(); json(res,200,{ok:true}); return;
  }


  // ── FULL RESET ───────────────────────────────────────────────
  if (p === '/api/fullreset' && req.method === 'POST') {
    if (state._autoReset) clearTimeout(state._autoReset);
    state.judgeReady    = false;
    state.tvReady       = false;
    state.goSignalGiven = false;
    state.currentRider1 = '';
    state.currentRider2 = '';
    state.nextRider1    = '';
    state.nextRider2    = '';
    state.runCurrent    = 1;
    state.timerRunning  = false;
    state.timerStart    = null;
    state.timerElapsed  = 0;
    state.adminMessage  = '';
    state.msgColor      = '';
    state.history       = [];
    broadcast();
    json(res, 200, {ok: true}); return;
  }

  if (p==='/api/history/clear' && req.method==='POST') {
    state.history = []; broadcast(); json(res,200,{ok:true}); return;
  }

  if (p==='/api/admin' && req.method==='POST') {
    const b=await body(req);
    if(b.eventName!==undefined)    state.eventName=b.eventName;
    if(b.logoBase64!==undefined)   state.logoBase64=b.logoBase64;
    if(b.riderMode!==undefined)    state.riderMode=parseInt(b.riderMode)||1;
    if(b.runTotal!==undefined)     state.runTotal=parseInt(b.runTotal)||0;
    if(b.runCurrent!==undefined)   state.runCurrent=parseInt(b.runCurrent)||0;
    if(b.adminMessage!==undefined) state.adminMessage=b.adminMessage;
    if(b.msgColor!==undefined)     state.msgColor=b.msgColor;
    if(b.language!==undefined)     state.language=b.language;
    if(b.showRun!==undefined)      state.showRun=!!b.showRun;
    if(b.theme!==undefined)        state.theme=b.theme;
    if(b.accentColor!==undefined)  state.accentColor=b.accentColor;
    if(b.appName!==undefined)      state.appName=b.appName;
    if(b.showRiders!==undefined)   state.showRiders=!!b.showRiders;
    if(b.timerEnabled!==undefined) state.timerEnabled=!!b.timerEnabled;
    if(b.systemActive!==undefined) { state.systemActive=!!b.systemActive; if(!state.systemActive){ state.judgeReady=false; state.tvReady=false; state.goSignalGiven=false; } }
    broadcast(); json(res,200,{ok:true}); return;
  }

  if (p==='/api/riders' && req.method==='POST') {
    const b=await body(req);
    if(b.currentRider1!==undefined) state.currentRider1=b.currentRider1;
    if(b.currentRider2!==undefined) state.currentRider2=b.currentRider2;
    if(b.nextRider1!==undefined)    state.nextRider1=b.nextRider1;
    if(b.nextRider2!==undefined)    state.nextRider2=b.nextRider2;
    broadcast(); json(res,200,{ok:true}); return;
  }


  // ── SYSTEM STATUS ─────────────────────────────────────────
  if (p === '/api/status' && req.method === 'GET') {
    if (!isAuthed(req)) { json(res,401,{ok:false}); return; }
    json(res, 200, {
      ok: true,
      clients:  clients.length,
      uptime:   Math.floor(process.uptime()),
      memory:   Math.round(process.memoryUsage().rss / 1024 / 1024),
      profiles: appData.profiles.length,
      admins:   appData.admins.length,
      lastSave: appData._lastSave || null,
    });
    return;
  }

  // ── PROFILES API ─────────────────────────────────────────────
  // GET /api/profiles — list all profiles
  if (p==='/api/profiles' && req.method==='GET') {
    if (!isAuthed(req)) { json(res,401,{ok:false}); return; }
    json(res,200,{ok:true, profiles: appData.profiles}); return;
  }

  // POST /api/profiles/save — save new or update profile
  if (p==='/api/profiles/save' && req.method==='POST') {
    if (!isAuthed(req)) { json(res,401,{ok:false}); return; }
    const b = await body(req);
    if (!b.name) { json(res,400,{ok:false,error:'Brak nazwy profilu'}); return; }
    if (appData.profiles.length >= 5 && !b.id) {
      json(res,400,{ok:false,error:'Maksymalnie 5 profili'}); return;
    }
    const profile = {
      id:          b.id || Date.now().toString(36),
      name:        b.name,
      eventName:   b.eventName   || '',
      logoBase64:  b.logoBase64  || '',
      language:    b.language    || 'pl',
      riderMode:   b.riderMode   || 1,
      timerEnabled:b.timerEnabled|| false,
      showRun:     b.showRun     || false,
      runTotal:    b.runTotal    || 0,
      theme:       b.theme       || 'dark',
      accentColor: b.accentColor || '#00C8FF',
    };
    const idx = appData.profiles.findIndex(p => p.id === profile.id);
    if (idx >= 0) appData.profiles[idx] = profile;
    else appData.profiles.push(profile);
    saveData();
    json(res,200,{ok:true, profile}); return;
  }

  // POST /api/profiles/load — load profile into state
  if (p==='/api/profiles/load' && req.method==='POST') {
    if (!isAuthed(req)) { json(res,401,{ok:false}); return; }
    const b = await body(req);
    const prof = appData.profiles.find(p => p.id === b.id);
    if (!prof) { json(res,404,{ok:false,error:'Nie znaleziono profilu'}); return; }
    state.eventName   = prof.eventName   || '';
    state.logoBase64  = prof.logoBase64  || '';
    state.language    = prof.language    || 'pl';
    state.riderMode   = prof.riderMode   || 1;
    state.timerEnabled= prof.timerEnabled|| false;
    state.showRun     = prof.showRun     || false;
    state.runTotal    = prof.runTotal    || 0;
    state.theme       = prof.theme       || 'dark';
    state.accentColor = prof.accentColor || '#00C8FF';
    broadcast();
    json(res,200,{ok:true}); return;
  }

  // POST /api/profiles/delete — delete profile
  if (p==='/api/profiles/delete' && req.method==='POST') {
    if (!isAuthed(req)) { json(res,401,{ok:false}); return; }
    const b = await body(req);
    appData.profiles = appData.profiles.filter(p => p.id !== b.id);
    saveData();
    json(res,200,{ok:true}); return;
  }

  // ── ADMINS API ───────────────────────────────────────────────
  // GET /api/admins — list admins (superadmin only)
  if (p==='/api/admins' && req.method==='GET') {
    if (!isSuperAdmin(req)) { json(res,403,{ok:false}); return; }
    json(res,200,{ok:true, admins: appData.admins.map(a=>({login:a.login,role:a.role}))}); return;
  }

  // POST /api/admins/add — add admin (superadmin only, max 2 total)
  if (p==='/api/admins/add' && req.method==='POST') {
    if (!isSuperAdmin(req)) { json(res,403,{ok:false,error:'Brak uprawnień'}); return; }
    const b = await body(req);
    if (!b.login || !b.password) { json(res,400,{ok:false,error:'Brak loginu lub hasła'}); return; }
    if (appData.admins.length >= 2) { json(res,400,{ok:false,error:'Maksymalnie 2 administratorów'}); return; }
    if (findAdmin(b.login)) { json(res,400,{ok:false,error:'Login zajęty'}); return; }
    appData.admins.push({ login: b.login, password: b.password, role: 'admin', email: b.email||'', blocked: false });
    saveData();
    json(res,200,{ok:true}); return;
  }

  // POST /api/admins/change-password — change own password
  if (p==='/api/admins/change-password' && req.method==='POST') {
    if (!isAuthed(req)) { json(res,401,{ok:false}); return; }
    const b = await body(req);
    const me = getSessionAdmin(req);
    if (!me) { json(res,401,{ok:false}); return; }
    if (!b.oldPassword || !b.newPassword) { json(res,400,{ok:false,error:'Brak danych'}); return; }
    if (me.password !== b.oldPassword) { json(res,400,{ok:false,error:'Stare hasło nieprawidłowe'}); return; }
    if (b.newPassword.length < 4) { json(res,400,{ok:false,error:'Hasło min. 4 znaki'}); return; }
    me.password = b.newPassword;
    if (b.newLogin && b.newLogin !== me.login) {
      if (findAdmin(b.newLogin)) { json(res,400,{ok:false,error:'Login zajęty'}); return; }
      me.login = b.newLogin;
    }
    if (b.newEmail) me.email = b.newEmail;
    saveData();
    json(res,200,{ok:true}); return;
  }

  // POST /api/admins/delete — delete second admin (superadmin only)
  if (p==='/api/admins/delete' && req.method==='POST') {
    if (!isSuperAdmin(req)) { json(res,403,{ok:false,error:'Brak uprawnień'}); return; }
    const b = await body(req);
    const target = findAdmin(b.login);
    if (!target) { json(res,404,{ok:false,error:'Nie znaleziono'}); return; }
    if (target.role === 'superadmin') { json(res,400,{ok:false,error:'Nie można usunąć superadmina'}); return; }
    appData.admins = appData.admins.filter(a => a.login !== b.login);
    saveData();
    json(res,200,{ok:true}); return;
  }


  // ── PASSWORD RESET ───────────────────────────────────────────
  // POST /api/reset-request — send code to email
  if (p === '/api/reset-request' && req.method === 'POST') {
    const b = await body(req);
    const admin = appData.admins.find(a => a.email === b.email);
    if (!admin) {
      // Don't reveal if email exists
      json(res, 200, {ok: true, msg: 'Jeśli email istnieje, kod został wysłany'}); return;
    }
    const code = genCode();
    resetTokens.set(code, { login: admin.login, expires: Date.now() + 15*60*1000 });
    // Clean old tokens
    for (const [k, v] of resetTokens) {
      if (Date.now() > v.expires) resetTokens.delete(k);
    }
    sendViaSMTP(
      process.env.GMAIL_USER || 'grzesiek.bog2004@gmail.com',
      (process.env.GMAIL_APP_PASSWORD || 'kvgzhfthoiwysoan').replace(/\s/g,''),
      admin.email, code
    ).then(() => {
      console.log('[RESET] Code sent to', admin.email);
    }).catch(e => {
      console.error('[RESET] Email error:', e.message);
    });
    json(res, 200, {ok: true, msg: 'Kod wysłany na ' + admin.email.replace(/(.{3}).*(@.*)/, '$1***$2')}); return;
  }

  // POST /api/reset-verify — verify code and set new password
  if (p === '/api/reset-verify' && req.method === 'POST') {
    const b = await body(req);
    const entry = resetTokens.get(b.code);
    if (!entry || Date.now() > entry.expires) {
      json(res, 400, {ok: false, error: 'Kod nieprawidłowy lub wygasł'}); return;
    }
    if (!b.newPassword || b.newPassword.length < 4) {
      json(res, 400, {ok: false, error: 'Hasło min. 4 znaki'}); return;
    }
    const admin = findAdmin(entry.login);
    if (!admin) { json(res, 400, {ok: false, error: 'Błąd'}); return; }
    admin.password = b.newPassword;
    resetTokens.delete(b.code);
    saveData();
    json(res, 200, {ok: true, msg: 'Hasło zmienione — możesz się zalogować'}); return;
  }

  // POST /api/admins/block — block/unblock admin (superadmin only)
  if (p === '/api/admins/block' && req.method === 'POST') {
    if (!isSuperAdmin(req)) { json(res, 403, {ok: false, error: 'Brak uprawnień'}); return; }
    const b = await body(req);
    const target = findAdmin(b.login);
    if (!target) { json(res, 404, {ok: false, error: 'Nie znaleziono'}); return; }
    if (target.role === 'superadmin') { json(res, 400, {ok: false, error: 'Nie można zablokować superadmina'}); return; }
    target.blocked = !!b.blocked;
    saveData();
    // If blocking — kick active sessions
    if (target.blocked) {
      for (const [token, d] of sessions) {
        if (d.login === target.login) sessions.delete(token);
      }
      // Force system off and broadcast
      state.systemActive = false;
      state.judgeReady = false; state.tvReady = false; state.goSignalGiven = false;
      broadcast();
    }
    json(res, 200, {ok: true, blocked: target.blocked}); return;
  }

  // ── LOGIN / LOGOUT ───────────────────────────────────────────
  if (p === '/login' && req.method === 'GET') {
    fs.readFile(path.join(DIR, '/login.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {'Content-Type': 'text/html'}); res.end(data);
    }); return;
  }

  if (p === '/login' && req.method === 'POST') {
    body(req).then(b => {
      const admin = checkAuth(b.login, b.password);
      if (admin) {
        const token = genToken();
        sessions.set(token, { login: admin.login, lastActivity: Date.now() });
        res.writeHead(200, {
          'Set-Cookie': 'rr_session=' + token + '; Path=/; HttpOnly; SameSite=Strict',
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({ok:true, role: admin.role}));
      } else {
        res.writeHead(401, {'Content-Type': 'application/json'});
        res.end('{"ok":false,"error":"Błędny login lub hasło"}');
      }
    }); return;
  }

  if (p === '/logout' && req.method === 'POST') {
    const token = getCookie(req, 'rr_session');
    if (token) sessions.delete(token);
    // Wyłącz system przy wylogowaniu
    state.systemActive  = false;
    state.judgeReady    = false;
    state.tvReady       = false;
    state.goSignalGiven = false;
    broadcast();
    res.writeHead(200, {
      'Set-Cookie': 'rr_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'Content-Type': 'application/json'
    });
    res.end('{"ok":true}'); return;
  }


  // ── PWA FILES ────────────────────────────────────────────────
  if (p === '/sw.js') {
    fs.readFile(path.join(DIR, 'sw.js'), (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    }); return;
  }
  if (p.startsWith('/manifest-') && p.endsWith('.json')) {
    fs.readFile(path.join(DIR, p.slice(1)), (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': 'application/manifest+json',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    }); return;
  }

  // ── ADMIN GUARD ──────────────────────────────────────────────
  if (p === '/admin' && !isAuthed(req)) {
    res.writeHead(302, {'Location': '/login'}); res.end(); return;
  }

  // ── STATIC FILES ─────────────────────────────────────────────
  let file = p==='/' ? '/index.html' : p;
  if(p==='/info')     file='/info.html';
  if(p==='/judge')    file='/judge.html';
  if(p==='/tv')       file='/tv.html';
  if(p==='/operator') file='/operator.html';
  if(p==='/admin')    file='/admin.html';

  fs.readFile(path.join(DIR, file), (err,data) => {
    if(err){
      fs.readFile(path.join(DIR, '/404.html'), (e2,d2) => {
        res.writeHead(404, {'Content-Type':'text/html; charset=utf-8'});
        res.end(d2 || '<h1>404 Not Found</h1>');
      }); return;
    }
    const ct = MIME[path.extname(file)]||'text/plain';
    const headers = {'Content-Type': ct};
    if (ct.includes('text/html')) {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      headers['Pragma'] = 'no-cache';
    }
    // Gzip compression for text files
    const ae = req.headers['accept-encoding'] || '';
    const compressible = ct.includes('text/html') || ct.includes('javascript') || ct.includes('css') || ct.includes('json');
    if (compressible && ae.includes('gzip')) {
      zlib.gzip(data, (e, compressed) => {
        if (e) { res.writeHead(200, headers); res.end(data); return; }
        headers['Content-Encoding'] = 'gzip';
        headers['Vary'] = 'Accept-Encoding';
        res.writeHead(200, headers);
        res.end(compressed);
      });
    } else {
      res.writeHead(200, headers);
      res.end(data);
    }
  });

}).listen(PORT,'0.0.0.0',()=>{
  const ifaces=require('os').networkInterfaces();
  let ip='localhost';
  Object.values(ifaces).forEach(i=>i.forEach(d=>{if(d.family==='IPv4'&&!d.internal)ip=d.address;}));
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║      RACE READY SYSTEM — uruchomiony!               ║');
  console.log(`║  ADMIN:     http://${ip}:${PORT}/admin   ║`);
  console.log(`║  SEDZIA:    http://${ip}:${PORT}/judge   ║`);
  console.log(`║  TV:        http://${ip}:${PORT}/tv      ║`);
  console.log(`║  OPERATOR:  http://${ip}:${PORT}/operator║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');
});
