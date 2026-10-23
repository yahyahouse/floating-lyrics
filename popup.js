const DEFAULTS = {
  enabled: true, useLrclib: true, aiEnabled: true, fontSize: 18, transparency: 22, autoHide: true,
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
  for (const k of ['enabled', 'useLrclib', 'aiEnabled', 'autoHide']) $(k).checked = !!settings[k];
  for (const k of ['provider', 'baseUrl', 'apiKey', 'model', 'language']) $(k).value = settings[k] || '';
  $('transparency').value = settings.transparency;
  $('transparencyVal').textContent = `${settings.transparency}%`;

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onYtm = !!tab?.url?.startsWith('https://music.youtube.com/');
  if (onYtm) {
    try { current = await chrome.tabs.sendMessage(tab.id, { type: 'get:track' }); } catch { current = null; }
    const t = current?.track;
    $('now').textContent = t ? `${t.title}${t.artist ? ` · ${t.artist}` : ''}` : 'No song playing yet';
    $('regenBtn').disabled = !t;
  } else {
    $('now').textContent = 'Open music.youtube.com';
  }
  await refreshCapture(onYtm);
  refreshCache();
}

async function refreshCapture(onYtm) {
  const btn = $('capBtn');
  const st = $('capStatus');
  if (!onYtm) {
    st.textContent = 'The extension only works on YouTube Music.';
    st.classList.remove('on');
    btn.disabled = true;
    return;
  }
  const r = await chrome.runtime.sendMessage({ type: 'capture:status', tabId: tab.id });
  btn.disabled = false;
  if (r?.capturing) {
    st.textContent = 'AI is listening to this tab';
    st.classList.add('on');
    btn.textContent = 'Stop listening';
    btn.dataset.mode = 'release';
  } else {
    st.textContent = r?.capturingTabId != null
      ? 'AI is active in another tab. Allow it here to switch.'
      : 'AI is not allowed to listen to this tab yet.';
    st.classList.remove('on');
    btn.textContent = 'Allow AI to listen to this tab';
    btn.dataset.mode = 'grant';
  }
}

async function refreshCache() {
  const r = await chrome.runtime.sendMessage({ type: 'ai:count' });
  $('cacheInfo').textContent = `AI cache: ${r?.count ?? 0} songs`;
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ settings });
}

function msg(text, err = false) {
  $('saveMsg').textContent = text;
  $('saveMsg').classList.toggle('err', err);
}

// Toggles save immediately
for (const k of ['enabled', 'useLrclib', 'aiEnabled', 'autoHide']) {
  $(k).addEventListener('change', () => saveSettings({ [k]: $(k).checked }));
}

$('transparency').addEventListener('input', () => {
  const v = Number($('transparency').value);
  $('transparencyVal').textContent = `${v}%`;
  saveSettings({ transparency: v });
});

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
  try { origin = new URL(baseUrl).origin; } catch { return msg('Invalid base URL.', true); }

  // Request host permission for endpoints outside the built-in list
  const builtIn = ['https://api.openai.com', 'https://api.groq.com', 'https://generativelanguage.googleapis.com'];
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!builtIn.includes(origin) && !isLocal) {
    const ok = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!ok) return msg('Access to the endpoint was denied.', true);
  }

  await saveSettings({
    provider: $('provider').value,
    baseUrl,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    language: $('language').value.trim().toLowerCase()
  });
  msg('Saved.');
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
    $('capStatus').textContent = `Failed: ${e?.message || e}`;
  }
  await refreshCapture(true);
});

$('regenBtn').addEventListener('click', async () => {
  const t = current?.track;
  if (!t) return;
  await chrome.runtime.sendMessage({ type: 'ai:clear', videoId: t.videoId, tabId: tab.id });
  $('regenBtn').textContent = 'Cache for this song cleared';
  refreshCache();
});

$('clearBtn').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'ai:clear' });
  $('cacheInfo').textContent = `Cleared ${r?.removed ?? 0} songs`;
});

function showProviderHint() {
  const hints = {
    openai: 'Word-level timestamps, most precise for the ⟳ button.',
    groq: 'Fast and cheap, supports word-level timestamps.',
    gemini: 'Use an API key from Google AI Studio. Line-level timing, slightly less precise than Whisper.',
    local: 'Local OpenAI-compatible server, API key may be empty.',
    custom: 'OpenAI-compatible endpoint (/audio/transcriptions).'
  };
  $('providerHint').textContent = hints[$('provider').value] || '';
}

load().then(showProviderHint);
