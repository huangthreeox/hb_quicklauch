const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');

// ==================== 配置管理 ====================
const configPath = path.join(app.getPath('userData'), 'config.json');

function loadAllData() {
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!raw.profiles) {
        return { active: 'default', profiles: { default: raw } };
      }
      if (!raw.profiles[raw.active]) {
        raw.active = Object.keys(raw.profiles)[0] || 'default';
      }
      return raw;
    }
  } catch (e) {
    console.error('读取配置失败:', e.message);
  }
  return { active: 'default', profiles: { default: { folders: [], apps: {} } } };
}

function saveAllData(data) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('保存配置失败:', e.message);
  }
}

function getActiveConfig() {
  const data = loadAllData();
  const profile = data.profiles[data.active] || { folders: [], apps: {} };
  return {
    folders: profile.folders || [],
    apps: profile.apps || {},
    activeProfile: data.active,
    recordingEnabled: profile.recordingEnabled !== false
  };
}

function saveActiveConfig(config) {
  const data = loadAllData();
  data.profiles[data.active] = {
    folders: config.folders,
    apps: config.apps,
    recordingEnabled: config.recordingEnabled !== false
  };
  saveAllData(data);
}

// ==================== 操作日志 ====================
const logDir = path.join(app.getPath('userData'), 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function getLogFile() {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return path.join(logDir, `quicklaunch-${date}.log`);
}

function writeLog(action, appName, detail) {
  const ts = new Date().toISOString().replace('T',' ').slice(0,19);
  const line = `[${ts}] ${action.padEnd(10)} ${appName || '-'}  ${detail || ''}`;
  try { fs.appendFileSync(getLogFile(), line + '\n', 'utf-8'); } catch(e) {}
}

function getAppDisplayName(appPath) {
  const cfg = getActiveConfig();
  const info = cfg.apps[appPath];
  return (info?.customName || info?.baseName || info?.name || appPath);
}

// ==================== 进程管理 ====================
const runningProcesses = new Map();

function startApp(appPath, args = '', runAsAdmin = false) {
  if (runAsAdmin) {
    return startAppAsAdmin(appPath, args);
  }
  return new Promise((resolve, reject) => {
    try {
      const argArray = args ? args.split(/\s+/).filter(a => a.length > 0) : [];
      const cwd = path.dirname(appPath);
      const child = spawn(appPath, argArray, {
        cwd,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();

      runningProcesses.set(appPath, { process: child, pid: child.pid });

      child.on('error', (err) => {
        runningProcesses.delete(appPath);
        writeLog('START ERR', getAppDisplayName(appPath), err.message);
        resolve({ success: false, error: err.message });
      });

      child.on('exit', (code) => {
        runningProcesses.delete(appPath);
        writeLog('EXITED', getAppDisplayName(appPath), `exit code ${code}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app-status-changed', { appPath, running: false, pid: null });
        }
      });

      writeLog('START', getAppDisplayName(appPath), `PID ${child.pid}`);
      resolve({ success: true, pid: child.pid });
    } catch (err) {
      writeLog('START ERR', getAppDisplayName(appPath), err.message);
      reject(err);
    }
  });
}

function startAppAsAdmin(appPath, args = '') {
  return new Promise((resolve) => {
    const escapedPath = appPath.replace(/'/g, "''");
    const argList = args || '';
    const psCmd = `$p=Start-Process '${escapedPath}' -ArgumentList '${argList}' -Verb RunAs -PassThru -WindowStyle Normal;if($p){$p.Id}else{0}`;
    const encodedCmd = Buffer.from(psCmd, 'utf16le').toString('base64');

    exec(`powershell -NoProfile -EncodedCommand ${encodedCmd}`, { timeout: 10000 }, (err, stdout) => {
      if (err) {
        writeLog('START ERR', getAppDisplayName(appPath), 'Admin launch failed: ' + err.message);
        resolve({ success: false, error: err.message });
        return;
      }
      const pid = parseInt(stdout);
      if (pid && pid > 0) {
        runningProcesses.set(appPath, { pid, admin: true });
        writeLog('START', getAppDisplayName(appPath), `PID ${pid} [ADMIN]`);
        resolve({ success: true, pid });
      } else {
        writeLog('START ERR', getAppDisplayName(appPath), 'UAC declined or failed');
        resolve({ success: false, error: 'UAC declined or launch failed' });
      }
    });
  });
}

function stopApp(appPath) {
  return new Promise((resolve) => {
    const entry = runningProcesses.get(appPath);
    if (!entry) {
      resolve({ success: false, error: '应用未在运行' });
      return;
    }

    writeLog('STOP', getAppDisplayName(appPath), `PID ${entry.pid}`);
    exec(`taskkill /PID ${entry.pid} /T /F`, (err) => {
      runningProcesses.delete(appPath);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app-status-changed', {
          appPath,
          running: false,
          pid: null
        });
      }
      resolve({ success: true });
    });
  });
}

function stopAllApps() {
  writeLog('STOP ALL', '-', `${runningProcesses.size} processes`);
  const promises = [];
  for (const [appPath] of runningProcesses) {
    promises.push(stopApp(appPath));
  }
  return Promise.all(promises);
}

async function startAllApps(config) {
  const entries = Object.entries(config.apps)
    .filter(([, cfg]) => cfg.enabled !== false)
    .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0));

  writeLog('START ALL', '-', `${entries.length} apps`);

  const results = [];
  for (const [appPath, appConfig] of entries) {
    const delay = Number(appConfig.delay) || 0;
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    try {
      const result = await startApp(appPath, appConfig.args || '', appConfig.runAsAdmin !== false);
      results.push({ appPath, ...result });
    } catch (err) {
      results.push({ appPath, success: false, error: err.message });
    }
  }
  return results;
}

function getRunningStatus() {
  const status = {};
  for (const [appPath, entry] of runningProcesses) {
    status[appPath] = { running: true, pid: entry.pid };
  }
  return status;
}

// ==================== 性能监控 ====================
const os = require('os');
let statsTimer = null;
let statsHistory = [];
let recordingEnabled = true; // CSV 录制开关

function loadRecordingState() {
  const data = loadAllData();
  const profile = data.profiles[data.active] || {};
  recordingEnabled = profile.recordingEnabled !== false;
}

function collectStats() {
  const pids = [...runningProcesses.values()].map(e => e.pid);
  if (pids.length === 0) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stats-updated', {
        systemCPU: getLocalSystemCPU(),
        processes: {}
      });
    }
    return;
  }

  const pidList = pids.join(',');
  const psCmd =
    `$sysCPU=(Get-WmiObject Win32_Processor|Measure-Object -Property LoadPercentage -Average).Average;` +
    `$procs=@{};@(${pidList})|ForEach-Object{$p=Get-Process -Id $_ -ErrorAction SilentlyContinue;if($p){$k=[string]$_;$procs[$k]=@{PID=$_;CPU=if($p.CPU){[math]::Round($p.CPU,1)}else{0};MemMB=[math]::Round($p.WorkingSet64/1MB,1)}}};` +
    `@{systemCPU=$sysCPU;processes=$procs}|ConvertTo-Json -Compress`;

  const encodedCmd = Buffer.from(psCmd, 'utf16le').toString('base64');
  exec(`powershell -NoProfile -EncodedCommand ${encodedCmd}`, { timeout: 5000 }, (err, stdout) => {
    if (err || !stdout) return;
    try {
      const stats = JSON.parse(stdout.trim());
      const timestamp = new Date().toISOString();

      if (recordingEnabled) {
        statsHistory.push({ timestamp, ...stats });
        if (statsHistory.length > 500) statsHistory.shift();
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stats-updated', stats);
      }
    } catch (e) { /* 忽略解析错误 */ }
  });
}

function getLocalSystemCPU() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  }
  const idle = totalIdle / cpus.length;
  const total = totalTick / cpus.length;
  return Math.round((1 - idle / total) * 100);
}

function startStatsTimer() {
  if (statsTimer) return;
  statsTimer = setInterval(collectStats, 2000);
}

function stopStatsTimer() {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

// ==================== 图标生成 ====================
function createAppIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const r = (size / 2) - 1;
  const cx = size / 2, cy = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const off = (y * size + x) * 4;
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= r) {
        // 圆内：检查是否在播放三角区域内
        const triLeft  = cx - r * 0.3;
        const triRight = cx + r * 0.55;
        const triHalfH = r * 0.55;
        const relX = x - cx;
        const relY = y - cy;
        const edgeY = (triHalfH / (triRight - triLeft)) * Math.abs(relX - triLeft);

        if (relX >= triLeft - cx && relX <= triRight - cx && Math.abs(relY) <= edgeY) {
          buf[off] = 255; buf[off + 1] = 255; buf[off + 2] = 255; buf[off + 3] = 255; // 白色三角
        } else {
          buf[off] = 59; buf[off + 1] = 130; buf[off + 2] = 246; buf[off + 3] = 255; // 蓝色圆
        }
      } else {
        buf[off] = 0; buf[off + 1] = 0; buf[off + 2] = 0; buf[off + 3] = 0; // 透明
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

// ==================== 窗口 & 托盘 ====================
let mainWindow = null;
let tray = null;
let forceQuit = false;

function createWindow() {
  const icon = createAppIcon(32);

  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 700,
    minHeight: 500,
    title: 'QuickLaunch',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('renderer/index.html');
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const icon = createAppIcon(16);
  tray = new Tray(icon);
  tray.setToolTip('QuickLaunch');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Exit', click: () => { forceQuit = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

// ==================== 应用生命周期 ====================
app.whenReady().then(() => {
  loadRecordingState();
  createWindow();
  createTray();
  startStatsTimer();
});

app.on('window-all-closed', () => {
  // 不退出，由托盘控制
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
    startStatsTimer();
  }
});

app.on('before-quit', () => {
  forceQuit = true;
  stopAllApps();
  stopStatsTimer();
});

// ==================== 扫描文件夹 ====================
function scanFolder(folderPath) {
  try {
    if (!fs.existsSync(folderPath)) {
      return { success: false, error: '文件夹不存在' };
    }
    const entries = fs.readdirSync(folderPath, { recursive: true, withFileTypes: true });
    const exeFiles = entries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
      .map(entry => {
        const fullPath = path.join(entry.parentPath || folderPath, entry.name);
        const relativePath = path.relative(folderPath, fullPath);
        return {
          name: relativePath,
          baseName: entry.name, // 单文件名（不含路径）
          path: fullPath
        };
      });
    return { success: true, files: exeFiles };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ==================== IPC 处理器 ====================
ipcMain.handle('get-config', () => {
  const config = getActiveConfig();
  const runningStatus = getRunningStatus();
  for (const appPath of Object.keys(config.apps)) {
    config.apps[appPath] = {
      ...config.apps[appPath],
      ...(runningStatus[appPath] || { running: false, pid: null })
    };
  }
  return config;
});

ipcMain.handle('save-config', (event, config) => {
  saveActiveConfig(config);
  return { success: true };
});

ipcMain.handle('get-profiles', () => {
  const data = loadAllData();
  const names = Object.keys(data.profiles);
  const list = names.map(name => ({
    name,
    appCount: Object.keys(data.profiles[name].apps || {}).length
  }));
  return { active: data.active, profiles: list };
});

ipcMain.handle('switch-profile', (event, name) => {
  const data = loadAllData();
  if (!data.profiles[name]) {
    return { success: false, error: 'Profile not found' };
  }
  data.active = name;
  saveAllData(data);
  loadRecordingState(); // 切换 profile 时同步录制状态
  const config = getActiveConfig();
  const runningStatus = getRunningStatus();
  for (const appPath of Object.keys(config.apps)) {
    config.apps[appPath] = {
      ...config.apps[appPath],
      ...(runningStatus[appPath] || { running: false, pid: null })
    };
  }
  return { success: true, config };
});

ipcMain.handle('create-profile', (event, name, baseConfig) => {
  if (!name || !name.trim()) {
    return { success: false, error: 'Name required' };
  }
  const trimmed = name.trim();
  const data = loadAllData();
  if (data.profiles[trimmed]) {
    return { success: false, error: 'Profile already exists' };
  }
  data.profiles[trimmed] = baseConfig || { folders: [], apps: {} };
  data.active = trimmed;
  saveAllData(data);
  return { success: true, config: getActiveConfig() };
});

ipcMain.handle('delete-profile', (event, name) => {
  const data = loadAllData();
  const keys = Object.keys(data.profiles);
  if (keys.length <= 1) {
    return { success: false, error: 'Cannot delete the last group' };
  }
  if (!data.profiles[name]) {
    return { success: false, error: 'Group not found' };
  }
  delete data.profiles[name];
  if (data.active === name) {
    data.active = Object.keys(data.profiles)[0];
  }
  saveAllData(data);
  loadRecordingState();
  return { success: true, active: data.active, config: getActiveConfig() };
});

ipcMain.handle('rename-profile', (event, oldName, newName) => {
  if (!newName || !newName.trim()) return { success: false, error: 'Name required' };
  const trimmed = newName.trim();
  const data = loadAllData();
  if (!data.profiles[oldName]) return { success: false, error: 'Group not found' };
  if (trimmed !== oldName && data.profiles[trimmed]) return { success: false, error: 'Name already exists' };
  data.profiles[trimmed] = data.profiles[oldName];
  if (trimmed !== oldName) delete data.profiles[oldName];
  if (data.active === oldName) data.active = trimmed;
  saveAllData(data);
  return { success: true, newName: trimmed, profiles: Object.keys(data.profiles).map(n => ({ name: n, appCount: Object.keys(data.profiles[n].apps || {}).length })), active: data.active };
});

ipcMain.handle('clone-profile', (event, sourceName, newName) => {
  if (!newName || !newName.trim()) return { success: false, error: 'Name required' };
  const trimmed = newName.trim();
  const data = loadAllData();
  if (!data.profiles[sourceName]) return { success: false, error: 'Source group not found' };
  if (data.profiles[trimmed]) return { success: false, error: 'Name already exists' };
  data.profiles[trimmed] = JSON.parse(JSON.stringify(data.profiles[sourceName]));
  saveAllData(data);
  return { success: true, profiles: Object.keys(data.profiles).map(n => ({ name: n, appCount: Object.keys(data.profiles[n].apps || {}).length })), active: data.active };
});

ipcMain.handle('scan-folder', (event, folderPath) => {
  return scanFolder(folderPath);
});

ipcMain.handle('start-app', async (event, appPath, args, runAsAdmin) => {
  return startApp(appPath, args, runAsAdmin);
});

ipcMain.handle('stop-app', async (event, appPath) => {
  return stopApp(appPath);
});

ipcMain.handle('start-all', async (event, config) => {
  return startAllApps(config);
});

ipcMain.handle('stop-all', async () => {
  await stopAllApps();
  return { success: true };
});

ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('open-config-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Configuration File',
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths[0]) return { success: false, error: 'Cancelled' };
  try {
    const content = fs.readFileSync(result.filePaths[0], 'utf-8');
    const parsed = JSON.parse(content);
    return { success: true, config: parsed, filePath: result.filePaths[0] };
  } catch (err) {
    return { success: false, error: `Failed to read file: ${err.message}` };
  }
});

ipcMain.handle('export-config-file', async (event, config) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Configuration',
    defaultPath: 'quicklaunch-config.json',
    filters: [{ name: 'JSON Files', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { success: false, error: 'Cancelled' };
  try {
    fs.writeFileSync(result.filePath, JSON.stringify(config, null, 2), 'utf-8');
    return { success: true, filePath: result.filePath };
  } catch (err) {
    return { success: false, error: `Failed to write: ${err.message}` };
  }
});

ipcMain.handle('export-csv', async (event, records) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Stats CSV',
    defaultPath: `quicklaunch-stats-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  if (result.canceled || !result.filePath) return { success: false, error: 'Cancelled' };
  try {
    fs.writeFileSync(result.filePath, records, 'utf-8');
    return { success: true, filePath: result.filePath };
  } catch (err) {
    return { success: false, error: `Failed to write: ${err.message}` };
  }
});

ipcMain.handle('get-stats-history', () => {
  return statsHistory;
});

ipcMain.handle('clear-stats-history', () => {
  statsHistory = [];
  return { success: true };
});

ipcMain.handle('toggle-recording', (event, enabled) => {
  recordingEnabled = enabled;
  // 持久化到当前 profile
  const data = loadAllData();
  const profile = data.profiles[data.active] || {};
  profile.recordingEnabled = enabled;
  data.profiles[data.active] = profile;
  saveAllData(data);
  if (!enabled) statsHistory = [];
  return { success: true, recordingEnabled };
});

ipcMain.handle('open-log-dir', () => {
  const { shell } = require('electron');
  shell.openPath(logDir);
  return { success: true, path: logDir };
});

ipcMain.handle('get-recording-state', () => {
  return recordingEnabled;
});
