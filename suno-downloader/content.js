/**
 * content.js — injected into every suno.com page.
 *
 * 1. Injects page-inject.js into the real page context so it can intercept
 *    fetch calls (content scripts run in a sandbox and cannot see page JS state).
 * 2. Listens for CustomEvents dispatched by page-inject.js and forwards the
 *    data to background.js.
 * 3. Scans the DOM for song links (fallback / supplement to API interception).
 */
(function () {
  'use strict';

  // --- inject page-inject.js into the real page context ---
  const script = document.createElement('script');
  script.src = browser.runtime.getURL('page-inject.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();

  // --- relay auth token from page to background ---
  window.addEventListener('__sunoAuth', (event) => {
    browser.runtime
      .sendMessage({ type: 'AUTH_CAPTURED', token: event.detail.token })
      .catch(() => {});
  });

  // --- relay song data from page to background ---
  window.addEventListener('__sunoData', (event) => {
    const { feedBase, token, data } = event.detail;
    browser.runtime
      .sendMessage({ type: 'SONGS_CAPTURED', feedBase, token, data, pageName: document.title })
      .catch(() => {});
  });

  // --- DOM scan: find song links visible on the page ---
  function scanDOM() {
    const ids = new Set();
    document.querySelectorAll('a[href]').forEach((a) => {
      const m = a.pathname.match(/\/song\/([a-f0-9-]{36})/i);
      if (m) ids.add(m[1]);
    });
    if (ids.size > 0) {
      browser.runtime
        .sendMessage({ type: 'DOM_IDS_CAPTURED', ids: [...ids] })
        .catch(() => {});
    }
  }

  // document.body is null at document_start, so wait for it before observing.
  function setupObserver() {
    scanDOM();
    const observer = new MutationObserver(scanDOM);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) {
    setupObserver();
  } else {
    document.addEventListener('DOMContentLoaded', setupObserver);
  }

})();
