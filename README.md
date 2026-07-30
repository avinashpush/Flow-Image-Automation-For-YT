# Flow Character Prompter

Chrome extension (Manifest V3) for character-aware image-prompt generation in
[Google Flow](https://labs.google/fx).

---

## Stage 1 — Character Insertion Validation (current)

**Goal:** prove that programmatic character insertion creates a real Slate node
(not plain text) so the same character generates reliably every time.

### How to load

1. Open `chrome://extensions`, enable **Developer mode**
2. Click **Load unpacked** → select this directory
3. Navigate to the Flow prompt page (`labs.google/fx/…`)
4. Click the extension icon

### Usage

- Write a prompt using `@{Character Name}` tokens, e.g.:
  ```
  A cinematic shot of @{Trevor} standing in the rain
  ```
- Click **Insert Prompt** — watch the log panel for each step
- Visually confirm the character chip/mention appears in the editor
- Optionally click **Generate** to fire Flow's generate control

### Architecture

| File | Role |
|------|------|
| `manifest.json` | MV3 declaration; content script scoped to `labs.google/*` |
| `content.js` | All automation logic; `CONFIG` block isolates fragile selectors |
| `popup.html` | Extension popup UI |
| `popup.js` | Popup ↔ content script messaging via a named Chrome port |

**Slate injection** (`typeIntoSlate`): uses `document.execCommand('insertText')`
to fire `beforeinput`/`input` through the browser's native input pipeline, which
Slate intercepts. Direct DOM writes bypass Slate and are ignored.

**Character picker** (`insertCharacter`): types `@` → waits for the Radix popover
(MutationObserver on `document.body`) → types the name to filter Virtuoso's
virtualized list → waits for the option DOM node → full pointer event sequence
→ waits for "Add to Prompt" → clicks it → waits for picker to close.

**Selector strategy**: all fragile selectors live in `CONFIG` at the top of
`content.js`. Stable ARIA attributes (`role="textbox"`, `role="option"`,
`data-radix-popper-content-wrapper`, `data-slate-editor`) are preferred over
styled-components hash classes (which rotate on every Flow deploy).

### When a Flow deploy breaks something

Check `CONFIG` in `content.js`:
- Picker not opening → inspect `<body>` for the new popover wrapper attribute
- Options not found → confirm `div[role="option"]` still exists; adjust `findOptionByName`
- "Add to Prompt" not found → update `CONFIG.addToPromptText`
- Model check failing → update `CONFIG.expectedModel`

---

## Stage 2 — Queue & Progress (planned, not built)

- Accept a list of prompts (textarea or uploaded `.txt`, one per line)
- Loop through the list with a configurable inter-prompt delay
- Auto-click Generate after each insertion
- Show `N / total` progress in the popup
- Log any prompt whose character didn't match (no option found)

Architecture note: the existing `insertPrompt` + `clickGenerate` functions are
the inner loop body. Stage 2 wraps them in a `for` loop driven by the popup,
streaming per-prompt status over the same port protocol.

---

## Stage 3 — Auto-download (planned, not built)

- After each Generate, detect Flow's output image(s)
- Download via `chrome.downloads.download()` into a user-chosen subfolder
- Note: Chrome's downloads API confines files to the user's Downloads folder;
  arbitrary absolute paths require Native Messaging.

Architecture note: image detection likely requires watching the DOM for Flow's
image result elements (MutationObserver). The download URL can be extracted from
the `src` attribute of the rendered `<img>` or from a network response intercepted
via a service worker fetch handler.
