// PATT for iPhone - a Home Screen web app that shares data with the PATT desktop
// app through Supabase. Same rules as the desktop: one timer at a time, Today =
// what's left on counted tasks' daily targets, This week = weekly target minus
// counted time. No build step, no libraries.

const VERSION = "1.4.0";
const UPSERT = "resolution=merge-duplicates,return=minimal";
const MOODS = [["Productive", "#30d158"], ["Focused", "#0a84ff"], ["Okay", "#8e8e93"],
               ["Distracted", "#ff9f0a"], ["Unmotivated", "#ff453a"], ["Tired", "#bf5af2"]];
const REFRESH_EVERY = 20;          // seconds between pulls while the app is open
const DOUBLE_TAP = 0.7, MOOD_UNDO = 15, NOTE_GRACE = 120, MIN_SESSION = 3;
const HANDOFF_FOR = 600;           // seconds a Google sign-in may take to come back
const SLIP_UNDO = 8;               // tap a not-to-do item again within this to undo
const CHECKIN_GRACE = 120;         // a check-in never pauses sooner than this after it appeared
// Shared with the PC (Settings there); used until the PC has saved its own.
const DEFAULT_PREFS = { checkin_on: "1", checkin_prompt: "25", checkin_pause: "30", avoid_nudge: "2" };
const QUESTIONS = ["What have you been working on?", "What have you achieved since your last note?",
                   "What's moved forward in the last half hour?", "Quick note: what are you in the middle of?"];
const EMPTY = () => ({ views: [], tasks: [], sessions: [], notes: [], moods: [], reps: [], overrides: [], prefs: [] });
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
  data: { ...EMPTY(), ...(LS.get("cache", null) || {}) },
  queue: LS.get("queue", []),
  status: "idle", lastSync: LS.get("lastSync", 0), error: "",
  lastTap: { uuid: null, t: 0 },
  sheetTask: null, padValue: "",
  slipUndo: null,                           // {task, uuid, until}: the slip a second tap undoes
  ci: { since: null, at: 0, paused: null }, // check-in: asked for which stretch, when; paused session
  mgr: null,                                // set-up screen state: {tab, edit, showArchived, msg}
  welcomed: LS.get("welcomed", false),
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
const mmss = sec => { sec = Math.max(0, Math.floor(sec)); return `${Math.floor(sec / 60)}:${pad2(sec % 60)}`; };
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
    const [views, tasks, sessions, notes, moods, reps, overrides, prefs] = await Promise.all([
      getAll("views", "select=*&deleted=is.false&order=sort_order"),
      getAll("tasks", "select=*&deleted=is.false&order=sort_order"),
      getAll("sessions", `select=*&deleted=is.false&or=(end_ts.is.null,start_ts.gte.${ts(addDays(ws, -1))})&order=start_ts`),
      getAll("session_notes", `select=*&deleted=is.false&ts=gte.${ts(addDays(today, -1))}&order=ts`),
      getAll("moods", `select=*&deleted=is.false&ts=gte.${ts(today)}&order=ts`),
      getAll("reps", "select=uuid,task_uuid,ts,count,secs&deleted=is.false&order=ts"),
      getAll("overrides", `select=*&deleted=is.false&day=gte.${isoDay(ws)}`),
      getAll("prefs", "select=key,value&deleted=is.false"),
    ]);
    S.data = { views, tasks, sessions, notes, moods, reps, overrides, prefs };
    LS.set("cache", S.data);
    S.lastSync = now(); LS.set("lastSync", S.lastSync);
    setStatus("ok");
    if (!views.length) firstRun();                 // a brand-new account
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
const isTimed = t => t.kind !== "reps" && t.kind !== "avoid";      // not exercise, not not-to-do
function pref(k) { const r = (D().prefs || []).find(p => p.key === k); return r ? r.value : DEFAULT_PREFS[k]; }
function prefInt(k, lo, hi) {
  const v = parseInt(pref(k), 10);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : parseInt(DEFAULT_PREFS[k], 10);
}
function ciLimits() { const a = prefInt("checkin_prompt", 1, 600); return [a, Math.max(prefInt("checkin_pause", 1, 600), a + 1)]; }
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
  return D().tasks.filter(t => isTimed(t) && !t.archived && (S.view === "all" || vids.has(t.view_uuid)))
    .sort((a, b) => a.sort_order - b.sort_order);
}
function counted() {
  const vids = new Set(selectedViews().map(v => v.uuid));
  return D().tasks.filter(t => vids.has(t.view_uuid) && t.billable && isTimed(t));
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
        <div class="cols"><div class="colL"><div id="seg" class="seg"></div>
        <div id="tiles" class="tiles"></div>
        <section class="card" id="exCard"><div class="caps">Exercise <span class="faint">· this week</span></div><div id="ex" class="ex"></div></section>
        <section class="card" id="avCard"><div class="caps">Not-to-do <span class="faint">· today</span></div><div id="av" class="ex"></div></section>
        </div><div class="colR">
        <section class="card" id="now">
          <div class="row2" style="margin-top:0"><span class="caps">Now</span><span id="ciChip" class="chip"></span></div>
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
        <section class="card" id="moodCard"><div class="row2" style="margin-top:0"><span class="caps">Mood</span><span id="moodLast" class="small faint"></span></div>
          <div id="moods" class="moods"></div></section>
        </div></div>
        <div id="foot" class="footer"></div>
      </div>`;
    $("#stopBtn").onclick = () => stopRunning();
    $("#noteForm").onsubmit = e => { e.preventDefault(); addNote(); };
    $("#tiles").onclick = e => {
      if (e.target.closest("[data-new]")) return openEditor("task", null, "time");
      const b = e.target.closest("[data-task]"); if (b) tapTask(b.dataset.task);
    };
    $("#seg").onclick = e => { const b = e.target.closest("[data-view]"); if (b) { S.view = b.dataset.view; LS.set("view", S.view); renderAll(); } };
    $("#moods").onclick = e => { const b = e.target.closest("[data-mood]"); if (b) logMood(b.dataset.mood); };
    $("#ex").onclick = e => {
      if (e.target.closest("[data-new]")) return openEditor("task", null, "reps");
      const b = e.target.closest("[data-ex]"); if (b) openPad(b.dataset.ex);
    };
    $("#av").onclick = e => {
      if (e.target.closest("[data-new]")) return openEditor("task", null, "avoid");
      const b = e.target.closest("[data-av]"); if (b) logSlip(b.dataset.av);
    };
    $("#foot").onclick = e => { if (e.target.id === "signOut") signOut(); };
  }
  renderHead(); renderSeg(); renderNow(); renderTiles(); renderEx(); renderAv(); renderMoods(); live();
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
    <div class="head-r"><button class="sync" id="syncPill" title="${esc(S.error)}"><span class="dot ${dots[S.status] || ""}"></span>${esc(txt)}</button>
    <button class="icon-btn" id="mgrBtn" aria-label="Tasks and settings" title="Tasks and settings">${ICON_SLIDERS}</button></div>`;
  $("#syncPill").onclick = () => load();
  $("#mgrBtn").onclick = () => openManage();
}

function renderSeg() {
  const vs = viewList();
  if (S.view !== "all" && !vs.find(v => v.uuid === S.view)) S.view = vs.length ? vs[0].uuid : null;
  $("#seg").innerHTML = vs.map(v => `<button data-view="${v.uuid}" class="${S.view === v.uuid ? "on" : ""}">${esc(v.name)}</button>`).join("")
    + `<button data-view="all" class="${S.view === "all" ? "on" : ""}">All</button>`;
}

function renderNow() {
  const r = running(), t = r && taskBy(r.task_uuid);
  const p = !r && S.ci.paused, pt = p && taskBy(p.task_uuid);
  $("#nowDot").style.background = t ? t.color : pt ? "var(--danger)" : "var(--faint)";
  $("#nowName").textContent = t ? t.name : pt ? pt.name : "Nothing running";
  $("#nowName").style.color = t || pt ? "var(--text)" : "var(--muted)";
  $("#stopBtn").disabled = !r;
  if (pt) {
    $("#notes").innerHTML = `<div style="color:var(--danger)">No note for ${ciLimits()[1]} minutes, so the timer is paused. Add a note to carry on.</div>`;
    return;
  }
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
  }).join("") : `<div class="card empty" style="grid-column:1/-1"><div class="empty-t">No tasks here yet</div>
      <div class="muted small">Add a project or job you want to track time against.</div>
      <button class="btn pill" data-new="time">Add a task</button></div>`;
}

function renderCounters(c) {
  const name = S.view === "all" ? "All views" : (selectedViews()[0] || {}).name || "";
  let dayHtml, weekHtml, dayFrac = null, weekFrac = null;
  if (c.planned <= 0) {
    dayHtml = metric("Today", "var(--accent)", fmtHM(c.doneToday), "worked", "No daily targets yet");
  } else {
    dayFrac = (c.planned - c.left) / c.planned;
    dayHtml = metric("Today", "var(--accent)", c.left > 0 ? fmtHM(c.left) : "Done", c.left > 0 ? "left" : "✓",
                     `${fmtHM(c.doneToday)} of ${fmtHM(c.planned)} planned`, c.left <= 0);
  }
  if (!c.weekTarget) {
    weekHtml = metric("This week", "var(--good)", fmtHM(c.doneWeek), "worked", "Set a weekly target on the PC");
  } else {
    const wl = c.weekTarget - c.doneWeek, th = c.weekTarget / 3600;
    weekFrac = c.doneWeek / c.weekTarget;
    let sub = `${fmtHM(c.doneWeek)} done`;
    if (wl > 0 && c.weekdaysLeft) sub += ` · ${fmtHM((wl + (c.isWeekday ? c.doneToday : 0)) / c.weekdaysLeft)} a day`;
    weekHtml = wl > 0 ? metric("This week", "var(--good)", fmtHM(wl), `left of ${Number.isInteger(th) ? th + "h" : fmtHM(c.weekTarget)}`, sub)
                      : metric("This week", "var(--good)", "Done", "✓", `${fmtHM(c.doneWeek)} done this week`, true);
  }
  $("#counters").innerHTML = `<div class="caps">${esc(name)}</div>
    <div class="rings-row">${rings(dayFrac, weekFrac)}<div class="metrics">${dayHtml}${weekHtml}</div></div>`;
}
// Activity-style rings: today outside (blue), this week inside (green)
function rings(dayFrac, weekFrac) {
  const arc = (r, frac, col) => {
    const C = 2 * Math.PI * r, f = frac == null ? 0 : Math.max(0, Math.min(1, frac));
    return `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${col}" stroke-opacity=".22" stroke-width="12"/>` +
      (f > 0.005 ? `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round"
         stroke-dasharray="${(f * C).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 50 50)"/>` : "");
  };
  return `<svg class="rings" viewBox="0 0 100 100" aria-hidden="true">${arc(43, dayFrac, "#0a84ff")}${arc(29, weekFrac, "#30d158")}</svg>`;
}
function metric(label, colour, big, suf, sub, good = false) {
  return `<div class="metric"><div class="lbl" style="color:${colour}">${label}</div>
    <div><span class="big" style="${good ? "color:var(--good)" : ""}">${big}</span> <span class="muted small">${esc(suf)}</span></div>
    <div class="small faint">${esc(sub)}</div></div>`;
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
              : best ? `<span class="rec">Best ${fmtQty(best, t.unit)}</span>` : `<span class="rec">&nbsp;</span>`;
    return `<button data-ex="${t.uuid}"><div class="small muted"><span class="dot" style="background:${t.color};width:7px;height:7px"></span> ${esc(t.name)}</div>
      <div class="val" style="${cur ? "" : "color:var(--faint)"}">${fmtQty(cur, t.unit)}</div>${rec}</button>`;
  }).join("") : `<div class="muted small empty-row">Push-ups, a run, anything you count.
      <button class="chip-btn" data-new="reps">+ Add</button></div>`;
  void w1;
}

function renderAv() {
  const items = D().tasks.filter(t => t.kind === "avoid" && !t.archived).sort((a, b) => a.sort_order - b.sort_order);
  const t0 = ts(startOfDay()), w0 = ts(weekStart()), n = now();
  $("#av").innerHTML = items.length ? items.map(t => {
    const rs = D().reps.filter(r => r.task_uuid === t.uuid && r.ts >= w0);
    const today = rs.filter(r => r.ts >= t0).length;
    const secs = rs.reduce((a, r) => a + (r.secs || 0), 0);
    const undo = S.slipUndo && S.slipUndo.task === t.uuid && S.slipUndo.until > n;
    const sub = undo ? "Logged · tap again to undo" : `${rs.length} this week${secs >= 60 ? " · " + fmtHM(secs) : ""}`;
    return `<button data-av="${t.uuid}"><div class="small muted"><span class="dot" style="background:${t.color};width:7px;height:7px"></span> ${esc(t.name)}</div>
      <div class="val" style="color:${today ? "var(--slip)" : "var(--good)"}">${today ? today + "×" : "Clean"}</div>
      <span class="rec">${esc(sub)}</span></button>`;
  }).join("") : `<div class="muted small empty-row">Things to stay away from, like YouTube. Tap one when you slip.
      <button class="chip-btn" data-new="avoid">+ Add</button></div>`;
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
  const ps = !c.running && S.ci.paused && D().sessions.find(s => s.uuid === S.ci.paused.session_uuid);
  $("#clock").textContent = c.running ? fmtHMS(c.n - c.running.start_ts) : ps ? fmtHMS((ps.end_ts || c.n) - ps.start_ts) : "0:00:00";
  $("#clock").style.color = c.running ? "var(--text)" : ps ? "var(--danger)" : "var(--faint)";
  const st = ciStatus(c.n), chip = $("#ciChip");
  chip.textContent = st.state === "ok" ? `Note due in ${Math.ceil(st.left / 60)} min`
    : st.state === "due" ? `Note due · pauses in ${Math.ceil(st.left / 60)} min`
    : st.state === "paused" || st.state === "pause" ? "Paused · add a note" : "";
  chip.style.color = st.state === "due" ? "var(--warn)" : st.state === "ok" ? "var(--faint)" : "var(--danger)";
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
  ciTick();
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
  S.ci.paused = null; closeCheckin();
  if (!r) return renderAll();
  const op = closeSession(r, now());
  renderAll();
  await enqueue(op);
  LS.set("cache", S.data);
}

async function addNote() {
  const inp = $("#noteIn"), text = inp.value.trim();
  if (!text) return;
  if (!running() && S.ci.paused) {
    inp.value = ""; inp.blur(); closeCheckin();
    const ops = noteWhilePaused(text);
    renderAll();
    for (const op of ops) await enqueue(op);
    LS.set("cache", S.data);
    return;
  }
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

// not-to-do: one tap = one slip; a second tap straight after undoes it
async function logSlip(u) {
  const n = now(), un = S.slipUndo;
  if (un && un.task === u && un.until > n) {
    S.slipUndo = null;
    D().reps = D().reps.filter(r => r.uuid !== un.uuid);
    renderAv();
    await enqueue({ m: "PATCH", p: `reps?uuid=eq.${un.uuid}`, b: { deleted: true }, prefer: "return=minimal" });
    LS.set("cache", S.data);
    return;
  }
  const row = { uuid: uuid(), task_uuid: u, ts: n, count: 1, secs: 0 };
  D().reps.push(row);
  S.slipUndo = { task: u, uuid: row.uuid, until: n + SLIP_UNDO };
  renderAv();
  setTimeout(() => { if ($("#av")) renderAv(); }, SLIP_UNDO * 1000 + 100);
  await enqueue({ m: "POST", p: "reps?on_conflict=user_id,uuid", b: [row], prefer: UPSERT });
  LS.set("cache", S.data);
}

// --------------------------------------------------------- check-ins ----
// Same rule as the PC: while a timer runs, ask for a note after `checkin_prompt`
// minutes without one; still nothing after `checkin_pause` minutes = pause the timer
// until there's a note. Never pauses out of the blue: it always asks first.
function ciStatus(n = now()) {
  const r = running();
  if (r && S.ci.paused) S.ci.paused = null;               // a timer started somewhere: carry on
  if (pref("checkin_on") !== "1") return { state: "off" };
  if (!r) return S.ci.paused ? { state: "paused", ...S.ci.paused } : { state: "idle" };
  const t = taskBy(r.task_uuid);
  if (t && !t.billable) return { state: "exempt" };       // breaks don't need notes
  const since = Math.max(r.start_ts, ...D().notes.filter(x => x.session_uuid === r.uuid).map(x => x.ts));
  const [a, b] = ciLimits(), el = n - since;
  let st;
  if (el < a * 60) st = { state: "ok", left: a * 60 - el };
  else if (el < b * 60) st = { state: "due", left: b * 60 - el };
  else {
    const waited = S.ci.since === since ? n - S.ci.at : 0;
    st = waited < CHECKIN_GRACE ? { state: "due", left: CHECKIN_GRACE - waited } : { state: "pause", left: 0 };
  }
  return { ...st, since, session: r, task: t };
}

let ciBusy = false;
async function ciTick() {
  if (!S.auth || ciBusy || !$("#main")) return;
  const st = ciStatus();
  if (st.state === "due") {
    if (S.ci.since !== st.since) { S.ci.since = st.since; S.ci.at = now(); openCheckin(st); }
    else updateCheckin(st);
  } else if (st.state === "pause") {
    ciBusy = true;
    try {
      await load();                                       // a note may have come from the PC
      const st2 = ciStatus();
      if (st2.state !== "pause") return;
      const r = st2.session, op = closeSession(r, now());
      S.ci.paused = { task_uuid: r.task_uuid, session_uuid: r.uuid, at: r.end_ts };
      openCheckin(ciStatus());
      renderAll();
      await enqueue(op);
      LS.set("cache", S.data);
    } finally { ciBusy = false; }
  } else if (st.state !== "paused") closeCheckin();
}

function openCheckin(st) {
  const el = $("#ci"), paused = st.state === "paused";
  const t = paused ? taskBy(st.task_uuid) : st.task;
  const typed = $("#ciText") ? $("#ciText").value : "";
  el.innerHTML = `<div class="panel ci${paused ? " paused" : ""}">
    <div class="row2" style="margin-top:0"><span class="caps"${paused ? ' style="color:var(--danger)"' : ""}>${paused ? "Timer paused" : "Check-in"}</span>
      <span class="small" style="color:${t ? t.color : "var(--muted)"};font-weight:600">● ${esc(t ? t.name : "")}</span></div>
    <h3 class="ci-q">${esc(paused ? "Add a note to carry on" : QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)])}</h3>
    <div class="small muted" id="ciSub"></div>
    <textarea id="ciText" rows="3" placeholder="e.g. Drafted the RFI responses"></textarea>
    <button class="btn${paused ? " danger" : ""}" id="ciSave">${paused ? "Save &amp; resume" : "Save note"}</button>
    <button class="link block" id="ciLater">${paused ? "Leave it paused" : "Not now"}</button></div>`;
  $("#ciText").value = typed;
  el.classList.remove("hidden");
  updateCheckin(st);
  $("#ciSave").onclick = () => saveCheckin();
  $("#ciLater").onclick = () => closeCheckin();
}
function updateCheckin(st) {
  const sub = $("#ciSub");
  if (!sub || $("#ci").classList.contains("hidden")) return;
  sub.textContent = st.state === "paused"
    ? `No note for ${ciLimits()[1]} minutes, so the timer is paused. Write what you've been doing and it picks up again.`
    : `Last note ${fmtClock(st.since)} · the timer pauses in ${mmss(st.left)}`;
}
function closeCheckin() { const el = $("#ci"); if (el) { el.classList.add("hidden"); el.innerHTML = ""; } }

// a note for the paused session (at the moment it paused), then the same task again
function noteWhilePaused(text) {
  const p = S.ci.paused, n = now(), ops = [];
  S.ci.paused = null;
  const note = { uuid: uuid(), session_uuid: p.session_uuid, ts: Math.min(n, p.at), text };
  D().notes.push(note);
  ops.push({ m: "POST", p: "session_notes?on_conflict=user_id,uuid", b: [note], prefer: UPSERT });
  const t = taskBy(p.task_uuid);
  if (t && !t.archived) {
    const s = { uuid: uuid(), task_uuid: p.task_uuid, start_ts: n, end_ts: null, note: "" };
    D().sessions.push(s);
    ops.push({ m: "POST", p: "sessions?on_conflict=user_id,uuid", b: [s], prefer: UPSERT });
  }
  return ops;
}
async function saveCheckin() {
  const ta = $("#ciText"), text = ta.value.trim();
  if (!text) { ta.focus(); $("#ciSub").style.color = "var(--warn)"; return; }
  const r = running();
  let ops = [];
  if (r) {
    const note = { uuid: uuid(), session_uuid: r.uuid, ts: now(), text };
    D().notes.push(note);
    ops.push({ m: "POST", p: "session_notes?on_conflict=user_id,uuid", b: [note], prefer: UPSERT });
  } else if (S.ci.paused) ops = noteWhilePaused(text);
  closeCheckin();
  renderAll();
  for (const op of ops) await enqueue(op);
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

// ------------------------------------------------------------ set-up ----
// Everything the PC can set up, here too: tasks (timed, exercise, not-to-do), views
// and the check-in timings. New accounts get a starter view and a short welcome.
const COLORS = ["#0a84ff", "#30d158", "#ff9f0a", "#ff453a", "#bf5af2", "#64d2ff", "#ff375f", "#ffd60a", "#5e5ce6", "#8e8e93"];
const ICON_SLIDERS = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>`;
const KIND_LABEL = { time: "Timed", reps: "Exercise", avoid: "Not-to-do" };
const STARTERS = [["time", "Deep work"], ["time", "Admin & email"], ["time", "Meetings"], ["time", "Study"],
                  ["reps", "Push-ups"], ["reps", "Run", "km"], ["avoid", "YouTube", "youtube"],
                  ["avoid", "Social media", "facebook, instagram, tiktok"]];

// Same id for a setting on every device (matches the PC's uuid5 of "patt-pref:<key>").
async function uuid5(name, ns = "6ba7b811-9dad-11d1-80b4-00c04fd430c8") {
  const nsb = ns.replace(/-/g, "").match(/../g).map(h => parseInt(h, 16));
  const data = new Uint8Array([...nsb, ...new TextEncoder().encode(name)]);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", data)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// Durations as on the PC: "2" = 2h (up to `upto`), "1:30", "45m", "2h 15m"; returns minutes.
function parseDur(text, upto) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return null;
  if (t.includes(":")) {
    const [h, m] = t.split(":"), H = Number(h || 0), M = Number(m || 0);
    if (!Number.isInteger(H) || !Number.isInteger(M) || H < 0 || M < 0 || M >= 60) throw new Error(text);
    return H * 60 + M;
  }
  if (/^\d+(\.\d+)?$/.test(t)) { const v = Number(t); return v <= upto || (t.includes(".") && v <= 24) ? v * 60 : v; }
  const m = t.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?$/);
  if (m && (m[1] || m[2])) return Number(m[1] || 0) * 60 + Number(m[2] || 0);
  throw new Error(text);
}
const fmtMin = m => m == null ? "" : fmtHM(m * 60);
const nextOrder = list => list.reduce((a, x) => Math.max(a, x.sort_order || 0), 0) + 1;
function nextColor() { return COLORS[D().tasks.length % COLORS.length]; }

async function saveRow(table, row, isNew) {
  const list = D()[table];
  const i = list.findIndex(x => x.uuid === row.uuid);
  if (i >= 0) list[i] = { ...list[i], ...row }; else list.push(row);
  LS.set("cache", S.data);
  const { uuid: u, ...fields } = row;
  await enqueue(isNew ? { m: "POST", p: `${table}?on_conflict=user_id,uuid`, b: [row], prefer: UPSERT }
                      : { m: "PATCH", p: `${table}?uuid=eq.${u}`, b: fields, prefer: "return=minimal" });
}
function newTask(kind, name, extra = {}) {
  const v = selectedViews()[0] || viewList()[0];
  return { uuid: uuid(), name, project: "", kind, daily_target: null, weekly_target: null, weekdays_only: 0,
           color: kind === "avoid" ? "#ff375f" : nextColor(), sort_order: nextOrder(D().tasks), archived: 0, created_at: now(),
           view_uuid: kind === "time" && v ? v.uuid : null, billable: kind === "time" ? 1 : 0,
           unit: "reps", keywords: "", ...extra };
}

// first run: a starter view (like the PC's) and a welcome with a few ideas
let starting = false;
async function firstRun() {
  if (starting || D().views.length) return;
  starting = true;
  const v = { uuid: uuid(), name: "Work", weekly_target: 30 * 60, plan: "360,360,360,360,360,0,0", sort_order: 0, archived: 0 };
  S.view = v.uuid; LS.set("view", S.view);
  try { await saveRow("views", v, true); } finally { starting = false; }
  renderAll();
  if (!D().tasks.length && !S.welcomed) openManage("welcome");
}

function openManage(tab = "tasks") {
  S.mgr = { tab, edit: null, showArchived: false, picked: new Set(), msg: "" };
  renderManage();
  $("#mgr").classList.remove("hidden");
}
function openEditor(type, u, kind) {
  if (!S.mgr) S.mgr = { tab: "tasks", showArchived: false, picked: new Set(), msg: "", direct: true };
  S.mgr.edit = { type, uuid: u, kind };
  S.mgr.msg = "";
  renderManage();
  $("#mgr").classList.remove("hidden");
}
function closeManage() { $("#mgr").classList.add("hidden"); $("#mgr").innerHTML = ""; S.mgr = null; renderAll(); }
function backFromEditor() { if (S.mgr.direct) return closeManage(); S.mgr.edit = null; S.mgr.msg = ""; renderManage(); }

function renderManage() {
  const m = S.mgr, el = $("#mgr");
  if (!m) return;
  if (m.edit) return renderEditor();
  if (m.tab === "welcome") return renderWelcome();
  const tabs = [["tasks", "Tasks"], ["views", "Views"], ["settings", "Settings"]];
  let body = "";
  if (m.tab === "tasks") {
    const live = D().tasks.filter(t => !t.archived), gone = D().tasks.filter(t => t.archived);
    const group = (title, list) => list.length ? `<div class="grp">${esc(title)}</div><div class="list">${list.map(rowFor).join("")}</div>` : "";
    body = viewList().map(v => group(v.name, live.filter(t => isTimed(t) && t.view_uuid === v.uuid))).join("")
      + group("Timed, no view", live.filter(t => isTimed(t) && !viewList().some(v => v.uuid === t.view_uuid)))
      + group("Exercise", live.filter(t => t.kind === "reps")) + group("Not-to-do", live.filter(t => t.kind === "avoid"))
      + (live.length ? "" : `<p class="muted small">Nothing yet. Add the projects you work on, exercise you count, or things to avoid.</p>`)
      + (gone.length ? `<button class="link block" data-act="arch">${m.showArchived ? "Hide" : "Show"} archived (${gone.length})</button>
         ${m.showArchived ? `<div class="list">${gone.map(rowFor).join("")}</div>` : ""}` : "")
      + `<button class="btn" data-act="new-task">New task</button>`;
  } else if (m.tab === "views") {
    body = `<p class="muted small">Each view has its own tiles and weekly hours target, e.g. Work and Personal.</p>
      <div class="list">${D().views.filter(v => !v.archived).map(v => `<button class="row" data-edit-view="${v.uuid}">
        <span class="row-main"><b>${esc(v.name)}</b><span class="faint small">${v.weekly_target ? fmtMin(v.weekly_target) + " a week" : "No weekly target"}</span></span><span class="chev">›</span></button>`).join("")}</div>
      <button class="btn" data-act="new-view">New view</button>`;
  } else {
    const [a, b] = ciLimits();
    body = `<div class="grp">Note check-ins</div>
      <div class="form-card">
        <label class="tog"><input type="checkbox" id="setOn" ${pref("checkin_on") === "1" ? "checked" : ""}> While a timer runs, ask what I've been working on</label>
        <label class="fld"><span>Ask after</span><input id="setAsk" inputmode="numeric" value="${a}"><em>minutes without a note</em></label>
        <label class="fld"><span>Pause the timer after</span><input id="setPause" inputmode="numeric" value="${b}"><em>minutes if there's still no note</em></label>
        <p class="faint small">Breaks (tasks that don't count toward hours) are never paused. The same settings apply on your PC.</p>
      </div>
      <div class="grp">Not-to-do</div>
      <div class="form-card">
        <label class="fld"><span>Nudge me after</span><input id="setNudge" inputmode="numeric" value="${prefInt("avoid_nudge", 0, 600)}"><em>minutes (PC only, 0 = never)</em></label>
      </div>
      <div class="err">${esc(m.msg)}</div>
      <button class="btn" data-act="save-settings">Save</button>`;
  }
  el.innerHTML = `<div class="panel mgr">
    <div class="row2" style="margin-top:0"><h3>Set up</h3><button class="link" data-act="close">Done</button></div>
    <div class="seg mini">${tabs.map(([k, t]) => `<button data-tab="${k}" class="${m.tab === k ? "on" : ""}">${t}</button>`).join("")}</div>
    ${body}</div>`;
}
function rowFor(t) {
  const sub = t.kind === "avoid" ? (t.keywords ? `Spots: ${t.keywords}` : "Logged by hand")
    : t.kind === "reps" ? [t.daily_target ? `${t.daily_target} a day` : "", t.weekly_target ? `${t.weekly_target} a week` : "", t.unit !== "reps" ? t.unit : ""].filter(Boolean).join(" · ") || "No target"
    : [t.daily_target ? `${fmtMin(t.daily_target)} a day` : "", t.weekly_target ? `${fmtMin(t.weekly_target)} a week` : "", t.billable ? "" : "not counted"].filter(Boolean).join(" · ") || "No target";
  return `<button class="row" data-edit-task="${t.uuid}"><span class="dot" style="background:${t.color}"></span>
    <span class="row-main"><b>${esc(t.name)}</b><span class="faint small">${esc(sub)}</span></span><span class="chev">›</span></button>`;
}

function renderWelcome() {
  const m = S.mgr;
  $("#mgr").innerHTML = `<div class="panel mgr welcome-sheet">
    <img class="logo small-logo" src="icon.svg" alt="">
    <h3 style="text-align:center">Welcome to PATT</h3>
    <p class="muted" style="text-align:center">Tap a task to time it, count your exercise, and keep an eye on time-wasters.
      Pick a few to start with. You can change everything later.</p>
    ${["time", "reps", "avoid"].map(k => `<div class="grp">${KIND_LABEL[k]}</div><div class="chips">${STARTERS.map((s, i) => s[0] === k
      ? `<button class="chip-btn ${m.picked.has(i) ? "on" : ""}" data-pick="${i}">${esc(s[1])}</button>` : "").join("")}</div>`).join("")}
    <button class="btn" data-act="welcome-add">${m.picked.size ? `Add ${m.picked.size} and start` : "Start with an empty board"}</button>
    <button class="link block" data-act="welcome-own">I'll add my own</button></div>`;
}

function renderEditor() {
  const m = S.mgr, e = m.edit;
  if (e.type === "view") {
    const v = D().views.find(x => x.uuid === e.uuid) || { name: "", weekly_target: null };
    $("#mgr").innerHTML = `<div class="panel mgr">
      <div class="row2" style="margin-top:0"><button class="link" data-act="back">Cancel</button><h3>${e.uuid ? "Edit view" : "New view"}</h3><button class="link" data-act="save-view"><b>Save</b></button></div>
      <div class="form-card">
        <label class="fld"><span>Name</span><input id="vName" value="${esc(v.name)}" placeholder="e.g. Work"></label>
        <label class="fld"><span>Weekly target</span><input id="vWeek" value="${esc(fmtMin(v.weekly_target))}" placeholder="e.g. 30"><em>hours (30, 37:30…)</em></label>
      </div>
      <div class="err">${esc(m.msg)}</div>
      ${e.uuid && viewList().length > 1 ? `<button class="btn secondary danger-t" data-act="archive-view">Archive this view</button>` : ""}</div>`;
    return;
  }
  const t = D().tasks.find(x => x.uuid === e.uuid) || newTask(e.kind || "time", "");
  const kind = e.uuid ? t.kind : (e.kind || "time");
  const isNew = !e.uuid;
  e.color = e.color || t.color;
  const views = viewList();
  const daily = kind === "reps" ? (t.daily_target ?? "") : fmtMin(t.daily_target);
  const weekly = kind === "reps" ? (t.weekly_target ?? "") : fmtMin(t.weekly_target);
  $("#mgr").innerHTML = `<div class="panel mgr">
    <div class="row2" style="margin-top:0"><button class="link" data-act="back">Cancel</button><h3>${isNew ? "New task" : "Edit task"}</h3><button class="link" data-act="save-task"><b>Save</b></button></div>
    ${isNew ? `<div class="seg mini">${["time", "reps", "avoid"].map(k => `<button data-kind="${k}" class="${kind === k ? "on" : ""}">${KIND_LABEL[k]}</button>`).join("")}</div>` : ""}
    <div class="form-card">
      <label class="fld"><span>Name</span><input id="tName" value="${esc(t.name)}" placeholder="${kind === "avoid" ? "e.g. YouTube" : kind === "reps" ? "e.g. Push-ups" : "e.g. Client project"}"></label>
      ${kind === "time" ? `
      <label class="fld"><span>View</span><select id="tView">${views.map(v => `<option value="${v.uuid}" ${v.uuid === t.view_uuid ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></label>
      <label class="fld"><span>Daily target</span><input id="tDaily" value="${esc(daily)}" placeholder="e.g. 2 or 1:30"><em>hours</em></label>
      <label class="fld"><span>Weekly target</span><input id="tWeekly" value="${esc(weekly)}" placeholder="e.g. 10"><em>hours</em></label>
      <label class="tog"><input type="checkbox" id="tWkd" ${t.weekdays_only ? "checked" : ""}> Daily target on weekdays only</label>
      <label class="tog"><input type="checkbox" id="tBill" ${t.billable ? "checked" : ""}> Counts toward the view's hours (untick for breaks)</label>` : ""}
      ${kind === "reps" ? `
      <label class="fld"><span>Counted in</span><input id="tUnit" value="${esc(t.unit || "reps")}" placeholder="reps, km…"></label>
      <label class="fld"><span>Daily target</span><input id="tDaily" inputmode="decimal" value="${esc(daily)}" placeholder="e.g. 100"></label>
      <label class="fld"><span>Weekly target</span><input id="tWeekly" inputmode="decimal" value="${esc(weekly)}" placeholder="optional"></label>` : ""}
      ${kind === "avoid" ? `
      <label class="fld"><span>Words to spot</span><input id="tKeys" value="${esc(t.keywords || "")}" placeholder="e.g. youtube"><em>PATT on your PC logs a slip when a window title has one</em></label>` : ""}
      <div class="fld"><span>Colour</span><div class="swatches">${COLORS.map(c => `<button class="sw ${c === e.color ? "on" : ""}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`).join("")}</div></div>
    </div>
    <div class="err">${esc(m.msg)}</div>
    ${!isNew ? `<button class="btn secondary ${t.archived ? "" : "danger-t"}" data-act="archive-task">${t.archived ? "Restore" : "Archive (hide)"}</button>` : ""}</div>`;
  if (isNew) setTimeout(() => $("#tName") && $("#tName").focus(), 50);
}

async function onManageClick(ev) {
  const m = S.mgr;
  if (!m) return;
  if (ev.target.id === "mgr") return m.edit ? backFromEditor() : closeManage();
  const b = ev.target.closest("button");
  if (!b) return;
  ev.preventDefault();
  const d = b.dataset;
  if (d.tab) { m.tab = d.tab; m.msg = ""; return renderManage(); }
  if (d.editTask) { m.edit = { type: "task", uuid: d.editTask }; return renderManage(); }
  if (d.editView) { m.edit = { type: "view", uuid: d.editView }; return renderManage(); }
  if (d.kind) { keepTyped(() => { m.edit.kind = d.kind; }); return; }
  if (d.color) { keepTyped(() => { m.edit.color = d.color; }); return; }
  if (d.pick) { const i = +d.pick; m.picked.has(i) ? m.picked.delete(i) : m.picked.add(i); return renderManage(); }
  switch (d.act) {
    case "close": return closeManage();
    case "back": return backFromEditor();
    case "arch": m.showArchived = !m.showArchived; return renderManage();
    case "new-task": m.edit = { type: "task", uuid: null, kind: "time" }; return renderManage();
    case "new-view": m.edit = { type: "view", uuid: null }; return renderManage();
    case "save-task": return saveTask();
    case "save-view": return saveView();
    case "save-settings": return saveSettings();
    case "archive-task": {
      const t = D().tasks.find(x => x.uuid === m.edit.uuid);
      if (t) await saveRow("tasks", { uuid: t.uuid, archived: t.archived ? 0 : 1 }, false);
      return backFromEditor();
    }
    case "archive-view": {
      await saveRow("views", { uuid: m.edit.uuid, archived: 1 }, false);
      if (S.view === m.edit.uuid) { S.view = (viewList()[0] || {}).uuid || "all"; LS.set("view", S.view); }
      return backFromEditor();
    }
    case "welcome-add": case "welcome-own": {
      S.welcomed = true; LS.set("welcomed", true);
      const rows = [];
      for (const i of [...m.picked].sort((a, b) => a - b)) {      // one by one: colours and order advance
        const [k, name, x] = STARTERS[i];
        const r = newTask(k, name, k === "reps" ? { unit: x || "reps" } : k === "avoid" ? { keywords: x } : {});
        D().tasks.push(r);
        rows.push(r);
      }
      if (d.act === "welcome-own") { m.tab = "tasks"; m.edit = { type: "task", uuid: null, kind: "time" }; renderManage(); }
      else closeManage();
      if (rows.length) await enqueue({ m: "POST", p: "tasks?on_conflict=user_id,uuid", b: rows, prefer: UPSERT });
      LS.set("cache", S.data);
      return;
    }
  }
}
// re-render the editor without losing what's been typed
function keepTyped(change) {
  const vals = {};
  for (const i of $("#mgr").querySelectorAll("input,select")) vals[i.id] = i.type === "checkbox" ? i.checked : i.value;
  change();
  renderManage();
  for (const [id, v] of Object.entries(vals)) { const i = $("#" + id); if (!i) continue; if (i.type === "checkbox") i.checked = v; else i.value = v; }
}

async function saveTask() {
  const m = S.mgr, e = m.edit, isNew = !e.uuid;
  const old = D().tasks.find(x => x.uuid === e.uuid);
  const kind = isNew ? (e.kind || "time") : old.kind;
  const val = id => ($("#" + id) ? $("#" + id).value.trim() : "");
  const name = val("tName");
  if (!name) { m.msg = "Give it a name."; return keepTyped(() => {}); }
  const row = isNew ? newTask(kind, name) : { uuid: old.uuid, name };
  row.color = e.color || row.color || old.color;
  try {
    if (kind === "time") {
      row.view_uuid = val("tView") || null;
      row.daily_target = parseDur(val("tDaily"), 12);
      row.weekly_target = parseDur(val("tWeekly"), 168);
      row.weekdays_only = $("#tWkd").checked ? 1 : 0;
      row.billable = $("#tBill").checked ? 1 : 0;
    } else if (kind === "reps") {
      const num = s => { if (!s) return null; const n = Number(s); if (!(n > 0)) throw new Error(s); return n; };
      row.daily_target = num(val("tDaily")); row.weekly_target = num(val("tWeekly"));
      row.unit = val("tUnit") || "reps";
    } else {
      row.keywords = val("tKeys").toLowerCase().split(",").map(x => x.trim()).filter(Boolean).join(", ");
    }
  } catch (err) {
    m.msg = kind === "reps" ? "Targets are numbers, e.g. 100." : "Targets look like 2 (hours), 1:30 or 45m.";
    return keepTyped(() => {});
  }
  backFromEditor();
  await saveRow("tasks", row, isNew);
  renderAll();
}

async function saveView() {
  const m = S.mgr, e = m.edit, isNew = !e.uuid;
  const name = $("#vName").value.trim();
  let week;
  try { week = parseDur($("#vWeek").value, 168); } catch { m.msg = "The weekly target looks like 30 or 37:30."; return keepTyped(() => {}); }
  if (!name) { m.msg = "Give it a name."; return keepTyped(() => {}); }
  const row = isNew ? { uuid: uuid(), name, weekly_target: week, plan: "360,360,360,360,360,0,0", sort_order: nextOrder(D().views), archived: 0 }
                    : { uuid: e.uuid, name, weekly_target: week };
  backFromEditor();
  await saveRow("views", row, isNew);
  if (isNew) { S.view = row.uuid; LS.set("view", S.view); }
  renderAll();
}

async function saveSettings() {
  const m = S.mgr, int = id => Number($("#" + id).value.trim());
  const ask = int("setAsk"), pause = int("setPause"), nudge = int("setNudge");
  if (![ask, pause, nudge].every(Number.isInteger) || !(ask >= 1 && ask < pause && pause <= 600) || nudge < 0 || nudge > 600) {
    m.msg = "The pause has to come after the reminder, e.g. ask after 25 and pause after 30 minutes.";
    return keepTyped(() => {});
  }
  const want = { checkin_on: $("#setOn").checked ? "1" : "0", checkin_prompt: String(ask), checkin_pause: String(pause), avoid_nudge: String(nudge) };
  const rows = [];
  for (const [key, value] of Object.entries(want)) {
    if (pref(key) === value && (D().prefs || []).some(p => p.key === key)) continue;
    const row = { uuid: await uuid5("patt-pref:" + key), key, value };
    D().prefs = (D().prefs || []).filter(p => p.key !== key).concat([{ key, value }]);
    rows.push(row);
  }
  closeManage();
  toast("Settings saved");
  if (rows.length) await enqueue({ m: "POST", p: "prefs?on_conflict=user_id,uuid", b: rows, prefer: UPSERT });
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
    <p class="lead">Time your work, count your exercise and keep tabs on time-wasters, on your phone, in your browser and on your PC.</p>
    <button class="btn google" id="google">Continue with Google</button>
    <div class="err">${esc(err)}</div>
    <p class="fine">New here? Just continue: your account is made the first time you sign in.
      Already use PATT on a PC? Use the same Google account.</p>
    <p class="fine"><a href="privacy.html">Privacy</a> · <a href="get/">Get PATT for Windows</a></p>`);
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
    S.data = EMPTY();
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
    S.data = EMPTY();
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
  document.body.insertAdjacentHTML("beforeend", '<div id="ci" class="sheet hidden" role="dialog" aria-modal="true"></div>' +
    '<div id="mgr" class="sheet hidden" role="dialog" aria-modal="true"></div>');
  $("#mgr").addEventListener("click", onManageClick);
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
