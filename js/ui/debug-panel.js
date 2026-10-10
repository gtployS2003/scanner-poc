import { CONFIG, APP_VERSION } from '../config.js';
import { jsHeapMB } from '../utils/device.js';

/** เก็บค่าวัดย้อนหลังแบบ rolling window */
export class Stats {
  constructor(size = CONFIG.stats.window) {
    this.size = size;
    this.samples = [];       // { t, grabMs, detectMs, roundMs, found, areaRatio, brightness, sharpness }
    this.completions = [];   // timestamps สำหรับคำนวณ FPS
  }

  add(sample) {
    const t = performance.now();
    this.samples.push({ t, ...sample });
    if (this.samples.length > this.size) this.samples.shift();
    this.completions.push(t);
    while (this.completions.length && t - this.completions[0] > 1000) this.completions.shift();
  }

  get fps() {
    const t = performance.now();
    return this.completions.filter((c) => t - c <= 1000).length;
  }

  avg(key) {
    if (!this.samples.length) return null;
    return this.samples.reduce((s, x) => s + x[key], 0) / this.samples.length;
  }

  /** จำนวนครั้งที่พบเอกสารแยกตามวิธี ในหน้าต่างล่าสุด */
  get strategyCounts() {
    const counts = {};
    for (const s of this.samples) {
      if (s.strategy) counts[s.strategy] = (counts[s.strategy] ?? 0) + 1;
    }
    return counts;
  }

  get foundRatio() {
    if (!this.samples.length) return null;
    return this.samples.filter((s) => s.found).length / this.samples.length;
  }

  get last() {
    return this.samples.at(-1) ?? null;
  }

  summary() {
    return {
      fps: this.fps,
      avgGrabMs: round1(this.avg('grabMs')),
      avgReadMs: round1(this.avg('readMs')),
      avgDetectMs: round1(this.avg('detectMs')),
      avgRoundTripMs: round1(this.avg('roundMs')),
      foundRatio: this.foundRatio === null ? null : Math.round(this.foundRatio * 100) / 100,
      strategyCounts: this.strategyCounts,
      lastCandidates: this.last?.candidates ?? null,
      lastPassed: this.last?.passed ?? null,
      lastScore: this.last?.score ?? null,
      lastBrightness: this.last?.brightness ?? null,
      lastSharpness: this.last?.sharpness ?? null,
      jsHeapMB: jsHeapMB(),
    };
  }
}

/** แสดงค่าวัดบนจอ อัปเดตไม่เกิน CONFIG.debug.refreshMs */
export class DebugPanel {
  constructor(listEl) {
    this.listEl = listEl;
    this.lastRender = 0;
  }

  render(state, stats, force = false, stability = null) {
    const t = performance.now();
    if (!force && t - this.lastRender < CONFIG.debug.refreshMs) return;
    this.lastRender = t;

    const cv = state.cvInfo;
    const cam = state.camInfo;
    const fps = stats.fps;
    const pass = fps >= CONFIG.gate.minFps;
    const heap = jsHeapMB();
    const last = stats.last;

    const rows = [
      ['เวอร์ชัน', APP_VERSION],
      ['OpenCV', cv
        ? `${cv.version} · ${cv.source.includes('docs.opencv.org') ? 'remote' : 'local'}${cv.sizeMB ? ` · ${cv.sizeMB} MB` : ''}`
        : state.cvError ? `<span class="ng">ผิดพลาด: ${esc(state.cvError)}</span>` : esc(state.cvProgress ?? 'กำลังโหลด')],
      ['เวลาโหลด', cv
        ? `รวม ${fmtSec(cv.totalMs)} (ดาวน์โหลด ${fmtMs(cv.downloadMs)} · สคริปต์ ${fmtMs(cv.evalMs)} · runtime ${fmtMs(cv.runtimeMs)})`
        : '-'],
      ['Geometry', cv?.geometry
        ? Object.entries(cv.geometry).map(([k, v]) => `${k}: ${v}`).join(' · ')
        : '-'],
      ['กล้อง', cam ? esc(cam.label || cam.facingMode || 'ไม่ทราบชื่อ') : '-'],
      ['Stream', cam ? `${cam.streamWidth ?? '?'}×${cam.streamHeight ?? '?'} @ ${cam.frameRate ?? '?'} fps` : '-'],
      ['Video', cam ? `${cam.videoWidth}×${cam.videoHeight}` : '-'],
      ['เฟรมตรวจจับ', last ? `${last.width}×${last.height}` : '-'],
      ['Detect FPS', cv ? `<span class="${pass ? 'ok' : 'ng'}">${fps}</span> (เกณฑ์ ≥ ${CONFIG.gate.minFps})` : '-'],
      ['เวลาเฉลี่ย', last
        ? `grab (${state.grabMode}) ${fmtMs(stats.avg('grabMs'))} · อ่านพิกเซล ${fmtMs(stats.avg('readMs'))} · detect ${fmtMs(stats.avg('detectMs'))} · รวม ${fmtMs(stats.avg('roundMs'))}`
        : '-'],
      ['พบเอกสาร', stats.foundRatio === null ? '-'
        : `${Math.round(stats.foundRatio * 100)}% ของ ${stats.samples.length} เฟรมล่าสุด${last?.found ? ` · พื้นที่ ${Math.round(last.areaRatio * 100)}%` : ''}`],
      ['วิธีที่พบ', Object.keys(stats.strategyCounts).length
        ? Object.entries(stats.strategyCounts).map(([k, v]) => `${k} ${v}`).join(' · ')
        : '-'],
      ['คะแนนขอบ', last?.score
        ? `ตัวเลือก ${last.candidates} ผ่าน ${last.passed} · ต่างสี ${last.score.contrast} (≥ ${CONFIG.detect.score.minContrast}) · เป็นกระดาษ ${Math.round(last.score.paper * 100)}% (≥ ${Math.round(CONFIG.detect.score.minPaper * 100)}%)`
        : last ? `ตัวเลือก ${last.candidates ?? 0}` : '-'],
      ['ความนิ่ง', stability?.rawJitter != null
        ? `สั่นก่อน ${fmtPct(stability.rawJitter)} → หลัง ${fmtPct(stability.smoothJitter)} ของเฟรม · ไม่ย้าย ${stability.jumpsRejected} · ย้าย ${stability.jumpsAccepted}`
        : '-'],
      ['ความสว่าง', last ? `${last.brightness} / 255` : '-'],
      ['ความคม', last ? `${last.sharpness}` : '-'],
      ['JS heap', heap === null ? 'วัดไม่ได้ใน Browser นี้' : `${heap} MB`],
    ];

    this.listEl.innerHTML = rows
      .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
      .join('');
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}
function round1(v) {
  return v === null ? null : Math.round(v * 10) / 10;
}
function fmtPct(v) {
  return v == null ? '-' : `${(v * 100).toFixed(2)}%`;
}
function fmtMs(v) {
  return v === null ? '-' : `${Math.round(v)} ms`;
}
function fmtSec(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}