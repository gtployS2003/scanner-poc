// เกณฑ์และค่าทั้งหมดของ Spike อยู่ที่นี่ที่เดียว เพื่อจูนระหว่างทดสอบบนเครื่องจริง
// ปรับผ่าน URL ได้โดยไม่ต้องแก้โค้ด:
//   ?res=720 | 1080 | 4k   ความละเอียดที่ขอจากกล้อง (ค่าเริ่มต้น 1080)
//   ?size=320 | 480 | 640  ด้านยาวของเฟรมที่ใช้ตรวจจับ (ค่าเริ่มต้น 480)
//   ?cv=remote             ข้าม opencv.js ในเครื่อง ไปโหลดจาก docs.opencv.org
//   ?debug                 เปิด Eruda (console บนมือถือ)

const params = new URLSearchParams(location.search);

const RESOLUTIONS = {
  '720': [1280, 720],
  '1080': [1920, 1080],
  '4k': [3840, 2160],
};
const [idealWidth, idealHeight] = RESOLUTIONS[params.get('res')] ?? RESOLUTIONS['1080'];

export const CONFIG = Object.freeze({
  opencv: {
    localUrl: 'vendor/opencv/5.0.0/opencv.js',
    remoteUrl: 'https://docs.opencv.org/5.0.0/opencv.js',
    forceRemote: params.get('cv') === 'remote',
    loadTimeoutMs: 60_000,
  },
  camera: { idealWidth, idealHeight },
  detect: {
    longSide: Number(params.get('size')) || 480,
    minIntervalMs: 0,          // 0 = ส่งเฟรมใหม่ทันทีที่ worker ว่าง
    minAreaRatio: 0.15,        // เอกสารต้องกินพื้นที่อย่างน้อย 15% ของเฟรม
    epsilons: [0.02, 0.03, 0.045],
  },
  overlay: {
    smoothing: 0.55,           // น้ำหนักของตำแหน่งเดิม (0 = ไม่ smooth)
    jumpReset: 0.12,           // มุมขยับเกินสัดส่วนนี้ของเฟรม = เริ่ม smooth ใหม่
    holdFrames: 3,             // ไม่พบติดกันกี่เฟรมจึงซ่อนกรอบ
  },
  output: { longSide: 2000, jpegQuality: 0.85 },
  gate: { minFps: 5 },
  stats: { window: 30 },
  debug: { eruda: params.has('debug'), refreshMs: 250 },
});
