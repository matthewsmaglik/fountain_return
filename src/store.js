// Storage adapters. The app only uses this interface:
//   listScripts() -> [{id, title, updatedAt}]
//   loadScript(id) -> {id, title, text, updatedAt, source} | null
//   saveScript(id, {title, text})
//   watchScript(id, cb) -> unsubscribe     (remote changes, e.g. from Claude in chat)
//   deleteScript(id)
//   listRevisions(scriptId) / addRevision(scriptId, {label, color, text})
//   loadChat(scriptId) / saveChat(scriptId, turns)
//   loadSettings() / saveSettings(obj)
//
// dbStore: the Artifact `db` capability. Claude can read and write the same
//   documents from a regular chat, which is how the chat window and the page
//   stay in step.
// localStore: browser storage, for running the page outside claude.ai.

export async function dbStore() {
  const db = window.claude ? await window.claude.use("db") : null;
  if (!db) return null;
  const safe = (p) => p.catch((e) => { console.warn("db", e); throw e; });
  return {
    kind: "db",
    async listScripts() {
      const snap = await safe(db.collection("scripts").get());
      return snap.docs
        .map((d) => ({ id: d.id, title: d.data().title, updatedAt: d.data().updatedAt || 0 }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async loadScript(id) {
      const s = await safe(db.doc(`scripts/${id}`).get());
      return s.exists ? { id, ...s.data() } : null;
    },
    saveScript: (id, data) => safe(db.doc(`scripts/${id}`).set({ ...data, updatedAt: Date.now(), source: "editor" })),
    deleteScript: (id) => safe(db.doc(`scripts/${id}`).delete()),
    watchScript(id, cb) {
      return db.doc(`scripts/${id}`).onSnapshot(
        (s) => { if (s.exists && !s.metadata.hasPendingWrites) cb({ id, ...s.data() }); },
        (e) => console.warn("watch", e),
      );
    },
    async listRevisions(scriptId) {
      const snap = await safe(db.collection("revisions").where("scriptId", "==", scriptId).get());
      return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.at - a.at);
    },
    addRevision: (scriptId, r) => safe(db.collection("revisions").add({ scriptId, ...r, at: Date.now() })),
    async loadChat(scriptId) {
      const s = await safe(db.doc(`chats/${scriptId}`).get());
      return s.exists ? s.data().turns || [] : [];
    },
    saveChat: (scriptId, turns) => safe(db.doc(`chats/${scriptId}`).set({ turns, updatedAt: Date.now() })),
    async loadSettings() {
      const s = await safe(db.doc("settings/main").get());
      return s.exists ? s.data() : {};
    },
    saveSettings: (obj) => safe(db.doc("settings/main").set(obj)),
  };
}

export function localStore() {
  const K = "fountain-studio:";
  const get = (k, d) => { try { const v = localStorage.getItem(K + k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const put = (k, v) => { try { localStorage.setItem(K + k, JSON.stringify(v)); } catch {} };
  return {
    kind: "local",
    async listScripts() {
      return Object.values(get("scripts", {})).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async loadScript(id) { return get("scripts", {})[id] || null; },
    async saveScript(id, data) { const all = get("scripts", {}); all[id] = { id, ...data, updatedAt: Date.now() }; put("scripts", all); },
    async deleteScript(id) { const all = get("scripts", {}); delete all[id]; put("scripts", all); },
    watchScript() { return () => {}; },
    async listRevisions(scriptId) { return get("rev:" + scriptId, []); },
    async addRevision(scriptId, r) { const list = get("rev:" + scriptId, []); list.unshift({ id: String(Date.now()), scriptId, ...r, at: Date.now() }); put("rev:" + scriptId, list.slice(0, 50)); },
    async loadChat(scriptId) { return get("chat:" + scriptId, []); },
    async saveChat(scriptId, turns) { put("chat:" + scriptId, turns); },
    async loadSettings() { return get("settings", {}); },
    async saveSettings(obj) { put("settings", obj); },
  };
}
