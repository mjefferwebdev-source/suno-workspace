/**
 * background.js — persistent background script.
 *
 * Responsibilities:
 *   - Store auth token and captured song list
 *   - Fetch all pages of songs from the Suno API when asked
 *   - Download songs one at a time, in order
 *   - Broadcast progress to the popup
 */
(function () {
  'use strict';

  // ── state ──────────────────────────────────────────────────────────────────

  let authToken = null;
  let feedBaseUrl = null;            // e.g. https://studio-api.suno.ai/api/feed/v2/
  const songs = new Map();           // clip id → clip object (from API)
  const domIds = new Set();          // clip ids found in DOM (no metadata yet)

  let isDownloading = false;
  let stopRequested = false;
  let progress = {
    current: 0,
    total: 0,
    currentTitle: '',
    done: false,
    stopped: false,
    errors: [],
  };

  // ── message handling ───────────────────────────────────────────────────────

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {

      case 'AUTH_CAPTURED':
        authToken = msg.token;
        return false;

      case 'SONGS_CAPTURED':
        if (msg.feedBase) feedBaseUrl = msg.feedBase;
        if (msg.token) authToken = msg.token;
        processSongData(msg.data);
        return false;

      case 'DOM_IDS_CAPTURED':
        (msg.ids || []).forEach((id) => domIds.add(id));
        return false;

      case 'GET_STATUS':
        sendResponse({
          songCount: songs.size,
          domIdCount: domIds.size,
          hasToken: !!authToken,
          hasFeedUrl: !!feedBaseUrl,
          isDownloading,
          progress,
        });
        return false;

      case 'FETCH_ALL_SONGS':
        if (!authToken) {
          sendResponse({ error: 'No auth token captured yet. Browse your Suno workspace first.' });
          return false;
        }
        fetchAllSongs()
          .then((count) => sendResponse({ count }))
          .catch((err) => sendResponse({ error: err.message }));
        return true; // keep channel open for async response

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

  // ── data processing ────────────────────────────────────────────────────────

  function processSongData(data) {
    if (!data) return;

    const clips =
      data.clips ||
      data.songs ||
      data.items ||
      (Array.isArray(data) ? data : null);

    if (Array.isArray(clips)) {
      clips.forEach((clip) => {
        if (clip && clip.id && isComplete(clip)) {
          songs.set(clip.id, clip);
        }
      });
    }

    // Single clip response
    if (data.id && isComplete(data)) {
      songs.set(data.id, data);
    }
  }

  function isComplete(clip) {
    // Only download finished clips (not pending / error states)
    if (!clip.status) return true; // assume complete if no status field
    return clip.status === 'complete' || clip.status === 'completed';
  }

  // ── fetch all songs via paginated API ──────────────────────────────────────

  async function fetchAllSongs() {
    songs.clear();

    // Determine the base URL to call
    const base = feedBaseUrl || 'https://studio-api.suno.ai/api/feed/v2/';

    const pageSize = 20;
    let page = 0;
    let numTotal = null;

    while (true) {
      const url = `${base}?page_size=${pageSize}&page=${page}`;
      let resp;
      try {
        resp = await fetch(url, {
          headers: { Authorization: authToken },
        });
      } catch (err) {
        throw new Error(`Network error: ${err.message}`);
      }

      if (resp.status === 401) {
        throw new Error('Session expired. Refresh your Suno tab to renew your login, then try again.');
      }
      if (!resp.ok) {
        throw new Error(`Suno API error ${resp.status}. Try refreshing the page.`);
      }

      const data = await resp.json();
      processSongData(data);

      if (numTotal === null) {
        numTotal = data.num_total_results || data.total || 0;
      }

      const fetched = data.clips || data.songs || data.items || [];
      if (fetched.length < pageSize) break;         // last page
      if (numTotal > 0 && songs.size >= numTotal) break;

      page++;
    }

    return songs.size;
  }

  // ── download queue ─────────────────────────────────────────────────────────

  async function startDownload() {
    if (isDownloading) return;

    // Build ordered list: API songs first, then DOM-only ids not already included
    const list = [...songs.values()];
    for (const id of domIds) {
      if (!songs.has(id)) {
        list.push({ id, title: id, audio_url: null });
      }
    }

    if (list.length === 0) return;

    isDownloading = true;
    stopRequested = false;
    progress = {
      current: 0,
      total: list.length,
      currentTitle: '',
      done: false,
      stopped: false,
      errors: [],
    };
    broadcastProgress();

    for (const song of list) {
      if (stopRequested) break;

      progress.current++;
      progress.currentTitle = song.title || song.id;
      broadcastProgress();

      try {
        await downloadSong(song);
      } catch (err) {
        progress.errors.push(`"${song.title || song.id}": ${err.message}`);
      }
    }

    isDownloading = false;
    progress.done = !stopRequested;
    progress.stopped = stopRequested;
    broadcastProgress();
  }

  async function downloadSong(song) {
    const wavUrl = buildWavUrl(song);
    const safe = sanitizeFilename(song.title || song.id);

    // Try WAV first; on failure fall back to MP3
    try {
      await triggerDownload(wavUrl, `suno-downloads/${safe}.wav`);
    } catch (_) {
      const mp3Url = song.audio_url || `https://cdn1.suno.ai/${song.id}.mp3`;
      await triggerDownload(mp3Url, `suno-downloads/${safe}.mp3`);
    }
  }

  function buildWavUrl(song) {
    if (song.audio_url) {
      // Swap .mp3 extension for .wav
      return song.audio_url.replace(/\.mp3(\?.*)?$/, '.wav');
    }
    return `https://cdn1.suno.ai/${song.id}.wav`;
  }

  function triggerDownload(url, filename) {
    return new Promise((resolve, reject) => {
      browser.downloads.download(
        { url, filename, saveAs: false, conflictAction: 'uniquify' },
        (downloadId) => {
          if (browser.runtime.lastError) {
            return reject(new Error(browser.runtime.lastError.message));
          }
          waitForDownload(downloadId, resolve, reject);
        }
      );
    });
  }

  function waitForDownload(downloadId, resolve, reject) {
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        browser.downloads.onChanged.removeListener(onChanged);
        resolve();
      } else if (delta.state?.current === 'interrupted') {
        browser.downloads.onChanged.removeListener(onChanged);
        reject(new Error('Download interrupted'));
      }
    };
    browser.downloads.onChanged.addListener(onChanged);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  function broadcastProgress() {
    browser.runtime
      .sendMessage({ type: 'PROGRESS_UPDATE', progress })
      .catch(() => {}); // popup may not be open — that's fine
  }

  function sanitizeFilename(name) {
    return String(name)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .trim()
      .slice(0, 200) || 'untitled';
  }
})();
