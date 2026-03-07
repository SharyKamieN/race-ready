const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

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
    admins: [{ login: 'admin', password: 'ledcity1063', role: 'superadmin' }],
    profiles: []
  };
}

function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(appData, null, 2)); } catch(e) {}
}

let appData = loadData();

// Helper: find admin by login
function findAdmin(login) {
  return appData.admins.find(a => a.login === login);
}
function checkAuth(login, password) {
  const a = findAdmin(login);
  return a && a.password === password ? a : null;
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
    appData.admins.push({ login: b.login, password: b.password, role: 'admin' });
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
    res.writeHead(200, {
      'Set-Cookie': 'rr_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'Content-Type': 'application/json'
    });
    res.end('{"ok":true}'); return;
  }

  // ── ADMIN GUARD ──────────────────────────────────────────────
  if (p === '/admin' && !isAuthed(req)) {
    res.writeHead(302, {'Location': '/login'}); res.end(); return;
  }

  // ── STATIC FILES ─────────────────────────────────────────────
  let file = p==='/' ? '/index.html' : p;
  if(p==='/judge')    file='/judge.html';
  if(p==='/tv')       file='/tv.html';
  if(p==='/operator') file='/operator.html';
  if(p==='/admin')    file='/admin.html';

  fs.readFile(path.join(DIR, file), (err,data) => {
    if(err){ res.writeHead(404); res.end('Not found: '+file); return; }
    res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'text/plain'});
    res.end(data);
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
