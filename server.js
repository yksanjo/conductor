#!/usr/bin/env node
'use strict';

// Conductor daemon — serves a live, glanceable web cockpit of your Claude Code sessions.
// Read-only. Zero dependencies (node:http only). The page polls /api/sessions and
// re-renders cards; click a card for full detail.
//
//   conductor-cockpit                 start on :7591, open browser, 60-min window
//   conductor-cockpit --port 8080
//   conductor-cockpit --no-open       don't auto-open the browser

const http = require('http');
const { exec } = require('child_process');
const { collectSessions } = require('./lib');

function parseArgs(argv) {
  const a = { port: parseInt(process.env.CONDUCTOR_PORT, 10) || 7591, open: true };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--port') a.port = parseInt(argv[++i], 10) || a.port;
    else if (v === '--no-open') a.open = false;
  }
  return a;
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>🎼 Conductor</title>
<style>
  :root {
    --bg:#0b0b11; --panel:#15151f; --panel2:#1c1c2a; --line:#2a2a3d;
    --txt:#ececf4; --mut:#8a8aa3; --dim:#5d5d75;
    --active:#36e07f; --recent:#4bd0c0; --idle:#f5b942;
    --accent:#b06cff; --accent2:#ff5cc8;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--txt);
    font:14px/1.45 ui-sans-serif,-apple-system,"SF Pro Text",Inter,system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;
    background-image:radial-gradient(1200px 600px at 80% -10%, rgba(176,108,255,.10), transparent),
                     radial-gradient(900px 500px at 0% 110%, rgba(255,92,200,.07), transparent);
    min-height:100vh;
  }
  header {
    display:flex; align-items:center; gap:16px; padding:18px 26px; position:sticky; top:0;
    backdrop-filter:blur(10px); background:rgba(11,11,17,.7); border-bottom:1px solid var(--line); z-index:10;
  }
  h1 { font-size:17px; margin:0; letter-spacing:.3px; font-weight:650; }
  h1 .g { background:linear-gradient(90deg,var(--accent),var(--accent2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .count { color:var(--mut); font-size:13px; }
  .spacer { flex:1; }
  .seg { display:flex; gap:2px; background:var(--panel); border:1px solid var(--line); border-radius:9px; padding:3px; }
  .seg button {
    border:0; background:transparent; color:var(--mut); font:inherit; font-size:12px; font-weight:600;
    padding:5px 11px; border-radius:6px; cursor:pointer;
  }
  .seg button.on { background:var(--panel2); color:var(--txt); }
  .pulse { width:7px; height:7px; border-radius:50%; background:var(--active); box-shadow:0 0 0 0 var(--active); animation:p 2s infinite; }
  @keyframes p { 0%{box-shadow:0 0 0 0 rgba(54,224,127,.5);} 70%{box-shadow:0 0 0 7px rgba(54,224,127,0);} 100%{box-shadow:0 0 0 0 rgba(54,224,127,0);} }
  main { padding:24px 26px 60px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:16px; }
  .card {
    background:linear-gradient(180deg,var(--panel),var(--panel2)); border:1px solid var(--line);
    border-radius:16px; padding:17px 17px 15px; cursor:pointer; position:relative; overflow:hidden;
    transition:transform .12s ease, border-color .12s ease, box-shadow .12s ease;
  }
  .card:hover { transform:translateY(-3px); border-color:#3a3a55; box-shadow:0 12px 30px rgba(0,0,0,.45); }
  .card .bar { position:absolute; left:0; top:0; bottom:0; width:3px; }
  .card.active .bar { background:var(--active); }
  .card.recent .bar { background:var(--recent); }
  .card.idle  .bar { background:var(--idle); opacity:.6; }
  .row1 { display:flex; align-items:center; gap:8px; margin-bottom:3px; }
  .dot { width:9px; height:9px; border-radius:50%; flex:none; }
  .active .dot { background:var(--active); box-shadow:0 0 8px var(--active); }
  .recent .dot { background:var(--recent); }
  .idle  .dot { background:var(--idle); }
  .label { font-size:17px; font-weight:680; letter-spacing:.2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .task { color:var(--mut); font-size:13px; min-height:18px; margin:2px 0 12px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .meta { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--dim); }
  .chip { background:#23233444; border:1px solid var(--line); border-radius:6px; padding:1px 7px; color:var(--mut); }
  .time { margin-left:auto; }
  .empty { color:var(--mut); text-align:center; padding:80px 0; }
  /* modal */
  .scrim { position:fixed; inset:0; background:rgba(5,5,9,.66); backdrop-filter:blur(3px); display:none; align-items:center; justify-content:center; z-index:50; }
  .scrim.show { display:flex; }
  .modal { width:min(640px,92vw); max-height:84vh; overflow:auto; background:var(--panel); border:1px solid var(--line); border-radius:18px; padding:24px; }
  .modal h2 { margin:0 0 2px; font-size:21px; }
  .modal .sub { color:var(--mut); font-size:13px; margin-bottom:18px; }
  .kv { margin:14px 0; }
  .kv .k { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.6px; margin-bottom:4px; }
  .kv .v { color:var(--txt); font-size:14px; word-break:break-word; }
  .timeline { border-left:2px solid var(--line); margin-left:4px; padding-left:16px; }
  .ev { margin:9px 0; font-size:13px; color:var(--mut); }
  .ev b { color:var(--txt); font-weight:600; }
  .close { float:right; cursor:pointer; color:var(--mut); font-size:20px; line-height:1; border:0; background:0; }
  .foot { color:var(--dim); font-size:11px; margin-top:22px; }
</style>
</head>
<body>
<header>
  <span class="pulse"></span>
  <h1>🎼 <span class="g">Conductor</span></h1>
  <span class="count" id="count"></span>
  <span class="spacer"></span>
  <div class="seg" id="seg">
    <button data-m="10">10m</button>
    <button data-m="60" class="on">1h</button>
    <button data-m="1440">1d</button>
    <button data-m="all">all</button>
  </div>
</header>
<main><div class="grid" id="grid"></div><div class="empty" id="empty" style="display:none"></div></main>

<div class="scrim" id="scrim"><div class="modal" id="modal"></div></div>

<script>
let WINDOW = '60';
let DATA = [];
let openId = null;

const esc = (s)=> (s==null?'':String(s)).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

async function load() {
  const q = WINDOW==='all' ? 'all=1' : 'minutes='+WINDOW;
  try {
    const r = await fetch('/api/sessions?'+q);
    const j = await r.json();
    DATA = j.sessions; render();
  } catch(e) { /* keep last render */ }
}

function render() {
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  document.getElementById('count').textContent = DATA.length ? DATA.length+' window'+(DATA.length>1?'s':'') : '';
  if (!DATA.length) {
    grid.innerHTML=''; empty.style.display='block';
    empty.textContent = 'No sessions in this window. Try a wider range.';
    return;
  }
  empty.style.display='none';
  grid.innerHTML = DATA.map(s => \`
    <div class="card \${s.status}" onclick="openCard('\${s.sessionId}')">
      <div class="bar"></div>
      <div class="row1"><span class="dot"></span><span class="label">\${esc(s.label)}</span></div>
      <div class="task">\${esc(s.task || s.intent || '—')}</div>
      <div class="meta">
        \${s.gitBranch ? '<span class="chip">'+esc(s.gitBranch)+'</span>' : ''}
        <span class="time">\${esc(s.lastActiveRel)}</span>
      </div>
    </div>\`).join('');
  if (openId) renderModal(); // keep detail fresh while open
}

function openCard(id){ openId=id; renderModal(); document.getElementById('scrim').classList.add('show'); }
function closeModal(){ openId=null; document.getElementById('scrim').classList.remove('show'); }

function renderModal(){
  const s = DATA.find(x=>x.sessionId===openId);
  if(!s){ closeModal(); return; }
  const evs = (s.recent||[]).slice().reverse().map(e=>{
    const who = e.role==='assistant' ? 'Claude' : 'you';
    return '<div class="ev"><b>'+who+'</b> · '+esc(e.summary)+'</div>';
  }).join('') || '<div class="ev">no recent events</div>';
  document.getElementById('modal').innerHTML = \`
    <button class="close" onclick="closeModal()">×</button>
    <h2>\${esc(s.label)}</h2>
    <div class="sub">\${esc(s.cwd||'')} \${s.gitBranch?' · '+esc(s.gitBranch):''} · \${esc(s.lastActiveRel)} · \${esc(s.status)}</div>
    <div class="kv"><div class="k">Goal</div><div class="v">\${esc(s.intent||s.task||'—')}</div></div>
    <div class="kv"><div class="k">Doing now</div><div class="v">\${esc(s.lastAction||'—')}</div></div>
    <div class="kv"><div class="k">Recent</div><div class="timeline">\${evs}</div></div>
    <div class="foot">session \${esc(s.shortId)} · read-only · this view never touches the window</div>\`;
}

document.getElementById('seg').addEventListener('click', e=>{
  const b=e.target.closest('button'); if(!b) return;
  document.querySelectorAll('#seg button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); WINDOW=b.dataset.m; load();
});
document.getElementById('scrim').addEventListener('click', e=>{ if(e.target.id==='scrim') closeModal(); });
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeModal(); });

load();
setInterval(load, 4000);
</script>
</body>
</html>`;

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/sessions') {
    const all = url.searchParams.get('all') === '1';
    const minutes = parseInt(url.searchParams.get('minutes'), 10) || 60;
    try {
      const rows = await collectSessions({ minutes, all });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ generatedAt: new Date().toISOString(), count: rows.length, sessions: rows }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

function main() {
  const args = parseArgs(process.argv);
  const server = http.createServer(handle);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`Port ${args.port} is busy. Conductor may already be running → http://localhost:${args.port}\nOr pick another: conductor-cockpit --port 8080`);
    } else { console.error('conductor server error:', e.message); }
    process.exit(1);
  });
  server.listen(args.port, '127.0.0.1', () => {
    const url = `http://localhost:${args.port}`;
    console.log(`🎼 Conductor cockpit → ${url}  (read-only; Ctrl+C to stop)`);
    if (args.open && process.platform === 'darwin') exec(`open ${url}`);
    else if (args.open && process.platform === 'linux') exec(`xdg-open ${url}`);
  });
}

main();
