// เกณฑ์และค่าทั้งหมดของ Spike อยู่ที่นี่ที่เดียว เพื่อจูนระหว่างทดสอบบนเครื่องจริง
// ปรับผ่าน URL ได้โดยไม่ต้องแก้โค้ด:
//   ?res=720 | 1080 | 4k   ความละเอียดที่ขอจากกล้อง (ค่าเริ่มต้น 1080)
//   ?size=320 | 480 | 640  ด้านยาวของเฟรมที่ใช้ตรวจจับ (ค่าเริ่มต้น 480)
//   ?cv=remote             ข้าม opencv.js ในเครื่อง ไปโหลดจาก docs.opencv.org
//   ?grab=canvas           ดึงเฟรมแบบเดิมบน main thread (ค่าเริ่มต้น bitmap)
//   ?enhanced=off          ปิดวิธีตรวจจับแบบ enhanced สำหรับพื้นสีอ่อน
//   ?view=edges            แสดงภาพขอบที่ใช้หาเอกสารมุมขวาล่าง
//   ?debug                 เปิด Eruda (console บนมือถือ)

const params = new URLSearchParams(location.search);

/** เปลี่ยนทุกครั้งที่ส่งไฟล์ชุดใหม่ ใช้ยืนยันว่ามือถือโหลดโค้ดล่าสุดแล้ว (ดูแถว "เวอร์ชัน") */
export const APP_VERSION = 'm0-r5';

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
    maxAreaRatio: 0.95,        // ใหญ่กว่านี้มักเป็นขอบเฟรมเอง ไม่ใช่กระดาษ
    epsilons: [0.02, 0.03, 0.045],
    minAngle: 40,              // มุมภายในของสี่เหลี่ยมที่ยอมรับ (องศา)
    maxAngle: 140,
    hullFill: 0.9,             // hull ต้องเกือบเป็นสี่เหลี่ยมอยู่แล้ว
    maxCandidates: 8,          // ให้คะแนนสี่เหลี่ยมที่ใหญ่ที่สุดกี่ตัวต่อวิธี
    // ให้คะแนนขอบด้วยสีสองฝั่ง: ด้านในต้องเป็นกระดาษ และต่างจากด้านนอก
    score: {
      sampleDist: 3,           // ห่างจากเส้นขอบกี่ px (บนเฟรมตรวจจับ) ให้พ้นความหนาของเส้นพิมพ์
      samplesPerSide: 16,
      minContrast: 6,          // ΔE ขั้นต่ำระหว่างด้านในกับด้านนอก (Lab 8-bit)
      minPaper: 0.6,           // สัดส่วนจุดด้านในที่ต้องดูเป็นกระดาษ
      paperMinL: 100,          // กระดาษต้องสว่างอย่างน้อยเท่านี้ (L 0–255)
      paperMaxChroma: 25,      // และสีไม่จัดเกินนี้
      minValid: 0.5,           // จุดด้านนอกต้องอยู่ในเฟรมอย่างน้อยครึ่งหนึ่ง
    },
    enhanced: {
      enabled: params.get('enhanced') !== 'off',
      longSide: 360,           // ย่อภาพก่อนทำวิธีนี้ เพราะหนักกว่าวิธีแรกหลายเท่า
      blur: 5,
      cannyLow: 25,
      cannyHigh: 75,
      closeKernel: 5,
      clipLimit: 2,            // CLAHE ของช่อง L
      stretchPercent: 2,       // ตัดหัวท้ายกี่ % ก่อนยืดช่อง a/b
      maxGain: 8,              // ขยายช่องสีได้ไม่เกินกี่เท่า กัน noise
    },
  },
  grab: params.get('grab') === 'canvas' ? 'canvas' : 'bitmap',
  overlay: {
    smoothing: 0.55,           // น้ำหนักของตำแหน่งเดิม (0 = ไม่ smooth)
    jumpReset: 0.12,           // มุมขยับเกินสัดส่วนนี้ของเฟรม = เริ่ม smooth ใหม่
    holdFrames: 3,             // ไม่พบติดกันกี่เฟรมจึงซ่อนกรอบ
  },
  output: { longSide: 2000, jpegQuality: 0.85 },
  gate: { minFps: 5 },
  stats: { window: 30 },
  debug: { eruda: params.has('debug'), refreshMs: 250, view: params.get('view') },
});