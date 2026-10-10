import { APP_VERSION } from '../config.js';

/** ตัวกลางคุยกับ vision.worker.js แบบ request/response ด้วย Promise */
export class VisionClient {
  constructor() {
    // classic worker (ไม่ใช่ module) เพราะต้องใช้ importScripts โหลด opencv.js
    // ?v= กัน browser ใช้ worker เวอร์ชันเก่าที่ค้างใน cache
    const url = new URL('../../workers/vision.worker.js', import.meta.url);
    url.searchParams.set('v', APP_VERSION);
    this.worker = new Worker(url);
    this.seq = 0;
    this.pending = new Map();
    this.onProgress = null;   // (info) => void ระหว่างโหลด OpenCV
    this.worker.onmessage = (e) => this.#onMessage(e.data);
    this.worker.onerror = (e) => this.#failAll(new Error(e.message || 'Worker error'));
  }

  init({ urls, timeoutMs, detect }) {
    return this.#call('init', { urls, timeoutMs, detect });
  }

  /** frame.buffer หรือ frame.bitmap ถูกโอนไป worker และใช้ต่อฝั่งนี้ไม่ได้อีก */
  detect(frame, wantEdges = false) {
    const transfer = [frame.bitmap ?? frame.buffer];
    return this.#call('detect', { ...frame, wantEdges }, transfer);
  }

  warp(frame, quad, outLongSide) {
    return this.#call('warp', { ...frame, quad, outLongSide }, [frame.buffer]);
  }

  #call(type, payload, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload }, transfer);
    });
  }

  #onMessage(msg) {
    if (msg.type === 'progress') {
      this.onProgress?.(msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  #failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}