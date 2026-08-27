# android-tv-control
ระบบ Android TV Remote Screen Controller (เวอร์ชันล่าสุดที่รองรับทั้ง Realtime Canvas Snap Stream, Remote D-Pad, Split APKs Management, Cron Schedules และ Multi-Device Management

1. ภาพรวมระบบและโครงสร้างสถาปัตยกรรม
Live Screen Engine: สตรีมหน้าจอความเร็วสูงแบบ Realtime Canvas Stream ผ่าน WebSocket (Latency ต่ำ รองรับการควบคุมคลิกหน้าจอสด)
ADB Multi-Management: จัดการ Batch Command เช่น Home, Settings, Reboot, Sleep/Wakeup และ Bluetooth Pairing บน ZTE
App & Split APKs Installer: รองรับการติดตั้งและอัปเดตทั้งไฟล์เดี่ยว .apk และไฟล์ Split APKs (.zip, .xapk, .apks) ด้วย install-multiple
Schedule Cron Engine: ตั้งเวลาทำงานล่วงหน้าตามวัน/เดือน/ปี หรือแบบ Loop ประจำวัน

2. สิ่งที่ต้องเตรียม (Prerequisites)
องค์ประกอบ	เวอร์ชัน / สเปกขั้นต่ำ	หมายเหตุ
Operating System	Ubuntu 20.04 / 22.04 LTS	Headless / Cloud Server หรือเครื่อง On-Premises
Node.js Environment	Node.js v16.x - v20.x + NPM	ใช้รัน Express & WebSocket Engine
Android Platform Tools	ADB Version 30.0.0+	สำหรับสั่งการ Protocol ไปยังกล่อง Android
Process Manager	PM2 (Production Process Manager)	สำหรับสั่งรัน Background Service อัตโนมัติ

3. การติดตั้งฝั่ง Linux Server
3.1 ติดตั้งโปรแกรมและเครื่องมือจำเป็น
# อัปเดต Package และลงเครื่องมือพื้นฐาน
sudo apt update && sudo apt install -y curl wget unzip adb git

# ติดตั้ง Node.js (v18 LTS)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# ติดตั้ง PM2 สำหรับดูแลระบบ
sudo npm install -g pm2

3.2 โครงสร้างไดเรกทอรีโปรเจกต์
จัดวางโครงสร้างโฟลเดอร์ดังนี้:

/var/www/html/android-tv-control/

├── server.js               # Backend Node.js

├── package.json            # Node Dependencies

├── db.json                 # TV Devices Database

├── users.json              # Auth Users Database

├── schedules.json          # Cron Schedules Database

├── uploads/                # Temporary File Upload Storage

├── apk-repo/               # Local Repository สำหรับแอปอัปเดต

    └── versions.json       # Config ควบคุมเวอร์ชันแอป

└── public/                 # Frontend Web Interface
    
    ├── index.html          # Main Dashboard
    
    ├── schedule.html       # Schedule Manager UI
    
    ├── users.html          # User Management UI
    
    └── login.html          # Auth UI

3.3 ติดตั้ง Dependencies และเริ่มทำงานด้วย PM2
cd /var/www/html/android-tv-control

# ติดตั้ง Dependencies
npm install express ws multer node-cron

# เริ่มต้นระบบด้วย PM2
pm2 start server.js --name "android-tv-control"

# บันทึกสถานะเพื่อให้เปิดอัตโนมัติเมื่อเซิร์ฟเวอร์ Reboot
pm2 save
pm2 startup

3.4 ติดตั้ง scrcpy-server และ scrcpy Client (เวอร์ชันล่าสุด)
ระบบจำเป็นต้องใช้ scrcpy-server.jar เพื่อรองรับการจัดการสตรีมวิดีโอระดับฮาร์ดแวร์บน Android 10 - 14:

   3.4.1. ดาวน์โหลด scrcpy-server.jar เข้าสู่โฟลเดอร์โปรเจกต์:

cd /var/www/html/android-tv-control

# ดาวน์โหลด Server Binary v2.4
wget https://github.com/Genymobile/scrcpy/releases/download/v2.4/scrcpy-server-v2.4 -O scrcpy-server.jar

# กำหนดสิทธิ์การอ่านไฟล์
chmod 644 scrcpy-server.jar

   3.4.2. อัปเดต scrcpy Client บน Ubuntu Server (เลือกวิธีใดวิธีหนึ่ง):

วิธีที่ 1: ผ่าน Snap (แนะนำและสะดวกที่สุด)
# ลบเวอร์ชันเก่าออก
sudo apt remove -y scrcpy

# ติดตั้งเวอร์ชันล่าสุด
sudo snap install scrcpy
วิธีที่ 2: คอมไพล์จาก Source Code (สำหรับเซิร์ฟเวอร์ที่ไม่มี Snap)
# ติดตั้ง Build Dependencies
sudo apt update
sudo apt install -y ffmpeg libsdl2-2.0-0 libavcodec-dev libavformat-dev libavutil-dev \
                    libswresample-dev libsdl2-dev gcc git pkg-config meson ninja-build

# Clone และ Build
cd /tmp
git clone https://github.com/Genymobile/scrcpy
cd scrcpy
meson setup x --buildtype=release --strip -Db_lto=true
ninja -C x
sudo ninja -C x install

    3.4.3 ตรวจสอบเวอร์ชันหลังติดตั้ง:
scrcpy --version

4. การตั้งค่าตัวกล่อง Android TV (Device Setup)
เพื่อให้เซิร์ฟเวอร์สามารถจับภาพหน้าจอและสั่งการได้โดยไม่ติดระบบความปลอดภัย:

* เปิดกล่องทีวี ไปที่ Settings (การตั้งค่า) > Device Preferences (ค่ากำหนดอุปกรณ์) > About (เกี่ยวกับ)
* เลื่อนไปที่บรรทัด Build Number (หมายเลขบิลด์) แล้วกดปุ่ม OK บนรีโมทซ้ำๆ 7 ครั้ง จนขึ้นข้อความ "You are now a developer!"
* กลับมาที่หน้าก่อนหน้า เข้าเมนู Developer Options (สำหรับนักพัฒนาซอฟต์แวร์):
* เปิดใช้งาน USB Debugging
* เปิดใช้งาน Disable HW overlays (ปิดการซ้อนทับของฮาร์ดแวร์) สำคัญมากสำหรับ Homatics/Android 14
* เมื่อเซิร์ฟเวอร์ทำการเชื่อมต่อครั้งแรก จะมีหน้าต่างขึ้นบนจอทีวี ให้ติ๊ก "Always allow from this computer" แล้วกดยืนยัน OK

5. การตั้งค่าคลังอัปเดตแอป (Local APK Repository)
ไฟล์ apk-repo/versions.json ใช้สำหรับควบคุมเวอร์ชันแอปสตรีมมิ่งที่ต้องการให้ระบบตรวจสอบและแจ้งเตือนอัปเดต:

[
  {
    "name": "WeTV (TV)",
    "package": "com.wetv.tv",
    "latestVersion": "3.5.1",
    "apkFileName": "wetv-tv-3.5.1.apk"
  },
  {
    "name": "SmartTube (TV)",
    "package": "com.teamsmart.videomanager.tv",
    "latestVersion": "21.50",
    "apkFileName": "smarttube_beta.apk"
  }
]
การนำไฟล์ใส่ Repository: วางไฟล์ APK/Zip ลงในโฟลเดอร์ apk-repo/ ให้ชื่อไฟล์ตรงกับคีย์ apkFileName ใน JSON

6. การใช้งานและแก้ปัญหาเบื้องต้น
6.1 การควบคุมหน้าจอสด (Fast Canvas Live Stream)
เลือกกล่องที่ต้องการจากช่อง Target TV
กดปุ่ม "▶️ Start Live Stream" หน้าจอจะเริ่มสตรีมภาพสดต่อเนื่อง
สามารถใช้เมาส์คลิกบนจอภาพ Canvas เพื่อจำลองการใช้นิ้วแตะ (Tap) บนทีวีได้ทันที

6.2 ปัญหาที่พบบ่อย (Troubleshooting)
อาการ	สาเหตุ	วิธีแก้ไข
สถานะขึ้น Offline ตลอดเวลา	กล่องเปลี่ยน IP หรือยังไม่ Authorize ADB	รันคำสั่ง adb connect <IP>:5555 บน Server แล้วกดยอมรับบนหน้าจอทีวี
เปิด YouTube แล้วเป็นจอดำ	ติดสิทธิ์ Secure Surface / FLAG_SECURE	สลับไปใช้แอป SmartTube หรือเปิด "Disable HW overlays" บนกล่อง
Split APKs ติดตั้งไม่ผ่าน	ไฟล์ขาด base.apk หรือ config เฉพาะชิป	บีบอัดไฟล์ Split APKs เป็น .zip แล้วโยนผ่านฟังก์ชัน Upload & Install


