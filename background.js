// Service worker: coordinates audio capture, LRCLIB and the AI lyrics cache.
const DEFAULT_SETTINGS = {
  enabled: true,
  useLrclib: true,
  aiEnabled: true,
  fontSize: 18,
  transparency: 22,
  autoHide: true,
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'whisper-1',
  language: ''
};

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } });
});

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

function configError(s) {
  if (!s.baseUrl) return 'AI base URL is not set.';
  if (!s.model) return 'AI model is not set.';
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(`${s.baseUrl}/`);
  if (!s.apiKey && (!isLocal || s.provider === 'gemini')) return 'AI API key is not set.';
  return null;
}

// ---------- Offscreen document (where tab audio is captured & recorded) ----------
async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}

let creating = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Listening to YouTube Music tab audio to create lyrics with AI'
    }).finally(() => { creating = null; });
  }
  await creating;
}

const toOffscreen = (msg) => chrome.runtime.sendMessage({ target: 'offscreen', ...msg });

async function captureStatus() {
  if (!(await hasOffscreen())) return { capturing: false, tabId: null };
  try {
    return (await toOffscreen({ type: 'status' })) || { capturing: false, tabId: null };
  } catch {
    return { capturing: false, tabId: null };
  }
}

const notifyTab = (tabId, msg) => {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
};

// ---------- LRCLIB ----------
function parseLrc(lrc) {
  const out = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim() || '♪';
    for (const m of tags) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

const cleanTitle = (s = '') =>
  s.replace(/\s*[([][^)\]]*(official|video|audio|lyric|mv|visualizer|live)[^)\]]*[)\]]/gi, '').trim();

async function lrclib(t) {
  if (!t?.title) return { found: false };
  const headers = { 'Lrclib-Client': 'YTM Floating Lyrics v1.0.0' };
  const title = cleanTitle(t.title);
  const dur = Math.round(t.duration || 0);
  try {
    let hit = null;
    if (t.album && dur) {
      const q = new URLSearchParams({ track_name: title, artist_name: t.artist || '', album_name: t.album, duration: String(dur) });
      const r = await fetch(`https://lrclib.net/api/get?${q}`, { headers });
      if (r.ok) hit = await r.json();
    }
    if (!hit?.syncedLyrics) {
      const q = new URLSearchParams({ track_name: title, artist_name: t.artist || '' });
      const r = await fetch(`https://lrclib.net/api/search?${q}`, { headers });
      const list = r.ok ? await r.json() : [];
      const close = (x) => !dur || Math.abs((x.duration || 0) - dur) <= 3;
      const best = list
        .filter((x) => x.syncedLyrics && close(x))
        .sort((a, b) => Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur))[0];
      hit = best || hit || list.find((x) => x.plainLyrics && close(x)) || null;
    }
    if (hit?.syncedLyrics) {
      const lines = parseLrc(hit.syncedLyrics);
      if (lines.length) return { found: true, synced: true, lines };
    }
    if (hit?.plainLyrics) return { found: true, synced: false, text: hit.plainLyrics };
  } catch {}
  return { found: false };
}

// ---------- Message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return;
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

const fromOffscreen = (sender) => sender.id === chrome.runtime.id && !sender.tab && sender.url?.endsWith('/offscreen.html');

async function handle(msg, sender) {
  const tabId = sender.tab?.id;

  switch (msg.type) {
    case 'lrclib':
      return lrclib(msg.track);

    case 'capture:status': {
      const st = await captureStatus();
      const target = msg.tabId ?? tabId;
      return {
        capturing: !!st.capturing && st.tabId === target,
        capturingTabId: st.capturing ? st.tabId : null,
        configError: configError(await getSettings())
      };
    }

    case 'capture:grant': {
      await ensureOffscreen();
      const prev = await captureStatus();
      const r = await toOffscreen({ type: 'start', streamId: msg.streamId, tabId: msg.tabId });
      if (r?.error) throw new Error(r.error);
      if (prev.capturing && prev.tabId !== msg.tabId) notifyTab(prev.tabId, { type: 'capture:ended' });
      notifyTab(msg.tabId, { type: 'capture:ready' });
      return { ok: true };
    }

    case 'capture:release': {
      const st = await captureStatus();
      if (await hasOffscreen()) await toOffscreen({ type: 'release' });
      if (st.capturing) notifyTab(st.tabId, { type: 'capture:ended' });
      return { ok: true };
    }

    case 'record:start':
    case 'record:pause':
    case 'record:resume':
    case 'record:cancel':
    case 'record:stop': {
      const st = await captureStatus();
      if (!st.capturing || st.tabId !== tabId) return { error: 'not-capturing' };
      const type = msg.type.replace('record:', 'rec-');
      if (type === 'rec-stop') {
        const s = await getSettings();
        const err = configError(s);
        if (err) {
          await toOffscreen({ type: 'rec-cancel' });
          notifyTab(tabId, { type: 'ai:error', videoId: msg.videoId, error: err });
          return { error: err };
        }
        return toOffscreen({
          type,
          videoId: msg.videoId,
          timeline: msg.timeline,
          settings: { provider: s.provider, baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, language: s.language }
        });
      }
      return toOffscreen({ type, videoId: msg.videoId, offset: msg.offset, meta: msg.meta, mode: msg.mode });
    }

    // Transcription result from offscreen
    case 'ai:result': {
      if (!fromOffscreen(sender)) return {};
      if (msg.mode === 'sync') {
        if (msg.error || !msg.words?.length) {
          notifyTab(msg.tabId, { type: 'ai:error', mode: 'sync', videoId: msg.videoId, error: msg.error || 'AI found no vocals in this song.' });
          return { ok: false };
        }
        notifyTab(msg.tabId, { type: 'ai:sync-done', videoId: msg.videoId, words: msg.words });
        return { ok: true };
      }
      if (msg.error || !msg.lines?.length) {
        notifyTab(msg.tabId, { type: 'ai:error', videoId: msg.videoId, error: msg.error || 'AI found no vocals in this song.' });
        return { ok: false };
      }
      const lyrics = {
        source: 'AI',
        estimated: !!msg.estimated,
        lines: msg.lines,
        title: msg.meta?.title || '',
        artist: msg.meta?.artist || '',
        createdAt: Date.now()
      };
      await chrome.storage.local.set({ [`ai:${msg.videoId}`]: lyrics });
      notifyTab(msg.tabId, { type: 'ai:done', videoId: msg.videoId, lyrics });
      return { ok: true };
    }

    case 'capture:ended': {
      if (!fromOffscreen(sender)) return {};
      notifyTab(msg.tabId, { type: 'capture:ended' });
      return {};
    }

    case 'ai:clear': {
      if (msg.videoId) {
        await chrome.storage.local.remove([`ai:${msg.videoId}`, `sync:${msg.videoId}`, `pref:${msg.videoId}`]);
        if (msg.tabId != null) notifyTab(msg.tabId, { type: 'ai:regenerate', videoId: msg.videoId });
        return { ok: true, removed: 1 };
      }
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith('ai:') || k.startsWith('sync:') || k.startsWith('pref:'));
      await chrome.storage.local.remove(keys);
      return { ok: true, removed: keys.length };
    }

    case 'ai:count': {
      const all = await chrome.storage.local.get(null);
      return { count: Object.keys(all).filter((k) => k.startsWith('ai:') || k.startsWith('sync:')).length };
    }

    default:
      return {};
  }
}

// Release capture when the tab closes / leaves YouTube Music
async function releaseIf(tabId) {
  const st = await captureStatus();
  if (st.capturing && st.tabId === tabId) await toOffscreen({ type: 'release' }).catch(() => {});
}
chrome.tabs.onRemoved.addListener((tabId) => { releaseIf(tabId); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url && !info.url.startsWith('https://music.youtube.com/')) releaseIf(tabId);
});

// Shortcut Alt+Shift+L
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-overlay') return;
  const s = await getSettings();
  await chrome.storage.local.set({ settings: { ...s, enabled: !s.enabled } });
});
