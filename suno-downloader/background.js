/**
 * background.js — persistent background script.
 *
 * State:
 *   authToken        – Bearer token captured from the Suno page's own API calls.
 *   recentWorkspaces – Up to 10 { feedBase, name, lastSeen } entries, persisted
 *                      to storage so they survive browser restarts.
 *   fetchedSongs     – Songs loaded for the current download job.
 *
 * Flow:
 *   1. User browses suno.com → content.js → page-inject.js captures every
 *      suno.ai API call → sends AUTH_CAPTURED / SONGS_CAPTURED to here.
 *   2. Each SONGS_CAPTURED records the workspace in recentWorkspaces.
 *   3. User opens popup, picks a workspace → CHOOSE_WORKSPACE message.
 *   4. We fetch all pages of songs for that workspace, then download one by one.
 */
(function () {
  'use strict';

  // ── state ──────────────────────────────────────────────────────────────────

  let authToken = null;
  let recentWorkspaces = [];   // [{ feedBase, name, lastSeen }], max 10, newest first
  let fetchedSongs = [];

  let isDownloading = false;
  let stopRequested = false;
  let progress = makeIdleProgress();

  function makeIdleProgress() {
    return { phase: 'idle', current: 0, total: 0, currentTitle: '', workspaceName: '', done: false, stopped: false, errors: [] };
  }

  // Restore persisted workspaces on startup
  browser.storage.local.get('recentWorkspaces').then(({ recentWorkspaces: saved }) => {
    if (Array.isArray(saved)) recentWorkspaces = saved;
  }).catch(() => {});

  // ── message router ─────────────────────────────────────────────────────────

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {

      case 'AUTH_CAPTURED':
        authToken = msg.token;
        return false;

      case 'SONGS_CAPTURED':
        if (msg.token)    authToken = msg.token;
        if (msg.feedBase) recordWorkspace(msg.feedBase, msg.pageName);
        return false;

      case 'DOM_IDS_CAPTURED':
        return false;  // not used in this flow

      case 'GET_STATUS':
        sendResponse({
          recentWorkspaces,
          hasToken: !!authToken,
          isDownloading,
          progress,
        });
        return false;

      case 'CHOOSE_WORKSPACE':
        if (isDownloading) {
          sendResponse({ error: 'A download is already running — stop it first.' });
          return false;
        }
        if (!authToken) {
          sendResponse({ error: 'No session token yet. Browse suno.com first, then try again.' });
          return false;
        }
        // Kick off async; reply immediately so the popup isn't kept waiting.
        fetchAndDownload(msg.feedBase, msg.name).catch(() => {});
        sendResponse({ ok: true });
        return false;

      case 'STOP_DOWNLOAD':
        stopRequested = true;
        sendResponse({ stopped: true });
        return false;

      default:
        return false;
    }
  });

  // ── workspace history ──────────────────────────────────────────────────────

  function recordWorkspace(feedBase, rawPageName) {
    const name = deriveWorkspaceName(feedBase, rawPageName);
    // Move to front (or insert) keeping max 10
    recentWorkspaces = recentWorkspaces.filter(w => w.feedBase !== feedBase);
    recentWorkspaces.unshift({ feedBase, name, lastSeen: Date.now() });
    recentWorkspaces = recentWorkspaces.slice(0, 10);
    browser.storage.local.set({ recentWorkspaces }).catch(() => {});
  }

  function deriveWorkspaceName(feedBase, pageTitle) {
    if (pageTitle) {
      // Strip "| Suno", "- Suno", "— Suno" branding from page titles
      const cleaned = pageTitle
        .replace(/\s*[\|\-–—]\s*suno.*$/i, '')
        .replace(/^suno[\s\|\-–—]*/i, '')
        .trim();
      if (cleaned) return cleaned;
    }
    // Fallback: interpret the API path
    if (/\/feed\//.test(feedBase))     return 'My Library';
    if (/\/playlist\//.test(feedBase)) return 'Playlist';
    return 'Workspace';
  }

  // ── fetch + download pipeline ──────────────────────────────────────────────

  async function fetchAndDownload(feedBase, name) {
    fetchedSongs = [];
    isDownloading = true;
    stopRequested = false;

    // Phase 1: loading song list
    progress = { phase: 'fetching', current: 0, total: 0, currentTitle: 'Loading song list…', workspaceName: name, done: false, stopped: false, errors: [] };
    broadcastProgress();

    try {
      await fetchAllPages(feedBase);
    } catch (err) {
      progress = { ...progress, phase: 'error', currentTitle: err.message, done: true };
      isDownloading = false;
      broadcastProgress();
      return;
    }

    // Phase 2: download one by one
    const list = [...fetchedSongs];
    progress = { phase: 'downloading', current: 0, total: list.length, currentTitle: '', workspaceName: name, done: false, stopped: false, errors: [] };
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
    progress.done = true;
    progress.stopped = stopRequested;
    broadcastProgress();
  }

  async function fetchAllPages(feedBase) {
    const seen = new Set();
    const pageSize = 20;
    let page = 0;
    let numTotal = null;

    while (true) {
      const url = `${feedBase}?page_size=${pageSize}&page=${page}`;
      let resp;
      try {
        resp = await fetch(url, { headers: { Authorization: authToken } });
      } catch (err) {
        throw new Error(`Network error: ${err.message}`);
      }

      if (resp.status === 401) throw new Error('Session expired — refresh your Suno tab, then try again.');
      if (!resp.ok)           throw new Error(`Suno API returned ${resp.status} — try refreshing suno.com.`);

      const data = await resp.json();
      const clips = data.clips || data.songs || data.items || (Array.isArray(data) ? data : []);

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
  }

  // ── download helpers ───────────────────────────────────────────────────────

  async function downloadSong(song) {
    const wavUrl = song.audio_url
      ? song.audio_url.replace(/\.mp3(\?.*)?$/, '.wav')
      : `https://cdn1.suno.ai/${song.id}.wav`;
    const safe = sanitize(getSongTitle(song));

    try {
      await triggerDownload(wavUrl, `suno-downloads/${safe}.wav`);
    } catch (_) {
      // WAV not available — fall back to MP3
      const mp3 = song.audio_url || `https://cdn1.suno.ai/${song.id}.mp3`;
      await triggerDownload(mp3, `suno-downloads/${safe}.mp3`);
    }
  }

  function triggerDownload(url, filename) {
    return new Promise((resolve, reject) => {
      browser.downloads.download(
        { url, filename, saveAs: false, conflictAction: 'uniquify' },
        (id) => {
          if (browser.runtime.lastError) return reject(new Error(browser.runtime.lastError.message));
          waitForDownload(id, resolve, reject);
        }
      );
    });
  }

  function waitForDownload(id, resolve, reject) {
    const cb = (delta) => {
      if (delta.id !== id) return;
      if (delta.state?.current === 'complete')     { browser.downloads.onChanged.removeListener(cb); resolve(); }
      else if (delta.state?.current === 'interrupted') { browser.downloads.onChanged.removeListener(cb); reject(new Error('interrupted')); }
    };
    browser.downloads.onChanged.addListener(cb);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  function getSongTitle(clip) {
    return (
      clip.title?.trim()                     ||
      clip.display_name?.trim()              ||
      clip.name?.trim()                      ||
      clip.metadata?.title?.trim()           ||
      clip.metadata?.prompt?.trim()?.slice(0, 120) ||
      clip.id
    );
  }

  function isComplete(clip) {
    if (!clip.status) return true;
    return clip.status === 'complete' || clip.status === 'completed';
  }

  function sanitize(name) {
    return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 200) || 'untitled';
  }

  function broadcastProgress() {
    browser.runtime.sendMessage({ type: 'PROGRESS_UPDATE', progress }).catch(() => {});
  }

})();
