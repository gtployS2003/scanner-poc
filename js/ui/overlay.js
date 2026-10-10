import { CONFIG } from '../config.js';

const LAMP = '#ffb23e';

/**
 * วาดกรอบเอกสารบน canvas ที่ซ้อนกับ <video object-fit: cover>
 * พิกัด quad ที่รับเข้ามาเป็นสัดส่วน 0–1 ของเฟรม video
 *
 * แยก 2 จังหวะ:
 *  - update()  : เรียกเมื่อได้ผลตรวจจับ (6–20 ครั้ง/วินาที) → ติดตามและกรองเป็น "ตำแหน่งเป้าหมาย"
 *  - render()  : เรียกทุกเฟรมของจอ (60 ครั้ง/วินาที) → เลื่อนกรอบที่แสดงเข้าหาเป้าหมายแบบนุ่ม
 * กรอบจึงไม่กระโดดเป็นขั้นตามจังหวะการตรวจจับ
 */
export class Overlay {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.ctx = canvas.getContext('2d');
    this.smoothed = null;
    this.pending = null;
    this.pendingCount = 0;
    this.lastSeen = 0;
    this.lastRaw = null;
    this.rawJitter = null;
    this.smoothJitter = null;
    this.jumpsRejected = 0;
    this.jumpsAccepted = 0;
    this.display = null;       // มุมที่วาดอยู่จริงบนจอ
    this.opacity = 0;
    this.lastRender = 0;
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

  /**
   * รับผลตรวจจับล่าสุด คืน quad ที่นิ่งแล้ว (หรือ null เมื่อหายไปนานพอ)
   *  - ขยับน้อย (มือสั่น/noise) → smooth แรง  · ขยับมาก (ตั้งใจเลื่อน) → ตามเร็ว
   *  - กระโดดไปสี่เหลี่ยมอื่นทันที → ไม่เชื่อ จนกว่าจะเห็นตำแหน่งใหม่ซ้ำ confirmFrames เฟรม
   *  - ไม่พบในบางเฟรม → คงกรอบไว้ holdMs ก่อนซ่อน
   */
  update(quad, t = performance.now()) {
    const o = CONFIG.overlay;
    if (quad) {
      this.lastSeen = t;
      if (this.lastRaw) this.rawJitter = ema(this.rawJitter, meanCornerDistance(quad, this.lastRaw));
      this.lastRaw = quad;

      if (!this.smoothed) {
        this.smoothed = quad;
      } else {
        const d = maxCornerDistance(quad, this.smoothed);
        if (d > o.jumpReset) {
          // อาจเป็นสี่เหลี่ยมอื่นที่โผล่มาเฟรมเดียว ต้องเห็นซ้ำก่อนจึงย้าย
          if (this.pending && maxCornerDistance(quad, this.pending) < o.jumpReset / 2) this.pendingCount++;
          else { this.pending = quad; this.pendingCount = 1; }
          if (this.pendingCount >= o.confirmFrames) {
            this.smoothed = quad;
            this.pending = null;
            this.jumpsAccepted++;
          } else {
            this.jumpsRejected++;
          }
        } else {
          this.pending = null;
          const keep = d < o.stillThreshold ? o.smoothingStill : o.smoothingMove;
          const before = this.smoothed;
          this.smoothed = quad.map((p, i) => ({
            x: before[i].x * keep + p.x * (1 - keep),
            y: before[i].y * keep + p.y * (1 - keep),
          }));
          this.smoothJitter = ema(this.smoothJitter, meanCornerDistance(this.smoothed, before));
        }
      }
    } else if (this.smoothed && t - this.lastSeen > o.holdMs) {
      this.smoothed = null;
      this.pending = null;
      this.lastRaw = null;
    }
    return this.smoothed;
  }

  /** ค่าสำหรับแผงค่าวัด: การสั่นเฉลี่ยต่อเฟรม (สัดส่วนของเฟรม) ก่อนและหลังทำให้นิ่ง */
  stability() {
    return {
      rawJitter: this.rawJitter,
      smoothJitter: this.smoothJitter,
      jumpsRejected: this.jumpsRejected,
      jumpsAccepted: this.jumpsAccepted,
    };
  }

  clear() {
    this.smoothed = null;
    this.pending = null;
    this.lastRaw = null;
    this.display = null;
    this.opacity = 0;
    this.draw();
  }

  /** เรียกทุกเฟรมของจอจาก requestAnimationFrame */
  render(now = performance.now()) {
    const dt = this.lastRender ? Math.min(now - this.lastRender, 100) : 16;
    this.lastRender = now;
    const { renderTau, fadeTau } = CONFIG.overlay;
    const target = this.smoothed;

    if (target) {
      if (!this.display || this.opacity < 0.05) {
        this.display = target.map((p) => ({ ...p }));   // โผล่ใหม่: วางตรงเป้าหมายแล้วค่อยจางเข้า
      } else {
        // ค่อย ๆ เข้าหาเป้าหมายด้วยค่าคงที่เวลา renderTau (ms) ไม่ขึ้นกับ FPS ของการตรวจจับ
        const k = 1 - Math.exp(-dt / renderTau);
        this.display = this.display.map((p, i) => ({
          x: p.x + (target[i].x - p.x) * k,
          y: p.y + (target[i].y - p.y) * k,
        }));
      }
    }
    const goal = target ? 1 : 0;
    this.opacity += (goal - this.opacity) * (1 - Math.exp(-dt / fadeTau));
    if (!target && this.opacity < 0.02) {
      this.opacity = 0;
      this.display = null;
    }
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
    if (!this.display || !this.opacity || !this.video.videoWidth) return;

    const pts = this.display.map((p) => this.#toScreen(p));
    ctx.globalAlpha = this.opacity;

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
    ctx.globalAlpha = 1;
  }
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function maxCornerDistance(q1, q2) {
  return Math.max(...q1.map((p, i) => distance(p, q2[i])));
}

function meanCornerDistance(q1, q2) {
  return q1.reduce((s, p, i) => s + distance(p, q2[i]), 0) / q1.length;
}

function ema(prev, value, k = 0.2) {
  return prev === null ? value : prev * (1 - k) + value * k;
}