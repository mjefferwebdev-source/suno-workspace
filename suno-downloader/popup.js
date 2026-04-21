(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const statusMsg     = $('status-msg');
  const songCount     = $('song-count');
  const btnLoad       = $('btn-load');
  const btnDownload   = $('btn-download');
  const btnStop       = $('btn-stop');
  const progressSec   = $('progress-section');
  const progressTitle = $('progress-title');
  const barFill       = $('bar-fill');
  const progressSub   = $('progress-sub');
  const doneMsg       = $('done-msg');
  const errorsList    = $('errors-list');

  // ── boot ─────────────────────────────────────────────────────────────────

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'PROGRESS_UPDATE') renderProgress(msg.progress);
  });

  loadStatus();

  async function loadStatus() {
    try {
      const s = await browser.runtime.sendMessage({ type: 'GET_STATUS' });

      if (s.isDownloading) {
        showDownloading();
        renderProgress(s.progress);
        return;
      }

      const n = s.fetchedCount || 0;
      if (!s.hasToken) {
        setStatus('Browse suno.com in a tab, then click Load All Songs.');
      } else if (n > 0) {
        setStatus('Songs loaded — ready to download.');
        setCount(n);
        btnDownload.disabled = false;
      } else {
        setStatus('Click Load All Songs to fetch the workspace you are viewing.');
      }
    } catch (_) {
      setStatus('Could not reach the extension background — try reloading it.');
    }
  }

  // ── Load All Songs ────────────────────────────────────────────────────────

  btnLoad.addEventListener('click', async () => {
    btnLoad.disabled = true;
    btnLoad.textContent = '⏳ Loading…';
    setStatus('Fetching song list from Suno…');
    setCount('');
    btnDownload.disabled = true;
    doneMsg.hidden = true;
    errorsList.hidden = true;

    try {
      const res = await browser.runtime.sendMessage({ type: 'FETCH_ALL_SONGS' });
      if (res.error) {
        setStatus(res.error);
      } else {
        setCount(res.count);
        setStatus(res.count > 0 ? 'Songs loaded — ready to download.' : 'No songs found in this workspace.');
        btnDownload.disabled = res.count === 0;
      }
    } catch (err) {
      setStatus('Error: ' + err.message);
    }

    btnLoad.disabled = false;
    btnLoad.textContent = '↺ Load All Songs';
  });

  // ── Download All ──────────────────────────────────────────────────────────

  btnDownload.addEventListener('click', async () => {
    doneMsg.hidden = true;
    errorsList.hidden = true;
    await browser.runtime.sendMessage({ type: 'START_DOWNLOAD' });
    showDownloading();
  });

  // ── Stop ──────────────────────────────────────────────────────────────────

  btnStop.addEventListener('click', async () => {
    btnStop.disabled = true;
    btnStop.textContent = 'Stopping…';
    await browser.runtime.sendMessage({ type: 'STOP_DOWNLOAD' });
  });

  // ── progress rendering ────────────────────────────────────────────────────

  function showDownloading() {
    progressSec.hidden = false;
    btnDownload.hidden = true;
    btnLoad.disabled   = true;
    btnStop.hidden     = false;
    btnStop.disabled   = false;
    btnStop.textContent = '■ Stop';
  }

  function renderProgress(p) {
    if (!p) return;

    const pct = p.total > 0 ? (p.current / p.total) * 100 : 0;
    barFill.style.width   = pct.toFixed(1) + '%';
    progressTitle.textContent = p.currentTitle || '…';
    progressSub.textContent   = `${p.current} of ${p.total} songs`;

    if (p.done || p.stopped) {
      progressSec.hidden  = false;
      btnStop.hidden       = true;
      btnDownload.hidden   = false;
      btnDownload.disabled = false;
      btnLoad.disabled     = false;

      doneMsg.hidden = false;
      if (p.stopped) {
        doneMsg.style.color = '#facc15';
        doneMsg.textContent = `⚠ Stopped after ${p.current} of ${p.total} songs.`;
      } else {
        doneMsg.style.color = '#4ade80';
        doneMsg.textContent = `✓ All ${p.total} songs downloaded!`;
      }

      if (p.errors && p.errors.length) {
        errorsList.hidden = false;
        errorsList.innerHTML = p.errors.map((e) => `<div>${esc(e)}</div>`).join('');
      }
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  function setStatus(text) { statusMsg.textContent = text; }
  function setCount(n) {
    songCount.textContent = n === '' ? '' : `${n} song${n === 1 ? '' : 's'}`;
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

})();
