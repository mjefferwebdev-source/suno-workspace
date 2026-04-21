/**
 * page-inject.js — runs in the real page JS context (not the content script sandbox).
 * Intercepts fetch calls made by the Suno web app so we can capture:
 *   - The Bearer token used for API calls
 *   - Song clip data returned from feed / library endpoints
 *
 * Communicates back to content.js via CustomEvent on window.
 */
(function () {
  'use strict';

  if (window.__sunoDownloaderInjected) return;
  window.__sunoDownloaderInjected = true;

  let capturedToken = null;
  let capturedFeedBase = null;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (resource, options) {
    const url =
      typeof resource === 'string'
        ? resource
        : resource instanceof Request
        ? resource.url
        : String(resource);

    // --- capture auth token ---
    if (url.includes('suno.ai') && options && options.headers) {
      const headers = options.headers;
      let auth = null;
      if (headers instanceof Headers) {
        auth = headers.get('Authorization') || headers.get('authorization');
      } else if (typeof headers === 'object') {
        auth =
          headers['Authorization'] ||
          headers['authorization'] ||
          null;
      }
      if (auth && auth !== capturedToken) {
        capturedToken = auth;
        window.dispatchEvent(
          new CustomEvent('__sunoAuth', { detail: { token: auth } })
        );
      }
    }

    const response = await originalFetch(resource, options);

    // --- capture song data from feed / library / clips endpoints ---
    const isSunoApi =
      url.includes('studio-api.suno.ai') ||
      url.includes('suno.com/api/');

    const isFeedLike =
      url.includes('/feed') ||
      url.includes('/clips') ||
      url.includes('/library') ||
      url.includes('/playlist') ||
      url.includes('/me/') ||
      url.includes('/songs');

    if (isSunoApi && isFeedLike) {
      // Capture base URL for later pagination
      try {
        const u = new URL(url);
        capturedFeedBase = u.origin + u.pathname;
      } catch (_) {}

      const clone = response.clone();
      clone
        .json()
        .then((data) => {
          window.dispatchEvent(
            new CustomEvent('__sunoData', {
              detail: {
                feedBase: capturedFeedBase,
                token: capturedToken,
                data,
              },
            })
          );
        })
        .catch(() => {});
    }

    return response;
  };

})();
