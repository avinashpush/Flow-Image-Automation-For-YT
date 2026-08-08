'use strict';

// ─── ELEMENT REFS ─────────────────────────────────────────────────────────────────

const logEl          = document.getElementById('log');
const statusBar      = document.getElementById('status-bar');
const folderInput    = document.getElementById('folder-input');
const queueScriptEl  = document.getElementById('queue-script');
const promptCountEl  = document.getElementById('prompt-count');
const promptListEl   = document.getElementById('prompt-list');
const failedBoxEl    = document.getElementById('failed-box');
const failedEntriesEl = document.getElementById('failed-entries');
const delayMinEl     = document.getElementById('delay-min');
const delayMaxEl     = document.getElementById('delay-max');
const runQueueBtn    = document.getElementById('run-queue-btn');
const stopQueueBtn   = document.getElementById('stop-queue-btn');
const queueProgressEl = document.getElementById('queue-progress');
const parseErrorsEl  = document.getElementById('parse-errors');
const extractRosterBtn = document.getElementById('extract-roster-btn');
const diagnosePickerBtn = document.getElementById('diagnose-picker-btn');
const harvestIdsBtn = document.getElementById('harvest-ids-btn');
const diagnoseSidefxBtn = document.getElementById('diagnose-sidefx-btn');
const copyLogBtn = document.getElementById('copy-log-btn');

// ─── PROMPT SCRIPT PARSER ─────────────────────────────────────────────────────────
//
// Mirror of parsePromptScript() in content.js. Defined here so the popup can
// validate the script locally before sending anything over the port.
// Pure function — no DOM or extension APIs.

function parsePromptScript(rawText) {
  const blocks = rawText.split(/\n[ \t]*\n+/);
  const items  = [];
  const errors = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block) continue;

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

// ─── DOWNLOAD FOLDER SETTING ─────────────────────────────────────────────────────

function sanitizeFolder(raw) {
  return raw
    .replace(/\.\./g, '')
    .replace(/[/\\]/g, '')
    .trim();
}

chrome.storage.local.get(['downloadFolder', 'queueDelayMin', 'queueDelayMax'], (stored) => {
  if (stored.downloadFolder) folderInput.value = stored.downloadFolder;
  if (stored.queueDelayMin != null) delayMinEl.value = stored.queueDelayMin;
  if (stored.queueDelayMax != null) delayMaxEl.value = stored.queueDelayMax;
});

folderInput.addEventListener('input', () => {
  const clean = sanitizeFolder(folderInput.value);
  chrome.storage.local.set({ downloadFolder: clean || 'FlowOutputs' });
});

delayMinEl.addEventListener('change', () => {
  chrome.storage.local.set({ queueDelayMin: parseInt(delayMinEl.value, 10) || 3000 });
});
delayMaxEl.addEventListener('change', () => {
  chrome.storage.local.set({ queueDelayMax: parseInt(delayMaxEl.value, 10) || 8000 });
});

// ─── PORT ────────────────────────────────────────────────────────────────────────

let activePort = null;

// ─── LOG ─────────────────────────────────────────────────────────────────────────

function clearLog() {
  logEl.innerHTML = '<span class="log-empty">Log cleared.</span>';
}

function appendLog(text, level = 'info') {
  const placeholder = logEl.querySelector('.log-empty');
  if (placeholder) placeholder.remove();
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.textContent = text;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

// ─── STATUS ──────────────────────────────────────────────────────────────────────

function setStatus(text, state = '') {
  statusBar.textContent = text;
  statusBar.className   = state;
}

// ─── UI STATE ────────────────────────────────────────────────────────────────────

// Locks the queue section while a queue is running.
function setQueueRunning(on) {
  runQueueBtn.disabled    = on;
  stopQueueBtn.disabled   = !on;
  queueScriptEl.disabled  = on;
  delayMinEl.disabled     = on;
  delayMaxEl.disabled     = on;
}

// ─── TAB / CONNECTION ────────────────────────────────────────────────────────────

async function getFlowTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found.');
  if (!tab.url?.includes('labs.google')) {
    throw new Error(
      `Active tab is not on labs.google (currently: ${tab.url || 'unknown'}). ` +
      `Open the Flow prompt page first.`
    );
  }
  return tab;
}

function connectToContent(tabId) {
  return new Promise((resolve, reject) => {
    let connected = false;
    const port = chrome.tabs.connect(tabId, { name: 'flow-prompter' });
    port.onDisconnect.addListener(() => {
      if (!connected) {
        const msg = chrome.runtime.lastError?.message || 'Content script not found';
        reject(new Error(`${msg}. Try reloading the Flow tab.`));
      }
    });
    connected = true;
    resolve(port);
  });
}

// ─── PORT LISTENER — QUEUE ───────────────────────────────────────────────────────

function attachQueueListeners(port, { onDone }) {
  port.onMessage.addListener(msg => {
    if (msg.type === 'log') {
      appendLog(msg.status, msg.level || 'info');

      // Detect "[queue] Item X/Y" lines to update the progress indicator.
      const m = msg.status.match(/\[queue\] Item (\d+)\/(\d+)/);
      if (m) {
        queueProgressEl.textContent = `Prompt ${m[1]} of ${m[2]}`;
        queueProgressEl.hidden = false;
      }
    } else if (msg.type === 'promptStatus') {
      updatePromptStatus(msg.index, msg.status);
    } else if (msg.type === 'queueDone') {
      onDone(msg.result);
      activePort = null;
    }
  });

  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || '(no lastError)';
    if (activePort !== null) {
      appendLog(`Connection lost (${reason}) — content script may have crashed or tab navigated`, 'error');
      setStatus('Connection lost', 'error');
      setQueueRunning(false);
      queueProgressEl.hidden = true;
      activePort = null;
    }
  });
}

// ─── RUN QUEUE ───────────────────────────────────────────────────────────────────

runQueueBtn.addEventListener('click', async () => {
  const raw = queueScriptEl.value;

  // Parse and validate locally before touching the port.
  const { items, errors } = parsePromptScript(raw);

  // Show or hide parse errors.
  if (errors.length) {
    parseErrorsEl.hidden = false;
    parseErrorsEl.innerHTML = errors.map(e => {
      const preview = e.preview + (e.preview.length >= 60 ? '…' : '');
      return `<div>Block ${e.blockIndex + 1} could not be parsed: "${preview}"</div>`;
    }).join('');
    // Don't send — require the user to fix the script first.
    return;
  }
  parseErrorsEl.hidden = true;

  if (!items.length) {
    appendLog('No valid prompt blocks found in script.', 'warn');
    return;
  }

  const delayMin = Math.max(0, parseInt(delayMinEl.value, 10) || 3000);
  const delayMax = Math.max(delayMin, parseInt(delayMaxEl.value, 10) || 8000);

  let tab, port;
  try {
    tab  = await getFlowTab();
    port = await connectToContent(tab.id);
  } catch (err) {
    appendLog(`✗ ${err.message}`, 'error');
    setStatus('Error — see log', 'error');
    return;
  }

  activePort = port;

  // Reset all statuses to pending for this run (textarea was validated/disabled above).
  promptStatuses = promptStatuses.map(s => ({ text: s.text, status: 'pending' }));
  renderPromptList();
  clearFailedBox();

  setQueueRunning(true);
  queueProgressEl.hidden = true;
  setStatus(`Queue running — ${items.length} prompt${items.length !== 1 ? 's' : ''}…`, 'running');
  appendLog(`Starting queue: ${items.length} prompt${items.length !== 1 ? 's' : ''}, delay ${delayMin}–${delayMax}ms`);

  attachQueueListeners(port, {
    onDone(result) {
      setQueueRunning(false);
      queueProgressEl.hidden = true;

      // Mark any prompt still pending or generating as stopped (early stop or error).
      promptStatuses.forEach((_, idx) => {
        const s = promptStatuses[idx].status;
        if (s === 'pending' || s === 'generating') updatePromptStatus(idx, 'stopped');
      });

      const succeeded = promptStatuses.filter(s => s.status === 'done').length;
      const failed    = promptStatuses.filter(s => s.status === 'failed').length;
      const summary   = `${succeeded} succeeded, ${failed} failed`;

      if (result.done) {
        setStatus(`Queue complete — ${summary}.`, failed > 0 ? 'warn' : 'done');
        appendLog(`Queue complete — ${summary}.`, failed > 0 ? 'warn' : 'success');
      } else if (result.stopped) {
        setStatus(`Queue stopped after ${result.completed} of ${items.length} — ${summary}.`, 'warn');
        appendLog(`Queue stopped — ${result.completed} run, ${summary}.`, 'warn');
      } else if (result.crashed) {
        setStatus(`Flow crashed after ${result.completed} of ${items.length} — reload the tab and resume.`, 'error');
        appendLog(`Queue halted — Flow's page crashed (editor disappeared). Reload the Flow tab, then re-run starting from item ${result.completed + 1}.`, 'error');
      } else {
        const idx = result.failedIndex != null ? ` at item ${result.failedIndex + 1}` : '';
        setStatus(`Queue error${idx}: ${result.error}`, 'error');
        appendLog(`Queue failed${idx}: ${result.error}`, 'error');
      }
    },
  });

  port.postMessage({
    action:     'runQueue',
    promptItems: items,
    delayMinMs:  delayMin,
    delayMaxMs:  delayMax,
  });
});

// ─── STOP QUEUE ──────────────────────────────────────────────────────────────────

stopQueueBtn.addEventListener('click', () => {
  if (activePort) {
    try { activePort.postMessage({ action: 'stopQueue' }); } catch (_) {}
    appendLog('[queue] Stop requested — current item will finish then queue will halt.', 'warn');
    // Disable stop button immediately to prevent double-sends; queue runner
    // will re-enable the full UI once it detects the token change and exits.
    stopQueueBtn.disabled = true;
  }
});

// ─── EXTRACT CHARACTER IDS ────────────────────────────────────────────────────────
//
// One-shot utility: opens the "@" picker and reads every character's name + ID
// straight out of Virtuoso's React props (see extractCharacterRoster() /
// slate:extract-roster), then logs "'name': 'id'," lines ready to paste into
// CHARACTER_ID_MAP in content.js. Does not touch the queue or its port state.

extractRosterBtn.addEventListener('click', async () => {
  let tab, port;
  try {
    tab  = await getFlowTab();
    port = await connectToContent(tab.id);
  } catch (err) {
    appendLog(`✗ ${err.message}`, 'error');
    setStatus('Error — see log', 'error');
    return;
  }

  extractRosterBtn.disabled = true;
  appendLog('Extracting character roster…');

  port.onMessage.addListener(function onMsg(msg) {
    if (msg.type === 'log') {
      appendLog(msg.status, msg.level || 'info');
    } else if (msg.type === 'done') {
      port.onMessage.removeListener(onMsg);
      extractRosterBtn.disabled = false;
      if (!msg.success) {
        appendLog(`✗ Roster extraction failed: ${msg.error}`, 'error');
      }
    }
  });

  port.onDisconnect.addListener(() => {
    extractRosterBtn.disabled = false;
  });

  port.postMessage({ action: 'extractRoster' });
});

// ─── DIAGNOSE PICKER ──────────────────────────────────────────────────────────────
//
// Fallback for when extractRoster can't find a matching array prop. Dumps the
// picker's component chain, every array prop found on ancestor fibers (with a
// 2-item sample), and any filter/query string props — see diagnosePicker() /
// slate:inspect-picker in content.js / main-world.js.

diagnosePickerBtn.addEventListener('click', async () => {
  const characterName = window.prompt(
    'Character name to type into the picker filter while diagnosing (any saved character works):',
    'Danny'
  );
  if (!characterName) return;

  let tab, port;
  try {
    tab  = await getFlowTab();
    port = await connectToContent(tab.id);
  } catch (err) {
    appendLog(`✗ ${err.message}`, 'error');
    setStatus('Error — see log', 'error');
    return;
  }

  diagnosePickerBtn.disabled = true;
  appendLog(`Diagnosing picker (filter: "${characterName}")…`);

  port.onMessage.addListener(function onMsg(msg) {
    if (msg.type === 'log') {
      appendLog(msg.status, msg.level || 'info');
    } else if (msg.type === 'done') {
      port.onMessage.removeListener(onMsg);
      diagnosePickerBtn.disabled = false;
      if (!msg.success) {
        appendLog(`✗ Picker diagnosis failed: ${msg.error}`, 'error');
      }
    }
  });

  port.onDisconnect.addListener(() => {
    diagnosePickerBtn.disabled = false;
  });

  port.postMessage({ action: 'diagnosePicker', characterName });
});

// ─── HARVEST CHARACTER IDS (via real insertion) ──────────────────────────────────
//
// Fallback for when Extract Character IDs can't find a matching React prop.
// Inserts each given name for real via the picker (clearing the editor between
// each), then reads its true characterServerId back off the resulting chip —
// see harvestCharacterIds() in content.js. Slower (one real insertion per
// name) but only relies on the picker-driven insertion path already proven
// to work throughout the queue runner.

const DEFAULT_HARVEST_NAMES = [
  'Env_Studio_Astoria', 'Env_SliceShop', 'Env_CitySt_Night', 'Env_TaxOffice',
  'Env_BankVestibule', 'Env_CoopBoardRoom', 'Env_Brownstone_Kitchen', 'Env_AdmissionsOffice',
  'Env_PartyLoft', 'Env_WealthOffice', 'Env_HamptonsHouse', 'Env_PhilanthropyOffice',
  'Env_PenthouseWindow', 'Env_Lobby_Supertall', 'Env_Elevator', 'Elena', 'Theodore', 'Diane',
].join(', ');

harvestIdsBtn.addEventListener('click', async () => {
  const raw = window.prompt(
    'Comma-separated character names to insert and harvest IDs for (editor will be cleared before/after):',
    DEFAULT_HARVEST_NAMES
  );
  if (!raw) return;
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) return;

  let tab, port;
  try {
    tab  = await getFlowTab();
    port = await connectToContent(tab.id);
  } catch (err) {
    appendLog(`✗ ${err.message}`, 'error');
    setStatus('Error — see log', 'error');
    return;
  }

  harvestIdsBtn.disabled = true;
  appendLog(`Harvesting IDs for ${names.length} name(s)…`);

  port.onMessage.addListener(function onMsg(msg) {
    if (msg.type === 'log') {
      appendLog(msg.status, msg.level || 'info');
    } else if (msg.type === 'done') {
      port.onMessage.removeListener(onMsg);
      harvestIdsBtn.disabled = false;
      if (!msg.success) {
        appendLog(`✗ Harvest failed: ${msg.error}`, 'error');
      }
    }
  });

  port.onDisconnect.addListener(() => {
    harvestIdsBtn.disabled = false;
  });

  port.postMessage({ action: 'harvestRoster', names });
});

// ─── DIAGNOSE ADD-TO-PROMPT SIDE EFFECTS ─────────────────────────────────────────
//
// Snapshots network activity + client-side storage/caches before and after a
// real, picker-driven character insertion (the proven-correct path), then
// diffs everything — see diagnoseAddToPromptSideEffects() in content.js.
// Goal: find whatever "Add to Prompt" does beyond mutating the Slate document,
// since direct node insertion (bypassing the picker) produces a node that
// looks correct but gets silently flattened to plain text before generation.

diagnoseSidefxBtn.addEventListener('click', async () => {
  const characterName = window.prompt(
    'Character name to insert via the real picker while diagnosing (any saved character works):',
    'Danny'
  );
  if (!characterName) return;

  let tab, port;
  try {
    tab  = await getFlowTab();
    port = await connectToContent(tab.id);
  } catch (err) {
    appendLog(`✗ ${err.message}`, 'error');
    setStatus('Error — see log', 'error');
    return;
  }

  diagnoseSidefxBtn.disabled = true;
  appendLog(`Diagnosing Add-to-Prompt side effects (character: "${characterName}")…`);

  port.onMessage.addListener(function onMsg(msg) {
    if (msg.type === 'log') {
      appendLog(msg.status, msg.level || 'info');
    } else if (msg.type === 'done') {
      port.onMessage.removeListener(onMsg);
      diagnoseSidefxBtn.disabled = false;
      if (!msg.success) {
        appendLog(`✗ Side-effect diagnosis failed: ${msg.error}`, 'error');
      }
    }
  });

  port.onDisconnect.addListener(() => {
    diagnoseSidefxBtn.disabled = false;
  });

  port.postMessage({ action: 'diagnoseSideEffects', characterName });
});

// ─── COPY LOG ────────────────────────────────────────────────────────────────────
//
// Selecting text inside the scrolling log panel is fiddly and truncates easily,
// which repeatedly cost us the tail of a run — exactly where failures appear.
// One click copies the whole thing verbatim.

copyLogBtn.addEventListener('click', async () => {
  const text = logEl.innerText.trim();
  if (!text) return;
  const original = copyLogBtn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    copyLogBtn.textContent = `Copied ${text.split('\n').length} lines`;
  } catch (err) {
    copyLogBtn.textContent = 'Copy failed';
  }
  setTimeout(() => { copyLogBtn.textContent = original; }, 2000);
});

// ─── PROMPT STATUS LIST ──────────────────────────────────────────────────────────
//
// promptStatuses is the source of truth for the list. Each entry is
// { text: string, status: 'pending'|'generating'|'done'|'failed'|'stopped' }.
// It is rebuilt (preserving existing status for unchanged lines) whenever the
// textarea changes, and individual entries are updated via updatePromptStatus()
// during a queue run.

let promptStatuses = [];

const BADGE_LABELS = {
  pending:    '—',
  generating: 'generating',
  done:       'done',
  failed:     'failed',
  stopped:    'stopped',
};

function renderPromptList() {
  promptListEl.innerHTML = '';
  for (let i = 0; i < promptStatuses.length; i++) {
    const { text, status } = promptStatuses[i];
    const row = document.createElement('div');
    row.className = 'prompt-row';
    row.dataset.status = status;

    const num = document.createElement('span');
    num.className = 'prompt-row-num';
    num.textContent = String(i + 1);

    const label = document.createElement('span');
    label.className = 'prompt-row-text';
    label.textContent = text;

    const badge = document.createElement('span');
    badge.className = 'prompt-row-badge';
    badge.textContent = BADGE_LABELS[status] || status;

    row.appendChild(num);
    row.appendChild(label);
    row.appendChild(badge);
    promptListEl.appendChild(row);
  }
}

function updatePromptStatus(index, status) {
  if (index < 0 || index >= promptStatuses.length) return;
  promptStatuses[index].status = status;
  const rows = promptListEl.querySelectorAll('.prompt-row');
  const row = rows[index];
  if (row) {
    row.dataset.status = status;
    const badge = row.querySelector('.prompt-row-badge');
    if (badge) badge.textContent = BADGE_LABELS[status] || status;
    if (status === 'generating') row.scrollIntoView({ block: 'nearest' });
  }
  if (status === 'failed') addFailedEntry(index);
}

function addFailedEntry(index) {
  const { text } = promptStatuses[index];
  const entry = document.createElement('div');
  entry.className = 'failed-entry';
  entry.textContent = `#${index + 1} — ${text}`;
  failedEntriesEl.appendChild(entry);
  failedBoxEl.hidden = false;
}

function clearFailedBox() {
  failedEntriesEl.innerHTML = '';
  failedBoxEl.hidden = true;
}

// ─── LIVE PROMPT COUNT ───────────────────────────────────────────────────────────

function updatePromptCount() {
  const { items, errors } = parsePromptScript(queueScriptEl.value);
  if (!queueScriptEl.value.trim()) {
    promptCountEl.textContent = '';
    promptCountEl.className = '';
    promptStatuses = [];
    renderPromptList();
    return;
  }

  // Rebuild promptStatuses: preserve status for entries whose text is unchanged
  // at the same index; reset changed/new entries to 'pending'.
  const prev = promptStatuses;
  promptStatuses = items.map((item, i) => {
    const text = `${item.timestamp} ${item.text}`;
    if (prev[i] && prev[i].text === text) return { text, status: prev[i].status };
    return { text, status: 'pending' };
  });
  renderPromptList();

  if (errors.length) {
    promptCountEl.textContent =
      `${items.length} prompt${items.length !== 1 ? 's' : ''} loaded, ` +
      `${errors.length} block${errors.length !== 1 ? 's' : ''} could not be parsed`;
    promptCountEl.className = 'has-errors';
  } else {
    promptCountEl.textContent = `${items.length} prompt${items.length !== 1 ? 's' : ''} loaded`;
    promptCountEl.className = '';
  }
}

queueScriptEl.addEventListener('input', updatePromptCount);
