// PATT for iPhone - a Home Screen web app that shares data with the PATT desktop
// app through Supabase. Same rules as the desktop: one timer at a time, Today =
// what's left on counted tasks' daily targets, This week = weekly target minus
// counted time. No build step, no libraries.

const VERSION = "1.2.0";
const UPSERT = "resolution=merge-duplicates,return=minimal";
const MOODS = [["Productive", "#30d158"], ["Focused", "#0a84ff"], ["Okay", "#8e8e93"],
               ["Distracted", "#ff9f0a"], ["Unmotivated", "#ff453a"], ["Tired", "#bf5af2"]];
const REFRESH_EVERY = 20;          // seconds between pulls while the app is open
const DOUBLE_TAP = 0.7, MOOD_UNDO = 15, NOTE_GRACE = 120, MIN_SESSION = 3;
const HANDOFF_FOR = 600;           // seconds a Google sign-in may take to come back
// Simon's Supabase project. The publishable key is meant to be public: it only lets
// people try to sign in. Data is protected by Google sign-in + row-level security.
const CLOUD = { url: "https://stggkftvuzwsserlervg.supabase.co",
                key: "sb_publishable_EeQRPoX0w5f7r-HI69PvMg_sRG-MA8_" };

// ------------------------------------------------------------ storage ----
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem("patt." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("patt." + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem("patt." + k); } catch {} },
};

const S = {
  cfg: LS.get("cfg") || CLOUD,              // {url, key}; a saved one only for testing
  auth: LS.get("auth"),                     // {access_token, refresh_token, expires_at, email}
  view: LS.get("view", null),               // view uuid or "all"
  data: LS.get("cache", null) || { views: [], tasks: [], sessions: [], notes: [], moods: [], reps: [], overrides: [] },
  queue: LS.get("queue", []),
  status: "idle", lastSync: LS.get("lastSync", 0), error: "",
  lastTap: { uuid: null, t: 0 },
  sheetTask: null, padValue: "",
};

// -------------------------------------------------------------- time -----
const now = () => Date.now() / 1000;
const pad2 = n => String(n).padStart(2, "0");
function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function weekStart(d = new Date()) { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
const ts = d => d.getTime() / 1000;
const isoDay = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function fmtHM(sec) { const neg = sec < 0; sec = Math.round(Math.abs(sec)); return `${neg ? "-" : ""}${Math.floor(sec / 3600)}:${pad2(Math.floor(sec % 3600 / 60))}`; }
function fmtHMS(sec) { sec = Math.max(0, Math.floor(sec)); return `${Math.floor(sec / 3600)}:${pad2(Math.floor(sec % 3600 / 60))}:${pad2(sec % 60)}`; }
function fmtClock(t) { const d = new Date(t * 1000); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function fmtQty(v, unit) { const n = Math.round(v * 1000) / 1000; const t = Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1); return unit && unit !== "reps" ? `${t} ${unit}` : t; }
const clip = (s, e, a, b) => Math.max(0, Math.min(e, b) - Math.max(s, a));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const randomHex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, "0")).join("");
function jwtEmail(t) {
  try { return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email || ""; } catch { return ""; }
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));

// ------------------------------------------------------------- network ---
class AuthErr extends Error {}
class NetErr extends Error {}

async function authPost(path, body) {
  let r;
  try {
    r = await fetch(S.cfg.url + path, { method: "POST",
      headers: { apikey: S.cfg.key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch { throw new NetErr("No connection"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new AuthErr(j.error_description || j.msg || j.message || `Error ${r.status}`);
  return j;
}

function saveTokens(j) {
  S.auth = { access_token: j.access_token, refresh_token: j.refresh_token,
             expires_at: j.expires_at || (now() + (j.expires_in || 3600)),
             email: (j.user && j.user.email) || (S.auth && S.auth.email) || "" };
  LS.set("auth", S.auth);
}

let refreshing = null;              // one refresh at a time (refresh tokens rotate)
async function token(force = false) {
  if (!S.auth || !S.auth.refresh_token) throw new AuthErr("Signed out");
  if (!force && S.auth.access_token && S.auth.expires_at - 60 > now()) return S.auth.access_token;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const j = await authPost("/auth/v1/token?grant_type=refresh_token", { refresh_token: S.auth.refresh_token });
        saveTokens(j);
        return j.access_token;
      } catch (e) {
        if (e instanceof AuthErr) { S.auth = null; LS.del("auth"); }
        throw e;
      } finally { refreshing = null; }
    })();
  }
  return refreshing;
}

async function rest(method, path, body, prefer) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await token(attempt === 1);
    let r;
    try {
      r = await fetch(`${S.cfg.url}/rest/v1/${path}`, { method,
        headers: { apikey: S.cfg.key, Authorization: `Bearer ${t}`, "Content-Type": "application/json",
                   ...(prefer ? { Prefer: prefer } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw new NetErr("No connection"); }
    if (r.status === 401 && attempt === 0) continue;
    const txt = await r.text();
    if (r.status === 401) throw new AuthErr("Session expired");
    if (!r.ok) throw new Error(`${r.status}: ${txt.slice(0, 160)}`);
    return txt ? JSON.parse(txt) : null;
  }
}

async function getAll(table, query) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const rows = await rest("GET", `${table}?${query}&limit=1000&offset=${off}`);
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

// writes go through a queue so nothing is lost when offline, and stay in order
async function enqueue(op) {
  S.queue.push(op);
  LS.set("queue", S.queue);
  await flushQueue();
}
let flushing = false;
async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    while (S.queue.length) {
      const op = S.queue[0];
      try {
        await rest(op.m, op.p, op.b, op.prefer);
      } catch (e) {
        if (e instanceof NetErr) { setStatus("offline"); return; }
        if (e instanceof AuthErr) { setStatus("signedout"); renderAll(); return; }
        console.warn("dropping failed change", op, e);   // e.g. invalid row: don't block the queue
        toast("A change couldn't be saved: " + e.message);
      }
      S.queue.shift();
      LS.set("queue", S.queue);
    }
  } finally { flushing = false; }
}

// --------------------------------------------------------------- load ----
async function load() {
  if (!S.cfg || !S.auth) return;
  setStatus("busy");
  try {
    await flushQueue();
    if (S.queue.length) return;                    // still offline
    const ws = weekStart(), today = startOfDay();
    const [views, tasks, sessions, notes, moods, reps, overrides] = await Promise.all([
      getAll("views", "select=*&deleted=is.false&order=sort_order"),
      getAll("tasks", "select=*&deleted=is.false&order=sort_order"),
      getAll("sessions", `select=*&deleted=is.false&or=(end_ts.is.null,start_ts.gte.${ts(addDays(ws, -1))})&order=start_ts`),
      getAll("session_notes", `select=*&deleted=is.false&ts=gte.${ts(addDays(today, -1))}&order=ts`),
      getAll("moods", `select=*&deleted=is.false&ts=gte.${ts(today)}&order=ts`),
      getAll("reps", "select=uuid,task_uuid,ts,count&deleted=is.false&order=ts"),
      getAll("overrides", `select=*&deleted=is.false&day=gte.${isoDay(ws)}`),
    ]);
    S.data = { views, tasks, sessions, notes, moods, reps, overrides };
    LS.set("cache", S.data);
    S.lastSync = now(); LS.set("lastSync", S.lastSync);
    setStatus("ok");
  } catch (e) {
    if (e instanceof AuthErr) { setStatus("signedout"); }
    else if (e instanceof NetErr) { setStatus("offline"); }
    else { setStatus("error", e.message); }
  }
  renderAll();
}

function setStatus(s, err = "") { S.status = s; S.error = err; renderHead(); }

// ------------------------------------------------------------- derive ----
const D = () => S.data;
function viewList() { return D().views.filter(v => !v.archived); }
function selectedViews() {
  const vs = viewList();
  if (S.view === "all") return vs;
  const v = vs.find(x => x.uuid === S.view) || vs[0];
  return v ? [v] : [];
}
function running() {
  return D().sessions.filter(s => s.end_ts == null && !s.deleted)
    .sort((a, b) => b.start_ts - a.start_ts)[0] || null;
}
function taskBy(u) { return D().tasks.find(t => t.uuid === u); }
function targetFor(t, day) {
  const o = D().overrides.find(x => x.task_uuid === t.uuid && x.day === isoDay(day));
  if (o) return o.daily_target;
  if (t.daily_target == null) return null;
  if (t.weekdays_only && (day.getDay() === 0 || day.getDay() === 6)) return null;
  return t.daily_target;
}
function secsByTask(a, b, n) {
  const out = {};
  for (const s of D().sessions) {
    const secs = clip(s.start_ts, s.end_ts ?? n, a, b);
    if (secs > 0) out[s.task_uuid] = (out[s.task_uuid] || 0) + secs;
  }
  return out;
}
function tilesTasks() {
  const vids = new Set(selectedViews().map(v => v.uuid));
  return D().tasks.filter(t => t.kind !== "reps" && !t.archived && (S.view === "all" || vids.has(t.view_uuid)))
    .sort((a, b) => a.sort_order - b.sort_order);
}
function counted() {
  const vids = new Set(selectedViews().map(v => v.uuid));
  return D().tasks.filter(t => vids.has(t.view_uuid) && t.billable && t.kind !== "reps");
}

function computeAll() {
  const n = now(), today = startOfDay(), ws = weekStart();
  const t0 = ts(today), t1 = ts(addDays(today, 1)), w0 = ts(ws), w1 = ts(addDays(ws, 7));
  const day = secsByTask(t0, t1, n), week = secsByTask(w0, w1, n);
  const c = counted(), cIds = new Set(c.map(t => t.uuid));
  let planned = 0, left = 0, doneToday = 0, doneWeek = 0;
  for (const [u, s] of Object.entries(day)) if (cIds.has(u)) doneToday += s;
  for (const [u, s] of Object.entries(week)) if (cIds.has(u)) doneWeek += s;
  for (const t of c) {
    if (t.archived) continue;
    const tg = targetFor(t, today);
    if (!tg) continue;
    planned += tg * 60;
    left += Math.max(0, tg * 60 - (day[t.uuid] || 0));
  }
  const targets = selectedViews().map(v => v.weekly_target).filter(x => x != null);
  const weekTarget = targets.length ? targets.reduce((a, b) => a + b, 0) * 60 : null;
  const wd = today.getDay();
  const weekdaysLeft = Math.max(0, 5 - ((wd + 6) % 7));
  const r = running();
  return { n, day, week, planned, left, doneToday, doneWeek, weekTarget, weekdaysLeft,
           isWeekday: wd >= 1 && wd <= 5, running: r,
           totalToday: Object.values(day).reduce((a, b) => a + b, 0),
           totalWeek: Object.values(week).reduce((a, b) => a + b, 0) };
}

// ------------------------------------------------------------- render ----
const $ = s => document.querySelector(s);
const app = $("#app");

function renderAll() {
  if (!S.auth) return renderSignIn();
  if (!$("#main")) {
    app.innerHTML = `
      <div id="main">
        <div id="head" class="head"></div>
        <div id="seg" class="seg"></div>
        <section class="card" id="now">
          <div class="caps">Now</div>
          <div class="now-row" style="margin-top:6px"><span id="nowDot" class="dot"></span><span id="nowName" class="now-name"></span></div>
          <div class="now-row"><span id="clock" class="clock">0:00:00</span><span style="flex:1"></span>
            <button id="stopBtn" class="stop">Stop</button></div>
          <form class="note" id="noteForm" autocomplete="off">
            <input id="noteIn" enterkeyhint="send" placeholder="Add a note — what are you working on?">
            <button id="noteBtn" type="submit">Add</button>
          </form>
          <div id="notes" class="notes"></div>
        </section>
        <section class="card" id="counters"></section>
        <div id="tiles" class="tiles"></div>
        <section class="card"><div class="caps">Exercise · this week</div><div id="ex" class="ex"></div></section>
        <section class="card"><div class="row2" style="margin-top:0"><span class="caps">Mood</span><span id="moodLast" class="small faint"></span></div>
          <div id="moods" class="moods"></div></section>
        <div id="foot" class="footer"></div>
      </div>`;
    $("#stopBtn").onclick = () => stopRunning();
    $("#noteForm").onsubmit = e => { e.preventDefault(); addNote(); };
    $("#tiles").onclick = e => { const b = e.target.closest("[data-task]"); if (b) tapTask(b.dataset.task); };
    $("#seg").onclick = e => { const b = e.target.closest("[data-view]"); if (b) { S.view = b.dataset.view; LS.set("view", S.view); renderAll(); } };
    $("#moods").onclick = e => { const b = e.target.closest("[data-mood]"); if (b) logMood(b.dataset.mood); };
    $("#ex").onclick = e => { const b = e.target.closest("[data-ex]"); if (b) openPad(b.dataset.ex); };
    $("#foot").onclick = e => { if (e.target.id === "signOut") signOut(); };
  }
  renderHead(); renderSeg(); renderNow(); renderTiles(); renderEx(); renderMoods(); live();
  $("#foot").innerHTML = `Signed in as ${esc(S.auth.email)} · <button id="signOut">Sign out</button><br>PATT mobile ${VERSION}`;
}

function renderHead() {
  const h = $("#head");
  if (!h) return;
  const d = new Date();
  const dots = { ok: "ok", busy: "busy", offline: "err", error: "err", signedout: "err", idle: "" };
  const txt = { ok: S.lastSync ? `Synced ${fmtClock(S.lastSync)}` : "Synced", busy: "Syncing…",
                offline: S.queue.length ? `Offline · ${S.queue.length} waiting` : "Offline",
                error: "Sync problem", signedout: "Signed out", idle: "" }[S.status] || "";
  h.innerHTML = `<div><h1>${d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</h1>
      <div class="sub" id="totals"></div></div>
    <button class="sync" id="syncPill" title="${esc(S.error)}"><span class="dot ${dots[S.status] || ""}"></span>${esc(txt)}</button>`;
  $("#syncPill").onclick = () => load();
}

function renderSeg() {
  const vs = viewList();
  if (S.view !== "all" && !vs.find(v => v.uuid === S.view)) S.view = vs.length ? vs[0].uuid : null;
  $("#seg").innerHTML = vs.map(v => `<button data-view="${v.uuid}" class="${S.view === v.uuid ? "on" : ""}">${esc(v.name)}</button>`).join("")
    + `<button data-view="all" class="${S.view === "all" ? "on" : ""}">All</button>`;
}

function renderNow() {
  const r = running(), t = r && taskBy(r.task_uuid);
  $("#nowDot").style.background = t ? t.color : "var(--faint)";
  $("#nowName").textContent = t ? t.name : "Nothing running";
  $("#nowName").style.color = t ? "var(--text)" : "var(--muted)";
  $("#stopBtn").disabled = !r;
  const notes = r ? D().notes.filter(x => x.session_uuid === r.uuid).sort((a, b) => a.ts - b.ts).slice(-3) : [];
  $("#notes").innerHTML = r ? (notes.map(x => `<div><b>${fmtClock(x.ts)}</b>${esc(x.text)}</div>`).join("") ||
    `<div class="faint">Notes are saved with this session for your timesheet.</div>`) : `<div class="faint">Tap a task to start its timer.</div>`;
}

function tileInfo(t, c) {
  const done = c.day[t.uuid] || 0, wk = c.week[t.uuid] || 0;
  const tg = targetFor(t, startOfDay());
  const run = c.running && c.running.task_uuid === t.uuid;
  let big, suf, meta, frac = null;
  if (tg) {
    const left = tg * 60 - done;
    big = left > 0 ? fmtHM(left) : "Done";
    suf = left > 0 ? "left today" : (left < -59 ? "+" + fmtHM(-left) : "✓");
    meta = `${fmtHM(done)} of ${fmtHM(tg * 60)}`;
    frac = done / (tg * 60);
  } else { big = fmtHM(done); suf = "today"; meta = ""; }
  const wkTxt = t.weekly_target ? (t.weekly_target * 60 - wk > 0 ? `${fmtHM(t.weekly_target * 60 - wk)} left this wk` : "week target met")
                                : `${fmtHM(wk)} this week`;
  meta = meta ? `${meta} · ${wkTxt}` : wkTxt;
  return { big, suf, meta, run, done: big === "Done", frac,
           runTxt: run ? "● " + fmtHMS(c.n - c.running.start_ts) : "" };
}

function renderTiles() {
  const c = computeAll();
  const ts_ = tilesTasks();
  $("#tiles").innerHTML = ts_.length ? ts_.map(t => {
    const i = tileInfo(t, c);
    return `<button class="tile" data-task="${t.uuid}" style="${i.run ? `border-color:${t.color};background:color-mix(in srgb, ${t.color} 20%, var(--card))` : ""}">
      <div class="t-name"><span class="dot" style="background:${t.color}"></span><span>${esc(t.name)}</span></div>
      <div class="t-run" style="color:${t.color}" data-live="run">${i.runTxt}</div>
      <div class="t-big" data-live="big" style="${i.done ? "color:var(--good)" : ""}">${i.big}<small>${i.suf}</small></div>
      <div class="t-meta" data-live="meta">${esc(i.meta)}</div></button>`;
  }).join("") : `<div class="card muted" style="grid-column:1/-1">No tasks in this view yet. Add them in PATT on your PC.</div>`;
}

function renderCounters(c) {
  const name = S.view === "all" ? "All views" : (selectedViews()[0] || {}).name || "";
  let dayHtml, weekHtml;
  if (c.planned <= 0) {
    dayHtml = metric("Today", fmtHM(c.doneToday), "worked", null, "No daily targets on these tasks yet");
  } else {
    dayHtml = metric("Today", c.left > 0 ? fmtHM(c.left) : "Done", c.left > 0 ? "left" : "✓",
                     (c.planned - c.left) / c.planned, `${fmtHM(c.doneToday)} worked of ${fmtHM(c.planned)} planned`,
                     c.left <= 0);
  }
  if (!c.weekTarget) {
    weekHtml = metric("This week", fmtHM(c.doneWeek), "worked", null, "Set a weekly target on the PC (Edit view)");
  } else {
    const wl = c.weekTarget - c.doneWeek, th = c.weekTarget / 3600;
    let sub = `${fmtHM(c.doneWeek)} counted`;
    if (wl > 0 && c.weekdaysLeft) {
      const perDay = (wl + (c.isWeekday ? c.doneToday : 0)) / c.weekdaysLeft;
      sub += ` · ≈${fmtHM(perDay)}/day for ${c.weekdaysLeft} day${c.weekdaysLeft > 1 ? "s" : ""} incl. today`;
    }
    weekHtml = wl > 0 ? metric("This week", fmtHM(wl), `left of ${Number.isInteger(th) ? th + "h" : fmtHM(c.weekTarget)}`,
                               c.doneWeek / c.weekTarget, sub)
                      : metric("This week", "Done", "✓", c.doneWeek / c.weekTarget, `${fmtHM(c.doneWeek)} counted — weekly commitment met`, true);
  }
  $("#counters").innerHTML = `<div class="caps">${esc(name)}</div>${dayHtml}${weekHtml}`;
}
function metric(label, big, suf, frac, sub, good = false) {
  const w = frac == null ? null : Math.max(0, Math.min(1, frac)) * 100;
  const cls = frac == null ? "" : frac > 1 ? "over" : frac >= 1 ? "full" : "";
  return `<div class="metric"><div class="row"><span class="lbl">${label}</span>
    <span><span class="big" style="${good ? "color:var(--good)" : ""}">${big}</span> <span class="muted small">${esc(suf)}</span></span></div>
    ${w == null ? "" : `<div class="bar"><i class="${cls}" style="width:${w}%"></i></div>`}
    <div class="small faint" style="margin-top:4px">${esc(sub)}</div></div>`;
}

function renderEx() {
  const ex = D().tasks.filter(t => t.kind === "reps" && !t.archived).sort((a, b) => a.sort_order - b.sort_order);
  const w0 = ts(weekStart()), w1 = w0 + 7 * 86400;
  $("#ex").innerHTML = ex.length ? ex.map(t => {
    const byWeek = {};
    for (const r of D().reps.filter(r => r.task_uuid === t.uuid)) {
      const k = ts(weekStart(new Date(r.ts * 1000)));
      byWeek[k] = Math.round(((byWeek[k] || 0) + r.count) * 1000) / 1000;
    }
    const cur = byWeek[w0] || 0;
    const past = Object.entries(byWeek).filter(([k]) => +k !== w0).map(([, v]) => v);
    const best = past.length ? Math.max(...past) : 0;
    const rec = past.length && cur > best ? `<span class="rec new">★ new weekly record</span>`
              : best ? `<span class="rec">Record ${fmtQty(best, t.unit)}</span>` : `<span class="rec">No record yet</span>`;
    return `<button data-ex="${t.uuid}"><div class="small muted"><span class="dot" style="background:${t.color};width:7px;height:7px"></span> ${esc(t.name)}</div>
      <div class="val">${fmtQty(cur, t.unit)}</div>${rec}</button>`;
  }).join("") : `<div class="muted small">Add exercises in PATT on your PC (Tasks → New task → Reps / count).</div>`;
  void w1;
}

function renderMoods() {
  const today = D().moods.filter(m => m.ts >= ts(startOfDay())).sort((a, b) => a.ts - b.ts);
  const last = today[today.length - 1];
  $("#moods").innerHTML = MOODS.map(([m, col]) => `<button data-mood="${m}" class="${last && last.mood === m ? "on" : ""}"
     style="${last && last.mood === m ? `background:color-mix(in srgb, ${col} 55%, var(--tile))` : ""}">${m}</button>`).join("");
  $("#moodLast").textContent = last ? `${last.mood} at ${fmtClock(last.ts)}` : "How are you feeling?";
}

function live() {                     // once a second: clock, tiles, counters
  if (!$("#main")) return;
  const c = computeAll();
  $("#clock").textContent = c.running ? fmtHMS(c.n - c.running.start_ts) : "0:00:00";
  $("#clock").style.color = c.running ? "var(--text)" : "var(--faint)";
  const tot = $("#totals");
  if (tot) tot.textContent = `${fmtHM(c.totalToday)} tracked today · ${fmtHM(c.totalWeek)} this week`;
  for (const el of document.querySelectorAll("#tiles [data-task]")) {
    const t = taskBy(el.dataset.task);
    if (!t) continue;
    const i = tileInfo(t, c);
    el.querySelector('[data-live="run"]').textContent = i.runTxt;
    const big = el.querySelector('[data-live="big"]');
    big.innerHTML = `${i.big}<small>${i.suf}</small>`;
    big.style.color = i.done ? "var(--good)" : "";
    el.querySelector('[data-live="meta"]').textContent = i.meta;
  }
  renderCounters(c);
}

// ------------------------------------------------------------ actions ----
function toast(msg, ms = 2500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.add("hidden"), ms);
}

function closeSession(r, at) {
  const hasExtras = D().notes.some(n => n.session_uuid === r.uuid) || D().moods.some(m => m.session_uuid === r.uuid);
  if (at - r.start_ts < MIN_SESSION && !hasExtras) {      // accidental double-tap: drop it
    D().sessions = D().sessions.filter(s => s.uuid !== r.uuid);
    return { m: "PATCH", p: `sessions?uuid=eq.${r.uuid}`, b: { deleted: true }, prefer: "return=minimal" };
  }
  r.end_ts = Math.max(r.start_ts, at);
  return { m: "PATCH", p: `sessions?uuid=eq.${r.uuid}`, b: { end_ts: r.end_ts }, prefer: "return=minimal" };
}

async function tapTask(u) {
  const n = now();
  if (S.lastTap.uuid === u && n - S.lastTap.t < DOUBLE_TAP) return;   // double tap = one tap
  S.lastTap = { uuid: u, t: n };
  const r = running(), ops = [];
  if (r) ops.push(closeSession(r, n));
  if (!r || r.task_uuid !== u) {
    const s = { uuid: uuid(), task_uuid: u, start_ts: n, end_ts: null, note: "" };
    D().sessions.push(s);
    ops.push({ m: "POST", p: "sessions?on_conflict=user_id,uuid", b: [s], prefer: UPSERT });
  }
  renderAll();
  for (const op of ops) await enqueue(op);
  LS.set("cache", S.data);
}

async function stopRunning() {
  const r = running();
  if (!r) return;
  const op = closeSession(r, now());
  renderAll();
  await enqueue(op);
  LS.set("cache", S.data);
}

async function addNote() {
  const inp = $("#noteIn"), text = inp.value.trim();
  if (!text) return;
  let target = running();
  if (!target) {                       // typed it, pressed Stop, then Add: the session that just ended
    const n = now();
    target = D().sessions.filter(s => s.end_ts && s.end_ts > n - NOTE_GRACE).sort((a, b) => b.end_ts - a.end_ts)[0];
  }
  if (!target) { toast("Start a task first — your note is kept in the box."); return; }
  const note = { uuid: uuid(), session_uuid: target.uuid, ts: now(), text };
  D().notes.push(note);
  inp.value = "";
  inp.blur();
  renderNow();
  await enqueue({ m: "POST", p: "session_notes?on_conflict=user_id,uuid", b: [note], prefer: UPSERT });
  LS.set("cache", S.data);
}

async function logMood(m) {
  const n = now(), recent = D().moods.filter(x => x.ts > n - MOOD_UNDO).sort((a, b) => a.ts - b.ts);
  const last = recent[recent.length - 1];
  if (last && last.mood === m) {                           // second tap = undo
    D().moods = D().moods.filter(x => x.uuid !== last.uuid);
    renderMoods(); toast(`${m} removed`);
    await enqueue({ m: "PATCH", p: `moods?uuid=eq.${last.uuid}`, b: { deleted: true }, prefer: "return=minimal" });
    return;
  }
  const r = running();
  const row = { uuid: uuid(), ts: n, mood: m, session_uuid: r ? r.uuid : null };
  D().moods.push(row);
  renderMoods();
  await enqueue({ m: "POST", p: "moods?on_conflict=user_id,uuid", b: [row], prefer: UPSERT });
  LS.set("cache", S.data);
}

// exercise keypad
function openPad(u) {
  S.sheetTask = taskBy(u);
  S.padValue = "";
  renderPad();
  $("#sheet").classList.remove("hidden");
}
function closePad() { $("#sheet").classList.add("hidden"); S.sheetTask = null; renderEx(); }
function renderPad() {
  const t = S.sheetTask;
  if (!t) return;
  const dec = !["reps", ""].includes(t.unit || "reps");
  const t0 = ts(startOfDay()), w0 = ts(weekStart());
  const todays = D().reps.filter(r => r.task_uuid === t.uuid && r.ts >= t0).sort((a, b) => a.ts - b.ts);
  const sum = a => Math.round(a.reduce((x, r) => x + r.count, 0) * 1000) / 1000;
  const week = sum(D().reps.filter(r => r.task_uuid === t.uuid && r.ts >= w0));
  const tg = targetFor(t, startOfDay());
  const quick = dec ? [1, 2.5, 5, 10] : [5, 10, 20, 25];
  const keys = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "⌫", "0", dec ? "." : "C"];
  $("#sheet").innerHTML = `<div class="panel">
    <div class="row2" style="margin-top:0"><h3>${esc(t.name)}</h3><button class="link" data-act="close">Done</button></div>
    <div class="small muted">Today ${fmtQty(sum(todays), t.unit)}${tg ? " / " + tg : ""} · Week ${fmtQty(week, t.unit)}</div>
    <div class="display">${esc(S.padValue || "0")}</div>
    <div class="quick">${quick.map(q => `<button data-quick="${q}" style="background:color-mix(in srgb, ${t.color} 35%, var(--tile))">+${q}</button>`).join("")}</div>
    <div class="keys">${keys.map(k => `<button data-key="${k}">${k}</button>`).join("")}</div>
    <button class="btn" data-act="log">${dec ? "Log" : "Log set"}</button>
    <div class="row2"><span class="small muted">Today</span><button class="link small" data-act="undo">Undo last</button></div>
    <div class="sets">${todays.map(r => `${fmtQty(r.count, t.unit)} @ ${fmtClock(r.ts)}`).join(" · ") || "None yet"}</div></div>`;
}
document.addEventListener("click", async e => {
  if (!S.sheetTask || !e.target.closest("#sheet")) return;
  if (e.target.id === "sheet") return closePad();
  const b = e.target.closest("button");
  if (!b) return;
  const t = S.sheetTask;
  if (b.dataset.key) {
    const k = b.dataset.key;
    if (k === "C") S.padValue = "";
    else if (k === "⌫") S.padValue = S.padValue.slice(0, -1);
    else if (k === ".") { if (!S.padValue.includes(".")) S.padValue = (S.padValue || "0") + "."; }
    else if (S.padValue.length < 6) { S.padValue += k; if (!S.padValue.includes(".")) S.padValue = S.padValue.replace(/^0+/, ""); }
    return renderPad();
  }
  if (b.dataset.quick) return logReps(t, +b.dataset.quick);
  if (b.dataset.act === "log") { const v = parseFloat(S.padValue); S.padValue = ""; if (v > 0) return logReps(t, v); return renderPad(); }
  if (b.dataset.act === "undo") {
    const t0 = ts(startOfDay());
    const last = D().reps.filter(r => r.task_uuid === t.uuid && r.ts >= t0).sort((a, b) => a.ts - b.ts).pop();
    if (!last) return;
    D().reps = D().reps.filter(r => r.uuid !== last.uuid);
    renderPad();
    return enqueue({ m: "PATCH", p: `reps?uuid=eq.${last.uuid}`, b: { deleted: true }, prefer: "return=minimal" });
  }
  if (b.dataset.act === "close") return closePad();
});
async function logReps(t, v) {
  const row = { uuid: uuid(), task_uuid: t.uuid, ts: now(), count: Math.round(v * 1000) / 1000 };
  D().reps.push(row);
  renderPad();
  await enqueue({ m: "POST", p: "reps?on_conflict=user_id,uuid", b: [row], prefer: UPSERT });
  LS.set("cache", S.data);
}

// --------------------------------------------------------------- sign in ----
const appUrl = () => location.origin + location.pathname;
function pendingHandoff() {
  const p = LS.get("handoff");
  if (p && now() - p.t > HANDOFF_FOR) { LS.del("handoff"); return null; }
  return p;
}

function screen(inner) {
  app.innerHTML = `<div class="welcome"><img class="logo" src="icon.svg" alt="">${inner}</div>`;
}

function renderSignIn(err = "") {
  if (pendingHandoff()) return renderWaiting();
  screen(`<h1>PATT</h1>
    <p class="lead">Your time tracker, in step with PATT on your PC.</p>
    <button class="btn google" id="google">Continue with Google</button>
    <div class="err">${esc(err)}</div>
    <p class="fine">Use the same Google account you signed in with on your PC.</p>`);
  $("#google").onclick = () => googleSignIn();
}

function renderWaiting() {
  screen(`<h1>Finish signing in</h1>
    <p class="lead">Choose your Google account in the page that opened. If it ends up in Safari,
       just come back here. PATT picks it up by itself.</p>
    <div class="waiting"><span class="dot busy"></span> Waiting for Google…</div>
    <button class="btn secondary" id="cancelG">Cancel</button>`);
  $("#cancelG").onclick = () => { LS.del("handoff"); renderAll(); };
}

// Google sign-in. The page comes back to the app's own address with the session in the
// #fragment. In the Home Screen app that usually means we're back where we started (same
// storage: just keep it). If iOS finished it in Safari instead, that page can't reach the
// app's storage, so it parks the session in the cloud under the random code below and
// the app collects it (claimHandoff).
function googleSignIn() {
  const code = randomHex(32);
  LS.set("handoff", { code, t: now() });
  const back = `${appUrl()}?handoff=${code}`;
  renderWaiting();
  location.href = `${S.cfg.url}/auth/v1/authorize?provider=google&prompt=select_account` +
                  `&redirect_to=${encodeURIComponent(back)}`;
}

function renderParked(err = "", busy = false) {
  screen(`<h1>${err ? "Couldn't finish signing in" : busy ? "Signing in…" : "You're signed in ✓"}</h1>
    <p class="lead">${err ? esc(err) : busy ? "One moment." : "Now go back to <b>PATT on your Home Screen</b>. It finishes signing in by itself. You can close this page."}</p>`);
}

async function handleReturn() {
  const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.slice(1));
  const code = q.get("handoff");
  const at = h.get("access_token"), rt = h.get("refresh_token");
  const err = h.get("error_description") || h.get("error") || q.get("error_description") || q.get("error");
  if (!code && !at && !err) return null;
  history.replaceState(null, "", location.pathname);          // keep tokens out of history
  const cfg = S.cfg;
  const pend = LS.get("handoff");
  const here = !code || (pend && pend.code === code);         // back in the app that asked
  if (err) {
    if (here) { LS.del("handoff"); return { error: err.replace(/\+/g, " ") }; }
    renderParked(err.replace(/\+/g, " "));
    return { parked: true };
  }
  if (!at || !rt) return here ? { error: "Google sign-in didn't complete. Try again." } : null;
  if (here) {
    saveTokens({ access_token: at, refresh_token: rt, expires_at: +h.get("expires_at") || null,
                 expires_in: +h.get("expires_in") || 3600, user: { email: jwtEmail(at) } });
    LS.del("handoff");
    S.data = { views: [], tasks: [], sessions: [], notes: [], moods: [], reps: [], overrides: [] };
    return { signedIn: true };
  }
  renderParked("", true);
  try {
    const r = await fetch(`${cfg.url}/rest/v1/rpc/patt_handoff_put`, { method: "POST",
      headers: { apikey: cfg.key, Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code, token: rt }) });
    if (!r.ok) throw new Error(`error ${r.status}`);
    renderParked();
  } catch (e) {
    renderParked(`The sign-in couldn't be passed to the app (${e.message}). Go back to PATT and try again.`);
  }
  return { parked: true };
}

let claiming = false;
async function claimHandoff() {
  const pend = pendingHandoff();
  if (!pend || S.auth || claiming) return;
  claiming = true;
  try {
    let r;
    try {
      r = await fetch(`${S.cfg.url}/rest/v1/rpc/patt_handoff_take`, { method: "POST",
        headers: { apikey: S.cfg.key, "Content-Type": "application/json" },
        body: JSON.stringify({ code: pend.code }) });
    } catch { return; }                                          // offline: try again later
    const rt = r.ok ? await r.json() : null;
    if (!rt) return;
    LS.del("handoff");
    try {
      saveTokens(await authPost("/auth/v1/token?grant_type=refresh_token", { refresh_token: rt }));
    } catch (e) { renderSignIn(e.message || "Sign-in expired. Try again."); return; }
    S.data = { views: [], tasks: [], sessions: [], notes: [], moods: [], reps: [], overrides: [] };
    app.innerHTML = "";
    renderAll();
    load();
  } finally { claiming = false; }
}

function signOut() {
  if (S.queue.length && !confirm(`${S.queue.length} change(s) haven't been uploaded yet. Sign out anyway?`)) return;
  S.auth = null; LS.del("auth"); LS.del("cache"); LS.set("queue", []); S.queue = [];
  app.innerHTML = "";
  renderAll();
}

// --------------------------------------------------------------- boot ----
(async function boot() {
  const ret = await handleReturn();
  if (ret && ret.parked) return;                 // this Safari page only passes the sign-in on
  if (ret && ret.error) renderSignIn(ret.error); else renderAll();
  load();
  claimHandoff();
  setInterval(live, 1000);
  setInterval(() => { if (document.visibilityState === "visible") load(); }, REFRESH_EVERY * 1000);
  setInterval(() => { if (document.visibilityState === "visible") claimHandoff(); }, 2000);
  const back = () => { if (document.visibilityState === "visible") { claimHandoff(); load(); } };
  document.addEventListener("visibilitychange", back);
  window.addEventListener("focus", () => claimHandoff());
  window.addEventListener("pageshow", () => claimHandoff());
  window.addEventListener("online", () => load());
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();

window.__patt = S;          // for debugging/tests
