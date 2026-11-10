# Deploy web (Vercel) + Google Analytics

## Checklist isi repositori GitHub (halaman utama repo harus menampilkan ini)
index.html, package.json, vite.config.ts, tsconfig.json, vercel.json, .env.production,
folder **src/** (berisi main.tsx, App.tsx, lib/, services/), folder **scripts/**, folder plugins/.
Buka folder src di GitHub: harus ada `main.tsx`. Jika tidak ada, itulah penyebab error "Failed to resolve /src/main.tsx".

## Deploy
1. Vercel -> Add New -> Project -> pilih repo -> **Deploy** (pengaturan default; vercel.json sudah mengatur semuanya).
2. Buka situs, Pengaturan (gerigi) -> isi API key Gemini (tersimpan di browser pengunjung, bukan di situs).
   JANGAN menaruh API key di Environment Variables Vercel (akan bocor ke publik).

## Google Analytics 4
1. analytics.google.com -> Admin -> Create property -> Web data stream -> isi URL Vercel -> salin **Measurement ID** (G-XXXXXXXXXX).
2. Buka `src/lib/analytics.ts` di GitHub -> ikon pensil -> isi `GA_ID_FALLBACK = 'G-XXXXXXXXXX'` -> Commit (Vercel otomatis deploy ulang).
3. Cek: GA -> Reports -> Realtime, lalu buka situs (pakai jendela penyamaran tanpa ekstensi pemblokir iklan).
Event kustom yang terkirim: import_files, translate_page, export_file, select_content_type (tandai sebagai Key event/konversi di GA).

## Alternatif tanpa GitHub (Vercel CLI)
Di folder proyek: `npm install` -> `npx vercel login` -> `npx vercel --prod`
