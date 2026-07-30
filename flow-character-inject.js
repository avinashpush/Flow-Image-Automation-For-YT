/**
 * Google Flow — character-aware prompt injection
 * ------------------------------------------------
 * Solves the problem Zappy Flow has: pasting "@Trevor" as text does NOT create
 * a Slate mention node. This drives the real UI so Slate/Flow inserts the proper
 * character reference, guaranteeing the same character every generation.
 *
 * Strategy: parse the prompt for @character tokens, then for each segment either
 * type plain text or perform the real "open picker -> filter -> select -> Add to
 * Prompt" sequence. Matching is done on STABLE attributes (role, data-testid,
 * visible text) — never on styled-component hash classes, which Google rotates.
 */

// ---------- CONFIG: the only selectors you may need to re-check after a Flow update ----------
const SEL = {
  editor: 'div[role="textbox"][data-slate-editor="true"][contenteditable="true"]',
  addButton: 'button[aria-haspopup="dialog"]',           // the "+" / add_2 trigger
  optionList: '[data-testid="virtuoso-item-list"]',
  option: '[role="option"]',
  // text node inside an option that holds the character name (fallback chain)
  optionNameCandidates: ['.sc-b0e5-14'],                 // hashed; we also read textContent
  addToPromptText: 'Add to Prompt',                      // matched by button text, not class
};

const TIMEOUT_MS = 8000;
const POLL_MS = 60;

// ---------- small async helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until predicate() returns a truthy value (e.g. an element), or throw. */
async function waitFor(predicate, { timeout = TIMEOUT_MS, poll = POLL_MS, label = 'element' } = {}) {
  const start = performance.now();
  for (;;) {
    let v;
    try { v = predicate(); } catch { v = null; }
    if (v) return v;
    if (performance.now() - start > timeout) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(poll);
  }
}

// ---------- typing into Slate ----------
/**
 * Slate ignores .value / .textContent mutation. It only reacts to real input
 * events. We focus the editor and insert text via execCommand('insertText'),
 * which fires the beforeinput/input pipeline Slate listens to. If your Chrome
 * build has execCommand disabled, fall back to dispatching InputEvent manually.
 */
function focusEditor() {
  const editor = document.querySelector(SEL.editor);
  if (!editor) throw new Error('Slate editor not found — check SEL.editor');
  editor.focus();
  // place caret at end
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return editor;
}

function insertText(text) {
  const editor = focusEditor();
  // Primary path: execCommand routes through the editable's input pipeline.
  const ok = document.execCommand('insertText', false, text);
  if (!ok) {
    // Fallback: dispatch a real InputEvent Slate can interpret.
    editor.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertText', data: text, bubbles: true, cancelable: true,
    }));
    editor.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText', data: text, bubbles: true,
    }));
  }
}

// ---------- the character mention sequence ----------
function readOptionName(optionEl) {
  for (const cls of SEL.optionNameCandidates) {
    const node = optionEl.querySelector(cls);
    if (node && node.textContent.trim()) return node.textContent.trim();
  }
  // Stable fallback: first non-empty text line in the option, excluding the
  // "Character" type label.
  const lines = optionEl.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
  return lines.find((l) => l.toLowerCase() !== 'character') || lines[0] || '';
}

/**
 * Insert one character mention. `name` must EXACTLY match the character's display
 * name in Flow (e.g. "Trevor" vs "Trevor (child)"). exact=true requires a perfect,
 * case-insensitive full-string match so you never grab the wrong variant.
 */
async function insertCharacter(name, { exact = true } = {}) {
  // 1) Open the picker. Typing '@' is the in-editor trigger Slate recognizes.
  insertText('@');
  // 2) Type the name to filter the virtualized list down to (ideally) one row.
  insertText(name);

  // 3) Wait for the list, then for an option whose name matches.
  await waitFor(() => document.querySelector(SEL.optionList), { label: 'option list' });

  const match = await waitFor(() => {
    const opts = [...document.querySelectorAll(SEL.option)];
    return opts.find((o) => {
      const n = readOptionName(o).toLowerCase();
      const target = name.toLowerCase();
      return exact ? n === target : n.includes(target);
    });
  }, { label: `character option "${name}"` });

  // 4) Select it (real pointer sequence — click alone sometimes won't register).
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    match.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }

  // 5) Commit via "Add to Prompt" (matched by text, not hashed class).
  const addBtn = await waitFor(() => {
    return [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim().toLowerCase() === SEL.addToPromptText.toLowerCase());
  }, { label: '"Add to Prompt" button' });

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    addBtn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }

  // Let Slate settle the inserted mention node before the next segment.
  await sleep(150);
}

// ---------- prompt parsing + orchestration ----------
/**
 * Splits a prompt into ordered segments of {type:'text'|'char', value}.
 * Token syntax in your stored prompts: use @{Character Name} so multi-word names
 * and punctuation are unambiguous. Example:
 *   "Wide shot of @{Trevor} arguing with @{Michael} at night"
 */
function parsePrompt(raw) {
  const segments = [];
  const re = /@\{([^}]+)\}/g;
  let last = 0, m;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) segments.push({ type: 'text', value: raw.slice(last, m.index) });
    segments.push({ type: 'char', value: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < raw.length) segments.push({ type: 'text', value: raw.slice(last) });
  return segments;
}

/** Type a full prompt with embedded @{Character} tokens into Flow. */
async function buildPrompt(raw) {
  focusEditor();
  for (const seg of parsePrompt(raw)) {
    if (seg.type === 'text') insertText(seg.value);
    else await insertCharacter(seg.value, { exact: true });
  }
}

// Expose for your queue runner / popup to call.
window.FlowInject = { buildPrompt, insertCharacter, insertText, parsePrompt };