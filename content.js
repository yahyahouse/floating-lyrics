// Lyrics overlay + sync & recording logic on music.youtube.com
(() => {
  'use strict';
  if (window.__ytmflLoaded) return;
  window.__ytmflLoaded = true;

  const DEFAULTS = { enabled: true, useLrclib: true, aiEnabled: true, fontSize: 18, transparency: 22, autoHide: true };

  let settings = { ...DEFAULTS };
  let ui = null;
  let track = null;          // { videoId, title, artist, album, duration }
  let lyrics = null;         // { source, lines:[{t,text}], estimated, footer }
  let activeIndex = -1;
  let rec = { state: 'idle' }; // idle | need-permission | need-restart | recording | paused | transcribing
  let lastTime = 0;
  let loadToken = 0;
  let boundVideo = null;
  let pendingVid = null;
  let pendingSince = 0;

  const getVideo = () => document.querySelector('video');
  // YT Music gapless: the next song can continue on the same <video> element, so
  // video.currentTime does not restart at 0. timeBase = video.currentTime - song position.
  let timeBase = 0;
  const songTime = (v) => Math.max(0, v.currentTime - timeBase);
  const seekSong = (v, t) => { v.currentTime = Math.max(0, t) + timeBase; };

  // Extension reloaded/updated → the old script in this tab is orphaned, every chrome.* API throws
  const orphaned = () => { try { return !chrome.runtime?.id; } catch { return true; } };
  let timers = [];
  function teardown() {
    timers.forEach(clearInterval);
    timers = [];
    if (boundVideo) {
      boundVideo.removeEventListener('timeupdate', onTimeUpdate);
      boundVideo.removeEventListener('pause', onPauseLike);
      boundVideo.removeEventListener('waiting', onPauseLike);
      boundVideo.removeEventListener('playing', onPlaying);
      boundVideo = null;
    }
    ui?.destroy();
    window.__ytmflLoaded = false;
  }

  function bg(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e?.message || e) }));
    } catch (e) {
      return Promise.resolve({ error: String(e?.message || e) });
    }
  }

  // ---------- Bridge to main-world.js ----------
  let reqId = 0;
  const pending = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__ytmfl !== 'res') return;
    const done = pending.get(e.data.id);
    if (!done) return;
    pending.delete(e.data.id);
    done(e.data.result);
  });
  function mainWorld(action, payload = {}, timeout = 12000) {
    return new Promise((resolve) => {
      const id = ++reqId;
      pending.set(id, resolve);
      window.postMessage({ __ytmfl: 'req', id, action, payload }, '*');
      setTimeout(() => {
        if (pending.delete(id)) resolve({ error: 'timeout' });
      }, timeout);
    });
  }

  // ---------- Overlay ----------
  const ICON_PIP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor" stroke="none"/></svg>';
  const ICON_SYNC = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.9-3.9L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.9 3.9L20 15"/><path d="M20 20v-5h-5"/></svg>';
  const ICON_EDIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  const ICON_AI = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/></svg>';
  const ICON_MIN ='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 12h12"/></svg>';

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
button { all: unset; cursor: pointer; }
.card {
  --fs: 18px;
  --bg-a: .78; /* background opacity, set from the transparency setting */
  position: relative;
  width: 340px; height: min(420px, 60vh); min-width: 240px; min-height: 150px;
  display: flex; flex-direction: column; overflow: hidden; resize: both;
  background: rgba(14, 14, 16, var(--bg-a)); color: #fff;
  border: 1px solid rgba(255, 255, 255, calc(.08 * var(--bg-a) / .78)); border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, calc(.45 * var(--bg-a)));
  backdrop-filter: blur(calc(26px * var(--bg-a))) saturate(140%); -webkit-backdrop-filter: blur(calc(26px * var(--bg-a))) saturate(140%);
  font-family: "YouTube Sans", Roboto, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
  transition: background-color .25s, border-color .25s, box-shadow .25s;
}
/* Auto-hide: without hover only the lyrics show; menu & background appear when the cursor enters */
.card.autohide:not(:hover) {
  background-color: transparent; border-color: transparent; box-shadow: none;
  backdrop-filter: none; -webkit-backdrop-filter: none;
}
.head, .foot { transition: opacity .25s; }
.card.autohide:not(:hover) .head, .card.autohide:not(:hover) .foot { opacity: 0; }
/* Thin / hidden background → add text shadow so lyrics stay readable over the video */
.card.clear :is(.head, .line, .nowline, .state, .foot),
.card.autohide:not(:hover) :is(.line, .nowline, .state) { text-shadow: 0 1px 3px rgba(0, 0, 0, .9), 0 0 12px rgba(0, 0, 0, .6); }
.card.clear .line, .card.autohide:not(:hover) .line { color: rgba(255, 255, 255, .55); }
.card.clear .line.past, .card.autohide:not(:hover) .line.past { color: rgba(255, 255, 255, .7); }
.card.clear .line.active, .card.autohide:not(:hover) .line.active { color: #fff; }
.card.min { height: auto !important; min-height: 0; min-width: 180px; resize: horizontal; }
.card.min .view, .card.min .foot { display: none; }
.head {
  display: flex; align-items: center; gap: 10px; flex: none;
  padding: 11px 10px 10px 16px; cursor: grab; user-select: none;
  border-bottom: 1px solid rgba(255, 255, 255, .06);
}
.card.min .head { border-bottom: 0; }
.head.dragging { cursor: grabbing; }
.meta { flex: 1; min-width: 0; }
.title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { display: flex; align-items: center; gap: 6px; margin-top: 2px; min-width: 0; font-size: 11.5px; color: rgba(255, 255, 255, .55); }
.artist { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge { flex: none; font-size: 10px; letter-spacing: .03em; padding: 1px 7px; border-radius: 99px; background: rgba(255, 255, 255, .1); color: rgba(255, 255, 255, .75); }
.badge:empty { display: none; }
.actions { display: flex; gap: 2px; flex: none; }
.actions button {
  width: 26px; height: 26px; display: grid; place-items: center; border-radius: 8px;
  font-size: 11px; font-weight: 600; color: rgba(255, 255, 255, .55);
}
.actions button:hover { background: rgba(255, 255, 255, .08); color: #fff; }
.actions [data-act="sync"] { display: none; }
.actions [data-act="sync"].show { display: grid; }
.actions [data-act="sync"].busy { color: #ff4e45; cursor: default; }
.actions [data-act="sync"].busy svg { animation: spin 1.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.mini { position: absolute; left: 0; bottom: 0; height: 2px; width: 0; background: #ff4e45; transition: width .3s linear; pointer-events: none; }
.mini.paused { background: rgba(255, 255, 255, .4); }
.actions [data-act="edit"], .actions [data-act="recreate"] { display: none; }
.actions [data-act="edit"].show, .actions [data-act="recreate"].show { display: grid; }
.editor { position: absolute; inset: 0; display: none; flex-direction: column; gap: 8px; padding: 12px 14px; background: #0e0e10; }
.editor.show { display: flex; }
.editor textarea {
  flex: 1; min-height: 0; resize: none; outline: none; padding: 10px 12px; border-radius: 10px;
  background: rgba(255, 255, 255, .05); border: 1px solid rgba(255, 255, 255, .1); color: #fff;
  font: 13px/1.55 inherit; font-family: inherit;
}
.editor textarea:focus { border-color: rgba(255, 255, 255, .3); }
.editor .hint { font-size: 11px; line-height: 1.45; color: rgba(255, 255, 255, .45); }
.editor .btns { display: flex; gap: 6px; align-items: center; }
.editor .btns button { padding: 6px 12px; border-radius: 99px; font-size: 12px; font-weight: 600; }
.editor .del { margin-right: auto; color: #ff8a80; padding-left: 2px !important; }
.editor .del[hidden] { display: none; }
.editor .sec { border: 1px solid rgba(255, 255, 255, .15); color: rgba(255, 255, 255, .8); }
.editor .pri { background: #fff; color: #000; }
.view { position: relative; flex: 1; min-height: 0; }
.scroller {
  position: relative; height: 100%; overflow-y: auto; padding: 0 18px;
  container-type: size; scrollbar-width: none;
  -webkit-mask-image: linear-gradient(transparent, #000 16%, #000 84%, transparent);
  mask-image: linear-gradient(transparent, #000 16%, #000 84%, transparent);
}
.scroller::-webkit-scrollbar { display: none; }
.lines { padding: 42cqh 0; }
.line {
  font-size: var(--fs); line-height: 1.35; font-weight: 600; padding: 5px 0;
  color: rgba(255, 255, 255, .3); cursor: pointer; transition: color .25s ease;
  overflow-wrap: anywhere;
}
.line.past { color: rgba(255, 255, 255, .48); }
.line.active { color: #fff; }
.line:hover { color: rgba(255, 255, 255, .8); }
.state {
  position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; padding: 24px; text-align: center; background: inherit;
}
.state.show { display: flex; }
.state .t { font-size: 14px; font-weight: 600; color: rgba(255, 255, 255, .9); display: flex; align-items: center; gap: 8px; }
.state .s { font-size: 12px; line-height: 1.5; color: rgba(255, 255, 255, .55); max-width: 280px; }
.state .bar { width: 70%; height: 3px; border-radius: 3px; background: rgba(255, 255, 255, .1); overflow: hidden; }
.state .bar i { display: block; height: 100%; width: 0; background: #fff; transition: width .3s linear; }
.state .cta { margin-top: 4px; padding: 7px 14px; border-radius: 99px; background: #fff; color: #000; font-size: 12px; font-weight: 600; }
.state .cta:hover { background: rgba(255, 255, 255, .85); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #ff4e45; animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .3; } }
.nowline { display: none; }
.card.min .nowline {
  display: block; padding: 0 16px 12px; font-size: var(--fs); line-height: 1.35; font-weight: 600;
  overflow-wrap: anywhere; animation: fadein .25s ease;
}
.card.min .nowline:empty { display: none; }
.nowline.next { color: rgba(255, 255, 255, .45); }
@keyframes fadein { from { opacity: 0; transform: translateY(3px); } }
.foot { flex: none; padding: 6px 16px 9px; font-size: 10.5px; color: rgba(255, 255, 255, .35); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.foot:empty { display: none; }
.toast {
  position: absolute; left: 50%; bottom: 14px; transform: translate(-50%, 8px); opacity: 0; pointer-events: none;
  max-width: calc(100% - 28px); padding: 7px 12px; border-radius: 10px; font-size: 12px;
  background: rgba(255, 255, 255, .95); color: #000; transition: opacity .2s, transform .2s;
}
.toast.show { opacity: 1; transform: translate(-50%, 0); }
:host([data-pip]) .card { width: 100vw !important; height: 100vh !important; border: 0; border-radius: 0; resize: none; background: #0e0e10; box-shadow: none; }
:host([data-pip]) .head { cursor: default; }
:host([data-pip]) [data-act="min"] { display: none; }
`;

  function createOverlay(cb) {
    const host = document.createElement('div');
    host.id = 'ytmfl-host';
    host.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
<div class="card">
  <div class="head">
    <div class="meta">
      <div class="title">Floating Lyrics</div>
      <div class="sub"><span class="artist"></span><span class="badge"></span></div>
    </div>
    <div class="actions">
      <button data-act="smaller" title="Smaller text">A-</button>
      <button data-act="bigger" title="Bigger text">A+</button>
      <button data-act="edit" title="Enter / edit lyrics yourself">${ICON_EDIT}</button>
      <button data-act="sync" title="Match lyric timing with AI">${ICON_SYNC}</button>
      <button data-act="recreate" title="Recreate lyrics with AI">${ICON_AI}</button>
      <button data-act="pip" title="Float above all windows">${ICON_PIP}</button>
      <button data-act="min" title="Minimize">${ICON_MIN}</button>
    </div>
  </div>
  <div class="view">
    <div class="scroller"><div class="lines"></div></div>
    <div class="state"></div>
    <div class="editor">
      <textarea spellcheck="false" placeholder="Paste or type lyrics here, one lyric line per row."></textarea>
      <div class="hint">Plain text: timing is estimated, then can be fixed with the ⟳ button or "Tap sync". LRC format ([01:23.45] text) is synced right away.</div>
      <div class="btns">
        <button class="del">Delete manual lyrics</button>
        <button class="sec" data-ed="tap" title="Plays from the start; press space / click as each line begins">Tap sync</button>
        <button class="sec" data-ed="cancel">Cancel</button>
        <button class="pri" data-ed="save">Save</button>
      </div>
    </div>
  </div>
  <div class="nowline"></div>
  <div class="foot"></div>
  <div class="toast"></div>
  <div class="mini"></div>
</div>`;

    const q = (s) => root.querySelector(s);
    const card = q('.card');
    const head = q('.head');
    const scroller = q('.scroller');
    const linesEl = q('.lines');
    const stateEl = q('.state');
    const footEl = q('.foot');
    const nowEl = q('.nowline');
    const toastEl = q('.toast');
    let lineEls = [];
    let userScrollUntil = 0;
    let pipWin = null;
    let pos = { x: 0, y: 0 };
    let toastTimer = 0;
    let saveTimer = 0;

    function place(x, y) {
      const w = card.offsetWidth || 340;
      x = Math.min(Math.max(8, x), Math.max(8, innerWidth - w - 8));
      y = Math.min(Math.max(8, y), Math.max(8, innerHeight - 56));
      pos = { x, y };
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
    }

    // Drag
    head.addEventListener('pointerdown', (e) => {
      if (pipWin || e.button !== 0 || e.target.closest('button')) return;
      const r = host.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      head.classList.add('dragging');
      const move = (ev) => place(ev.clientX - dx, ev.clientY - dy);
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
        head.classList.remove('dragging');
        cb.onSaveUi({ x: pos.x, y: pos.y });
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });

    addEventListener('resize', () => { if (!pipWin) place(pos.x, pos.y); });

    // Normal size (w, h) and minimized width (mw) are stored separately
    let size = { w: 0, h: 0, mw: 0 };
    function applySize() {
      const min = card.classList.contains('min');
      const w = min ? size.mw || size.w : size.w;
      card.style.width = w ? `${w}px` : '';
      card.style.height = !min && size.h ? `${size.h}px` : '';
    }

    // Save size after resizing
    new ResizeObserver(() => {
      if (pipWin) return;
      const patch = card.classList.contains('min')
        ? { mw: card.offsetWidth }
        : { w: card.offsetWidth, h: card.offsetHeight };
      Object.assign(size, patch);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => cb.onSaveUi(patch), 400);
    }).observe(card);

    // Manual scrolling pauses auto-scroll for a moment
    const holdScroll = () => { userScrollUntil = Date.now() + 3000; };
    scroller.addEventListener('wheel', holdScroll, { passive: true });
    scroller.addEventListener('touchmove', holdScroll, { passive: true });

    linesEl.addEventListener('click', (e) => {
      const el = e.target.closest('.line');
      if (el) cb.onSeek(Number(el.dataset.i));
    });

    q('.actions').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'smaller') cb.onFont(-1);
      else if (act === 'bigger') cb.onFont(1);
      else if (act === 'pip') togglePip();
      else if (act === 'edit') cb.onEdit();
      else if (act === 'recreate') cb.onRecreate();
      else if (act === 'sync') { if (!b.classList.contains('busy')) cb.onSync(); }
      else if (act === 'min') {
        card.classList.toggle('min');
        applySize();
        place(pos.x, pos.y);
        cb.onSaveUi({ min: card.classList.contains('min') });
      }
    });

    // Lyrics editor. Don't let YouTube Music shortcuts (space, j/k, etc.) fire while typing.
    const editor = q('.editor');
    for (const ev of ['keydown', 'keyup', 'keypress']) editor.addEventListener(ev, (e) => e.stopPropagation());
    editor.querySelector('[data-ed="cancel"]').addEventListener('click', () => editor.classList.remove('show'));
    editor.querySelector('[data-ed="save"]').addEventListener('click', () => cb.onEditorSave(editor.querySelector('textarea').value));
    editor.querySelector('.del').addEventListener('click', () => cb.onEditorDelete());
    editor.querySelector('[data-ed="tap"]').addEventListener('click', () => cb.onTapStart(editor.querySelector('textarea').value));

    async function togglePip() {
      if (pipWin) { pipWin.close(); return; }
      if (!('documentPictureInPicture' in window)) {
        api.toast('This browser does not support Document Picture-in-Picture yet.');
        return;
      }
      try {
        pipWin = await window.documentPictureInPicture.requestWindow({
          width: Math.max(320, card.offsetWidth),
          height: Math.max(360, card.offsetHeight)
        });
      } catch (err) {
        api.toast('Failed to open the floating window.');
        pipWin = null;
        return;
      }
      pipWin.document.title = 'Lyrics';
      pipWin.document.body.style.cssText = 'margin:0;background:#0e0e10;overflow:hidden;';
      host.setAttribute('data-pip', '');
      host.style.cssText = 'position:static;display:block;width:100vw;height:100vh;';
      pipWin.document.body.append(host);
      pipWin.addEventListener('pagehide', () => {
        pipWin = null;
        host.removeAttribute('data-pip');
        host.style.cssText = 'position:fixed;z-index:2147483647;';
        document.documentElement.append(host);
        place(pos.x, pos.y);
        cb.onPipClosed();
      }, { once: true });
      api.scrollToActive(true);
    }

    function scrollTo(i, instant) {
      const el = lineEls[i];
      if (!el) return;
      const top = el.offsetTop - scroller.clientHeight / 2 + el.offsetHeight / 2;
      scroller.scrollTo({ top, behavior: instant ? 'auto' : 'smooth' });
    }

    let current = -1;
    // Minimized mode: show the line being sung (or the first line, dimmed, before it starts)
    function setNowLine(i) {
      const el = lineEls[i] || (i < 0 ? lineEls[0] : null);
      const text = el?.textContent || '';
      if (nowEl.textContent === text) return;
      nowEl.textContent = text;
      nowEl.classList.toggle('next', i < 0);
      // restart the fade animation
      nowEl.style.animation = 'none';
      void nowEl.offsetWidth;
      nowEl.style.animation = '';
    }

    const api = {
      mount() { document.documentElement.append(host); },
      destroy() {
        pipWin?.close();
        host.remove();
      },
      isPip: () => !!pipWin,
      applyUi(u = {}) {
        size = { w: u.w || 0, h: u.h || 0, mw: u.mw || 0 };
        card.classList.toggle('min', !!u.min);
        applySize();
        requestAnimationFrame(() => place(u.x ?? innerWidth - card.offsetWidth - 24, u.y ?? 88));
      },
      setVisible(v) { if (!pipWin) host.style.display = v ? '' : 'none'; },
      setFont(px) { card.style.setProperty('--fs', `${px}px`); },
      setAutoHide(on) { card.classList.toggle('autohide', !!on); },
      // pct: 0 = solid background, 100 = fully see-through
      setTransparency(pct) {
        const a = 1 - Math.min(100, Math.max(0, Number(pct) || 0)) / 100;
        card.style.setProperty('--bg-a', a.toFixed(2));
        card.classList.toggle('clear', a < 0.5);
      },
      setTrack(t) {
        q('.title').textContent = t?.title || 'Floating Lyrics';
        q('.artist').textContent = t?.artist || '';
      },
      setBadge(text) { q('.badge').textContent = text || ''; },
      setFoot(text) { footEl.textContent = text || ''; },
      setLines(lines) {
        const frag = document.createDocumentFragment();
        lineEls = lines.map((l, i) => {
          const d = document.createElement('div');
          d.className = 'line';
          d.dataset.i = String(i);
          d.textContent = l.text;
          frag.append(d);
          return d;
        });
        linesEl.replaceChildren(frag);
        current = -1;
        setNowLine(-1);
        scroller.scrollTop = 0;
        stateEl.classList.remove('show');
      },
      clearLines() {
        linesEl.replaceChildren();
        lineEls = [];
        current = -1;
        setNowLine(-1);
      },
      setActive(i) {
        for (let k = 0; k < lineEls.length; k++) {
          lineEls[k].classList.toggle('active', k === i);
          lineEls[k].classList.toggle('past', k < i);
        }
        current = i;
        setNowLine(i);
        if (i >= 0 && Date.now() > userScrollUntil) scrollTo(i, false);
      },
      scrollToActive(instant) { if (current >= 0) scrollTo(current, instant); },
      showState({ title, sub = '', progress = null, live = false, action = null }) {
        stateEl.replaceChildren();
        const t = document.createElement('div');
        t.className = 't';
        if (live) {
          const dot = document.createElement('span');
          dot.className = 'dot';
          t.append(dot);
        }
        t.append(document.createTextNode(title));
        stateEl.append(t);
        if (sub) {
          const s = document.createElement('div');
          s.className = 's';
          s.textContent = sub;
          stateEl.append(s);
        }
        if (progress !== null) {
          const bar = document.createElement('div');
          bar.className = 'bar';
          bar.innerHTML = '<i></i>';
          bar.firstChild.style.width = `${Math.round(progress * 100)}%`;
          stateEl.append(bar);
        }
        if (action) {
          const b = document.createElement('button');
          b.className = 'cta';
          b.textContent = action.label;
          b.addEventListener('click', action.onClick);
          stateEl.append(b);
        }
        stateEl.classList.add('show');
      },
      setEditVisible(v) { q('[data-act="edit"]').classList.toggle('show', !!v); },
      openEditor(text, hasManual) {
        const ed = q('.editor');
        ed.querySelector('textarea').value = text || '';
        ed.querySelector('.del').hidden = !hasManual;
        ed.classList.add('show');
        setTimeout(() => ed.querySelector('textarea').focus(), 0);
      },
      closeEditor() { q('.editor').classList.remove('show'); },
      setRecreateVisible(v) { q('[data-act="recreate"]').classList.toggle('show', !!v); },
      setSyncVisible(v) { q('[data-act="sync"]').classList.toggle('show', !!v); },
      // progress: 0..1 while AI is listening, null when done/cancelled
      setSyncBusy(progress, paused = false) {
        const btn = q('[data-act="sync"]');
        const mini = q('.mini');
        const busy = progress !== null && progress !== undefined;
        btn.classList.toggle('busy', busy);
        btn.title = busy ? 'AI is listening to match the timing…' : 'Match lyric timing with AI';
        if (busy) btn.classList.add('show');
        mini.classList.toggle('paused', !!paused);
        mini.style.width = busy ? `${Math.min(100, Math.max(0, progress * 100)).toFixed(1)}%` : '0';
      },
      setProgress(p) {
        const i = stateEl.querySelector('.bar i');
        if (i) i.style.width = `${Math.min(100, Math.max(0, p * 100)).toFixed(1)}%`;
      },
      toast(msg) {
        toastEl.textContent = msg;
        toastEl.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
      }
    };
    return api;
  }

  // ---------- Lyrics ----------
  // lyrics: { base: 'YT Music'|'LRCLIB'|'AI', lines, estimated, aiSynced, footer }
  let syncCache = null; // { times, n, base } — timestamps only, lyric text is not stored
  const syncJobs = new Map(); // videoId -> { rows, base } being synced by AI

  function splitRows(text) {
    return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  function estimateLines(text, duration) {
    const rows = splitRows(text);
    if (!rows.length) return [];
    const d = duration || 180;
    const start = d * 0.06;
    const span = d * 0.88;
    return rows.map((r, i) => ({ t: start + (span * i) / rows.length, text: r }));
  }

  function withSync(l) {
    if (l.base === 'AI' || !syncCache) return l;
    if (syncCache.base !== l.base || syncCache.n !== l.lines.length) return l;
    return {
      ...l,
      estimated: false,
      aiSynced: true,
      lines: l.lines.map((x, i) => ({ ...x, t: syncCache.times[i] }))
    };
  }

  function badgeFor(l) {
    if (l.aiSynced) return `${l.base} · AI sync`;
    if (l.estimated) return `${l.base} · estimated`;
    return l.base;
  }

  // ---------- Manual lyrics (user input) ----------
  let editingVid = null;

  function parseLrcText(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const tags = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
      if (!tags.length) continue;
      const body = raw.replace(/\[[^\]]*\]/g, '').trim() || '♪';
      for (const m of tags) out.push({ t: Number(m[1]) * 60 + Number(m[2].replace(':', '.')), text: body });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  function manualLyrics(text, duration) {
    const timed = parseLrcText(text);
    if (timed.length >= 2) return { base: 'Manual', lines: timed };
    return { base: 'Manual', estimated: true, lines: estimateLines(text, duration) };
  }

  const fmtTime = (t) => {
    const m = Math.floor(t / 60);
    const sec = (t - m * 60).toFixed(2).padStart(5, '0');
    return `${String(m).padStart(2, '0')}:${sec}`;
  };

  function openEditor() {
    if (!track) return;
    editingVid = track.videoId;
    let text = '';
    if (lyrics?.lines?.length) {
      // If timing is already right, fill in LRC format so the timing is saved too
      text = lyrics.estimated
        ? lyrics.lines.map((l) => l.text).join('\n')
        : lyrics.lines.map((l) => `[${fmtTime(l.t)}] ${l.text}`).join('\n');
    }
    ui.openEditor(text, lyrics?.base === 'Manual');
  }

  async function dropManualSync(vid) {
    const key = `sync:${vid}`;
    const cur = (await chrome.storage.local.get(key))[key];
    if (cur?.base === 'Manual') await chrome.storage.local.remove(key);
    if (track?.videoId === vid && syncCache?.base === 'Manual') syncCache = null;
  }

  async function saveManual(text) {
    const vid = editingVid || track?.videoId;
    if (!vid) return;
    text = String(text || '').trim();
    if (!text) { ui.toast('Lyrics are empty.'); return; }
    await chrome.storage.local.set({ [`user:${vid}`]: { text, updatedAt: Date.now() } });
    await dropManualSync(vid);
    ui.closeEditor();
    editingVid = null;
    if (track?.videoId !== vid) { ui.toast('Lyrics saved for the previous song.'); return; }
    if (rec.videoId === vid && isRecording()) cancelRecording();
    rec = { state: 'idle' };
    const l = manualLyrics(text, track.duration);
    show(l);
    ui.toast(l.estimated ? 'Lyrics saved. Press ⟳ to fix the timing.' : 'Lyrics saved.');
  }

  async function deleteManual() {
    const vid = editingVid || track?.videoId;
    if (!vid) return;
    await chrome.storage.local.remove(`user:${vid}`);
    await dropManualSync(vid);
    ui.closeEditor();
    editingVid = null;
    ui.toast('Manual lyrics deleted.');
    if (track?.videoId === vid) loadTrack({ ...track });
  }

  // ---------- Tap sync: user presses space / clicks as each line begins ----------
  const TAP_LAG = 0.1; // compensates for reaction time
  let tap = null; // { videoId, rows, times }

  function startTap(text) {
    if (!track) return;
    if (isRecording() || rec.state === 'transcribing') return ui.toast('Wait for the AI to finish first.');
    const rows = splitRows(String(text || '').replace(/\[[^\]]*\]/g, ''));
    if (rows.length < 2) return ui.toast('Enter the lyrics first, one lyric line per row.');
    const v = getVideo();
    if (!v) return;
    ui.closeEditor();
    editingVid = null;
    tap = { videoId: track.videoId, rows, times: [] };
    lyrics = null;
    activeIndex = -1;
    ui.setLines(rows.map((r) => ({ text: r })));
    ui.setActive(-1);
    ui.setSyncVisible(false);
    ui.setBadge('Tap sync');
    renderTap();
    seekSong(v, 0);
    lastTime = 0;
    if (v.paused) v.play().catch(() => {});
  }

  function renderTap() {
    ui.setFoot(`Space / click = line starts · ⌫ undo · Esc cancel — ${tap.times.length}/${tap.rows.length}`);
  }

  function tapNext() {
    const v = getVideo();
    if (!tap || !v) return;
    const t = Math.max(0, songTime(v) - TAP_LAG);
    // After seeking back → drop taps ahead of the current position
    while (tap.times.length && tap.times[tap.times.length - 1] > t) tap.times.pop();
    if (tap.times.length >= tap.rows.length) return;
    tap.times.push(t);
    ui.setActive(tap.times.length - 1);
    renderTap();
    if (tap.times.length === tap.rows.length) finishTap();
  }

  function undoTap() {
    if (!tap?.times.length) return;
    tap.times.pop();
    ui.setActive(tap.times.length - 1);
    renderTap();
  }

  function cancelTap(msg) {
    if (!tap) return;
    const vid = tap.videoId;
    tap = null;
    if (msg) ui.toast(msg);
    if (track?.videoId === vid) loadTrack({ ...track });
  }

  async function finishTap() {
    if (!tap) return;
    const { videoId: vid, rows, times } = tap;
    tap = null;
    if (!times.length) return cancelTap();
    // Untapped lines (song ended first) → place 2 seconds after the previous line
    const all = rows.map((_, i) => times[i] ?? times[times.length - 1] + (i - times.length + 1) * 2);
    const lrc = rows.map((r, i) => `[${fmtTime(all[i])}] ${r}`).join('\n');
    editingVid = vid;
    await saveManual(lrc);
  }

  function onTapKey(e) {
    if (!tap || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target?.closest?.('input, textarea, [contenteditable="true"]')) return;
    let handled = true;
    if (e.code === 'Space' || e.code === 'Enter') { if (!e.repeat) tapNext(); }
    else if (e.code === 'Backspace') undoTap();
    else if (e.code === 'Escape') cancelTap('Tap sync cancelled.');
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  window.addEventListener('keydown', onTapKey, true);

  function show(l) {
    l = withSync(l);
    lyrics = l;
    activeIndex = -1;
    ui.setLines(l.lines);
    ui.setBadge(badgeFor(l));
    ui.setFoot(l.footer || '');
    if (!isRecording()) ui.setSyncVisible(l.base !== 'AI' && l.lines.length > 0);
    syncNow();
  }

  function indexAt(t) {
    const ls = lyrics.lines;
    let lo = 0;
    let hi = ls.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ls[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function syncNow() {
    const v = getVideo();
    if (!v || !lyrics || !lyrics.lines.length) return;
    const i = indexAt(songTime(v) + 0.2);
    if (i !== activeIndex) {
      activeIndex = i;
      ui.setActive(i);
    }
  }

  async function loadTrack(t) {
    if (orphaned()) return teardown();
    if (tap && tap.videoId !== t.videoId) { tap = null; ui.toast('Tap sync cancelled because the song changed.'); }
    if (tap) return;
    const token = ++loadToken;
    track = t;
    lyrics = null;
    activeIndex = -1;
    // Keep track of a transcription still running for this song (repeat, regenerate, settings change)
    if (!(rec.state === 'transcribing' && rec.videoId === t.videoId)) rec = { state: 'idle' };
    ui.clearLines();
    ui.setTrack(t);
    ui.setBadge('');
    ui.setFoot('');
    ui.setSyncVisible(false);
    ui.setSyncBusy(null);
    ui.showState({ title: 'Searching for lyrics…' });

    ui.setEditVisible(true);
    ui.setRecreateVisible(true);
    const keys = [`ai:${t.videoId}`, `sync:${t.videoId}`, `user:${t.videoId}`, `pref:${t.videoId}`];
    const store = await chrome.storage.local.get(keys);
    if (token !== loadToken) return;
    const cached = store[keys[0]];
    syncCache = store[keys[1]] || null;

    // 0. User-entered lyrics always win
    if (store[keys[2]]?.text) return show(manualLyrics(store[keys[2]].text, t.duration));
    // User asked AI to recreate the lyrics → use the AI result even if YT Music has lyrics
    if (store[keys[3]] === 'ai' && cached?.lines?.length) return show({ ...cached, base: 'AI' });

    // 1. YouTube Music's own lyrics
    // An error (ytcfg not ready, timeout, HTTP) differs from "no lyrics" → retry first
    let ytm = await mainWorld('lyrics', { videoId: t.videoId });
    for (let i = 0; ytm?.error && i < 2; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      if (token !== loadToken) return;
      ytm = await mainWorld('lyrics', { videoId: t.videoId });
    }
    if (token !== loadToken) return;
    if (ytm?.found && ytm.synced) {
      return show({ base: 'YT Music', lines: ytm.lines, footer: ytm.footer });
    }

    if (ytm?.found) {
      const est = { base: 'YT Music', estimated: true, lines: estimateLines(ytm.text, t.duration), footer: ytm.footer };
      // Already synced by AI → use it right away
      if (syncCache?.base === 'YT Music' && syncCache.n === est.lines.length) return show(est);
      if (settings.useLrclib) {
        const lr = await bg({ type: 'lrclib', track: t });
        if (token !== loadToken) return;
        if (lr?.synced && lr.lines?.length) return show({ base: 'LRCLIB', lines: lr.lines });
      }
      return show(est);
    }

    // 2. Previously generated AI lyrics
    if (cached?.lines?.length) return show({ ...cached, base: 'AI' });

    let lrPlain = null;
    if (settings.useLrclib) {
      const lr = await bg({ type: 'lrclib', track: t });
      if (token !== loadToken) return;
      if (lr?.synced && lr.lines?.length) return show({ base: 'LRCLIB', lines: lr.lines });
      if (lr?.found && lr.text) lrPlain = lr.text;
    }

    // 3. Fallback AI
    if (rec.state === 'transcribing' && rec.mode === 'generate') {
      return ui.showState({ title: 'AI is writing the lyrics…', sub: 'Lyrics will appear automatically when done.', live: true });
    }
    if (lrPlain && ytm?.error) return show({ base: 'LRCLIB', estimated: true, lines: estimateLines(lrPlain, t.duration) });
    // Failing to fetch from YT Music ≠ no lyrics → don't regenerate with AI right away
    if (ytm?.error) {
      return ui.showState({
        title: 'Failed to fetch YT Music lyrics',
        sub: 'Try again, or press ✦ to create lyrics with AI.',
        action: { label: 'Try again', onClick: () => track && loadTrack({ ...track }) }
      });
    }
    if (settings.aiEnabled) return startAIFlow();
    if (lrPlain) return show({ base: 'LRCLIB', estimated: true, lines: estimateLines(lrPlain, t.duration) });
    ui.showState({ title: 'Lyrics not available', sub: 'Enable the AI fallback in the extension settings to create lyrics.' });
  }

  // ---------- Aligning lyric text with what the AI heard ----------
  const CJK = /([぀-ヿ㐀-鿿豈-﫿가-힯])/g;

  function tokenize(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(CJK, ' $1 ')
      .replace(/['’`]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter(Boolean);
  }

  function similarity(a, b) {
    if (a === b) return 1;
    const la = a.length;
    const lb = b.length;
    const mx = Math.max(la, lb);
    if (Math.abs(la - lb) > mx / 2) return 0;
    let prev = Array.from({ length: lb + 1 }, (_, j) => j);
    let cur = new Array(lb + 1);
    for (let i = 1; i <= la; i++) {
      cur[0] = i;
      for (let j = 1; j <= lb; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      [prev, cur] = [cur, prev];
    }
    return 1 - prev[lb] / mx;
  }

  // rows: text per line, words: [{ w, s, e }] from Whisper → start second of each line
  function alignLines(rows, words) {
    const lt = [];
    rows.forEach((r, line) => tokenize(r).forEach((tok, k) => lt.push({ tok, line, k })));
    const wt = [];
    for (const w of words || []) {
      const toks = tokenize(w.w);
      const dur = Math.max(0.01, Number(w.e) - Number(w.s));
      toks.forEach((tok, i) => wt.push({ tok, t: Number(w.s) + (dur * i) / toks.length }));
    }
    const n = lt.length;
    const m = wt.length;
    if (!n || !m || n * m > 4e6) return null;

    // DP alignment (LCS-like, but word matching may be fuzzy)
    const W = m + 1;
    const score = new Float32Array((n + 1) * W);
    const dir = new Uint8Array((n + 1) * W); // 0 = match, 1 = skip lyric word, 2 = skip AI word
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        let best = score[(i - 1) * W + j];
        let d = 1;
        const left = score[i * W + j - 1];
        if (left > best) { best = left; d = 2; }
        const s = similarity(lt[i - 1].tok, wt[j - 1].tok);
        if (s >= 0.7) {
          const diag = score[(i - 1) * W + j - 1] + s;
          if (diag > best) { best = diag; d = 0; }
        }
        score[i * W + j] = best;
        dir[i * W + j] = d;
      }
    }

    const tokTime = new Array(n).fill(null);
    let i = n;
    let j = m;
    while (i > 0 && j > 0) {
      const d = dir[i * W + j];
      if (d === 0) { tokTime[i - 1] = wt[j - 1].t; i--; j--; }
      else if (d === 1) i--;
      else j--;
    }

    // Line time = first matched word, corrected for its position in the line
    const L = rows.length;
    const times = new Array(L).fill(null);
    const total = new Array(L).fill(0);
    const hit = new Array(L).fill(0);
    lt.forEach((x, idx) => {
      total[x.line]++;
      const t = tokTime[idx];
      if (t == null) return;
      hit[x.line]++;
      if (times[x.line] == null) times[x.line] = Math.max(0, t - x.k * 0.25);
    });
    for (let k = 0; k < L; k++) {
      if (times[k] != null && hit[k] < Math.min(2, total[k]) && hit[k] / Math.max(1, total[k]) < 0.34) times[k] = null;
    }

    // Drop out-of-order times
    let last = -Infinity;
    for (let k = 0; k < L; k++) {
      if (times[k] == null) continue;
      if (times[k] < last) times[k] = null;
      else last = times[k];
    }

    const known = [];
    times.forEach((t, k) => { if (t != null) known.push(k); });
    const withText = total.filter((c) => c > 0).length || 1;
    if (known.length / withText < 0.3) return null;

    const fixed = times.slice();
    for (let k = 0; k < L; k++) {
      if (fixed[k] != null) continue;
      let prev = null;
      let next = null;
      for (const x of known) {
        if (x < k) prev = x;
        else if (x > k) { next = x; break; }
      }
      if (prev != null && next != null) fixed[k] = times[prev] + ((times[next] - times[prev]) * (k - prev)) / (next - prev);
      else if (next != null) fixed[k] = Math.max(0, times[next] - (next - k) * 2);
      else fixed[k] = times[prev] + (k - prev) * 2;
    }
    return fixed.map((t) => Math.round(t * 100) / 100);
  }

  async function requestSync() {
    if (!track || !lyrics || isRecording()) return;
    const st = await bg({ type: 'capture:status' });
    if (st?.configError) return ui.toast(`${st.configError} Configure it via the extension icon.`);
    if (!st?.capturing) return ui.toast('Click the extension icon → "Allow AI to listen to this tab" first.');
    const v = getVideo();
    if (!v || !track || !lyrics) return;
    syncJobs.set(track.videoId, { rows: lyrics.lines.map((l) => l.text), base: lyrics.base });
    seekSong(v, 0);
    lastTime = 0;
    if (v.paused) v.play().catch(() => {});
    ui.toast('AI is listening from the start to match the timing.');
    startRecording('sync');
  }

  // Recreate lyrics with AI (listen from the start), even if lyrics exist
  async function requestRecreate() {
    if (!track) return;
    if (isRecording() || rec.state === 'transcribing') return ui.toast('AI is still working on this song.');
    const st = await bg({ type: 'capture:status' });
    if (st?.configError) return ui.toast(`${st.configError} Configure it via the extension icon.`);
    if (!st?.capturing) return ui.toast('Click the extension icon → "Allow AI to listen to this tab" first.');
    const v = getVideo();
    if (!v || !track) return;
    const vid = track.videoId;
    await chrome.storage.local.set({ [`pref:${vid}`]: 'ai' });
    await chrome.storage.local.remove(`ai:${vid}`);
    if (track?.videoId !== vid) return;
    lyrics = null;
    activeIndex = -1;
    ui.clearLines();
    ui.setBadge('');
    ui.setFoot('');
    ui.setSyncVisible(false);
    seekSong(v, 0);
    lastTime = 0;
    if (v.paused) v.play().catch(() => {});
    startRecording('generate');
  }

  async function applySync(videoId, words) {
    const job = syncJobs.get(videoId);
    syncJobs.delete(videoId);
    if (!job) return;
    const times = alignLines(job.rows, words);
    if (!times) {
      ui.toast('AI could not match the lyrics to this song.');
      return;
    }
    const entry = { times, n: job.rows.length, base: job.base, createdAt: Date.now() };
    await chrome.storage.local.set({ [`sync:${videoId}`]: entry });
    if (track?.videoId === videoId) {
      syncCache = entry;
      if (lyrics && lyrics.base === job.base && lyrics.lines.length === job.rows.length) {
        show({ ...lyrics, aiSynced: false });
      }
      ui.toast('Lyric timing synced.');
    } else {
      ui.toast('Lyric timing for the previous song synced.');
    }
  }

  // ---------- AI: listen to one full song, then transcribe ----------
  const isRecording = () => rec.state === 'recording' || rec.state === 'paused';

  // { wall clock, video position } log while recording, so AI seconds map exactly to song seconds
  let timeline = [];
  function mark() {
    const v = getVideo();
    if (v) timeline.push({ w: Date.now(), t: songTime(v), p: rec.state === 'recording' });
  }

  function restartAction() {
    return {
      label: 'Play from start',
      onClick: () => {
        const v = getVideo();
        if (!v) return;
        seekSong(v, 0);
        lastTime = 0;
        if (v.paused) v.play().catch(() => {});
        startAIFlow();
      }
    };
  }

  async function startAIFlow() {
    if (!track) return;
    const forVid = track.videoId;
    const st = await bg({ type: 'capture:status' });
    if (!track || track.videoId !== forVid || lyrics) return;

    if (st?.configError) {
      rec = { state: 'need-config' };
      ui.showState({ title: 'Lyrics not available yet', sub: `${st.configError} Open the extension icon to set up AI.` });
      return;
    }
    if (!st?.capturing) {
      rec = { state: 'need-permission' };
      ui.showState({
        title: 'Lyrics not available yet',
        sub: 'Click the extension icon and choose "Allow AI to listen to this tab" so AI can create the lyrics.'
      });
      return;
    }
    const v = getVideo();
    if (!v) return;
    if (songTime(v) > 3) {
      rec = { state: 'need-restart' };
      ui.showState({
        title: 'AI needs to listen from the start',
        sub: 'So the lyrics are complete and the timestamps are right.',
        action: restartAction()
      });
      return;
    }
    startRecording('generate');
  }

  async function startRecording(mode = 'generate') {
    const v = getVideo();
    if (!v || !track) return;
    lastTime = songTime(v);
    rec = { state: 'recording', videoId: track.videoId, mode };
    timeline = [];
    mark();
    const r = await bg({
      type: 'record:start',
      videoId: track.videoId,
      offset: songTime(v),
      mode,
      meta: {
        title: track.title,
        artist: track.artist,
        duration: track.duration,
        // Sync mode: give the AI the lyric text so what it hears leans toward the right words
        lyrics: mode === 'sync' ? syncJobs.get(track.videoId)?.rows : undefined
      }
    });
    if (r?.error) {
      rec = { state: 'need-permission' };
      if (mode === 'sync') {
        ui.setSyncBusy(null);
        ui.toast('AI cannot listen. Allow it again via the extension icon.');
      } else {
        ui.showState({ title: 'AI cannot listen', sub: 'Allow it again via the extension icon, then play the song from the start.' });
      }
      return;
    }
    if (v.paused) {
      rec.state = 'paused';
      mark();
      bg({ type: 'record:pause' });
    }
    renderListening();
  }

  function renderListening() {
    const v = getVideo();
    const p = track?.duration ? (v ? songTime(v) : 0) / track.duration : 0;
    if (rec.mode === 'sync') {
      ui.setSyncBusy(p, rec.state === 'paused');
      return;
    }
    ui.showState({
      title: rec.state === 'paused' ? 'AI waiting (song paused)' : 'AI is listening',
      sub: 'Lyrics are created after the song ends. Don\'t skip or seek until it finishes.',
      progress: p,
      live: rec.state === 'recording'
    });
  }

  function cancelRecording() {
    if (isRecording()) bg({ type: 'record:cancel' });
    if (rec.mode === 'sync') {
      syncJobs.delete(rec.videoId);
      ui.setSyncBusy(null);
    }
    rec = { state: 'idle' };
  }

  function finishRecording() {
    if (!isRecording()) return;
    mark();
    const { videoId: vid, mode } = rec;
    rec = { state: 'transcribing', videoId: vid, mode };
    bg({ type: 'record:stop', videoId: vid, timeline });
    if (mode === 'sync') {
      ui.setSyncBusy(null);
      ui.toast('AI is syncing the lyric timing…');
      return;
    }
    if (track?.videoId === vid) {
      ui.showState({
        title: 'AI is writing the lyrics…',
        sub: 'Lyrics will appear automatically next time this song plays.',
        live: true
      });
    }
  }

  // ---------- Video events ----------
  function onTimeUpdate() {
    const v = getVideo();
    if (!v || !track) return;
    const t = songTime(v);

    if (tap) {
      if (track.duration && t >= track.duration - 1.2) finishTap();
    } else if (isRecording()) {
      mark();
      const dt = t - lastTime;
      if (dt < -1 || dt > 2.5) {
        const mode = rec.mode;
        const job = mode === 'sync' ? syncJobs.get(rec.videoId) : null;
        cancelRecording();
        if (t < 1.5) {
          if (job) syncJobs.set(track.videoId, job);
          startRecording(mode);
        } else if (mode === 'sync') {
          ui.toast('Sync cancelled because the song was seeked.');
          ui.setSyncVisible(true);
        } else {
          rec = { state: 'need-restart' };
          ui.showState({
            title: 'AI stopped listening',
            sub: 'The song was seeked or skipped midway, so the recording is incomplete.',
            action: restartAction()
          });
        }
      } else if (track.duration && t >= track.duration - 1.2) {
        finishRecording();
      } else if (rec.mode === 'sync') {
        ui.setSyncBusy(track.duration ? t / track.duration : 0, rec.state === 'paused');
      } else {
        ui.setProgress(track.duration ? t / track.duration : 0);
      }
    } else if (!lyrics && rec.state !== 'transcribing' && track.duration && lastTime > track.duration - 3 && t < 2) {
      // Song repeated (repeat one) → check again, AI lyrics may be ready
      loadTrack({ ...track });
    }
    lastTime = t;
  }

  function onPauseLike() {
    if (rec.state !== 'recording') return;
    rec.state = 'paused';
    mark();
    bg({ type: 'record:pause' });
    renderListening();
  }

  function onPlaying() {
    if (rec.state !== 'paused') return;
    rec.state = 'recording';
    mark();
    bg({ type: 'record:resume' });
    renderListening();
  }

  function bindVideo() {
    const v = getVideo();
    if (!v || v === boundVideo) return;
    if (boundVideo) {
      boundVideo.removeEventListener('timeupdate', onTimeUpdate);
      boundVideo.removeEventListener('pause', onPauseLike);
      boundVideo.removeEventListener('waiting', onPauseLike);
      boundVideo.removeEventListener('playing', onPlaying);
    }
    boundVideo = v;
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('pause', onPauseLike);
    v.addEventListener('waiting', onPauseLike);
    v.addEventListener('playing', onPlaying);
  }

  // ---------- Song change detection ----------
  function leaveTrack() {
    if (isRecording()) {
      if (track?.duration && lastTime >= track.duration - 4) finishRecording();
      else cancelRecording();
    }
  }

  async function poll() {
    if (orphaned()) return teardown();
    bindVideo();
    const now = await mainWorld('now', {}, 3000);
    if (!now || now.error || !now.videoId) return;
    if (Number.isFinite(now.base) && Math.abs(now.base - timeBase) > 0.3) {
      timeBase = now.base;
      syncNow();
    }
    if (track && now.videoId === track.videoId) {
      // Initial duration can be wrong (player not ready) → update & re-estimate timing
      if (now.duration > 0 && Math.abs(now.duration - (track.duration || 0)) > 2) {
        track.duration = now.duration;
        if (lyrics?.estimated) {
          show({ ...lyrics, lines: estimateLines(lyrics.lines.map((l) => l.text).join('\n'), now.duration) });
        }
      }
      return;
    }
    if (pendingVid !== now.videoId) {
      pendingVid = now.videoId;
      pendingSince = Date.now();
      return;
    }
    const age = Date.now() - pendingSince;
    if (age < 800) return;
    if (!(now.title && now.duration > 0) && age < 6000) return;
    if (track && now.title === track.title && age < 2500) return; // metadata not updated yet
    pendingVid = null;
    leaveTrack();
    const v0 = getVideo();
    lastTime = v0 ? songTime(v0) : 0;
    loadTrack({
      videoId: now.videoId,
      title: now.title,
      artist: now.artist,
      album: now.album,
      duration: now.duration
    });
  }

  // ---------- Messages from background ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg?.type) return;
    switch (msg.type) {
      case 'get:track':
        sendResponse({ track, source: lyrics?.base || null, rec: rec.state });
        return;
      case 'capture:ready':
        if (track && !lyrics && rec.state === 'need-permission') startAIFlow();
        else if (track && !lyrics && rec.state === 'need-config') startAIFlow();
        return;
      case 'capture:ended':
        if (isRecording()) {
          if (rec.mode === 'sync') {
            syncJobs.delete(rec.videoId);
            ui.setSyncBusy(null);
            ui.toast('Tab listening permission ended, sync cancelled.');
          }
          rec = { state: 'need-permission' };
          if (!lyrics) ui.showState({ title: 'AI stopped listening', sub: 'Tab listening permission has ended. Allow it again via the extension icon.' });
        }
        return;
      case 'ai:done':
        if (rec.state === 'transcribing' && rec.videoId === msg.videoId) rec = { state: 'idle' };
        if (track?.videoId === msg.videoId) {
          if (!lyrics) show({ ...msg.lyrics, base: 'AI' });
        } else {
          ui.toast(`AI lyrics ready: ${msg.lyrics?.title || 'previous song'}`);
        }
        return;
      case 'ai:sync-done':
        if (rec.state === 'transcribing' && rec.videoId === msg.videoId) rec = { state: 'idle' };
        applySync(msg.videoId, msg.words);
        return;
      case 'ai:error':
        if (rec.state === 'transcribing' && rec.videoId === msg.videoId) rec = { state: 'idle' };
        if (msg.mode === 'sync') {
          syncJobs.delete(msg.videoId);
          ui.toast(`Timing sync failed: ${msg.error || 'unknown error'}`);
        } else if (track?.videoId === msg.videoId && !lyrics) {
          ui.showState({ title: 'Failed to create AI lyrics', sub: msg.error || '', action: restartAction() });
        } else {
          ui.toast(`AI lyrics failed: ${msg.error || 'unknown error'}`);
        }
        return;
      case 'ai:regenerate':
        if (track?.videoId === msg.videoId) {
          cancelRecording();
          loadTrack({ ...track });
        }
        return;
    }
  });

  // ---------- Settings ----------
  async function saveUi(patch) {
    const { ui: cur } = await chrome.storage.local.get('ui');
    await chrome.storage.local.set({ ui: { ...(cur || {}), ...patch } });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const prev = settings;
    settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
    ui.setVisible(settings.enabled);
    ui.setFont(settings.fontSize);
    ui.setTransparency(settings.transparency);
    ui.setAutoHide(settings.autoHide);
    if (track && !lyrics && settings.aiEnabled !== prev.aiEnabled && rec.state !== 'recording' && rec.state !== 'paused') {
      loadTrack({ ...track });
    }
  });

  async function init() {
    const st = await chrome.storage.local.get(['settings', 'ui']);
    settings = { ...DEFAULTS, ...(st.settings || {}) };
    ui = createOverlay({
      onSaveUi: saveUi,
      onFont: (d) => {
        const fontSize = Math.min(40, Math.max(12, (settings.fontSize || 18) + d * 2));
        chrome.storage.local.set({ settings: { ...settings, fontSize } });
      },
      onSeek: (i) => {
        if (tap) return tapNext();
        const v = getVideo();
        const line = lyrics?.lines?.[i];
        if (v && line) seekSong(v, line.t);
      },
      onSync: requestSync,
      onRecreate: requestRecreate,
      onEdit: openEditor,
      onEditorSave: saveManual,
      onEditorDelete: deleteManual,
      onTapStart: startTap,
      onPipClosed: () => ui.setVisible(settings.enabled)
    });
    ui.mount();
    ui.applyUi(st.ui || {});
    ui.setFont(settings.fontSize);
    ui.setTransparency(settings.transparency);
    ui.setAutoHide(settings.autoHide);
    ui.setVisible(settings.enabled);
    ui.showState({ title: 'Play a song to show lyrics' });
    timers = [setInterval(poll, 500), setInterval(syncNow, 150)];
  }

  init();
})();
