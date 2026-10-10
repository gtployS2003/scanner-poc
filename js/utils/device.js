const ua = navigator.userAgent;

function detectInAppBrowser() {
  if (/\bLine\//i.test(ua)) return 'LINE';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'Facebook';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/TikTok|musical_ly/i.test(ua)) return 'TikTok';
  return null;
}

export const device = Object.freeze({
  isIOS: /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  isAndroid: /Android/i.test(ua),
  inAppBrowser: detectInAppBrowser(),
  userAgent: ua,
});

/** รายการตรวจความพร้อมที่แสดงบนหน้าเริ่ม; required = ถ้าไม่ผ่านจะเริ่มไม่ได้ */
export function environmentChecks() {
  const inApp = device.inAppBrowser;
  return [
    { label: 'เปิดผ่าน HTTPS', ok: window.isSecureContext, required: true,
      note: 'กล้องใช้ได้เฉพาะหน้าเว็บ HTTPS' },
    { label: 'รองรับการเข้าถึงกล้อง', ok: Boolean(navigator.mediaDevices?.getUserMedia), required: true,
      note: 'Browser นี้ไม่มี getUserMedia' },
    { label: 'รองรับ Web Worker และ WebAssembly',
      ok: typeof Worker !== 'undefined' && typeof WebAssembly === 'object', required: true,
      note: 'ต้องใช้สำหรับ OpenCV.js' },
    { label: 'เปิดใน Browser หลัก', ok: !inApp, required: false,
      note: inApp ? `กำลังเปิดใน ${inApp} ซึ่งกล้องอาจใช้ไม่ได้ ให้เปิดลิงก์นี้ใน ${device.isIOS ? 'Safari' : 'Chrome'}` : '' },
    { label: 'กันจอดับระหว่างสแกน', ok: 'wakeLock' in navigator, required: false, optional: true,
      note: 'ไม่รองรับ Wake Lock ใช้งานต่อได้' },
  ];
}

/** หน่วยความจำ JS heap (มีเฉพาะ Chromium) */
export function jsHeapMB() {
  const m = performance.memory;
  return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
}
