/** ตัวกลางคุยกับ vision.worker.js แบบ request/response ด้วย Promise */
export class VisionClient {
  constructor() {
    // classic worker (ไม่ใช่ module) เพราะต้องใช้ importScripts โหลด opencv.js
    this.worker = new Worker(new URL('../../workers/vision.worker.js', import.meta.url));
    this.seq = 0;
    this.pending = new Map();
    this.worker.onmessage = (e) => this.#onMessage(e.data);
    this.worker.onerror = (e) => this.#failAll(new Error(e.message || 'Worker error'));
  }

  init({ urls, timeoutMs, detect }) {
    return this.#call('init', { urls, timeoutMs, detect });
  }

  /** frame.buffer ถูกโอนไป worker และใช้ต่อฝั่งนี้ไม่ได้อีก */
  detect(frame) {
    return this.#call('detect', frame, [frame.buffer]);
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
