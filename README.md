# Fountain Studio

A two-pane screenplay editor for working on Fountain scripts with Claude.

- **Left:** the script, as plain Fountain text laid out like a page (scene numbers in the margin, character cues and dialogue indented, estimated page breaks).
- **Right:** a conversation with Claude that always sees the current draft.
- **Breakdown box:** page count, scenes with page and length in eighths, speaking characters in order of appearance. Click any row to jump there. Closes with the ×.

## Working with Claude

| You want to | Do this |
| --- | --- |
| Talk about the script | Type in the chat. Claude reads the whole current draft each time. |
| Get a passage redone | Highlight it, press **Rewrite with Claude** (⌘K / Ctrl+K), say what should change or pick a quick chip. You get three options. **Apply** one, type a refinement and press **Again**, or **Dismiss**. The passage stays tinted pink while options are open, and you can keep editing elsewhere. |
| Ask about a specific moment | Highlight it, then type in the chat. The selection travels with the message. |
| Accept a suggested change | Chat replies can carry edit cards (old text struck through, new text below). **Apply** makes the change; ⌘Z undoes it. |
| Keep a checkpoint | **Revisions**, then save. Snapshots follow the industry color order (White, Blue, Pink, Yellow, Green, Goldenrod…). |
| Set house style | **Settings**: style notes go into every Claude request. Model choice trades speed for depth. |

You can always edit, cut, and retype anything yourself. The script is just text.

## How it runs

The page is published as a claude.ai Artifact and uses two platform capabilities:

- `sample` calls Claude on the viewer's own Claude plan. No API key, no server.
- `db` stores scripts, chat history, revisions and settings. Claude can read and write the same store from a regular claude.ai chat, so you can say "tighten scene 7 in PVC" in chat and the open editor picks up the change.

Opened outside claude.ai (for example `dist/fountain-studio.html` straight from disk), it falls back to browser storage and editing works without Claude. `src/claude.js` also has an API-key adapter for running it standalone; see `docs/ARCHITECTURE.md`.

## Develop

```sh
npm install
npm run build      # writes dist/fountain-studio.html (one self-contained file)
npm test           # parser checks against samples/
```

## Layout

```
src/
  fountain.js    Fountain line classifier, title page, page estimate, scenes, characters
  editor.js      CodeMirror 6 setup and screenplay decorations
  prompts.js     every instruction Claude receives, and the edit-block parser
  claude.js      Claude adapters (claude.ai Artifact, Anthropic API)
  store.js       storage adapters (Artifact db, browser storage)
  app.js         the UI
  template.html  markup and styles
samples/         sample scripts
test/            parser tests
docs/            architecture notes
```
