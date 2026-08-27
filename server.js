const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const multer = require('multer');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8889;
const DB_PATH = path.join(__dirname, 'db.json');
const USERS_DB_PATH = path.join(__dirname, 'users.json');
const SCHEDULES_DB_PATH = path.join(__dirname, 'schedules.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s+/g, '_');
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// DATABASE HELPERS FOR TV, USER & SCHEDULE
// ==========================================

function readDatabase() {
  try {
    if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2));
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8') || '[]');
    return data.map(item => ({ ...item, port: item.port || '5555' }));
  } catch (err) {
    return [];
  }
}

function writeDatabase(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    return false;
  }
}

function readUsersDatabase() {
  try {
    if (!fs.existsSync(USERS_DB_PATH)) {
      const defaultUsers = [{ id: "usr-admin", username: "admin", password: "adminpassword", role: "admin" }];
      fs.writeFileSync(USERS_DB_PATH, JSON.stringify(defaultUsers, null, 2));
    }
    return JSON.parse(fs.readFileSync(USERS_DB_PATH, 'utf8') || '[]');
  } catch (err) {
    return [];
  }
}

function writeUsersDatabase(data) {
  try {
    fs.writeFileSync(USERS_DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    return false;
  }
}

function readSchedulesDatabase() {
  try {
    if (!fs.existsSync(SCHEDULES_DB_PATH)) fs.writeFileSync(SCHEDULES_DB_PATH, JSON.stringify([], null, 2));
    return JSON.parse(fs.readFileSync(SCHEDULES_DB_PATH, 'utf8') || '[]');
  } catch (err) {
    return [];
  }
}

function writeSchedulesDatabase(data) {
  try {
    fs.writeFileSync(SCHEDULES_DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    return false;
  }
}

function getServerIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function getTvDevice(ip, port) {
  const tvs = readDatabase();
  const tv = tvs.find(t => t.ip === ip && String(t.port || '5555') === String(port || '5555'));
  const finalPort = port || (tv && tv.port ? tv.port : '5555');
  return { ip, port: finalPort, target: `${ip}:${finalPort}` };
}

// ==========================================
// SCHEDULE ENGINE (CRON EXECUTION)
// ==========================================

function executeTvAction(target, action) {
  const keycode = action === 'SLEEP_TV' ? '223' : '224';
  exec(`adb devices`, { timeout: 1500 }, (err, stdout) => {
    const devicesOutput = stdout || '';
    if (devicesOutput.includes(`${target}\tunauthorized`)) return;

    exec(`adb connect ${target}`, { timeout: 2000 }, () => {
      exec(`adb -s ${target} shell input keyevent ${keycode}`, { timeout: 3000 });
    });
  });
}

cron.schedule('* * * * *', () => {
  const now = new Date();
  const currentMin = now.getMinutes();
  const currentHour = now.getHours();
  const currentDate = now.getDate();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  let schedules = readSchedulesDatabase();
  let updated = false;

  schedules.forEach(item => {
    if (!item.enabled) return;

    const [sHour, sMin] = item.time.split(':').map(Number);
    if (sHour !== currentHour || sMin !== currentMin) return;

    let shouldExecute = false;

    if (item.type === 'once') {
      const [sYear, sMonth, sDay] = item.date.split('-').map(Number);
      if (sYear === currentYear && sMonth === currentMonth && sDay === currentDate) {
        shouldExecute = true;
        item.enabled = false;
        updated = true;
      }
    } else if (item.type === 'daily') {
      shouldExecute = true;
    } else if (item.type === 'monthly') {
      if (item.dayOfMonth === currentDate) shouldExecute = true;
    } else if (item.type === 'yearly') {
      if (item.dayOfMonth === currentDate && item.monthOfYear === currentMonth) shouldExecute = true;
    }

    if (shouldExecute) {
      item.targetTvs.forEach(target => {
        executeTvAction(target, item.action);
      });
    }
  });

  if (updated) writeSchedulesDatabase(schedules);
});

// ==========================================
// REST APIs (SCHEDULE & USER)
// ==========================================

app.get('/api/schedules', (req, res) => res.json(readSchedulesDatabase()));

app.post('/api/schedules', (req, res) => {
  const { title, action, type, time, date, dayOfMonth, monthOfYear, targetTvs } = req.body;
  if (!title || !action || !type || !time || !targetTvs || targetTvs.length === 0) {
    return res.status(400).json({ error: 'Missing required schedule fields' });
  }

  const schedules = readSchedulesDatabase();
  const newSchedule = {
    id: 'sch-' + Date.now(),
    title: title.trim(),
    action,
    type,
    time,
    date: date || '',
    dayOfMonth: Number(dayOfMonth) || 1,
    monthOfYear: Number(monthOfYear) || 1,
    targetTvs,
    enabled: true
  };

  schedules.push(newSchedule);
  if (writeSchedulesDatabase(schedules)) res.status(201).json(newSchedule);
  else res.status(500).json({ error: 'Save failed' });
});

app.put('/api/schedules/:id/toggle', (req, res) => {
  let schedules = readSchedulesDatabase();
  const item = schedules.find(s => s.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  item.enabled = !item.enabled;
  if (writeSchedulesDatabase(schedules)) res.json(item);
  else res.status(500).json({ error: 'Update failed' });
});

app.delete('/api/schedules/:id', (req, res) => {
  let schedules = readSchedulesDatabase();
  const filtered = schedules.filter(s => s.id !== req.params.id);
  if (writeSchedulesDatabase(filtered)) res.json({ success: true });
  else res.status(500).json({ error: 'Delete failed' });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const users = readUsersDatabase();
  const user = users.find(u => u.username === username && u.password === password);

  if (user) res.json({ success: true, username: user.username, role: user.role });
  else res.status(401).json({ error: 'Invalid username or password' });
});

app.get('/api/users', (req, res) => {
  const users = readUsersDatabase();
  res.json(users.map(u => ({ id: u.id, username: u.username, role: u.role })));
});

app.post('/api/users', (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const users = readUsersDatabase();
  if (users.some(u => u.username === username.trim())) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  const newUser = {
    id: 'usr-' + Date.now(),
    username: username.trim(),
    password: password.trim(),
    role: role || 'operator'
  };

  users.push(newUser);
  if (writeUsersDatabase(users)) res.status(201).json({ id: newUser.id, username: newUser.username, role: newUser.role });
  else res.status(500).json({ error: 'Save failed' });
});

app.put('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const { username, password, role } = req.body;
  let users = readUsersDatabase();
  const index = users.findIndex(u => u.id === id);

  if (index === -1) return res.status(404).json({ error: 'User not found' });
  if (username) users[index].username = username.trim();
  if (password && password.trim() !== '') users[index].password = password.trim();
  if (role) users[index].role = role;

  if (writeUsersDatabase(users)) res.json({ id: users[index].id, username: users[index].username, role: users[index].role });
  else res.status(500).json({ error: 'Update failed' });
});

app.delete('/api/users/:id', (req, res) => {
  let users = readUsersDatabase();
  if (users.length <= 1) return res.status(400).json({ error: 'Cannot delete the last admin user' });
  const filtered = users.filter(u => u.id !== req.params.id);
  if (writeUsersDatabase(filtered)) res.json({ success: true });
  else res.status(500).json({ error: 'Delete failed' });
});

// ==========================================
// TV REST APIS
// ==========================================

app.get('/api/server-info', (req, res) => res.json({ serverIp: getServerIp(), port: PORT }));
app.get('/api/tvs', (req, res) => res.json(readDatabase()));

app.post('/api/tvs', (req, res) => {
  const { name, ip, port } = req.body;
  if (!name || !ip) return res.status(400).json({ error: 'Name and IP required' });
  const tvs = readDatabase();
  const newTv = { 
    id: 'tv-' + Date.now(), 
    name: name.trim(), 
    ip: ip.trim(), 
    port: port ? port.trim() : '5555' 
  };
  tvs.push(newTv);
  if (writeDatabase(tvs)) res.status(201).json(newTv);
  else res.status(500).json({ error: 'Save failed' });
});

app.put('/api/tvs/:id', (req, res) => {
  const { id } = req.params;
  const { name, ip, port } = req.body;
  let tvs = readDatabase();
  const index = tvs.findIndex(t => t.id === id);
  if (index === -1) return res.status(404).json({ error: 'TV not found' });
  tvs[index] = { 
    ...tvs[index], 
    name: name ? name.trim() : tvs[index].name, 
    ip: ip ? ip.trim() : tvs[index].ip,
    port: port ? port.trim() : tvs[index].port || '5555'
  };
  if (writeDatabase(tvs)) res.json(tvs[index]);
  else res.status(500).json({ error: 'Update failed' });
});

app.delete('/api/tvs/:id', (req, res) => {
  let tvs = readDatabase();
  const filtered = tvs.filter(t => t.id !== req.params.id);
  if (tvs.length === filtered.length) return res.status(404).json({ error: 'Not found' });
  if (writeDatabase(filtered)) res.json({ success: true });
  else res.status(500).json({ error: 'Delete failed' });
});

app.get('/api/get-tv-network', (req, res) => {
  const targetIp = req.query.ip;
  const targetPort = req.query.port;
  if (!targetIp) return res.status(400).json({ error: 'Target TV IP required' });
  const device = getTvDevice(targetIp, targetPort);

  exec(`adb connect ${device.target}`, { timeout: 3000 }, () => {
    exec(`adb -s ${device.target} shell ip route`, { timeout: 3000 }, (err, stdout, stderr) => {
      if (err) return res.status(500).json({ error: 'Failed', details: stderr || err.message });
      res.json({ ip: targetIp, port: device.port, routeInfo: stdout.trim() });
    });
  });
});

app.get('/api/get-device-info', (req, res) => {
  const targetIp = req.query.ip;
  const targetPort = req.query.port;
  if (!targetIp) return res.status(400).json({ error: 'Target TV IP required' });
  const device = getTvDevice(targetIp, targetPort);

  exec(`adb connect ${device.target}`, { timeout: 3000 }, (connErr) => {
    if (connErr) return res.status(500).json({ error: 'Device unreachable' });

    const cmd = `adb -s ${device.target} shell "getprop ro.product.manufacturer && echo '---' && getprop ro.product.model && echo '---' && getprop ro.product.brand"`;
    exec(cmd, { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) return res.status(500).json({ error: 'Failed to fetch info' });

      const parts = stdout.split('---').map(s => s.trim());
      const manufacturer = parts[0] || 'Unknown';
      const model = parts[1] || 'Unknown';
      const brand = parts[2] || 'Unknown';
      const isZte = manufacturer.toLowerCase().includes('zte') || brand.toLowerCase().includes('zte') || model.toLowerCase().includes('b86');

      res.json({ ip: targetIp, port: device.port, manufacturer, model, brand, deviceType: isZte ? 'ZTE Box 📦' : 'Standard Android TV 📺' });
    });
  });
});

app.get('/api/get-current-app', (req, res) => {
  const targetIp = req.query.ip;
  const targetPort = req.query.port;
  if (!targetIp) return res.status(400).json({ error: 'Target TV IP required' });
  const device = getTvDevice(targetIp, targetPort);

  exec(`adb connect ${device.target}`, { timeout: 3000 }, () => {
    exec(`adb -s ${device.target} shell "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"`, { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return res.json({ ip: targetIp, port: device.port, package: 'Unknown', appName: 'Unknown / Off' });

      const match = stdout.match(/([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.]+)/);
      if (match && match[1]) {
        const packageName = match[1];
        const appNames = {
          'com.wetv.tv': 'WeTV (TV)',
          'com.netflix.ninja': 'Netflix',
          'com.wbd.stream': 'HBO Max / Max',
          'tv.danmaku.bili': 'Bilibili (TV)',
          'com.bilibili.app.in': 'Bilibili (TV)',
          'com.iqiyi.i18n.tv': 'iQIYI (TV)',
          'com.google.android.youtube.tv': 'YouTube (TV)',
          'com.disney.disneyplus': 'Disney+ (TV)',
          'com.google.android.tvlauncher': 'Android TV Home'
        };
        res.json({ ip: targetIp, port: device.port, package: packageName, appName: appNames[packageName] || packageName });
      } else {
        res.json({ ip: targetIp, port: device.port, package: 'Home', appName: 'Home Screen' });
      }
    });
  });
});

app.get('/api/get-system-resources', (req, res) => {
  const targetIp = req.query.ip;
  const targetPort = req.query.port;
  if (!targetIp) return res.status(400).json({ error: 'Target TV IP required' });
  const device = getTvDevice(targetIp, targetPort);

  exec(`adb connect ${device.target}`, { timeout: 3000 }, () => {
    const cmd = `adb -s ${device.target} shell "cat /proc/meminfo && echo '---SPLIT---' && df -h /data && echo '---SPLIT---' && dumpsys wifi"`;
    exec(cmd, { timeout: 6000 }, (err, stdout) => {
      if (err || !stdout) return res.status(500).json({ error: 'Failed to fetch resources' });

      const parts = stdout.split('---SPLIT---');
      const ramOut = parts[0] || '';
      const storageOut = parts[1] || '';
      const wifiOut = parts[2] || '';

      let ramInfo = { total: 'N/A', used: 'N/A', free: 'N/A', percent: 0 };
      const memTotalMatch = ramOut.match(/MemTotal:\s+(\d+)\s+kB/i);
      const memAvailableMatch = ramOut.match(/MemAvailable:\s+(\d+)\s+kB/i) || ramOut.match(/MemFree:\s+(\d+)\s+kB/i);

      if (memTotalMatch && memAvailableMatch) {
        const totalKb = parseInt(memTotalMatch[1]);
        const availKb = parseInt(memAvailableMatch[1]);
        const usedKb = totalKb - availKb;
        ramInfo = {
          total: `${Math.round(totalKb / 1024)} MB`,
          used: `${Math.round(usedKb / 1024)} MB`,
          free: `${Math.round(availKb / 1024)} MB`,
          percent: Math.round((usedKb / totalKb) * 100)
        };
      }

      let storageInfo = { size: 'N/A', used: 'N/A', avail: 'N/A', percent: '0%' };
      const storageLines = storageOut.trim().split('\n');
      if (storageLines.length >= 2) {
        const dataLine = storageLines.find(line => line.includes('/data')) || storageLines[1];
        const cols = dataLine.trim().split(/\s+/);
        if (cols.length >= 5) storageInfo = { size: cols[1], used: cols[2], avail: cols[3], percent: cols[4] };
      }

      let wifiInfo = { rssi: 'Ethernet / Connected 🌐', linkSpeed: 'LAN Cable', ssid: 'Wired Network' };
      const rssiMatch = wifiOut.match(/RSSI:\s*(-?\d+)/i) || wifiOut.match(/rssi=(-?\d+)/i);
      const speedMatch = wifiOut.match(/Link speed:\s*(\d+\s*Mbps)/i) || wifiOut.match(/linkSpeed=(\d+)/i);
      const ssidMatch = wifiOut.match(/SSID:\s*"?([^",\n]+)"?/i);

      if (rssiMatch && parseInt(rssiMatch[1]) !== -127 && parseInt(rssiMatch[1]) !== 0) {
        const rssiVal = parseInt(rssiMatch[1]);
        let signalQuality = rssiVal >= -60 ? 'Excellent 🟢' : rssiVal >= -75 ? 'Good 🟡' : 'Weak 🔴';
        wifiInfo = {
          rssi: `${rssiVal} dBm (${signalQuality})`,
          linkSpeed: speedMatch ? (speedMatch[1].includes('Mbps') ? speedMatch[1] : `${speedMatch[1]} Mbps`) : 'N/A',
          ssid: ssidMatch ? ssidMatch[1].trim() : 'Connected'
        };
      }

      res.json({ ip: targetIp, port: device.port, ram: ramInfo, storage: storageInfo, wifi: wifiInfo });
    });
  });
});

app.post('/api/install-apk', upload.single('apkFile'), (req, res) => {
  const targetIp = req.body.ip;
  const targetPort = req.body.port;
  const uploadedFile = req.file;
  if (!targetIp || !uploadedFile) return res.status(400).json({ error: 'IP and File required' });

  const device = getTvDevice(targetIp, targetPort);
  const filePath = uploadedFile.path;
  const originalName = uploadedFile.originalname.toLowerCase();

  let tempExtractDir = null;

  const runInstall = (apkPaths) => {
    const isMultiple = apkPaths.length > 1;
    const installCmd = isMultiple
      ? `adb -s ${device.target} install-multiple -r -d -g ${apkPaths.join(' ')}`
      : `adb -s ${device.target} install -r -d -g ${apkPaths[0]}`;

    exec(`adb connect ${device.target}`, { timeout: 3000 }, () => {
      exec(installCmd, { timeout: 180000 }, (instErr, stdout, stderr) => {
        // ลบไฟล์อัปโหลดและโฟลเดอร์ชั่วคราว
        fs.unlink(filePath, () => {});
        if (tempExtractDir && fs.existsSync(tempExtractDir)) {
          exec(`rm -rf "${tempExtractDir}"`);
        }

        const output = (stdout || '') + (stderr || '');
        if (instErr || !output.includes('Success')) {
          return res.status(500).json({ error: 'Install failed', details: output.trim() || instErr.message });
        }
        res.json({ message: `Installed ${apkPaths.length} package(s) successfully!`, output: output.trim() });
      });
    });
  };

  try {
    if (originalName.endsWith('.zip') || originalName.endsWith('.xapk') || originalName.endsWith('.apks')) {
      tempExtractDir = path.join(UPLOAD_DIR, 'temp-upload-' + Date.now());
      fs.mkdirSync(tempExtractDir, { recursive: true });

      exec(`unzip -o -q "${filePath}" -d "${tempExtractDir}"`, (unzipErr) => {
        if (unzipErr) {
          fs.unlink(filePath, () => {});
          exec(`rm -rf "${tempExtractDir}"`);
          return res.status(500).json({ error: 'Failed to extract archive', details: unzipErr.message });
        }

        const files = fs.readdirSync(tempExtractDir).filter(f => f.endsWith('.apk'));
        if (files.length === 0) {
          fs.unlink(filePath, () => {});
          exec(`rm -rf "${tempExtractDir}"`);
          return res.status(400).json({ error: 'No .apk files found inside compressed archive' });
        }

        runInstall(files.map(f => `"${path.join(tempExtractDir, f)}"`));
      });
    } else {
      // ไฟล์เดี่ยว .apk
      runInstall([`"${filePath}"`]);
    }
  } catch (err) {
    fs.unlink(filePath, () => {});
    if (tempExtractDir && fs.existsSync(tempExtractDir)) {
      exec(`rm -rf "${tempExtractDir}"`);
    }
    res.status(500).json({ error: 'Server process error', details: err.message });
  }
});

app.get('/api/get-installed-apps', (req, res) => {
  const targetIp = req.query.ip;
  const targetPort = req.query.port;
  const appType = req.query.type || 'user';
  if (!targetIp) return res.status(400).json({ error: 'Target TV IP required' });

  const device = getTvDevice(targetIp, targetPort);
  let flag = appType === 'system' ? '-s' : appType === 'all' ? '' : '-3';

  exec(`adb connect ${device.target}`, { timeout: 3000 }, () => {
    exec(`adb -s ${device.target} shell pm list packages ${flag}`, { timeout: 5000 }, (cmdErr, stdout, stderr) => {
      if (cmdErr) return res.status(500).json({ error: 'Failed', details: stderr || cmdErr.message });
      const packages = stdout.trim().split('\n').map(line => line.replace(/^package:/, '').trim()).filter(line => line.length > 0);
      res.json({ ip: targetIp, port: device.port, type: appType, total: packages.length, packages });
    });
  });
});

app.get('/api/get-app-version', (req, res) => {
  const targetIp = req.query.ip;
  const targetPort = req.query.port;
  const pkgNamesStr = req.query.package;
  if (!targetIp || !pkgNamesStr) return res.status(400).json({ error: 'IP and Package required' });

  const device = getTvDevice(targetIp, targetPort);
  const pkgList = pkgNamesStr.split(',');

  exec(`adb connect ${device.target}`, { timeout: 3000 }, () => {
    let foundVersion = 'Not Installed';
    let matchedPkg = pkgList[0];
    let count = 0;

    pkgList.forEach((pkg) => {
      exec(`adb -s ${device.target} shell dumpsys package ${pkg.trim()}`, { timeout: 4000 }, (err, stdout) => {
        count++;
        if (!err && stdout) {
          const match = stdout.match(/versionName=([^\s]+)/);
          if (match && match[1]) {
            foundVersion = match[1];
            matchedPkg = pkg.trim();
          }
        }
        if (count === pkgList.length) {
          res.json({ ip: targetIp, port: device.port, package: matchedPkg, versionName: foundVersion });
        }
      });
    });
  });
});

const APK_REPO_DIR = path.join(__dirname, 'apk-repo');
const VERSIONS_FILE = path.join(APK_REPO_DIR, 'versions.json');

// API ตรวจสอบอัปเดต โดยเทียบเวอร์ชันบนกล่องกับคลัง APK บนเซิร์ฟเวอร์
app.get('/api/check-app-updates', (req, res) => {
  const targetIp = req.query.ip;
  const targetPort = req.query.port;
  if (!targetIp) return res.status(400).json({ error: 'Target TV IP required' });

  const device = getTvDevice(targetIp, targetPort);
  let repoVersions = [];
  try {
    if (fs.existsSync(VERSIONS_FILE)) {
      repoVersions = JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf8') || '[]');
    }
  } catch (e) { repoVersions = []; }

  if (repoVersions.length === 0) {
    return res.json({ ip: targetIp, port: device.port, apps: [] });
  }

  exec(`adb connect ${device.target}`, { timeout: 3000 }, () => {
    let checkedCount = 0;
    const results = [];

    repoVersions.forEach(appItem => {
      exec(`adb -s ${device.target} shell dumpsys package ${appItem.package}`, { timeout: 4000 }, (err, stdout) => {
        checkedCount++;
        let installedVersion = 'Not Installed';
        if (!err && stdout) {
          const match = stdout.match(/versionName=([^\s]+)/);
          if (match && match[1]) installedVersion = match[1];
        }

        const hasUpdate = installedVersion !== appItem.latestVersion && installedVersion !== 'Not Installed';
        const apkPath = path.join(APK_REPO_DIR, appItem.apkFileName);
        const apkReady = fs.existsSync(apkPath);

        results.push({
          ...appItem,
          installedVersion,
          hasUpdate,
          apkReady
        });

        if (checkedCount === repoVersions.length) {
          res.json({ ip: targetIp, port: device.port, apps: results });
        }
      });
    });
  });
});

// API สั่งติดตั้งอัปเดตจาก APK ในคลังเซิร์ฟเวอร์ (รองรับทั้งไฟล์เดี่ยว, โฟลเดอร์, และไฟล์ .zip / .xapk / .apks)
app.post('/api/apply-app-update', (req, res) => {
  const { ip, port, apkFileName } = req.body;
  if (!ip || !apkFileName) return res.status(400).json({ error: 'IP and APK target required' });

  const device = getTvDevice(ip, port);
  const targetPath = path.join(APK_REPO_DIR, apkFileName);

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: `File or Directory '${apkFileName}' not found on server repo` });
  }

  const stat = fs.statSync(targetPath);
  let tempExtractDir = null;

  const runInstallation = (apkPaths) => {
    const isMultiple = apkPaths.length > 1;
    const installCmd = isMultiple
      ? `adb -s ${device.target} install-multiple -r -d -g ${apkPaths.join(' ')}`
      : `adb -s ${device.target} install -r -d -g ${apkPaths[0]}`;

    exec(`adb connect ${device.target}`, { timeout: 3000 }, () => {
      exec(installCmd, { timeout: 180000 }, (err, stdout, stderr) => {
        if (tempExtractDir && fs.existsSync(tempExtractDir)) {
          exec(`rm -rf "${tempExtractDir}"`);
        }

        const output = (stdout || '') + (stderr || '');
        if (err || !output.includes('Success')) {
          return res.status(500).json({
            error: 'Installation failed',
            details: output.trim() || err.message
          });
        }

        res.json({
          success: true,
          message: `Installed ${apkPaths.length} package(s) successfully!`,
          output: output.trim()
        });
      });
    });
  };

  try {
    if (stat.isDirectory()) {
      // 1. กรณีเป็นโฟลเดอร์ Split APKs
      const files = fs.readdirSync(targetPath).filter(f => f.endsWith('.apk'));
      if (files.length === 0) return res.status(400).json({ error: 'No .apk files found in directory' });
      runInstallation(files.map(f => `"${path.join(targetPath, f)}"`));
    } else if (apkFileName.endsWith('.zip') || apkFileName.endsWith('.xapk') || apkFileName.endsWith('.apks')) {
      // 2. กรณีเป็นไฟล์บีบอัด (.zip / .xapk / .apks) ใช้ unzip ของ Linux
      tempExtractDir = path.join(UPLOAD_DIR, 'temp-split-' + Date.now());
      fs.mkdirSync(tempExtractDir, { recursive: true });

      exec(`unzip -o -q "${targetPath}" -d "${tempExtractDir}"`, (unzipErr) => {
        if (unzipErr) {
          exec(`rm -rf "${tempExtractDir}"`);
          return res.status(500).json({ error: 'Failed to extract archive', details: unzipErr.message });
        }

        const files = fs.readdirSync(tempExtractDir).filter(f => f.endsWith('.apk'));
        if (files.length === 0) {
          exec(`rm -rf "${tempExtractDir}"`);
          return res.status(400).json({ error: 'No .apk files found inside compressed archive' });
        }

        runInstallation(files.map(f => `"${path.join(tempExtractDir, f)}"`));
      });
    } else {
      // 3. กรณีเป็นไฟล์ .apk เดี่ยว
      runInstallation([`"${targetPath}"`]);
    }
  } catch (error) {
    if (tempExtractDir && fs.existsSync(tempExtractDir)) {
      exec(`rm -rf "${tempExtractDir}"`);
    }
    res.status(500).json({ error: 'Server process error', details: error.message });
  }
});

// ==========================================
// SCREEN CAPTURE & REMOTE CONTROL
// ==========================================

function captureScreen(ip, port) {
  return new Promise((resolve, reject) => {
    const device = getTvDevice(ip, port);
    // ขยาย maxBuffer เป็น 20MB และตั้ง timeout 4500ms ป้องกัน SurfaceFlinger ค้างขณะเล่น Stream
    exec(`adb -s ${device.target} exec-out screencap -p`, { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 4500 }, (err, stdout) => {
      if (err || !stdout || stdout.length < 1000) {
        return reject(err || new Error('Capture failed or empty frame'));
      }
      resolve(`data:image/png;base64,${stdout.toString('base64')}`);
    });
  });
}

function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}

function checkTvStatus(ip, port) {
  return new Promise((resolve) => {
    const targetPort = port || '5555';
    const target = `${ip}:${targetPort}`;

    exec(`adb devices`, { timeout: 1500 }, (devErr, devStdout) => {
      const devicesOutput = devStdout || '';
      if (devicesOutput.includes(`${target}\tdevice`)) {
        return resolve({ ip, port: targetPort, target, status: 'online' });
      }
      if (devicesOutput.includes(`${target}\tunauthorized`)) {
        return resolve({ ip, port: targetPort, target, status: 'offline' });
      }

      exec(`adb connect ${target}`, { timeout: 2000 }, (connErr, connStdout) => {
        const output = (connStdout || '').trim();
        if (output.includes('connected to') || output.includes('already connected')) {
          resolve({ ip, port: targetPort, target, status: 'online' });
        } else {
          resolve({ ip, port: targetPort, target, status: 'offline' });
        }
      });
    });
  });
}

async function pollTvStatuses() {
  const tvs = readDatabase();
  if (!tvs || tvs.length === 0) return;
  
  const results = [];
  for (const tv of tvs) {
    try {
      const res = await checkTvStatus(tv.ip, tv.port);
      results.push(res);
    } catch (e) {
      results.push({ ip: tv.ip, port: tv.port || '5555', status: 'offline' });
    }
  }
  if (typeof broadcast === 'function') broadcast({ action: 'STATUS_UPDATE', statuses: results });
}

setInterval(pollTvStatuses, 60000);

wss.on('connection', (ws) => {
  pollTvStatuses();

  ws.on('message', async (message) => {
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }
    
    const { action, ip, port } = data;
    if (!ip && action !== 'CHECK_ALL_STATUS') return;

    const device = getTvDevice(ip, port);
    const target = device.target;

    try {
      switch (action) {
        case 'CHECK_ALL_STATUS':
          await pollTvStatuses();
          break;
        case 'CAPTURE_SCREEN': {
          try {
            const imgData = await captureScreen(ip, port);
            ws.send(JSON.stringify({ status: 'success', action: 'SCREEN_FRAME', ip, port: device.port, image: imgData }));
          } catch (err) {
            ws.send(JSON.stringify({ status: 'error', action: 'SCREEN_FRAME', ip, port: device.port, message: err.message }));
          }
          break;
        }
        case 'TAP':
          exec(`adb -s ${target} shell input tap ${data.x} ${data.y}`);
          break;
        case 'UP':
          exec(`adb -s ${target} shell input keyevent 19`);
          break;
        case 'DOWN':
          exec(`adb -s ${target} shell input keyevent 20`);
          break;
        case 'LEFT':
          exec(`adb -s ${target} shell input keyevent 21`);
          break;
        case 'RIGHT':
          exec(`adb -s ${target} shell input keyevent 22`);
          break;
        case 'OK':
          exec(`adb -s ${target} shell input keyevent 23`);
          break;
        case 'VOLUME_MUTE':
          exec(`adb -s ${target} shell input keyevent 164`);
          break;
        case 'VOLUME_UP':
          exec(`adb -s ${target} shell input keyevent 24`);
          break;
        case 'VOLUME_DOWN':
          exec(`adb -s ${target} shell input keyevent 25`);
          break;
        case 'SWIPE_UP':
          exec(`adb -s ${target} shell input swipe 500 800 500 200 300`);
          break;
        case 'SWIPE_DOWN':
          exec(`adb -s ${target} shell input swipe 500 200 500 800 300`);
          break;
        case 'HOME':
          exec(`adb -s ${target} shell input keyevent 3`);
          break;
        case 'BACK':
          exec(`adb -s ${target} shell input keyevent 4`);
          break;
        case 'OPEN_SETTINGS':
          exec(`adb -s ${target} shell am start -a android.settings.SETTINGS`);
          break;
        case 'PAIR_REMOTE': {
          const zteCommands = [
            `adb -s ${target} shell am start -n com.android.tv.settings/.accessories.AddAccessoryActivity`,
            `adb -s ${target} shell am start -a android.settings.PAIR_BLUETOOTH_DEVICES`,
            `adb -s ${target} shell am start -a android.settings.BLUETOOTH_SETTINGS`,
            `adb -s ${target} shell am start -n com.google.android.apps.tv.remote.service/.settings.AddAccessoryActivity`
          ].join(' || ');

          exec(zteCommands, { timeout: 3500 }, (err) => {
            if (err) ws.send(JSON.stringify({ status: 'error', action, ip, port: device.port, message: err.message }));
            else ws.send(JSON.stringify({ status: 'success', action, ip, port: device.port, message: 'Opened Bluetooth pairing screen on TV' }));
          });
          break;
        }
        case 'SLEEP_TV':
          exec(`adb -s ${target} shell input keyevent 223`, (err) => {
            if (err) ws.send(JSON.stringify({ status: 'error', action, ip, port: device.port, message: err.message }));
            else ws.send(JSON.stringify({ status: 'success', action, ip, port: device.port, message: 'TV into Sleep Mode' }));
          });
          break;
        case 'WAKEUP_TV':
          exec(`adb -s ${target} shell input keyevent 224`, (err) => {
            if (err) ws.send(JSON.stringify({ status: 'error', action, ip, port: device.port, message: err.message }));
            else ws.send(JSON.stringify({ status: 'success', action, ip, port: device.port, message: 'TV Woken Up' }));
          });
          break;
        case 'REBOOT_TV':
          exec(`adb -s ${target} reboot`, (err) => {
            if (err) ws.send(JSON.stringify({ status: 'error', action, ip, port: device.port, message: err.message }));
            else ws.send(JSON.stringify({ status: 'success', action, ip, port: device.port, message: 'Rebooting Android TV...' }));
          });
          break;
        case 'FORCE_STOP_APP': {
          const pkg = data.package;
          exec(`adb -s ${target} shell am force-stop ${pkg}`, (err) => {
            if (err) ws.send(JSON.stringify({ status: 'error', action, ip, port: device.port, message: err.message }));
            else ws.send(JSON.stringify({ status: 'success', action, ip, port: device.port, message: `Force stopped ${pkg}` }));
          });
          break;
        }
        case 'LOCK_APP':
          exec(`adb -s ${target} shell am start -n ${data.package}/${data.activity || ''} --lock-task`);
          break;
        case 'UNLOCK_APP':
          exec(`adb -s ${target} shell am stop-lock-task`);
          break;
        case 'UNINSTALL_APP':
          exec(`adb -s ${target} shell pm uninstall ${data.package}`, (err, stdout) => {
            if (err) ws.send(JSON.stringify({ status: 'error', action, ip, port: device.port, message: err.message }));
            else ws.send(JSON.stringify({ status: 'success', action, ip, port: device.port, message: stdout.trim() }));
          });
          break;
        case 'CLEAR_APP_DATA': {
          const pkg = data.package;
          exec(`adb -s ${target} shell pm clear ${pkg}`, (err, stdout) => {
            if (err) ws.send(JSON.stringify({ status: 'error', action, ip, port: device.port, message: err.message }));
            else ws.send(JSON.stringify({ status: 'success', action, ip, port: device.port, message: `Cleared data for ${pkg}: ${stdout.trim()}` }));
          });
          break;
        }
        case 'CLEAR_ALL_APPS_DATA': {
          exec(`adb -s ${target} shell pm list packages -3`, (err, stdout) => {
            if (err) return ws.send(JSON.stringify({ status: 'error', action, ip, port: device.port, message: 'Failed to list apps' }));
            const packages = stdout.trim().split('\n').map(line => line.replace(/^package:/, '').trim()).filter(line => line.length > 0);
            if (packages.length === 0) return ws.send(JSON.stringify({ status: 'success', action, ip, port: device.port, message: 'No third-party apps to clear' }));

            let clearedCount = 0;
            packages.forEach(pkg => {
              exec(`adb -s ${target} shell pm clear ${pkg}`, () => {
                clearedCount++;
                if (clearedCount === packages.length) {
                  ws.send(JSON.stringify({ status: 'success', action, ip, port: device.port, message: `Successfully cleared data for all ${packages.length} apps!` }));
                }
              });
            });
          });
          break;
        }
      }
    } catch (err) {
      ws.send(JSON.stringify({ status: 'error', message: err.toString(), ip, port: device.port }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://${getServerIp()}:${PORT}`);
});