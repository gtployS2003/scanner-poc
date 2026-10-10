/* Vision Worker (classic worker) — ถือ OpenCV.js และทำงานประมวลผลภาพทั้งหมด
 *
 * ข้อความเข้า : { id, type: 'init' | 'detect' | 'warp', payload }
 * ข้อความออก : { id, ok: true, result } | { id, ok: false, error }
 *
 * กติกาหน่วยความจำ: ทุก cv.Mat ที่สร้างต้องผ่าน track() แล้วถูก delete() ใน finally
 */
/* global importScripts */

let cv = null;
let detectConf = { minAreaRatio: 0.15, epsilons: [0.02, 0.03, 0.045] };

const now = () => performance.now();

self.onmessage = async ({ data }) => {
  const { id, type, payload } = data;
  try {
    if (type === 'init') {
      reply(id, await init(payload));
    } else if (type === 'detect') {
      reply(id, detect(payload));
    } else if (type === 'warp') {
      const result = warp(payload);
      reply(id, result, [result.buffer]);
    } else {
      throw new Error(`ไม่รู้จักคำสั่ง ${type}`);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) });
  }
};

function reply(id, result, transfer = []) {
  self.postMessage({ id, ok: true, result }, transfer);
}

/* ------------------------------------------------------------------ init */

async function init({ urls, timeoutMs, detect }) {
  if (detect) detectConf = { ...detectConf, ...detect };
  const t0 = now();
  let source = null;
  const errors = [];

  for (const url of urls) {
    try {
      importScripts(url);          // โหลดแบบ synchronous; ไฟล์ราว 8–10 MB
      if (!self.cv) throw new Error('ไม่พบตัวแปร cv');
      source = url;
      break;
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  if (!source) throw new Error(`โหลด OpenCV.js ไม่สำเร็จ (${errors.join(' | ')})`);

  const tScript = now();
  cv = await withTimeout(resolveCv(self.cv), timeoutMs, 'OpenCV runtime ไม่พร้อมภายในเวลาที่กำหนด');
  const tReady = now();
  geom = buildGeometry(cv);

  return {
    source,
    version: readVersion(cv),
    geometry: geom.source,
    scriptMs: Math.round(tScript - t0),
    runtimeMs: Math.round(tReady - tScript),
    totalMs: Math.round(tReady - t0),
  };
}

/** รองรับทั้ง build ที่ cv เป็น Promise และ build ที่ต้องรอ onRuntimeInitialized */
async function resolveCv(candidate) {
  // ห้าม await object ของ Emscripten ตรง ๆ: build เก่ามี .then() ที่ทำให้วนไม่จบ
  if (candidate instanceof Promise) candidate = await candidate;
  if (candidate.Mat) return candidate;
  await new Promise((resolve) => { candidate.onRuntimeInitialized = resolve; });
  return candidate;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function readVersion(c) {
  try {
    const info = c.getBuildInformation?.() ?? '';
    const m = info.match(/Version control:\s*(\S+)/);
    return m ? m[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

function requireCv() {
  if (!cv) throw new Error('OpenCV ยังไม่พร้อม');
  return cv;
}

/* ---------------------------------------------------------------- detect */

function detect({ buffer, width, height }) {
  const c = requireCv();
  const t0 = now();
  const mats = [];
  const track = (m) => { mats.push(m); return m; };

  try {
    const src = track(new c.Mat(height, width, c.CV_8UC4));
    src.data.set(new Uint8Array(buffer));

    const gray = track(new c.Mat());
    c.cvtColor(src, gray, c.COLOR_RGBA2GRAY);

    // ความสว่าง: ค่าเฉลี่ย 0–255
    const brightness = c.mean(gray)[0];

    // ความคม: Variance of Laplacian (ยิ่งสูงยิ่งคม) — M0 วัดทั้งเฟรม, M3 จะวัดเฉพาะในกรอบเอกสาร
    const lap = track(new c.Mat());
    c.Laplacian(gray, lap, c.CV_64F);
    const mean = track(new c.Mat());
    const std = track(new c.Mat());
    c.meanStdDev(lap, mean, std);
    const sharpness = std.doubleAt(0, 0) ** 2;

    // ขอบ: Blur → Canny (threshold จาก Otsu ปรับตามแสงอัตโนมัติ) → Dilate เชื่อมขอบที่ขาด
    const blurred = track(new c.Mat());
    c.GaussianBlur(gray, blurred, new c.Size(5, 5), 0);
    const bin = track(new c.Mat());
    const otsu = c.threshold(blurred, bin, 0, 255, c.THRESH_BINARY + c.THRESH_OTSU);
    const edges = track(new c.Mat());
    c.Canny(blurred, edges, otsu * 0.5, otsu);
    const kernel = track(c.Mat.ones(3, 3, c.CV_8U));
    c.dilate(edges, edges, kernel);

    const contours = track(new c.MatVector());
    const hierarchy = track(new c.Mat());
    c.findContours(edges, contours, hierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);

    const frameArea = width * height;
    const best = findBestQuad(c, contours, frameArea);

    return {
      width,
      height,
      quad: best ? normalize(orderCorners(best.pts), width, height) : null,
      areaRatio: best ? best.area / frameArea : 0,
      contourCount: contours.size(),
      brightness: Math.round(brightness),
      sharpness: Math.round(sharpness),
      detectMs: now() - t0,
    };
  } finally {
    mats.forEach((m) => m.delete());
  }
}

/** เลือกรูปสี่เหลี่ยมนูนที่ใหญ่ที่สุดและใหญ่กว่าเกณฑ์ขั้นต่ำ */
function findBestQuad(c, contours, frameArea) {
  const minArea = frameArea * detectConf.minAreaRatio;
  let best = null;

  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    try {
      const area = geom.contourArea(cnt);
      if (area < minArea || (best && area <= best.area)) continue;
      const peri = geom.arcLength(cnt);

      for (const eps of detectConf.epsilons) {
        const pts = geom.approx(cnt, eps * peri);
        // OpenCV 5 คืนผลของ vector เป็น Mat 1 มิติ (rows = 1) จึงนับจำนวนจุดแทนการดู .rows
        if (pts.length === 4 && isConvexPolygon(pts)) {
          best = { pts, area: polygonArea(pts) };
          break;
        }
      }
    } finally {
      cnt.delete();
    }
  }
  return best;
}

/* -------------------------------------------------------------- geometry
 * OpenCV 5 ย้ายฟังก์ชันเรขาคณิต (เช่น isContourConvex) จาก imgproc ไปโมดูล geometry
 * ซึ่ง build ของ opencv.js อาจไม่ได้รวมไว้ จึงใช้ของ OpenCV เมื่อมี และใช้ JS แทนเมื่อไม่มี
 * contour ที่ได้จาก CHAIN_APPROX_SIMPLE บนเฟรม 480 px มีจุดไม่มาก ฝั่ง JS จึงเร็วพอ
 */
let geom = null;

function buildGeometry(c) {
  const source = {};
  const pick = (name, nativeFn, jsFn) => {
    const native = typeof c[name] === 'function';
    source[name] = native ? 'opencv' : 'js';
    return native ? nativeFn : jsFn;
  };
  return {
    source,
    contourArea: pick('contourArea',
      (m) => c.contourArea(m),
      (m) => polygonArea(matPoints(m))),
    arcLength: pick('arcLength',
      (m) => c.arcLength(m, true),
      (m) => perimeter(matPoints(m))),
    approx: pick('approxPolyDP',
      (m, eps) => {
        const out = new c.Mat();
        try {
          c.approxPolyDP(m, out, eps, true);
          return matPoints(out);
        } finally {
          out.delete();
        }
      },
      (m, eps) => approxClosed(matPoints(m), eps)),
  };
}

/** อ่านจุดจาก Mat ชนิด CV_32SC2 ได้ทั้งรูปแบบ Nx1 (4.x) และ 1 มิติ (5.x) */
function matPoints(m) {
  const d = m.data32S;
  const pts = [];
  for (let i = 0; i + 1 < d.length; i += 2) pts.push({ x: d[i], y: d[i + 1] });
  return pts;
}

function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function perimeter(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) s += dist(pts[i], pts[(i + 1) % pts.length]);
  return s;
}

/** นูนเมื่อทุกมุมเลี้ยวไปทางเดียวกัน (ใช้แทน isContourConvex) */
function isConvexPolygon(pts) {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const c = pts[(i + 2) % pts.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) return false;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/** Douglas–Peucker แบบเส้นปิด: แบ่งที่จุดไกลสุดจากจุดแรก แล้วลดจุดทีละครึ่ง */
function approxClosed(pts, eps) {
  if (pts.length <= 4) return pts.slice();
  let far = 0;
  let dmax = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[0], pts[i]);
    if (d > dmax) { dmax = d; far = i; }
  }
  const a = simplify(pts.slice(0, far + 1), eps);
  const b = simplify([...pts.slice(far), pts[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const first = pts[0];
  const last = pts.at(-1);
  let idx = -1;
  let dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segmentDistance(pts[i], first, last);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [first, last];
  const left = simplify(pts.slice(0, idx + 1), eps);
  const right = simplify(pts.slice(idx), eps);
  return [...left.slice(0, -1), ...right];
}

function segmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** เรียงมุมเป็น [ซ้ายบน, ขวาบน, ขวาล่าง, ซ้ายล่าง] */
function orderCorners(pts) {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

function normalize(pts, width, height) {
  return pts.map((p) => ({ x: p.x / width, y: p.y / height }));
}

/* ------------------------------------------------------------------ warp */

const FULL_FRAME = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Perspective correction บนเฟรมเต็ม ให้ด้านยาวของผลลัพธ์ = outLongSide */
function warp({ buffer, width, height, quad, outLongSide }) {
  const c = requireCv();
  const t0 = now();
  const mats = [];
  const track = (m) => { mats.push(m); return m; };

  try {
    const corners = (quad ?? FULL_FRAME).map((p) => ({ x: p.x * width, y: p.y * height }));
    const [tl, tr, br, bl] = corners;
    const natW = Math.max(dist(tl, tr), dist(bl, br));
    const natH = Math.max(dist(tl, bl), dist(tr, br));
    const scale = outLongSide / Math.max(natW, natH);
    const outW = Math.max(1, Math.round(natW * scale));
    const outH = Math.max(1, Math.round(natH * scale));

    const src = track(new c.Mat(height, width, c.CV_8UC4));
    src.data.set(new Uint8Array(buffer));

    const srcTri = track(c.matFromArray(4, 1, c.CV_32FC2, corners.flatMap((p) => [p.x, p.y])));
    const dstTri = track(c.matFromArray(4, 1, c.CV_32FC2, [
      0, 0, outW - 1, 0, outW - 1, outH - 1, 0, outH - 1,
    ]));
    const M = track(c.getPerspectiveTransform(srcTri, dstTri));
    const dst = track(new c.Mat());
    c.warpPerspective(src, dst, M, new c.Size(outW, outH), c.INTER_LINEAR, c.BORDER_REPLICATE, new c.Scalar());

    // คัดลอกออกจาก WASM heap ก่อน delete
    const out = new Uint8ClampedArray(dst.data);

    return {
      buffer: out.buffer,
      width: outW,
      height: outH,
      naturalWidth: Math.round(natW),
      naturalHeight: Math.round(natH),
      quadUsed: Boolean(quad),
      warpMs: now() - t0,
    };
  } finally {
    mats.forEach((m) => m.delete());
  }
}
