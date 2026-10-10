import { CONFIG } from '../config.js';

const LAMP = '#ffb23e';

/**
 * วาดกรอบเอกสารบน canvas ที่ซ้อนกับ <video object-fit: cover>
 * พิกัด quad ที่รับเข้ามาเป็นสัดส่วน 0–1 ของเฟรม video
 */
export class Overlay {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.ctx = canvas.getContext('2d');
    this.smoothed = null;
    this.misses = 0;
    this.cssW = 0;
    this.cssH = 0;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  /** รับผลตรวจจับล่าสุด คืน quad หลัง smooth (หรือ null เมื่อหายไปนานพอ) */
  update(quad) {
    const { smoothing, jumpReset, holdFrames } = CONFIG.overlay;
    if (quad) {
      this.misses = 0;
      const jumped = this.smoothed && quad.some((p, i) => distance(p, this.smoothed[i]) > jumpReset);
      this.smoothed = !this.smoothed || jumped
        ? quad
        : quad.map((p, i) => ({
            x: this.smoothed[i].x * smoothing + p.x * (1 - smoothing),
            y: this.smoothed[i].y * smoothing + p.y * (1 - smoothing),
          }));
    } else if (++this.misses > holdFrames) {
      this.smoothed = null;
    }
    this.draw();
    return this.smoothed;
  }

  clear() {
    this.smoothed = null;
    this.draw();
  }

  /** แปลงพิกัดเฟรมเป็นพิกัดจอ โดยชดเชยส่วนที่ object-fit: cover ตัดออก */
  #toScreen(p) {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const s = Math.max(this.cssW / vw, this.cssH / vh);
    const ox = (this.cssW - vw * s) / 2;
    const oy = (this.cssH - vh * s) / 2;
    return { x: p.x * vw * s + ox, y: p.y * vh * s + oy };
  }

  draw() {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    if (!this.smoothed || !this.video.videoWidth) return;

    const pts = this.smoothed.map((p) => this.#toScreen(p));

    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 178, 62, 0.16)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = LAMP;
    ctx.stroke();

    ctx.fillStyle = LAMP;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
