/* Vision Worker (classic worker) — ถือ OpenCV.js และทำงานประมวลผลภาพทั้งหมด
 *
 * ข้อความเข้า : { id, type: 'init' | 'detect' | 'warp', payload }
 * ข้อความออก : { id, ok: true, result } | { id, ok: false, error }
 *
 * กติกาหน่วยความจำ: ทุก cv.Mat ที่สร้างต้องผ่าน track() แล้วถูก delete() ใน finally
 */
/* global importScripts */

let cv = null;
let detectConf = {
  minAreaRatio: 0.15,
  maxAreaRatio: 0.95,
  epsilons: [0.02, 0.03, 0.045],
  minAngle: 40,
  maxAngle: 140,
  hullFill: 0.9,
  maxCandidates: 8,
  fitTolerance: 0.02,
  fitMinPoints: 8,
  fitMaxShift: 0.03,
  regionOpen: 0.02,
  snap: null,
  enhanced: null,
  score: null,
};

const now = () => performance.now();

self.onmessage = async ({ data }) => {
  const { id, type, payload } = data;
  try {
    if (type === 'init') {
      reply(id, await init(payload));
    } else if (type === 'detect') {
      const result = detect(payload);
      reply(id, result, result.edges ? [result.edges] : []);
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
  const deadline = t0 + timeoutMs;
  const remaining = () => Math.max(1, deadline - now());
  const errors = [];
  let source = null;
  let bytes = null;
  let downloadMs = null;
  let evalMs = null;

  for (const url of urls) {
    try {
      const tDl = now();
      let scriptUrl = url;
      try {
        // ดาวน์โหลดเองเพื่อรายงานความคืบหน้าและตรวจว่าได้ไฟล์ JS จริง
        const dl = await withTimeout(download(url), remaining(), 'ดาวน์โหลดเกินเวลาที่กำหนด');
        scriptUrl = dl.blobUrl;
        bytes = dl.bytes;
      } catch (e) {
        // ปลายทางที่ไม่เปิด CORS (เช่น docs.opencv.org) fetch ไม่ได้ ให้ importScripts ตรงแทน
        if (!(e instanceof TypeError)) throw e;
        progress({ phase: 'download', note: 'fetch ไม่ได้ (CORS) ใช้ importScripts ตรง', url });
      }
      downloadMs = now() - tDl;

      progress({ phase: 'evaluate', url, bytes });
      const tEval = now();
      importScripts(scriptUrl);
      evalMs = now() - tEval;
      if (scriptUrl !== url) URL.revokeObjectURL(scriptUrl);
      if (!self.cv) throw new Error('โหลดสคริปต์แล้วแต่ไม่พบตัวแปร cv');
      source = url;
      break;
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
      progress({ phase: 'fallback', url, error: e.message });
    }
  }
  if (!source) throw new Error(`โหลด OpenCV.js ไม่สำเร็จ (${errors.join(' | ')})`);

  progress({ phase: 'runtime', cvType: describe(self.cv) });
  const tRuntime = now();
  const resolved = await withTimeout(resolveCv(self.cv), remaining(), `OpenCV runtime ไม่พร้อมภายในเวลาที่กำหนด (cv เป็น ${describe(self.cv)})`);
  cv = resolved.lib;
  const tReady = now();
  geom = buildGeometry(cv);

  return {
    source,
    version: readVersion(cv),
    geometry: geom.source,
    sizeMB: bytes ? Math.round(bytes / 104857.6) / 10 : null,
    downloadMs: Math.round(downloadMs),
    evalMs: Math.round(evalMs),
    runtimeMs: Math.round(tReady - tRuntime),
    totalMs: Math.round(tReady - t0),
  };
}

function progress(info) {
  self.postMessage({ type: 'progress', ...info });
}

/** ดาวน์โหลดเป็น Blob URL พร้อมรายงาน % ทุก ~250 ms */
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/html')) throw new Error('ได้หน้า HTML แทนไฟล์ JavaScript (ไฟล์อาจไม่มีอยู่ที่ path นี้)');

  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (now() - lastPost > 250) {
      lastPost = now();
      progress({ phase: 'download', url, loaded, total });
    }
  }
  progress({ phase: 'download', url, loaded, total: total || loaded });
  const blob = new Blob(chunks, { type: 'text/javascript' });
  return { blobUrl: URL.createObjectURL(blob), bytes: loaded };
}

/**
 * opencv.js แต่ละ build ส่ง cv มาไม่เหมือนกัน:
 *  - object ที่มี Mat พร้อมใช้แล้ว
 *  - object ที่ต้องรอ onRuntimeInitialized
 *  - Promise ที่ resolve เป็น cv
 *  - ฟังก์ชัน factory (MODULARIZE) ที่ต้องเรียกก่อน
 *
 * สำคัญ: object ของ Emscripten บาง build มีเมธอด .then() ที่เรียก callback ด้วยตัวเอง
 * ถ้า resolve Promise ด้วย object นั้นตรง ๆ JavaScript จะเรียก .then() วนไม่รู้จบ
 * จน worker ค้างทั้งตัว (timeout ก็ไม่ทำงาน) จึงห่อไว้ใน { lib } เสมอและไม่ await ตัว cv ตรง ๆ
 */
function resolveCv(candidate) {
  if (typeof candidate === 'function' && !candidate.Mat) candidate = candidate();
  if (candidate instanceof Promise) {
    return candidate.then((lib) => waitForMat(lib));
  }
  return waitForMat(candidate);
}

function waitForMat(lib) {
  if (lib?.Mat) return Promise.resolve({ lib });
  // รอทั้ง callback และตรวจซ้ำทุก 50 ms เผื่อ callback ถูกเรียกไปแล้วก่อนเราจะผูก
  return new Promise((resolve) => {
    let timer = null;
    const check = () => {
      if (!lib.Mat) return;
      clearInterval(timer);
      resolve({ lib });
    };
    const previous = lib.onRuntimeInitialized;
    lib.onRuntimeInitialized = () => {
      if (typeof previous === 'function') previous();
      check();
    };
    timer = setInterval(check, 50);
  });
}

function describe(v) {
  if (v === undefined) return 'undefined';
  if (v instanceof Promise) return 'Promise';
  if (typeof v === 'function') return v.Mat ? 'function+Mat' : 'function';
  return v && v.Mat ? 'object+Mat' : typeof v;
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

/* ---------------------------------------------------------------- detect
 * หาสี่เหลี่ยมที่เป็นไปได้ด้วย 2 วิธี:
 *  1. gray     : ขอบจากภาพขาวดำ (เร็ว ได้ผลดีบนพื้นเข้ม)
 *  2. enhanced : ใช้เมื่อวิธีแรกไม่มีตัวเลือกที่ผ่านเกณฑ์ — แยกช่อง Lab, เพิ่ม Contrast เฉพาะที่ (CLAHE)
 *                และยืดช่องสี a/b เพื่อจับขอบกระดาษขาวบนพื้นสีอ่อน ถ้าขอบขาดใช้ Convex Hull ปิดรูป
 *
 * จากนั้นให้คะแนนทุกตัวเลือกด้วยการสุ่มดูสีสองฝั่งของขอบ (scoreBoundary)
 * ขอบกระดาษจริง: ด้านในเป็นกระดาษ (สว่าง สีไม่จัด) และด้านในต่างจากด้านนอก
 * กรอบตารางที่พิมพ์บนฟอร์มมีกระดาษทั้งสองฝั่ง ส่วนกรอบโต๊ะ/เงามีด้านในไม่ใช่กระดาษ จึงถูกคัดออก
 */

let readCanvas = null;
let readCtx = null;

/** อ่านพิกเซลจาก ImageBitmap ที่ main thread ส่งมา (ย้ายงานอ่าน GPU → CPU มาไว้ใน worker) */
function readBitmap(bitmap, width, height) {
  if (!readCanvas || readCanvas.width !== width || readCanvas.height !== height) {
    readCanvas = new OffscreenCanvas(width, height);
    readCtx = readCanvas.getContext('2d', { willReadFrequently: true });
  }
  readCtx.drawImage(bitmap, 0, 0, width, height);   // ระบุขนาดเสมอ เผื่อ browser ไม่ทำ resize ให้
  bitmap.close();
  return readCtx.getImageData(0, 0, width, height).data;
}

function detect({ buffer, bitmap, width, height, wantEdges, prevQuad }) {
  const c = requireCv();
  const t0 = now();
  const mats = [];
  const track = (m) => { mats.push(m); return m; };

  try {
    const tRead = now();
    const pixels = bitmap ? readBitmap(bitmap, width, height) : new Uint8Array(buffer);
    const readMs = now() - tRead;

    const src = track(new c.Mat(height, width, c.CV_8UC4));
    src.data.set(pixels);

    const gray = track(new c.Mat());
    c.cvtColor(src, gray, c.COLOR_RGBA2GRAY);

    // ความสว่าง: ค่าเฉลี่ย 0–255
    const brightness = c.mean(gray)[0];

    // ความคม: Variance of Laplacian — ขึ้นกับปริมาณตัวอักษรด้วย จึงต้องใช้แบบเทียบสัมพัทธ์ใน M3
    const lap = track(new c.Mat());
    c.Laplacian(gray, lap, c.CV_64F);
    const mean = track(new c.Mat());
    const std = track(new c.Mat());
    c.meanStdDev(lap, mean, std);
    const sharpness = std.doubleAt(0, 0) ** 2;

    // Lab ใช้ทั้งให้คะแนนขอบและวิธี enhanced
    const rgb = track(new c.Mat());
    c.cvtColor(src, rgb, c.COLOR_RGBA2RGB);
    const lab = track(new c.Mat());
    c.cvtColor(rgb, lab, c.COLOR_RGB2Lab);
    const labImg = { data: lab.data, width, height };

    const frameArea = width * height;
    const evaluated = [];

    // วิธีที่ 1: gray
    const tGray = now();
    let edges = track(grayEdges(c, gray, track));
    let edgesSize = { width, height };
    evaluated.push(...scoreAll(labImg, searchCandidates(c, edges, c.RETR_EXTERNAL, false, track), 'gray'));
    evaluated.push(...scoreAll(labImg, regionCandidates(c, edges, track), 'gray-region'));
    let chosen = choose(evaluated, width, height, prevQuad);
    const grayMs = now() - tGray;

    // วิธีที่ 2: enhanced (เมื่อวิธีแรกไม่มีตัวเลือกที่ผ่านเกณฑ์)
    let enhancedMs = 0;
    if (!chosen && detectConf.enhanced?.enabled) {
      const tEnh = now();
      const { edges: enhEdges, scale } = enhancedEdges(c, lab, track);
      edges = track(enhEdges);
      edgesSize = { width: enhEdges.cols, height: enhEdges.rows };
      const found = [...searchCandidates(c, edges, c.RETR_LIST, true, track), ...regionCandidates(c, edges, track, true)]
        .map((q) => {
          const pts = q.pts.map((p) => ({ x: p.x / scale, y: p.y / scale }));
          return { ...q, pts, area: polygonArea(pts) };   // พื้นที่ในพิกัดเดียวกับวิธีแรก
        });
      for (const q of scoreAll(labImg, found, 'enhanced')) evaluated.push(q);
      chosen = choose(evaluated, width, height, prevQuad);
      enhancedMs = now() - tEnh;
    }

    // ดูดมุมเข้าหาขอบกระดาษจริงบนช่อง L (ไม่ขึ้นกับว่า contour เละแค่ไหน)
    let snapped = 0;
    if (chosen && detectConf.snap?.enabled) {
      const L = (x, y) => labImg.data[(y * width + x) * 3];
      const r = snapQuad(L, width, height, orderCorners(chosen.pts), detectConf.snap, detectConf.snap.samplesLive);
      chosen = { ...chosen, pts: r.pts };
      snapped = r.sides;
    }

    // ตัวเลือกที่ดีที่สุดแม้ไม่ผ่าน ไว้ดูใน debug ว่าคะแนนห่างจากเกณฑ์เท่าไร
    const top = chosen ?? evaluated.sort((x, y) => y.contrast - x.contrast)[0] ?? null;

    return {
      width,
      height,
      quad: chosen ? normalize(orderCorners(chosen.pts), width, height) : null,
      areaRatio: chosen ? polygonArea(chosen.pts) / frameArea : 0,
      strategy: chosen ? chosen.strategy + (chosen.hull ? '-hull' : '') : null,
      snapped,
      candidates: evaluated.length,
      passed: evaluated.filter((q) => q.ok).length,
      score: top ? { contrast: round1(top.contrast), sides: top.sides, paper: round1(top.paper), valid: round1(top.valid) } : null,
      brightness: Math.round(brightness),
      sharpness: Math.round(sharpness),
      readMs,
      grayMs,
      enhancedMs,
      detectMs: now() - t0,
      // ภาพขอบสำหรับ ?view=edges (คัดลอกออกจาก WASM heap)
      edges: wantEdges ? new Uint8Array(edges.data).buffer : null,
      edgesWidth: edgesSize.width,
      edgesHeight: edgesSize.height,
    };
  } finally {
    mats.forEach((m) => m.delete());
  }
}

const round1 = (v) => Math.round(v * 10) / 10;

function scoreAll(labImg, candidates, strategy) {
  const margin = 0.02 * Math.max(labImg.width, labImg.height);
  const inFrame = (pts) => pts.every((p) =>
    p.x >= -margin && p.y >= -margin && p.x <= labImg.width + margin && p.y <= labImg.height + margin);
  return candidates.filter((q) => inFrame(q.pts)).map((q) => {
    const s = scoreBoundary(labImg, q.pts);
    const conf = detectConf.score;
    const ok = s.valid >= conf.minValid && s.contrast >= conf.minContrast && s.paper >= conf.minPaper;
    return { ...q, ...s, strategy, ok };
  });
}

/**
 * จากตัวเลือกที่ผ่านเกณฑ์:
 *  - ถ้ามีตัวที่อยู่ใกล้กรอบเดิม (prevQuad) ใช้ตัวนั้น กรอบจึงไม่สลับไปมาระหว่างสี่เหลี่ยมที่ผ่านพอ ๆ กัน
 *  - ไม่มี → เลือกตัวที่ใหญ่ที่สุด (กระดาษครอบกรอบที่พิมพ์ข้างในเสมอ)
 */
function choose(evaluated, width, height, prevQuad) {
  const ok = evaluated.filter((q) => q.ok);
  if (!ok.length) return null;
  if (prevQuad) {
    let near = null;
    let nearDist = Infinity;
    for (const q of ok) {
      const n = normalize(orderCorners(q.pts), width, height);
      const d = n.reduce((sum, p, i) => sum + Math.hypot(p.x - prevQuad[i].x, p.y - prevQuad[i].y), 0) / 4;
      if (d < nearDist) { nearDist = d; near = q; }
    }
    if (near && nearDist <= detectConf.stickRadius) return near;
  }
  return ok.reduce((best, q) => (q.area > best.area ? q : best));
}

/**
 * สุ่มจุดตามแต่ละด้าน แล้วเทียบสี Lab ห่างจากเส้นเข้าไปด้านในและออกไปด้านนอก sampleDist px
 *  contrast : ค่ามัธยฐานของระยะสี (ΔE แบบ 8-bit) ระหว่างด้านในกับด้านนอก
 *  paper    : สัดส่วนจุดด้านในที่ "ดูเป็นกระดาษ" (สว่างพอ และสีไม่จัด)
 *  valid    : สัดส่วนจุดด้านนอกที่ยังอยู่ในเฟรม (ต่ำ = เอกสารล้นขอบเฟรม)
 */
function scoreBoundary(img, pts) {
  const { sampleDist: d, samplesPerSide: n, paperMinL, paperMaxChroma } = detectConf.score;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const sideContrast = [];
  let validCount = 0;
  let paperHits = 0;
  let insideCount = 0;
  let total = 0;

  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = dist(a, b);
    if (!len) { sideContrast.push(0); continue; }
    let nx = -(b.y - a.y) / len;
    let ny = (b.x - a.x) / len;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    if (nx * (mx - cx) + ny * (my - cy) < 0) { nx = -nx; ny = -ny; }   // ให้ชี้ออกนอกรูป

    const diffs = [];
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      total++;
      const inside = sampleLab(img, px - nx * d, py - ny * d);
      if (!inside) continue;
      insideCount++;
      const chroma = Math.hypot(inside[1] - 128, inside[2] - 128);
      if (inside[0] >= paperMinL && chroma <= paperMaxChroma) paperHits++;
      const outside = sampleLab(img, px + nx * d, py + ny * d);
      if (!outside) continue;
      diffs.push(Math.hypot(inside[0] - outside[0], inside[1] - outside[1], inside[2] - outside[2]));
    }
    validCount += diffs.length;
    diffs.sort((x, y) => x - y);
    // ด้านที่ไม่มีจุดให้วัด (ล้นเฟรม) นับเป็น 0 → ไม่ผ่าน เพราะต้องเห็นครบ 4 มุม
    sideContrast.push(diffs.length >= n * 0.3 ? diffs[Math.floor(diffs.length / 2)] : 0);
  }
  return {
    // ใช้ด้านที่อ่อนที่สุด: ทุกด้านต้องเป็นขอบจริง ด้านที่ลากผ่านกลางกระดาษ (สองฝั่งขาว) จะถูกคัดทิ้ง
    contrast: Math.min(...sideContrast),
    sides: sideContrast.map((v) => Math.round(v)),
    paper: insideCount ? paperHits / insideCount : 0,
    valid: total ? validCount / total : 0,
  };
}

function sampleLab({ data, width, height }, x, y) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= width || yi >= height) return null;
  const i = (yi * width + xi) * 3;
  return [data[i], data[i + 1], data[i + 2]];
}

/** วิธีที่ 1: Blur → Canny (threshold จาก Otsu) → Dilate */
function grayEdges(c, gray, track) {
  const blurred = track(new c.Mat());
  c.GaussianBlur(gray, blurred, new c.Size(5, 5), 0);
  const bin = track(new c.Mat());
  const otsu = c.threshold(blurred, bin, 0, 255, c.THRESH_BINARY + c.THRESH_OTSU);
  const edges = new c.Mat();
  c.Canny(blurred, edges, otsu * 0.5, otsu);
  const kernel = track(c.Mat.ones(3, 3, c.CV_8U));
  c.dilate(edges, edges, kernel);
  return edges;
}

/**
 * วิธีที่ 2: ขอบจากทั้ง 3 ช่องของ Lab รวมกัน แล้วปิดช่องว่างด้วย Morphological Close
 * ย่อภาพเหลือ enhanced.longSide ก่อน เพราะวิธีนี้หนักกว่าวิธีแรกหลายเท่า (คืน scale ไว้แปลงพิกัดกลับ)
 */
function enhancedEdges(c, lab, track) {
  const e = detectConf.enhanced;
  let input = lab;
  let scale = 1;
  const longSide = Math.max(lab.cols, lab.rows);
  if (e.longSide && longSide > e.longSide) {
    scale = e.longSide / longSide;
    input = track(new c.Mat());
    c.resize(lab, input, new c.Size(Math.round(lab.cols * scale), Math.round(lab.rows * scale)), 0, 0, c.INTER_AREA);
  }
  const planes = track(new c.MatVector());
  c.split(input, planes);

  const combined = c.Mat.zeros(input.rows, input.cols, c.CV_8UC1);
  const ksize = new c.Size(e.blur, e.blur);
  for (let i = 0; i < 3; i++) {
    const channel = track(planes.get(i));
    const prepared = track(new c.Mat());
    if (i === 0) applyClahe(c, channel, prepared, e.clipLimit);   // L: ความสว่าง
    else stretch(channel, prepared, e.stretchPercent, e.maxGain);  // a, b: โทนสี
    c.GaussianBlur(prepared, prepared, ksize, 0);
    const channelEdges = track(new c.Mat());
    c.Canny(prepared, channelEdges, e.cannyLow, e.cannyHigh);
    c.bitwise_or(combined, channelEdges, combined);
  }
  const kernel = track(c.Mat.ones(e.closeKernel, e.closeKernel, c.CV_8U));
  c.morphologyEx(combined, combined, c.MORPH_CLOSE, kernel);
  return { edges: combined, scale };
}

function applyClahe(c, src, dst, clipLimit) {
  if (typeof c.CLAHE === 'function') {
    const clahe = new c.CLAHE(clipLimit, new c.Size(8, 8));
    try {
      clahe.apply(src, dst);
    } finally {
      clahe.delete();
    }
  } else {
    c.equalizeHist(src, dst);
  }
}

/** ยืดช่วงค่าโดยตัดหัวท้าย pct% (กันหมึกสีบนเอกสารดึงช่วงทั้งหมด) และจำกัดอัตราขยายกัน noise */
function stretch(src, dst, pct, maxGain) {
  const data = src.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  const cut = (data.length * pct) / 100;
  let lo = 0;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < cut;) lo++;
  let hi = 255;
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < cut;) hi--;
  const gain = Math.min(255 / Math.max(hi - lo, 1), maxGain);
  src.convertTo(dst, -1, gain, -lo * gain);
}

/**
 * หาสี่เหลี่ยมจาก "พื้นที่" แทนเส้น: ระบายเต็มทุกรูปที่ขอบล้อมไว้ แล้วกัด (open) ส่วนที่บางกว่า kernel ทิ้ง
 * ใช้กับกรณีที่เส้นอื่น (รอยต่อโต๊ะ ขอบแผ่นรอง) มาชนขอบกระดาษจนต่อเป็นรูปเดียวกัน:
 * เส้นที่ยื่นออกไปบางแค่ไม่กี่ px จึงหายไป เหลือพื้นที่กระดาษที่เป็นสี่เหลี่ยม
 */
function regionCandidates(c, edges, track, allowHull = false) {
  const outer = track(new c.MatVector());
  const hierarchy = track(new c.Mat());
  c.findContours(edges, outer, hierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);
  const mask = track(c.Mat.zeros(edges.rows, edges.cols, c.CV_8UC1));
  c.drawContours(mask, outer, -1, new c.Scalar(255), -1);
  const k = Math.max(3, Math.round(Math.max(edges.cols, edges.rows) * detectConf.regionOpen) | 1);
  const kernel = track(c.Mat.ones(k, k, c.CV_8U));
  c.morphologyEx(mask, mask, c.MORPH_OPEN, kernel);
  return searchCandidates(c, mask, c.RETR_EXTERNAL, allowHull, track);
}

function searchCandidates(c, edges, mode, allowHull, track) {
  const contours = track(new c.MatVector());
  const hierarchy = track(new c.Mat());
  // เก็บทุกจุดของขอบ (NONE) เพื่อใช้ลากเส้นตรงที่พอดีที่สุดในแต่ละด้าน
  c.findContours(edges, contours, hierarchy, mode, c.CHAIN_APPROX_NONE);
  return findCandidates(contours, edges.cols, edges.rows, allowHull);
}

/**
 * รวบรวมสี่เหลี่ยมทุกตัวที่ผ่านเกณฑ์ ขนาด · นูน · มุมภายใน (เรียงจากใหญ่ไปเล็ก ไม่เกิน maxCandidates)
 * contour ที่ไม่เป็น 4 มุมตรง ๆ และ allowHull จะลองใช้ Convex Hull ของ contour แทน
 */
function findCandidates(contours, width, height, allowHull) {
  const frameArea = width * height;
  const bounds = { width, height };
  const minArea = frameArea * detectConf.minAreaRatio;
  const maxArea = frameArea * detectConf.maxAreaRatio;
  const inRange = (a) => a >= minArea && a <= maxArea;
  const out = [];

  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    try {
      let direct = false;
      const area = geom.contourArea(cnt);
      if (inRange(area)) {
        const peri = geom.arcLength(cnt);
        for (const eps of detectConf.epsilons) {
          // OpenCV 5 คืนผลของ vector เป็น Mat 1 มิติ จึงนับจำนวนจุดแทนการดู .rows
          const rough = geom.approx(cnt, eps * peri);
          if (!isDocumentQuad(rough)) continue;
          // มุมจาก approxPolyDP เป็นจุดบนขอบที่สั่นตาม noise; ใช้จุดตัดของเส้นที่ fit แทน
          const fitted = fitCorners(matPoints(cnt), rough, bounds);
          const pts = fitted && isDocumentQuad(fitted) ? fitted : rough;
          out.push({ pts, area: polygonArea(pts), hull: false });
          direct = true;
          break;
        }
      }

      if (allowHull && !direct) {
        const pts = matPoints(cnt);
        if (boundingArea(pts) < minArea) continue;
        const hull = convexHull(pts);
        const hullArea = polygonArea(hull);
        if (!inRange(hullArea)) continue;
        const hullPeri = perimeter(hull);
        for (const eps of detectConf.epsilons) {
          const rough = approxClosed(hull, eps * hullPeri);
          if (rough.length !== 4) continue;
          // มุมกระดาษมักหายไปเมื่อขอบขาดเป็นช่วง จึงต่อเส้นขอบแต่ละด้านแล้วหาจุดตัดเป็นมุมจริง
          const q = fitCorners(pts, rough, bounds) ?? refineCorners(hull, rough);
          // hull ต้องเต็มสี่เหลี่ยมเกือบทั้งหมด ไม่ใช่รูปหลายเหลี่ยมที่ถูกบีบให้เหลือ 4 มุม
          if (q && isDocumentQuad(q) && hullArea / polygonArea(q) >= detectConf.hullFill) {
            out.push({ pts: q, area: polygonArea(q), hull: true });
            break;
          }
        }
      }
    } finally {
      cnt.delete();
    }
  }
  out.sort((x, y) => y.area - x.area);
  return out.slice(0, detectConf.maxCandidates);
}

/**
 * หามุมจากจุดตัดของเส้นตรง 4 เส้นที่ fit ผ่านจุดขอบจริง
 * แต่ละด้านใช้เฉพาะจุดช่วงกลาง 10–90% ของด้าน และห่างจากแนวด้านไม่เกิน fitTolerance
 * แล้ว fit ซ้ำโดยตัดจุดที่ห่างเส้นเกิน 2.5 เท่าของค่ามัธยฐานทิ้ง (กันกิ่งจากตัวอักษร เงา ขอบโต๊ะ)
 * ถ้ามุมที่ได้หลุดนอกเฟรม หรือขยับจากมุมเดิมเกิน fitMaxShift คืน null ให้ใช้มุมเดิม
 */
function fitCorners(points, rough, bounds) {
  const lines = [];
  for (let s = 0; s < 4; s++) {
    const a = rough[s];
    const b = rough[(s + 1) % 4];
    const len = dist(a, b);
    if (!len) return null;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const tol = Math.max(1.5, len * detectConf.fitTolerance);
    let near = [];
    for (const p of points) {
      const t = (p.x - a.x) * ux + (p.y - a.y) * uy;
      if (t < len * 0.1 || t > len * 0.9) continue;
      if (Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux) <= tol) near.push(p);
    }
    if (near.length < detectConf.fitMinPoints) return null;
    let line = fitLine(near);
    for (let iter = 0; iter < 2; iter++) {
      const res = near.map((p) => lineDistance(p, line));
      const med = [...res].sort((x, y) => x - y)[Math.floor(res.length / 2)];
      const kept = near.filter((_, i) => res[i] <= Math.max(1, med * 2.5));
      if (kept.length < detectConf.fitMinPoints || kept.length === near.length) break;
      near = kept;
      line = fitLine(near);
    }
    lines.push(line);
  }

  const maxShift = detectConf.fitMaxShift * Math.max(bounds.width, bounds.height);
  const margin = 0.02 * Math.max(bounds.width, bounds.height);
  const corners = [];
  for (let s = 0; s < 4; s++) {
    // มุม s อยู่ระหว่างด้าน s-1 (เข้า) กับด้าน s (ออก)
    const p = intersect(lines[(s + 3) % 4], lines[s]);
    if (!p) return null;
    if (dist(p, rough[s]) > maxShift) return null;
    if (p.x < -margin || p.y < -margin || p.x > bounds.width + margin || p.y > bounds.height + margin) return null;
    corners.push(p);
  }
  return corners;
}

/** ระยะตั้งฉากจากจุดถึงเส้น (เส้นแทนด้วยจุด 2 จุดห่างกัน 1 หน่วย ตามที่ fitLine คืน) */
function lineDistance(p, [a, b]) {
  return Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x));
}

/** เส้นตรงที่พอดีที่สุดผ่านจุดชุดหนึ่ง (แกนหลักของ covariance) คืนเป็นจุด 2 จุดบนเส้น */
function fitLine(pts) {
  let mx = 0;
  let my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return [{ x: mx, y: my }, { x: mx + Math.cos(angle), y: my + Math.sin(angle) }];
}

/**
 * ใช้ขอบที่ยาวที่สุดของ hull ในแต่ละด้านเป็นเส้นตรงของด้านนั้น แล้วหาจุดตัดของด้านที่ติดกัน
 * rough คือ 4 จุดที่อยู่บน hull (ได้จาก approxClosed ซึ่งเลือกจากจุดเดิมเสมอ)
 */
function refineCorners(hull, rough) {
  const idx = rough.map((p) => hull.indexOf(p));
  if (idx.some((i) => i < 0)) return null;
  const order = [...idx].sort((a, b) => a - b);
  const n = hull.length;
  const lines = [];
  for (let s = 0; s < 4; s++) {
    const from = order[s];
    const to = order[(s + 1) % 4] + (s === 3 ? n : 0);
    let bestLen = -1;
    let line = null;
    for (let k = from; k < to; k++) {
      const a = hull[k % n];
      const b = hull[(k + 1) % n];
      const len = dist(a, b);
      if (len > bestLen) { bestLen = len; line = [a, b]; }
    }
    if (!line) return null;
    lines.push(line);
  }
  const corners = [];
  for (let s = 0; s < 4; s++) {
    const p = intersect(lines[(s + 3) % 4], lines[s]);
    if (!p) return null;
    corners.push(p);
  }
  return corners;
}

function intersect([p1, p2], [p3, p4]) {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(d) < 1e-9) return null;
  const a = p1.x * p2.y - p1.y * p2.x;
  const b = p3.x * p4.y - p3.y * p4.x;
  return {
    x: (a * (p3.x - p4.x) - (p1.x - p2.x) * b) / d,
    y: (a * (p3.y - p4.y) - (p1.y - p2.y) * b) / d,
  };
}

function isDocumentQuad(pts) {
  return pts.length === 4 && isConvexPolygon(pts) && anglesWithin(pts, detectConf.minAngle, detectConf.maxAngle);
}

/** มุมภายในทุกมุมต้องอยู่ในช่วง กันรูปสี่เหลี่ยมบิดเบี้ยวที่ไม่น่าใช่กระดาษ */
function anglesWithin(q, minDeg, maxDeg) {
  for (let i = 0; i < q.length; i++) {
    const a = q[(i + q.length - 1) % q.length];
    const b = q[i];
    const c = q[(i + 1) % q.length];
    const v1x = a.x - b.x;
    const v1y = a.y - b.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y));
    const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (!(deg >= minDeg && deg <= maxDeg)) return false;
  }
  return true;
}

function boundingArea(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return (maxX - minX) * (maxY - minY);
}

/** Convex Hull แบบ Monotone Chain (ไม่พึ่งโมดูล geometry ของ OpenCV 5) */
function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/* -------------------------------------------------------------- geometry
 * OpenCV 5 ย้ายฟังก์ชันเรขาคณิต (เช่น isContourConvex) จาก imgproc ไปโมดูล geometry
 * ซึ่ง build ของ opencv.js อาจไม่ได้รวมไว้ จึงใช้ของ OpenCV เมื่อมี และใช้ JS แทนเมื่อไม่มี
 * contour บนเฟรม 480 px มีจุดไม่กี่พันจุด ฝั่ง JS จึงเร็วพอ
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

/* ------------------------------------------------------------------ snap
 * ดูดแต่ละด้านของกรอบเข้าหาขอบกระดาษจริง
 *  ตามแนวด้าน สุ่มจุดช่วงกลาง 10–90% แล้วไล่ตั้งฉากกับเส้นในระยะ ±radius
 *  ที่แต่ละตำแหน่งเทียบค่าเฉลี่ยความสว่าง "band" px ด้านนอกกับด้านใน
 *  ขอบกระดาษ = ขั้นบันได (ในสว่าง นอกมืด หรือกลับกัน) → ต่างกันมาก
 *  เส้นพิมพ์บาง ๆ บนฟอร์ม = ขาวทั้งสองข้าง → ต่างกันน้อย จึงไม่ถูกดูดเข้าไป
 *  จุดที่ได้ fit เป็นเส้นแบบตัดจุดแปลกปลอม แล้วใช้จุดตัดเป็นมุมใหม่
 *  ด้านที่จุดไม่พอ หรือมุมใหม่ขยับเกิน 2×radius / หลุดเฟรม → ใช้ของเดิม
 *
 * L(x, y) คืนความสว่าง 0–255 ของพิกเซล (จำนวนเต็ม) · quad เรียง TL, TR, BR, BL ในพิกัดพิกเซล
 */
function snapQuad(L, width, height, quad, conf, samples) {
  const longSide = Math.max(width, height);
  const radius = Math.max(2, Math.round(conf.radius * longSide));
  const band = Math.max(1, Math.round(conf.band * longSide));
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const read = (x, y) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return null;
    return L(xi, yi);
  };

  const lines = [];
  let sides = 0;
  for (let s = 0; s < 4; s++) {
    const a = quad[s];
    const b = quad[(s + 1) % 4];
    const len = dist(a, b);
    let nx = -(b.y - a.y) / len;
    let ny = (b.x - a.x) / len;
    if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0) { nx = -nx; ny = -ny; }

    const found = [];
    for (let j = 0; j < samples; j++) {
      const t = 0.1 + (0.8 * (j + 0.5)) / samples;
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      // ค่าความสว่างตามแนวตั้งฉาก ตั้งแต่ -(radius+band) ถึง +(radius+band)
      const span = radius + band;
      const prof = [];
      let ok = true;
      for (let d = -span; d <= span; d++) {
        const v = read(px + nx * d, py + ny * d);
        if (v === null) { ok = false; break; }
        prof.push(v);
      }
      if (!ok) continue;
      // prefix sum เพื่อหาค่าเฉลี่ยช่วงได้เร็ว
      const pre = [0];
      for (const v of prof) pre.push(pre.at(-1) + v);
      let bestD = 0;
      let bestDiff = 0;
      for (let d = -radius; d <= radius; d++) {
        const i = d + span;                                  // index ของตำแหน่ง d ใน prof
        const inside = (pre[i] - pre[i - band]) / band;      // band px ก่อนถึงตำแหน่งนี้ (ด้านใน)
        const outside = (pre[i + 1 + band] - pre[i + 1]) / band;   // band px หลังตำแหน่งนี้ (ด้านนอก)
        const diff = outside - inside;
        if (Math.abs(diff) > Math.abs(bestDiff)) { bestDiff = diff; bestD = d; }
      }
      if (Math.abs(bestDiff) >= conf.minStep) {
        found.push({ x: px + nx * bestD, y: py + ny * bestD, sign: Math.sign(bestDiff) });
      }
    }

    // ขอบกระดาษหนึ่งด้านควรเป็นทิศเดียวกันตลอด (ในสว่างกว่านอก หรือกลับกัน) ตัดจุดที่สวนทาง
    const pos = found.filter((p) => p.sign > 0).length;
    const pts = found.filter((p) => (pos * 2 >= found.length ? p.sign > 0 : p.sign < 0));
    if (pts.length >= Math.max(6, samples * conf.minCoverage)) {
      let near = pts;
      let line = fitLine(near);
      for (let iter = 0; iter < 2; iter++) {
        const res = near.map((p) => lineDistance(p, line));
        const med = [...res].sort((x, y) => x - y)[Math.floor(res.length / 2)];
        const kept = near.filter((_, i) => res[i] <= Math.max(1, med * 2.5));
        if (kept.length < 6 || kept.length === near.length) break;
        near = kept;
        line = fitLine(near);
      }
      lines.push(line);
      sides++;
    } else {
      lines.push([a, b]);
    }
  }

  const out = [];
  for (let s = 0; s < 4; s++) {
    const p = intersect(lines[(s + 3) % 4], lines[s]);
    const okPoint = p && dist(p, quad[s]) <= radius * 2 && p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height;
    out.push(okPoint ? p : quad[s]);
  }
  if (!isDocumentQuad(out)) return { pts: quad, sides: 0 };
  return { pts: out, sides };
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
    let corners = (quad ?? FULL_FRAME).map((p) => ({ x: p.x * width, y: p.y * height }));

    // ดูดมุมอีกรอบบนภาพความละเอียดเต็ม: กรอบบนจอผ่านการ smooth และหามาจากภาพย่อ
    // จึงคลาดจากขอบจริงได้หลายสิบ px ที่ 4K
    let snapped = 0;
    let snapShift = 0;
    const tSnap = now();
    if (quad && detectConf.snap?.enabled) {
      const px = new Uint8Array(buffer);
      const L = (x, y) => {
        const i = (y * width + x) * 4;
        return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      };
      const r = snapQuad(L, width, height, corners, detectConf.snap, detectConf.snap.samplesCapture);
      snapShift = r.pts.reduce((sum, p, i) => sum + dist(p, corners[i]), 0) / 4;
      corners = r.pts;
      snapped = r.sides;
    }
    const snapMs = now() - tSnap;
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
      snapped,
      snapShiftPx: Math.round(snapShift),
      snapMs: Math.round(snapMs),
      warpMs: now() - t0,
    };
  } finally {
    mats.forEach((m) => m.delete());
  }
}