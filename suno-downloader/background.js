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
  let feedBaseUrl = null;    // captured from page; used as pagination base URL

  // fetchedSongs is ONLY populated by an explicit FETCH_ALL_SONGS call.
  // It is cleared and replaced each time the user clicks "Load All Songs",
  // so it always reflects exactly one workspace — never a mixture of tabs.
  let fetchedSongs = [];

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
        // Passive capture from page — only record the token and feed URL so
        // that FETCH_ALL_SONGS can use them later.  Do NOT add these songs to
        // the download list; they may come from a different workspace tab.
        if (msg.feedBase) feedBaseUrl = msg.feedBase;
        if (msg.token) authToken = msg.token;
        return false;

      case 'DOM_IDS_CAPTURED':
        // DOM scan just helps confirm a Suno page is open; token capture is
        // what matters, so we don't accumulate these ids for downloading.
        if (msg.token) authToken = msg.token;
        return false;

      case 'GET_STATUS':
        sendResponse({
          fetchedCount: fetchedSongs.length,
          hasToken: !!authToken,
          hasFeedUrl: !!feedBaseUrl,
          isDownloading,
          progress,
        });
        return false;

      case 'FETCH_ALL_SONGS':
        if (!authToken) {
          sendResponse({ error: 'No auth token yet — browse your Suno workspace first, then try again.' });
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

  // ── song title extraction ──────────────────────────────────────────────────

  function getSongTitle(clip) {
    // Suno auto-titled songs often have title = "" (empty string, falsy).
    // Check several field names used across Suno API versions.
    return (
      clip.title?.trim() ||
      clip.display_name?.trim() ||
      clip.name?.trim() ||
      clip.metadata?.title?.trim() ||
      clip.metadata?.prompt?.trim()?.slice(0, 120) ||
      clip.id
    );
  }

  function isComplete(clip) {
    if (!clip.status) return true;
    return clip.status === 'complete' || clip.status === 'completed';
  }

  // ── fetch all songs via paginated API ──────────────────────────────────────

  async function fetchAllSongs() {
    // Always start fresh — guarantees only the current workspace is included.
    fetchedSongs = [];
    const seen = new Set();

    const base = feedBaseUrl || 'https://studio-api.suno.ai/api/feed/v2/';
    const pageSize = 20;
    let page = 0;
    let numTotal = null;

    while (true) {
      const url = `${base}?page_size=${pageSize}&page=${page}`;
      let resp;
      try {
        resp = await fetch(url, { headers: { Authorization: authToken } });
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

      const page_clips =
        data.clips || data.songs || data.items ||
        (Array.isArray(data) ? data : []);

      for (const clip of page_clips) {
        if (clip && clip.id && !seen.has(clip.id) && isComplete(clip)) {
          seen.add(clip.id);
          fetchedSongs.push(clip);
        }
      }

      if (numTotal === null) {
        numTotal = data.num_total_results || data.total || 0;
      }

      if (page_clips.length < pageSize) break;
      if (numTotal > 0 && fetchedSongs.length >= numTotal) break;

      page++;
    }

    return fetchedSongs.length;
  }

  // ── download queue ─────────────────────────────────────────────────────────

  async function startDownload() {
    if (isDownloading) return;
    if (fetchedSongs.length === 0) return;

    // Snapshot the list so mid-download refreshes don't interfere.
    const list = [...fetchedSongs];

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

    isDownloading = false;
    progress.done = !stopRequested;
    progress.stopped = stopRequested;
    broadcastProgress();
  }

  async function downloadSong(song) {
    const wavUrl = buildWavUrl(song);
    const safe = sanitizeFilename(getSongTitle(song));

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
