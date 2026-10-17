// Menangkap audio tab, merekam 1 lagu penuh, lalu mengirim ke Whisper.
let stream = null;
let audioCtx = null;
let capturedTabId = null;
let recorder = null;
let chunks = [];
let session = null; // { videoId, offset, meta }

const MAX_BYTES = 24 * 1024 * 1024;
const JUNK = /(thanks? for watching|thank you for watching|subscribe|subtitles? by|amara\.org|terima kasih (telah|sudah) menonton|like and subscribe)/i;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  handle(msg).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case 'status':
      return { capturing: !!stream && stream.active, tabId: capturedTabId };

    case 'start':
      await startCapture(msg.streamId, msg.tabId);
      return { ok: true };

    case 'release':
      stopCapture();
      return { ok: true };

    case 'rec-start':
      if (!stream?.active) return { error: 'not-capturing' };
      await discardRecording();
      chunks = [];
      session = { videoId: msg.videoId, offset: Number(msg.offset) || 0, meta: msg.meta || {}, mode: msg.mode === 'sync' ? 'sync' : 'generate', spans: [] };
      recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 });
      recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      recorder.start(1000);
      session.spans.push({ from: Date.now(), to: null });
      return { ok: true };

    case 'rec-pause':
      if (recorder?.state === 'recording') {
        recorder.pause();
        closeSpan();
      }
      return { ok: true };

    case 'rec-resume':
      if (recorder?.state === 'paused') {
        recorder.resume();
        session?.spans.push({ from: Date.now(), to: null });
      }
      return { ok: true };

    case 'rec-cancel':
      await discardRecording();
      return { ok: true };

    case 'rec-stop': {
      if (!recorder || !session || session.videoId !== msg.videoId) return { error: 'no-recording' };
      closeSpan();
      const s = { ...session, timeline: Array.isArray(msg.timeline) ? msg.timeline : [] };
      const blob = await stopRecorder();
      session = null;
      transcribe(blob, s, msg.settings)
        .then((r) => report({ ...r, mode: s.mode, videoId: s.videoId, meta: s.meta }))
        .catch((e) => report({ error: String(e?.message || e), mode: s.mode, videoId: s.videoId, meta: s.meta }));
      return { ok: true };
    }

    default:
      return { error: 'unknown' };
  }
}

function report(payload) {
  chrome.runtime.sendMessage({ type: 'ai:result', tabId: capturedTabId, ...payload }).catch(() => {});
}

async function startCapture(streamId, tabId) {
  stopCapture();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });
  // Teruskan audio ke speaker, karena tab capture membuat tab jadi senyap
  audioCtx = new AudioContext();
  audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
  capturedTabId = tabId;
  const track = stream.getAudioTracks()[0];
  if (track) {
    track.addEventListener('ended', () => {
      const id = capturedTabId;
      stopCapture();
      chrome.runtime.sendMessage({ type: 'capture:ended', tabId: id }).catch(() => {});
    });
  }
}

function stopCapture() {
  if (recorder && recorder.state !== 'inactive') {
    try { recorder.stop(); } catch {}
  }
  recorder = null;
  chunks = [];
  session = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  audioCtx?.close().catch(() => {});
  audioCtx = null;
  capturedTabId = null;
}

function stopRecorder() {
  return new Promise((resolve) => {
    const r = recorder;
    recorder = null;
    if (!r || r.state === 'inactive') {
      resolve(new Blob(chunks, { type: 'audio/webm' }));
      return;
    }
    r.addEventListener('stop', () => resolve(new Blob(chunks, { type: 'audio/webm' })), { once: true });
    r.stop();
  });
}

function closeSpan() {
  const last = session?.spans.at(-1);
  if (last && last.to == null) last.to = Date.now();
}

// Detik di rekaman → detik di lagu. Rekaman dijeda saat lagu dijeda, jadi detik rekaman diubah dulu
// ke jam dinding (lewat span aktif recorder), lalu ke posisi video (lewat catatan timeline dari tab).
// Dengan begitu jeda pesan antar-context tidak menggeser timing.
function makeClock(s) {
  const spans = s.spans || [];
  const tl = (s.timeline || [])
    .filter((x) => Number.isFinite(x?.w) && Number.isFinite(x?.t))
    .sort((a, b) => a.w - b.w);
  if (!spans.length || tl.length < 2) return (r) => r + s.offset;

  const toWall = (r) => {
    let acc = 0;
    for (const sp of spans) {
      const len = ((sp.to ?? Date.now()) - sp.from) / 1000;
      if (r <= acc + len) return sp.from + (r - acc) * 1000;
      acc += len;
    }
    const last = spans[spans.length - 1];
    return (last.to ?? last.from) + (r - acc) * 1000;
  };
  const toVideo = (w) => {
    if (w <= tl[0].w) return tl[0].t - (tl[0].w - w) / 1000;
    for (let i = 1; i < tl.length; i++) {
      const a = tl[i - 1];
      const b = tl[i];
      if (w > b.w) continue;
      if (!a.p) return a.t;
      return a.t + Math.min((w - a.w) / 1000, Math.max(0, b.t - a.t));
    }
    const z = tl[tl.length - 1];
    return z.p ? z.t + (w - z.w) / 1000 : z.t;
  };
  return (r) => toVideo(toWall(r));
}

async function discardRecording() {
  if (recorder) await stopRecorder();
  chunks = [];
  session = null;
}

async function apiError(res) {
  let detail = '';
  try { detail = (await res.json())?.error?.message || ''; } catch {}
  return new Error(`AI error ${res.status}${detail ? `: ${detail}` : ''}`);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// "01:07.5" / "1:02:03" / "67.5" → detik
function parseStamp(v) {
  if (typeof v === 'number') return v;
  const str = String(v ?? '').trim();
  if (!str) return NaN;
  const parts = str.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// Gemini: kirim audio langsung, minta transkripsi per baris lengkap dengan detiknya.
// Hasilnya dibentuk mirip respons Whisper ({ segments }) supaya proses selanjutnya sama.
async function geminiRequest(blob, s, cfg) {
  if (blob.size > 14 * 1024 * 1024) throw new Error('Audio terlalu besar untuk Gemini (maks ±14 MB).');
  const hint = [s.meta?.title, s.meta?.artist].filter(Boolean).join(' - ');
  const prompt = [
    'Transcribe the sung vocals in this audio recording of a song.',
    'Return one entry per sung line with "start" and "end" as timestamps in MM:SS.s format (minutes:seconds from the beginning of the audio, e.g. "01:07.5"), and "text".',
    'Only write what is actually audible. Skip instrumental parts. Do not add notes, labels or translations.',
    cfg.language ? `The vocals are mostly in language code "${cfg.language}".` : 'Keep the original language of the vocals.',
    hint ? `Song info for spelling of names only: ${hint}.` : ''
  ].filter(Boolean).join(' ');

  const base = (cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const res = await fetch(`${base}/models/${encodeURIComponent(cfg.model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'audio/webm', data: await blobToBase64(blob) } }
        ]
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: { start: { type: 'STRING' }, end: { type: 'STRING' }, text: { type: 'STRING' } },
            required: ['start', 'text']
          }
        }
      }
    })
  });
  if (!res.ok) throw await apiError(res);
  const data = await res.json();
  const raw = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  let items = [];
  try { items = JSON.parse(raw); } catch { throw new Error('Respons Gemini tidak bisa dibaca.'); }
  if (!Array.isArray(items)) items = [];
  const segments = items
    .map((x) => ({ start: parseStamp(x.start), end: parseStamp(x.end ?? x.start), text: String(x.text || '').trim() }))
    .filter((x) => Number.isFinite(x.start) && x.text)
    .map((x) => ({ ...x, end: Number.isFinite(x.end) && x.end > x.start ? x.end : x.start + 2 }))
    .sort((a, b) => a.start - b.start);
  return { segments, text: '' };
}

async function whisperRequest(blob, s, cfg) {
  const fd = new FormData();
  fd.append('file', blob, 'song.webm');
  fd.append('model', cfg.model);
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'segment');
  fd.append('timestamp_granularities[]', 'word');
  fd.append('temperature', '0');
  if (cfg.language) fd.append('language', cfg.language);
  const hint = [s.meta?.title, s.meta?.artist].filter(Boolean).join(' - ');
  if (hint) fd.append('prompt', hint);

  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
  const headers = cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
  const res = await fetch(url, { method: 'POST', headers, body: fd });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

async function transcribe(blob, s, cfg) {
  if (!blob.size) throw new Error('Rekaman kosong.');
  if (blob.size > MAX_BYTES) throw new Error('Audio terlalu besar untuk dikirim ke AI (maks 24 MB).');

  const data = cfg.provider === 'gemini' ? await geminiRequest(blob, s, cfg) : await whisperRequest(blob, s, cfg);
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const clock = makeClock(s);

  // Gemini kadang menulis detik yang melar melewati panjang rekaman → skala ulang ke panjang rekaman
  const recLen = (s.spans || []).reduce((acc, sp) => acc + ((sp.to ?? Date.now()) - sp.from) / 1000, 0);
  const maxEnd = Math.max(0, ...segments.map((seg) => Number(seg.end) || 0));
  if (cfg.provider === 'gemini' && recLen > 10 && maxEnd > recLen + 3) {
    const k = recLen / maxEnd;
    for (const seg of segments) {
      seg.start = Number(seg.start) * k;
      seg.end = Number(seg.end) * k;
    }
  }

  // Mode sync: kembalikan kata + waktunya, nanti dicocokkan dengan teks lirik di tab
  if (s.mode === 'sync') {
    let words = Array.isArray(data.words) && data.words.length
      ? data.words.map((w) => ({ w: String(w.word || ''), s: clock(Number(w.start)), e: clock(Number(w.end)) }))
      : segments
          .filter((seg) => (seg.no_speech_prob ?? 0) < 0.6)
          .map((seg) => ({ w: String(seg.text || ''), s: clock(Number(seg.start)), e: clock(Number(seg.end)) }));
    words = words.filter((w) => w.w.trim() && Number.isFinite(w.s) && Number.isFinite(w.e));
    if (!words.length) throw new Error('AI tidak menemukan vokal di lagu ini.');
    return { words };
  }

  if (segments.length) {
    // Awal segmen Whisper sering kecepatan (ikut jeda/intro); pakai kata pertama di segmen kalau ada
    const words = Array.isArray(data.words) ? data.words : [];
    const startOf = (seg) => {
      const st = Number(seg.start);
      const w = words.find((x) => Number(x.start) >= st - 0.05 && Number(x.start) < Number(seg.end));
      return w ? Number(w.start) : st;
    };
    const lines = segments
      .filter((seg) => (seg.no_speech_prob ?? 0) < 0.6)
      .map((seg) => ({ t: Math.max(0, clock(startOf(seg))), text: String(seg.text || '').trim() }))
      .filter((l) => l.text && !JUNK.test(l.text));
    return { lines, estimated: false };
  }

  // Server tidak mengembalikan timestamp → bagi rata sepanjang durasi
  const text = String(data.text || '').trim();
  if (!text || JUNK.test(text)) return { lines: [] };
  const rows = text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const d = s.meta?.duration || 180;
  return {
    lines: rows.map((r, i) => ({ t: d * 0.06 + (d * 0.88 * i) / rows.length, text: r })),
    estimated: true
  };
}
