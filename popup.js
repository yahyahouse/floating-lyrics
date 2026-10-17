const DEFAULTS = {
  enabled: true, useLrclib: true, aiEnabled: true, fontSize: 18,
  provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'whisper-1', language: ''
};
const PROVIDERS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.8-flash' },
  local: { baseUrl: 'http://localhost:8000/v1', model: 'Systran/faster-whisper-large-v3' },
  custom: null
};

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };
let tab = null;
let current = null; // { track }

async function load() {
  const { settings: s } = await chrome.storage.local.get('settings');
  settings = { ...DEFAULTS, ...(s || {}) };
  for (const k of ['enabled', 'useLrclib', 'aiEnabled']) $(k).checked = !!settings[k];
  for (const k of ['provider', 'baseUrl', 'apiKey', 'model', 'language']) $(k).value = settings[k] || '';

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onYtm = !!tab?.url?.startsWith('https://music.youtube.com/');
  if (onYtm) {
    try { current = await chrome.tabs.sendMessage(tab.id, { type: 'get:track' }); } catch { current = null; }
    const t = current?.track;
    $('now').textContent = t ? `${t.title}${t.artist ? ` · ${t.artist}` : ''}` : 'Belum ada lagu yang diputar';
    $('regenBtn').disabled = !t;
  } else {
    $('now').textContent = 'Buka music.youtube.com';
  }
  await refreshCapture(onYtm);
  refreshCache();
}

async function refreshCapture(onYtm) {
  const btn = $('capBtn');
  const st = $('capStatus');
  if (!onYtm) {
    st.textContent = 'Extension hanya bekerja di YouTube Music.';
    st.classList.remove('on');
    btn.disabled = true;
    return;
  }
  const r = await chrome.runtime.sendMessage({ type: 'capture:status', tabId: tab.id });
  btn.disabled = false;
  if (r?.capturing) {
    st.textContent = 'AI aktif mendengarkan tab ini';
    st.classList.add('on');
    btn.textContent = 'Berhenti mendengarkan';
    btn.dataset.mode = 'release';
  } else {
    st.textContent = r?.capturingTabId != null
      ? 'AI sedang aktif di tab lain. Izinkan di sini untuk pindah.'
      : 'AI belum diizinkan mendengarkan tab ini.';
    st.classList.remove('on');
    btn.textContent = 'Izinkan AI mendengarkan tab ini';
    btn.dataset.mode = 'grant';
  }
}

async function refreshCache() {
  const r = await chrome.runtime.sendMessage({ type: 'ai:count' });
  $('cacheInfo').textContent = `Cache AI: ${r?.count ?? 0} lagu`;
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ settings });
}

function msg(text, err = false) {
  $('saveMsg').textContent = text;
  $('saveMsg').classList.toggle('err', err);
}

// Toggle langsung tersimpan
for (const k of ['enabled', 'useLrclib', 'aiEnabled']) {
  $(k).addEventListener('change', () => saveSettings({ [k]: $(k).checked }));
}

$('provider').addEventListener('change', () => {
  showProviderHint();
  const p = PROVIDERS[$('provider').value];
  if (p) {
    $('baseUrl').value = p.baseUrl;
    $('model').value = p.model;
  }
});

$('saveBtn').addEventListener('click', async () => {
  const baseUrl = $('baseUrl').value.trim().replace(/\/+$/, '');
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return msg('Base URL tidak valid.', true); }

  // Minta izin host untuk endpoint di luar daftar bawaan
  const builtIn = ['https://api.openai.com', 'https://api.groq.com', 'https://generativelanguage.googleapis.com'];
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!builtIn.includes(origin) && !isLocal) {
    const ok = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!ok) return msg('Izin akses ke endpoint ditolak.', true);
  }

  await saveSettings({
    provider: $('provider').value,
    baseUrl,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    language: $('language').value.trim().toLowerCase()
  });
  msg('Tersimpan.');
  if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { type: 'capture:ready' }).catch(() => {});
});

$('capBtn').addEventListener('click', async () => {
  const btn = $('capBtn');
  btn.disabled = true;
  try {
    if (btn.dataset.mode === 'release') {
      await chrome.runtime.sendMessage({ type: 'capture:release' });
    } else {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const r = await chrome.runtime.sendMessage({ type: 'capture:grant', tabId: tab.id, streamId });
      if (r?.error) throw new Error(r.error);
    }
  } catch (e) {
    $('capStatus').textContent = `Gagal: ${e?.message || e}`;
  }
  await refreshCapture(true);
});

$('regenBtn').addEventListener('click', async () => {
  const t = current?.track;
  if (!t) return;
  await chrome.runtime.sendMessage({ type: 'ai:clear', videoId: t.videoId, tabId: tab.id });
  $('regenBtn').textContent = 'Cache lagu ini dihapus';
  refreshCache();
});

$('clearBtn').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'ai:clear' });
  $('cacheInfo').textContent = `Dihapus ${r?.removed ?? 0} lagu`;
});

function showProviderHint() {
  const hints = {
    openai: 'Timestamp per kata, paling presisi untuk tombol ⟳.',
    groq: 'Cepat dan murah, mendukung timestamp per kata.',
    gemini: 'Pakai API key dari Google AI Studio. Timing per baris, sedikit kurang presisi dibanding Whisper.',
    local: 'Server lokal OpenAI-compatible, API key boleh kosong.',
    custom: 'Endpoint OpenAI-compatible (/audio/transcriptions).'
  };
  $('providerHint').textContent = hints[$('provider').value] || '';
}

load().then(showProviderHint);
