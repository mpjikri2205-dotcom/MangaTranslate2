# Perubahan (perbaikan engine render, prompt, editor)

Cara pasang: timpa folder `src/` proyek lama dengan `src/` di ZIP ini (server.ts, package.json tidak berubah),
lalu `npm run dev`. Tidak ada dependensi baru.

## File baru
- `src/lib/pixel.ts`      : deteksi & hapus teks asli (flood-fill balon + deteksi goresan + inpainting)
- `src/lib/textLayout.ts` : tata letak teks HORIZONTAL mengikuti bentuk balon (oval/persegi)
- `src/lib/renderPage.ts` : pipeline render (hapus -> cache -> tulis teks)
- `src/lib/aiPrompt.ts`   : prompt + skema JSON baru (box_2d) + normalisasi hasil AI

## Akar masalah yang diperbaiki
1. Satu kotak dipakai sebagai area hapus DAN area tulis -> kini dipisah (`srcX/srcY/srcW/srcH` = teks asli, tidak ikut bergeser saat drag).
2. Penghapus lama menyerah bila goresan >28% & radius isi cuma 4-8px -> kini mask piksel teks + inpainting.
3. Heuristik "tinggi > 1.5x lebar = vertikal" membuat teks Indonesia vertikal -> dihapus. Terjemahan selalu horizontal (tombol Vertikal manual tetap ada).
4. Teks panjang dipotong "..." -> kini font mengecil / area melebar, tidak pernah dipotong.
5. Render dipanggil di dalam updater setState tanpa penjaga urutan, font belum termuat saat mengukur -> kini di-debounce, hasil basi dibuang, font di-preload.
6. Retranslate 1 blok mematikan antrean terjemah global -> diperbaiki.

## Prompt AI
- Koordinat pakai `box_2d [ymin,xmin,ymax,xmax]` (format asli Gemini), box diminta ketat ke teks ASLI.
- Urutan baca manga (kanan-ke-kiri), transkripsi dulu baru terjemah, field `kind`/`vertical`, konteks 6 baris halaman sebelumnya, temperature 0.2.

## Editor
- Toolbar mengambang di atas kanvas (tambah teks/eraser, undo/redo, font, rata, horizontal, hapus, AI, simpan).
- Shortcut: tekan `?` untuk daftar lengkap. Undo/Redo per halaman (Ctrl+Z / Ctrl+Y).
- Multi-pilih blok (Shift+klik, Ctrl+A) dan hapus/geser/ubah massal.
- Pilih halaman (centang, Shift+klik = rentang) lintas proyek -> bar "Terjemahkan ulang" / "Hapus" massal.
- Panel pengaturan jadi overlay; sidebar & drawer memakai lebar proporsional; sidebar otomatis menutup saat edit di layar sempit.

## Update 2
- Toolbar edit dipindah ke baris di atas kanvas (tidak lagi menutupi preview).
- Seleksi drag gaya Google Drive: tahan lalu seret (mouse: geser >6px; sentuh: tekan lama) + auto-scroll di tepi. Berlaku untuk daftar halaman dan daftar blok teks.
- Kotak centang halaman sekarang selalu terlihat; tombol "Pilih", "Pilih semua", "Terjemah (N)", "Hapus" di atas daftar halaman.
- Daftar Blok teks (mode edit): centang, drag-select, hapus massal.
- Penghapus teks besar di luar balon: kernel deteksi diperbesar (maks 24px).

## Update 3 (bug: bagian wajah ikut terhapus)
- Toleransi warna latar diperketat (kulit pucat tidak lagi dianggap bagian balon).
- Hanya komponen netral (hitam/abu/putih) yang dianggap teks; mulut, bibir, rambut berwarna dilindungi (jalur balon & jalur teks-di-atas-gambar).
- Zona hapus di sekitar kotak AI untuk balon dipersempit (35% -> 15%).

## Update 4
- Sisa teks asli di balon: jika interior balon terdeteksi tertutup & terpercaya, SEMUA goresan netral di dalamnya dihapus (tidak bergantung pada kotak AI yang kadang melewatkan satu kolom/baris).
- Panel "Gaya & Efek" muncul untuk 1 ATAU BANYAK blok terpilih: ukuran font, rata, bold/italic, horizontal/vertikal, font, warna, Stroke, Bayangan, Glow (warna + intensitas), masking (Auto/Oval/Rounded/Siku/Off + warna), hapus-asli on/off.
- Renderer mendukung strokeW, shadowBlur, glowBlur per blok (tipe baru di types.ts).

## Update 5
- Masking (Oval/Rounded/Siku) kini TIDAK lagi bergantung pada toggle "Hapus teks asli"; keduanya independen.
- Area hapus teks asli tampil sebagai kotak merah putus-putus saat blok dipilih; bisa digeser/di-resize lewat pegangan merah, atau diatur: "Tetap" / "Ikut kotak" / "Set = kotak" (tombol M).
- Klik area kosong = lepas pilihan. Alat baru: Pilih (seret = seleksi area/marquee), Teks, Eraser (seret untuk menggambar). Esc / D / tombol "Lepas" juga melepas pilihan.
- Shortcut bisa dikustomisasi (tekan ? lalu klik tombol yang ingin diubah); tersimpan di browser.
- "Training": AI kini belajar dari koreksi Anda. Setiap terjemahan yang Anda ubah lalu disimpan (Ctrl+S) dicatat dan dikirim sebagai panduan di prompt berikutnya (maks 25 terbaru). Dapat dilihat/dihapus di menu shortcut (?).
- Penghapus teks di atas gambar: kotak deteksi otomatis melebar bila huruf melewati batas kotak AI.
- Tata letak: bentuk balon memakai superellipse (mengikuti balon bulat/oval/membulat-persegi), font diperbesar otomatis bila ada ruang, jarak baris lebih rapat.

## Update 6 - Android (APK)
- Capacitor ditambahkan (config: capacitor.config.json, dependensi di package.json, script android:*).
- src/lib/apiClient.ts: /api/translate, /api/free-translate, /api/env-check dikerjakan di dalam aplikasi saat berjalan sebagai APK; di web tetap lewat server.ts.
- src/lib/nativeFile.ts: ekspor PDF/ZIP lewat lembar Bagikan Android.
- .github/workflows/build-apk.yml: membangun APK otomatis di GitHub (tanpa Android Studio). Lihat README_ANDROID.md.

## Update 7 - Android: ekspor & impor
- Ekspor langsung ke folder (default Download/MangaTranslate atau folder pilihan) lewat plugin native FileSaver; tidak ada dialog per file. Cadangan otomatis: lembar Bagikan.
- Notifikasi "N file tersimpan" + lokasi; pilihan folder di Pengaturan.
- Impor file: bar progres tipis di atas layar + keterangan file/halaman (tidak menutupi layar), UI tidak lagi "membeku".
- scripts/android-setup.mjs + native/FileSaverPlugin.java; workflow GitHub diperbarui.

## Update 8 - Android: plugin resmi, nama file, seleksi
- Plugin penyimpanan dijadikan paket lokal capacitor-mtfilesaver (terdaftar otomatis oleh cap sync); skrip setup kini membersihkan patch lama dan memeriksa pendaftaran plugin.
- Kartu status di Pengaturan: aktif / tidak aktif + alasan error; tombol Pilih folder menampilkan error bila gagal.
- Nama file ekspor kembali bersih (jalur cadangan Bagikan tidak lagi memberi awalan angka).
- Seleksi sentuhan memakai touch event (tekan lama + geser + auto-scroll), mencegah menu tekan-lama Android; berlaku untuk halaman, blok teks, dan PROYEK.
- Seleksi proyek: centang bulat, bar aksi Terjemahkan / Hapus / Semua / Batal.
- update-android.bat: satu klik untuk npm install + android:sync.

## Update 9 - terjemahan "macet" (buku/halaman padat teks)
- Batas waktu 150 dtk untuk permintaan AI + percobaan ulang otomatis (sebelumnya menunggu selamanya jika koneksi putus).
- Baris status langkah di kartu "Translasi" (mengirim ke AI / menunggu kuota-jaringan / menganalisis & menghapus teks x/y).
- Render halaman tidak lagi membekukan layar (jeda UI antar blok) dan inpainting dipercepat sekitar 40%.
- Layar tetap menyala selama menerjemahkan/mengimpor (plugin: keepAwake), karena Android menidurkan JavaScript saat layar mati.

## Update 10 - Mode Buku / Dokumen
Masalah: hasil terjemah buku terdengar santai, saling menimpa, ukuran tidak seragam, tidak rata kiri-kanan.
Penyebab: prompt memerintahkan "bahasa santai komik" + tata letak dirancang untuk balon manga.
- Pengaturan > "Jenis konten": Manga/Komik atau Buku/Dokumen (tersimpan).
- Mode Buku: prompt bahasa baku formal (PUEBI), terjemahan per PARAGRAF utuh (kalimat tidak dipotong per baris), abaikan grafik/gambar/nomor halaman.
- Tata letak buku: rata kiri-kanan (justify), ukuran huruf seragam (persentil-30), rata atas, tumbuh ke bawah hanya di ruang kosong (tidak menimpa blok bawah), font serif, tanpa stroke.
- Penghapus buku: seluruh kotak paragraf asli ditutup warna latar (andal, tanpa sisa huruf) pada latar rata.
- Editor: tombol justify (☰), font "Serif (buku)", shortcut 4.
- Prompt terjemah-ulang-blok & jalur teks-saja ikut formal pada mode Buku.

## Update 11 - Deploy web (Vercel) + Google Analytics
- package.json diperbaiki (valid); `build` = vite build (server bundling pindah ke build:server); name = manga-translate.
- Mode mandiri web (VITE_STANDALONE di .env.production): AI dipanggil dari browser dengan API key pengguna; unduhan memakai browser.
- vercel.json + scripts/web-prep.mjs (lepas plugin Android saat build web) + scripts/verify-files.mjs (pesan jelas bila src/ tidak terupload).
- src/lib/analytics.ts: GA4 + event kustom; nonaktif di localhost & APK. index.html: meta description/OG.

## Update 12 - Perbaikan situs Vercel + kustomisasi
- Deteksi mode mandiri otomatis berdasarkan alamat situs (tidak lagi bergantung pada .env.production yang bisa tidak terupload) -> memperbaiki error 404 /api/translate dan unduhan file di Vercel.
- Penghapus: teks BERWARNA pada blok non-balon (buku/narasi) kini ikut terhapus; perlindungan warna tetap di dalam balon.
- Panduan API key (pop-up otomatis sekali + kartu "Butuh API key?" di Pengaturan).
- src/config.ts (nama aplikasi), src/theme.css (warna/tema), README_CUSTOMIZE.md.
