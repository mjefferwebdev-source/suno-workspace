(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const statusMsg     = $('status-msg');
  const songCount     = $('song-count');
  const btnRefresh    = $('btn-refresh');
  const btnDownload   = $('btn-download');
  const btnStop       = $('btn-stop');
  const progressSec   = $('progress-section');
  const progressTitle = $('progress-title');
  const barFill       = $('bar-fill');
  const progressSub   = $('progress-sub');
  const doneSec       = $('done-section');
  const doneMsg       = $('done-msg');
  const errorsSec     = $('errors-section');
  const errorsList    = $('errors-list');

  // ── listen for progress broadcasts from background ──────────────────────

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'PROGRESS_UPDATE') renderProgress(msg.progress);
  });

  // ── initial status load ──────────────────────────────────────────────────

  loadStatus();

  async function loadStatus() {
    try {
      const s = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
      applyStatus(s);
    } catch (_) {
      statusMsg.textContent = 'Unable to reach background. Reload the extension.';
    }
  }

  function applyStatus(s) {
    const n = s.fetchedCount || 0;

    if (!s.hasToken) {
      statusMsg.textContent = 'Open suno.com in a tab, then click Load All Songs.';
    } else if (n > 0) {
      statusMsg.textContent = 'Library loaded — ready to download.';
    } else {
      statusMsg.textContent = 'Click "Load All Songs" to fetch your workspace.';
    }

    if (n > 0) {
      songCount.textContent = n + (n === 1 ? ' song' : ' songs');
      btnDownload.disabled = false;
    } else {
      songCount.textContent = '';
      btnDownload.disabled = true;
    }

    if (s.isDownloading) {
      showDownloading();
      renderProgress(s.progress);
    }
  }

  // ── Load All Songs ───────────────────────────────────────────────────────

  btnRefresh.addEventListener('click', async () => {
    btnRefresh.disabled = true;
    btnRefresh.textContent = '⏳ Loading…';
    statusMsg.textContent = 'Fetching your full song library from Suno…';
    songCount.textContent = '';
    btnDownload.disabled = true;
    doneSec.classList.add('hidden');
    errorsSec.classList.add('hidden');

    try {
      const result = await browser.runtime.sendMessage({ type: 'FETCH_ALL_SONGS' });
      if (result.error) {
        statusMsg.textContent = result.error;
      } else {
        const n = result.count;
        statusMsg.textContent = 'Library loaded — ready to download.';
        songCount.textContent = n + (n === 1 ? ' song' : ' songs');
        btnDownload.disabled = n === 0;
      }
    } catch (err) {
      statusMsg.textContent = 'Error: ' + err.message;
    }

    btnRefresh.disabled = false;
    btnRefresh.textContent = '↺ Load All Songs';
  });

  // ── Download All ─────────────────────────────────────────────────────────

  btnDownload.addEventListener('click', async () => {
    doneSec.classList.add('hidden');
    errorsSec.classList.add('hidden');
    await browser.runtime.sendMessage({ type: 'START_DOWNLOAD' });
    showDownloading();
  });

  // ── Stop ─────────────────────────────────────────────────────────────────

  btnStop.addEventListener('click', async () => {
    btnStop.disabled = true;
    btnStop.textContent = 'Stopping…';
    await browser.runtime.sendMessage({ type: 'STOP_DOWNLOAD' });
  });

  // ── UI helpers ────────────────────────────────────────────────────────────

  function showDownloading() {
    progressSec.classList.remove('hidden');
    btnDownload.classList.add('hidden');
    btnStop.classList.remove('hidden');
    btnStop.disabled = false;
    btnStop.textContent = '■ Stop';
    btnRefresh.disabled = true;
  }

  function renderProgress(p) {
    if (!p) return;

    const pct = p.total > 0 ? (p.current / p.total) * 100 : 0;
    barFill.style.width = pct.toFixed(1) + '%';
    progressTitle.textContent = 'Downloading: ' + (p.currentTitle || '…');
    progressSub.textContent = p.current + ' / ' + p.total;

    if (p.done || p.stopped) {
      progressSec.classList.add('hidden');
      btnStop.classList.add('hidden');
      btnDownload.classList.remove('hidden');
      btnDownload.disabled = false;
      btnRefresh.disabled = false;

      doneSec.classList.remove('hidden');
      if (p.stopped) {
        doneMsg.style.color = '#facc15';
        doneMsg.textContent = '⚠ Download stopped at ' + p.current + ' of ' + p.total + ' songs.';
      } else {
        doneMsg.style.color = '#4ade80';
        doneMsg.textContent = '✓ All ' + p.total + ' songs downloaded!';
      }

      if (p.errors && p.errors.length > 0) {
        errorsSec.classList.remove('hidden');
        errorsList.innerHTML = p.errors
          .map((e) => '<div>' + escHtml(e) + '</div>')
          .join('');
      }
    }
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
})();
