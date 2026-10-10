import { CONFIG, APP_VERSION } from './config.js';
import { device, environmentChecks } from './utils/device.js';
import { CameraService, explainCameraError } from './camera/camera-service.js';
import { FrameGrabber, grabBitmap, canGrabBitmap } from './camera/frame-grabber.js';
import { VisionClient } from './vision/vision-client.js';
import { Overlay } from './ui/overlay.js';
import { Stats, DebugPanel } from './ui/debug-panel.js';

const $ = (id) => document.getElementById(id);

const el = {
  startScreen: $('screen-start'),
  scanScreen: $('screen-scan'),
  checks: $('env-checks'),
  startBtn: $('btn-start'),
  startMsg: $('start-msg'),
  video: $('video'),
  overlay: $('overlay'),
  edges: $('edges'),
  pill: $('status-pill'),
  debug: $('debug'),
  debugRows: $('debug-rows'),
  debugBtn: $('btn-debug'),
  copyBtn: $('btn-copy'),
  cameraSelect: $('camera-select'),
  captureBtn: $('btn-capture'),
  sheet: $('sheet-result'),
  resultImg: $('result-img'),
  resultMeta: $('result-meta'),
  closeBtn: $('btn-close'),
};

const state = {
  running: false,      // อยู่หน้าสแกน
  paused: false,       // หยุดตรวจจับชั่วคราว (ดูผล / สลับแอป)
  busy: false,         // worker กำลังทำงานกับเฟรมก่อนหน้า
  capturing: false,
  lastSentAt: 0,
  cvInfo: null,
  cvError: null,
  cvProgress: 'เริ่มโหลด',
  camInfo: null,
  quad: null,
  grabMode: CONFIG.grab === 'bitmap' && canGrabBitmap ? 'bitmap' : 'canvas',
  lastWarp: null,
  resultUrl: null,
};

const camera = new CameraService(el.video);
const detectGrabber = new FrameGrabber();
const fullGrabber = new FrameGrabber();
const overlay = new Overlay(el.overlay, el.video);
const stats = new Stats();
const debugPanel = new DebugPanel(el.debugRows);
let vision = null;

/* ---------------------------------------------------------------- start */

function renderChecks() {
  const checks = environmentChecks();
  el.checks.innerHTML = '';
  for (const c of checks) {
    const li = document.createElement('li');
    li.className = [c.ok ? 'pass' : 'fail', c.optional ? 'optional' : ''].join(' ');
    li.textContent = c.label;
    if (!c.ok && c.note) {
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent = c.note;
      li.append(note);
    }
    el.checks.append(li);
  }
  const blocked = checks.some((c) => c.required && !c.ok);
  el.startBtn.disabled = blocked;
  if (blocked) el.startMsg.textContent = 'เครื่องหรือ Browser นี้ยังไม่พร้อม แก้รายการสีแดงด้านบนก่อน';
}

async function startScan() {
  el.startBtn.disabled = true;
  el.startMsg.textContent = '';
  try {
    state.camInfo = await camera.start();
  } catch (err) {
    el.startMsg.textContent = explainCameraError(err);
    el.startBtn.disabled = false;
    return;
  }

  el.startScreen.hidden = true;
  el.scanScreen.hidden = false;
  state.running = true;
  overlay.resize();
  populateCameras();
  loadVision();
  requestAnimationFrame(tick);
}

async function populateCameras() {
  try {
    const cams = await camera.listCameras();
    el.cameraSelect.innerHTML = '';
    cams.forEach((cam, i) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `กล้อง ${i + 1}`;
      opt.selected = cam.deviceId === camera.deviceId;
      el.cameraSelect.append(opt);
    });
    el.cameraSelect.hidden = cams.length < 2;
  } catch {
    el.cameraSelect.hidden = true;
  }
}

async function loadVision() {
  setPill('กำลังโหลด OpenCV');
  const { localUrl, remoteUrl, forceRemote, loadTimeoutMs } = CONFIG.opencv;
  const local = new URL(localUrl, location.href).href;
  const urls = forceRemote ? [remoteUrl] : [local, remoteUrl];
  try {
    vision = new VisionClient();
    vision.onProgress = onCvProgress;
    state.cvInfo = await vision.init({ urls, timeoutMs: loadTimeoutMs, detect: CONFIG.detect });
    el.captureBtn.disabled = false;
    setPill('เล็งไปที่เอกสาร');
  } catch (err) {
    state.cvError = err.message;
    setPill('โหลด OpenCV ไม่สำเร็จ', 'error');
    console.error(err);
  }
  debugPanel.render(state, stats, true);
}

function onCvProgress(p) {
  const file = p.url?.includes('docs.opencv.org') ? 'remote' : 'local';
  if (p.phase === 'download') {
    if (p.note) {
      state.cvProgress = `${file}: ${p.note}`;
    } else {
      const mb = (p.loaded / 1048576).toFixed(1);
      const pct = p.total ? ` (${Math.round((p.loaded / p.total) * 100)}%)` : '';
      state.cvProgress = `${file}: ดาวน์โหลด ${mb} MB${pct}`;
      setPill(`กำลังโหลด OpenCV${pct}`);
    }
  } else if (p.phase === 'evaluate') {
    state.cvProgress = `${file}: ประมวลผลสคริปต์${p.bytes ? ` ${(p.bytes / 1048576).toFixed(1)} MB` : ''}`;
    setPill('กำลังเตรียม OpenCV');
  } else if (p.phase === 'runtime') {
    state.cvProgress = `รอ runtime พร้อม (cv เป็น ${p.cvType})`;
  } else if (p.phase === 'fallback') {
    state.cvProgress = `${file} ไม่สำเร็จ: ${p.error}`;
  }
  debugPanel.render(state, stats, true);
}

/* ----------------------------------------------------------------- loop */

function tick() {
  if (!state.running) return;
  requestAnimationFrame(tick);

  const ready = state.cvInfo && !state.busy && !state.paused && !state.capturing && el.video.videoWidth;
  if (ready && performance.now() - state.lastSentAt >= CONFIG.detect.minIntervalMs) {
    runDetect();
  }
  overlay.render(performance.now());
  debugPanel.render(state, stats, false, overlay.stability());
}

async function runDetect() {
  state.busy = true;
  state.lastSentAt = performance.now();
  try {
    const t0 = performance.now();
    const frame = await grabFrame();
    if (!frame) return;
    const grabMs = performance.now() - t0;

    const r = await vision.detect(frame, showEdges, state.quad);
    const roundMs = performance.now() - t0;
    if (state.paused || state.capturing) return;

    stats.add({
      grabMs,
      readMs: r.readMs,
      detectMs: r.detectMs,
      roundMs,
      found: Boolean(r.quad),
      strategy: r.strategy,
      snapped: r.snapped,
      candidates: r.candidates,
      passed: r.passed,
      score: r.score,
      areaRatio: r.areaRatio,
      brightness: r.brightness,
      sharpness: r.sharpness,
      width: r.width,
      height: r.height,
    });

    state.quad = overlay.update(r.quad);
    setPill(state.quad ? 'พบเอกสาร' : 'เล็งไปที่เอกสาร', state.quad ? 'found' : '');
    if (r.edges) drawEdges(r.edges, r.edgesWidth, r.edgesHeight);
  } catch (err) {
    console.error('detect failed', err);
  } finally {
    state.busy = false;
  }
}

/** ใช้ createImageBitmap ถ้าได้ ถ้าใช้ไม่ได้บนเครื่องนี้จะสลับไปแบบ canvas ถาวร */
async function grabFrame() {
  const longSide = CONFIG.detect.longSide;
  if (state.grabMode === 'bitmap') {
    try {
      return await grabBitmap(el.video, longSide);
    } catch (err) {
      console.warn('createImageBitmap ใช้ไม่ได้ สลับเป็น canvas', err);
      state.grabMode = 'canvas';
    }
  }
  return detectGrabber.grab(el.video, longSide);
}

/* ---------------------------------------------------------- edges view */

const showEdges = CONFIG.debug.view === 'edges';
const edgesCtx = el.edges.getContext('2d');

function drawEdges(buffer, width, height) {
  if (el.edges.width !== width || el.edges.height !== height) {
    el.edges.width = width;
    el.edges.height = height;
  }
  const src = new Uint8Array(buffer);
  const img = edgesCtx.createImageData(width, height);
  for (let i = 0, j = 0; i < src.length; i++, j += 4) {
    const v = src[i];
    img.data[j] = v;
    img.data[j + 1] = v ? 178 : 0;
    img.data[j + 2] = v ? 62 : 0;
    img.data[j + 3] = 255;
  }
  edgesCtx.putImageData(img, 0, 0);
}

/* -------------------------------------------------------------- capture */

async function captureTest() {
  if (!state.cvInfo || state.capturing) return;
  state.capturing = true;
  el.captureBtn.disabled = true;
  if (navigator.vibrate) navigator.vibrate(30);

  const quad = state.quad;
  try {
    const t0 = performance.now();
    const frame = fullGrabber.grab(el.video, 0);
    const grabMs = performance.now() - t0;
    fullGrabber.release();
    if (!frame) throw new Error('ยังไม่มีภาพจากกล้อง');
    const frameSize = `${frame.width}×${frame.height}`;

    const r = await vision.warp(frame, quad, CONFIG.output.longSide);

    const t1 = performance.now();
    const blob = await encodeJpeg(r);
    const encodeMs = performance.now() - t1;

    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = URL.createObjectURL(blob);

    state.lastWarp = {
      frameSize,
      quadUsed: r.quadUsed,
      snapped: r.snapped,
      snapShiftPx: r.snapShiftPx,
      snapMs: r.snapMs,
      naturalSize: `${r.naturalWidth}×${r.naturalHeight}`,
      outputSize: `${r.width}×${r.height}`,
      grabMs: Math.round(grabMs),
      warpMs: Math.round(r.warpMs),
      encodeMs: Math.round(encodeMs),
      totalMs: Math.round(performance.now() - t0),
      jpegKB: Math.round(blob.size / 1024),
    };
    showResult();
  } catch (err) {
    setPill(`ถ่ายทดสอบไม่สำเร็จ: ${err.message}`, 'error');
    console.error(err);
    state.capturing = false;
    el.captureBtn.disabled = false;
  }
}

function encodeJpeg({ buffer, width, height }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      canvas.width = 0;   // คืนหน่วยความจำทันที
      canvas.height = 0;
      blob ? resolve(blob) : reject(new Error('เข้ารหัส JPEG ไม่สำเร็จ'));
    }, 'image/jpeg', CONFIG.output.jpegQuality);
  });
}

function showResult() {
  const w = state.lastWarp;
  el.resultImg.src = state.resultUrl;
  const rows = [
    ['เฟรมจากกล้อง', w.frameSize],
    ['ใช้กรอบที่ตรวจจับ', w.quadUsed ? 'ใช่' : 'ไม่พบเอกสาร ใช้ทั้งเฟรม'],
    ['ดูดมุมบนภาพเต็ม', w.quadUsed ? `${w.snapped}/4 ด้าน · มุมเลื่อนเฉลี่ย ${w.snapShiftPx} px · ${w.snapMs} ms` : '-'],
    ['ขนาดเอกสารในเฟรม', `${w.naturalSize} px`],
    ['ขนาดผลลัพธ์', `${w.outputSize} px`],
    ['ดึงเฟรมเต็ม', `${w.grabMs} ms`],
    ['Warp', `${w.warpMs} ms`],
    ['เข้ารหัส JPEG', `${w.encodeMs} ms`],
    ['รวม', `${w.totalMs} ms`],
    ['ขนาดไฟล์', `${w.jpegKB} KB`],
  ];
  el.resultMeta.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    el.resultMeta.append(dt, dd);
  }
  state.paused = true;
  el.sheet.hidden = false;
}

function closeResult() {
  el.sheet.hidden = true;
  state.paused = false;
  state.capturing = false;
  el.captureBtn.disabled = !state.cvInfo;
  overlay.clear();
}

/* --------------------------------------------------------------- report */

function buildReport() {
  return {
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    page: location.href,
    device: {
      ios: device.isIOS,
      android: device.isAndroid,
      inAppBrowser: device.inAppBrowser,
      userAgent: device.userAgent,
      screen: `${screen.width}×${screen.height} @${window.devicePixelRatio}x`,
    },
    config: {
      requestedResolution: `${CONFIG.camera.idealWidth}×${CONFIG.camera.idealHeight}`,
      grabMode: state.grabMode,
      enhanced: CONFIG.detect.enhanced.enabled,
      detectLongSide: CONFIG.detect.longSide,
      outputLongSide: CONFIG.output.longSide,
    },
    opencv: state.cvInfo ?? { error: state.cvError },
    camera: state.camInfo,
    detection: stats.summary(),
    stability: roundStability(overlay.stability()),
    gate: {
      minFps: CONFIG.gate.minFps,
      passed: stats.fps >= CONFIG.gate.minFps,
    },
    lastWarp: state.lastWarp,
  };
}

function roundStability(s) {
  const pct = (v) => (v === null ? null : Math.round(v * 10000) / 100);   // % ของเฟรม
  return {
    rawJitterPct: pct(s.rawJitter),
    smoothJitterPct: pct(s.smoothJitter),
    jumpsRejected: s.jumpsRejected,
    jumpsAccepted: s.jumpsAccepted,
  };
}

async function copyReport() {
  const json = JSON.stringify(buildReport(), null, 2);
  try {
    await navigator.clipboard.writeText(json);
    el.copyBtn.textContent = 'คัดลอกแล้ว';
  } catch {
    window.prompt('คัดลอกผลทดสอบด้านล่าง', json);
  }
  setTimeout(() => { el.copyBtn.textContent = 'คัดลอกผลทดสอบ'; }, 1500);
}

/* ---------------------------------------------------------------- misc */

function setPill(text, kind = '') {
  el.pill.textContent = text;
  el.pill.className = `pill ${kind}`.trim();
}

async function switchCamera(deviceId) {
  state.paused = true;
  overlay.clear();
  try {
    state.camInfo = await camera.start(deviceId);
  } catch (err) {
    setPill(explainCameraError(err), 'error');
  }
  overlay.resize();
  state.paused = !el.sheet.hidden;
}

async function onVisibilityChange() {
  if (!state.running) return;
  if (document.hidden) {
    state.paused = true;
    camera.stop();
    return;
  }
  // iOS หยุด stream เมื่อสลับแอป จึงเปิดใหม่ทุกครั้งที่กลับมา
  try {
    state.camInfo = await camera.start(camera.deviceId);
    overlay.resize();
  } catch (err) {
    setPill(explainCameraError(err), 'error');
  }
  state.paused = !el.sheet.hidden;
}

function loadEruda() {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/eruda@3.0.1/eruda.min.js';
  s.onload = () => window.eruda?.init();
  document.head.append(s);
}

/* ---------------------------------------------------------------- wire */

if (CONFIG.debug.eruda) loadEruda();
el.edges.hidden = !showEdges;
renderChecks();

el.startBtn.addEventListener('click', startScan);
el.captureBtn.addEventListener('click', captureTest);
el.closeBtn.addEventListener('click', closeResult);
el.copyBtn.addEventListener('click', copyReport);
el.cameraSelect.addEventListener('change', (e) => switchCamera(e.target.value));
el.debugBtn.addEventListener('click', () => {
  const collapsed = el.debug.classList.toggle('collapsed');
  el.debugBtn.textContent = collapsed ? 'แสดงค่าวัด' : 'ซ่อนค่าวัด';
});
document.addEventListener('visibilitychange', onVisibilityChange);
window.addEventListener('resize', () => overlay.resize());