// Berjalan di "MAIN world" halaman YouTube Music, supaya bisa membaca ytcfg & player.
// Komunikasi dengan content.js lewat window.postMessage.
(() => {
  'use strict';
  if (window.__ytmflMain) return;
  window.__ytmflMain = true;

  const cfg = (k) => {
    try { return window.ytcfg?.get?.(k); } catch { return undefined; }
  };

  async function innertube(endpoint, body) {
    const context = cfg('INNERTUBE_CONTEXT');
    if (!context) throw new Error('ytcfg belum siap');
    const clientName = String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') || 67);
    const clientVersion = String(cfg('INNERTUBE_CLIENT_VERSION') || context.client?.clientVersion || '');
    const key = cfg('INNERTUBE_API_KEY');
    const url = `/youtubei/v1/${endpoint}?prettyPrint=false${key ? `&key=${encodeURIComponent(key)}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        'X-Youtube-Client-Name': clientName,
        'X-Youtube-Client-Version': clientVersion
      },
      body: JSON.stringify({ context, ...body })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Cari baris lirik ber-timestamp: { lyricLine, cueRange: { startTimeMilliseconds } }
  function extractTimed(data) {
    const timed = [];
    walk(data, (n) => {
      if (n.cueRange && n.lyricLine !== undefined) {
        const ms = Number(n.cueRange.startTimeMilliseconds);
        if (Number.isFinite(ms)) timed.push({ t: ms / 1000, text: String(n.lyricLine).trim() || '♪' });
        return false;
      }
    });
    return timed.sort((a, b) => a.t - b.t);
  }

  function walk(node, fn, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 80) return;
    if (fn(node) === false) return;
    for (const k in node) walk(node[k], fn, depth + 1);
  }

  const runsText = (r) => (r?.runs || []).map((x) => x.text).join('') || r?.simpleText || '';

  // Ambil lirik bawaan YouTube Music (tab "Lyrics").
  async function getLyrics(videoId) {
    const next = await innertube('next', { videoId, isAudioOnly: true });

    let browseId = null;
    walk(next, (n) => {
      const id = n.browseEndpoint?.browseId;
      if (!browseId && typeof id === 'string' && id.startsWith('MPLYt')) browseId = id;
    });
    if (!browseId) return { found: false };

    const data = await innertube('browse', { browseId });
    const timed = extractTimed(data);

    // Lirik statis + keterangan sumber
    let plain = null;
    let footer = '';
    walk(data, (n) => {
      const r = n.musicDescriptionShelfRenderer;
      if (r && plain === null) {
        plain = runsText(r.description);
        footer = runsText(r.footer);
        return false;
      }
    });

    if (timed.length) {
      timed.sort((a, b) => a.t - b.t);
      return { found: true, synced: true, lines: timed, footer };
    }
    if (plain && plain.trim()) return { found: true, synced: false, text: plain, footer };
    return { found: false };
  }

  // Info lagu yang sedang diputar.
  function nowPlaying() {
    const player = document.getElementById('movie_player');
    let data = {};
    try { data = player?.getVideoData?.() || {}; } catch {}
    const meta = navigator.mediaSession?.metadata;
    const video = document.querySelector('video');
    const videoId = data.video_id || new URLSearchParams(location.search).get('v') || null;
    let duration = 0;
    // Gapless: getDuration() lagu berikutnya = bagian yang baru ter-buffer (29s, 49s, …) → pakai panjang asli lagu dulu
    try {
      const d = player?.getPlayerResponse?.()?.videoDetails;
      if (d && d.videoId === videoId) duration = Number(d.lengthSeconds) || 0;
    } catch {}
    if (!duration) try { duration = Number(player?.getDuration?.()) || 0; } catch {}
    if (!duration && video && Number.isFinite(video.duration)) duration = video.duration;
    // Saat iklan, durasi milik iklan — jangan dipakai untuk estimasi lirik
    const ad = !!player?.classList?.contains('ad-showing');
    if (ad) duration = 0;
    // Selisih jam <video> vs posisi lagu (gapless: lagu berikutnya tidak mulai dari 0)
    let base;
    try {
      const ct = Number(player?.getCurrentTime?.());
      if (!ad && video && Number.isFinite(ct)) base = video.currentTime - ct;
    } catch {}
    return {
      videoId,
      title: meta?.title || data.title || '',
      artist: meta?.artist || data.author || '',
      album: meta?.album || '',
      duration,
      base
    };
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.__ytmfl !== 'req') return;
    const { id, action, payload } = e.data;
    let result;
    try {
      if (action === 'lyrics') result = await getLyrics(payload.videoId);
      else if (action === 'now') result = nowPlaying();
      else result = { error: 'unknown action' };
    } catch (err) {
      result = { error: String(err?.message || err) };
    }
    window.postMessage({ __ytmfl: 'res', id, result }, '*');
  });
})();
