(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Views
  const viewWorkspaces = $('view-workspaces');
  const viewDownload   = $('view-download');

  // Workspace-picker elements
  const workspaceList  = $('workspace-list');
  const hint           = $('hint');

  // Download-progress elements
  const dlWorkspace = $('dl-workspace');
  const dlStatus    = $('dl-status');
  const barFill     = $('bar-fill');
  const dlSub       = $('dl-sub');
  const dlDone      = $('dl-done');
  const dlErrors    = $('dl-errors');
  const btnStop     = $('btn-stop');
  const btnBack     = $('btn-back');

  // ── bootstrap ─────────────────────────────────────────────────────────────

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'PROGRESS_UPDATE') applyProgress(msg.progress);
  });

  loadStatus();

  async function loadStatus() {
    try {
      const s = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
      if (s.isDownloading) {
        showDownloadView(s.progress);
      } else {
        showWorkspaceView(s.recentWorkspaces, s.hasToken);
      }
    } catch (_) {
      showHint('Unable to reach the extension background. Try reloading the extension in about:debugging.');
    }
  }

  // ── View: workspace picker ─────────────────────────────────────────────────

  function showWorkspaceView(workspaces, hasToken) {
    viewDownload.classList.add('hidden');
    viewWorkspaces.classList.remove('hidden');
    workspaceList.innerHTML = '';
    hideHint();

    if (!hasToken) {
      showHint('Open <strong>suno.com</strong> in a tab and browse your workspaces — they will appear here.');
      return;
    }

    if (!workspaces || workspaces.length === 0) {
      showHint('No workspaces detected yet. Browse your Suno workspaces and they will appear here automatically.');
      return;
    }

    workspaces.forEach((ws) => {
      const btn = document.createElement('button');
      btn.className = 'workspace-btn';
      btn.innerHTML =
        `<span class="ws-name">${esc(ws.name)}</span>` +
        `<span class="ws-arrow">&#8594;</span>`;
      btn.addEventListener('click', () => onWorkspaceChosen(ws));
      workspaceList.appendChild(btn);
    });
  }

  function showHint(html) {
    hint.innerHTML = html;
    hint.classList.remove('hidden');
  }

  function hideHint() {
    hint.classList.add('hidden');
    hint.innerHTML = '';
  }

  // ── Workspace chosen ──────────────────────────────────────────────────────

  async function onWorkspaceChosen(ws) {
    // Switch to download view immediately so the user sees feedback
    showDownloadView({
      phase: 'fetching',
      workspaceName: ws.name,
      currentTitle: 'Loading song list…',
      current: 0,
      total: 0,
    });

    const result = await browser.runtime.sendMessage({
      type: 'CHOOSE_WORKSPACE',
      feedBase: ws.feedBase,
      name: ws.name,
    });

    if (result.error) {
      dlStatus.textContent = result.error;
      dlStatus.style.color = '#f87171';
      btnStop.classList.add('hidden');
      btnBack.classList.remove('hidden');
    }
  }

  // ── View: download progress ───────────────────────────────────────────────

  function showDownloadView(p) {
    viewWorkspaces.classList.add('hidden');
    viewDownload.classList.remove('hidden');
    applyProgress(p);
  }

  function applyProgress(p) {
    if (!p) return;

    dlWorkspace.textContent = p.workspaceName || '';
    dlStatus.style.color = '';
    dlDone.classList.add('hidden');
    dlErrors.classList.add('hidden');

    switch (p.phase) {

      case 'fetching':
        dlStatus.textContent = 'Loading song list…';
        barFill.style.width = '0%';
        dlSub.textContent = '';
        btnStop.classList.add('hidden');
        btnBack.classList.add('hidden');
        break;

      case 'downloading': {
        const pct = p.total > 0 ? (p.current / p.total) * 100 : 0;
        barFill.style.width = pct.toFixed(1) + '%';
        dlStatus.textContent = p.currentTitle || '…';
        dlSub.textContent = `${p.current} of ${p.total} songs`;
        btnStop.classList.remove('hidden');
        btnBack.classList.add('hidden');

        if (p.done || p.stopped) {
          btnStop.classList.add('hidden');
          btnBack.classList.remove('hidden');
          dlDone.classList.remove('hidden');
          if (p.stopped) {
            dlDone.style.color = '#facc15';
            dlDone.textContent = `⚠ Stopped after ${p.current} of ${p.total} songs.`;
          } else {
            dlDone.style.color = '#4ade80';
            dlDone.textContent = `✓ All ${p.total} songs downloaded!`;
          }
          if (p.errors && p.errors.length) {
            dlErrors.classList.remove('hidden');
            dlErrors.innerHTML = p.errors.map((e) => `<div>${esc(e)}</div>`).join('');
          }
        }
        break;
      }

      case 'error':
        dlStatus.textContent = p.currentTitle || 'An error occurred.';
        dlStatus.style.color = '#f87171';
        barFill.style.width = '0%';
        dlSub.textContent = '';
        btnStop.classList.add('hidden');
        btnBack.classList.remove('hidden');
        break;
    }
  }

  // ── Buttons ───────────────────────────────────────────────────────────────

  btnStop.addEventListener('click', async () => {
    btnStop.disabled = true;
    btnStop.textContent = 'Stopping…';
    await browser.runtime.sendMessage({ type: 'STOP_DOWNLOAD' });
  });

  btnBack.addEventListener('click', () => loadStatus());

  // ── helpers ───────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

})();
