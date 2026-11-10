# Kustomisasi sendiri (nama, alamat web, warna)

Cara mengedit di GitHub: buka berkas -> ikon pensil -> ubah -> **Commit changes**. Vercel deploy ulang otomatis (~1 menit).
Pratinjau instan di PC tanpa deploy: `npm run dev` lalu buka http://localhost:3000 (simpan berkas = tampilan langsung berubah).

## 1. Nama aplikasi
- `src/config.ts` -> ubah `APP_NAME` (nama di header + judul tab browser) dan `APP_TAGLINE`.
- `index.html` -> ubah teks di `<title>` dan `og:title` (dibaca Google/media sosial sebelum aplikasi dimuat).
- Aplikasi Android: `capacitor.config.json` -> `appName`, lalu `npm run android:sync`.

## 2. Alamat web (domain)
Vercel -> pilih proyek -> **Settings -> Domains**:
- Domain gratis `xxx.vercel.app`: klik Edit/Add, ketik nama baru yang masih kosong (mis. `namakeren.vercel.app`).
- Domain sendiri (mis. yang sudah tersambung): tambahkan di halaman yang sama dan ikuti petunjuk DNS.
- Nama proyek: **Settings -> General -> Project Name**.
Google Analytics tetap bekerja (memakai Measurement ID, bukan alamat). Perbarui URL di Data Stream GA bila ingin rapi.

## 3. Warna & tema
Buka `src/theme.css`, ubah 4 baris di `:root`:
`--mt-primary` (tombol utama), `--mt-accent` / `--mt-accent-dark` (hijau), `--mt-page-bg` (latar).
Ada 4 preset siap salin (Biru, Ungu, Marun, Hijau tua) di komentar file tsb.
Pakai warna pekat untuk primary & accent-dark agar teks putih tetap terbaca.
