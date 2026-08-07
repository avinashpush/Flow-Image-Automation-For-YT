// content.js — Flow Character Prompter, Stage 1
// Core injection logic lifted from flow-character-inject.js and wrapped in the
// extension's port-messaging harness so the popup UI can drive and observe it.
'use strict';

// ─── SEL / CONFIG ────────────────────────────────────────────────────────────────
// All fragile / deploy-sensitive selectors live here.
// On a Flow redeploy: update only this block — never touch logic below.
const SEL = {
  // Stable Slate attributes — NOT hashed styled-components class names.
  editor: 'div[role="textbox"][data-slate-editor="true"][contenteditable="true"]',

  // Alternative picker entry point (the "+" / add_2 button outside the editor).
  // Not used in the main insertion sequence; kept for reference / future use.
  addButton: 'button[aria-haspopup="dialog"]',

  // Virtuoso list container — present in the DOM only while the picker is open.
  optionList: '[data-testid="virtuoso-item-list"]',

  // Virtuoso's dedicated scroll element (overflow-y: auto), an ancestor of
  // optionList. This — not any other wrapper — is the element whose scrollTop
  // controls which rows Virtuoso mounts. Verified against live popover markup;
  // react-virtuoso stamps both attributes, so match either.
  optionScroller: '[data-virtuoso-scroller="true"], [data-testid="virtuoso-scroller"]',

  // The picker popover's own "Search assets" input. This is a SEPARATE
  // filtering mechanism from the inline "@query" typed into the editor — the
  // inline filter is the one with the works-only-once-per-page-load bug, and
  // this search box is the workaround: it filters the roster reliably on
  // every picker open. Fallback selector by placeholder in case the id
  // rotates on a Flow deploy.
  searchInput: '#add-menu-input, input[placeholder="Search assets"]',

  // Each character row in the Virtuoso-rendered list.
  // role="option" is an ARIA standard — safe to rely on.
  option: '[role="option"]',

  // Hashed class that currently holds the option's display name.
  // Try these first; if a Flow deploy rotates the hash the innerText fallback
  // (in readOptionName) takes over automatically.
  optionNameCandidates: ['.sc-b0e5-14'],

  // "Add to Prompt" button — matched by trimmed text content, never by class.
  addToPromptText: 'Add to Prompt',

  // Radix portals the character picker popover to a wrapper div on <body>.
  // We wait for this wrapper to be removed after closing the picker so its
  // deferred onCloseAutoFocus (which restores focus/selection into Slate)
  // has a chance to run before Flow mutates the editor again — see the
  // postPickerCloseSettleMs comment in CONFIG below.
  popoverWrapper: '[data-radix-popper-content-wrapper]',

  // Flow's submit button is an icon button with no visible label text.
  // The <i> element inside it contains this Material Icon ligature name.
  // Stable as long as Flow uses the same icon; update here if it changes.
  generateIcon: 'arrow_forward',

  // Visually-hidden <span> text inside the submit button (screen-reader label).
  // Used as a fallback when the icon text doesn't match.
  generateFallbackText: 'Create',
};

const CONFIG = {
  // Must match the visible text in Flow's model selector button.
  // Update here when you switch models; no other code needs to change.
  expectedModel: '🍌 Nano Banana 2',

  // Upper-bound timeout and polling cadence used by waitFor().
  timeoutMs: 8000,
  pollMs:    60,

  // Outer ceiling for the entire "wait for matching option" operation in insertCharacter.
  // Raised from 8 s to account for projects with large asset libraries where Virtuoso
  // takes longer to finish filtering before the target row stabilises.
  optionTimeoutMs: 20000,

  // How long waitForOptionStable() will keep polling for list stability before giving
  // up on the stability check and falling through to direct match polling.
  // Keeps the stability phase bounded even if the list never fully settles.
  optionStabilityCapMs: 3000,

  // Pause after "Add to Prompt" so Slate can finalise the mention node before
  // the next segment starts. This is a coordination pause, not a "wait for an
  // element" delay — those use waitFor() with a predicate.
  postCharacterPauseMs: 150,

  // Upper bound on how long insertCharacter() will wait for the Radix popover
  // wrapper to be removed from the DOM after closing the picker. Radix defers
  // its onCloseAutoFocus (focus/selection restore) to run after close; if we
  // move on (e.g. to clickGenerate, which lets Flow reset the editor) before
  // that callback fires, it can try to restore a now-stale Slate selection
  // and throw inside Flow's own React tree, crashing the whole page. This is
  // a best-effort wait, not a hard requirement — we proceed regardless once
  // it elapses.
  popoverCloseSettleMs: 500,

  // Floor on how soon after clicking Generate an image may be accepted as
  // "the output of this prompt". Flow's result gallery lazily mounts older
  // images as it re-renders/scrolls, and those look brand-new to a DOM-diff
  // check — causing the queue to instantly "detect output" and download a
  // picture from a previous prompt. A real generation never completes in a
  // few seconds, so any candidate appearing before this floor is treated as
  // pre-existing gallery content and added to the ignore set instead.
  minGenerationMs: 8000,

  // How many images a single Generate is expected to produce — match this to
  // Flow's model-selector count ("… x1" / "x2" / "x4").
  //
  // This is the key defence against Flow's gallery bulk-mounting a batch of
  // OLD results during a re-render. Those are all "unknown" URLs (they may
  // predate this browsing session entirely, so a session-scoped seen-set
  // can't recognise them) and would otherwise all be downloaded as if they
  // were this prompt's output — observed once as 13 files saved for a single
  // prompt. A batch larger than this count cannot be a generation result, so
  // it is rejected wholesale rather than downloaded.
  maxOutputsPerPrompt: 1,

  // OFF by default — see the big warning comment on insertCharacterDirect().
  // Direct Slate node insertion (skipping the "@" picker) looked correct in
  // every check this extension makes, but produced a broken generation: the
  // character's literal name was rendered as plain text in the output image
  // instead of resolving to the actual character. Two follow-up fixes were
  // tried (waiting for the chip's DOM node to render; forcing insertion at
  // the document's true end via editor.select()) — neither fixed the
  // underlying problem, and the second one regressed further, breaking
  // execCommand('insertText') entirely on every segment after the first
  // direct insertion. Do not flip this to true until the root cause is
  // actually understood — a picker failure at least surfaces as a loud
  // error; this fails silently with a wrong image or breaks insertion
  // outright.
  useDirectCharacterInsertion: false,
};

// ─── Character ID map ─────────────────────────────────────────────────────────
//
// Maps lowercase display name → Flow's characterServerId (UUID).
// This is the only data needed to synthesise an AT_TAG_TYPE mention node.
//
// HOW TO DISCOVER NEW IDs:
//   1. Let insertCharacter() insert the character via the "@" picker (the
//      fallback path used for any name not listed here).
//   2. The [slate:children] log line after every insertion dumps the mention
//      node, including its characterServerId — copy it from there.
//   3. Add the entry below (key = name.toLowerCase()).
//
// Any name found here skips the picker entirely (see insertCharacter) — no
// "@" trigger, no Virtuoso search, no "Add to Prompt" click. This exists
// because the picker's typed-query filtering only works for the very first
// mention per page load; every mention after that shows Virtuoso's static
// unfiltered roster, so anything not in that initial render can never be
// found by typing, no matter how long you wait or scroll. Bypassing the
// picker for known characters also avoids a Radix popover crash the picker
// UI can trigger when a mention is left uncommitted.
const CHARACTER_ID_MAP = {
  'trevor': 'b650085d-bc22-4b0d-a63a-8229f5a5386b',
  'danny': 'f50dca21-7cd7-4078-a7a2-35e4d7c5ac2d',
  'protagonist': '8b63a514-2d3f-4697-a39f-83dd7a83272d',
  'env_studio_astoria': '6c0c4a0f-2fb3-4d7f-af81-33b68c827960',
  'env_sliceshop': 'd68449f2-f2b7-41a1-8677-40711dc1aeec',
  'env_cityst_night': '4c80cb83-7609-44ba-a6b0-2fd6766398eb',
  'env_taxoffice': 'ff94ee73-8e13-452a-81e3-398e4c453be5',
  'env_bankvestibule': '7bcaeaef-7856-49fd-aeb5-842b6d9737f8',
  'env_coopboardroom': 'b3c31ec2-94aa-4b6d-a2ad-c024b5fb9b95',
  'env_brownstone_kitchen': '6f729231-0d08-4b29-b49c-7ecfaddb646c',
  'env_admissionsoffice': '4b200ff3-f54c-4fe7-88b5-d01bcc99a750',
  'env_partyloft': '7bf5e020-52cd-492f-bac2-46d17c50f84f',
  'env_wealthoffice': 'db583690-de00-4e39-9a80-4dd471325cca',
  'env_hamptonshouse': 'd474ee53-bb75-4afb-8493-6c56a9ca51c5',
  'env_philanthropyoffice': '24b80507-b758-46f9-8ac8-e70ff38a5cc8',
  'env_penthousewindow': '8af1f18b-af29-40b1-a4d8-9bb76f70fa85',
  'env_lobby_supertall': 'f2d5d41a-9954-41fc-93d9-109aa2576cf5',
  'env_elevator': 'c3b54f5f-86d6-41f1-a7d5-466b446cf0ce',
  'elena': '3a00cf8b-a38c-4f5d-9d17-f9b7af221ee6',
  'theodore': '519d42ed-5094-4ec1-b5ca-22b2ea6d4c7b',
  'diane': 'e3456ec3-bce3-4716-a9bb-0923e2d3ee10',
  'kevin': '4f06fbd8-a961-4a87-a1b2-0a75e76da955',
  'gloria': '0cd55dfc-0654-44f3-a1f0-983ff2fcb2f5',
  'arthur': '3e06f849-012e-44e7-b6a5-01bdbdca091b',
  'manny': '1f0ffad1-682e-49cd-a30b-9dfed82d57ed',
  'susan': '4b8fe98c-aa9f-4a7e-876d-b58262b0b2d9',
  'howard': '8b253389-aad6-4e64-af6a-d8a750afc628',
};

// ─── MAIN-world bridge ────────────────────────────────────────────────────────
//
// main-world.js runs in the page's MAIN JS world and has direct access to the
// React fiber / Slate editor object. This isolated-world script communicates
// with it via CustomEvents on window — cross-world CustomEvents work because
// both worlds share the same DOM event dispatch system.
//
//   this script → window.dispatchEvent(CustomEvent('fp:request',  { detail }))
//   main-world  → window.dispatchEvent(CustomEvent('fp:response', { detail }))
//
// slateRequest(cmd, payload?) returns a Promise that resolves with the result
// or rejects with a descriptive error. All Slate model reads and mutations
// (editor.selection, editor.select, editor.insertNodes) go through this bridge.

const _mwPending = new Map();
let   _mwIdSeq   = 0;

window.addEventListener('fp:response', (evt) => {
  const { id, result, error } = evt.detail || {};
  const cb = _mwPending.get(id);
  if (cb) { _mwPending.delete(id); cb(result, error); }
});

function slateRequest(cmd, payload, timeoutMs) {
  payload    = payload    ?? null;
  timeoutMs  = timeoutMs  ?? 3000;
  return new Promise((resolve, reject) => {
    const id    = String(++_mwIdSeq);
    const timer = setTimeout(() => {
      _mwPending.delete(id);
      reject(new Error('slateRequest("' + cmd + '") timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    _mwPending.set(id, (result, error) => {
      clearTimeout(timer);
      if (error) reject(new Error(error));
      else resolve(result);
    });
    window.dispatchEvent(new CustomEvent('fp:request', { detail: { cmd, id, payload } }));
  });
}

// ─── FROM flow-character-inject.js: async helpers ────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `predicate` every CONFIG.pollMs until it returns a truthy value, or throw
 * after CONFIG.timeoutMs. Kept as a polling loop (not MutationObserver) to match
 * the reference implementation exactly — simpler and proven against the live site.
 */
async function waitFor(predicate, { timeout = CONFIG.timeoutMs, poll = CONFIG.pollMs, label = 'element' } = {}) {
  const start = performance.now();
  for (;;) {
    let v;
    try { v = predicate(); } catch { v = null; }
    if (v) return v;
    if (performance.now() - start > timeout) {
      throw new Error(`Timed out waiting for: ${label}`);
    }
    await sleep(poll);
  }
}

// ─── FROM flow-character-inject.js: Slate typing ─────────────────────────────────

/**
 * Focus the Slate editor and place the caret at the very end.
 *
 * Called at the start of every insertText() call so focus is correct even if the
 * picker stole it between operations. Caret placement is done via the Selection
 * API because Slate uses the browser's native selection to determine where to
 * insert — without this, text can land at position 0 or wherever focus last was.
 */
function focusEditor() {
  const editor = document.querySelector(SEL.editor);
  if (!editor) throw new Error(`Slate editor not found — check SEL.editor (${SEL.editor})`);
  // Send focus to the editor element exactly once, mirroring a user click.
  // The browser restores the last caret position for this element, or places
  // the cursor at the start/end of content if this is the first focus.
  //
  // NEVER call selectNodeContents after focus. selectNodeContents creates a
  // non-collapsed range spanning all editor content. If execCommand fires before
  // the subsequent collapse() call (or if Slate's selectionchange handler
  // processes the range-selection event), the entire existing text is the
  // active selection and the next insertText call replaces it with the new
  // segment — wiping everything typed so far.
  editor.focus();
  // If the browser placed a non-collapsed "select all" range on focus (some
  // contenteditable implementations do this), collapse it to the end point.
  // collapseToEnd() only shrinks an existing range — it never creates one,
  // never selects content, and is a no-op on an already-collapsed caret.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) sel.collapseToEnd();

  // FIRST-INTERACTION CASE: .focus() alone does not necessarily create a
  // selection range. On a freshly loaded page — before anything has ever been
  // clicked into the editor — there is no range at all (logs show
  // "Sel [A] before @ dispatch: {no-sel}"), and execCommand('insertText')
  // silently does nothing because it has no caret to insert at. That made the
  // FIRST prompt of a queue run fail while every later prompt succeeded.
  // Create a collapsed caret at the end of the content in that case only.
  //
  // Note the selectNodeContents warning above still holds: the range is
  // collapsed BEFORE being applied, so no content is ever left selected.
  if (sel && sel.rangeCount === 0) {
    const r = document.createRange();
    r.selectNodeContents(editor);
    r.collapse(false); // collapse to end — never leave a spanning selection
    applyRange(r);
  }
  return editor;
}

/**
 * Type `text` into the Slate editor.
 *
 * WHY execCommand:
 * Slate maintains its own virtual document tree. Direct DOM writes
 * (element.textContent, innerHTML, createTextNode) bypass Slate's reconciliation
 * and are ignored or overwritten on the next render. Slate's onChange fires only
 * when the browser's native input pipeline fires — specifically the `beforeinput`
 * event. document.execCommand('insertText') triggers that pipeline faithfully,
 * as if the user had typed the characters. It is marked "deprecated" in the spec
 * but remains fully supported in Chrome and is the standard technique for driving
 * Slate programmatically.
 *
 * Fallback:
 * If execCommand returns false (sandboxed iframe, unusual config), dispatch the
 * beforeinput + input event pair manually. Less reliable but best available option.
 */
function insertText(text) {
  // NOTE: intentionally no focusEditor() here.
  // The caller (insertPrompt or insertCharacter's filter step) is responsible for
  // placing focus and the caret. Re-focusing on every insertText call would reset
  // the caret via selectNodeContents-or-collapse, potentially wiping text that was
  // already inserted in the current pass.
  const ok = document.execCommand('insertText', false, text);
  if (!ok) {
    const editor = document.querySelector(SEL.editor);
    if (editor) {
      editor.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText', data: text, bubbles: true, cancelable: true,
      }));
      editor.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText', data: text, bubbles: true,
      }));
    }
  }
}

// ─── FROM flow-character-inject.js: picker interaction ───────────────────────────

/**
 * Extract the display name from a character option element.
 *
 * Tries the known hashed class(es) in SEL.optionNameCandidates first.
 * If those are absent or empty (hash rotated on a Flow deploy), falls back to
 * innerText: splits on newlines, strips blanks, and returns the first line that
 * isn't the "Character" type label — which is the display name.
 *
 * This is the reference implementation's approach, unchanged.
 */
function readOptionName(optionEl) {
  for (const cls of SEL.optionNameCandidates) {
    const node = optionEl.querySelector(cls);
    if (node && node.textContent.trim()) return node.textContent.trim();
  }
  // Stable fallback: first non-empty line of the option's rendered text that
  // isn't the type label ("Character", "Style", etc.).
  const lines = optionEl.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
  return lines.find((l) => l.toLowerCase() !== 'character') || lines[0] || '';
}

// Type a query into the picker popover's own "Search assets" input (see
// SEL.searchInput). The input is React-controlled, so writing .value directly
// gets clobbered on the next render — the value must go through the native
// HTMLInputElement setter and then an 'input' event so React's onChange sees
// it. Returns true if the input was found and set.
function setPickerSearchQuery(text, log) {
  const input = document.querySelector(SEL.searchInput);
  if (!input) {
    log(`    [search] Picker search input not found (${SEL.searchInput})`, 'warn');
    return false;
  }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  log(`    [search] Set picker search box to "${text}"`);
  return true;
}

// Clear the picker's search box if it still holds a query. The box is NOT
// reset when the popover closes, so a query left over from a previous
// character would still be filtering the list the next time the picker opens
// — and it leaves the popover's React state dirty across open/close cycles.
// Call this before closing the picker (both on success and on failure).
// Silent no-op when the input is absent or already empty.
function clearPickerSearchQuery(log) {
  const input = document.querySelector(SEL.searchInput);
  if (!input || !input.value) return;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  log(`    [search] Cleared picker search box`);
}

// Find the element whose scrollTop actually drives Virtuoso's row mounting.
// Returns { el, via } or null.
//
// Preferred path: Virtuoso's own scroller, stamped with
// data-virtuoso-scroller="true" (see SEL.optionScroller), an ancestor of the
// item list with overflow-y: auto.
//
// WHY THE OLD HEURISTIC FAILED: it walked up from the item list returning the
// first ancestor with scrollHeight > clientHeight. Between the item list and
// the real scroller sits Virtuoso's viewport div (data-viewport-type,
// height: 100%, position: absolute) whose content is taller than itself — so
// it passes that test — but it has default overflow: visible, making
// scrollTop writes a silent no-op. The scan grabbed it first and scrolling
// never moved (observed as scrollTop stuck at 0). The fallback below
// therefore also requires computed overflow-y to be auto/scroll, not just a
// size mismatch.
function findScrollContainer(el) {
  const scroller = el.closest(SEL.optionScroller);
  if (scroller) return { el: scroller, via: 'virtuoso-scroller attribute' };

  let node = el.parentElement;
  for (let i = 0; i < 8 && node; i++) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 4) {
      return { el: node, via: 'overflow-y heuristic' };
    }
    node = node.parentElement;
  }
  return null;
}

// Fallback for when the picker's typed-query filtering has no effect (observed:
// works for the very first "@" mention of a page session, but subsequent
// mentions show Virtuoso's full unfiltered roster instead of a filtered one).
// Virtuoso only renders DOM rows currently scrolled into view, so a target
// character further down the roster never appears no matter how long we poll
// the unchanging visible slice. This scrolls the list's container in steps,
// re-scanning rendered [role="option"] rows after each step, until a match is
// found or the container stops advancing (i.e. we've reached the bottom).
// Runs until `deadlineTs` (absolute Date.now() timestamp) at the latest.
async function scrollAndScanForOption(name, exact, log, deadlineTs) {
  const target = name.toLowerCase();
  const listEl = document.querySelector(SEL.optionList);
  if (!listEl) return null;

  const found = findScrollContainer(listEl);
  if (!found) {
    log(`    [scroll] no scrollable ancestor found for the option list — cannot scan beyond the initial render`, 'warn');
    return null;
  }
  const container = found.el;
  log(`    [scroll] Scroll container located via ${found.via} (clientHeight=${container.clientHeight}, scrollHeight=${container.scrollHeight})`);

  const findMatch = () => {
    const opts = [...document.querySelectorAll(SEL.option)];
    return opts.find((o) => {
      const n = readOptionName(o).toLowerCase();
      return exact ? n === target : n.includes(target);
    });
  };

  // Diagnostic: which rows are actually mounted right now. Without this we
  // can't distinguish "scrolled but the same rows stayed mounted" from
  // "new rows mounted but none matched".
  const mountedSummary = () => {
    const opts = [...document.querySelectorAll(SEL.option)];
    if (!opts.length) return '0 mounted';
    const first = readOptionName(opts[0]);
    const last  = readOptionName(opts[opts.length - 1]);
    return `${opts.length} mounted, "${first}" … "${last}"`;
  };

  container.scrollTop = 0;
  container.dispatchEvent(new Event('scroll', { bubbles: true }));
  await sleep(150);

  let lastScrollTop = -1;
  let step = 0;
  let dwellUsed = false;
  while (Date.now() < deadlineTs) {
    step++;
    const match = findMatch();
    if (match) {
      log(`    [scroll] Found "${name}" after ${step} scroll step(s) (scrollTop=${container.scrollTop})`);
      return match;
    }
    log(`    [scroll] step ${step}: scrollTop=${container.scrollTop}/${container.scrollHeight} — ${mountedSummary()}`);

    if (container.scrollTop === lastScrollTop) {
      // Bottom reached. Flow's asset list lazy-loads more pages when the
      // scroller hits the end (observed: scrollHeight grew between two
      // separate scans with no other interaction). Dwell here briefly and
      // watch for content growth before concluding the name isn't present —
      // bailing the instant scrollTop stops advancing races the page fetch.
      if (!dwellUsed) {
        dwellUsed = true;
        const heightBefore = container.scrollHeight;
        const dwellDeadline = Math.min(Date.now() + 2500, deadlineTs);
        log(`    [scroll] At bottom (scrollHeight=${heightBefore}) — dwelling up to 2.5s for lazy-loaded rows…`);
        let grew = false;
        while (Date.now() < dwellDeadline) {
          await sleep(250);
          container.scrollTop = container.scrollHeight; // stay pinned to the bottom
          if (container.scrollHeight > heightBefore + 4) { grew = true; break; }
          const dwellMatch = findMatch();
          if (dwellMatch) {
            log(`    [scroll] Found "${name}" during bottom dwell (scrollTop=${container.scrollTop})`);
            return dwellMatch;
          }
        }
        if (grew) {
          log(`    [scroll] Content grew to ${container.scrollHeight} — continuing scan`);
          lastScrollTop = -1;  // re-arm end detection and keep scrolling
          dwellUsed = false;   // the next bottom (after this new page) gets its own dwell
          continue;
        }
      }
      log(`    [scroll] Reached end of list (scrollTop=${container.scrollTop}) after ${step} step(s) — "${name}" is not present`, 'warn');
      return null;
    }
    lastScrollTop = container.scrollTop;

    container.scrollTop += Math.max(container.clientHeight * 0.8, 150);
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(150);
  }
  log(`    [scroll] Deadline reached mid-scan (scrollTop=${container.scrollTop})`, 'warn');
  return null;
}

// Wait for the character picker's [role="option"] list to stabilise, then return
// the first option whose display name matches `name`.
//
// "Stable" means two consecutive 100 ms polls produce the same element count AND
// the same concatenated name text — i.e. Virtuoso has stopped re-rendering. Only
// after stability is confirmed do we treat the current list as the final filtered
// result and check for the target option.
//
// Two ceilings:
//   stabilityCapMs  — max time spent waiting for stability. If the list is still
//                     changing after this, we stop waiting for it to settle and
//                     fall through to direct match-polling for the remainder.
//   totalTimeoutMs  — absolute ceiling for the whole function. Throws if the
//                     target option hasn't appeared by this deadline.
//
// Returns the matched DOM element. Throws on timeout (message includes both limits).
async function waitForOptionStable(name, exact, log, totalTimeoutMs, stabilityCapMs) {
  const POLL     = 100;  // ms between snapshots
  const start    = Date.now();
  const deadline = start + totalTimeoutMs;
  const target   = name.toLowerCase();
  let   prevSnap = null;       // snapshot string from the previous poll
  let   capLogged = false;     // log the cap-exceeded message only once
  let   pollCount = 0;
  let   searchTried  = false;  // search-box fallback runs at most once per call
  let   searchTriedAt = 0;     // when the search query was set (for its settle window)
  let   scrollScanDone = false; // scroll-scan fallback runs at most once per call

  // ── DIAG: entry ───────────────────────────────────────────────────────────
  log(`    [settle:DIAG] ENTER — target="${name}" exact=${exact} totalTimeoutMs=${totalTimeoutMs} stabilityCapMs=${stabilityCapMs}`);

  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed >= totalTimeoutMs) {
      // ── DIAG: outer timeout ──────────────────────────────────────────────
      log(`    [settle:DIAG] TIMEOUT after ${elapsed}ms — ${pollCount} poll(s) ran — last snap: "${prevSnap}"`, 'error');
      throw new Error(
        `character option "${name}" not found after ${totalTimeoutMs}ms ` +
        `(stability cap: ${stabilityCapMs}ms)`
      );
    }

    await sleep(POLL);
    pollCount++;

    const opts = [...document.querySelectorAll(SEL.option)];

    // Snapshot: count + every visible name joined. Using \x00 as separator avoids
    // false matches if one name happens to be a prefix of the next.
    const snap = opts.length + '\x00' + opts.map(o => readOptionName(o)).join('\x00');

    const isStable   = prevSnap !== null && snap === prevSnap;
    const pastCap    = (Date.now() - start) >= stabilityCapMs;

    // ── DIAG: per-poll ────────────────────────────────────────────────────
    log(`    [settle:DIAG] poll #${pollCount} +${Date.now() - start}ms — opts=${opts.length} stable=${isStable} pastCap=${pastCap} snap="${snap}"`);

    if (pastCap && !isStable && !capLogged) {
      capLogged = true;
      // ── DIAG: cap hit ────────────────────────────────────────────────
      log(`    [settle:DIAG] CAP HIT — list still changing after ${stabilityCapMs}ms — switching to direct poll`);
      log(`    [settle] Stability cap (${stabilityCapMs}ms) reached — list still changing; switching to direct poll`);
    }

    // Check for a match once the list is stable, or once we've exceeded the cap.
    if (isStable || pastCap) {
      const match = opts.find(o => {
        const n = readOptionName(o).toLowerCase();
        return exact ? n === target : n.includes(target);
      });
      if (match) {
        const elapsed2 = Date.now() - start;
        log(`    [settle] Matched "${name}" after ${elapsed2}ms (stable=${isStable})`);
        return match;
      }

      // The inline "@query" filter had no effect (list is stable and doesn't
      // contain the target — the known works-only-once-per-page-load bug).
      // Fallback 1: the popover's own "Search assets" input, a separate
      // filtering mechanism from the inline one. Set the query there and let
      // the normal polling above catch the re-filtered results.
      if (isStable && !searchTried) {
        searchTried  = true;
        searchTriedAt = Date.now();
        log(`    [settle] List stable with no match — inline "@" filter not engaged; trying the picker's search box…`);
        if (setPickerSearchQuery(name, log)) {
          prevSnap = null; // list will re-render; re-arm stability detection
          continue;
        }
        // Search input missing — fall straight through to the scroll-scan.
      }

      // Give the search-box results time to load and settle before concluding
      // it didn't work (the asset search may round-trip to the server).
      if (isStable && searchTried && Date.now() - searchTriedAt < 3000) {
        prevSnap = snap;
        continue;
      }

      // Fallback 2: actively scroll the Virtuoso list so rows further down
      // get mounted (it only renders rows in view, and the roster lazy-loads
      // additional pages at the bottom). Only attempted once per call, and
      // only once the list has genuinely settled.
      if (isStable && !scrollScanDone) {
        scrollScanDone = true;
        log(`    [settle] Search box didn't surface "${name}" either — scanning by scroll…`);
        const scrolled = await scrollAndScanForOption(name, exact, log, deadline);
        if (scrolled) {
          log(`    [settle] Matched "${name}" via scroll-scan after ${Date.now() - start}ms`);
          return scrolled;
        }
        log(`    [settle] Scroll-scan completed without a match`, 'warn');
        throw new Error(
          `character option "${name}" not found — tried inline filter, the picker search box, ` +
          `and a full scroll-scan of the list, after ${Date.now() - start}ms`
        );
      }
    }

    prevSnap = snap;
  }
}

/**
 * Insert one character mention into the Slate editor.
 *
 * Sequence (matches flow-character-inject.js exactly):
 *   1. insertText('@')   — triggers Flow's Slate mention plugin; picker opens
 *   2. insertText(name)  — filters the Virtuoso list to matching rows
 *   3. waitFor optionList present — confirms the picker rendered
 *   4. waitFor matching option — Virtuoso brings it into the rendered range
 *   5. Full MouseEvent sequence on the option — bare .click() can miss Radix handlers
 *   6. waitFor "Add to Prompt" button — appears after option selection
 *   7. Full MouseEvent sequence on "Add to Prompt" — commits the Slate mention node
 *   8. sleep(postCharacterPauseMs) — let Slate finalise before the next segment
 *
 * VIRTUOSO NOTE:
 * Virtuoso only renders rows currently visible in the viewport. Steps 1+2 filter
 * the list so the target row scrolls into the rendered range. If the option still
 * isn't found, the character name likely doesn't exist in Flow's library.
 *
 * EXACT MATCHING:
 * readOptionName() returns the display name; we compare it fully (case-insensitive)
 * so "Trevor" never matches "Trevor (child)" or "Trevor Smith".
 */

/**
 * Remove any stray "@" trigger character left in the Slate editor after a
 * mention is committed.
 *
 * WHY IT'S NEEDED:
 * Flow's mention plugin replaces the search text (e.g. "Trevor") with the
 * mention node when "Add to Prompt" is clicked, but in some cases it does
 * not remove the "@" that preceded the search text. We walk the editor's
 * text nodes and delete any lone "@" we find.
 *
 * Two forms handled:
 *   1. A text node whose entire content is "@"
 *      (Slate stored it as a separate leaf node)
 *   2. A text node that ends with "@"
 *      (Slate merged it with the preceding text, e.g. "White background with @")
 *
 * We stop after the first match — there should only ever be one trigger "@"
 * per character insertion.
 */
// `characterName` is the name that was just typed as the filter (e.g. "Trevor").
// For an EMPTY editor (1st chip), Flow's commit wipes the "@name" text and leaves
// a bare "@". For a POPULATED editor (2nd+ chip), Flow leaves "@name" as literal
// text AND appends a bare "@" chip-placeholder. In both cases we want to delete
// everything from "@" onward before the chip, then reanchor the caret after it.
function removeStrayTrigger(log, characterName = '') {
  const editorEl = document.querySelector(SEL.editor);
  if (!editorEl) return;

  const chips = editorEl.querySelectorAll('[contenteditable="false"]');
  const chip  = chips.length ? chips[chips.length - 1] : null;

  // Always reanchor after the chip so the next segment inserts to the right of
  // it, regardless of whether we deleted anything or not.
  function reanchorAfterChip() {
    const sel = window.getSelection();
    if (!sel) return;
    const afterNode = nearestEditableText(chip, 'next');
    if (afterNode) {
      sel.collapse(afterNode, 0);
    } else {
      // No text node after chip — position at the element offset that follows it.
      const parent = chip.parentNode;
      const idx = [...parent.childNodes].indexOf(chip);
      sel.collapse(parent, idx + 1);
    }
  }

  if (chip) {
    // ── Look BEFORE the chip ──────────────────────────────────────────────────
    // Build a regex that matches the full "@name" trigger (+ any trailing
    // whitespace or Slate zero-width spacers) at the end of the text node.
    // For an empty-editor commit the text before chip is just "@"; for a
    // populated-editor commit it is "@Trevor " (name + space Flow added).
    const escapedName = characterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const strayPat = characterName
      ? new RegExp('@' + escapedName + '[\\u200B\\uFEFF\\u200C\\u200D \\t]*$', 'i')
      : /@[​﻿‌‍ \t]*$/;

    const before = nearestEditableText(chip, 'prev');
    const beforeText = before?.textContent ?? '';
    log(`    removeStrayTrigger: text ending before chip: "…${beforeText.slice(-20)}"`);

    if (before) {
      const m = strayPat.exec(beforeText);
      if (m) {
        deleteRange(before, m.index, beforeText.length);
        log(`    Removed stray "${m[0].replace(/\s+$/, '')}" preceding the chip`);
        reanchorAfterChip();
        return;
      }
    }

    // ── Look AFTER the chip ───────────────────────────────────────────────────
    const after = nearestEditableText(chip, 'next');
    const afterText = after?.textContent ?? '';
    log(`    removeStrayTrigger: text starting after chip: "${afterText.slice(0, 10)}…"`);

    if (after && afterText.startsWith('@')) {
      deleteRange(after, 0, 1);
      log(`    Removed stray "@" following the chip`);
      // Caret is at the deletion point (start of afterText node) — correct.
      return;
    }

    log(`    removeStrayTrigger: no stray "@…" adjacent to chip`);
    reanchorAfterChip(); // still reanchor for consistency
    return;
  }

  // Fallback (no chip found): scan all text nodes for a lone '@'.
  log(`    removeStrayTrigger: no chip found; scanning text nodes`);
  const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent;
    if (t === '@') {
      const r = document.createRange(); r.selectNode(node);
      applyRange(r); document.execCommand('delete');
      log(`    Removed stray "@" (fallback — standalone node)`);
      return;
    }
    if (t.endsWith('@')) {
      deleteRange(node, t.length - 1, t.length);
      log(`    Removed stray "@" (fallback — end of "…${t.slice(-10)}")`);
      return;
    }
  }
  log(`    removeStrayTrigger: no stray "@" found anywhere`);
}

// Walk siblings to find the nearest text node in `direction` ('prev'|'next').
// Descends into element siblings to reach leaf text nodes.
function nearestEditableText(startEl, direction) {
  let sibling = direction === 'prev' ? startEl.previousSibling : startEl.nextSibling;
  while (sibling) {
    if (sibling.nodeType === Node.TEXT_NODE) return sibling;
    // Descend: for 'prev' we want the last text node inside the sibling;
    // for 'next' we want the first.
    const w = document.createTreeWalker(sibling, NodeFilter.SHOW_TEXT);
    if (direction === 'next') {
      const n = w.nextNode(); if (n) return n;
    } else {
      let last = null, n;
      while ((n = w.nextNode())) last = n;
      if (last) return last;
    }
    sibling = direction === 'prev' ? sibling.previousSibling : sibling.nextSibling;
  }
  return null;
}

function deleteRange(textNode, start, end) {
  const r = document.createRange();
  r.setStart(textNode, start);
  r.setEnd(textNode,   end);
  applyRange(r);
  document.execCommand('delete');
}

// Apply a Range as the document selection. Returns false if it couldn't be
// applied — most commonly because the range points into nodes that are no
// longer in the document (Flow crashed and unmounted the editor), which
// otherwise surfaces as a stream of uncatchable-looking
// "addRange(): The given range isn't in document" console errors.
function applyRange(range) {
  const s = window.getSelection();
  if (!s) return false;
  if (!range.startContainer?.isConnected) return false;
  s.removeAllRanges();
  try {
    s.addRange(range);
    return true;
  } catch (_) {
    return false;
  }
}

// Read the editor's actual text content for logging / verification.
// Two sources of noise are excluded:
//   1. data-slate-placeholder elements — Flow renders "What do you want to
//      create?" inside the editor DOM when it's empty; textContent includes it
//      even though it is not real editor content.
//   2. Slate zero-width spacers (U+200B, U+FEFF, U+200C, U+200D) — Slate
//      inserts these to stabilise the caret inside leaf spans; they bleed into
//      textContent reads and appear as garbled whitespace in the log.
function editorText(editorEl) {
  if (!editorEl) return '';
  const clone = editorEl.cloneNode(true);
  clone.querySelectorAll('[data-slate-placeholder]').forEach(el => el.remove());
  return (clone.textContent || '').replace(/[​﻿‌‍]/g, '').trim();
}

// ─── Slate editor object access via React fiber ──────────────────────────────
//
// The Slate editor JS object (.children, .selection, .apply, .insertText,
// .select, .collapse …) is not directly reachable from the DOM, but React
// stores the Fiber tree on each DOM node as a property keyed
// "__reactFiber$<hash>" (React 16+) or "__reactInternalInstance$<hash>" (older).
// Walking up the fiber tree lets us reach the component that holds the editor
// in its props or hook state.
//
// Why verify with isSlateEditor():
//   React fibers have many props; we match on the structural signature of a
//   Slate editor to avoid false positives (any object named "editor").
//
// Cache: the walk is skipped when the cached object is still live. The object
// is considered stale if .children access throws (unmounted Proxy) or the
// DOM element has disappeared.

let _slateEditorCache = null;

function isSlateEditor(v) {
  return (
    v != null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Array.isArray(v.children) &&
    'selection' in v &&
    typeof v.apply === 'function' &&
    typeof v.insertText === 'function'
  );
}

function getSlateEditor() {
  // Return cached instance if still live.
  if (_slateEditorCache) {
    try { if (Array.isArray(_slateEditorCache.children)) return _slateEditorCache; }
    catch { /* stale — fall through */ }
    _slateEditorCache = null;
  }

  const editorEl = document.querySelector(SEL.editor);
  if (!editorEl) return null;

  const fiberKey = Object.keys(editorEl).find(
    k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
  );
  if (!fiberKey) return null;

  // Walk upward through the fiber tree.
  let fiber = editorEl[fiberKey];
  for (let depth = 0; fiber && depth < 200; depth++, fiber = fiber.return) {
    // Check memoizedProps (class components & function components that receive
    // the editor as a prop, e.g. <Slate editor={editor}>).
    const mp = fiber.memoizedProps;
    if (mp) {
      for (const k of Object.keys(mp)) {
        if (isSlateEditor(mp[k])) { _slateEditorCache = mp[k]; return mp[k]; }
      }
    }
    // Check hook state linked-list (useReducer / useRef / useState).
    // useRef stores value as { current: ... }; other hooks store it directly.
    let ms = fiber.memoizedState;
    for (let d2 = 0; ms && d2 < 50; d2++, ms = ms.next) {
      const v = ms.memoizedState;
      if (isSlateEditor(v)) { _slateEditorCache = v; return v; }
      if (v && typeof v === 'object' && isSlateEditor(v.current)) {
        _slateEditorCache = v.current; return v.current;
      }
    }
  }
  return null;
}

// Dismisses the character picker via Escape if it's still open. Used when
// insertCharacterImpl() throws partway through (e.g. the option was never
// found) — in that case the picker's Radix popover never goes through its
// normal "Add to Prompt" close path and is left open. If we let that dangling
// popover linger, the NEXT insertCharacter() call's own "@" trigger forces
// Radix to close it, and its deferred onCloseAutoFocus then fires against
// whatever the editor looks like at that later point — which can be a wholly
// different document by then — and throws inside Flow's own React tree,
// crashing the page. Closing it immediately, right after the failure, means
// that focus-restore runs while the DOM it's referencing is still valid.
async function closePickerIfOpen(log) {
  if (!document.querySelector(SEL.popoverWrapper) && !document.querySelector(SEL.optionList)) return;
  log(`    [cleanup] Closing picker left open after failure (Escape)…`, 'warn');
  clearPickerSearchQuery(log); // don't leave a stale query filtering the next open
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true,
  }));
  try {
    await waitFor(() => !document.querySelector(SEL.popoverWrapper), {
      timeout: CONFIG.popoverCloseSettleMs,
      label: 'popover wrapper removed (failure cleanup)',
    });
    log(`    [cleanup] ✓ Popover closed`);
  } catch (_) {
    log(`    [cleanup] ⚠ Popover still present after Escape — proceeding anyway`, 'warn');
  }
}

// Inserts a mention node directly via the MAIN-world bridge, entirely
// skipping the "@" picker — see CHARACTER_ID_MAP and slate:insert-mention.
//
// DISABLED BY DEFAULT (see CONFIG.useDirectCharacterInsertion below) pending a
// controlled re-test. Root-cause investigation so far:
//   - Network capture (request + response bodies) during a real picker
//     insertion showed nothing character-related — two unrelated
//     project.searchUserProjects calls only.
//   - localStorage / sessionStorage / cache-shaped window keys: no diff.
//   - Zustand devtools action log (via redux-devtools-shim.js): zero actions
//     fired by any store during the insertion.
//   So there is no evidence of a hidden "registration" side channel beyond
//   the Slate document itself.
//   - What WAS confirmed broken: the multi-character "ProtagonistDanny" run
//     showed the final [slate:children] dump contained perfectly valid
//     AT_TAG_TYPE nodes with correct characterServerId values throughout —
//     they were NOT flattened to plain text. They were just in the WRONG
//     ORDER relative to surrounding text (text landing before a chip instead
//     of after). That's consistent with a caret-sync race, not a missing
//     backend registration: slate:insert-mention resolves in the MAIN world
//     as soon as editor.insertNodes()/select() return, which is before React
//     necessarily commits the resulting chip to the actual DOM. If we return
//     immediately, the NEXT segment's placeCaret() (in insertPrompt) looks
//     for a '[contenteditable="false"]' chip element to position the cursor
//     after and finds nothing yet, so it falls back to document start.
// This function now waits for the chip's real DOM node to appear before
// returning, to close that race. Whether fixing ordering alone resolves the
// "wrong character in the image" symptom, or whether a real registration gap
// still exists underneath, is what the next controlled test needs to show.
async function insertCharacterDirect(name, characterServerId, log) {
  log(`    [direct] Inserting known character "${name}" (id=${characterServerId}) — bypassing picker`);
  const editorEl = document.querySelector(SEL.editor);
  await slateRequest('slate:insert-mention', { characterServerId, displayText: name }, 3000);

  try {
    await waitFor(() => {
      if (!editorEl) return false;
      const chips = [...editorEl.querySelectorAll('[contenteditable="false"]')];
      return chips.some((c) => c.textContent.includes(name));
    }, { timeout: 2000, label: `chip DOM node for "${name}"` });
    log(`    ✓ Chip DOM node confirmed for "${name}"`);
  } catch (e) {
    log(`    ⚠ Chip for "${name}" never got a [contenteditable="false"] DOM node within 2s (${e.message}) — it may have rendered as plain text rather than a real mention`, 'warn');
  }

  log(`    ✓ Character "${name}" inserted directly`, 'success');
}

async function insertCharacter(name, log, opts) {
  const knownId = CONFIG.useDirectCharacterInsertion ? CHARACTER_ID_MAP[name.toLowerCase()] : null;
  if (knownId) {
    try {
      return await insertCharacterDirect(name, knownId, log);
    } catch (err) {
      log(`    ⚠ Direct insertion failed for "${name}" (${err.message}) — falling back to picker`, 'warn');
      // Fall through to the picker-driven path below.
    }
  }

  try {
    return await insertCharacterImpl(name, log, opts);
  } catch (err) {
    await closePickerIfOpen(log);
    throw err;
  }
}

async function insertCharacterImpl(name, log, { exact = true } = {}) {
  let pickerOpenedVia = null;

  // ── Approach A: synthesize the @ keypress ─────────────────────────────────
  //
  // ROOT CAUSE of the previous timeout: insertText('@') via execCommand writes
  // a literal '@' into Slate's DOM but does NOT fire a keydown event. Flow's
  // mention plugin listens for keydown (key:"@") to decide when to open the
  // picker — so the picker never appeared, and all downstream waitFor calls
  // timed out immediately.
  //
  // Fix: fire the full browser keyboard event sequence that a real Shift+2
  // keypress produces, so Slate's mention plugin sees a genuine trigger:
  //   keydown → beforeinput → input → keyup
  // execCommand('insertText') is then the insertion mechanism (it fires the
  // real beforeinput + input internally, which Slate needs to update its model).
  // We dispatch an additional explicit beforeinput first because some Slate
  // builds gate the picker on the beforeinput event rather than keydown.
  log(`    [A] Firing @ keydown sequence…`);
  // Do NOT call focusEditor() here. insertPrompt() focused the editor once before
  // the segment loop, and each previous segment's caret advancement (insertText) or
  // post-character reanchor (focusEditor at end of insertCharacter) leaves the caret
  // exactly where this segment should begin. Re-calling focusEditor() here would
  // invoke selectNodeContents on the entire editor, risking a non-collapsed selection
  // that execCommand would then replace with '@'.
  const editor = document.querySelector(SEL.editor);
  if (!editor) throw new Error(`Slate editor not found — check SEL.editor (${SEL.editor})`);

  // Helper: compact DOM selection snapshot for the log.
  const selSnap = () => {
    const s = window.getSelection();
    if (!s || s.rangeCount === 0) return '{no-sel}';
    return `{collapsed:${s.isCollapsed} anchorOffset:${s.anchorOffset} rangeCount:${s.rangeCount}}`;
  };

  // Helper: Slate MODEL selection snapshot — reads editor.selection directly.
  // This is the source of truth Flow's Slate transforms use; it can diverge
  // from the DOM selection when Slate hasn't reconciled yet.
  const slateSelSnap = () => {
    try {
      const se = getSlateEditor();
      if (!se) return '{no-slate-editor}';
      return JSON.stringify(se.selection);
    } catch (e) { return `{err:${e.message}}`; }
  };

  // SAFETY: the selection must be collapsed at the caret before the '@' trigger.
  // A non-collapsed (range) selection would cause execCommand('insertText', '@') to
  // replace all selected text with '@', wiping any preceding text segment.
  {
    const s = window.getSelection();
    log(`    Sel [A] before @ dispatch: ${selSnap()}`);
    if (s && !s.isCollapsed) {
      log(`    ⚠ [A] non-collapsed — forcing collapseToEnd()`, 'warn');
      s.collapseToEnd();
    }
  }
  // Read Slate's internal selection via MAIN-world bridge (async, safe here).
  try {
    const sa = await slateRequest('slate:selection', null, 800);
    log(`    Slate[A]: ${JSON.stringify(sa)}`);
  } catch (e) { log(`    Slate[A]: {${e.message}}`); }

  // Snapshot BEFORE the '@' fires — confirms leading text is present in the
  // editor before the picker-open sequence. If this log shows empty / missing
  // text, the bug is in the preceding insertText call, not in the picker logic.
  log(`    Editor before picker-open: "${editorText(editor)}"`);

  // keydown: Shift+2 → produces '@' on a US keyboard.
  // This is the event Flow's mention plugin listens for to open the picker.
  editor.dispatchEvent(new KeyboardEvent('keydown', {
    key: '@', code: 'Digit2', keyCode: 50, which: 50,
    shiftKey: true, bubbles: true, cancelable: true, view: window,
  }));

  // Check immediately after keydown — if Slate's keydown handler disturbed the
  // selection (e.g. created a spanning range that will later be used as the
  // mention replace-range), force it back to collapsed before execCommand fires.
  {
    const s = window.getSelection();
    log(`    Sel [B] after @ keydown:  ${selSnap()}`);
    log(`    Slate[B]: ${slateSelSnap()}`);
    if (s && !s.isCollapsed) {
      log(`    ⚠ [B] keydown left non-collapsed sel — forcing collapseToEnd()`, 'warn');
      s.collapseToEnd();
    }
  }

  // execCommand inserts '@' AND fires real beforeinput + input through the browser's
  // native pipeline. Do NOT also dispatch beforeinput/input manually — doing so
  // causes Slate to process the insertion twice, leaving '@@' in the editor. The
  // mention plugin then replaces only one '@' + the name, leaving a stray second '@'.
  document.execCommand('insertText', false, '@');

  // Check after execCommand — the insertion might re-expand the selection.
  {
    const s = window.getSelection();
    log(`    Sel [C] after execCmd '@': ${selSnap()}`);
    log(`    Slate[C]: ${slateSelSnap()}`);
    if (s && !s.isCollapsed) {
      log(`    ⚠ [C] execCmd left non-collapsed sel — forcing collapseToEnd()`, 'warn');
      s.collapseToEnd();
    }
  }
  log(`    [ck3] Editor after '@' dispatch: "${editorText(editor)}"`);

  // keyup: completes the keystroke lifecycle.
  editor.dispatchEvent(new KeyboardEvent('keyup', {
    key: '@', code: 'Digit2', keyCode: 50, which: 50,
    shiftKey: true, bubbles: true, cancelable: true, view: window,
  }));

  // Check whether the Virtuoso list appeared (= picker opened)
  try {
    await waitFor(
      () => document.querySelector(SEL.optionList),
      { timeout: CONFIG.timeoutMs, label: 'option list (A)' }
    );
    pickerOpenedVia = 'A';
  } catch (_) { /* fall through to Approach B */ }

  log(`    picker opened (approach A): ${pickerOpenedVia === 'A'}`);

  // ── Approach B: click the dedicated add/create button ─────────────────────
  //
  // If Approach A didn't open the picker (e.g. the keydown trigger changed),
  // fall back to Flow's own UI entry point for the character picker.
  // button[aria-haspopup="dialog"] is the "+" / add_2 icon button whose whole
  // job is to open this picker — more robust than synthesizing the keypress.
  if (!pickerOpenedVia) {
    log(`    [B] Clicking add button (${SEL.addButton})…`);
    const addTriggerBtn = document.querySelector(SEL.addButton);
    if (!addTriggerBtn) {
      throw new Error(
        `Approach A (@ keydown) timed out and Approach B add button` +
        ` "${SEL.addButton}" was not found. ` +
        `Inspect the Flow toolbar for the "+" character button and update SEL.addButton.`
      );
    }
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      addTriggerBtn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    try {
      await waitFor(
        () => document.querySelector(SEL.optionList),
        { timeout: CONFIG.timeoutMs, label: 'option list (B)' }
      );
      pickerOpenedVia = 'B';
    } catch (_) { /* both failed */ }

    log(`    picker opened (approach B): ${pickerOpenedVia === 'B'}`);

    if (!pickerOpenedVia) {
      throw new Error(
        `Character picker did not open via Approach A (@ keydown sequence) ` +
        `or Approach B (add button click). Both timed out waiting for` +
        ` "${SEL.optionList}".`
      );
    }
  }

  // Snapshot AFTER picker opens — if the editor lost its leading text between
  // "before picker-open" and here, the '@' keydown + execCommand sequence (or
  // the Approach B button click) is what cleared it.
  log(`    Editor after picker-open:  "${editorText(editor)}"`);

  // ── Switch to the "Characters" tab ───────────────────────────────────────
  //
  // The picker defaults to the "All" tab, which includes images, uploads, and
  // other asset types alongside characters. On projects with a large asset
  // library this inflates the Virtuoso list, slows re-rendering, and causes
  // waitForOptionStable() to see many more items than necessary.
  //
  // The tab bar mounts asynchronously after the Virtuoso list container appears,
  // so we poll for [role="tab"] elements before doing anything with them. Each
  // poll attempt is logged so we can see how many iterations it takes.
  //
  // We switch on every picker open — no relying on the tab persisting.
  // Log whether it was already selected so we can observe real behaviour.
  {
    const TAB_POLL_MS  = 100;
    const TAB_POLL_CAP = 2000;  // give up after 2 s if tab bar never appears
    let   allTabs      = [];
    let   tabPollCount = 0;
    const tabPollStart = Date.now();

    while (Date.now() - tabPollStart < TAB_POLL_CAP) {
      tabPollCount++;
      allTabs = [...document.querySelectorAll('[role="tab"]')];
      log(`    [tab] poll #${tabPollCount} — ${allTabs.length} tab(s) found`);
      if (allTabs.length > 0) break;
      await sleep(TAB_POLL_MS);
    }

    const charsTab = allTabs.find(t => t.textContent.trim().includes('Characters'));

    if (charsTab) {
      const alreadySelected = charsTab.getAttribute('aria-selected') === 'true';
      log(`    [tab] Characters tab found — aria-selected="${charsTab.getAttribute('aria-selected')}" (${alreadySelected ? 'already active — no click needed' : 'not active — clicking'})`);

      if (!alreadySelected) {
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          charsTab.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      }

      // Verify the tab became active (or was already active).
      try {
        await waitFor(
          () => charsTab.getAttribute('aria-selected') === 'true',
          { timeout: 1000, label: 'Characters tab aria-selected="true"' }
        );
        log(`    [tab] ✓ Characters tab active`);
      } catch (_) {
        log(`    [tab] ⚠ aria-selected did not flip to "true" within 1s — proceeding with current tab`, 'warn');
      }
    } else if (allTabs.length > 0) {
      log(`    [tab] ⚠ Tab bar found but no tab contains "Characters" — markup may have changed`, 'warn');
      log(`    [tab]   tabs: [${allTabs.map(t => `"${t.textContent.trim().slice(0, 20)}"`).join(', ')}]`);
    } else {
      log(`    [tab] ⚠ Tab bar never appeared after ${tabPollCount} poll(s) / ${Date.now() - tabPollStart}ms — continuing with whatever tab is active`, 'warn');
    }
  }

  // ── Type the name to filter the Virtuoso list ─────────────────────────────
  //
  // insertText() no longer calls focusEditor(), so the focus stays on the editor
  // at the '@' caret position. For Approach A the picker is an inline overlay
  // driven by keystrokes in the editor; execCommand inserts the name and the
  // picker filters in real time.
  log(`    Typing "${name}" to filter…`);
  insertText(name);
  {
    const s = window.getSelection();
    log(`    Sel [D] after typing name:  ${selSnap()}`);
    if (s && !s.isCollapsed) {
      log(`    ⚠ [D] insertText left non-collapsed sel — forcing collapseToEnd()`, 'warn');
      s.collapseToEnd();
    }
  }
  // Capture Slate's internal selection BEFORE the waitFor polling loop runs.
  // This is the "correct" position (anchorOffset matches end of @query).
  // Slate[E] (after waitFor) shows where it drifted to.
  try {
    const sd = await slateRequest('slate:selection', null, 800);
    log(`    Slate[D]: ${JSON.stringify(sd)}`);
  } catch (e) { log(`    Slate[D]: {${e.message}}`); }
  log(`    [ck4] Editor after typing name: "${editorText(editor)}"`);

  // ── Wait for the matching option ──────────────────────────────────────────
  //
  // Both waitFor calls below query document globally — NOT a scoped root —
  // because the Radix popover is portaled to <body> and lives outside the
  // editor's DOM subtree. readOptionName / matching logic is unchanged.
  //
  log(`    Waiting for option "${name}" (stability cap: ${CONFIG.optionStabilityCapMs}ms, timeout: ${CONFIG.optionTimeoutMs}ms)…`);
  const match = await waitForOptionStable(
    name, exact, log, CONFIG.optionTimeoutMs, CONFIG.optionStabilityCapMs
  );

  log(`    Matched option for "${name}"`, 'success');

  // ── Restore Slate's internal selection via MAIN-world bridge ─────────────
  //
  // DOM-selection fixes (window.getSelection) had no effect because Flow's
  // mention-commit transform reads editor.selection (Slate's internal model),
  // not the DOM selection. Between [D] and [E], Slate drifts its internal
  // selection to near block-start. When the option is clicked with that stale
  // selection, the commit replace-range spans from block-start to cursor end,
  // wiping all leading text.
  //
  // main-world.js can reach editor.select() directly. 'slate:restore-query-caret'
  // walks editor.children for the end of "@<name>", then calls editor.select()
  // to plant the collapsed caret there — exactly where a real user's cursor is.
  {
    // Read Slate's drifted selection before we fix it.
    log(`    Sel [E] DOM: ${selSnap()}`);
    try {
      const esBefore = await slateRequest('slate:selection', null, 800);
      log(`    Slate[E] before fix: ${JSON.stringify(esBefore)}`);
    } catch (e) { log(`    Slate[E]: {${e.message}}`); }

    // Fix: collapse Slate's internal selection to the end of "@<name>".
    // The mention commit will then replace ONLY "@<name>" with the chip,
    // leaving all preceding text intact.
    try {
      const res = await slateRequest('slate:select-query-end', { name });
      log(`    Slate[E] fixed → path:${JSON.stringify(res.point.path)} offset:${res.point.offset}`);
      log(`    Slate[E'] after fix: ${JSON.stringify(res.selection)}`);
    } catch (e) {
      log(`    ⚠ slate:select-query-end failed: ${e.message} — leading text may be wiped`, 'warn');
    }
  }
  log(`    Clicking option…`);
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    match.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  log(`    [ck5] Editor after clicking option: "${editorText(editor)}"`);


  // ── Click "Add to Prompt" to commit the Slate mention node ────────────────
  log(`    Waiting for "Add to Prompt"…`);
  const addToPromptBtn = await waitFor(() => {
    return [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim().toLowerCase() === SEL.addToPromptText.toLowerCase());
  }, { label: '"Add to Prompt" button' });

  // Clear any query we typed into the picker's search box BEFORE committing.
  // The box isn't reset when the popover closes, so leaving it set would
  // filter the next picker open by the previous character's name and leaves
  // the popover's React state dirty across open/close cycles.
  clearPickerSearchQuery(log);

  log(`    Clicking "Add to Prompt"…`);
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    addToPromptBtn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  log(`    [ck6] Editor after "Add to Prompt" click: "${editorText(editor)}"`);

  await sleep(CONFIG.postCharacterPauseMs);
  log(`    [ck6b] Editor after settle (${CONFIG.postCharacterPauseMs}ms): "${editorText(editor)}"`);

  // Clean up the "@" trigger character that the mention plugin sometimes leaves
  // behind as plain text after committing the mention node.
  // removeStrayTrigger also repositions the caret to AFTER the chip if it had
  // to delete a stray '@' (which leaves the caret before the chip). No
  // focusEditor() call is needed here — the cursor is at the correct position.
  removeStrayTrigger(log, name);
  log(`    [ck7] Editor after stray-'@' cleanup: "${editorText(editor)}"`);

  // Wait for the Radix popover wrapper to actually leave the DOM before moving
  // on. Its onCloseAutoFocus runs on a deferred timer after close and tries to
  // restore focus/selection into Slate — if we let clickGenerate reset the
  // editor before that callback fires, it restores a stale selection and
  // throws inside Flow's own render, which has been observed to crash the
  // whole page (Next.js "client-side exception"). Best-effort: log and move
  // on regardless if it never disappears, rather than blocking the queue.
  try {
    await waitFor(() => !document.querySelector(SEL.popoverWrapper), {
      timeout: CONFIG.popoverCloseSettleMs,
      label: 'popover wrapper removed from DOM',
    });
    log(`    ✓ Popover wrapper gone from DOM`);
  } catch (_) {
    log(`    ⚠ Popover wrapper still present after ${CONFIG.popoverCloseSettleMs}ms — proceeding anyway`, 'warn');
  }

  // Dump editor.children via MAIN-world bridge. This reveals the mention node's
  // exact schema — type, characterId/name fields, children structure. Once we
  // know the schema we can call slate:insert-nodes directly, bypassing the picker.
  try {
    const children = await slateRequest('slate:children');
    log(`    [slate:children] ${JSON.stringify(children)}`);
  } catch (e) {
    log(`    [slate:children] err: ${e.message}`, 'warn');
  }

  log(`    ✓ Character "${name}" inserted`, 'success');
}

// ─── FROM flow-character-inject.js: prompt parsing + orchestration ────────────────

/**
 * Split a prompt string into ordered {type, value} segments.
 * Token syntax: @{Character Name} — braces required so multi-word names and
 * punctuation are unambiguous.
 *
 * Example: "Wide shot of @{Trevor} arguing with @{Michael} at night"
 * → [{type:'text', value:'Wide shot of '}, {type:'char', value:'Trevor'},
 *    {type:'text', value:' arguing with '}, {type:'char', value:'Michael'},
 *    {type:'text', value:' at night'}]
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

// ─── MODEL CHECK (extension-only, not in reference) ──────────────────────────────

/**
 * Find Flow's model selector button and verify it shows CONFIG.expectedModel.
 * Matched by visible text (innerText), not by class. Logs a warning but does not
 * abort — the operator decides whether to proceed with the wrong model.
 */
function checkModelSelector(log) {
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
  const modelBtn = buttons.find(
    (btn) => (btn.innerText || btn.textContent || '').trim().toLowerCase()
               .includes(CONFIG.expectedModel.toLowerCase())
  );
  if (!modelBtn) {
    log(
      `⚠ Model selector not found — expected visible text containing` +
      ` "${CONFIG.expectedModel}". Verify the correct model is selected in Flow.`,
      'warn'
    );
    return;
  }
  const actual = (modelBtn.innerText || modelBtn.textContent || '').trim();
  log(`✓ Model: "${actual}"`, 'success');
}

// ─── MAIN INSERTION ENTRY POINT ───────────────────────────────────────────────────

/**
 * Parse `raw` and drive each segment into the Slate editor in order.
 * Text segments use insertText(); character tokens use the full picker sequence.
 */
// Remove every literal "@<name>" string from editable text nodes after all
// chips are committed. The picker sequence for each chip leaves the filter
// query ("@Trevor") as visible text next to the chip node; this pass erases
// those artifacts without touching the chip elements themselves
// (contenteditable="false" nodes are skipped by the walker filter).
//
// Two-step: (1) delete each "@name" match, (2) collapse any double spaces that
// result from having had a space before and after the deleted text.
// Insert `text` at the caret position described by `placeCaret()`, with:
//   • explicit editor.focus() before every attempt (button clicks during chip
//     commit steal focus, leaving execCommand with no valid selection target)
//   • execCommand return-value capture + post-insert textContent verification
//   • up to 5 attempts with graduated back-off (200/400/600/800 ms) before declaring failure
//
// Returns true if the text landed in the editor, false on total failure.
async function insertTextVerified(editorEl, text, placeCaret, log, label) {
  const fp = text.replace(/[​﻿‌‍]/g, '').trim().slice(0, 30);

  for (let attempt = 1; attempt <= 5; attempt++) {
    // Bail out the moment the editor is detached from the document. When Flow
    // crashes (Next.js error boundary unmounts the app), retrying is pointless
    // and actively noisy: every attempt calls placeCaret() twice, each of which
    // fails with "addRange(): The given range isn't in document" against the
    // dead tree. Observed as 10+ such console errors per crashed prompt.
    if (!editorEl.isConnected) {
      log(`  ${label} ✗ Editor is detached from the document — Flow appears to have crashed; aborting retries`, 'error');
      return false;
    }

    if (attempt > 1) {
      const ms = 200 * (attempt - 1); // 200 / 400 / 600 / 800 ms
      log(`  ${label} ↺ retry ${attempt - 1} (waiting ${ms}ms)`);
      await sleep(ms);
    }

    // ── 1. Position caret BEFORE focus ────────────────────────────────────
    // Slate's 'focus' event handler reads window.getSelection() to sync its
    // internal cursor. If we call editor.focus() first, Slate syncs from
    // whatever position the browser chose (often start-of-editor). Setting
    // the DOM selection first ensures Slate's focus handler picks up the
    // correct caret position.
    placeCaret();

    // ── 2. Focus editor ───────────────────────────────────────────────────
    // After insertCharacter the "Add to Prompt" button click moves browser
    // focus away from the editor, silently breaking execCommand.
    editorEl.focus();
    const focusOk = document.activeElement === editorEl ||
                    editorEl.contains(document.activeElement);

    // Re-apply caret after focus in case focus() reset the selection
    // (some browsers move the cursor to the start on .focus()).
    placeCaret();
    const sel  = window.getSelection();
    const selOk = !!(sel && sel.rangeCount > 0);

    log(`  ${label} [att ${attempt}] focus:${focusOk ? '✓' : '✗'} sel:${selOk ? `✓(${sel.rangeCount})` : '✗'}`);

    if (!selOk) continue; // can't insert without a range

    // ── 3. Insert ──────────────────────────────────────────────────────────
    // Log editor state right before execCommand so failed attempts are diagnosable:
    // if focus and sel are both ✓ but text still doesn't land, the snapshot shows
    // what the caret's anchor node looked like at the moment of insertion.
    const prevSnap = editorText(editorEl);
    const anchorOffset = sel.anchorNode ? sel.anchorOffset : '?';
    const anchorText   = sel.anchorNode
      ? (sel.anchorNode.textContent || '').slice(0, 40).replace(/\n/g, '↵')
      : '—';
    log(`  ${label} [att ${attempt}] pre-exec: offset=${anchorOffset} anchor="${anchorText}" editor="${prevSnap}"`);
    const cmdOk    = document.execCommand('insertText', false, text);
    if (!cmdOk) {
      // execCommand can return false in some browser builds; try the InputEvent
      // fallback so Slate's beforeinput pipeline still receives the text.
      editorEl.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText', data: text, bubbles: true, cancelable: true,
      }));
      editorEl.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText', data: text, bubbles: true,
      }));
    }

    await sleep(60); // one Slate tick

    // ── 4. Verify ─────────────────────────────────────────────────────────
    const nowSnap  = editorText(editorEl);
    const appeared = nowSnap.includes(fp) && nowSnap !== prevSnap;
    log(`  ${label} [att ${attempt}] cmd:${cmdOk ? '✓' : '✗'} appeared:${appeared ? '✓' : '✗'} | "${nowSnap}"`);

    if (appeared) return true;
  }

  log(`  ${label} ✗ ALL RETRIES FAILED — "${fp}" not in editor`, 'error');
  return false;
}

// Remove every literal "@<name>" string from editable text nodes after all
// chips are committed. The picker sequence for each chip leaves the filter
// query ("@Trevor") as visible text next to the chip node; this pass erases
// those artifacts without touching the chip elements themselves
// (contenteditable="false" nodes are skipped by the walker filter).
//
// Two-step: (1) delete each "@name" match, (2) collapse any double spaces that
// result from having had a space before and after the deleted text.
function cleanupStrayQueryText(editorEl, charNames, log) {
  const skipChips = {
    acceptNode(node) {
      let el = node.parentElement;
      while (el && el !== editorEl) {
        if (el.contentEditable === 'false') return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  };

  // Step 1: For each character name, repeatedly find and delete "@name" until
  // none remain. "Restart after mutation" avoids stale TreeWalker references.
  for (const name of charNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pat = new RegExp('@' + escaped, 'gi');

    let found = true;
    let guard = 0;
    while (found && guard++ < 20) {
      found = false;
      const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT, skipChips);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent;
        pat.lastIndex = 0;
        const m = pat.exec(text);
        if (!m) continue;

        const start = m.index;
        const end   = start + m[0].length;
        const ctx   = text.slice(Math.max(0, start - 8), end + 8)
                          .replace(/[​﻿‌‍]/g, '·');
        log(`  [cleanup] "@${name}" → deleting from "…${ctx}…"`);
        deleteRange(node, start, end);
        found = true;
        break; // walker is stale after DOM mutation — restart
      }
    }
    if (!found && guard === 1) log(`  [cleanup] No "@${name}" in text nodes`);
  }

  // Step 2: Fix any double-spaces that resulted from the deletions.
  let dbl = true;
  let dblGuard = 0;
  while (dbl && dblGuard++ < 20) {
    dbl = false;
    const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT, skipChips);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      const idx  = text.indexOf('  ');
      if (idx < 0) continue;
      log(`  [cleanup] double space at [${idx}] → collapsing`);
      deleteRange(node, idx, idx + 1);
      dbl = true;
      break;
    }
  }
}

// Walk every editable text node in the editor and report whether each node
// containing `textFp` is Slate-model-owned or orphaned DOM. Text inserted via
// the native input pipeline (execCommand / InputEvent) ends up inside a
// data-slate-node / data-slate-leaf / data-slate-string element. Text that
// is injected directly into the DOM (e.g. via Range manipulation that Slate
// doesn't observe) appears visually but lives outside Slate's virtual document
// — Flow's generator reads the model, not the raw DOM, so it would be ignored.
function checkSlateOwnership(editorEl, textFp, log) {
  const skipChips = {
    acceptNode(node) {
      let el = node.parentElement;
      while (el && el !== editorEl) {
        if (el.contentEditable === 'false') return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  };

  const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT, skipChips);
  let node;
  let checked = 0;
  while ((node = walker.nextNode())) {
    const t = node.textContent.replace(/[​﻿‌‍]/g, '');
    if (!t.includes(textFp)) continue;
    checked++;

    let el = node.parentElement;
    let slateAttr = null;
    while (el && el !== editorEl) {
      if (el.hasAttribute('data-slate-node'))   { slateAttr = `node="${el.getAttribute('data-slate-node')}"`; break; }
      if (el.hasAttribute('data-slate-leaf'))   { slateAttr = 'leaf'; break; }
      if (el.hasAttribute('data-slate-string')) { slateAttr = 'string'; break; }
      el = el.parentElement;
    }
    const owned = slateAttr !== null;
    log(`  [diag:own] "${t.slice(0, 35)}" → ${owned ? `✓ Slate (${slateAttr})` : '✗ ORPHANED — NOT in Slate model'}`);
  }
  if (checked === 0) log(`  [diag:own] No text node containing "${textFp}"`);
}

async function insertPrompt(raw, log) {
  log('── Prompt insertion starting (picker flow + Slate selection fix) ──');

  // ── Editor discovery + SPA recovery ──────────────────────────────────────────
  //
  // After Flow displays a generated image it SPA-navigates to a storyboard/gallery
  // route that unmounts the Slate editor. The content script survives the route
  // change (same origin, port stays open), but document.querySelector(SEL.editor)
  // returns null. Recovery: click the "+" / add_2 addButton (button[aria-haspopup])
  // which re-opens the create panel, then wait for the editor to mount.
  let editorEl = document.querySelector(SEL.editor);
  if (!editorEl) {
    log('⚠ Slate editor not in DOM — Flow may have navigated to storyboard view. Trying addButton…', 'warn');
    const addBtn = document.querySelector(SEL.addButton);
    if (addBtn) {
      addBtn.click();
      log('  Clicked addButton — waiting up to 8 s for editor to mount…');
      try {
        editorEl = await waitFor(
          () => document.querySelector(SEL.editor),
          { timeout: 8000, label: 'Slate editor after addButton click' }
        );
        log('✓ Slate editor mounted after addButton click');
        await sleep(150); // brief settle before interacting
      } catch (_) {
        log('  Editor did not appear after addButton click', 'warn');
      }
    } else {
      log('  addButton not found in DOM either', 'warn');
    }
  }
  if (!editorEl) {
    throw new Error(`Slate editor not found — are you on the Flow prompt tab? (${SEL.editor})`);
  }
  log('✓ Slate editor found');

  // Verify MAIN-world bridge — insertCharacter relies on it for the selection fix
  // (slate:select-query-end) right before each option click.
  try {
    await slateRequest('slate:ping', null, 2000);
    log('✓ MAIN-world bridge ready');
  } catch (e) {
    throw new Error(
      'MAIN-world bridge not responding: ' + e.message +
      ' — reload the Flow tab after (re)installing the extension.'
    );
  }

  // Clear the Slate model before each new prompt insertion.
  // execCommand('delete') at [ck1b] only clears the DOM — Slate's internal model
  // retains previous content. slate:clear wipes the model and collapses selection
  // to [0,0]:0 so slate:insert-text-at-start always prepends into an empty model.
  let slateClearOk = false;
  try {
    await slateRequest('slate:clear', null, 3000);
    slateClearOk = true;
    log('✓ Slate model cleared');
  } catch (e) {
    log(`⚠ slate:clear failed: ${e.message} — model may have stale content`, 'warn');
  }

  checkModelSelector(log);

  const segments = parsePrompt(raw);
  if (!segments.length) throw new Error('Prompt is empty after parsing.');

  const summary = segments.map(s =>
    s.type === 'char' ? `[@${s.value}]` : `"${s.value}"`
  ).join(' ');
  log(`✓ Parsed ${segments.length} segment(s): ${summary}`);

  // ── Leading-text deferral ─────────────────────────────────────────────────
  //
  // Flow's mention commit wipes all Slate content from block-start to the cursor
  // when the editor contains text before an uncommitted @query. The fix is to
  // avoid that scenario entirely: defer any text that must appear BEFORE the
  // first chip and insert it LAST, via the MAIN-world Slate API (which writes
  // directly into Slate's owned model — unlike the earlier DOM setStartBefore
  // attempt, which created uneditable orphan nodes).
  //
  // Example: "Cars in the background with @{Trevor} in front."
  //   leadingText  = "Cars in the background with "
  //   mainSegments = [ {char:"Trevor"}, {text:" in front."} ]
  //
  //   Execution order:
  //     1. insertCharacter("Trevor") into empty editor  — chip committed, thumbnail appears
  //     2. insertTextVerified(" in front.")             — lands after chip via execCommand
  //     3. slate:insert-text-at-start("Cars in …")     — prepended via Slate API
  //
  // When there is no leading text (first segment is a char, or there are no chars
  // at all), mainSegments === segments and no Slate API call is needed.
  const firstCharIdx  = segments.findIndex(s => s.type === 'char');
  const hasLeadingText = firstCharIdx > 0; // text segment(s) before first chip

  // Concatenate all text segments that precede the first chip (in practice it's
  // always a single segment, but handle the general case).
  const leadingText   = hasLeadingText
    ? segments.slice(0, firstCharIdx).map(s => s.value).join('')
    : null;
  const mainSegments  = hasLeadingText ? segments.slice(firstCharIdx) : segments;

  if (leadingText !== null) {
    log(`  [order] Leading text deferred: "${leadingText}"`);
    log(`  [order] Main segments: ${mainSegments.map(s => s.type === 'char' ? `[@${s.value}]` : `"${s.value}"`).join(' ')}`);
  }

  // Focus once; subsequent segments inherit the caret left by the previous one.
  focusEditor();
  log(`[ck1] Editor after focus: "${editorText(editorEl)}"`);

  // ── Clear stale content from a previous failed generation ────────────────────
  //
  // When clickGenerate fails (generate button never becomes enabled), Flow does
  // not reset the editor. The next insertPrompt call finds stale text in the DOM
  // and insertTextVerified appends to it instead of replacing it (because
  // focusEditor collapses to end rather than selecting all — that collapse is
  // intentional mid-flow to avoid clobbering already-typed segments, but at the
  // START of a fresh insertion we DO want to wipe whatever was left behind).
  //
  // LAST-RESORT ONLY — runs solely when the Slate-API clear above FAILED.
  //
  // WHY THIS IS GATED: selectNodeContents + execCommand('delete') spans the
  // whole editor, including the contenteditable="false" void nodes that back
  // character chips, and rips them out of the DOM directly. React still has
  // those nodes in its tree, so its next commit tries to remove them from a
  // parent they're no longer in and throws
  //   NotFoundError: Failed to execute 'removeChild' on 'Node'
  // which Next.js's error boundary escalates into a full "client-side
  // exception" that tears down the whole Flow app. That was the recurring
  // mid-queue crash. slate:clear already empties the model through Slate's
  // own API (keeping React in sync), and it succeeds on essentially every
  // run — so doing this DOM pass afterwards was both redundant and the thing
  // breaking the page. Only reach for it if the safe path genuinely failed.
  if (!slateClearOk && editorText(editorEl).trim()) {
    log(`[ck1b] slate:clear failed and editor still has content — falling back to DOM delete (may destabilize Flow)`, 'warn');
    const range = document.createRange();
    range.selectNodeContents(editorEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete', false, null);
    await sleep(80);
    log(`[ck1b] Editor after stale-content clear: "${editorText(editorEl)}"`);
  } else if (editorText(editorEl).trim()) {
    log(`[ck1b] Editor DOM still shows text after slate:clear ("${editorText(editorEl).slice(0, 40)}…") — leaving it alone; Slate's model is authoritative and the DOM will reconcile`);
  }

  // ── Main segment loop (left-to-right, no leading text) ───────────────────
  //
  // TEXT → insertTextVerified (execCommand, caret after last chip or at end)
  // CHAR → insertCharacter   (picker → slate:select-query-end fix → commit)
  for (let i = 0; i < mainSegments.length; i++) {
    const seg    = mainSegments[i];
    const prefix = `  [${i + 1}/${mainSegments.length}]`;

    if (seg.type === 'text') {
      const prevSeg = mainSegments[i - 1];
      const placeCaret = () => {
        const s = window.getSelection();
        if (!s) return;
        // Editor unmounted (Flow crashed) — every selection call below would
        // throw "The given range isn't in document" against the dead tree.
        if (!editorEl.isConnected) return;
        if (prevSeg?.type === 'char') {
          const chips    = editorEl.querySelectorAll('[contenteditable="false"]');
          const lastChip = chips[chips.length - 1];
          if (lastChip) {
            const afterNode = nearestEditableText(lastChip, 'next');
            if (afterNode) { s.collapse(afterNode, 0); return; }
            const parent = lastChip.parentNode;
            s.collapse(parent, [...parent.childNodes].indexOf(lastChip) + 1);
            return;
          }
        }
        // [DIAG] Log editor structure to confirm where the placeholder sits.
        const _anyPH = editorEl.querySelector('[data-slate-placeholder]');
        const _directPH = [...editorEl.childNodes].find(
          n => n.nodeType === Node.ELEMENT_NODE && n.matches('[data-slate-placeholder]')
        );
        log(`[placeCaret:DIAG] childNodes=${editorEl.childNodes.length} directPH=${!!_directPH} anyPH=${!!_anyPH} anyPH.text="${(_anyPH?.textContent ?? '—').slice(0, 30)}"`);

        // TreeWalker: find the last text node that has no [data-slate-placeholder]
        // ancestor. The previous direct-childNodes filter was a no-op because the
        // placeholder is a grandchild (inside the Slate paragraph node, not a direct
        // child of editorEl). collapse(false) on the paragraph still ended in the
        // placeholder. TreeWalker traverses the full subtree and rejects any text
        // node whose ancestor chain includes [data-slate-placeholder].
        const walker = document.createTreeWalker(
          editorEl,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode(node) {
              let el = node.parentElement;
              while (el && el !== editorEl) {
                if (el.hasAttribute('data-slate-placeholder')) return NodeFilter.FILTER_REJECT;
                el = el.parentElement;
              }
              return NodeFilter.FILTER_ACCEPT;
            }
          }
        );
        let lastTextNode = null;
        while (walker.nextNode()) lastTextNode = walker.currentNode;

        const _lastText = (lastTextNode?.textContent ?? '(none)')
          .slice(0, 40).replace(/﻿/g, '[FEFF]').replace(/​/g, '[ZWS]');
        log(`[placeCaret:DIAG] lastTextNode="${_lastText}"`);

        if (lastTextNode) {
          s.collapse(lastTextNode, lastTextNode.length);
          const _anchor = (window.getSelection()?.anchorNode?.textContent ?? '')
            .slice(0, 40).replace(/﻿/g, '[FEFF]');
          log(`[placeCaret:DIAG] anchor after collapse="${_anchor}"`);
          return;
        }
        // Fallback: no non-placeholder text node found; collapse to end of editorEl.
        log('[placeCaret:DIAG] FALLBACK: collapsing editorEl end');
        const r = document.createRange();
        r.selectNodeContents(editorEl);
        r.collapse(false);
        applyRange(r); // guarded: no-ops if the editor is detached (crashed page)
      };

      log(`${prefix} Typing: "${seg.value}"`);
      const ok = await insertTextVerified(editorEl, seg.value, placeCaret, log, prefix);
      if (!ok) {
        log(`${prefix} Aborting — text insert failed.`, 'error');
        return;
      }
      log(`${prefix} Editor DOM: "${editorText(editorEl)}"`);

      // ── Slate model verification + MAIN-world fallback ──────────────────────
      // execCommand updates the DOM but Slate's beforeinput pipeline may not
      // update the internal model (e.g. if the event fires but Slate ignores it
      // for inserts into the zero-width sentinel node). Query slate:children to
      // confirm text landed in the model. If it's absent, call editor.insertText()
      // via the MAIN-world bridge — the same mechanism proven to work for
      // leading-text insertion (slate:insert-text-at-start).
      let _slateChildren = null;
      try {
        _slateChildren = await slateRequest('slate:children', null, 2000);
        log(`${prefix} [slate:children] ${JSON.stringify(_slateChildren)}`);
      } catch (e) {
        log(`${prefix} [slate:children] err: ${e.message}`, 'warn');
      }
      const _collectText = (nodes) => {
        let t = '';
        for (const n of (nodes || [])) {
          if (typeof n.text === 'string') t += n.text;
          if (Array.isArray(n.children)) t += _collectText(n.children);
        }
        return t;
      };
      const _fp20          = seg.value.replace(/[​﻿‌‍]/g, '').trim().slice(0, 20);
      const _slateModelTxt = _collectText(_slateChildren || []).replace(/﻿/g, '');
      const _slateHasTxt   = _slateModelTxt.includes(_fp20);
      log(`${prefix} [slate:model] "${_slateModelTxt.slice(0, 60)}" hasText:${_slateHasTxt}`);

      if (!_slateHasTxt) {
        log(`${prefix} execCommand wrote to DOM but Slate model is empty — MAIN-world fallback`);
        if (!prevSeg) {
          // No prior segment: the editor was empty at segment start. [0,0]:0 is the
          // only valid Slate point, so slate:insert-text-at-start is correct here.
          try {
            const _mwRes = await slateRequest('slate:insert-text-at-start', { text: seg.value }, 3000);
            log(`${prefix} MAIN-world insert ✓ children: ${JSON.stringify(_mwRes?.children ?? _mwRes)}`);
          } catch (e) {
            log(`${prefix} MAIN-world insert ✗ ${e.message}`, 'error');
            return;
          }
        } else {
          log(`${prefix} [warn] post-chip text absent from Slate model — no MAIN-world fallback yet`, 'warn');
        }
      }

    } else {
      log(`${prefix} Inserting character: "${seg.value}"`);
      await insertCharacter(seg.value, log, { exact: true });
      log(`${prefix} Editor: "${editorText(editorEl)}"`);
    }
  }

  // ── Prepend leading text via MAIN-world Slate API ─────────────────────────
  //
  // All chips are now committed (character registration complete). Insert
  // leading text at path [0,0]:0 — directly into Slate's model — so it
  // appears before the first chip as a proper Slate-owned text node.
  if (leadingText) {
    log(`  [lead] Prepending "${leadingText}" via slate:insert-text-at-start…`);
    try {
      const res = await slateRequest('slate:insert-text-at-start', { text: leadingText });
      log(`  [lead] ✓ Done`);
      log(`  [slate:children] ${JSON.stringify(res.children)}`);
    } catch (e) {
      log(`  [lead] ✗ Failed: ${e.message}`, 'error');
    }
  }

  log(`✓ Editor full text: "${editorText(editorEl)}"`, 'success');
  log('── Insertion complete — inspect the editor before generating ──', 'success');
}




// ─── PICKER DATA SOURCE DIAGNOSIS ────────────────────────────────────────────────
//
// Automated investigation of what the "@Name" picker is actually showing.
//
// The question being answered: does Virtuoso receive only registered character
// rows, or does its item list also include image/asset filenames (which would
// inflate the dataset and slow down render when the library is large)?
//
// Sequence:
//   1. Install the broad network interceptor (fetch + XHR)
//   2. Type "@{characterName}" into the editor to open the picker
//   3. Wait for the Virtuoso list to appear
//   4. Call slate:inspect-picker while the list is visible:
//        — walks fiber tree upward from the list container
//        — surfaces all array props (full item list before client-side filter)
//        — surfaces all string props matching /query|filter|search|…/
//        — reports component names (orientation)
//   5. Call slate:get-requests to see if any server request fired during the open
//   6. Press Escape to close the picker and backspace the injected text
//
// Results are all streamed through `log` so they appear in the popup log panel.
// The editor state is left unchanged (any stray "@name" text is removed).
async function diagnosePicker(characterName, log) {
  log(`[diag:picker] Starting picker diagnosis for "@${characterName}"…`);

  // Step 1: install broad network interceptor
  try {
    await slateRequest('slate:patch-network-all', null, 3000);
    log(`[diag:picker] Network interceptor installed (fetch + XHR)`);
  } catch (e) {
    log(`[diag:picker] ⚠ Network interceptor failed: ${e.message} — continuing without it`, 'warn');
  }
  const netStartTs = Date.now();

  // Step 2: open picker
  const editorEl = document.querySelector(SEL.editor);
  if (!editorEl) throw new Error(`Editor not found (${SEL.editor})`);

  focusEditor();

  // Collapse to end of editor so the "@" lands at the tail, not mid-text.
  const selObj = window.getSelection();
  if (selObj) {
    const rng = document.createRange();
    rng.selectNodeContents(editorEl);
    rng.collapse(false);
    selObj.removeAllRanges();
    selObj.addRange(rng);
  }

  log(`[diag:picker] Firing "@" keydown + execCommand…`);
  editorEl.dispatchEvent(new KeyboardEvent('keydown', {
    key: '@', code: 'Digit2', keyCode: 50, which: 50,
    shiftKey: true, bubbles: true, cancelable: true,
  }));
  document.execCommand('insertText', false, '@');
  editorEl.dispatchEvent(new KeyboardEvent('keyup', {
    key: '@', code: 'Digit2', keyCode: 50, which: 50,
    shiftKey: true, bubbles: true, cancelable: true,
  }));

  // Step 2b: type the filter name
  log(`[diag:picker] Typing filter text "${characterName}"…`);
  insertText(characterName);

  // Step 3: wait for Virtuoso list
  let pickerOpen = false;
  try {
    await waitFor(() => document.querySelector(SEL.optionList), {
      timeout: CONFIG.timeoutMs, label: 'Virtuoso option list',
    });
    pickerOpen = true;
    log(`[diag:picker] Picker is open — "${SEL.optionList}" found in DOM`);
  } catch (_) {
    log(`[diag:picker] ⚠ Picker did not open within ${CONFIG.timeoutMs}ms — proceeding with inspection anyway`, 'warn');
  }

  // Give Virtuoso one render tick to populate items
  await sleep(200);

  // Step 4: inspect fiber
  log(`[diag:picker] ── Fiber inspection ──`);
  try {
    const pd = await slateRequest('slate:inspect-picker', null, 4000);

    log(`[diag:picker] Rendered rows in Virtuoso DOM: ${pd.renderedItemCount}`);

    if (pd.components.length) {
      log(`[diag:picker] Component chain (inner → outer): ${pd.components.map(c => `${c.name}(d${c.depth})`).join(' → ')}`);
    } else {
      log(`[diag:picker] ⚠ No named components found — picker may use anonymous functions`);
    }

    if (pd.dataProps.length) {
      log(`[diag:picker] Array props found on ancestor components:`);
      for (const dp of pd.dataProps) {
        const comp = dp.component ? ` [${dp.component}]` : '';
        log(`[diag:picker]   d${dp.depth}${comp} .${dp.prop}: ${dp.length} items — shape: ${JSON.stringify(dp.itemShape)}`);
        log(`[diag:picker]     sample[0]: ${JSON.stringify(dp.sample?.[0])}`);
        if (dp.sample?.[1] !== undefined) {
          log(`[diag:picker]     sample[1]: ${JSON.stringify(dp.sample[1])}`);
        }
      }
    } else {
      log(`[diag:picker] ⚠ No array props on any ancestor — data may be in memoized hook state (not accessible via props walk)`);
    }

    if (pd.queryProps.length) {
      log(`[diag:picker] Filter/query string props:`);
      for (const qp of pd.queryProps) {
        const comp = qp.component ? ` [${qp.component}]` : '';
        log(`[diag:picker]   d${qp.depth}${comp} .${qp.prop} = "${qp.value}"`);
      }
    } else {
      log(`[diag:picker] No filter/query string props found on ancestor components`);
    }
  } catch (e) {
    log(`[diag:picker] ✗ slate:inspect-picker failed: ${e.message}`, 'error');
  }

  // Step 5: network activity
  log(`[diag:picker] ── Network requests since "@" was typed ──`);
  try {
    const nd = await slateRequest('slate:get-requests', { since: netStartTs }, 3000);
    if (nd.count === 0) {
      log(`[diag:picker] No requests fired — filtering is client-side (full dataset was pre-loaded)`);
    } else {
      log(`[diag:picker] ${nd.count} request(s) captured:`);
      for (const req of nd.requests) {
        const age = req.ts - netStartTs;
        log(`[diag:picker]   +${age}ms [${req.via}] ${req.method} ${req.url}`);
        if (req.body) {
          log(`[diag:picker]     body: ${JSON.stringify(req.body).slice(0, 300)}`);
        }
      }
    }
  } catch (e) {
    log(`[diag:picker] ✗ slate:get-requests failed: ${e.message}`, 'error');
  }

  // Step 6: close picker + clean up
  log(`[diag:picker] Closing picker (Escape) and removing injected "@${characterName}"…`);
  editorEl.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
    bubbles: true, cancelable: true,
  }));
  await sleep(150);

  // Backspace out "@" + characterName
  const injected = '@' + characterName;
  const current  = editorText(editorEl);
  if (current.endsWith(injected)) {
    const s2 = window.getSelection();
    if (s2) {
      const rng2 = document.createRange();
      rng2.selectNodeContents(editorEl);
      rng2.collapse(false);
      s2.removeAllRanges();
      s2.addRange(rng2);
    }
    for (let i = 0; i < injected.length; i++) {
      document.execCommand('delete', false, null);
    }
    log(`[diag:picker] Removed "${injected}" from editor`);
  } else {
    log(`[diag:picker] Editor text did not end with "${injected}" — leaving as-is (current: "${current.slice(-40)}")`);
  }

  log(`[diag:picker] ── Diagnosis complete ──`, 'success');
}

// ─── CHARACTER ROSTER EXTRACTION ──────────────────────────────────────────────────
//
// One-shot helper to populate CHARACTER_ID_MAP without inserting every character
// through the picker one at a time. Opens the "@" picker, switches to the
// Characters tab, then reads the full character array straight out of
// Virtuoso's React props via slate:extract-roster (bypasses the DOM entirely,
// so no scrolling or typed filtering is involved). Logs every name → ID pair
// so they can be copy-pasted into CHARACTER_ID_MAP.
async function extractCharacterRoster(log) {
  log(`[roster] Opening picker to read the full character list…`);

  const editorEl = document.querySelector(SEL.editor);
  if (!editorEl) throw new Error(`Editor not found (${SEL.editor})`);

  focusEditor();
  const selObj = window.getSelection();
  if (selObj) {
    const rng = document.createRange();
    rng.selectNodeContents(editorEl);
    rng.collapse(false);
    selObj.removeAllRanges();
    selObj.addRange(rng);
  }

  editorEl.dispatchEvent(new KeyboardEvent('keydown', {
    key: '@', code: 'Digit2', keyCode: 50, which: 50,
    shiftKey: true, bubbles: true, cancelable: true,
  }));
  document.execCommand('insertText', false, '@');
  editorEl.dispatchEvent(new KeyboardEvent('keyup', {
    key: '@', code: 'Digit2', keyCode: 50, which: 50,
    shiftKey: true, bubbles: true, cancelable: true,
  }));

  try {
    await waitFor(() => document.querySelector(SEL.optionList), {
      timeout: CONFIG.timeoutMs, label: 'Virtuoso option list',
    });
    log(`[roster] Picker open`);
  } catch (e) {
    throw new Error(`Picker never opened: ${e.message}`);
  }

  // Switch to the Characters tab so the roster we read is characters only.
  const allTabs = [...document.querySelectorAll('[role="tab"]')];
  const charsTab = allTabs.find((t) => t.textContent.trim().includes('Characters'));
  if (charsTab && charsTab.getAttribute('aria-selected') !== 'true') {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      charsTab.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    await sleep(300);
  }

  try {
    const res = await slateRequest('slate:extract-roster', null, 4000);
    log(`[roster] Found ${res.count} character(s) via prop "${res.prop}" (${res.source}, depth ${res.depth}, id key "${res.idKey}", name key "${res.nameKey}")`, 'success');
    log(`[roster] ── Paste these into CHARACTER_ID_MAP (key = name.toLowerCase()) ──`);
    for (const c of res.roster) {
      log(`[roster]   '${String(c.name).toLowerCase()}': '${c.id}',`);
    }
  } catch (e) {
    log(`[roster] ✗ slate:extract-roster failed: ${e.message}`, 'error');
    log(`[roster]   Try diagnosePicker instead to see what array props ARE available.`, 'warn');
  }

  // Close the picker + remove the injected "@".
  editorEl.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true,
  }));
  await sleep(150);
  if (editorText(editorEl).endsWith('@')) {
    const s2 = window.getSelection();
    if (s2) {
      const rng2 = document.createRange();
      rng2.selectNodeContents(editorEl);
      rng2.collapse(false);
      s2.removeAllRanges();
      s2.addRange(rng2);
    }
    document.execCommand('delete', false, null);
  }
  log(`[roster] ── Done ──`, 'success');
}

// ─── CHARACTER ID HARVEST (via real insertion) ───────────────────────────────────
//
// extractCharacterRoster() reads the fiber tree directly but couldn't find a
// matching array prop — Flow's picker data may live somewhere the fiber walk
// doesn't reach (deeper hook state, a closure, etc). This is the fallback:
// reuse the picker-driven insertCharacterImpl(), which is already proven to
// work reliably for any name Virtuoso renders by default (that's every name
// that has EVER matched in a queue run — filtering only breaks for names
// OUTSIDE that default-rendered set, like "Protagonist"). For each name given,
// clear the editor, insert it for real, read its characterServerId back off
// the resulting AT_TAG_TYPE node, then clear and move to the next. Slower
// than a single fiber read, but uses only code paths already known to work.
async function harvestCharacterIds(names, log) {
  const results = [];
  log(`[harvest] Harvesting IDs for ${names.length} name(s) via real insertion…`);

  for (const name of names) {
    log(`[harvest] "${name}" — clearing editor and inserting…`);
    try {
      await slateRequest('slate:clear', null, 3000);
      await insertCharacterImpl(name, log, { exact: true });

      const res = await slateRequest('slate:list-characters', null, 3000);
      const match = (res.characters || []).find(
        (c) => (c.displayText || '').toLowerCase() === name.toLowerCase()
      );
      if (match) {
        log(`[harvest]   '${name.toLowerCase()}': '${match.characterServerId}',`, 'success');
        results.push({ name, id: match.characterServerId });
      } else {
        log(`[harvest]   ⚠ inserted but couldn't read back its ID via slate:list-characters`, 'warn');
      }
    } catch (e) {
      log(`[harvest]   ✗ "${name}" failed: ${e.message}`, 'error');
      await closePickerIfOpen(log);
    }
    await sleep(300);
  }

  try { await slateRequest('slate:clear', null, 3000); } catch (_) {}

  log(`[harvest] ── Done: ${results.length}/${names.length} harvested ──`, 'success');
  if (results.length) {
    log(`[harvest] ── Paste these into CHARACTER_ID_MAP ──`);
    for (const r of results) log(`[harvest]   '${r.name.toLowerCase()}': '${r.id}',`);
  }
  return results;
}

// ─── ADD-TO-PROMPT SIDE-EFFECT DIAGNOSIS ─────────────────────────────────────────
//
// Direct Slate node insertion (bypassing the "@" picker — see
// insertCharacterDirect / CONFIG.useDirectCharacterInsertion) produces a node
// that is structurally identical to a real mention but gets silently
// flattened to plain text before generation, and the resulting image doesn't
// depict the actual character. This strongly suggests clicking "Add to
// Prompt" in the real picker does something beyond mutating the Slate
// document — registers the character reference through some side channel
// (a network call, a client-side cache/store) that our direct path never
// replicates.
//
// This diagnostic snapshots network activity and client-side storage/cache-
// shaped globals before and after a REAL (picker-driven, proven-correct)
// character insertion, then reports everything that changed, to try to find
// that side channel.
function diffSnapshots(before, after) {
  const changes = [];
  function diffSection(section, a, b) {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
      const av = a ? a[k] : undefined;
      const bv = b ? b[k] : undefined;
      if (JSON.stringify(av) !== JSON.stringify(bv)) {
        changes.push({ section, key: k, before: av, after: bv });
      }
    }
  }
  diffSection('localStorage', before.localStorage, after.localStorage);
  diffSection('sessionStorage', before.sessionStorage, after.sessionStorage);
  diffSection('windowKeys', before.windowKeys, after.windowKeys);
  return changes;
}

async function diagnoseAddToPromptSideEffects(characterName, log) {
  log(`[diag:sidefx] Starting side-effect diagnosis for a REAL "@${characterName}" insertion…`);

  try { await slateRequest('slate:clear', null, 3000); } catch (_) {}

  try {
    await slateRequest('slate:patch-network-all', null, 3000);
    log(`[diag:sidefx] Network interceptor installed (captures request + response bodies)`);
  } catch (e) {
    log(`[diag:sidefx] ⚠ Network interceptor failed: ${e.message} — continuing without it`, 'warn');
  }
  const netStartTs = Date.now();

  let before;
  try {
    before = await slateRequest('slate:snapshot-state', null, 4000);
    log(`[diag:sidefx] Snapshot BEFORE: ${Object.keys(before.localStorage).length} localStorage, ${Object.keys(before.sessionStorage).length} sessionStorage, ${Object.keys(before.windowKeys).length} cache-shaped window key(s)`);
  } catch (e) {
    log(`[diag:sidefx] ✗ snapshot BEFORE failed: ${e.message}`, 'error');
    return;
  }

  log(`[diag:sidefx] Inserting "${characterName}" via the REAL picker (proven-correct path)…`);
  try {
    await insertCharacterImpl(characterName, log, { exact: true });
  } catch (e) {
    log(`[diag:sidefx] ✗ insertCharacterImpl failed: ${e.message}`, 'error');
    await closePickerIfOpen(log);
    return;
  }

  log(`[diag:sidefx] Waiting 1.5s for any async side effects to settle…`);
  await sleep(1500);

  let after;
  try {
    after = await slateRequest('slate:snapshot-state', null, 4000);
  } catch (e) {
    log(`[diag:sidefx] ✗ snapshot AFTER failed: ${e.message}`, 'error');
    return;
  }

  log(`[diag:sidefx] ── Network requests during insertion ──`);
  try {
    const nd = await slateRequest('slate:get-requests', { since: netStartTs }, 3000);
    if (nd.count === 0) {
      log(`[diag:sidefx]   (none — if a side channel exists, it isn't a network call)`);
    } else {
      log(`[diag:sidefx]   ${nd.count} request(s):`);
      for (const req of nd.requests) {
        const age = req.ts - netStartTs;
        log(`[diag:sidefx]   +${age}ms [${req.via}] ${req.method} ${req.url}`);
        if (req.body) log(`[diag:sidefx]     req body: ${JSON.stringify(req.body).slice(0, 500)}`);
        if (req.response) log(`[diag:sidefx]     response: ${JSON.stringify(req.response).slice(0, 800)}`);
        if (req.responseError) log(`[diag:sidefx]     response error: ${req.responseError}`, 'warn');
      }
    }
  } catch (e) {
    log(`[diag:sidefx] ✗ slate:get-requests failed: ${e.message}`, 'error');
  }

  log(`[diag:sidefx] ── State changes (localStorage / sessionStorage / cache-shaped window keys) ──`);
  const changes = diffSnapshots(before, after);
  if (!changes.length) {
    log(`[diag:sidefx]   (none detected — side effect may live in React-internal state not reachable from window, or IndexedDB)`);
  } else {
    for (const c of changes) {
      log(`[diag:sidefx]   [${c.section}] "${c.key}" changed`, 'success');
      log(`[diag:sidefx]     before: ${JSON.stringify(c.before).slice(0, 300)}`);
      log(`[diag:sidefx]     after:  ${JSON.stringify(c.after).slice(0, 300)}`);
    }
  }

  log(`[diag:sidefx] ── Zustand devtools action log (redux-devtools-shim.js) ──`);
  try {
    const dd = await slateRequest('slate:get-devtools-log', { since: netStartTs }, 3000);
    if (dd.count === 0) {
      log(`[diag:sidefx]   (none — either no Zustand store changed, or the shim wasn't installed for this page load)`);
    } else {
      log(`[diag:sidefx]   ${dd.count} entrie(s):`);
      for (const entry of dd.entries) {
        const age = entry.ts - netStartTs;
        log(`[diag:sidefx]   +${age}ms [${entry.store}] ${entry.type}`);
        if (entry.action) log(`[diag:sidefx]     action: ${JSON.stringify(entry.action).slice(0, 300)}`);
        if (entry.state) log(`[diag:sidefx]     state:  ${JSON.stringify(entry.state).slice(0, 800)}`);
      }
    }
  } catch (e) {
    log(`[diag:sidefx] ✗ slate:get-devtools-log failed: ${e.message}`, 'error');
    log(`[diag:sidefx]   (this is expected if the Flow tab hasn't been fully reloaded since the shim was added — reload the tab, not just the extension, and re-run)`, 'warn');
  }

  try { await slateRequest('slate:clear', null, 3000); } catch (_) {}
  log(`[diag:sidefx] ── Diagnosis complete ──`, 'success');
}

// ─── SAVE GENERATED IMAGES ───────────────────────────────────────────────────────

// Save each URL in `urls` to the user's configured download folder via the
// background service worker's SAVE_GENERATED_IMAGE handler.
//
// Filename format: <sanitized-timestamp>[_N].png
//   timestamp sanitization: strip surrounding brackets, replace ":" with "-"
//   e.g. "[0:00]" → "0-00.png", "[0:02:15]" → "0-02-15.png"
//   if urls.length > 1: "0-00.png", "0-00_2.png", "0-00_3.png", …
//
// `log` is the same streaming callback used throughout content.js, so each
// save attempt appears in the popup's log panel.
async function saveGeneratedImages(urls, timestamp, log) {
  const base = timestamp
    .replace(/^\[/, '').replace(/\]$/, '')  // strip surrounding [ ]
    .replace(/:/g, '-');                     // "0:02:15" → "0-02-15"

  // Backstop against a detection bug ever writing a pile of files for one
  // prompt again (previously: 13 saves from a single gallery re-render).
  // waitForOutput should already reject bulk arrivals; refuse here regardless
  // rather than silently filling the download folder.
  if (urls.length > CONFIG.maxOutputsPerPrompt) {
    log(
      `  [save] ✗ Refusing to save ${urls.length} images for one prompt ` +
      `(max ${CONFIG.maxOutputsPerPrompt}) — this looks like gallery content, not output. Nothing saved.`,
      'error'
    );
    return;
  }

  for (let i = 0; i < urls.length; i++) {
    const suffix   = i === 0 ? '' : '_' + (i + 1);
    const filename = base + suffix + '.png';
    log(`  [save] ${filename} ← ${urls[i].slice(0, 60)}…`);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'SAVE_GENERATED_IMAGE',
        url:  urls[i],
        filename,
      });
      if (resp && resp.ok) {
        log(`  [save] ✓ ${filename} (downloadId ${resp.downloadId})`, 'success');
      } else {
        log(`  [save] ✗ ${filename}: ${resp?.error || 'unknown error'}`, 'error');
      }
    } catch (e) {
      log(`  [save] ✗ ${filename}: ${e.message}`, 'error');
    }
  }
}

// ─── OUTPUT DETECTION ────────────────────────────────────────────────────────────

// Resolves when at least one img[alt="Generated image"] appears whose src was
// not present before generation started (beforeSrcs) and is a real HTTP URL.
// Uses a MutationObserver so it reacts immediately when Flow injects the element
// rather than burning CPU in a polling loop.
//
// Returns:
//   { done: true,    urls: string[] }  — one or more new image URLs found
//   { timeout: true, urls: [] }        — timeoutMs elapsed with nothing new
//
// beforeSrcs should be collected with collectCurrentOutputSrcs() immediately
// before clicking Generate so that any pre-existing results are excluded.
function waitForOutput(beforeSrcs, timeoutMs = 120000) {
  // ── DIAGNOSTIC — remove once selector is confirmed ──────────────────────────
  console.log('[waitForOutput] START — beforeSrcs (' + beforeSrcs.size + ' entries):',
    [...beforeSrcs]);

  return new Promise((resolve) => {
    let settled   = false;
    let pollCount = 0;
    const startedAt = Date.now();

    // src → timestamp first observed. A candidate is an image that is genuinely
    // unknown (not in beforeSrcs, which accumulates every src seen this
    // session) and fully decoded. Candidates are HELD rather than accepted
    // immediately: see the minGenerationMs rationale below.
    const candidates = new Map();

    function finish(result) {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearInterval(poller);
      clearTimeout(timer);
      for (const url of result.urls || []) seenOutputSrcs.add(url);
      resolve(result);
    }

    // Scan the DOM and return candidate srcs that are now old enough to accept.
    //
    // Gates a src must clear to even become a candidate:
    //   1. Unknown — beforeSrcs holds every src seen this session, so an old
    //      gallery image lazily re-mounting is recognised as old.
    //   2. Fully decoded (complete && naturalWidth > 0) — Flow mounts <img>
    //      elements before their bytes arrive.
    //
    // Then, before a candidate is accepted, it must have been continuously
    // observed for at least CONFIG.minGenerationMs. Flow's gallery mounts
    // pre-existing results during re-render, which previously caused instant
    // "output detected" and downloading a picture from an earlier prompt. A
    // real generation takes far longer than this floor, so waiting it out
    // separates the two. Crucially the candidate is HELD, not discarded — a
    // fast generation is still returned, just after the floor elapses.
    function collect(trigger) {
      pollCount++;
      const now     = Date.now();
      const elapsed = now - startedAt;
      const imgs = [...document.querySelectorAll('img[alt="Generated image"]')];
      console.log(`[waitForOutput] poll #${pollCount} (${trigger}, +${elapsed}ms): ${imgs.length} img[alt="Generated image"] in DOM`);

      if (imgs.length === 0) {
        console.log('  → no matching <img> elements; selector may not match Flow\'s current markup');
      }

      const live = new Set();
      for (const img of imgs) {
        // Use img.src (the DOM property) not getAttribute('src').
        // getAttribute returns the raw HTML attribute value, which is a relative
        // path like "/fx/api/trpc/...". img.src is browser-resolved to the full
        // absolute URL ("https://labs.google/fx/api/trpc/..."), which is what
        // beforeSrcs contains and what the startsWith('http') guard requires.
        const src      = img.src;
        const isHttp   = src.startsWith('http');
        const inBefore = beforeSrcs.has(src);
        const loaded   = img.complete && img.naturalWidth > 0;
        if (!isHttp || inBefore) continue;
        live.add(src);

        if (!loaded) {
          console.log(`  src="${src}" | not yet decoded — waiting`);
          continue;
        }
        if (!candidates.has(src)) {
          candidates.set(src, now);
          console.log(`  src="${src}" | NEW candidate — holding ${CONFIG.minGenerationMs}ms to rule out gallery re-mount`);
        }
      }

      // Drop candidates that vanished again (transient gallery mounts).
      for (const src of [...candidates.keys()]) {
        if (!live.has(src)) {
          candidates.delete(src);
          console.log(`  src="${src}" | candidate disappeared before maturing — discarded`);
        }
      }

      const ready = [];
      for (const [src, firstSeen] of candidates) {
        const age = now - firstSeen;
        if (age >= CONFIG.minGenerationMs) ready.push(src);
        else console.log(`  src="${src}" | candidate age ${age}ms < ${CONFIG.minGenerationMs}ms floor`);
      }

      // Bulk-arrival rejection. A Generate yields at most
      // CONFIG.maxOutputsPerPrompt images; anything more is Flow's gallery
      // mounting a batch of pre-existing results during a re-render. Those
      // URLs are unknown to us (they can predate this session), so without
      // this check they'd all be treated as output and downloaded — the
      // "13 files for one prompt" failure. Permanently ignore the whole batch
      // and keep waiting for the real, singular result.
      if (ready.length > CONFIG.maxOutputsPerPrompt) {
        console.warn(
          `[waitForOutput] ${ready.length} images matured at once (max expected ${CONFIG.maxOutputsPerPrompt}) — ` +
          `treating as a gallery re-render, not output. Ignoring them and continuing to wait.`
        );
        for (const src of ready) {
          beforeSrcs.add(src);
          seenOutputSrcs.add(src);
          candidates.delete(src);
        }
        return [];
      }

      return ready;
    }

    // Immediate scan. Cannot resolve — anything already present the instant
    // Generate was clicked is by definition not this prompt's output; this
    // pass only seeds the candidate/ignore bookkeeping.
    collect('immediate');

    const timer = setTimeout(() => {
      console.log('[waitForOutput] TIMEOUT after ' + timeoutMs + 'ms — resolving with timeout');
      finish({ timeout: true, urls: [] });
    }, timeoutMs);

    function check(trigger) {
      if (settled) return;
      const found = collect(trigger);
      if (found.length) {
        console.log(`[waitForOutput] resolved DONE via ${trigger}:`, found);
        finish({ done: true, urls: found });
      }
    }

    // Mutation-driven checks catch the image arriving; the interval is what
    // lets a candidate that arrived early mature past the floor even when no
    // further DOM mutations occur.
    const observer = new MutationObserver(() => check('mutation'));
    const poller   = setInterval(() => check('poll'), 1000);

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  });
}

// Every output-image src observed at ANY point this session.
//
// A snapshot of only the currently-mounted images is not enough: Flow's result
// gallery lazily mounts and unmounts older results as it re-renders, so an
// image from a previous prompt can be absent at snapshot time and present a
// moment later. Diffing against the snapshot alone would classify it as new
// output and download the wrong picture. Accumulating every src ever seen
// means a re-mounted old image is still recognised as old.
const seenOutputSrcs = new Set();

// Snapshot output-image srcs to pass to waitForOutput() before triggering a
// generation. Returns the union of what's mounted right now and everything
// seen earlier this session, so only genuinely-new URLs can qualify.
function collectCurrentOutputSrcs() {
  for (const img of document.querySelectorAll('img[alt="Generated image"]')) {
    // img.src (property) gives the browser-resolved absolute URL.
    // getAttribute('src') would give the raw relative path, which would not
    // match the absolute URLs that waitForOutput.collect() now collects.
    const src = img.src;
    if (src) seenOutputSrcs.add(src);
  }
  return new Set(seenOutputSrcs);
}

// ─── GENERATE (extension-only, not in reference) ─────────────────────────────────

async function clickGenerate(log) {
  log('Looking for generate button…');

  // Flow's submit button is NEVER html-disabled. It uses aria-disabled exclusively:
  //   aria-disabled="false"  →  prompt is non-empty, click will fire
  //   aria-disabled="true"   →  prompt is empty, click is a no-op
  // There may be two arrow_forward buttons in the toolbar; we must target the
  // one that is currently aria-disabled="false".
  const isLive = (b) => b.getAttribute('aria-disabled') === 'false';

  const findLiveBtn = () =>
    [...document.querySelectorAll('button')].find(b => {
      const icon = b.querySelector('i');
      return icon &&
        icon.textContent.trim() === SEL.generateIcon &&
        isLive(b);
    });

  // Wait up to 5 s for the button to become live. insertPrompt writes leading
  // text via the MAIN-world Slate API, which triggers React to re-render the
  // toolbar, so there may be a short lag before aria-disabled flips.
  let btn;
  try {
    btn = await waitFor(findLiveBtn, {
      timeout: 5000,
      label: `arrow_forward button with aria-disabled="false"`,
    });
  } catch (e) {
    throw new Error(
      `Generate button never became enabled (aria-disabled="true" the whole time). ` +
      `Prompt may not have landed in Slate's model. ` +
      `(${e.message})`
    );
  }
  log(`✓ Submit button enabled (aria-disabled="false")`);

  // Install network interceptor before triggering the click.
  try { await slateRequest('slate:patch-network', null, 1500); } catch (_) {}

  // Poll for a concrete signal that Flow accepted the submit.
  // Returns a label string on success, null on timeout.
  const editorEl = document.querySelector(SEL.editor);
  const pollSignal = async (timeoutMs) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      // Signal 1: Flow clears the editor after a successful submit.
      if (editorEl && editorText(editorEl).trim() === '') return 'editor-cleared';
      // Signal 2: button flips back to aria-disabled="true" (prompt gone).
      if (!isLive(btn)) return 'button-disabled';
      // Signal 3: a loading / generation indicator appeared.
      if (document.querySelector(
        '[role="progressbar"], [aria-busy="true"], [aria-label*="generating" i], [data-state="loading"]'
      )) return 'spinner-appeared';
      await sleep(100);
    }
    return null;
  };

  // ── Primary: background-worker fiber walk (Zappy Flow pattern) ──────────────
  //
  // Mark the button with a unique token → send REACT_FIBER_CLICK to the
  // background service worker → it injects fiberClickInMainWorld() into the
  // page's MAIN world via chrome.scripting.executeScript, walks the React fiber
  // tree upward from the marked element, and calls onSubmit (no isTrusted check)
  // or onClick (with full SyntheticEvent stub including nativeEvent.isTrusted).
  // This replicates exactly how Zappy Flow bypasses Flow's isTrusted gate.
  const markerAttr = 'data-fp-click-target';
  const markerToken = String(Date.now());
  btn.setAttribute(markerAttr, markerToken);

  let fiberOk = false;
  log('Invoking React handler via background executeScript fiber walk…');
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'REACT_FIBER_CLICK',
      markerAttr,
      token: markerToken,
    });
    if (resp && resp.ok) {
      fiberOk = true;
      const d = resp.detail || {};
      log(`  fiber click OK — method:${d.method} depth:${d.depth} args:${d.args}`);
    } else {
      log(`  fiber click failed — ${(resp && (resp.error || resp.detail?.reason)) || 'no detail'}`, 'warn');
    }
  } catch (e) {
    log(`  fiber click error — ${e.message}`, 'warn');
  } finally {
    btn.removeAttribute(markerAttr);
  }

  // The button goes from aria-disabled="false" to "true" at roughly T+3–5 s after
  // submission (server round-trip). A 3 s timeout consistently exits just before
  // the flip. 8 s gives a comfortable margin without meaningfully delaying the queue.
  let signal = fiberOk ? await pollSignal(8000) : null;

  // ── Secondary: slate:submit (MAIN-world bridge, direct __reactProps$ call) ──
  // Fixed to pass nativeEvent in SyntheticEvent stub. Catches cases where the
  // fiber walk found no handler at any parent level (unlikely but possible if
  // Flow restructures its component tree).
  if (!signal) {
    log('  Falling back to slate:submit (MAIN-world __reactProps$ call)…', 'warn');
    try {
      const res = await slateRequest('slate:submit', null, 3000);
      if (res && res.ok) {
        log('  slate:submit: handler called');
        signal = await pollSignal(3000);
      }
    } catch (e) {
      log(`  slate:submit failed: ${e.message}`, 'warn');
    }
  }

  // ── Tertiary: synthetic DOM event sequence on the button and its icon ────────
  const syntheticClick = (el) => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  };
  if (!signal) {
    log('  Falling back to synthetic events on button…', 'warn');
    syntheticClick(btn);
    signal = await pollSignal(3000);
  }
  if (!signal) {
    const icon = btn.querySelector('i');
    if (icon) {
      log('  No signal — retrying on inner <i> icon…', 'warn');
      syntheticClick(icon);
      signal = await pollSignal(2000);
    }
  }

  if (!signal) {
    log('✗ Generation did not start — no signal after all attempts.', 'error');
    log('  Tried: background executeScript fiber walk → slate:submit → synthetic events.', 'error');
    log('  Check extension console for REACT_FIBER_CLICK details; try clicking generate manually.', 'error');
    return;
  }

  log(`✓ Generation started (signal: ${signal})`, 'success');

  // Retrieve the network payload captured by the interceptor.
  try {
    await sleep(300);
    const netRes = await slateRequest('slate:get-network', null, 2000);
    if (netRes.request) {
      log(`  [network:url] ${netRes.request.url}`);
      log(`  [network:payload] ${JSON.stringify(netRes.request.body)}`);
    } else {
      log('  [network:payload] (none — interceptor did not see the request)');
    }
  } catch (_) {}
}

// ─── PROMPT SCRIPT PARSER ────────────────────────────────────────────────────────
//
// Parses a multi-block script where each prompt is separated by one or more
// blank lines and begins with a bracketed timestamp:
//
//   [0:00]: Wide shot of @{Trevor} walking in rain
//
//   [0:05]: Close up on @{Trevor}'s face, wet hair,
//   dramatic lighting
//
// Multi-line descriptions (the second block above) are captured in full — the
// text after the first colon-space extends to the end of the block.
//
// Returns { items: [{timestamp, text}], errors: [{blockIndex, preview}] }.
// Blocks that don't match the pattern are skipped and reported in errors[].
// The timestamp keeps its surrounding brackets because saveGeneratedImages
// already strips them when building the filename.
function parsePromptScript(rawText) {
  // Split on one or more blank lines (lines that are empty or contain only
  // whitespace) to get individual prompt blocks.
  const blocks = rawText.split(/\n[ \t]*\n+/);
  const items  = [];
  const errors = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block) continue; // skip runs of blank lines at start/end

    // Match "[timestamp]: description" where description may span the rest of
    // the block ([\s\S]+ matches newlines inside the block).
    const m = block.match(/^\[(.+?)\]:\s*([\s\S]+)$/);
    if (!m) {
      errors.push({ blockIndex: i, preview: block.slice(0, 60) });
      continue;
    }

    items.push({
      timestamp: '[' + m[1] + ']',
      text:      m[2].trim(),
    });
  }

  return { items, errors };
}

// ─── PAGE-CRASH DETECTION ─────────────────────────────────────────────────────────
//
// Detects whether Flow's own page has crashed out from under us (Next.js
// error boundary tore down the React tree) vs. an ordinary selector/timing
// failure. The Slate editor is expected to be present on the page at all
// times while a Flow project is open, so its absence is a strong signal the
// app itself died rather than this one prompt failing.
function isPageCrashed() {
  return !document.querySelector(SEL.editor);
}

// ─── FAIL-CARD DETECTION ─────────────────────────────────────────────────────────
//
// Returns true if Flow is showing an explicit generation-failure card, identified
// by a visible button whose trimmed text content is exactly "Retry" or starts with
// "Retry". Used by the queue runner to distinguish a Flow-reported failure (worth
// retrying) from a silent timeout (image may have generated; resubmitting risks a
// duplicate).
function detectFailCard() {
  const btns = [...document.querySelectorAll('button, [role="button"]')];
  return btns.some(b => {
    const t = b.textContent.trim();
    return t === 'Retry' || t.startsWith('Retry');
  });
}

// ─── QUEUE RUNNER ────────────────────────────────────────────────────────────────
//
// Processes an ordered array of { timestamp, text } prompt items one at a time.
// A module-level token guards against stale runs: incrementing queueToken from
// outside (stopQueue action) causes the in-flight loop to detect the change and
// exit cleanly without throwing.

let queueToken = 0;

// promptItems  — [{ timestamp: string, text: string }, …]
// delayMinMs   — minimum random inter-prompt wait (ms)
// delayMaxMs   — maximum random inter-prompt wait (ms)
// log          — streaming log callback (status, level?) → void
//
// Return values (all non-throwing):
//   { done: true,    completed: N }                  — full queue finished
//   { stopped: true, completed: N }                  — cancelled via stopQueue
//   { error: string, completed: N, failedIndex: N }  — step threw or returned falsy
async function runQueue(promptItems, delayMinMs, delayMaxMs, log, notify = () => {}) {
  const myToken = queueToken;

  for (let i = 0; i < promptItems.length; i++) {
    // ── Cancellation check ────────────────────────────────────────────────────
    if (queueToken !== myToken) {
      log(`[queue] Stopped before item ${i + 1} — token changed`, 'warn');
      return { stopped: true, completed: i };
    }

    const { timestamp, text } = promptItems[i];
    log(`[queue] Item ${i + 1}/${promptItems.length}: ${timestamp} — "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
    notify({ type: 'promptStatus', index: i, status: 'generating' });

    // ── 1–3. Insert prompt → snapshot → trigger generation ────────────────────
    // A failure in any of these steps marks this prompt failed and moves on to
    // the next item. Individual prompt errors must not abort the whole queue.
    let beforeSrcs;
    try {
      const insertOk = await insertPrompt(text, log);
      if (insertOk === false) throw new Error('insertPrompt returned false');

      beforeSrcs = collectCurrentOutputSrcs();

      const generateOk = await clickGenerate(log);
      if (generateOk === false) throw new Error('clickGenerate returned false');
    } catch (e) {
      log(`[queue] ✗ Item ${i + 1} (${timestamp}) failed: ${e.message}`, 'error');
      notify({ type: 'promptStatus', index: i, status: 'failed' });

      // Distinguish "this prompt failed" from "the page itself crashed" —
      // the latter means every remaining item would fail instantly too, so
      // halt now instead of racing through the rest of the queue in
      // milliseconds. See isPageCrashed().
      if (isPageCrashed()) {
        log(`[queue] ✗✗ Slate editor is gone from the page — Flow appears to have crashed (Next.js error boundary). Stopping queue instead of failing every remaining item.`, 'error');
        return { crashed: true, error: e.message, completed: i, failedIndex: i };
      }
      continue;
    }

    // ── 4. Wait for generated output ──────────────────────────────────────────
    log('[queue] Waiting for output image (selector: img[alt="Generated image"]) — up to 120s…');
    let result;
    try {
      result = await waitForOutput(beforeSrcs, 120000);
    } catch (e) {
      log(`[queue] ✗ waitForOutput threw: ${e.message}`, 'error');
      notify({ type: 'promptStatus', index: i, status: 'failed' });
      return { error: `waitForOutput: ${e.message}`, completed: i, failedIndex: i };
    }
    log(`[queue] waitForOutput resolved: ${result.done
      ? `${result.urls.length} new image(s) detected`
      : 'timed out — no new img[alt="Generated image"] appeared; if Flow did render output, the selector may need updating'}`);

    if (result.done) {
      log(`[queue] Output ready (${result.urls.length} image${result.urls.length !== 1 ? 's' : ''})`, 'success');
      try {
        await saveGeneratedImages(result.urls, timestamp, log);
      } catch (e) {
        log(`[queue] ✗ saveGeneratedImages threw: ${e.message}`, 'error');
      }
      notify({ type: 'promptStatus', index: i, status: 'done' });

    } else {
      // ── Timeout: distinguish explicit fail card vs. silent timeout ─────────
      //
      // Fail card → Flow reported failure itself → safe to retry once, since no
      // image was produced.
      //
      // Silent timeout → image may have generated but wasn't detected (selector
      // drift, slow network, etc.) → do NOT resubmit, as that risks a duplicate.
      if (detectFailCard()) {
        log(`[queue] Fail card detected — retrying item ${i + 1} once…`, 'warn');
        let retryDone = false;
        try {
          const ok2 = await insertPrompt(text, log);
          if (ok2 !== false) {
            const bs2 = collectCurrentOutputSrcs();
            const ok3 = await clickGenerate(log);
            if (ok3 !== false) {
              const result2 = await waitForOutput(bs2, 120000);
              if (result2.done) {
                try {
                  await saveGeneratedImages(result2.urls, timestamp, log);
                } catch (e) {
                  log(`[queue] ✗ saveGeneratedImages threw on retry: ${e.message}`, 'error');
                }
                notify({ type: 'promptStatus', index: i, status: 'done' });
                log(`[queue] Retry succeeded for item ${i + 1}`, 'success');
                retryDone = true;
              }
            }
          }
        } catch (e) {
          log(`[queue] Retry threw: ${e.message}`, 'error');
        }
        if (!retryDone) {
          log(`[queue] ⚠ Retry also failed — item ${i + 1} marked failed`, 'warn');
          notify({ type: 'promptStatus', index: i, status: 'failed' });
        }
      } else {
        log(`[queue] ⚠ Timed out (120s) — no fail card — skipping download, moving on`, 'warn');
        notify({ type: 'promptStatus', index: i, status: 'failed' });
      }
    }

    // ── 5. Inter-prompt delay (skip after the last item) ─────────────────────
    if (i < promptItems.length - 1) {
      const delay = Math.round(delayMinMs + Math.random() * (delayMaxMs - delayMinMs));
      log(`[queue] Waiting ${(delay / 1000).toFixed(1)}s before next prompt…`);
      await sleep(delay);
    }
  }

  log(`[queue] All ${promptItems.length} item(s) complete`, 'success');
  return { done: true, completed: promptItems.length };
}

// ─── PORT HANDLER ─────────────────────────────────────────────────────────────────
//
// The popup opens a named port 'flow-prompter' and sends one of these messages:
//   { action: 'insertPrompt', prompt: string }
//   { action: 'generate' }
//   { action: 'runQueue',  promptItems: [{timestamp, text}], delayMinMs, delayMaxMs }
//   { action: 'stopQueue' }
//
// We stream { type: 'log', status, level } messages back as each step completes,
// then send { type: 'done', success, error? } or { type: 'queueDone', result }
// when finished.

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'flow-prompter') return;

  const log = (status, level = 'info') => {
    try { port.postMessage({ type: 'log', status, level }); } catch (_) {}
  };

  port.onMessage.addListener(async (msg) => {
    if (msg.action === 'insertPrompt') {
      try {
        await insertPrompt(msg.prompt, log);
        port.postMessage({ type: 'done', success: true });
      } catch (err) {
        log(`✗ ${err.message}`, 'error');
        port.postMessage({ type: 'done', success: false, error: err.message });
      }

    } else if (msg.action === 'generate') {
      try {
        await clickGenerate(log);
        port.postMessage({ type: 'done', success: true });
      } catch (err) {
        log(`✗ ${err.message}`, 'error');
        port.postMessage({ type: 'done', success: false, error: err.message });
      }

    } else if (msg.action === 'runQueue') {
      const notify = (notifyMsg) => {
        try { port.postMessage(notifyMsg); } catch (_) {}
      };
      const result = await runQueue(
        msg.promptItems,
        msg.delayMinMs ?? 3000,
        msg.delayMaxMs ?? 8000,
        log,
        notify,
      );
      try { port.postMessage({ type: 'queueDone', result }); } catch (_) {}

    } else if (msg.action === 'stopQueue') {
      queueToken++;
      log('[queue] Stop requested — current item will finish then queue will halt', 'warn');

    } else if (msg.action === 'diagnosePicker') {
      try {
        await diagnosePicker(msg.characterName || 'Trevor', log);
        port.postMessage({ type: 'done', success: true });
      } catch (err) {
        log(`✗ diagnosePicker: ${err.message}`, 'error');
        port.postMessage({ type: 'done', success: false, error: err.message });
      }

    } else if (msg.action === 'extractRoster') {
      try {
        await extractCharacterRoster(log);
        port.postMessage({ type: 'done', success: true });
      } catch (err) {
        log(`✗ extractRoster: ${err.message}`, 'error');
        port.postMessage({ type: 'done', success: false, error: err.message });
      }

    } else if (msg.action === 'harvestRoster') {
      try {
        const results = await harvestCharacterIds(msg.names || [], log);
        port.postMessage({ type: 'done', success: true, results });
      } catch (err) {
        log(`✗ harvestRoster: ${err.message}`, 'error');
        port.postMessage({ type: 'done', success: false, error: err.message });
      }

    } else if (msg.action === 'diagnoseSideEffects') {
      try {
        await diagnoseAddToPromptSideEffects(msg.characterName || 'Danny', log);
        port.postMessage({ type: 'done', success: true });
      } catch (err) {
        log(`✗ diagnoseSideEffects: ${err.message}`, 'error');
        port.postMessage({ type: 'done', success: false, error: err.message });
      }
    }
  });
});
