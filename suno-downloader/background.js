/**
 * background.js
 *
 * page-inject.js (running in the real page context) intercepts every fetch
 * call Suno makes and fires window events.  content.js relays those events
 * here as runtime messages.  Because content.js is now injected at
 * document_start, it installs page-inject.js before any Suno JavaScript runs,
 * so we catch the very first API call that carries the auth token.
 */
(function () {
  'use strict';

  // ── state ──────────────────────────────────────────────────────────────────

  let authToken  = null;
  let feedBaseUrl = null;   // API base URL for the workspace currently open

  let fetchedSongs = [];    // populated only by an explicit FETCH_ALL_SONGS call

  let isDownloading  = false;
  let stopRequested  = false;
  let progress = {
    current: 0, total: 0, currentTitle: '',
    done: false, stopped: false, errors: [],
  };

  // ── messages ───────────────────────────────────────────────────────────────

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {

      case 'AUTH_CAPTURED':
        authToken = msg.token;
        return false;

      case 'SONGS_CAPTURED':
        if (msg.token)    authToken    = msg.token;
        if (msg.feedBase) feedBaseUrl  = msg.feedBase;
        return false;

      case 'DOM_IDS_CAPTURED':
        return false;

      case 'GET_STATUS':
        sendResponse({
          fetchedCount: fetchedSongs.length,
          hasToken:     !!authToken,
          isDownloading,
          progress,
        });
        return false;

      case 'FETCH_ALL_SONGS':
        if (!authToken) {
          sendResponse({ error: 'No session token yet — browse your Suno workspace first, then try again.' });
          return false;
        }
        fetchAllSongs()
          .then(count => sendResponse({ count }))
          .catch(err  => sendResponse({ error: err.message }));
        return true;   // keep channel open for async reply

      case 'START_DOWNLOAD':
        startDownload();
        sendResponse({ started: true });
        return false;

      case 'STOP_DOWNLOAD':
        stopRequested = true;
        sendResponse({ stopped: true });
        return false;

      default:
        return false;
    }
  });

  // ── fetch all pages ────────────────────────────────────────────────────────

  async function fetchAllSongs() {
    fetchedSongs = [];
    const seen     = new Set();
    const base     = feedBaseUrl || 'https://studio-api.suno.ai/api/feed/v2/';
    const pageSize = 20;
    let   page     = 0;
    let   numTotal = null;

    while (true) {
      const url  = `${base}?page_size=${pageSize}&page=${page}`;
      let   resp;
      try {
        resp = await fetch(url, { headers: { Authorization: authToken } });
      } catch (err) {
        throw new Error(`Network error: ${err.message}`);
      }

      if (resp.status === 401)
        throw new Error('Session expired — refresh your Suno tab, then try again.');
      if (!resp.ok)
        throw new Error(`Suno API returned ${resp.status} — try refreshing suno.com.`);

      const data  = await resp.json();
      const clips = data.clips || data.songs || data.items
                    || (Array.isArray(data) ? data : []);

      for (const clip of clips) {
        if (clip && clip.id && !seen.has(clip.id) && isComplete(clip)) {
          seen.add(clip.id);
          fetchedSongs.push(clip);
        }
      }

      if (numTotal === null) numTotal = data.num_total_results || data.total || 0;
      if (clips.length < pageSize) break;
      if (numTotal > 0 && fetchedSongs.length >= numTotal) break;
      page++;
    }

    return fetchedSongs.length;
  }

  // ── download queue ─────────────────────────────────────────────────────────

  async function startDownload() {
    if (isDownloading || fetchedSongs.length === 0) return;

    const list    = [...fetchedSongs];
    isDownloading = true;
    stopRequested = false;
    progress      = { current: 0, total: list.length, currentTitle: '', done: false, stopped: false, errors: [] };
    broadcastProgress();

    for (const song of list) {
      if (stopRequested) break;

      const title = getSongTitle(song);
      progress.current++;
      progress.currentTitle = title;
      broadcastProgress();

      try {
        await downloadSong(song);
      } catch (err) {
        progress.errors.push(`"${title}": ${err.message}`);
      }
    }

    isDownloading   = false;
    progress.done    = !stopRequested;
    progress.stopped = stopRequested;
    broadcastProgress();
  }

  async function downloadSong(song) {
    const wavUrl = song.audio_url
      ? song.audio_url.replace(/\.mp3(\?.*)?$/, '.wav')
      : `https://cdn1.suno.ai/${song.id}.wav`;
    const safe = sanitize(getSongTitle(song));

    try {
      await triggerDownload(wavUrl, `suno-downloads/${safe}.wav`);
    } catch (_) {
      const mp3 = song.audio_url || `https://cdn1.suno.ai/${song.id}.mp3`;
      await triggerDownload(mp3, `suno-downloads/${safe}.mp3`);
    }
  }

  function triggerDownload(url, filename) {
    return new Promise((resolve, reject) => {
      browser.downloads.download(
        { url, filename, saveAs: false, conflictAction: 'uniquify' },
        (id) => {
          if (browser.runtime.lastError)
            return reject(new Error(browser.runtime.lastError.message));
          waitForDownload(id, resolve, reject);
        }
      );
    });
  }

  function waitForDownload(id, resolve, reject) {
    const cb = (delta) => {
      if (delta.id !== id) return;
      if (delta.state?.current === 'complete')
        { browser.downloads.onChanged.removeListener(cb); resolve(); }
      else if (delta.state?.current === 'interrupted')
        { browser.downloads.onChanged.removeListener(cb); reject(new Error('interrupted')); }
    };
    browser.downloads.onChanged.addListener(cb);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  function getSongTitle(clip) {
    return (
      clip.title?.trim()                          ||
      clip.display_name?.trim()                   ||
      clip.name?.trim()                           ||
      clip.metadata?.title?.trim()                ||
      clip.metadata?.prompt?.trim()?.slice(0,120) ||
      clip.id
    );
  }

  function isComplete(clip) {
    if (!clip.status) return true;
    return clip.status === 'complete' || clip.status === 'completed';
  }

  function sanitize(name) {
    return String(name)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .trim().slice(0, 200) || 'untitled';
  }

  function broadcastProgress() {
    browser.runtime.sendMessage({ type: 'PROGRESS_UPDATE', progress }).catch(() => {});
  }

})();
