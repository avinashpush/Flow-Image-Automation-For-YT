// redux-devtools-shim.js — NOT REGISTERED / NOT LOADED.
//
// UNREGISTERED from manifest.json. This was written to find a hypothesized
// "character registration" side channel behind Flow's "Add to Prompt" click.
// It captured ZERO entries when tested (slate:get-devtools-log returned an
// empty log), so it produced no diagnostic value — while still being a
// document_start MAIN-world script that lies to the page about Redux
// DevTools being installed, altering how Zustand's devtools middleware
// initializes every store. Since a recurring Next.js "removeChild" crash
// appeared around the same period, this was removed as a plausible
// destabilizer with nothing to lose. Kept on disk only as a record of the
// approach; re-register in manifest.json at your own risk.
//
// Original description follows.
//
// Runs in the page's MAIN world at document_start, BEFORE Flow's own JS
// bundle initializes.
//
// Flow uses Zustand with its `devtools` middleware, which checks for
// `window.__REDUX_DEVTOOLS_EXTENSION__` at store-creation time and silently
// no-ops (logging "Please install/enable Redux devtools extension") if it
// isn't there. By planting our own implementation of that extension object
// before any store is created, every Zustand store in the app unknowingly
// reports its name, initial state, and every subsequent action + resulting
// state straight to us — a complete window into in-memory app state that
// isn't reachable via window/localStorage/sessionStorage/network alone.
//
// Must run at document_start: Flow's stores are created once, early, during
// bundle initialization. Planting this any later (e.g. document_idle) means
// stores already checked for the extension and gave up before we existed.
//
// Read the captured log via the 'slate:get-devtools-log' command in
// main-world.js (same MAIN world, so it can read window.__fpDevtoolsLog
// directly).
'use strict';

(function () {
  if (window.__fpDevtoolsPatched) return;
  window.__fpDevtoolsPatched = true;
  window.__fpDevtoolsLog = [];

  function safeSerialize(v) {
    try { return JSON.parse(JSON.stringify(v)); }
    catch { return String(v); }
  }

  function makeConnection(name) {
    return {
      init(state) {
        window.__fpDevtoolsLog.push({ ts: Date.now(), store: name, type: 'init', state: safeSerialize(state) });
      },
      subscribe() { return function unsubscribe() {}; },
      unsubscribe() {},
      send(action, state) {
        window.__fpDevtoolsLog.push({ ts: Date.now(), store: name, type: 'send', action: safeSerialize(action), state: safeSerialize(state) });
      },
      error() {},
    };
  }

  let connCounter = 0;
  const extension = {
    connect(options) {
      const name = (options && (options.name || options.storeName)) || ('store#' + (++connCounter));
      return makeConnection(name);
    },
    send() {},
  };

  try {
    Object.defineProperty(window, '__REDUX_DEVTOOLS_EXTENSION__', {
      value: extension, writable: false, configurable: true,
    });
    Object.defineProperty(window, '__REDUX_DEVTOOLS_EXTENSION_COMPOSE__', {
      value: function () { return function (createStore) { return createStore; }; },
      writable: false, configurable: true,
    });
  } catch (e) {
    window.__fpDevtoolsShimError = e.message;
  }
})();
