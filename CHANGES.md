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
