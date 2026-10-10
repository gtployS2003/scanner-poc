import { CONFIG } from '../config.js';

/** เปิด/ปิดกล้องหลัง สลับกล้อง และกันจอดับระหว่างใช้งาน */
export class CameraService {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.deviceId = null;
    this.wakeLock = null;
  }

  get track() {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  async start(deviceId = this.deviceId) {
    this.stop();

    const { idealWidth, idealHeight } = CONFIG.camera;
    const video = {
      width: { ideal: idealWidth },
      height: { ideal: idealHeight },
    };
    if (deviceId) video.deviceId = { exact: deviceId };
    else video.facingMode = { ideal: 'environment' };

    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.deviceId = this.track?.getSettings?.().deviceId ?? deviceId ?? null;

    this.video.srcObject = this.stream;
    await this.video.play();
    await waitForDimensions(this.video);
    this.requestWakeLock();
    return this.info();
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.releaseWakeLock();
  }

  info() {
    const track = this.track;
    const s = track?.getSettings?.() ?? {};
    return {
      label: track?.label ?? '',
      facingMode: s.facingMode ?? '',
      streamWidth: s.width ?? null,
      streamHeight: s.height ?? null,
      frameRate: s.frameRate ? Math.round(s.frameRate) : null,
      videoWidth: this.video.videoWidth,
      videoHeight: this.video.videoHeight,
    };
  }

  /** ชื่อกล้องจะมีให้ก็ต่อเมื่อได้รับสิทธิ์แล้ว จึงเรียกหลัง start() */
  async listCameras() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  }

  async requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      this.wakeLock = null;
    }
  }

  releaseWakeLock() {
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }
}

function waitForDimensions(video) {
  if (video.videoWidth) return Promise.resolve();
  return new Promise((resolve) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
}

/** แปลง error จาก getUserMedia เป็นข้อความที่บอกวิธีแก้ */
export function explainCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return window.isSecureContext
        ? 'ไม่ได้รับสิทธิ์ใช้กล้อง เปิดสิทธิ์กล้องของเว็บนี้ในการตั้งค่า Browser แล้วลองอีกครั้ง'
        : 'กล้องใช้ได้เฉพาะหน้าเว็บ HTTPS เปิดลิงก์ที่ขึ้นต้นด้วย https://';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'ไม่พบกล้องหลังที่ใช้ได้บนเครื่องนี้';
    case 'NotReadableError':
      return 'กล้องถูกใช้งานโดยแอปอื่นอยู่ ปิดแอปนั้นแล้วลองอีกครั้ง';
    default:
      return `เปิดกล้องไม่สำเร็จ: ${err?.message ?? err}`;
  }
}
