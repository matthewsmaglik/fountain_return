import { EditorView } from "@codemirror/view";
import { analyze, formatEighths } from "./fountain.js";
import { createEditor, replaceDoc, scrollToLine, setPending, clearPending, getPending } from "./editor.js";
import { artifactClaude, errorCopy } from "./claude.js";
import { dbStore, localStore } from "./store.js";
import { rulesTurn, rewriteTurn, parseEdits } from "./prompts.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const uid = () => Math.random().toString(36).slice(2, 10);

const REVISION_COLORS = [
  ["White", "#ffffff"], ["Blue", "#9ec5ff"], ["Pink", "#f7b8cf"], ["Yellow", "#f7e58a"], ["Green", "#a8dcb0"],
  ["Goldenrod", "#e0b04a"], ["Buff", "#eedcb3"], ["Salmon", "#f4a98f"], ["Cherry", "#d9536b"],
];
const MAX_TURNS = 40;
const MAX_PROMPT = 230_000;

const NEW_SCRIPT = `Title: Untitled
Credit: Written by
Author:
Draft date: ${new Date().toLocaleDateString("en-US")}

====

INT. LOCATION - DAY

Action.

CHARACTER
Dialogue.
`;

const S = {
  store: null,
  claude: null,
  claudeChecked: false,
  view: null,
  id: null,
  title: "",
  scripts: [],
  lastSaved: "",
  dirty: false,
  saving: null,
  saveTimer: 0,
  unwatch: null,
  turns: [],
  analysis: null,
  bdTab: "scenes",
  settings: { styleNotes: "", tier: "default" },
  busy: null, // AbortController of the running Claude call
};

// ---------------------------------------------------------------- boot
let EMPTY_HTML = "";
async function boot() {
  bindUI();
  EMPTY_HTML = $("empty").innerHTML;
  $("empty").innerHTML = `<p>Loading your scripts…</p>`;
  renderChat();
  const db = await dbStore().catch(() => null);
  S.store = db || localStore();
  S.settings = { ...S.settings, ...(await S.store.loadSettings().catch(() => ({}))) };
  await refreshScripts();
  if (S.scripts.length) await openScript(S.scripts[0].id);
  else showEmpty();
  artifactClaude().then((c) => { S.claude = c; S.claudeChecked = true; renderChat(); }).catch(() => { S.claudeChecked = true; renderChat(); });
}

async function refreshScripts() {
  S.scripts = await S.store.listScripts().catch(() => []);
  const sel = $("scriptSelect");
  sel.innerHTML = S.scripts.length
    ? S.scripts.map((s) => `<option value="${esc(s.id)}">${esc(s.title || "Untitled")}</option>`).join("")
    : `<option value="">No scripts</option>`;
  if (S.id) sel.value = S.id;
}

function showEmpty() {
  $("empty").innerHTML = EMPTY_HTML;
  $("emptyOpen").onclick = () => $("fileInput").click();
  $("emptyNew").onclick = () => createScript(NEW_SCRIPT, "Untitled");
  $("sheet").hidden = true;
  $("empty").hidden = false;
  $("breakdown").hidden = true;
  setStatus("");
}

// ---------------------------------------------------------------- scripts
async function openScript(id) {
  await flushSave();
  const doc = await S.store.loadScript(id);
  if (!doc) return;
  S.unwatch?.();
  S.id = id;
  S.title = doc.title || "Untitled";
  S.lastSaved = doc.text || "";
  S.dirty = false;
  $("empty").hidden = true;
  $("sheet").hidden = false;
  $("breakdown").hidden = $("btnBreakdown").getAttribute("aria-pressed") !== "true";
  if (!S.view) {
    S.view = createEditor({
      parent: $("sheet"),
      doc: S.lastSaved,
      onChange: onDocChange,
      onSelection: onSelection,
      extraKeys: [{ key: "Mod-k", run: () => { openPopover(); return true; } }],
    });
  } else {
    S.view.load(S.lastSaved);
  }
  $("scriptSelect").value = id;
  setStatus("Saved");
  runAnalysis();
  S.turns = await S.store.loadChat(id).catch(() => []);
  renderChat();
  S.unwatch = S.store.watchScript(id, onRemoteChange);
}

async function createScript(text, nameHint) {
  const a = analyze(text);
  const title = a.meta.title || nameHint || "Untitled";
  const id = slug(title) + "-" + uid().slice(0, 4);
  await S.store.saveScript(id, { title, text });
  await refreshScripts();
  await openScript(id);
  toast(`Opened ${title}`);
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "script";

function onDocChange() {
  S.dirty = true;
  setStatus("Editing", true);
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(save, 1200);
  clearTimeout(S.anTimer);
  S.anTimer = setTimeout(runAnalysis, 250);
}

async function save() {
  if (!S.id || !S.view) return;
  if (S.saving) { await S.saving; }
  const text = S.view.state.doc.toString();
  if (text === S.lastSaved) { S.dirty = false; setStatus("Saved"); return; }
  const title = analyze(text).meta.title || S.title || "Untitled";
  setStatus("Saving", true);
  S.saving = S.store.saveScript(S.id, { title, text })
    .then(() => {
      S.lastSaved = text;
      if (S.view.state.doc.toString() === text) { S.dirty = false; setStatus("Saved"); }
      if (title !== S.title) { S.title = title; refreshScripts(); }
    })
    .catch((e) => setStatus(e?.code === "quota_exceeded" ? "Storage full" : "Not saved", true))
    .finally(() => { S.saving = null; });
  await S.saving;
}

async function flushSave() {
  clearTimeout(S.saveTimer);
  if (S.dirty) await save();
}

function onRemoteChange(doc) {
  if (!S.view || doc.id !== S.id) return;
  const current = S.view.state.doc.toString();
  if (doc.text === current || doc.text === S.lastSaved) return;
  if (!S.dirty) {
    replaceDoc(S.view, doc.text);
    S.lastSaved = doc.text;
    S.dirty = false;
    setStatus("Updated from chat");
    toast("Script updated from your Claude chat");
    return;
  }
  const b = $("banner");
  b.innerHTML = `<span style="flex:1;min-width:12ch">A newer version of this script was saved from chat.</span><button class="btn" id="bnLoad">Load it</button><button class="btn" id="bnKeep">Keep mine</button>`;
  b.hidden = false;
  $("bnLoad").onclick = () => { replaceDoc(S.view, doc.text); S.lastSaved = doc.text; S.dirty = false; setStatus("Saved"); b.hidden = true; };
  $("bnKeep").onclick = () => { b.hidden = true; save(); };
}

function setStatus(t, warn) {
  const el = $("status");
  el.textContent = t;
  el.classList.toggle("dirty", !!warn);
}

// ---------------------------------------------------------------- breakdown
function runAnalysis() {
  if (!S.view) return;
  S.analysis = analyze(S.view.state.doc.toString());
  renderBreakdown();
}

function renderBreakdown() {
  const a = S.analysis;
  if (!a) return;
  const runtime = a.pages ? `${a.pages}` : "0";
  $("bdBadge").textContent = `${a.pages} pp`;
  $("bdTitle").textContent = a.meta.title ? `Breakdown · ${a.meta.title}` : "Breakdown";
  $("bdStats").innerHTML = [
    [a.pages, "pages"],
    [a.scenes.length, "scenes"],
    [a.characters.length, "speaking"],
    [`~${runtime}m`, "runtime"],
  ].map(([v, l]) => `<div class="bd-stat"><b>${esc(v)}</b><span>${l}</span></div>`).join("");

  $("bdTabScenes").setAttribute("aria-selected", S.bdTab === "scenes");
  $("bdTabChars").setAttribute("aria-selected", S.bdTab === "chars");

  const body = $("bdBody");
  if (S.bdTab === "scenes") {
    body.innerHTML = a.scenes.length
      ? `<ul class="bd-list">${a.scenes.map((s) => `
        <li><button data-line="${s.line}">
          <span class="num">${esc(s.number)}</span>
          <span class="hd">${esc(s.heading)}</span>
          <span class="meta">p${s.page} · ${formatEighths(s.eighths)}</span>
          ${s.characters.length ? `<span class="sub">${esc(s.characters.map(title).join(", "))}</span>` : ""}
        </button></li>`).join("")}</ul>
        <p class="bd-note">Pages are estimated at 55 lines per page. Scene lengths are in eighths of a page.</p>`
      : `<p class="bd-note">No scene headings yet. Start a line with INT. or EXT. after a blank line.</p>`;
  } else {
    body.innerHTML = a.characters.length
      ? `<ul class="bd-list">${a.characters.map((c, i) => `
        <li><button data-line="${c.firstLine}">
          <span class="num">${i + 1}</span>
          <span class="hd">${esc(c.name)}</span>
          <span class="meta">${c.speeches} lines · ${c.words}w</span>
          <span class="sub">${c.scenes} scene${c.scenes === 1 ? "" : "s"}, first speaks in sc. ${c.firstScene + 1 || "?"}</span>
        </button></li>`).join("")}</ul>
        <p class="bd-note">Listed by first line of dialogue. ${a.dialogueWords} of ${a.wordCount} words are dialogue.</p>`
      : `<p class="bd-note">No speaking characters yet.</p>`;
  }
}

const title = (n) => n.charAt(0) + n.slice(1).toLowerCase();

// ---------------------------------------------------------------- selection + rewrite
function selectionInfo() {
  if (!S.view) return null;
  const sel = S.view.state.selection.main;
  if (sel.empty) return null;
  const text = S.view.state.sliceDoc(sel.from, sel.to);
  if (!text.trim()) return null;
  return { from: sel.from, to: sel.to, text };
}

function sceneAt(pos) {
  const a = S.analysis;
  if (!a || !S.view) return null;
  const line = S.view.state.doc.lineAt(pos).number - 1;
  let found = null;
  for (const s of a.scenes) if (s.line <= line) found = s;
  return found;
}

// Show the Rewrite chip only once a selection settles: not mid-drag, and not
// on every Shift+arrow press.
let chipTimer = 0;
function onSelection() {
  const info = selectionInfo();
  updateFocusChip(info);
  const chip = $("chipRewrite");
  clearTimeout(chipTimer);
  if (!info || !$("pop").hidden || S.dragging) { chip.hidden = true; return; }
  chipTimer = setTimeout(placeChip, 160);
}

function placeChip() {
  const info = selectionInfo();
  const chip = $("chipRewrite");
  if (!info || S.dragging || !$("pop").hidden) { chip.hidden = true; return; }
  const head = S.view.state.selection.main.head;
  const upward = head === info.from;
  const coords = S.view.coordsAtPos(head, upward ? 1 : -1);
  if (!coords) { chip.hidden = true; return; }
  const box = $("desk").getBoundingClientRect();
  chip.hidden = false;
  const cw = chip.offsetWidth, ch = chip.offsetHeight;
  let top = upward ? coords.top - box.top - ch - 8 : coords.bottom - box.top + 8;
  if (top < 8) top = coords.bottom - box.top + 8;
  if (top > box.height - ch - 8) top = coords.top - box.top - ch - 8;
  if (top < 8 || top > box.height - ch - 8) { chip.hidden = true; return; }
  chip.style.left = Math.max(8, Math.min(coords.left - box.left - cw / 2, box.width - cw - 8)) + "px";
  chip.style.top = top + "px";
}

// Rewrites work on clean units: whole lines when the selection spans lines,
// whole words inside a single line.
function snapRange(from, to) {
  const doc = S.view.state.doc;
  const a = doc.lineAt(from), b = doc.lineAt(Math.max(from, to - 1));
  if (a.number !== b.number) {
    return { from: a.from, to: b.to };
  }
  const text = a.text;
  let s = from - a.from, e = to - a.from;
  while (s > 0 && /\S/.test(text[s - 1])) s--;
  while (e < text.length && /\S/.test(text[e])) e++;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (e - s >= text.trim().length) return { from: a.from, to: a.to };
  return { from: a.from + s, to: a.from + e };
}

function updateFocusChip(info) {
  const fc = $("focusChip");
  if (!info) { fc.hidden = true; return; }
  const lines = info.text.split("\n").filter((l) => l.trim()).length;
  const sc = sceneAt(info.from);
  $("focusText").textContent = `Selected: ${lines} line${lines === 1 ? "" : "s"}${sc ? " in " + sc.heading : ""}`;
  fc.hidden = false;
}

function openPopover() {
  const raw = selectionInfo();
  if (!raw) { toast("Highlight part of the script first"); return; }
  clearTimeout(chipTimer);
  const r = snapRange(raw.from, raw.to);
  const info = { ...r, text: S.view.state.sliceDoc(r.from, r.to) };
  // Mark exactly what will be sent, and keep it marked while you type the direction.
  S.view.dispatch({
    selection: { anchor: info.from, head: info.to },
    effects: [clearPending.of("draft"), setPending.of({ id: "draft", from: info.from, to: info.to })],
  });
  const chip = $("chipRewrite");
  const pop = $("pop");
  pop.hidden = false;
  chip.hidden = true;
  const box = $("desk").getBoundingClientRect();
  const end = S.view.coordsAtPos(info.to, -1) || { left: box.left + 40, top: box.top + 60, bottom: box.top + 80 };
  const start = S.view.coordsAtPos(info.from, 1) || end;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let top = end.bottom - box.top + 10;
  if (top + ph > box.height - 8) top = start.top - box.top - ph - 10;
  top = Math.max(8, Math.min(top, box.height - ph - 8));
  pop.style.left = Math.max(8, Math.min(end.left - box.left - pw / 2, box.width - pw - 8)) + "px";
  pop.style.top = top + "px";
  S.popSel = info;
  $("popQuote").textContent = info.text.trim();
  $("popText").value = "";
  updatePopButton();
  $("popText").focus();
}

function popCount() { return +($("pop").querySelector('.seg [aria-checked="true"]')?.dataset.n || 3); }
function updatePopButton() {
  const has = !!$("popText").value.trim();
  $("popGo").textContent = has ? (popCount() === 1 ? "Rewrite" : "Get 3 takes") : "Surprise me";
}

function closePopover(keepDraft) {
  $("pop").hidden = true;
  S.popSel = null;
  if (!keepDraft && S.view) S.view.dispatch({ effects: clearPending.of("draft") });
}

async function requestRewrite(instruction, existing, count) {
  // existing: {pendingId, original} when refining an earlier round
  let pendingId, original;
  if (existing) {
    pendingId = existing.pendingId;
    const r = getPending(S.view, pendingId);
    if (!r) { toast("That passage was removed"); return; }
    original = S.view.state.sliceDoc(r.from, r.to);
  } else {
    const draft = getPending(S.view, "draft");
    const info = draft || S.popSel || selectionInfo();
    if (!info) return;
    count = popCount();
    closePopover(true);
    pendingId = uid();
    original = S.view.state.sliceDoc(info.from, info.to);
    S.view.dispatch({ effects: [clearPending.of("draft"), setPending.of({ id: pendingId, from: info.from, to: info.to })] });
  }
  showPane("chat");

  const r = getPending(S.view, pendingId);
  const doc = S.view.state.doc;
  const before = doc.sliceString(Math.max(0, r.from - 600), r.from);
  const after = doc.sliceString(r.to, Math.min(doc.length, r.to + 400));
  const sc = sceneAt(r.from);

  const prev = existing ? S.turns.filter((t) => t.kind === "options" && t.pendingId === pendingId).pop() : null;
  count = count || prev?.count || 3;
  const userTurn = {
    role: "user", kind: "rewrite", pendingId, quote: original, scene: sc?.heading || "",
    content: `Rewrite${sc ? " in " + sc.heading : ""}: ${instruction || "your own takes"}`,
  };
  S.turns.push(userTurn);
  const asstTurn = { role: "assistant", kind: "options", pendingId, original, options: null, pending: true, content: "", count };
  S.turns.push(asstTurn);
  renderChat();

  const prompt = rewriteTurn({
    selected: original, before, after, instruction, count,
    previous: prev?.options ? prev.options.map((o, i) => `${i + 1}. ${o.label}\n${o.text}`).join("\n\n") : "",
  });
  const turns = buildTurns(prompt, { forRewrite: true });

  await withClaude(async (signal) => {
    const res = await S.claude.askJSON(turns, { signal, tier: S.settings.tier });
    const options = (res?.options || []).filter((o) => o && typeof o.text === "string").slice(0, count).map((o) => ({
      label: String(o.label || "Option"), note: String(o.note || ""), text: fitWhitespace(original, o.text),
    }));
    if (!options.length) throw { code: "invalid_json" };
    asstTurn.options = options;
    asstTurn.content = "Options offered:\n" + options.map((o, i) => `${i + 1}. ${o.label}: ${o.text}`).join("\n\n");
  }, asstTurn);
  asstTurn.pending = false;
  renderChat();
  persistChat();
}

// Keep the selection's leading and trailing whitespace so applied text fits.
function fitWhitespace(original, text) {
  const lead = /^\s*/.exec(original)[0];
  const trail = /\s*$/.exec(original)[0];
  return lead + text.replace(/^\s+|\s+$/g, "") + trail;
}

function applyOption(turn, i) {
  const r = getPending(S.view, turn.pendingId);
  if (!r) { toast("That passage is gone from the script"); return; }
  const text = turn.options[i].text;
  S.view.dispatch({
    changes: { from: r.from, to: r.to, insert: text },
    effects: clearPending.of(turn.pendingId),
    selection: { anchor: r.from, head: r.from + text.length },
    scrollIntoView: true,
  });
  turn.applied = i;
  S.turns.filter((t) => t.pendingId === turn.pendingId && t.kind === "options").forEach((t) => (t.closed = true));
  renderChat();
  persistChat();
  toast(`Applied "${turn.options[i].label}". Undo with ⌘Z.`);
}

function dismissOptions(turn) {
  S.view.dispatch({ effects: clearPending.of(turn.pendingId) });
  S.turns.filter((t) => t.pendingId === turn.pendingId && t.kind === "options").forEach((t) => (t.closed = true));
  renderChat();
  persistChat();
}

// ---------------------------------------------------------------- chat
function buildTurns(finalUser, { forRewrite } = {}) {
  const text = S.view ? S.view.state.doc.toString() : "";
  const info = forRewrite ? null : selectionInfo();
  const rules = rulesTurn({ text, styleNotes: S.settings.styleNotes, focus: info?.text });
  const history = S.turns
    .filter((t) => t.content && !t.pending && !t.failed)
    .map((t) => ({ role: t.role, content: t.kind === "rewrite" ? `${t.content}\nPassage:\n${t.quote}` : t.content }));
  // the last element is usually the turn we're answering; drop it, we pass finalUser instead
  if (history.length && history[history.length - 1].role === "user") history.pop();
  let turns = [{ role: "user", content: rules }, ...history, { role: "user", content: finalUser }];
  let size = turns.reduce((n, t) => n + t.content.length, 0);
  while (size > MAX_PROMPT && turns.length > 2) {
    const [gone] = turns.splice(1, 1);
    size -= gone.content.length;
  }
  return turns;
}

async function sendChat() {
  const input = $("input");
  const text = input.value.trim();
  if (!text || S.busy) return;
  if (!S.view) { toast("Open a script first"); return; }
  input.value = "";
  autoGrow();
  const info = selectionInfo();
  const userTurn = { role: "user", content: text };
  if (info) userTurn.quote = info.text;
  S.turns.push(userTurn);
  const asst = { role: "assistant", content: "", pending: true };
  S.turns.push(asst);
  renderChat();
  const turns = buildTurns(text);
  await withClaude(async (signal) => {
    asst.content = await S.claude.ask(turns, {
      signal, tier: S.settings.tier,
      onText: ({ text }) => { asst.content = text; renderTurn(asst); },
    });
  }, asst);
  asst.pending = false;
  renderChat();
  persistChat();
}

async function withClaude(fn, turn) {
  if (!S.claude) {
    turn.failed = true;
    turn.error = S.claudeChecked ? "Claude isn't reachable from this view. Open the page inside claude.ai to use chat and rewrites." : "Connecting to Claude. Try again in a moment.";
    return;
  }
  const ctl = new AbortController();
  S.busy = ctl;
  updateSendButton();
  try { await fn(ctl.signal); }
  catch (e) {
    turn.failed = true;
    if (e?.text) turn.content = e.text;
    turn.error = errorCopy(e);
    if (e?.code === "cancelled") turn.error = "Stopped.";
  } finally {
    S.busy = null;
    updateSendButton();
  }
}

function updateSendButton() {
  const b = $("btnSend");
  b.textContent = S.busy ? "Stop" : "Send";
  b.classList.toggle("primary", !S.busy);
}

function persistChat() {
  if (!S.id) return;
  const keep = S.turns.filter((t) => !t.pending).slice(-MAX_TURNS).map((t) => {
    const c = { ...t };
    delete c.el;
    if (c.content && c.content.length > 12000) c.content = c.content.slice(0, 12000);
    return c;
  });
  S.store.saveChat(S.id, keep).catch(() => {});
}

function renderChat() {
  const log = $("log");
  log.innerHTML = "";
  if (!S.turns.length) {
    const intro = document.createElement("div");
    intro.className = "msg system";
    intro.innerHTML = `<div class="body">${
      S.view
        ? `<p>Ask anything about the script, or ask for changes. Proposed edits arrive as cards you can apply.</p><p>To rework a passage, highlight it, press <b>Rewrite with Claude</b> (⌘K), and tell Claude what you want. Choose one take or three, then apply, redirect or dismiss.</p>`
        : `<p>Open a script to start.</p>`
    }${S.claudeChecked && !S.claude ? `<p class="err">Claude isn't reachable from this view. Editing still works; chat and rewrites need the page open in claude.ai.</p>` : ""}</div>`;
    log.append(intro);
  }
  for (const t of S.turns) { t.el = null; log.append(renderTurn(t)); }
  log.scrollTop = log.scrollHeight;
}

function renderTurn(t) {
  const el = t.el || document.createElement("div");
  const fresh = !t.el;
  t.el = el;
  el.className = `msg ${t.role}`;
  let html = `<div class="who">${t.role === "user" ? "You" : "Claude"}</div>`;

  if (t.role === "user") {
    html += t.quote ? `<div class="quote">${esc(t.quote.trim())}</div>` : "";
    html += `<div class="body">${esc(t.content)}</div>`;
    el.innerHTML = html;
    return el;
  }

  if (t.kind === "options") {
    if (t.pending && !t.failed) html += `<div class="body thinking">${t.count === 1 ? "Rewriting…" : "Writing " + (t.count || 3) + " takes…"}</div>`;
    if (t.options) {
      html += t.options.map((o, i) => `
        <div class="card">
          <div class="card-head"><b>${esc(o.label)}</b><span class="tag">Option ${i + 1}</span></div>
          ${o.note ? `<div class="note">${esc(o.note)}</div>` : ""}
          <pre>${esc(o.text.trim())}</pre>
          <div class="card-actions">
            ${t.applied === i ? `<span class="done">Applied</span>` : t.closed ? "" : `<button class="btn primary" data-act="apply" data-i="${i}">Apply</button>`}
          </div>
        </div>`).join("");
      if (!t.closed) {
        html += `<div class="refine"><input type="text" id="refine-${t.pendingId}-${S.turns.indexOf(t)}" placeholder="New direction, e.g. take 2 but quieter" data-act="refine-input"><button class="btn" data-act="refine">Again</button><button class="btn ghost" data-act="dismiss">Dismiss</button></div>`;
      }
    }
    if (t.error) html += `<div class="err">${esc(t.error)}</div>`;
    el.innerHTML = html;
    el.querySelectorAll("[data-act='apply']").forEach((b) => (b.onclick = () => applyOption(t, +b.dataset.i)));
    const inp = el.querySelector("[data-act='refine-input']");
    const go = () => { const v = inp.value.trim(); requestRewrite(v || "Try a new round of options.", { pendingId: t.pendingId }); };
    el.querySelector("[data-act='refine']")?.addEventListener("click", go);
    inp?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    el.querySelector("[data-act='dismiss']")?.addEventListener("click", () => dismissOptions(t));
    return el;
  }

  // plain assistant reply, possibly with edit blocks
  if (t.pending && !t.content) {
    html += `<div class="body thinking">Thinking…</div>`;
    el.innerHTML = html;
    return el;
  }
  let shown = t.content;
  let drafting = false;
  if (t.pending) {
    const open = shown.lastIndexOf("<edit>");
    if (open > shown.lastIndexOf("</edit>")) { shown = shown.slice(0, open); drafting = true; }
  }
  const { edits, parts } = parseEdits(shown);
  t.applied = t.applied || {};
  html += `<div class="body">`;
  for (const p of parts) {
    if (p.kind === "text") html += md(p.text);
    else html += editCard(edits[p.index], p.index, t);
  }
  if (drafting) html += `<p class="thinking">Drafting an edit…</p>`;
  html += `</div>`;
  if (!t.pending && edits.length > 1) {
    const open = edits.filter((_, i) => !t.applied[i]).length;
    if (open > 1) html += `<div><button class="btn" data-act="apply-all">Apply all ${open} edits</button></div>`;
  }
  if (t.error) html += `<div class="err">${esc(t.error)}</div>`;
  el.innerHTML = html;
  el.querySelectorAll("[data-act='edit']").forEach((b) => (b.onclick = () => applyEdit(t, edits, +b.dataset.i)));
  el.querySelector("[data-act='apply-all']")?.addEventListener("click", () => edits.forEach((_, i) => !t.applied[i] && applyEdit(t, edits, i, true)));
  if (!fresh) { const log = $("log"); if (log.scrollHeight - log.scrollTop - log.clientHeight < 140) log.scrollTop = log.scrollHeight; }
  return el;
}

function editCard(e, i, t) {
  const state = t.applied[i];
  const removed = e.find.trim();
  const added = e.replace.trim();
  return `<div class="card">
    <div class="card-head"><b>${esc(e.note || "Proposed edit")}</b><span class="tag">Edit</span></div>
    <pre>${removed ? `<del>${esc(removed)}</del>\n` : ""}${added ? esc(added) : "<i>(delete)</i>"}</pre>
    <div class="card-actions">${
      state === "done" ? `<span class="done">Applied</span>`
      : state === "miss" ? `<span class="miss">Couldn't find that text in the script. It may have changed.</span>`
      : t.pending ? "" : `<button class="btn primary" data-act="edit" data-i="${i}">Apply</button>`
    }</div></div>`;
}

function applyEdit(t, edits, i, quiet) {
  const e = edits[i];
  const doc = S.view.state.doc.toString();
  let at = doc.indexOf(e.find);
  let len = e.find.length;
  if (at < 0) {
    // tolerate trailing spaces and line ending differences
    const norm = (s) => s.replace(/[ \t]+$/gm, "");
    const nd = norm(doc), nf = norm(e.find);
    const k = nd.indexOf(nf);
    if (k >= 0 && nd === doc) { at = k; len = nf.length; }
  }
  if (at < 0 || !e.find) { t.applied[i] = "miss"; renderTurn(t); return; }
  S.view.dispatch({ changes: { from: at, to: at + len, insert: e.replace }, selection: { anchor: at, head: at + e.replace.length }, scrollIntoView: true });
  t.applied[i] = "done";
  renderTurn(t);
  persistChat();
  if (!quiet) toast("Edit applied. Undo with ⌘Z.");
}

// tiny markdown: paragraphs, bullets, numbered lists, bold, italics, code
function md(src) {
  const blocks = src.trim().split(/\n{2,}/);
  return blocks.map((b) => {
    const lines = b.split("\n");
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>`).join("")}</ul>`;
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
    return b.trim() ? `<p>${lines.map(inline).join("<br>")}</p>` : "";
  }).join("");
}
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<i>$2</i>")
    .replace(/^#{1,4}\s+(.*)$/, "<b>$1</b>");
}

// ---------------------------------------------------------------- export, revisions, settings
async function exportScript() {
  if (!S.view) return;
  await flushSave();
  const text = S.view.state.doc.toString();
  const name = (slug(S.title) || "script") + ".fountain";
  const downloads = window.claude ? await window.claude.use("downloads") : null;
  if (downloads) {
    try { await downloads.save({ filename: name, data: text }); toast("Saved to your computer"); return; }
    catch (e) {
      if (e?.code === "declined") return;
      if (e?.code === "rejected_extension") {
        try { await downloads.save({ filename: name.replace(/\.fountain$/, ".txt"), data: text }); toast("Saved as .txt. Rename it to .fountain."); return; } catch {}
      }
    }
  }
  try { await navigator.clipboard.writeText(text); toast("Copied the script to your clipboard"); }
  catch { toast("Export isn't available here. Select all in the script and copy."); }
}

async function openRevisions() {
  const p = $("revPanel");
  if (!p.hidden) { p.hidden = true; $("btnRevisions").setAttribute("aria-pressed", "false"); return; }
  $("settingsPanel").hidden = true; $("btnSettings").setAttribute("aria-pressed", "false");
  $("btnRevisions").setAttribute("aria-pressed", "true");
  p.hidden = false;
  p.innerHTML = `<h3>Revisions <button class="bd-close" id="revClose" aria-label="Close">×</button></h3><p class="hint">Loading…</p>`;
  $("revClose").onclick = openRevisions;
  if (!S.id) { p.querySelector(".hint").textContent = "Open a script first."; return; }
  const revs = await S.store.listRevisions(S.id).catch(() => []);
  const next = REVISION_COLORS[revs.length % REVISION_COLORS.length];
  p.innerHTML = `<h3>Revisions <button class="bd-close" id="revClose" aria-label="Close">×</button></h3>
    <p class="hint">A revision is a snapshot you can return to. They follow the industry color order, so the next one is ${next[0]}.</p>
    <div style="display:flex;gap:6px"><button class="btn primary" id="revSave">Save ${next[0]} revision</button></div>
    ${revs.length ? `<ul class="rev-list">${revs.map((r) => `
      <li><span class="swatch" style="background:${esc(r.colorHex || "#fff")}"></span>
      <div><div>${esc(r.label)}</div><div class="when">${new Date(r.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${analyze(r.text).pages} pp</div></div>
      <button class="btn" data-rev="${esc(r.id)}">Restore</button></li>`).join("")}</ul>` : `<p class="hint">No revisions saved yet.</p>`}`;
  $("revClose").onclick = openRevisions;
  $("revSave").onclick = async () => {
    await flushSave();
    const label = `${next[0]} revision`;
    await S.store.addRevision(S.id, { label, color: next[0], colorHex: next[1], text: S.view.state.doc.toString() });
    toast(`Saved ${label}`);
    p.hidden = true; openRevisions();
  };
  p.querySelectorAll("[data-rev]").forEach((b) => (b.onclick = async () => {
    const r = revs.find((x) => x.id === b.dataset.rev);
    if (!r) return;
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Replace current?"; return; }
    replaceDoc(S.view, r.text);
    toast(`Restored ${r.label}. Undo with ⌘Z.`);
  }));
}

function openSettings() {
  const p = $("settingsPanel");
  if (!p.hidden) { p.hidden = true; $("btnSettings").setAttribute("aria-pressed", "false"); return; }
  $("revPanel").hidden = true; $("btnRevisions").setAttribute("aria-pressed", "false");
  $("btnSettings").setAttribute("aria-pressed", "true");
  p.hidden = false;
  p.innerHTML = `<h3>Settings <button class="bd-close" id="setClose" aria-label="Close">×</button></h3>
    <div class="field"><label for="setStyle">Style notes Claude follows</label>
      <textarea id="setStyle" placeholder="Lean, understated action lines. No em dashes.">${esc(S.settings.styleNotes || "")}</textarea></div>
    <div class="field"><label for="setTier">Model</label>
      <select id="setTier">
        <option value="quick">Fast (short rewrites, quick questions)</option>
        <option value="default">Balanced</option>
        <option value="complex">Most capable (structure, big notes)</option>
      </select></div>
    <p class="hint">Saved with your scripts. Storage: ${S.store?.kind === "db" ? "this page's database, readable by Claude in your chats" : "this browser only"}.</p>
    <div style="display:flex;gap:6px;justify-content:space-between;flex-wrap:wrap">
      <button class="btn primary" id="setSave">Save settings</button>
      ${S.id ? `<button class="btn ghost" id="setDelete">Delete this script</button>` : ""}
    </div>`;
  $("setTier").value = S.settings.tier || "default";
  $("setClose").onclick = openSettings;
  $("setSave").onclick = async () => {
    S.settings = { ...S.settings, styleNotes: $("setStyle").value.trim(), tier: $("setTier").value };
    await S.store.saveSettings(S.settings).catch(() => {});
    toast("Settings saved");
    openSettings();
  };
  const del = $("setDelete");
  if (del) del.onclick = async () => {
    if (del.dataset.confirm !== "1") { del.dataset.confirm = "1"; del.textContent = `Delete "${S.title}" for good?`; return; }
    S.unwatch?.();
    await S.store.deleteScript(S.id).catch(() => {});
    S.id = null; S.dirty = false; S.turns = [];
    await refreshScripts();
    openSettings();
    if (S.scripts.length) openScript(S.scripts[0].id); else { showEmpty(); renderChat(); }
  };
}

// ---------------------------------------------------------------- misc UI
let toastTimer;
function toast(t) {
  const el = $("toast");
  el.textContent = t;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function showPane(which) {
  $("panes").dataset.show = which;
  $("tabScript").setAttribute("aria-pressed", which === "script");
  $("tabChat").setAttribute("aria-pressed", which === "chat");
}

function autoGrow() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 180) + "px";
}

function bindUI() {
  $("scriptSelect").onchange = (e) => e.target.value && openScript(e.target.value);
  const openFile = () => $("fileInput").click();
  $("btnOpen").onclick = openFile;
  $("emptyOpen").onclick = openFile;
  $("fileInput").onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    e.target.value = "";
    createScript(text, f.name.replace(/\.[^.]+$/, ""));
  };
  const newScript = () => createScript(NEW_SCRIPT, "Untitled");
  $("btnNew").onclick = newScript;
  $("emptyNew").onclick = newScript;
  $("btnExport").onclick = exportScript;
  $("btnRevisions").onclick = openRevisions;
  $("btnSettings").onclick = openSettings;

  const toggleBd = (on) => {
    $("btnBreakdown").setAttribute("aria-pressed", on);
    $("breakdown").hidden = !on || !S.view || $("sheet").hidden;
    try { localStorage.setItem("fountain-studio:bd", on ? "1" : "0"); } catch {}
  };
  let bdPref = "1";
  try { bdPref = localStorage.getItem("fountain-studio:bd") ?? "1"; } catch {}
  $("btnBreakdown").setAttribute("aria-pressed", bdPref === "1");
  $("btnBreakdown").onclick = () => toggleBd($("btnBreakdown").getAttribute("aria-pressed") !== "true");
  $("bdClose").onclick = () => toggleBd(false);
  $("bdTabScenes").onclick = () => { S.bdTab = "scenes"; renderBreakdown(); };
  $("bdTabChars").onclick = () => { S.bdTab = "chars"; renderBreakdown(); };
  $("bdBody").onclick = (e) => {
    const b = e.target.closest("[data-line]");
    if (b && S.view) { scrollToLine(S.view, +b.dataset.line); showPane("script"); }
  };

  $("chipRewrite").onmousedown = (e) => e.preventDefault();
  $("chipRewrite").onclick = openPopover;
  $("popCancel").onclick = () => { closePopover(); S.view?.focus(); };
  $("popGo").onclick = () => requestRewrite($("popText").value.trim());
  $("popText").addEventListener("input", updatePopButton);
  $("pop").querySelector(".seg").onclick = (e) => {
    const b = e.target.closest("[data-n]");
    if (!b) return;
    $("pop").querySelectorAll(".seg [data-n]").forEach((x) => x.setAttribute("aria-checked", x === b));
    updatePopButton();
  };
  $("popText").onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); requestRewrite($("popText").value.trim()); }
    if (e.key === "Escape") { closePopover(); S.view?.focus(); }
  };
  $("popQuick").onclick = (e) => {
    const b = e.target.closest("[data-q]");
    if (!b) return;
    const t = $("popText");
    const cur = t.value.trim();
    t.value = cur ? (cur.endsWith(".") ? cur + " " : cur + ". ") + b.dataset.q : b.dataset.q;
    updatePopButton();
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  };

  $("btnSend").onclick = () => (S.busy ? S.busy.abort() : sendChat());
  $("input").oninput = autoGrow;
  $("input").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } };
  $("btnClearChat").onclick = () => { S.turns = []; renderChat(); persistChat(); };
  $("tabScript").onclick = () => showPane("script");
  $("tabChat").onclick = () => showPane("chat");

  $("deskScroll").addEventListener("scroll", () => { if (!$("chipRewrite").hidden) placeChip(); }, { passive: true });
  $("sheet").addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (!$("pop").hidden) closePopover();
    S.dragging = true;
    $("chipRewrite").hidden = true;
  });
  window.addEventListener("pointerup", () => { if (S.dragging) { S.dragging = false; onSelection(); } });
  window.addEventListener("pointercancel", () => { S.dragging = false; });
  window.addEventListener("beforeunload", () => { if (S.dirty) save(); });
}

boot();
