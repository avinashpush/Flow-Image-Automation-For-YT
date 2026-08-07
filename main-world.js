// main-world.js — runs in the page's MAIN JavaScript world.
//
// The isolated-world content script (content.js) cannot access window.__reactFiber$
// or any other React internal because Chrome extension content scripts run in a
// sandboxed JS environment that shares the DOM but NOT the JS heap with the page.
//
// This script runs in "world":"MAIN" (see manifest.json), so it shares the same
// JS heap as the page's React/Slate code. It exposes a command API to content.js
// via CustomEvents on window (cross-world CustomEvents work because both worlds
// share the same DOM event system):
//
//   content.js   →  window.dispatchEvent(CustomEvent('fp:request',  { detail }))
//   main-world   →  window.dispatchEvent(CustomEvent('fp:response', { detail }))
//
// Commands:
//   slate:ping                  — verify bridge is alive and editor accessible
//   slate:children              — dump full editor.children (mention node schema)
//   slate:selection             — read current editor.selection
//   slate:restore-query-caret   — collapse selection to end of "@<name>" text
//   slate:insert-nodes          — direct Slate node insertion (skip picker)
//   slate:inspect-picker        — while picker open: dump Virtuoso data arrays + query props
//   slate:patch-network-all     — intercept fetch + XHR to capture picker search traffic
//   slate:get-requests          — retrieve (and optionally clear) the request log
'use strict';

const FP_REQ = 'fp:request';
const FP_RES = 'fp:response';

// ─── Slate editor access ──────────────────────────────────────────────────────

let _cache = null;

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
  if (_cache) {
    try { if (Array.isArray(_cache.children)) return _cache; }
    catch { _cache = null; }
  }

  const el = document.querySelector(
    'div[role="textbox"][data-slate-editor="true"][contenteditable="true"]'
  );
  if (!el) return null;

  // React 16+ stores the Fiber as a property whose key starts with
  // "__reactFiber$" (newer builds) or "__reactInternalInstance$" (older).
  const fk = Object.keys(el).find(
    k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
  );
  if (!fk) return null;

  let fiber = el[fk];
  for (let depth = 0; fiber && depth < 200; depth++, fiber = fiber.return) {
    const mp = fiber.memoizedProps;
    if (mp) {
      for (const k of Object.keys(mp)) {
        if (isSlateEditor(mp[k])) { _cache = mp[k]; return mp[k]; }
      }
    }
    let ms = fiber.memoizedState;
    for (let d2 = 0; ms && d2 < 50; d2++, ms = ms.next) {
      const v = ms.memoizedState;
      if (isSlateEditor(v)) { _cache = v; return v; }
      if (v && typeof v === 'object' && isSlateEditor(v.current)) {
        _cache = v.current; return v.current;
      }
    }
  }
  return null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

// Safe-serialize Slate objects. editor.children may contain Proxy objects or
// circular refs in some Slate versions; JSON round-trip materialises them.
function safe(v) {
  return JSON.parse(JSON.stringify(v));
}

function respond(id, result, error) {
  window.dispatchEvent(new CustomEvent(FP_RES, {
    detail: { id, result: result ?? null, error: error ?? null },
  }));
}

// Return the first (wantEnd=false) or last (wantEnd=true) text-leaf Point in
// the document. Used by slate:clear to build a full-document selection.
function getDocPoint(nodes, wantEnd, basePath) {
  basePath = basePath || [];
  const len = nodes.length;
  for (let ii = 0; ii < len; ii++) {
    const i = wantEnd ? len - 1 - ii : ii;
    const n = nodes[i];
    const p = basePath.concat(i);
    if (typeof n.text === 'string') {
      return { path: p, offset: wantEnd ? n.text.length : 0 };
    }
    if (Array.isArray(n.children)) {
      const r = getDocPoint(n.children, wantEnd, p);
      if (r) return r;
    }
  }
  return null;
}

// RFC-4122 v4 UUID for new mention node IDs.
function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// Walk Slate's virtual document tree to find the LAST text leaf containing
// `pattern` (case-insensitive). Returns a Slate Point { path, offset } where
// offset points to the character immediately after the match, or null.
function findTextEnd(nodes, pattern, basePath) {
  basePath = basePath || [];
  let found = null;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const p    = basePath.concat(i);
    if (typeof node.text === 'string') {
      const idx = node.text.toLowerCase().lastIndexOf(pattern.toLowerCase());
      if (idx >= 0) found = { path: p, offset: idx + pattern.length };
    } else if (Array.isArray(node.children)) {
      const inner = findTextEnd(node.children, pattern, p);
      if (inner) found = inner;
    }
  }
  return found;
}

// ─── Command handler ──────────────────────────────────────────────────────────

window.addEventListener(FP_REQ, function (evt) {
  const detail  = evt.detail || {};
  const { cmd, id, payload } = detail;
  if (!id) return; // ignore malformed requests

  let editor;
  try { editor = getSlateEditor(); } catch (e) { respond(id, null, e.message); return; }
  if (!editor) { respond(id, null, 'no-slate-editor'); return; }

  try {
    switch (cmd) {

      // ── Connectivity check ────────────────────────────────────────────────
      case 'slate:ping':
        respond(id, { ok: true });
        break;

      // ── Read editor model ─────────────────────────────────────────────────
      case 'slate:children':
        respond(id, safe(editor.children));
        break;

      case 'slate:selection':
        respond(id, editor.selection ? safe(editor.selection) : null);
        break;

      // ── Fix caret before mention commit ───────────────────────────────────
      //
      // Between typing "@<name>" and clicking the picker option, Slate's
      // internal selection drifts to near block-start. Flow's mention commit
      // reads editor.selection to determine the replace-range: if that range
      // spans from block-start to end-of-query, the commit wipes all leading
      // text. This command walks editor.children to find "@<name>", then calls
      // editor.select() to collapse the caret to the end of that text —
      // replicating the state a real user's selection is in when they click.
      //
      // Both names route to the same logic. 'slate:select-query-end' is the
      // canonical name from spec; 'slate:restore-query-caret' is kept for
      // backwards compatibility with existing log messages.
      case 'slate:select-query-end':
      case 'slate:restore-query-caret': {
        const { name } = payload || {};
        if (!name) { respond(id, null, 'payload.name required'); break; }

        let point = null;
        // Try "@<name>" first; fall back to "<name>" in case @ is in a prior leaf.
        for (const pat of ['@' + name, name]) {
          point = findTextEnd(editor.children, pat);
          if (point) break;
        }

        if (!point) {
          respond(id, null, '"@' + name + '" not found in editor.children');
          break;
        }

        editor.select({ anchor: point, focus: point });
        respond(id, { ok: true, point, selection: safe(editor.selection) });
        break;
      }

      // ── Direct node insertion (skip picker entirely) ──────────────────────
      //
      // Once we have the mention node schema from slate:children, we can
      // synthesise the node object and insert it directly — no picker, no
      // synthetic @, no commit-wipe, no selection races.
      case 'slate:insert-nodes': {
        const { nodes, at } = payload || {};
        if (!Array.isArray(nodes) || nodes.length === 0) {
          respond(id, null, 'payload.nodes must be a non-empty array');
          break;
        }
        const opts = at ? { at } : undefined;
        editor.insertNodes(nodes, opts);
        respond(id, { ok: true, children: safe(editor.children) });
        break;
      }

      // ── Insert one known character mention, entirely skipping the picker ───
      //
      // For characters whose characterServerId is already known (CHARACTER_ID_MAP
      // in content.js), there is no need to open the "@" picker, type into
      // Virtuoso, or click "Add to Prompt" at all — all of which have proven
      // flaky (typed filtering stops working after the first mention per page
      // load, and a failed/dangling picker popover has been observed to crash
      // Flow's own React tree via a stale Radix onCloseAutoFocus). This command
      // inserts the mention node directly at the current selection (same node
      // shape the real picker produces — see slate:build) and repositions the
      // selection to the text node immediately after the chip, so a subsequent
      // insertText() in content.js lands in the right place.
      case 'slate:insert-mention': {
        const { characterServerId, displayText } = payload || {};
        if (!characterServerId || !displayText) {
          respond(id, null, 'payload.characterServerId and payload.displayText are required');
          break;
        }

        const mentionNode = {
          id: uuid(),
          type: 'AT_TAG_TYPE',
          children: [{ text: '@' }],
          characterServerId,
          displayText,
        };

        // REVERTED: an earlier version of this handler called
        // editor.select() to the document's end point (computed via
        // getDocPoint) before inserting, to work around editor.selection
        // being stale relative to text typed via DOM execCommand(). That
        // made things worse — it left the DOM's actual selection/focus in a
        // state where content.js's execCommand('insertText') calls failed
        // completely on every subsequent segment, not just misordered. Do
        // not reintroduce that editor.select() call without first
        // understanding why it breaks execCommand — this whole direct-
        // insertion path is disabled by default (CONFIG.useDirectCharacterInsertion)
        // pending that.

        // Do NOT pass {select:true} — for inline-void nodes that would place
        // the cursor inside the void's empty text child, making the next
        // insertText a noop (see slate:build's identical comment above).
        editor.insertNodes([mentionNode]);

        const para = editor.children[0];
        if (!para || !Array.isArray(para.children)) {
          respond(id, null, 'editor.children[0] has no children array after insertNodes');
          break;
        }

        let chipIdx = -1;
        for (let k = para.children.length - 1; k >= 0; k--) {
          if (para.children[k].type === 'AT_TAG_TYPE') { chipIdx = k; break; }
        }
        if (chipIdx < 0) {
          respond(id, null, 'AT_TAG_TYPE not found in para.children after insertNodes');
          break;
        }
        if (chipIdx + 1 >= para.children.length) {
          respond(id, null, 'chip inserted but no trailing text sibling — normalization may not have run yet');
          break;
        }

        const point = { path: [0, chipIdx + 1], offset: 0 };
        editor.select({ anchor: point, focus: point });
        respond(id, { ok: true, point, children: safe(editor.children) });
        break;
      }

      // ── Clear the editor ──────────────────────────────────────────────────
      //
      // Selects the entire document then calls editor.deleteFragment() (preferred)
      // or editor.insertText('') (fallback). Both remove text nodes AND void inline
      // chips. After clearing, explicitly collapses selection to [0,0]:0 so that
      // slate:build always starts from a known-good selection state.
      //
      // Critical: editor.insertText('') is a noop in some Slate builds when the
      // string is empty, leaving the selection still expanded over the whole doc.
      // The explicit editor.select() below fixes that regardless of which path ran.
      case 'slate:clear': {
        const c = editor.children;
        const isEmpty =
          c.length === 1 &&
          Array.isArray(c[0].children) &&
          c[0].children.length === 1 &&
          typeof c[0].children[0].text === 'string' &&
          c[0].children[0].text === '';

        const startPoint = { path: [0, 0], offset: 0 };

        if (isEmpty) {
          editor.select({ anchor: startPoint, focus: startPoint });
          respond(id, { ok: true, alreadyEmpty: true, children: safe(editor.children) });
          break;
        }

        const start = getDocPoint(editor.children, false);
        const end   = getDocPoint(editor.children, true);
        if (!start || !end) {
          respond(id, null, 'could not locate document start/end points');
          break;
        }

        editor.select({ anchor: start, focus: end });

        // Prefer deleteFragment (added to editor object by slate-react's withReact).
        // Fall back to insertText('') which internally calls deleteFragment for
        // expanded selections in standard Slate.
        if (typeof editor.deleteFragment === 'function') {
          editor.deleteFragment();
        } else {
          editor.insertText('');
        }

        // Explicitly collapse to doc-start regardless of which branch ran above.
        // This guarantees slate:build's first editor.select() lands on a valid point.
        editor.select({ anchor: startPoint, focus: startPoint });
        respond(id, { ok: true, children: safe(editor.children) });
        break;
      }

      // ── Build a prompt from ordered segments ──────────────────────────────
      //
      // payload.segments: [{type:'text', value} | {type:'char', characterServerId, displayText}]
      //
      // Selection is managed explicitly at EVERY step:
      //   - editor.select(curPoint) before each insert (belt-and-suspenders)
      //   - For text: advance curPoint by text.length after insertText
      //   - For chip: after insertNodes, scan paragraph children to find the text
      //     node immediately AFTER the chip and set curPoint there
      //
      // Rationale: AT_TAG_TYPE is an inline (possibly void) node. After insertNodes
      // without {select:true}, Slate does NOT update editor.selection. After
      // insertNodes WITH {select:true}, Slate places the cursor inside the void
      // node's empty text child — which is an invalid target for insertText.
      // We always reposition curPoint explicitly from paragraph structure instead.
      case 'slate:build': {
        const { segments } = payload || {};
        if (!Array.isArray(segments) || segments.length === 0) {
          respond(id, null, 'payload.segments must be a non-empty array');
          break;
        }

        // Probe how Flow registers AT_TAG_TYPE — inline? void? Both matter for
        // how Slate normalises the document after insertNodes.
        const atProbe = { type: 'AT_TAG_TYPE', children: [{ text: '' }] };
        const isInline = typeof editor.isInline === 'function' ? String(editor.isInline(atProbe)) : '?';
        const isVoid   = typeof editor.isVoid   === 'function' ? String(editor.isVoid(atProbe))   : '?';

        const diagnostics = [`AT_TAG_TYPE isInline=${isInline} isVoid=${isVoid}`];

        // Anchor to the start of the (now-empty) document.
        // Also safe when called without a preceding slate:clear.
        let curPath   = [0, 0];
        let curOffset = 0;
        editor.select({
          anchor: { path: curPath, offset: curOffset },
          focus:  { path: curPath, offset: curOffset },
        });
        diagnostics.push(`initial sel: ${JSON.stringify(safe(editor.selection))}`);

        for (let i = 0; i < segments.length; i++) {
          const seg   = segments[i];
          const label = `seg[${i}:${seg.type}]`;

          // Always re-assert selection before every insert.
          editor.select({
            anchor: { path: curPath, offset: curOffset },
            focus:  { path: curPath, offset: curOffset },
          });
          diagnostics.push(`${label} sel before: path=[${curPath}] offset=${curOffset}`);

          if (seg.type === 'text') {
            if (!seg.value) { diagnostics.push(`${label} skip (empty value)`); continue; }

            editor.insertText(seg.value);

            const selAfter = editor.selection;
            diagnostics.push(`${label} sel after: ${JSON.stringify(selAfter ? safe(selAfter.anchor) : null)}`);
            diagnostics.push(`${label} children: ${JSON.stringify(safe(editor.children))}`);

            if (selAfter && selAfter.anchor) {
              // Slate advanced the selection — trust it.
              curPath   = [...selAfter.anchor.path];
              curOffset = selAfter.anchor.offset;
            } else {
              // insertText did not update selection (can happen if selection was null
              // or Slate short-circuited). Advance offset manually as a fallback.
              curOffset += seg.value.length;
              diagnostics.push(`${label} WARN: selection null after insertText — manually advanced offset to ${curOffset}`);
            }

          } else if (seg.type === 'char') {
            if (!seg.characterServerId || !seg.displayText) {
              respond(id, null, `${label}: missing characterServerId or displayText`);
              return;
            }

            // Match the real picker-generated node byte-for-byte.
            // The picker produces children:[{text:"@"}] — NOT children:[{text:""}].
            // Flow's serializer or generation code may require the "@" child text to
            // identify this as a valid character reference.
            const mentionNode = {
              id: uuid(),
              type: 'AT_TAG_TYPE',
              children: [{ text: '@' }],
              characterServerId: seg.characterServerId,
              displayText: seg.displayText,
            };

            // Do NOT pass {select:true} — for inline-void nodes that would place
            // the cursor inside the void's empty text child, making the next
            // insertText a noop.
            editor.insertNodes([mentionNode]);

            const selAfterInsert = editor.selection;
            diagnostics.push(`${label} sel after insertNodes: ${JSON.stringify(selAfterInsert ? safe(selAfterInsert.anchor) : null)}`);
            diagnostics.push(`${label} children: ${JSON.stringify(safe(editor.children))}`);

            // Reposition to the text node immediately AFTER the chip.
            // Slate normalization always ensures a text sibling follows an inline,
            // so para.children[chipIdx + 1] must exist.
            const para = editor.children[0];
            if (para && Array.isArray(para.children)) {
              // Find the last AT_TAG_TYPE (the chip we just inserted, since we go L→R)
              let chipIdx = -1;
              for (let k = para.children.length - 1; k >= 0; k--) {
                if (para.children[k].type === 'AT_TAG_TYPE') { chipIdx = k; break; }
              }

              if (chipIdx >= 0 && chipIdx + 1 < para.children.length) {
                curPath   = [0, chipIdx + 1];
                curOffset = 0;
                diagnostics.push(`${label} chip at para[${chipIdx}] → next text at [${curPath}]:${curOffset}`);
              } else if (chipIdx >= 0) {
                // Trailing sibling missing — normalization may not have run yet.
                // Set curPath optimistically; the next editor.select() will fail
                // if the node doesn't exist, which will surface as an error.
                curPath   = [0, chipIdx + 1];
                curOffset = 0;
                diagnostics.push(`${label} WARN: chip at para[${chipIdx}] but no trailing text sibling found`);
              } else {
                diagnostics.push(`${label} ERROR: AT_TAG_TYPE not found in para.children after insertNodes`);
              }
            } else {
              diagnostics.push(`${label} ERROR: editor.children[0] has no children array`);
            }
          }
        }

        respond(id, { ok: true, children: safe(editor.children), diagnostics });
        break;
      }

      // ── Discover character name → ID pairs ────────────────────────────────
      //
      // Walk editor.children and extract every AT_TAG_TYPE node's displayText
      // and characterServerId. Call this after any successful chip insertion to
      // get the IDs needed to populate CHARACTER_ID_MAP in content.js.
      case 'slate:list-characters': {
        const chars = [];
        const seen  = new Set();
        function walkChars(nodes) {
          for (const n of nodes) {
            if (n.type === 'AT_TAG_TYPE' && n.characterServerId && !seen.has(n.characterServerId)) {
              seen.add(n.characterServerId);
              chars.push({ displayText: n.displayText || '', characterServerId: n.characterServerId });
            }
            if (Array.isArray(n.children)) walkChars(n.children);
          }
        }
        walkChars(editor.children);
        respond(id, { characters: chars });
        break;
      }

      // ── Call the generate button's React onClick directly ────────────────────
      //
      // Flow's submit button uses React's delegated event system. It exposes only
      // onClick in its React props — onPointerDown and onMouseDown are undefined,
      // which is why synthetic pointer/mouse events dispatched from the content
      // script have no effect. We read the handler directly off the DOM element's
      // __reactProps$... key and invoke it from the MAIN world.
      //
      // Argument strategy (tried in order):
      //   1. No arg — works if the handler never reads event properties.
      //   2. Real MouseEvent — closest to what React normally delivers.
      //   3. Minimal stub — last resort if the native event causes issues.
      case 'slate:submit': {
        // Find the live submit button (aria-disabled="false" + arrow_forward icon).
        const submitBtn = [...document.querySelectorAll('button')].find(b => {
          const icon = b.querySelector('i');
          return icon &&
            icon.textContent.trim() === 'arrow_forward' &&
            b.getAttribute('aria-disabled') === 'false';
        });
        if (!submitBtn) {
          respond(id, null, 'no enabled arrow_forward button found (aria-disabled must be "false")');
          break;
        }

        // Locate the __reactProps$... key that holds the live React props.
        const propsKey = Object.keys(submitBtn).find(k => k.startsWith('__reactProps$'));
        if (!propsKey) {
          respond(id, null, 'no __reactProps$ key on submit button — React version may differ');
          break;
        }
        const rProps = submitBtn[propsKey];
        if (!rProps || typeof rProps.onClick !== 'function') {
          respond(id, null,
            `onClick not a function on __reactProps$. ` +
            `Available prop keys: ${Object.keys(rProps || {}).slice(0, 15).join(',')}`
          );
          break;
        }

        // Build a React SyntheticEvent-shaped stub.
        //
        // Root cause of "Cannot read properties of undefined (reading 'isTrusted')":
        // Flow's onClick handler accesses event.nativeEvent.isTrusted. React wraps
        // every real browser event in a SyntheticEvent that always has .nativeEvent.
        // Our previous attempts (no-arg, raw MouseEvent, plain stub) all lacked
        // .nativeEvent, so event.nativeEvent was undefined → throw.
        //
        // We provide two variants:
        //   trusted=true  — passes any "only accept real user clicks" gate
        //   trusted=false — for handlers that just need the shape, not the value
        const makeStub = (trusted) => {
          const nativeEvent = {
            isTrusted: trusted, type: 'click', bubbles: true, cancelable: true,
            defaultPrevented: false,
            preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
          };
          return {
            nativeEvent,
            isTrusted: trusted,
            type: 'click',
            target: submitBtn,
            currentTarget: submitBtn,
            bubbles: true, cancelable: true, defaultPrevented: false,
            eventPhase: 3,
            timeStamp: Date.now(),
            preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
            persist() {},
            isDefaultPrevented() { return false; },
            isPropagationStopped() { return false; },
          };
        };

        let called = false;
        let lastErr = '';
        const attempts = [
          () => rProps.onClick(makeStub(true)),   // trusted stub — bypasses isTrusted gate
          () => rProps.onClick(makeStub(false)),  // non-trusted stub — handler ignores trust
          () => rProps.onClick(),                  // no arg — handler ignores event entirely
        ];
        for (const attempt of attempts) {
          try { attempt(); called = true; break; }
          catch (e) { lastErr = e.message; }
        }

        if (!called) {
          respond(id, null, `all onClick attempts threw — last error: ${lastErr}`);
          break;
        }
        respond(id, { ok: true });
        break;
      }

      // ── Prepend text at the start of the document via Slate's API ───────────
      //
      // Used as the FINAL step of insertPrompt when the prompt has leading text
      // (text before the first character chip). We cannot insert it first because
      // Flow's mention commit wipes text that precedes an uncommitted @query in
      // Slate's model. Inserting it last — after all chips are committed — avoids
      // the commit entirely and places the text directly into Slate's owned model.
      //
      // Implementation: set selection to the very start of the document (path:[0,0]
      // offset:0, always a text leaf after Slate normalization), then call
      // editor.insertText(text). Slate splices it into that leaf, pushing the
      // rest of the paragraph content to the right. No DOM manipulation needed.
      case 'slate:insert-text-at-start': {
        const { text } = payload || {};
        if (!text) { respond(id, null, 'payload.text is required'); break; }

        const startPoint = { path: [0, 0], offset: 0 };
        editor.select({ anchor: startPoint, focus: startPoint });
        editor.insertText(text);

        respond(id, { ok: true, children: safe(editor.children) });
        break;
      }

      // ── Search React fiber state for character reference arrays ─────────────
      //
      // When the picker commits a mention, Flow may store the chosen character in
      // React component state BEYOND just inserting an AT_TAG_TYPE node — e.g. in a
      // "selected characters" array that the generation code reads to build the
      // request payload. This command walks the fiber tree upward from the editor
      // element looking for any hook state or prop that contains `characterServerId`
      // or `serverId` values, so we can compare what exists after a manual pick vs.
      // after our synthesized insertNodes.
      case 'slate:inspect-state': {
        const edEl = document.querySelector(
          'div[role="textbox"][data-slate-editor="true"][contenteditable="true"]'
        );
        if (!edEl) { respond(id, null, 'editor element not found'); break; }

        const fk2 = Object.keys(edEl).find(
          k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
        if (!fk2) { respond(id, null, 'no react fiber on editor element'); break; }

        function hasCharId(v) {
          if (!v || typeof v !== 'object') return false;
          if ('characterServerId' in v || 'serverId' in v) return true;
          if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0]) {
            return 'characterServerId' in v[0] || 'serverId' in v[0];
          }
          return false;
        }

        function tryS(v) {
          try { return JSON.parse(JSON.stringify(v)); }
          catch { return '[unserializable]'; }
        }

        const hits = [];
        let fib = edEl[fk2];
        for (let d = 0; fib && d < 400; d++, fib = fib.return) {
          try {
            const mp = fib.memoizedProps;
            if (mp && typeof mp === 'object') {
              for (const k of Object.keys(mp)) {
                try {
                  if (hasCharId(mp[k])) hits.push({ at: `d${d}.props.${k}`, val: tryS(mp[k]) });
                } catch {}
              }
            }
            let ms = fib.memoizedState;
            let hi = 0;
            while (ms && hi < 60) {
              try {
                if (hasCharId(ms.memoizedState)) {
                  hits.push({ at: `d${d}.hook${hi}`, val: tryS(ms.memoizedState) });
                }
                if (ms.queue && hasCharId(ms.queue.lastRenderedState)) {
                  hits.push({ at: `d${d}.hook${hi}.lrs`, val: tryS(ms.queue.lastRenderedState) });
                }
              } catch {}
              ms = ms.next;
              hi++;
            }
          } catch {}
        }
        respond(id, { hits });
        break;
      }

      // ── Inspect character picker data source while picker is open ────────────
      //
      // Walk the React fiber tree upward from the Virtuoso list container and surface:
      //   • every array-valued prop on any ancestor component (potential full item list,
      //     visible before client-side filtering is applied)
      //   • every string prop whose name suggests a search/filter query
      //   • component display names encountered along the way (orientation)
      //
      // This reveals whether the picker is fed a pre-loaded list of characters only, or
      // a combined list that also includes image/asset entries — and whether filtering is
      // done client-side (no server request) or triggers a search endpoint.
      //
      // Must be called WHILE the picker is open and showing results (i.e. after "@Name"
      // has been typed and the Virtuoso list is visible in the DOM).
      //
      // Returns { renderedItemCount, components, dataProps, queryProps }.
      case 'slate:inspect-picker': {
        const listEl = document.querySelector('[data-testid="virtuoso-item-list"]');
        if (!listEl) { respond(id, null, 'Virtuoso list not found — open the picker first and make sure "[data-testid=\'virtuoso-item-list\']" is in the DOM'); break; }

        const fkP = Object.keys(listEl).find(k =>
          k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
        if (!fkP) { respond(id, null, 'no React fiber key on virtuoso-item-list element'); break; }

        function pickerTryJson(v) {
          try {
            const s = JSON.stringify(v);
            return s.length > 600 ? s.slice(0, 600) + '…' : JSON.parse(s);
          } catch { return '[unserializable]'; }
        }
        function itemShape(arr) {
          if (!arr.length || typeof arr[0] !== 'object' || arr[0] === null) return typeof (arr[0] ?? null);
          return Object.keys(arr[0]).slice(0, 12);
        }

        const report = {
          renderedItemCount: listEl.children.length,
          components: [],
          dataProps: [],
          queryProps: [],
        };
        const seenCompNames = new Set();

        let fibP = listEl[fkP];
        for (let depth = 0; fibP && depth < 200; depth++, fibP = fibP.return) {
          try {
            // Collect component names for the hierarchy breadcrumb.
            const compName =
              (typeof fibP.type === 'function' && (fibP.type.displayName || fibP.type.name)) ||
              (fibP.type?.render && (fibP.type.render.displayName || fibP.type.render.name)) ||
              null;
            if (compName && !seenCompNames.has(compName)) {
              seenCompNames.add(compName);
              report.components.push({ depth, name: compName });
            }

            const mp = fibP.memoizedProps;
            if (!mp || typeof mp !== 'object') continue;

            for (const k of Object.keys(mp)) {
              try {
                const v = mp[k];
                // Arrays with at least 1 non-function item: possible full item list
                if (Array.isArray(v) && v.length >= 1 && typeof v[0] !== 'function') {
                  report.dataProps.push({
                    depth,
                    component: compName || null,
                    prop: k,
                    length: v.length,
                    itemShape: itemShape(v),
                    sample: pickerTryJson(v.slice(0, 2)),
                  });
                }
                // String props whose name suggests filtering or search
                if (typeof v === 'string' && v.length < 300 &&
                    /query|filter|search|term|text|keyword|name/i.test(k)) {
                  report.queryProps.push({ depth, component: compName || null, prop: k, value: v });
                }
              } catch {}
            }
          } catch {}
        }

        respond(id, report);
        break;
      }

      // ── Extract the full character roster (name → ID) for CHARACTER_ID_MAP ──
      //
      // slate:inspect-picker only samples the first 2 items of any array prop
      // it finds — enough to identify the shape, not enough to build a full
      // name→ID map. This command does the same fiber walk from the Virtuoso
      // item-list element, but specifically looks for an array whose items
      // look like character records (a UUID-shaped id field alongside a
      // string name field) and returns every item, not just a sample.
      //
      // Call this with the "@" picker open (any tab/filter state — it reads
      // the underlying data array directly, not the rendered/virtualized DOM
      // rows, so scrolling or typing a filter first is unnecessary).
      case 'slate:extract-roster': {
        const listEl = document.querySelector('[data-testid="virtuoso-item-list"]');
        if (!listEl) { respond(id, null, 'Virtuoso list not found — open the picker first'); break; }

        const fkR = Object.keys(listEl).find(k =>
          k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
        if (!fkR) { respond(id, null, 'no React fiber key on virtuoso-item-list element'); break; }

        const ID_KEYS   = ['characterServerId', 'serverId', 'assetId', 'id', 'uuid'];
        const NAME_KEYS  = ['displayText', 'name', 'label', 'title', 'characterName'];
        const isUuid     = (v) => typeof v === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

        // Tries `arr` as a direct array of character records first. If that
        // fails but items look like Virtuoso's grouped shape
        // (`{ tiles: [...], height }` — one entry per group, actual rows
        // nested inside `tiles`), flattens every group's tiles and retries.
        function tryExtract(arr, depth2 = 0) {
          const first = arr[0];
          if (!first || typeof first !== 'object') return null;

          const idKey   = ID_KEYS.find((ik) => isUuid(first[ik]));
          const nameKey = NAME_KEYS.find((nk) => typeof first[nk] === 'string' && first[nk].length > 0);
          if (idKey && nameKey) {
            return { source: 'direct', idKey, nameKey, roster: arr.map((it) => ({ name: it[nameKey], id: it[idKey] })) };
          }

          if (depth2 < 3 && Array.isArray(first.tiles)) {
            const flat = arr.flatMap((grp) => Array.isArray(grp.tiles) ? grp.tiles : []);
            if (flat.length) {
              const inner = tryExtract(flat, depth2 + 1);
              if (inner) return { ...inner, source: 'grouped-tiles' };
            }
          }
          return null;
        }

        let found = null;
        let fibR = listEl[fkR];
        for (let depth = 0; fibR && depth < 200 && !found; depth++, fibR = fibR.return) {
          const mp = fibR.memoizedProps;
          if (!mp || typeof mp !== 'object') continue;
          for (const k of Object.keys(mp)) {
            const v = mp[k];
            if (!Array.isArray(v) || v.length < 1) continue;
            const extracted = tryExtract(v);
            if (extracted && extracted.roster.length) {
              found = { depth, prop: k, ...extracted };
              break;
            }
          }
        }

        if (!found) {
          respond(id, null, 'no array prop with id+name-shaped items found on any ancestor (including grouped "tiles" arrays) — try slate:inspect-picker to see what IS available');
          break;
        }

        respond(id, {
          ok: true, depth: found.depth, prop: found.prop, source: found.source,
          idKey: found.idKey, nameKey: found.nameKey,
          count: found.roster.length, roster: found.roster,
        });
        break;
      }

      // ── Install a broad network interceptor (fetch + XHR) ─────────────────────
      //
      // Unlike slate:patch-network (which only captures the generate POST), this
      // patches both window.fetch and XMLHttpRequest.prototype so that every
      // outgoing request is logged to window.__fpAllRequests.
      //
      // Install BEFORE opening the picker to see whether typing in the filter field
      // triggers a server-side search request. Then read results with slate:get-requests.
      // Idempotent — safe to call multiple times.
      case 'slate:patch-network-all': {
        if (window.__fpAllNetPatched) {
          respond(id, { ok: true, alreadyPatched: true, count: (window.__fpAllRequests || []).length });
          break;
        }

        window.__fpAllRequests = [];
        const MAX_BODY_CHARS = 2000;

        // Fetch — also captures the response body (cloned so the page's own
        // consumption of the real Response is unaffected). Response reading is
        // async, so it's attached to the SAME entry object after the fact;
        // callers should re-read slate:get-requests a moment after the action
        // they're diagnosing to give response bodies time to resolve.
        const _origFetchAll = window.fetch.bind(window);
        window.fetch = function(input, init, ...rest) {
          const url    = typeof input === 'string' ? input : (input?.url || '');
          const method = (init?.method || 'GET').toUpperCase();
          let reqBody = null;
          if (init?.body) {
            try { reqBody = typeof init.body === 'string' ? JSON.parse(init.body) : String(init.body).slice(0, MAX_BODY_CHARS); }
            catch { reqBody = String(init.body).slice(0, MAX_BODY_CHARS); }
          }
          const entry = { ts: Date.now(), via: 'fetch', method, url, body: reqBody, response: null, responseError: null };
          window.__fpAllRequests.push(entry);

          const promise = _origFetchAll(input, init, ...rest);
          promise.then((res) => {
            res.clone().text().then((text) => {
              try { entry.response = JSON.parse(text); }
              catch { entry.response = text.slice(0, MAX_BODY_CHARS); }
            }).catch((e) => { entry.responseError = e.message; });
          }).catch((e) => { entry.responseError = e.message; });
          return promise;
        };

        // XHR — same idea via the load event, which fires once responseText
        // is available.
        const _origXhrOpen = XMLHttpRequest.prototype.open;
        const _origXhrSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this.__fpXhrMethod = method;
          this.__fpXhrUrl    = String(url).slice(0, 600);
          return _origXhrOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function(body) {
          let reqBody = null;
          if (body) { try { reqBody = JSON.parse(body); } catch { reqBody = String(body).slice(0, MAX_BODY_CHARS); } }
          const entry = {
            ts: Date.now(), via: 'xhr',
            method: this.__fpXhrMethod, url: this.__fpXhrUrl, body: reqBody, response: null, responseError: null,
          };
          window.__fpAllRequests.push(entry);
          this.addEventListener('load', () => {
            try { entry.response = JSON.parse(this.responseText); }
            catch { entry.response = String(this.responseText || '').slice(0, MAX_BODY_CHARS); }
          });
          this.addEventListener('error', () => { entry.responseError = 'xhr error event'; });
          return _origXhrSend.call(this, body);
        };

        window.__fpAllNetPatched = true;
        respond(id, { ok: true });
        break;
      }

      // ── Snapshot client-side storage + obviously-cache-shaped globals ────────
      //
      // If a real "Add to Prompt" click registers a character somewhere other
      // than a network call (a Zustand/Redux store, a plain in-memory cache
      // hung off window, IndexedDB), a network capture alone won't see it.
      // This grabs localStorage, sessionStorage, and any enumerable window
      // property whose name suggests a store/cache, so two snapshots (before
      // and after a real click) can be diffed by the caller.
      case 'slate:snapshot-state': {
        const snap = { ts: Date.now(), localStorage: {}, sessionStorage: {}, windowKeys: {} };

        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            snap.localStorage[k] = localStorage.getItem(k);
          }
        } catch (e) { snap.localStorageError = e.message; }

        try {
          for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i);
            snap.sessionStorage[k] = sessionStorage.getItem(k);
          }
        } catch (e) { snap.sessionStorageError = e.message; }

        const CACHE_NAME_RE = /cache|store|query|character|trpc|state|redux|zustand/i;
        try {
          for (const k of Object.getOwnPropertyNames(window)) {
            if (!CACHE_NAME_RE.test(k)) continue;
            if (k.startsWith('__fp')) continue; // our own instrumentation
            try {
              const v = window[k];
              if (v == null || typeof v === 'function') continue;
              const json = JSON.stringify(v, (_key, val) => (typeof val === 'function' ? '[function]' : val));
              snap.windowKeys[k] = json ? JSON.parse(json) : String(v);
            } catch { snap.windowKeys[k] = '[unserializable]'; }
          }
        } catch (e) { snap.windowKeysError = e.message; }

        respond(id, snap);
        break;
      }

      // ── Retrieve (and optionally clear) the request log ───────────────────────
      //
      // payload.since  (number, ms timestamp) — return only entries after this time
      // payload.clear  (boolean)              — empty the log after reading
      case 'slate:get-requests': {
        const allReqs = window.__fpAllRequests || [];
        const sinceTs = payload?.since;
        const out     = sinceTs ? allReqs.filter(r => r.ts >= sinceTs) : allReqs;
        if (payload?.clear) window.__fpAllRequests = [];
        respond(id, { count: out.length, requests: out });
        break;
      }

      // ── Retrieve (and optionally clear) the Zustand devtools action log ──────
      //
      // Populated by redux-devtools-shim.js (a separate document_start /
      // MAIN-world content script — see its own header comment for why the
      // timing matters). Requires that shim to have been in place BEFORE this
      // page load; if window.__fpDevtoolsPatched is false, the shim never
      // installed in time (e.g. the extension was reloaded but the Flow tab
      // wasn't) and this will just return an empty log.
      //
      // payload.since  (number, ms timestamp) — return only entries after this time
      // payload.clear  (boolean)              — empty the log after reading
      case 'slate:get-devtools-log': {
        if (!window.__fpDevtoolsPatched) {
          respond(id, null, 'devtools shim never installed for this page load — reload the Flow tab (not just the extension) after installing/updating redux-devtools-shim.js');
          break;
        }
        const allEntries = window.__fpDevtoolsLog || [];
        const sinceTs2    = payload?.since;
        const out2        = sinceTs2 ? allEntries.filter(e => e.ts >= sinceTs2) : allEntries;
        if (payload?.clear) window.__fpDevtoolsLog = [];
        respond(id, { count: out2.length, entries: out2 });
        break;
      }

      // ── Install a fetch interceptor to capture Generate request payloads ────
      //
      // Flow sends a POST when the user clicks Generate. By patching window.fetch
      // we can capture the JSON body and compare a manual-pick prompt against a
      // synthesized one — specifically whether characterServerId appears in the
      // payload (meaning the server reads it from the request) or not (meaning the
      // server uses session state set during the picker interaction).
      //
      // Call slate:patch-network once (idempotent). Then click Generate (manually or
      // via the extension). Then call slate:get-network to retrieve the captured
      // payload.
      case 'slate:patch-network': {
        if (window.__fpFetchPatched) {
          respond(id, { ok: true, alreadyPatched: true, lastRequest: window.__fpLastRequest || null });
          break;
        }
        const _origFetch = window.fetch.bind(window);
        window.fetch = function (input, init, ...rest) {
          try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const body = init && init.body;
            if (body) {
              let parsed = null;
              try { parsed = typeof body === 'string' ? JSON.parse(body) : body; } catch {}
              // Capture every POST with a parseable body; the generate endpoint will
              // contain character/prompt fields we can inspect.
              window.__fpLastRequest = { url, body: parsed ?? body, ts: Date.now() };
            }
          } catch {}
          return _origFetch(input, init, ...rest);
        };
        window.__fpFetchPatched = true;
        respond(id, { ok: true });
        break;
      }

      // ── Retrieve the last intercepted network request payload ─────────────
      case 'slate:get-network': {
        respond(id, { request: window.__fpLastRequest || null });
        break;
      }

      default:
        respond(id, null, 'unknown cmd: ' + cmd);
    }
  } catch (e) {
    respond(id, null, e.message);
  }
});

// Signal readiness. content.js doesn't need to wait for this (user interaction
// always arrives well after document_idle), but it's useful for manual console testing.
window.dispatchEvent(new CustomEvent('fp:ready'));
