/**
 * ดึงเฟรมจาก <video> เป็น RGBA buffer เพื่อส่งให้ worker แบบ Transferable
 * ใช้ canvas บน main thread แทน OffscreenCanvas ใน worker เพื่อไม่ผูกกับ iOS 16.4+
 */
export class FrameGrabber {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  /** longSide = 0 คือความละเอียดเต็มของ video */
  grab(video, longSide = 0) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const scale = longSide ? Math.min(1, longSide / Math.max(vw, vh)) : 1;
    const width = Math.round(vw * scale);
    const height = Math.round(vh * scale);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.drawImage(video, 0, 0, width, height);
    const image = this.ctx.getImageData(0, 0, width, height);
    return { buffer: image.data.buffer, width, height };
  }

  /** คืนหน่วยความจำของ canvas ขนาดใหญ่ (สำคัญบน iOS) */
  release() {
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
