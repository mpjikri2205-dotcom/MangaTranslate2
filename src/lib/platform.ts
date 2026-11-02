/** true bila berjalan di dalam aplikasi Android/iOS (Capacitor), false di browser/localhost. */
export const isNative = (): boolean => {
  try {
    return !!(globalThis as any).window?.Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
};
