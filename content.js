// Overlay lirik + logika sinkronisasi & perekaman di music.youtube.com
(() => {
  'use strict';
  if (window.__ytmflLoaded) return;
  window.__ytmflLoaded = true;

  const DEFAULTS = { enabled: true, useLrclib: true, aiEnabled: true, fontSize: 18 };

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

  // Extension di-reload/update → script lama di tab ini yatim, semua API chrome.* melempar error
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

  // ---------- Bridge ke main-world.js ----------
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
  const ICON_MIN ='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 12h12"/></svg>';

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
button { all: unset; cursor: pointer; }
.card {
  --fs: 18px;
  position: relative;
  width: 340px; height: min(420px, 60vh); min-width: 240px; min-height: 150px;
  display: flex; flex-direction: column; overflow: hidden; resize: both;
  background: rgba(14, 14, 16, .78); color: #fff;
  border: 1px solid rgba(255, 255, 255, .08); border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .45);
  backdrop-filter: blur(20px) saturate(140%); -webkit-backdrop-filter: blur(20px) saturate(140%);
  font-family: "YouTube Sans", Roboto, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.card.min { height: auto !important; min-height: 0; resize: none; }
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
.actions [data-act="edit"] { display: none; }
.actions [data-act="edit"].show { display: grid; }
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
      <button data-act="smaller" title="Perkecil teks">A-</button>
      <button data-act="bigger" title="Perbesar teks">A+</button>
      <button data-act="edit" title="Input / edit lirik sendiri">${ICON_EDIT}</button>
      <button data-act="sync" title="Sesuaikan timing lirik dengan AI">${ICON_SYNC}</button>
      <button data-act="pip" title="Mengambang di atas semua jendela">${ICON_PIP}</button>
      <button data-act="min" title="Ciutkan">${ICON_MIN}</button>
    </div>
  </div>
  <div class="view">
    <div class="scroller"><div class="lines"></div></div>
    <div class="state"></div>
    <div class="editor">
      <textarea spellcheck="false" placeholder="Tempel atau ketik lirik di sini, satu baris per baris lirik."></textarea>
      <div class="hint">Teks biasa: timing diestimasi, lalu bisa dipaskan dengan tombol ⟳. Format LRC ([01:23.45] teks) langsung sinkron.</div>
      <div class="btns">
        <button class="del">Hapus lirik manual</button>
        <button class="sec" data-ed="cancel">Batal</button>
        <button class="pri" data-ed="save">Simpan</button>
      </div>
    </div>
  </div>
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

    // Simpan ukuran setelah di-resize
    new ResizeObserver(() => {
      if (pipWin || card.classList.contains('min')) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => cb.onSaveUi({ w: card.offsetWidth, h: card.offsetHeight }), 400);
    }).observe(card);

    // Scroll manual menahan auto-scroll sebentar
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
      else if (act === 'sync') { if (!b.classList.contains('busy')) cb.onSync(); }
      else if (act === 'min') {
        card.classList.toggle('min');
        cb.onSaveUi({ min: card.classList.contains('min') });
      }
    });

    // Editor lirik. Shortcut YouTube Music (spasi, j/k, dll.) jangan ikut terpicu saat mengetik.
    const editor = q('.editor');
    for (const ev of ['keydown', 'keyup', 'keypress']) editor.addEventListener(ev, (e) => e.stopPropagation());
    editor.querySelector('[data-ed="cancel"]').addEventListener('click', () => editor.classList.remove('show'));
    editor.querySelector('[data-ed="save"]').addEventListener('click', () => cb.onEditorSave(editor.querySelector('textarea').value));
    editor.querySelector('.del').addEventListener('click', () => cb.onEditorDelete());

    async function togglePip() {
      if (pipWin) { pipWin.close(); return; }
      if (!('documentPictureInPicture' in window)) {
        api.toast('Browser ini belum mendukung Picture-in-Picture dokumen.');
        return;
      }
      try {
        pipWin = await window.documentPictureInPicture.requestWindow({
          width: Math.max(320, card.offsetWidth),
          height: Math.max(360, card.offsetHeight)
        });
      } catch (err) {
        api.toast('Gagal membuka jendela mengambang.');
        pipWin = null;
        return;
      }
      pipWin.document.title = 'Lirik';
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
    const api = {
      mount() { document.documentElement.append(host); },
      destroy() {
        pipWin?.close();
        host.remove();
      },
      isPip: () => !!pipWin,
      applyUi(u = {}) {
        if (u.w) card.style.width = `${u.w}px`;
        if (u.h) card.style.height = `${u.h}px`;
        card.classList.toggle('min', !!u.min);
        requestAnimationFrame(() => place(u.x ?? innerWidth - card.offsetWidth - 24, u.y ?? 88));
      },
      setVisible(v) { if (!pipWin) host.style.display = v ? '' : 'none'; },
      setFont(px) { card.style.setProperty('--fs', `${px}px`); },
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
        scroller.scrollTop = 0;
        stateEl.classList.remove('show');
      },
      clearLines() {
        linesEl.replaceChildren();
        lineEls = [];
        current = -1;
      },
      setActive(i) {
        for (let k = 0; k < lineEls.length; k++) {
          lineEls[k].classList.toggle('active', k === i);
          lineEls[k].classList.toggle('past', k < i);
        }
        current = i;
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
      setSyncVisible(v) { q('[data-act="sync"]').classList.toggle('show', !!v); },
      // progress: angka 0..1 saat AI mendengarkan, null untuk selesai/batal
      setSyncBusy(progress, paused = false) {
        const btn = q('[data-act="sync"]');
        const mini = q('.mini');
        const busy = progress !== null && progress !== undefined;
        btn.classList.toggle('busy', busy);
        btn.title = busy ? 'AI sedang mendengarkan untuk menyesuaikan timing…' : 'Sesuaikan timing lirik dengan AI';
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

  // ---------- Lirik ----------
  // lyrics: { base: 'YT Music'|'LRCLIB'|'AI', lines, estimated, aiSynced, footer }
  let syncCache = null; // { times, n, base } — hanya timestamp, teks lirik tidak disimpan
  const syncJobs = new Map(); // videoId -> { rows, base } yang sedang disesuaikan AI

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
    if (l.estimated) return `${l.base} · estimasi`;
    return l.base;
  }

  // ---------- Lirik manual (input user) ----------
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
      // Kalau timing sudah pas, isi dalam format LRC supaya timing-nya ikut tersimpan
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
    if (!text) { ui.toast('Lirik masih kosong.'); return; }
    await chrome.storage.local.set({ [`user:${vid}`]: { text, updatedAt: Date.now() } });
    await dropManualSync(vid);
    ui.closeEditor();
    editingVid = null;
    if (track?.videoId !== vid) { ui.toast('Lirik disimpan untuk lagu sebelumnya.'); return; }
    if (rec.videoId === vid && isRecording()) cancelRecording();
    rec = { state: 'idle' };
    const l = manualLyrics(text, track.duration);
    show(l);
    ui.toast(l.estimated ? 'Lirik disimpan. Tekan ⟳ supaya timing-nya pas.' : 'Lirik disimpan.');
  }

  async function deleteManual() {
    const vid = editingVid || track?.videoId;
    if (!vid) return;
    await chrome.storage.local.remove(`user:${vid}`);
    await dropManualSync(vid);
    ui.closeEditor();
    editingVid = null;
    ui.toast('Lirik manual dihapus.');
    if (track?.videoId === vid) loadTrack({ ...track });
  }

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
    const i = indexAt(v.currentTime + 0.2);
    if (i !== activeIndex) {
      activeIndex = i;
      ui.setActive(i);
    }
  }

  async function loadTrack(t) {
    if (orphaned()) return teardown();
    const token = ++loadToken;
    track = t;
    lyrics = null;
    activeIndex = -1;
    // Transkripsi lagu ini yang masih berjalan jangan dilupakan (repeat, regenerate, ganti setting)
    if (!(rec.state === 'transcribing' && rec.videoId === t.videoId)) rec = { state: 'idle' };
    ui.clearLines();
    ui.setTrack(t);
    ui.setBadge('');
    ui.setFoot('');
    ui.setSyncVisible(false);
    ui.setSyncBusy(null);
    ui.showState({ title: 'Mencari lirik…' });

    ui.setEditVisible(true);
    const keys = [`ai:${t.videoId}`, `sync:${t.videoId}`, `user:${t.videoId}`];
    const store = await chrome.storage.local.get(keys);
    if (token !== loadToken) return;
    const cached = store[keys[0]];
    syncCache = store[keys[1]] || null;

    // 0. Lirik yang diinput user selalu jadi prioritas
    if (store[keys[2]]?.text) return show(manualLyrics(store[keys[2]].text, t.duration));

    // 1. Lirik bawaan YouTube Music
    // Error (ytcfg belum siap, timeout, HTTP) beda dengan "lirik tidak ada" → coba lagi dulu
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
      // Sudah pernah disesuaikan AI → langsung pakai
      if (syncCache?.base === 'YT Music' && syncCache.n === est.lines.length) return show(est);
      if (settings.useLrclib) {
        const lr = await bg({ type: 'lrclib', track: t });
        if (token !== loadToken) return;
        if (lr?.synced && lr.lines?.length) return show({ base: 'LRCLIB', lines: lr.lines });
      }
      return show(est);
    }

    // 2. Lirik AI yang sudah pernah dibuat
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
      return ui.showState({ title: 'AI sedang menulis lirik…', sub: 'Lirik akan muncul otomatis setelah selesai.', live: true });
    }
    if (settings.aiEnabled) return startAIFlow();
    if (lrPlain) return show({ base: 'LRCLIB', estimated: true, lines: estimateLines(lrPlain, t.duration) });
    ui.showState({ title: 'Lirik tidak tersedia', sub: 'Aktifkan fallback AI di pengaturan extension untuk membuat liriknya.' });
  }

  // ---------- Penyelarasan teks lirik dengan hasil dengar AI ----------
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

  // rows: teks per baris, words: [{ w, s, e }] dari Whisper → array detik mulai tiap baris
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

    // DP alignment (mirip LCS, tapi pencocokan kata boleh fuzzy)
    const W = m + 1;
    const score = new Float32Array((n + 1) * W);
    const dir = new Uint8Array((n + 1) * W); // 0 = cocok, 1 = lewati kata lirik, 2 = lewati kata AI
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

    // Waktu tiap baris = kata pertama yang cocok, dikoreksi posisinya di baris
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

    // Buang yang tidak urut
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
    if (st?.configError) return ui.toast(`${st.configError} Atur lewat ikon extension.`);
    if (!st?.capturing) return ui.toast('Klik ikon extension → "Izinkan AI mendengarkan tab ini" dulu.');
    const v = getVideo();
    if (!v || !track || !lyrics) return;
    syncJobs.set(track.videoId, { rows: lyrics.lines.map((l) => l.text), base: lyrics.base });
    v.currentTime = 0;
    lastTime = 0;
    if (v.paused) v.play().catch(() => {});
    ui.toast('AI mendengarkan lagu dari awal untuk menyesuaikan timing.');
    startRecording('sync');
  }

  async function applySync(videoId, words) {
    const job = syncJobs.get(videoId);
    syncJobs.delete(videoId);
    if (!job) return;
    const times = alignLines(job.rows, words);
    if (!times) {
      ui.toast('AI belum bisa mencocokkan lirik dengan lagu ini.');
      return;
    }
    const entry = { times, n: job.rows.length, base: job.base, createdAt: Date.now() };
    await chrome.storage.local.set({ [`sync:${videoId}`]: entry });
    if (track?.videoId === videoId) {
      syncCache = entry;
      if (lyrics && lyrics.base === job.base && lyrics.lines.length === job.rows.length) {
        show({ ...lyrics, aiSynced: false });
      }
      ui.toast('Timing lirik sudah disesuaikan.');
    } else {
      ui.toast('Timing lirik lagu sebelumnya sudah disesuaikan.');
    }
  }

  // ---------- AI: dengarkan 1 lagu penuh lalu transkripsi ----------
  const isRecording = () => rec.state === 'recording' || rec.state === 'paused';

  // Catatan { jam dinding, posisi video } selama merekam, supaya detik hasil AI bisa dipetakan tepat ke detik lagu
  let timeline = [];
  function mark() {
    const v = getVideo();
    if (v) timeline.push({ w: Date.now(), t: v.currentTime, p: rec.state === 'recording' });
  }

  function restartAction() {
    return {
      label: 'Putar dari awal',
      onClick: () => {
        const v = getVideo();
        if (!v) return;
        v.currentTime = 0;
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
      ui.showState({ title: 'Lirik belum tersedia', sub: `${st.configError} Buka ikon extension untuk mengatur AI.` });
      return;
    }
    if (!st?.capturing) {
      rec = { state: 'need-permission' };
      ui.showState({
        title: 'Lirik belum tersedia',
        sub: 'Klik ikon extension lalu pilih "Izinkan AI mendengarkan tab ini" supaya AI bisa membuat liriknya.'
      });
      return;
    }
    const v = getVideo();
    if (!v) return;
    if (v.currentTime > 3) {
      rec = { state: 'need-restart' };
      ui.showState({
        title: 'AI perlu mendengar dari awal',
        sub: 'Supaya lirik yang dibuat lengkap dan timestamp-nya pas.',
        action: restartAction()
      });
      return;
    }
    startRecording('generate');
  }

  async function startRecording(mode = 'generate') {
    const v = getVideo();
    if (!v || !track) return;
    lastTime = v.currentTime;
    rec = { state: 'recording', videoId: track.videoId, mode };
    timeline = [];
    mark();
    const r = await bg({
      type: 'record:start',
      videoId: track.videoId,
      offset: v.currentTime,
      mode,
      meta: { title: track.title, artist: track.artist, duration: track.duration }
    });
    if (r?.error) {
      rec = { state: 'need-permission' };
      if (mode === 'sync') {
        ui.setSyncBusy(null);
        ui.toast('AI tidak bisa mendengarkan. Izinkan ulang lewat ikon extension.');
      } else {
        ui.showState({ title: 'AI tidak bisa mendengarkan', sub: 'Izinkan ulang lewat ikon extension, lalu putar lagu dari awal.' });
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
    const p = track?.duration ? (v?.currentTime || 0) / track.duration : 0;
    if (rec.mode === 'sync') {
      ui.setSyncBusy(p, rec.state === 'paused');
      return;
    }
    ui.showState({
      title: rec.state === 'paused' ? 'AI menunggu (lagu dijeda)' : 'AI sedang mendengarkan',
      sub: 'Lirik dibuat setelah lagu selesai. Jangan skip atau seek sampai lagu habis.',
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
      ui.toast('AI sedang menyesuaikan timing lirik…');
      return;
    }
    if (track?.videoId === vid) {
      ui.showState({
        title: 'AI sedang menulis lirik…',
        sub: 'Lirik akan otomatis muncul saat lagu ini diputar lagi.',
        live: true
      });
    }
  }

  // ---------- Event video ----------
  function onTimeUpdate() {
    const v = getVideo();
    if (!v || !track) return;
    const t = v.currentTime;

    if (isRecording()) {
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
          ui.toast('Penyesuaian dibatalkan karena lagu di-seek.');
          ui.setSyncVisible(true);
        } else {
          rec = { state: 'need-restart' };
          ui.showState({
            title: 'AI berhenti mendengarkan',
            sub: 'Lagu di-seek atau di-skip di tengah, jadi rekamannya tidak utuh.',
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
      // Lagu diulang (repeat one) → cek lagi, mungkin lirik AI sudah jadi
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

  // ---------- Deteksi ganti lagu ----------
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
    if (track && now.videoId === track.videoId) {
      // Durasi awal bisa salah (player belum siap) → perbarui & hitung ulang timing estimasi
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
    if (track && now.title === track.title && age < 2500) return; // metadata belum ter-update
    pendingVid = null;
    leaveTrack();
    lastTime = getVideo()?.currentTime || 0;
    loadTrack({
      videoId: now.videoId,
      title: now.title,
      artist: now.artist,
      album: now.album,
      duration: now.duration
    });
  }

  // ---------- Pesan dari background ----------
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
            ui.toast('Izin mendengarkan tab berakhir, penyesuaian dibatalkan.');
          }
          rec = { state: 'need-permission' };
          if (!lyrics) ui.showState({ title: 'AI berhenti mendengarkan', sub: 'Izin mendengarkan tab sudah berakhir. Izinkan lagi lewat ikon extension.' });
        }
        return;
      case 'ai:done':
        if (rec.state === 'transcribing' && rec.videoId === msg.videoId) rec = { state: 'idle' };
        if (track?.videoId === msg.videoId) {
          if (!lyrics) show({ ...msg.lyrics, base: 'AI' });
        } else {
          ui.toast(`Lirik AI siap: ${msg.lyrics?.title || 'lagu sebelumnya'}`);
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
          ui.toast(`Penyesuaian timing gagal: ${msg.error || 'unknown error'}`);
        } else if (track?.videoId === msg.videoId && !lyrics) {
          ui.showState({ title: 'Gagal membuat lirik AI', sub: msg.error || '', action: restartAction() });
        } else {
          ui.toast(`Lirik AI gagal: ${msg.error || 'unknown error'}`);
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

  // ---------- Pengaturan ----------
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
        const v = getVideo();
        const line = lyrics?.lines?.[i];
        if (v && line) v.currentTime = Math.max(0, line.t);
      },
      onSync: requestSync,
      onEdit: openEditor,
      onEditorSave: saveManual,
      onEditorDelete: deleteManual,
      onPipClosed: () => ui.setVisible(settings.enabled)
    });
    ui.mount();
    ui.applyUi(st.ui || {});
    ui.setFont(settings.fontSize);
    ui.setVisible(settings.enabled);
    ui.showState({ title: 'Putar lagu untuk menampilkan lirik' });
    timers = [setInterval(poll, 500), setInterval(syncNow, 150)];
  }

  init();
})();
