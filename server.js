const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT = process.env.PORT || 8080;

let state = {
  eventName:    'Garmin Winter Festival',
  logoBase64:   '',
  riderMode:    1,
  timerEnabled: false,
  systemActive: false,
  judgeReady:   false,
  tvReady:      false,
  goSignalGiven:false,
  currentRider1:'',
  currentRider2:'',
  nextRider1:   '',
  nextRider2:   '',
  runCurrent:   0,
  runTotal:     0,
  timerRunning: false,
  timerStart:   null,
  timerElapsed: 0,
  adminMessage: '',
  history:      [],
  _autoReset:   null,
};

let clients = [];

function pub() {
  return {
    eventName:    state.eventName,
    logoBase64:   state.logoBase64,
    riderMode:    state.riderMode,
    timerEnabled: state.timerEnabled,
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
  state.timerRunning  = false;
  state.timerStart    = null;
  state.timerElapsed  = 0;
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

const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};

// FILES ARE IN SAME DIRECTORY AS server.js (no public subfolder)
const DIR = __dirname;

http.createServer(async (req, res) => {
  const p = url.parse(req.url).pathname;
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return; }

  if (p==='/events') {
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
    res.write('data: '+JSON.stringify(pub())+'\n\n');
    clients.push(res);
    // Heartbeat every 25s to keep Railway connection alive
    const hb = setInterval(() => { try { res.write(':ping\n\n'); } catch(e){} }, 25000);
    req.on('close',()=>{ clearInterval(hb); clients=clients.filter(c=>c!==res); });
    return;
  }

  if (!state.systemActive && ['/api/judge','/api/tv','/api/go','/api/riders'].includes(p)) {
    res.writeHead(403,{'Content-Type':'application/json'}); res.end('{"ok":false,"reason":"System offline"}'); return;
  }

  if (p==='/api/state') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(pub())); return; }

  if (p==='/api/judge' && req.method==='POST') {
    state.judgeReady=!state.judgeReady;
    if(!state.judgeReady) state.goSignalGiven=false;
    autoReset(); broadcast();
    res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); return;
  }

  if (p==='/api/tv' && req.method==='POST') {
    state.tvReady=!state.tvReady;
    if(!state.tvReady) state.goSignalGiven=false;
    autoReset(); broadcast();
    res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); return;
  }

  if (p==='/api/go' && req.method==='POST') {
    if (state.judgeReady && state.tvReady) {
      state.goSignalGiven=true;
      if(state._autoReset) clearTimeout(state._autoReset);
      if(state.runCurrent>0) state.runCurrent++;
      if(state.timerEnabled){ state.timerRunning=true; state.timerStart=Date.now(); state.timerElapsed=0; }
      state.history.unshift({time:new Date().toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit',second:'2-digit'}),rider1:state.currentRider1,rider2:state.currentRider2,run:state.runCurrent});
      if(state.history.length>20) state.history.pop();
      broadcast();
      state._autoReset=setTimeout(()=>{ resetRound(); broadcast(); },5000);
    }
    res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); return;
  }

  if (p==='/api/reset' && req.method==='POST') {
    resetRound(); broadcast();
    res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); return;
  }

  if (p==='/api/admin' && req.method==='POST') {
    const b=await body(req);
    if(b.eventName!==undefined)    state.eventName=b.eventName;
    if(b.logoBase64!==undefined)   state.logoBase64=b.logoBase64;
    if(b.riderMode!==undefined)    state.riderMode=parseInt(b.riderMode)||1;
    if(b.runTotal!==undefined)     state.runTotal=parseInt(b.runTotal)||0;
    if(b.runCurrent!==undefined)   state.runCurrent=parseInt(b.runCurrent)||0;
    if(b.adminMessage!==undefined) state.adminMessage=b.adminMessage;
    if(b.timerEnabled!==undefined)  state.timerEnabled=!!b.timerEnabled;
    if(b.systemActive!==undefined)  { state.systemActive=!!b.systemActive; if(!state.systemActive){ state.judgeReady=false; state.tvReady=false; state.goSignalGiven=false; } }
    broadcast();
    res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); return;
  }

  if (p==='/api/riders' && req.method==='POST') {
    const b=await body(req);
    if(b.currentRider1!==undefined) state.currentRider1=b.currentRider1;
    if(b.currentRider2!==undefined) state.currentRider2=b.currentRider2;
    if(b.nextRider1!==undefined)    state.nextRider1=b.nextRider1;
    if(b.nextRider2!==undefined)    state.nextRider2=b.nextRider2;
    broadcast();
    res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); return;
  }

  // Static files — all in same DIR as server.js
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
