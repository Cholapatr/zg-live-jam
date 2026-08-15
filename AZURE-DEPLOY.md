# คู่มือ Deploy บน Azure App Service

ทำผ่านหน้าเว็บ Azure Portal ล้วนๆ ไม่ต้องใช้คำสั่ง/CLI ตามแผนที่ตกลงกับ Admin ไว้: ทดสอบด้วย **Free (F1)** ก่อน → ก่อนวันงาน scale ขึ้นเป็น **Basic B1** → หลังงานจบ **ลบ resource ทิ้ง**

---

## 1. เตรียมโค้ดขึ้น GitHub

Azure ดึงโค้ดจาก GitHub มา deploy ให้อัตโนมัติทุกครั้งที่ push (เหมือนที่ทำกับ Render)

1. ถ้ายังไม่มี repo: เข้า [github.com](https://github.com) → New repository → ตั้งชื่อ เช่น `zg-live-jam` → Create
2. อัปโหลดไฟล์ทั้งหมดในโฟลเดอร์ `zg-live-jam` ขึ้นไป (**ยกเว้น** `node_modules` และ `.env` — สองอย่างนี้ไม่ควรขึ้น GitHub อยู่แล้วเพราะอยู่ใน `.gitignore`)

---

## 2. สร้าง Web App บน Azure Portal (เริ่มที่ Free F1)

1. เข้า [portal.azure.com](https://portal.azure.com) → **Create a resource** → ค้นหา **Web App** → Create
2. แท็บ **Basics** กรอก:
   - **Resource Group**: กด Create new → ตั้งชื่อ เช่น `zg-live-jam-rg` (รวมทุกอย่างไว้ในนี้ ลบทีเดียวจบตอนหลังงาน)
   - **Name**: ชื่อที่ไม่ซ้ำใคร เช่น `zg-live-jam` (จะได้ลิงก์ `https://zg-live-jam.azurewebsites.net`)
   - **Publish**: Code
   - **Runtime stack**: Node 20 LTS (หรือเวอร์ชัน LTS ล่าสุดที่มีให้เลือก)
   - **Operating System**: **Linux**
   - **Region**: Southeast Asia (ใกล้ไทยสุด)
   - **Pricing plan**: กด Explore pricing plans (หรือ Change size) → เลือก **Free F1**
3. กด **Review + create** → **Create** รอสักครู่จนเสร็จ

---

## 3. เชื่อม GitHub ให้ deploy อัตโนมัติ

1. เข้า Web App ที่สร้างไว้ → เมนูซ้าย **Deployment Center**
2. **Source**: เลือก GitHub → Authorize (login GitHub ครั้งแรก) → เลือก Organization/Repository/Branch ที่อัปโหลดโค้ดไว้
3. กด **Save** — Azure จะสร้าง GitHub Actions workflow ให้อัตโนมัติ และเริ่ม deploy รอบแรกทันที (ดูสถานะได้ในแท็บ **Logs** ของหน้านี้ หรือแท็บ Actions ใน GitHub repo)

---

## 4. ตั้งค่า Environment Variables

1. เมนูซ้าย **Configuration** → แท็บ **Application settings** → **+ New application setting**
2. เพิ่มทีละตัวตามชื่อใน `.env.example` เช่น:
   - `ADMIN_PIN` = รหัส PIN ที่ต้องการ
   - `APP_BASE_URL` = `https://zg-live-jam.azurewebsites.net` (ใส่ลิงก์จริงของ Web App นี้ **ห้ามมี `/` ปิดท้าย**)
   - `SESSION_SECRET` = ตั้งค่าอะไรก็ได้ที่คาดเดายาก (สุ่มมา 1 ชุด)
   - ถ้าจะเปิดระบบ login ด้วย ใส่ `MICROSOFT_CLIENT_ID` / `MICROSOFT_TENANT_ID` / `MICROSOFT_CLIENT_SECRET` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` ตามที่มี
3. กด **Save** ด้านบน (แอปจะ restart ให้เอง)

**ถ้าเปิด login ด้วย** อย่าลืมกลับไปเพิ่ม Redirect URI ใหม่ที่ Google Cloud Console / Microsoft Entra ให้ตรงกับ `https://zg-live-jam.azurewebsites.net/auth/microsoft/callback` และ `.../auth/google/callback` ด้วย (ใส่เพิ่มได้เลยไม่ต้องลบของ localhost ทิ้ง)

---

## 5. เปิด WebSockets — ⚠️ ห้ามลืมขั้นตอนนี้

แอปใช้ Socket.IO เพื่อ real-time update ถ้าไม่เปิดตรงนี้แอปจะรันได้แต่หน้าจะไม่ update สดๆ:

1. เมนูซ้าย **Configuration** → แท็บ **General settings**
2. หา **Web sockets** → เปลี่ยนเป็น **On**
3. กด **Save**

(บน Free F1 จะรองรับได้แค่ 5 connection พร้อมกัน — พอสำหรับทดสอบคนเดียว/ไม่กี่คน)

---

## 6. ทดสอบ

เปิด `https://zg-live-jam.azurewebsites.net` — ควรใช้งานได้ปกติทุกฟีเจอร์ ลองเสนอเพลง/โหวต/เปิดคนละแท็บดูว่า real-time update ทำงานไหม

---

## 7. ก่อนวันงานจริง: Scale ขึ้นเป็น Basic B1

1. เข้า Web App → เมนูซ้าย **Scale up (App Service plan)**
2. เลือกแท็บ **Production** → เลือก **B1**
3. กด **Apply** — ใช้เวลาสักครู่ ไม่ต้อง deploy โค้ดใหม่ ข้อมูลเดิมยังอยู่ครบ

จุดนี้จะไม่มี WebSocket limit อีกต่อไป (รองรับได้หลักหมื่น connection) และแอปจะไม่ sleep ระหว่างงาน

---

## 8. หลังงานจบ: ลบ Resource Group ทิ้ง

Azure คิดเงินตามเวลาที่ App Service Plan เปิดอยู่ แม้จะ stop/scale down ก็ยังคิดเงิน (pause ไม่ได้) วิธีเดียวที่หยุดจ่ายจริงคือลบทิ้ง:

1. ค้นหา **Resource groups** ในแถบค้นหาด้านบน Azure Portal
2. เลือก `zg-live-jam-rg` (resource group ที่สร้างไว้ตอนแรก — จะรวม Web App + App Service Plan ไว้ในนี้ทั้งหมด)
3. กด **Delete resource group** → พิมพ์ชื่อ resource group ยืนยัน → Delete

ลบเสร็จคือหยุดคิดเงินทันที ถ้ามีงานครั้งหน้าค่อยไล่ทำตามขั้นตอนที่ 2 ใหม่ได้เลย (โค้ดยังอยู่ครบใน GitHub)

---

## ข้อมูลจะหายไหม

Azure App Service Linux เก็บไฟล์ในโฟลเดอร์ `/home` ซึ่ง**อยู่ถาวรข้าม restart** (ต่างจาก Render free tier ที่ข้อมูลหายทุกครั้งที่ restart) ข้อมูลจะหายก็ต่อเมื่อลบ resource group ทิ้งเท่านั้น — ดังนั้นระหว่างงานไม่ต้องกังวลเรื่องข้อมูลหายจาก sleep/restart เหมือน Render free tier
