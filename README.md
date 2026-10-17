# YTM Floating Lyrics

Lirik mengambang yang sinkron dengan lagu di YouTube Music. Kalau lirik tidak tersedia, AI mendengarkan lagu sampai selesai lalu menuliskan liriknya.

## Alur sumber lirik

• Lirik bawaan YouTube Music (versi sinkron, kalau ada)
• Lirik YTM statis → timestamp diambil dari LRCLIB; kalau tidak ketemu, baris diberi waktu estimasi
• Cache lirik AI yang pernah dibuat
• LRCLIB synced
• AI (Whisper): dengar 1 lagu penuh → transkripsi → disimpan → muncul saat lagu diputar lagi

## Instalasi

• Buka `chrome://extensions`
• Aktifkan Developer mode
• Klik Load unpacked, pilih folder ini
• Buka music.youtube.com dan putar lagu

## Setup AI

• Klik ikon extension
• Pilih provider: OpenAI (`whisper-1`), Groq (`whisper-large-v3`), Google Gemini (`gemini-3.8-flash`, API key dari Google AI Studio), atau server lokal yang OpenAI-compatible
• Isi API key, klik Simpan
• Klik "Izinkan AI mendengarkan tab ini" (perlu diulang setiap tab baru / browser dibuka ulang)

Untuk Whisper lokal di Mac, pakai server yang menyediakan endpoint `/v1/audio/transcriptions`, misalnya speaches (faster-whisper-server) di `http://localhost:8000/v1`.

## Fitur overlay

• Drag header untuk memindahkan, tarik pojok kanan bawah untuk resize
• Klik baris lirik untuk lompat ke bagian itu
• A- / A+ ukuran teks
• Tombol ✎: input atau edit lirik sendiri. Teks biasa diberi timing estimasi (bisa dipaskan dengan ⟳), format LRC langsung sinkron. Lirik manual jadi prioritas utama untuk lagu itu
• Tombol ⟳ (sesuaikan timing): AI mendengarkan lagu dari awal sampai habis, lalu mencocokkan tiap baris lirik dengan detiknya. Teks tetap dari YT Music, yang disimpan hanya timestamp-nya
• Tombol PiP: jendela lirik melayang di atas semua tab dan aplikasi
• Alt+Shift+L: tampil / sembunyi

## Catatan

• Saat AI mendengarkan, jangan skip atau seek sampai lagu habis. Pause dan buffering aman.
• Lirik dari YouTube Music tidak disimpan, hanya ditampilkan. Cache hanya untuk hasil AI dan tersimpan lokal di browser.
• Akurasi AI turun untuk lagu dengan musik yang ramai atau vokal yang berat.
• Ambil lirik YTM memakai API internal YouTube, jadi bisa perlu penyesuaian kalau YouTube mengubah strukturnya.
