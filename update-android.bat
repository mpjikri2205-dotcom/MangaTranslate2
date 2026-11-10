@echo off
cd /d "%~dp0"
echo === 1/2 npm install ===
call npm install
echo.
echo === 2/2 build web + sinkronisasi Android ===
call npm run android:sync
echo.
echo Cari baris "[android-setup] OK" di atas. Jika ada, lanjut di Android Studio:
echo   File ^> Sync Project with Gradle Files, lalu Build ^> Generate APKs
pause
