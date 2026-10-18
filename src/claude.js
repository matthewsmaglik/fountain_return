// Claude adapters. The app only talks to this interface:
//   { kind, available, ask(turns, opts), askJSON(turns, opts) }
// turns: [{role: "user"|"assistant", content}] starting and ending on "user".
// opts:  { onText({text}), signal, tier: "quick"|"default"|"complex" }
//
// artifactClaude: runs inside a claude.ai Artifact on the viewer's own Claude
//   account through the `sample` capability. No API key, no server.
// apiClaude: runs anywhere else (local dev, a desktop wrapper) with an
//   Anthropic API key, calling the Messages API from the browser.

export async function artifactClaude() {
  const sample = window.claude ? await window.claude.use("sample") : null;
  if (!sample) return null;
  const opts = (o = {}) => {
    const out = { cache: false };
    if (o.onText) out.onText = o.onText;
    if (o.signal) out.signal = o.signal;
    if (o.tier) out.modelTier = o.tier;
    return out;
  };
  return {
    kind: "artifact",
    ask: (turns, o) => sample(turns, opts(o)).then((r) => r.text),
    askJSON: (turns, o) => sample.json(turns, opts(o)),
  };
}

const API_MODELS = { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-opus-5-5" };

export function apiClaude(apiKey) {
  async function call(turns, o = {}) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: o.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: API_MODELS[o.tier || "default"],
        max_tokens: 8000,
        stream: true,
        messages: turns,
      }),
    });
    if (!res.ok) throw { code: "upstream_error", message: `API ${res.status}: ${await res.text()}` };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = "", buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const p of parts) {
        const line = p.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "content_block_delta" && ev.delta?.text) {
          text += ev.delta.text;
          o.onText?.({ text, delta: ev.delta.text });
        }
      }
    }
    return text;
  }
  return {
    kind: "api",
    ask: call,
    async askJSON(turns, o) {
      const text = await call(turns, o);
      return extractJSON(text);
    },
  };
}

export function extractJSON(text) {
  try { return JSON.parse(text); } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = text.search(/[\[{]/), b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
  throw { code: "invalid_json", message: "No JSON in reply", text };
}

export function errorCopy(e) {
  switch (e?.code) {
    case "not_granted": return "Claude is not allowed on this page. Allow it from the page's Permissions menu to use chat and rewrites.";
    case "sampling_disabled": return "Claude isn't available for this account.";
    case "rate_limited": return "You've hit a usage limit. Try again in a little while.";
    case "session_expired": return "Your session expired. Sign in again, then retry.";
    case "prompt_too_large": return "The script plus this conversation is too long to send. Clear the chat and try again.";
    case "refused": return "Claude declined that request. Try rephrasing it.";
    case "invalid_json": return "The reply came back in the wrong shape. Try again.";
    case "empty_completion": return "Claude returned nothing. Try asking a different way.";
    case "cancelled": return "";
    default: return "Something went wrong reaching Claude. Try again.";
  }
}
