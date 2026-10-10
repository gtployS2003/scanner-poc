# Doc Scanner PoC — M0 Technical Spike

หน้าเว็บหน้าเดียวสำหรับตอบคำถามเดียว: **Nothing 4a และ iPhone 14 Pro Max เปิดกล้อง โหลด OpenCV.js และตรวจจับเอกสารได้เร็วพอหรือไม่** ผลที่ได้ใช้ตัดสินใจ Go/No-go ก่อนเริ่ม M1

สิ่งที่ Spike ทำ: เปิดกล้องหลัง, โหลด OpenCV.js 5.0.0 ใน Web Worker, ตรวจจับเอกสารบนเฟรมย่อ (ด้านยาว 480 px), วาดกรอบ 4 มุม, วัดความสว่างและความคม, ปุ่มถ่ายทดสอบที่ทำ Perspective Correction บนเฟรมเต็มเป็นภาพด้านยาว 2000 px และปุ่มคัดลอกผลวัดเป็น JSON

สิ่งที่ยังไม่ทำ (อยู่ใน M1–M8): Auto Capture, Enhance, หลายหน้า, IndexedDB, PDF

## 1. เตรียมไฟล์ OpenCV.js

ดาวน์โหลด `https://docs.opencv.org/5.0.0/opencv.js` (หรือแตกจาก `opencv-5.0.0-docs.zip` ในหน้า Release) แล้ววางที่ `vendor/opencv/5.0.0/opencv.js` ตรวจขนาดไฟล์ด้วยว่าไม่เกิน 25 MiB ซึ่งเป็นเพดานต่อไฟล์ของ Cloudflare Pages

ถ้ายังไม่ได้วาง Worker จะโหลดจาก docs.opencv.org แทนอัตโนมัติ ใช้ทดสอบได้แต่เวลาโหลดที่วัดจะไม่ตรงกับของจริง

### ข้อควรรู้เมื่อใช้ OpenCV 5

- ฟังก์ชันเรขาคณิตบางตัว (เช่น `isContourConvex`) ถูกย้ายจาก `imgproc` ไปโมดูล `geometry` ซึ่ง opencv.js อาจไม่ได้รวมไว้ Worker จึงตรวจตอนโหลดว่ามีฟังก์ชันใดบ้าง และใช้ตัวที่เขียนด้วย JS แทนเมื่อไม่มี แถว "Geometry" ในแผงค่าวัดบอกว่าใช้ตัวไหนอยู่
- ผลของ `approxPolyDP` เป็น Mat 1 มิติ (`rows = 1`) ต่างจาก 4.x โค้ดจึงนับจำนวนจุดแทนการอ่าน `.rows`
- `warpPerspective` ใช้ Interpolation แบบใหม่ ผลจะต่างจาก 4.x เล็กน้อยและมักเร็วขึ้น ไม่ต้องแก้โค้ด

## 2. รันบนเครื่อง Windows แล้วเปิดจากมือถือ

กล้องทำงานเฉพาะบน HTTPS จึงต้องมี URL แบบ HTTPS ที่มือถือเข้าถึงได้ วิธีที่ง่ายที่สุดคือ Cloudflare Tunnel เพราะไม่ต้องติดตั้งใบรับรองบนมือถือ

```powershell
# ครั้งแรก
winget install --id Cloudflare.cloudflared

# ทุกครั้งที่พัฒนา (2 หน้าต่าง)
npx http-server . -p 8080 -c-1
cloudflared tunnel --url http://localhost:8080
```

เปิด URL `https://<สุ่ม>.trycloudflare.com` ที่ cloudflared แสดง บนมือถือทั้งสองเครื่อง

ทางเลือก: mkcert + `npx http-server -S` ก็ได้ แต่ต้องติดตั้ง Root CA บน iPhone และ Android เพิ่ม

## 3. Deploy ขึ้น Cloudflare Pages

เป็นเว็บ Static ไม่มี Build Step

- **ผ่าน Git (แนะนำ)**: Push repo ขึ้น GitHub แล้วสร้าง Pages project โดยตั้ง Build command ว่าง และ Output directory เป็น `/` ทุก Branch จะได้ Preview URL แยก
- **อัปโหลดตรง**: `npx wrangler pages deploy . --project-name doc-scanner-poc`

ไฟล์ `_headers` ตั้ง Cache ให้ OpenCV.js แคชได้นาน (อยู่ในโฟลเดอร์ตามเวอร์ชัน) และให้ไฟล์แอปตรวจเวอร์ชันใหม่ทุกครั้งระหว่าง Spike 
## 4. ตัวเลือกผ่าน URL

| พารามิเตอร์ | ค่า | ใช้เมื่อ |
| --- | --- | --- |
| `?res=` | `720`, `1080` (ค่าเริ่มต้น), `4k` | เทียบความละเอียดกล้องกับความเร็วและคุณภาพผลลัพธ์ |
| `?size=` | `320`, `480` (ค่าเริ่มต้น), `640` | เทียบขนาดเฟรมตรวจจับกับ FPS |
| `?cv=remote` | — | บังคับโหลด OpenCV.js จาก docs.opencv.org |
| `?debug` | — | เปิด Eruda เพื่อดู Console บนมือถือ (จำเป็นสำหรับ iPhone เมื่อไม่มี Mac) |

ผสมกันได้ เช่น `?res=4k&size=640&debug`

## 5. ขั้นตอนทดสอบ M0

ทำบนทั้งสองเครื่อง ด้วย Chrome บน Nothing 4a และ Safari บน iPhone 14 Pro Max

1. เปิดหน้าเว็บ ตรวจว่ารายการความพร้อมเป็นสีเขียว แล้วแตะ "เปิดกล้อง"
2. รอจนป้ายด้านล่างเปลี่ยนเป็น "เล็งไปที่เอกสาร" แล้วจดเวลาโหลด OpenCV จากแผงค่าวัด
3. วาง A4 บนโต๊ะสีเข้ม ถือนิ่ง 10 วินาที ดูว่ากรอบเกาะขอบเอกสาร และจด Detect FPS
4. ทำซ้ำบนโต๊ะสีขาว, ในห้องแสงน้อย และกับใบเสร็จ
5. แตะปุ่มชัตเตอร์ ตรวจว่าเอกสารถูกตัดเป็นสี่เหลี่ยมตรง แล้วจดเวลา Warp และขนาดไฟล์
6. สลับไปแอปอื่นแล้วกลับมา ตรวจว่ากล้องกลับมาทำงาน
7. แตะ "คัดลอกผลทดสอบ" แล้ววาง JSON เก็บไว้
8. เปิดหน้าเดิมอีกครั้ง จดเวลาโหลดรอบสอง (จาก Cache)
9. ทำซ้ำข้อ 3 และ 5 ด้วย `?res=4k` เพื่อดูว่าความละเอียดสูงขึ้นคุ้มกับเวลาที่เพิ่มหรือไม่

## 6. เกณฑ์ Go/No-go

| ตัวชี้วัด | เกณฑ์ | ถ้าไม่ผ่าน |
| --- | --- | --- |
| Detect FPS บน Nothing 4a | ≥ 5 | ลอง `?size=320`; ถ้ายังไม่ผ่าน พิจารณา Custom Build ของ OpenCV |
| ตรวจจับบนพื้นเข้ม | กรอบเกาะขอบ A4 เกือบตลอด | จูน `minAreaRatio` และ `epsilons` ใน `js/config.js` |
| Warp เฟรมเต็ม | ≤ 2 วินาที ต่อหน้า และ Tab ไม่ Reload | ลดความละเอียดกล้องหรือขนาด Output |
| โหลดครั้งแรก | ≤ 10 วินาที บน 4G | ตรวจว่าใช้ไฟล์ local และ Cache ทำงาน |
| สลับแอปแล้วกลับมา | กล้องกลับมาเอง | แก้ `onVisibilityChange` ก่อนเข้า M1 |

ผ่านครบ = เข้า M1 ได้ บันทึกค่า Stream ที่กล้องให้จริงไว้ด้วย เพราะเป็นตัวกำหนดความคมของภาพผลลัพธ์ 2000 px

## โครงสร้างไฟล์

```text
index.html
_headers                       Cloudflare Pages headers
css/spike.css
js/
  main.js                      ประกอบทุกส่วน, loop ตรวจจับ, ถ่ายทดสอบ, รายงาน
  config.js                    เกณฑ์ทั้งหมด + ตัวเลือกผ่าน URL
  camera/camera-service.js     getUserMedia, สลับกล้อง, Wake Lock
  camera/frame-grabber.js      ดึงเฟรมเป็น RGBA buffer
  vision/vision-client.js      คุยกับ Worker แบบ Promise
  ui/overlay.js                วาดกรอบ + smoothing + ชดเชย object-fit: cover
  ui/debug-panel.js            ค่าวัดบนจอ
  utils/device.js              ตรวจ iOS/Android, In-app Browser, ความพร้อม
workers/vision.worker.js       OpenCV.js: detect + warp
vendor/opencv/5.0.0/           วาง opencv.js ที่นี่
```

โครงนี้ตรงกับ Folder Structure ในเอกสารออกแบบ ส่วนที่ M1 จะเพิ่มคือ `capture/`, `pages/`, `export/` และหน้าจอ Editor, Pages, Export
#   s c a n n e r - p o c  
 #   s c a n n e r - p o c  
 #   s c a n n e r - p o c  
 #   s c a n n e r - p o c  
 