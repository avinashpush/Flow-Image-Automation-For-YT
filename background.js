'use strict';

// ─── REACT FIBER CLICK ─────────────────────────────────────────────────────────
//
// Replicates Zappy Flow's clickViaReactFiber pattern:
//   content script marks the target element → sends REACT_FIBER_CLICK here →
//   we inject a self-contained function into the page's MAIN world via
//   chrome.scripting.executeScript so it runs in the same JS heap as React.
//
// Why this beats calling __reactProps$.onClick() from main-world.js:
//   - Walking UP the fiber tree finds onSubmit on a parent component.
//     Form onSubmit handlers don't check event.nativeEvent.isTrusted, which
//     is exactly the check that caused "Cannot read properties of undefined
//     (reading 'isTrusted')" when we called the button's own onClick prop.
//   - executeScript world:"MAIN" runs the injected func in the same context as
//     the page without any content-script isolation layer.
//
// The injected function is fully self-contained — no closure over outer vars.

function fiberClickInMainWorld(markerAttr, token) {
  var el = document.querySelector('[' + markerAttr + '="' + token + '"]');
  if (!el) return { ok: false, reason: 'element not found: ' + markerAttr + '=' + token };

  var fk = Object.keys(el).find(function(k) {
    return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
  });
  if (!fk) return { ok: false, reason: '__reactFiber$ key not on element' };

  // Try calling fn with no args first; then with a full SyntheticEvent stub
  // that provides nativeEvent.isTrusted (needed by onClick handlers that do
  // exactly what broke us before: read event.nativeEvent.isTrusted).
  function tryCall(fn, element) {
    try {
      fn();
      return { ok: true, args: 'none' };
    } catch (_) {}

    try {
      var ne = {
        isTrusted: true, type: 'click', bubbles: true, cancelable: true,
        defaultPrevented: false,
        preventDefault: function() {},
        stopPropagation: function() {},
        stopImmediatePropagation: function() {},
      };
      fn({
        nativeEvent: ne,
        isTrusted: true, type: 'click',
        target: element, currentTarget: element,
        bubbles: true, cancelable: true, defaultPrevented: false, eventPhase: 3,
        timeStamp: Date.now(),
        preventDefault: function() {},
        stopPropagation: function() {},
        stopImmediatePropagation: function() {},
        persist: function() {},
        isDefaultPrevented: function() { return false; },
        isPropagationStopped: function() { return false; },
      });
      return { ok: true, args: 'stub' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  // Walk fiber upward: onSubmit first (no isTrusted check), onClick second.
  var fiber = el[fk];
  for (var depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
    var mp = fiber.memoizedProps;
    if (!mp || typeof mp !== 'object') continue;

    if (typeof mp.onSubmit === 'function') {
      var rs = tryCall(mp.onSubmit, el);
      if (rs.ok) return { ok: true, method: 'onSubmit', depth: depth, args: rs.args };
    }

    if (typeof mp.onClick === 'function') {
      var rc = tryCall(mp.onClick, el);
      if (rc.ok) return { ok: true, method: 'onClick', depth: depth, args: rc.args };
    }
  }

  return { ok: false, reason: 'no callable onSubmit/onClick in 60 fiber levels' };
}

// ─── TOOLBAR ICON → SIDE PANEL ─────────────────────────────────────────────────
//
// Side panels don't open automatically when the toolbar icon is clicked (unlike
// default_popup). This listener opens the side panel for the current window so
// clicking the icon has the expected toggle behaviour.

chrome.action.onClicked.addListener(function(tab) {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// ─── MESSAGE LISTENER ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === 'SAVE_GENERATED_IMAGE') {
    // Read the user-configured folder name before building the path.
    // Falls back to 'FlowOutputs' if the setting was never saved.
    chrome.storage.local.get('downloadFolder', function(result) {
      var folder = (result.downloadFolder || 'FlowOutputs').replace(/[/\\]/g, '').trim() || 'FlowOutputs';
      chrome.downloads.download({
        url: msg.url,
        filename: folder + '/' + msg.filename,
        conflictAction: 'uniquify',
        saveAs: false,
      }, function(downloadId) {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, downloadId: downloadId });
        }
      });
    });
    return true; // keep channel open for async sendResponse
  }

  if (msg.type !== 'REACT_FIBER_CLICK') return false;

  var tabId = sender.tab && sender.tab.id;
  if (!tabId) {
    sendResponse({ ok: false, error: 'no tabId in sender' });
    return true;
  }

  chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: 'MAIN',
    func: fiberClickInMainWorld,
    args: [msg.markerAttr, msg.token],
  }).then(function(results) {
    var res = (results && results[0] && results[0].result) ||
              { ok: false, reason: 'no result from executeScript' };
    sendResponse({ ok: res.ok, detail: res });
  }).catch(function(err) {
    sendResponse({ ok: false, error: err.message });
  });

  return true; // keep channel open for async sendResponse
});
