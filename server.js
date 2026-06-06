#!/usr/bin/env node
'use strict';

// Conductor daemon — serves a live, glanceable web cockpit of your Claude Code sessions.
// Zero dependencies (node:http only). The page polls /api/sessions and re-renders only when
// the data changes; click a card to pop that session up as a clean CLI window, or use the
// reply controls to steer it.
//
//   conductor-cockpit                 start on :7591, open browser, 60-min window
//   conductor-cockpit --port 8080
//   conductor-cockpit --no-open       don't auto-open the browser

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { collectSessions } = require('./lib');
const engine = require('./engine');
const manage = require('./manage');

let MANUAL = '<!doctype html><title>Conductor manual</title><body style="font:14px sans-serif;padding:40px">Manual not found.</body>';
try { MANUAL = fs.readFileSync(path.join(__dirname, 'docs', 'manual.html'), 'utf8'); } catch { /* ignore */ }

function parseArgs(argv) {
  const a = { port: parseInt(process.env.CONDUCTOR_PORT, 10) || 7591, open: true, adapter: 'claude-code' };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--port') a.port = parseInt(argv[++i], 10) || a.port;
    else if (v === '--no-open') a.open = false;
    else if (v === '--adapter') a.adapter = String(argv[++i] || 'claude-code');
  }
  return a;
}

// The adapter this cockpit serves (set at boot from --adapter). claude-code keeps its rich
// tmux control plane + existing endpoints; other adapters (e.g. fleet) route through the generic
// engine + adapter.control. Validated against the same whitelist the engine uses.
let ADAPTER_NAME = 'claude-code';
function activeAdapter() {
  try { return engine.loadAdapter(ADAPTER_NAME); } catch { ADAPTER_NAME = 'claude-code'; return engine.loadAdapter('claude-code'); }
}
function colorHex(name) {
  return ({ green: '#3ee07f', cyan: '#46d8c6', amber: '#f5b13f', red: '#ff5a6a', dim: '#6a6a85' })[name] || '#6a6a85';
}
function adapterMeta() {
  const a = activeAdapter();
  const statuses = (a.statuses || engine.DEFAULT_STATUSES).map((s) => ({ key: s.key, title: s.title, word: s.word, color: colorHex(s.color) }));
  const capabilities = (a.control && a.control.capabilities) || [];
  return { adapter: ADAPTER_NAME, statuses, capabilities };
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conductor</title>
<style>
  :root {
    --bg:#08080b; --bg2:#0b0b10;
    --line:rgba(255,255,255,.06); --line2:rgba(255,255,255,.12);
    --txt:#f3f3f8; --mut:#9696ab; --dim:#5c5c72;
    --active:#3ee07f; --open:#46d8c6; --recent:#f5b13f; --idle:#6a6a85;
    --accent:#a974ff; --accent2:#ff5cc8;
    --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;
    --sans:ui-sans-serif,-apple-system,"SF Pro Text",Inter,system-ui,sans-serif;
  }
  * { box-sizing:border-box; }
  html { color-scheme:dark; }
  body {
    margin:0; background:var(--bg); color:var(--txt);
    font:13.5px/1.5 var(--sans); -webkit-font-smoothing:antialiased; letter-spacing:.1px;
    min-height:100vh;
    background-image:
      radial-gradient(900px 480px at 88% -8%, rgba(169,116,255,.10), transparent 70%),
      radial-gradient(760px 420px at -4% 108%, rgba(255,92,200,.06), transparent 70%);
  }
  ::selection { background:rgba(169,116,255,.3); }
  /* scrollbar */
  ::-webkit-scrollbar { width:10px; height:10px; }
  ::-webkit-scrollbar-thumb { background:#23232f; border-radius:6px; border:2px solid var(--bg); }

  header {
    display:flex; align-items:center; gap:14px; padding:13px 24px; position:sticky; top:0; z-index:20;
    background:rgba(8,8,11,.72); backdrop-filter:blur(14px) saturate(1.2);
    border-bottom:1px solid var(--line);
  }
  .brand { display:flex; align-items:center; gap:9px; font-size:14.5px; font-weight:640; letter-spacing:.2px; }
  .brand .mk { background:linear-gradient(92deg,var(--accent),var(--accent2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .brand .ck { color:var(--mut); font-weight:500; letter-spacing:1px; }
  .live { width:7px; height:7px; border-radius:50%; background:var(--active); box-shadow:0 0 0 0 var(--active); animation:pulse 2.4s infinite; }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(62,224,127,.45);} 70%{box-shadow:0 0 0 8px rgba(62,224,127,0);} 100%{box-shadow:0 0 0 0 rgba(62,224,127,0);} }
  .count { color:var(--mut); font-size:12.5px; font-variant-numeric:tabular-nums; }
  .spacer { flex:1; }
  .legend { display:flex; gap:14px; font-size:11px; color:var(--mut); }
  .legend i { width:7px; height:7px; border-radius:50%; display:inline-block; margin-right:5px; vertical-align:middle; }
  .seg { display:flex; gap:1px; background:rgba(255,255,255,.04); border:1px solid var(--line); border-radius:9px; padding:2px; }
  .seg button { border:0; background:transparent; color:var(--mut); font:inherit; font-size:11.5px; font-weight:600; padding:5px 11px; border-radius:7px; cursor:pointer; transition:.12s; }
  .seg button:hover { color:var(--txt); }
  .seg button.on { background:rgba(255,255,255,.09); color:var(--txt); box-shadow:0 1px 2px rgba(0,0,0,.3); }
  .newbtn { font:inherit; font-size:12px; font-weight:650; color:var(--txt); background:linear-gradient(92deg,var(--accent),var(--accent2)); border:0; border-radius:9px; padding:7px 13px; cursor:pointer; transition:.12s; }
  .newbtn:hover { filter:brightness(1.1); }
  .manbtn { text-decoration:none; font-size:15px; line-height:1; padding:7px 9px; border:1px solid var(--line); border-radius:9px; background:rgba(255,255,255,.04); cursor:pointer; }
  .manbtn:hover { border-color:var(--line2); }
  .modal .qin { width:100%; }

  main { padding:14px 24px 64px; max-width:1500px; margin:0 auto; }
  .section-head { display:flex; align-items:center; gap:12px; margin:28px 2px 14px; }
  .section-head:first-child { margin-top:10px; }
  .section-head .sdot { width:7px; height:7px; border-radius:50%; flex:none; box-shadow:0 0 8px currentColor; }
  .section-head .stitle { font-size:10.5px; font-weight:750; letter-spacing:1.6px; text-transform:uppercase; color:var(--mut); white-space:nowrap; }
  .section-head .rule { flex:1; height:1px; background:linear-gradient(90deg,var(--line2),transparent); }
  .section-head .scount { font-size:11px; color:var(--dim); font-variant-numeric:tabular-nums; flex:none; }

  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(248px,1fr)); gap:14px; }
  .card {
    --c:var(--mut);
    background:linear-gradient(165deg,rgba(255,255,255,.035),rgba(255,255,255,.012));
    border:1px solid var(--line); border-radius:15px; padding:15px 16px 14px; cursor:pointer;
    position:relative; isolation:isolate; transition:transform .14s ease, border-color .14s ease, box-shadow .14s ease;
  }
  .card::before {
    content:''; position:absolute; inset:0; border-radius:inherit; padding:1px; pointer-events:none; opacity:0; transition:opacity .14s;
    background:linear-gradient(165deg,var(--c),transparent 55%);
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    -webkit-mask-composite:xor; mask-composite:exclude;
  }
  .card:hover { transform:translateY(-2px); box-shadow:0 14px 34px rgba(0,0,0,.5), 0 0 0 1px var(--line2); }
  .card:hover::before { opacity:.55; }
  .card.idle { opacity:.66; }
  .card.idle:hover { opacity:1; }

  .ctop { display:flex; align-items:center; gap:8px; margin-bottom:9px; }
  .pill { display:inline-flex; align-items:center; gap:6px; font-size:10.5px; font-weight:650; letter-spacing:.4px; text-transform:uppercase; color:var(--c); background:color-mix(in srgb,var(--c) 13%,transparent); border:1px solid color-mix(in srgb,var(--c) 26%,transparent); padding:3px 8px; border-radius:999px; }
  .pill i { width:6px; height:6px; border-radius:50%; background:var(--c); }
  .pill.active i { box-shadow:0 0 7px var(--c); }
  .time { margin-left:auto; font-size:11px; color:var(--dim); font-variant-numeric:tabular-nums; white-space:nowrap; }

  .label { font-size:15.5px; font-weight:660; letter-spacing:.1px; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .task { color:var(--mut); font-size:12.5px; line-height:1.45; margin:5px 0 13px; min-height:18px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .cfoot { display:flex; align-items:center; gap:7px; }
  .chip { font-family:var(--mono); font-size:10.5px; color:var(--mut); background:rgba(255,255,255,.05); border:1px solid var(--line); border-radius:6px; padding:2px 7px; }
  .mbadge { font-size:9px; font-weight:750; letter-spacing:.7px; text-transform:uppercase; color:var(--accent); background:rgba(169,116,255,.12); border:1px solid rgba(169,116,255,.3); border-radius:999px; padding:2px 7px; }
  .bopen { font:inherit; font-size:10.5px; font-weight:650; color:var(--open); background:rgba(70,216,198,.1); border:1px solid rgba(70,216,198,.32); border-radius:7px; padding:2px 8px; cursor:pointer; transition:.12s; }
  .bopen:hover { background:rgba(70,216,198,.22); }
  /* tiny ✕ at the card's top-middle — hidden until card hover so it stays unobtrusive */
  .xclose { position:absolute; top:6px; left:50%; transform:translateX(-50%); z-index:3; width:18px; height:18px; padding:0; line-height:16px; text-align:center; font-size:11px; font-weight:700; color:var(--mut); background:rgba(255,255,255,.04); border:1px solid var(--line); border-radius:50%; cursor:pointer; opacity:0; transition:.12s; }
  .card:hover .xclose { opacity:.55; }
  .xclose:hover { opacity:1; color:#ff8a96; background:rgba(255,90,106,.18); border-color:#ff5a6a; }

  .ctrl { margin-top:12px; padding-top:12px; border-top:1px dashed var(--line); }
  .qbtns { display:flex; flex-wrap:wrap; gap:5px; margin-bottom:7px; }
  .qb { font:inherit; font-size:11px; font-weight:600; color:var(--txt); background:rgba(255,255,255,.05); border:1px solid var(--line2); border-radius:7px; padding:4px 9px; cursor:pointer; transition:.12s; }
  .qb:hover { background:rgba(169,116,255,.18); border-color:var(--accent); }
  .qb.danger { color:#ff8a96; border-color:rgba(255,90,106,.4); }
  .qb.danger:hover { background:rgba(255,90,106,.18); border-color:#ff5a6a; }
  .bcast.fleet { background:linear-gradient(120deg,rgba(255,90,106,.12),rgba(245,177,63,.06)); border-color:rgba(255,90,106,.32); }
  .bcast.fleet .blabel b, .bcast.fleet .blabel { color:#ff8a96; }
  .qrow { display:flex; gap:5px; }
  .qin { flex:1; min-width:0; font:inherit; font-size:11.5px; color:var(--txt); background:rgba(0,0,0,.25); border:1px solid var(--line); border-radius:7px; padding:5px 9px; }
  .qin:focus { outline:none; border-color:var(--accent); }
  .qin::placeholder { color:var(--dim); }
  .qsend { font:inherit; color:var(--txt); background:rgba(169,116,255,.18); border:1px solid var(--accent); border-radius:7px; padding:5px 11px; cursor:pointer; }
  .qsend:hover { background:rgba(169,116,255,.3); }
  .toast { position:fixed; bottom:22px; left:50%; transform:translateX(-50%); background:#15151f; border:1px solid var(--line2); color:var(--txt); font-size:12.5px; padding:9px 16px; border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,.5); opacity:0; transition:opacity .2s; pointer-events:none; z-index:80; }
  .toast.show { opacity:1; }

  /* broadcast bar */
  .bcast { display:flex; align-items:center; gap:9px; flex-wrap:wrap; margin:18px 0 4px; padding:12px 14px;
    background:linear-gradient(120deg,rgba(169,116,255,.10),rgba(255,92,200,.06)); border:1px solid rgba(169,116,255,.28); border-radius:13px; }
  .bcast .blabel { font-size:12px; font-weight:700; letter-spacing:.3px; color:var(--txt); margin-right:2px; }
  .bcast .blabel b { color:var(--accent); }
  .bcast .bbtns { display:flex; flex-wrap:wrap; gap:5px; }
  .bcast .qin { flex:1; min-width:160px; }

  .card.active { --c:var(--active); } .card.open { --c:var(--open); }
  .card.recent { --c:var(--recent); } .card.idle { --c:var(--idle); }

  .empty { color:var(--mut); text-align:center; padding:90px 0; font-size:13px; }

  /* modal */
  .scrim { position:fixed; inset:0; background:rgba(4,4,7,.72); backdrop-filter:blur(5px); display:none; align-items:center; justify-content:center; z-index:60; padding:24px; }
  .scrim.show { display:flex; animation:fade .14s ease; }
  @keyframes fade { from{opacity:0;} to{opacity:1;} }
  .modal { width:min(660px,100%); max-height:86vh; overflow:auto; background:linear-gradient(180deg,#13131b,#0e0e14); border:1px solid var(--line2); border-radius:20px; padding:26px 28px; box-shadow:0 30px 80px rgba(0,0,0,.6); }
  .modal h2 { margin:0 0 3px; font-size:22px; font-weight:680; letter-spacing:.2px; }
  .modal .sub { color:var(--dim); font-size:12px; font-family:var(--mono); margin-bottom:20px; word-break:break-all; }
  .kv { margin:15px 0; }
  .kv .k { color:var(--dim); font-size:10px; text-transform:uppercase; letter-spacing:1px; margin-bottom:5px; font-weight:700; }
  .kv .v { color:var(--txt); font-size:13.5px; word-break:break-word; line-height:1.5; }
  .timeline { display:flex; flex-direction:column; gap:9px; margin-top:4px; }
  .ev { display:flex; gap:9px; font-size:12.5px; color:var(--mut); line-height:1.4; }
  .ev .who { font-family:var(--mono); font-size:10px; color:var(--dim); text-transform:uppercase; letter-spacing:.5px; flex:none; width:46px; padding-top:1px; }
  .ev .what { word-break:break-word; }
  .close { float:right; cursor:pointer; color:var(--mut); font-size:22px; line-height:1; border:0; background:0; transition:color .12s; }
  .close:hover { color:var(--txt); }
  .foot { color:var(--dim); font-size:11px; font-family:var(--mono); margin-top:24px; padding-top:16px; border-top:1px solid var(--line); }
</style>
</head>
<body>
<header>
  <span class="live"></span>
  <span class="brand">🎼 <span class="mk">Conductor</span> <span class="ck">Cockpit</span></span>
  <span class="count" id="count"></span>
  <span class="spacer"></span>
  <div class="legend">
    <span><i style="background:#3ee07f"></i>working</span>
    <span><i style="background:#46d8c6"></i>open</span>
    <span><i style="background:#f5b13f"></i>recent</span>
  </div>
  <div class="seg" id="seg">
    <button data-m="10">10m</button>
    <button data-m="60" class="on">1h</button>
    <button data-m="1440">1d</button>
    <button data-m="all">all</button>
  </div>
  <button class="newbtn" id="newbtn">+ New window</button>
  <a class="manbtn" href="/manual" target="_blank" title="Quick manual">📖</a>
</header>
<main>
  <div class="bcast" id="bcast" style="display:none">
    <span class="blabel">⚡ Prompt all managed <b id="bcount">0</b></span>
    <div class="bbtns" id="bbtns"></div>
    <input class="qin" id="binput" placeholder="message all managed windows…">
    <button class="qsend" id="bsend">↵</button>
  </div>
  <div id="board"></div>
  <div class="empty" id="empty" style="display:none"></div>
</main>

<div class="scrim" id="scrim"><div class="modal" id="modal"></div></div>
<div class="toast" id="toast"></div>

<script>
const ADAPTER = '__ADAPTER__';
let META = __META__;                 // { adapter, statuses:[{key,title,word,color}], capabilities }
let WINDOW = '60';
let DATA = [];
let lastHash = '';

const esc = (s)=> (s==null?'':String(s)).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function statusMeta(k){ return (META.statuses||[]).find(s=>s.key===k) || { key:k, title:k, word:k, color:'#6a6a85' }; }
function statusLabel(k){ return statusMeta(k).word; }
function sections(){ return (META.statuses||[]).map(s=>({ k:s.key, t:s.title, c:s.color })); }

function typingNow() {
  const a = document.activeElement;
  return a && a.classList && a.classList.contains('qin');
}
async function load() {
  const q = WINDOW==='all' ? 'all=1' : 'minutes='+WINDOW;
  try {
    const r = await fetch('/api/sessions?adapter='+encodeURIComponent(ADAPTER)+'&'+q);
    const j = await r.json();
    DATA = j.sessions;
    if (j.statuses) META = { adapter:j.adapter, statuses:j.statuses, capabilities:j.capabilities };
    // Structure = which windows / status / managed. Time + last-action churn every few
    // seconds but DON'T change structure, so we update those in place and never rebuild the
    // DOM (which would wipe a reply you're typing). Only a real structural change rebuilds —
    // and even then we defer while you're typing.
    const structure = WINDOW + '|' + JSON.stringify(DATA.map(s=>[s.id||s.sessionId,s.status,s.managed]));
    if (structure !== lastHash && !typingNow()) { lastHash = structure; render(); }
    else updateInPlace();
  } catch(e) { /* keep last render */ }
}

function updateInPlace() {
  const unit = ADAPTER==='claude-code' ? 'window' : 'bot';
  document.getElementById('count').textContent = DATA.length ? DATA.length+' '+unit+(DATA.length>1?'s':'') : '';
  const bc = document.getElementById('bcount'); if (bc) bc.textContent = DATA.filter(s=>s.managed).length;
  for (const s of DATA) {
    const card = document.querySelector('.card[data-id="'+(s.id||s.sessionId)+'"]');
    if (!card) continue;
    const t = card.querySelector('.time'); if (t && t.textContent !== s.lastActiveRel) t.textContent = s.lastActiveRel;
    const tk = card.querySelector('.task'); const v = s.lastAction || s.intent || '—';
    if (tk && tk.textContent !== v) tk.textContent = v;
  }
}

const QUICK = [
  ['Yes','yes'], ['No','no'], ['Continue','continue'],
  ['Review','review what you just did and report back'],
  ['Re-iterate','re-iterate and improve it'],
  ['Test+deploy','review and test it before deploying'],
];

function ctrlHTML(s) {
  // Managed windows send directly (data-label). Plain windows adopt-then-send (data-session).
  const attr = s.managed ? 'data-label="'+esc(s.mlabel)+'"' : 'data-session="'+esc(s.sessionId)+'"';
  const ph = s.managed ? 'reply to '+esc(s.mlabel)+'…' : 'reply — adopts this window…';
  const btns = QUICK.map(q => '<button class="qb" '+attr+' data-text="'+esc(q[1])+'">'+q[0]+'</button>').join('');
  return '<div class="ctrl"><div class="qbtns">'+btns+'</div>'
       + '<div class="qrow"><input class="qin" '+attr+' placeholder="'+ph+'">'
       + '<button class="qsend" '+attr+'>↵</button></div></div>';
}

function cardHTML(s) {
  return ADAPTER === 'claude-code' ? claudeCard(s) : fleetCard(s);
}
function claudeCard(s) {
  const sm = statusMeta(s.status);
  return \`<div class="card \${s.status}" data-id="\${s.sessionId}" style="--c:\${sm.color}">
      \${s.managed ? '<button class="xclose" data-close="'+esc(s.mlabel)+'" title="Close this window (kills its tmux session — irreversible)">✕</button>' : ''}
      <div class="ctop">
        <span class="pill \${s.status}" style="--c:\${sm.color}"><i></i>\${statusLabel(s.status)}</span>
        \${s.managed ? '<span class="mbadge">managed</span>' : ''}
        <span class="time">\${esc(s.lastActiveRel)}</span>
      </div>
      <div class="label">\${esc(s.title || s.label)}</div>
      <div class="task">\${esc(s.lastAction || s.intent || '—')}</div>
      <div class="cfoot">\${s.place ? '<span class="chip">'+esc(s.place)+'</span>' : ''}\${s.gitBranch ? '<span class="chip">'+esc(s.gitBranch)+'</span>' : ''}\${s.managed ? '<span class="mbadge">managed</span><button class="bopen" data-open="'+esc(s.mlabel)+'" title="Open this window in Terminal">↗ open</button>' : ''}</div>
      \${ctrlHTML(s)}
    </div>\`;
}
// Fleet card: read-only observation + opt-in per-bot control (pause/resume/flatten). Flatten is
// destructive → double-confirmed in fleetControl().
function fleetCard(s) {
  const sm = statusMeta(s.status);
  const chips = (s.context||[]).map(c=>'<span class="chip">'+esc(c)+'</span>').join('');
  const caps = META.capabilities || [];
  const btn = (cmd,label,cls)=> caps.includes(cmd) ? '<button class="qb '+(cls||'')+'" data-bot="'+esc(s.id)+'" data-cmd="'+cmd+'">'+label+'</button>' : '';
  return \`<div class="card \${s.status}" data-id="\${esc(s.id)}" style="--c:\${sm.color}">
      <div class="ctop">
        <span class="pill" style="--c:\${sm.color}"><i></i>\${statusLabel(s.status)}</span>
        <span class="time">\${esc(s.lastActiveRel)}</span>
      </div>
      <div class="label">\${esc(s.title || s.label)}</div>
      <div class="task">\${esc(s.lastAction || s.intent || '—')}</div>
      <div class="cfoot">\${chips}</div>
      <div class="ctrl"><div class="qbtns">\${btn('pause','⏸ Pause')}\${btn('resume','▶ Resume')}\${btn('flatten','🛑 Flatten','danger')}</div></div>
    </div>\`;
}

let toastT;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(()=>t.classList.remove('show'), 2200);
}
async function reply(label, text) {
  if (!text || !text.trim()) return;
  try {
    const r = await fetch('/api/say', { method:'POST', headers:{'content-type':'application/json','x-conductor':'1'}, body:JSON.stringify({label, text}) });
    const j = await r.json();
    toast(j.ok ? '→ sent “'+text+'” to '+label : 'send failed: '+(j.error||'?'));
  } catch(e) { toast('send failed'); }
}
async function replyAll(text) {
  if (!text || !text.trim()) return;
  try {
    const r = await fetch('/api/say-all', { method:'POST', headers:{'content-type':'application/json','x-conductor':'1'}, body:JSON.stringify({text}) });
    const j = await r.json();
    toast(j.ok ? '⚡ sent “'+text+'” to '+j.sent+' window'+(j.sent===1?'':'s') : 'broadcast failed');
  } catch(e) { toast('broadcast failed'); }
}
// reply to a plain (unmanaged) window: adopt it into tmux, then deliver the message there
async function replyAdopt(sessionId, text) {
  if (!text || !text.trim()) return;
  toast('adopting window + sending “'+text+'”…');
  try {
    const r = await fetch('/api/adopt-say', { method:'POST', headers:{'content-type':'application/json','x-conductor':'1'}, body:JSON.stringify({session:sessionId, text}) });
    const j = await r.json();
    toast(j.ok ? '✓ “'+j.label+'” adopted — reply goes to the managed copy; close the original tab' : 'failed: '+(j.error||'?'));
    lastHash=''; load();
  } catch(e) { toast('failed'); }
}
async function openTerm(label) {
  toast('opening “'+label+'” in Terminal…');
  try {
    const r = await fetch('/api/open', { method:'POST', headers:{'content-type':'application/json','x-conductor':'1'}, body:JSON.stringify({label}) });
    const j = await r.json();
    toast(j.ok ? (j.attached ? '↗ brought Terminal to front · '+label : '↗ opened “'+label+'” in a new Terminal') : 'open failed: '+(j.error||'?'));
  } catch(e) { toast('open failed'); }
}
// Close a managed window — kills its tmux session, so the live session's state is gone for
// good. Double-confirm in the browser, then send the label as a confirm token (the endpoint
// rejects without it). Only managed windows expose this button; plain windows live in your own
// terminal tabs and must be closed there.
async function closeWindow(label) {
  if (!confirm('Close “'+label+'”?\\n\\nThis kills its tmux session — the live Claude session and its state are lost. This cannot be undone.')) return;
  toast('closing “'+label+'”…');
  try {
    const r = await fetch('/api/stop', { method:'POST', headers:{'content-type':'application/json','x-conductor':'1'}, body:JSON.stringify({label, confirm:label}) });
    const j = await r.json();
    toast(j.ok ? '✕ closed “'+label+'”' : 'close failed: '+(j.error||'?'));
    if (j.ok) { lastHash=''; load(); }
  } catch(e) { toast('close failed'); }
}
// Click a card → bring its live CLI to the front. Managed windows already live in tmux, so we
// just surface the terminal. A plain (unmanaged) window has no terminal handle we can focus, so
// we adopt it (fork into tmux) — that gives you a real CLI for it — then open that. No more
// read-only dialog: a click means "show me this session in a terminal".
async function openCLI(id) {
  const s = DATA.find(x=>x.sessionId===id);
  if (!s) return;
  if (s.managed) { openTerm(s.mlabel); return; }
  toast('opening CLI — adopting this window…');
  try {
    const r = await fetch('/api/adopt', { method:'POST', headers:{'content-type':'application/json','x-conductor':'1'}, body:JSON.stringify({session:id}) });
    const j = await r.json();
    if (j.ok) { openTerm(j.label); lastHash=''; load(); }
    else toast('open failed: '+(j.error||'?'));
  } catch(e) { toast('open failed'); }
}
// --- fleet control: per-bot pause/resume/flatten + desk-wide flatten ----------------------
async function fleetControl(bot, cmd) {
  let confirmTok;
  if (cmd === 'flatten') {
    if (!confirm('Flatten '+bot+'? This sends a market-flatten command to that bot.')) return;
    confirmTok = 'flatten';
  }
  try {
    const r = await fetch('/api/control', { method:'POST', headers:{'content-type':'application/json','x-conductor':'1'},
      body:JSON.stringify({ adapter:ADAPTER, target:bot, command:{cmd}, confirm:confirmTok }) });
    const j = await r.json();
    toast(j.ok ? '→ '+cmd+' → '+bot : (cmd+' failed: '+(j.error||'?')));
  } catch(e) { toast(cmd+' failed'); }
}
async function deskFlatten() {
  // destructive + desk-wide → double confirm, then a confirm token
  if (!confirm('⚠ FLATTEN THE ENTIRE DESK?\\nEvery bot gets a market-flatten command.')) return;
  if (!confirm('Are you absolutely sure? This affects ALL bots.')) return;
  try {
    const r = await fetch('/api/broadcast', { method:'POST', headers:{'content-type':'application/json','x-conductor':'1'},
      body:JSON.stringify({ adapter:ADAPTER, command:{cmd:'flatten'}, confirm:'flatten' }) });
    const j = await r.json();
    toast(j.ok ? '🛑 flatten sent to '+j.sent+'/'+j.total+' bots' : 'flatten failed: '+(j.error||'?'));
  } catch(e) { toast('flatten failed'); }
}

// Adapt the header + broadcast bar to the active adapter. Claude keeps its "prompt all managed"
// bar + New-window button; fleet replaces them with a desk-wide panic-flatten band.
function setupChrome() {
  const ck = document.querySelector('.ck'); if (ck) ck.textContent = ADAPTER==='claude-code' ? 'Cockpit' : 'Fleet';
  const legend = document.querySelector('.legend');
  if (legend) legend.innerHTML = (META.statuses||[]).filter(s=>s.key!=='idle')
    .map(s=>'<span><i style="background:'+s.color+'"></i>'+esc(s.word)+'</span>').join('');
  if (ADAPTER !== 'claude-code') {
    const nb = document.getElementById('newbtn'); if (nb) nb.style.display='none';
    const bc = document.getElementById('bcast');
    bc.classList.add('fleet');
    bc.innerHTML = '<span class="blabel">🛑 Desk-wide</span>'
      + '<div class="bbtns"><button class="qb danger" id="flattenAll">Flatten all bots</button></div>'
      + '<span style="color:var(--dim);font-size:11px">read-only observation · opt-in control</span>';
    bc.style.display = 'flex';
    document.getElementById('flattenAll').addEventListener('click', deskFlatten);
  } else {
    // build claude broadcast quick-buttons once
    document.getElementById('bbtns').innerHTML = QUICK.map(q => '<button class="qb" data-all="'+esc(q[1])+'">'+q[0]+'</button>').join('');
  }
}
setupChrome();

function openLauncher() {
  document.getElementById('modal').innerHTML = \`
    <button class="close" onclick="closeModal()">×</button>
    <h2>New managed window</h2>
    <div class="sub">launches Claude in a tmux window you can drive from this dashboard</div>
    <div class="kv"><div class="k">Name</div><input class="qin" id="newlabel" placeholder="e.g. soag, research, fix-bug"></div>
    <div class="kv"><div class="k">Folder</div><input class="qin" id="newcwd" placeholder="~ (home) — or a path like ~/soag-grid"></div>
    <div class="kv"><button class="qsend" style="padding:8px 18px" onclick="launchWin()">Launch ▸</button></div>
    <div class="foot">opens in tmux · answer its trust prompt with a quick reply (1), then control it from the cards</div>\`;
  document.getElementById('scrim').classList.add('show');
  setTimeout(()=>{ const el=document.getElementById('newlabel'); if(el) el.focus(); }, 60);
}
async function launchWin() {
  const label = (document.getElementById('newlabel').value||'').trim();
  const cwd = (document.getElementById('newcwd').value||'').trim();
  if (!label) { toast('give it a name'); return; }
  toast('launching “'+label+'”…');
  try {
    const r = await fetch('/api/run', { method:'POST', headers:{'content-type':'application/json','x-conductor':'1'}, body:JSON.stringify({label, cwd}) });
    const j = await r.json();
    if (j.ok) { toast('✓ launched “'+j.label+'” — reply 1 to its trust prompt'); closeModal(); lastHash=''; load(); }
    else toast('launch failed: '+(j.error||'?'));
  } catch(e) { toast('launch failed'); }
}
document.getElementById('newbtn').addEventListener('click', openLauncher);

function render() {
  const board = document.getElementById('board');
  const empty = document.getElementById('empty');
  const unit = ADAPTER==='claude-code' ? 'window' : 'bot';
  document.getElementById('count').textContent = DATA.length ? DATA.length+' '+unit+(DATA.length>1?'s':'') : '';
  if (ADAPTER === 'claude-code') {
    const mc = DATA.filter(s=>s.managed).length;
    document.getElementById('bcount').textContent = mc;
    document.getElementById('bcast').style.display = mc ? 'flex' : 'none';
  }
  if (!DATA.length) {
    board.innerHTML=''; empty.style.display='block';
    empty.textContent = 'No sessions in this window. Try a wider range →';
    return;
  }
  empty.style.display='none';
  let html = '';
  for (const sec of sections()) {
    const items = DATA.filter(s => s.status === sec.k);
    if (!items.length) continue;
    html += \`<div class="section-head"><span class="sdot" style="color:\${sec.c};background:\${sec.c}"></span>\`
         +  \`<span class="stitle">\${sec.t}</span><span class="rule"></span>\`
         +  \`<span class="scount">\${items.length}</span></div>\`;
    html += '<div class="grid">' + items.map(cardHTML).join('') + '</div>';
  }
  board.innerHTML = html;
}

function closeModal(){ document.getElementById('scrim').classList.remove('show'); }

document.getElementById('seg').addEventListener('click', e=>{
  const b=e.target.closest('button'); if(!b) return;
  document.querySelectorAll('#seg button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); WINDOW=b.dataset.m; lastHash=''; load();
});
// delegated card + control handlers (survive innerHTML refresh)
const boardEl = document.getElementById('board');
function dispatchReply(el, text) {
  if (el.dataset.label != null) reply(el.dataset.label, text);              // managed → direct
  else if (el.dataset.session != null) replyAdopt(el.dataset.session, text); // plain → adopt + send
}
boardEl.addEventListener('click', e=>{
  const fb = e.target.closest('[data-cmd]');                 // fleet control button
  if (fb) { e.stopPropagation(); fleetControl(fb.dataset.bot, fb.dataset.cmd); return; }
  const ob = e.target.closest('.bopen');
  if (ob) { e.stopPropagation(); openTerm(ob.dataset.open); return; }
  const cb = e.target.closest('.xclose');
  if (cb) { e.stopPropagation(); closeWindow(cb.dataset.close); return; }
  const qb = e.target.closest('.qb,.qsend');
  if (qb) {
    e.stopPropagation();
    if (qb.classList.contains('qsend')) { const inp = qb.parentElement.querySelector('.qin'); dispatchReply(qb, inp.value); inp.value=''; }
    else dispatchReply(qb, qb.dataset.text);
    return;
  }
  if (e.target.closest('.ctrl')) return;       // clicks in the reply area shouldn't open the modal
  const card = e.target.closest('.card');
  if (card && ADAPTER === 'claude-code') openCLI(card.dataset.id);
});
// broadcast bar
const bcastEl = document.getElementById('bcast');
bcastEl.addEventListener('click', e=>{
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'bsend') { const i=document.getElementById('binput'); replyAll(i.value); i.value=''; }
  else if (b.dataset.all != null) replyAll(b.dataset.all);
});
const binputEl = document.getElementById('binput');   // claude-only; fleet replaces this bar
if (binputEl) binputEl.addEventListener('keydown', e=>{
  if (e.key === 'Enter') { replyAll(e.target.value); e.target.value=''; }
});
boardEl.addEventListener('keydown', e=>{
  if (e.target.classList && e.target.classList.contains('qin') && e.key==='Enter') {
    dispatchReply(e.target, e.target.value); e.target.value=''; e.stopPropagation();
  }
});
document.getElementById('scrim').addEventListener('click', e=>{ if(e.target.id==='scrim') closeModal(); });
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeModal(); });

load();
setInterval(load, 4000);
</script>
</body>
</html>`;

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req, res, cb) {
  let b = '', over = false;
  req.on('data', (c) => {
    b += c;
    if (b.length > 8192 && !over) { over = true; sendJSON(res, 413, { ok: false, error: 'body too large' }); req.destroy(); }
  });
  req.on('end', () => { if (over) return; let p; try { p = JSON.parse(b || '{}'); } catch { p = {}; } cb(p); });
}

// CSRF + DNS-rebinding guard for state-changing (POST) requests. The control endpoints
// inject keystrokes into live Claude windows, so a malicious page in the same browser must
// not be able to fire them. Three checks; any one largely closes it, we require all:
//  - Host must be localhost/127.0.0.1 (defeats DNS rebinding)
//  - Origin (when present) must be local (blocks cross-site form/fetch)
//  - a custom X-Conductor header — a cross-origin "simple request" can't set it without a
//    preflight, which we never answer, so the side effect never fires.
function localHost(req) {
  const h = (req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}
function localOrigin(req) {
  const o = req.headers.origin;
  if (!o || o === 'null') return true;
  try { const u = new URL(o); return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1'; }
  catch { return false; }
}
function writeAllowed(req) {
  return localHost(req) && localOrigin(req) && req.headers['x-conductor'] === '1';
}
// Commands that move real money / state and must carry an explicit confirm token (the UI also
// double-confirms). broadcast is always treated as destructive regardless of command.
const DESTRUCTIVE = new Set(['flatten']);
// Drive a freshly launched/adopted window from boot to "ready" and deliver the reply once the
// prompt box is up. Shared with the MCP control tools — see manage.deliverAdopted.
const deliverAdopted = manage.deliverAdopted;

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // All state-changing endpoints are POST; gate them against CSRF / DNS rebinding.
  if (req.method === 'POST' && !writeAllowed(req)) {
    return sendJSON(res, 403, { ok: false, error: 'forbidden — local origin + X-Conductor header required' });
  }
  if (url.pathname === '/api/meta') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(adapterMeta()));
    return;
  }

  if (url.pathname === '/api/sessions') {
    const all = url.searchParams.get('all') === '1';
    const minutes = parseInt(url.searchParams.get('minutes'), 10) || 60;
    const meta = adapterMeta();
    try {
      let rows;
      if (ADAPTER_NAME === 'claude-code') {
        rows = await collectSessions({ minutes, all });
        const mgd = manage.managedBySession();         // sessionId -> managed window
        for (const r of rows) {
          const w = mgd[r.sessionId];
          if (w) { r.managed = true; r.mlabel = w.label; }
        }
      } else {
        rows = await engine.collect(activeAdapter(), { minutes, all });
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ generatedAt: new Date().toISOString(), adapter: meta.adapter, statuses: meta.statuses, capabilities: meta.capabilities, count: rows.length, sessions: rows }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Generic per-unit control (used by non-claude adapters, e.g. fleet pause/resume/flatten).
  // Destructive commands (flatten) require an explicit confirm token in the body.
  if (url.pathname === '/api/control' && req.method === 'POST') {
    readBody(req, res, (p) => {
      const a = activeAdapter();
      if (!a.control || typeof a.control.send !== 'function') return sendJSON(res, 400, { ok: false, error: 'adapter has no control plane' });
      const command = p.command || {};
      if (!a.control.capabilities.includes(command.cmd)) return sendJSON(res, 400, { ok: false, error: 'unknown command' });
      if (DESTRUCTIVE.has(command.cmd) && p.confirm !== command.cmd) {
        return sendJSON(res, 400, { ok: false, error: `"${command.cmd}" is destructive — confirm token required` });
      }
      try { sendJSON(res, 200, a.control.send(p.target, command)); }
      catch (e) { sendJSON(res, 400, { ok: false, error: e.message }); }
    });
    return;
  }

  // Desk-wide broadcast (e.g. the panic flatten). Always destructive → confirm token required.
  if (url.pathname === '/api/broadcast' && req.method === 'POST') {
    readBody(req, res, (p) => {
      const a = activeAdapter();
      if (!a.control || typeof a.control.broadcast !== 'function') return sendJSON(res, 400, { ok: false, error: 'adapter has no broadcast' });
      const command = p.command || {};
      if (!a.control.capabilities.includes(command.cmd)) return sendJSON(res, 400, { ok: false, error: 'unknown command' });
      if (p.confirm !== command.cmd) return sendJSON(res, 400, { ok: false, error: 'broadcast requires a confirm token' });
      // Forward the validated token so the adapter's own destructive gate (defense in depth) passes.
      try { sendJSON(res, 200, a.control.broadcast({ ...command, confirm: p.confirm })); }
      catch (e) { sendJSON(res, 400, { ok: false, error: e.message }); }
    });
    return;
  }

  if (url.pathname === '/api/say' && req.method === 'POST') {
    readBody(req, res, (p) => {
      const r = p.key ? manage.key(p.label, p.key) : manage.say(p.label, p.text || '');
      sendJSON(res, r.ok ? 200 : 400, r);
    });
    return;
  }

  // Bring a managed window's terminal to the front (macOS).
  if (url.pathname === '/api/open' && req.method === 'POST') {
    readBody(req, res, (p) => { const r = manage.openTerminal(p.label); sendJSON(res, r.ok ? 200 : 400, r); });
    return;
  }

  // Close a managed window: kill its tmux window. Irreversible (the live session's state is
  // lost), so — like flatten — it requires a confirm token (confirm === the window label) on
  // top of the CSRF guard; the UI also double-confirms. Only conductor-managed windows live in
  // tmux and can be killed this way; plain windows running in the user's own terminal tabs have
  // no handle here and must be closed from that terminal.
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    readBody(req, res, (p) => {
      if (!p.label) return sendJSON(res, 400, { ok: false, error: 'label required' });
      if (p.confirm !== p.label) return sendJSON(res, 400, { ok: false, error: 'closing a window is irreversible — confirm token (the label) required' });
      const r = manage.stop(p.label);
      sendJSON(res, r.ok ? 200 : 400, r);
    });
    return;
  }

  // Broadcast to every managed window at once.
  if (url.pathname === '/api/say-all' && req.method === 'POST') {
    readBody(req, res, (p) => sendJSON(res, 200, manage.sayAll(p)));
    return;
  }

  // Launch a brand-new managed window (born in tmux, no fork needed).
  if (url.pathname === '/api/run' && req.method === 'POST') {
    readBody(req, res, (p) => {
      const label = (p.label || '').trim();
      if (!label) return sendJSON(res, 400, { ok: false, error: 'label required' });
      let cwd = (p.cwd || '').trim();
      cwd = cwd ? cwd.replace(/^~(?=$|\/)/, os.homedir()) : os.homedir();
      const r = manage.run(label, [], cwd, { capture: false });   // non-blocking; lazy-resolve later
      if (r.ok) deliverAdopted(r.label, '');                      // accept startup prompts → ready
      sendJSON(res, r.ok ? 200 : 400, r);
    });
    return;
  }

  // Reply to a plain window: adopt it (if not already managed), then deliver the message.
  if (url.pathname === '/api/adopt-say' && req.method === 'POST') {
    readBody(req, res, async (p) => {
      try {
        const text = p.text || '';
        const existing = manage.managedBySession()[p.session];
        if (existing) {                       // already managed → just send
          const r = manage.say(existing.label, text);
          return sendJSON(res, r.ok ? 200 : 400, { ...r, label: existing.label });
        }
        const rows = await collectSessions({ minutes: 4320 });
        const s = rows.find((r) => r.sessionId === p.session || r.shortId === p.session);
        if (!s) return sendJSON(res, 400, { ok: false, error: 'session not found' });
        const label = manage.uniqueLabel(s.label || s.shortId, s.sessionId);
        const r = manage.adopt(label, s.sessionId, s.cwd, { capture: false });
        if (r.ok) {
          deliverAdopted(label, text);        // accept startup prompts, then deliver once ready
          return sendJSON(res, 200, { ok: true, label, adopted: true });
        }
        // adopt failed (commonly: a managed copy of this window already exists) → send to it
        const sr = manage.say(label, text);
        sendJSON(res, sr.ok ? 200 : 400, { ok: sr.ok, label, error: sr.ok ? undefined : r.error });
      } catch (e) { sendJSON(res, 500, { ok: false, error: e.message }); }
    });
    return;
  }

  // Bring an existing (read-only) window under management by forking it into tmux.
  if (url.pathname === '/api/adopt' && req.method === 'POST') {
    readBody(req, res, async (p) => {
      try {
        const rows = await collectSessions({ minutes: 4320 });
        const s = rows.find((r) => r.sessionId === p.session || r.shortId === p.session);
        if (!s) return sendJSON(res, 400, { ok: false, error: 'session not found' });
        const label = manage.uniqueLabel(s.label || s.shortId, s.sessionId);
        const r = manage.adopt(label, s.sessionId, s.cwd, { capture: false });
        if (r.ok) deliverAdopted(r.label, '');
        sendJSON(res, r.ok ? 200 : 400, r);
      } catch (e) { sendJSON(res, 500, { ok: false, error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/manual') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(MANUAL);
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = PAGE
      .replace('__ADAPTER__', ADAPTER_NAME)
      .replace('__META__', JSON.stringify(adapterMeta()));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

function openBrowser(url) {
  if (process.platform === 'darwin') execFile('open', [url]);
  else if (process.platform === 'linux') execFile('xdg-open', [url]);
  else console.log(`open ${url}`);
}

function main() {
  const args = parseArgs(process.argv);
  try { engine.loadAdapter(args.adapter); ADAPTER_NAME = args.adapter; }
  catch (e) { console.error('conductor: ' + e.message + ' — falling back to claude-code'); ADAPTER_NAME = 'claude-code'; }
  const url = `http://localhost:${args.port}`;
  const server = http.createServer(handle);

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      // Already running? If it answers like a conductor cockpit, just open it (idempotent).
      const req = http.get({ host: '127.0.0.1', port: args.port, path: '/api/sessions?minutes=1', timeout: 1500 }, (r) => {
        let d = ''; r.on('data', (c) => d += c);
        r.on('end', () => {
          if (d.includes('"sessions"')) {
            console.log(`🎼 Conductor is already running → ${url}  (opening it)`);
            if (args.open) openBrowser(url);
            process.exit(0);
          } else {
            console.error(`Port ${args.port} is in use by something else. Try: conductor up --port 8080`);
            process.exit(1);
          }
        });
      });
      req.on('error', () => { console.error(`Port ${args.port} is busy. Try: conductor up --port 8080`); process.exit(1); });
      req.on('timeout', () => { req.destroy(); console.error(`Port ${args.port} is busy. Try: conductor up --port 8080`); process.exit(1); });
      return;
    }
    console.error('conductor server error:', e.message);
    process.exit(1);
  });

  server.listen(args.port, '127.0.0.1', () => {
    console.log(`🎼 Conductor cockpit → ${url}  (Ctrl+C to stop)`);
    if (args.open) openBrowser(url);
  });
}

main();
