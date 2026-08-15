# คู่มือตั้งค่าระบบ Login (Microsoft 365 / Google / LINE)

ระบบ login เป็น **ตัวเลือกเสริม** — ไม่ตั้งค่าอะไรเลยแอปก็ยังใช้งานได้ปกติทุกอย่าง (เสนอเพลง โหวต ตอบรับ จัดคิว) ยกเว้นฟีเจอร์ **⭐ Favourite List** ที่ต้อง login ก่อนถึงจะใช้ได้

ตั้งค่ากี่ provider ก็ได้ (1, 2 หรือทั้ง 3 ก็ได้) — provider ไหนไม่ได้ตั้งค่า Client ID/Secret จะไม่ขึ้นปุ่มในหน้า login ให้เห็นเอง ไม่ต้องปิดอะไรเพิ่ม

ทุก provider ต้องใช้ **Callback URL** (Redirect URI) — เป็นลิงก์ที่ provider จะพาผู้ใช้กลับมาที่แอปเราหลังล็อกอินเสร็จ ต้องคัดลอก **ค่าจริง** (ไม่ใช่ตัวอย่าง) ไปวางในช่องของแต่ละ provider ตรงๆ

**ถ้ากำลังทดสอบในเครื่องตัวเอง (localhost)** ให้คัดลอกไปวางตามนี้เป๊ะๆ (พิมพ์/วางทั้งบรรทัด ไม่ต้องแก้อะไร):

```
http://localhost:3000/auth/microsoft/callback
http://localhost:3000/auth/google/callback
http://localhost:3000/auth/line/callback
```

**ถ้า deploy จริงแล้ว** (เช่นบน Render.com) ให้ใช้ลิงก์จริงของแอปแทน `http://localhost:3000` เช่นถ้าลิงก์คือ `https://zg-live-jam.onrender.com` ก็คัดลอกไปวางว่า `https://zg-live-jam.onrender.com/auth/google/callback` เป็นต้น — provider ส่วนใหญ่ให้ใส่ Callback URL ได้มากกว่า 1 บรรทัด ดังนั้นใส่ทั้งสองแบบ (localhost ไว้ทดสอบ + ลิงก์จริงไว้ใช้งานจริง) พร้อมกันได้เลย ไม่ต้องลบอันเก่าทิ้ง

---

## 1. Microsoft 365 (Entra ID) — สำหรับพนักงาน ZyGen

ใช้บัญชี Microsoft 365 ของบริษัท ต้องมีสิทธิ์ผู้ดูแลระบบ (Global Admin หรือ Application Administrator) ใน Microsoft Entra ของบริษัท

1. เข้า [Microsoft Entra admin center](https://entra.microsoft.com) → เมนู **Identity → Applications → App registrations** → กด **New registration**
2. ตั้งชื่อ เช่น `ZG Live Jam` เลือก **Supported account types** เป็น "Accounts in this organizational directory only" (จำกัดเฉพาะพนักงาน ZyGen) หรือ "Accounts in any organizational directory" ถ้าต้องการเปิดกว้างกว่านั้น — ช่อง Redirect URI ตอนนี้เว้นว่างไว้ก่อน → กด **Register**
3. หน้า **Overview** จะเห็น **Application (client) ID** — คัดลอกไปใส่ `MICROSOFT_CLIENT_ID`
4. ถ้าจำกัดเฉพาะบัญชีบริษัท คัดลอก **Directory (tenant) ID** จากหน้าเดียวกันไปใส่ `MICROSOFT_TENANT_ID` ด้วย (ถ้าเว้นว่างไว้ = ใครก็ล็อกอินด้วยบัญชี Microsoft ได้หมด รวมบัญชีส่วนตัว)
5. เมนูซ้าย **Manage → Authentication** → **Add a platform** → เลือก **Web** → ช่อง **Redirect URI** วาง `http://localhost:3000/auth/microsoft/callback` (ทดสอบเครื่องตัวเอง) → Save (ทีหลัง deploy จริงค่อยกลับมาเพิ่มอีกบรรทัดด้วยลิงก์จริง)
6. เมนูซ้าย **Manage → Certificates & secrets** → แท็บ **Client secrets** → **New client secret** → ตั้งชื่อ+อายุ (เช่น 6 เดือน ครอบคลุมช่วงเตรียมงาน-หลังงาน) → **Add**
7. คัดลอกค่าใน ช่อง **Value** ทันที (หน้านี้เปิดอีกครั้งจะไม่เห็นค่าแล้ว) ไปใส่ `MICROSOFT_CLIENT_SECRET`
8. เมนูซ้าย **Manage → API permissions** ควรมี `openid`, `profile`, `email` อยู่แล้วเป็นค่าเริ่มต้น (ไม่ต้องเพิ่มเอง)

## 2. Google

ใช้บัญชี Google อะไรก็ได้ (ไม่จำเป็นต้องเป็นบัญชีองค์กร)

1. เข้า [Google Cloud Console](https://console.cloud.google.com) → สร้างหรือเลือกโปรเจกต์
2. ไปที่ **APIs & Services → OAuth consent screen** (หรือ "Google Auth Platform" ในเมนูใหม่) → ตั้งค่าเบื้องต้น: User type เลือก **External**, ใส่ชื่อแอป เช่น `ZG Live Jam`, อีเมลติดต่อ → บันทึก (ไม่ต้อง submit for verification เพราะใช้แค่ในงานภายใน จำนวนคนใช้ไม่เกินขีดจำกัด test/unverified app)
3. ถ้าจำกัดเฉพาะคนที่รู้จัก แนะนำเพิ่มอีเมลผู้ทดสอบในแท็บ **Audience → Test users** (unverified app จำกัดจำนวน test user ได้ระดับร้อยคน เพียงพอสำหรับงาน 80 คน)
4. ไปที่ **Clients** (หรือ Credentials) → **Create Client** → Application type เลือก **Web application**
5. ใต้ **Authorized redirect URIs** กด **Add URI** วาง `http://localhost:3000/auth/google/callback` (ทดสอบเครื่องตัวเอง) → Create (ทีหลัง deploy จริงค่อยกลับมากด Add URI เพิ่มอีกบรรทัดด้วยลิงก์จริง)
6. จะได้ **Client ID** และ **Client secret** ขึ้นมาทันที คัดลอกไปใส่ `GOOGLE_CLIENT_ID` และ `GOOGLE_CLIENT_SECRET`

## 3. LINE Login

เหมาะสำหรับแขก/ครอบครัวที่ส่วนใหญ่มี LINE อยู่แล้ว

1. เข้า [LINE Developers Console](https://developers.line.biz/console/) → ล็อกอินด้วยบัญชี LINE
2. สร้าง **Provider** ใหม่ (หรือใช้ตัวที่มีอยู่) ตั้งชื่อ เช่น `ZyGen`
3. ในหน้า Provider กด **Create a new channel** → เลือกประเภท **LINE Login**
4. กรอกข้อมูลช่อง เช่น Channel name `ZG Live Jam`, Channel description, App type ติ๊ก **Web app** → สร้างช่อง (agree ข้อตกลง)
5. แท็บ **Basic settings** จะเห็น **Channel ID** และ **Channel secret** — คัดลอกไปใส่ `LINE_CLIENT_ID` และ `LINE_CLIENT_SECRET` ตามลำดับ
6. แท็บ **LINE Login** → ช่อง **Callback URL** → กด Edit วาง `http://localhost:3000/auth/line/callback` (ทดสอบเครื่องตัวเอง — ถ้า console ไม่ยอมรับ URL ที่ไม่ใช่ https ให้ข้าม LINE ไปทดสอบตอน deploy จริงแทน) → Update
7. (ไม่บังคับ) ถ้าอยากได้อีเมลผู้ใช้ด้วย ในแท็บ Basic settings หัวข้อ **OpenID Connect** กด **Apply** เพื่อขอสิทธิ์ email scope (ต้องแนบภาพหน้าจอที่อธิบายว่าจะใช้อีเมลทำอะไร) — ถ้าไม่ขอ ระบบจะยังใช้งานได้ปกติ แค่ไม่มีอีเมลผู้ใช้เก็บไว้ (ใช้ชื่อ LINE แทน)

---

## หลังตั้งค่าเสร็จ

ใส่ค่าที่คัดลอกมาเป็น Environment Variables (ดู `.env.example` ประกอบ):

- **รันทดสอบในเครื่องตัวเอง:** คัดลอกไฟล์ `.env.example` เปลี่ยนชื่อเป็น `.env` (อยู่โฟลเดอร์เดียวกับ `server.js`) แล้วใส่ค่าที่ได้มา จากนั้น `npm start` ได้เลย — ตัวแอปมีตัวอ่าน `.env` อยู่ในตัวแล้ว ไม่ต้องติดตั้งอะไรเพิ่ม (ไฟล์ `.env` จะไม่ถูกอัปโหลดขึ้น GitHub เพราะอยู่ใน `.gitignore` แล้ว)
  - ตั้ง `APP_BASE_URL=http://localhost:3000` และใส่ Redirect URI ที่ provider เป็น `http://localhost:3000/auth/xxx/callback` — Google และ Microsoft รองรับ `http://localhost` สำหรับทดสอบได้โดยตรง ส่วน LINE บาง console อาจไม่ยอมรับ URL ที่ไม่ใช่ https ถ้าเจอแบบนั้นให้ข้าม LINE ไปทดสอบตอน deploy จริงแทน
- **Deploy บน Render.com:** ไปที่ service → แท็บ **Environment** → เพิ่มตัวแปรทีละตัวตามชื่อใน `.env.example` (ต้องมี `APP_BASE_URL` เป็นลิงก์จริงของ service เช่น `https://zg-live-jam.onrender.com` ไม่ใช่ localhost) แล้วไปแก้ Redirect URI ที่ตั้งไว้ที่ provider แต่ละเจ้าให้ตรงกับลิงก์จริงด้วย (เปลี่ยนจาก localhost เป็นลิงก์จริง)

**สำคัญ:** ทุกครั้งที่เปลี่ยนหรือเพิ่ม Redirect URI ที่ provider ต้องให้ตรงกับ `APP_BASE_URL` เป๊ะๆ (รวม https/http และไม่มี `/` ปิดท้าย) ไม่งั้น login จะ error `redirect_uri_mismatch`

ไม่จำเป็นต้องตั้งครบทั้ง 3 provider — ตั้งแค่ตัวที่สะดวกก็พอ ปุ่มในหน้า login จะโชว์เฉพาะ provider ที่ตั้งค่าไว้เท่านั้น
