# Architecture

## The core idea

The script is always plain Fountain text. Everything else (page layout, the breakdown, Claude's edits) is derived from or applied to that text. That keeps files portable to Highland, Fade In, Final Draft (via import), Beat, and plain git diffs.

## Three swappable pieces

```
            +-----------------------------+
            |  app.js (UI)                |
            |  editor.js  fountain.js     |
            +------+---------------+------+
                   |               |
         claude adapter      store adapter
       (claude.js)             (store.js)
       - artifact: sample      - db: Artifact database
       - api: API key          - local: browser storage
       - (future) MCP/agent    - (future) files on disk, git
```

Both adapters are small interfaces, so a new home for the editor means writing one adapter, not touching the UI.

## Where it can live

1. **claude.ai Artifact (current).** Zero setup, uses your Claude plan, works on desktop and phone, and Claude in chat shares the script store with the editor. Limits: the page cannot reach other sites, and files come in and out through Open and Export.
2. **Standalone web app or desktop wrapper (Tauri/Electron).** Same build, `apiClaude(key)` adapter, and a file-system store that reads and writes `.fountain` files directly. Costs API usage instead of plan usage.
3. **Claude Code / the Claude app with a local MCP server.** A tiny MCP server exposing `read_script`, `list_scenes`, `apply_edit` over a folder of `.fountain` files would let Claude work on scripts on disk from any Claude surface, with the editor as the viewer. This pairs well with keeping scripts in a git repo, one commit per revision.

The recommendation is to keep (1) as the daily driver and grow toward (3) for scripts that live in a repo.

## Data model (db store)

| Path | Contents |
| --- | --- |
| `scripts/<id>` | `{title, text, updatedAt, source}` |
| `revisions/<auto>` | `{scriptId, label, color, colorHex, text, at}` |
| `chats/<scriptId>` | `{turns: [...last 40], updatedAt}` |
| `settings/main` | `{styleNotes, tier}` |

When Claude writes a script from chat it sets `source: "chat"`. The editor watches the open script: if you have no unsaved typing it loads the new text (undoable); otherwise it asks.

## How Claude edits

- **Chat** sends the rules, style notes, any selected passage, and the full script as the first turn, then the conversation. Replies may contain `<edit><find>…</find><replace>…</replace><note>…</note></edit>` blocks, which render as cards. Apply finds the exact text and replaces it.
- **Rewrite** sends the selection with ~600 characters before and ~400 after, and asks for JSON with three options. The selected range is tracked through your edits, so an option applies in the right place even after you keep typing. Leading and trailing whitespace of the selection is preserved.

## Page estimate

55 lines per page, element widths close to Final Draft defaults (action 60 characters, dialogue 35, parentheticals 26), one blank line between elements, speeches kept whole. Expect it within about half a page of screenwriting software on a short; it drifts more on long scripts with lots of dual dialogue or forced breaks.
