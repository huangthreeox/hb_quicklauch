// ==================== 状态管理 ====================
let config = { folders: [], apps: {} };
let currentApps = {};
let activeProfile = 'default';
let profileNames = [];
let appStats = {};  // { pid: { CPU, MemMB } }
let systemCPU = 0;

// ==================== DOM 元素 ====================
const $ = (id) => document.getElementById(id);
const folderPathInput = $('folderPath');
const folderListEl = $('folderList');
const appListEl = $('appList');
const countDot = $('countDot');
const countText = $('countText');
const appCountEl = $('appCount');
const statusText = $('statusText');
const profileSelect = $('profileSelect');
const modalOverlay = $('modalOverlay');
const modalInput = $('modalInput');
const modalConfirm = $('modalConfirm');
const modalCancel = $('modalCancel');

// ==================== 模态框 ====================
let modalResolve = null;

function showModal() {
  modalOverlay.classList.remove('hidden');
  modalInput.value = '';
  modalInput.focus();
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function closeModal(result) {
  modalOverlay.classList.add('hidden');
  if (modalResolve) {
    modalResolve(result);
    modalResolve = null;
  }
}

modalConfirm.addEventListener('click', () => {
  const val = modalInput.value.trim();
  closeModal(val || null);
});

modalCancel.addEventListener('click', () => {
  closeModal(null);
});

modalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = modalInput.value.trim();
    closeModal(val || null);
  }
});

// ==================== 初始化 ====================
async function init() {
  const profilesData = await window.electronAPI.getProfiles();
  profileNames = profilesData.profiles || [];
  activeProfile = profilesData.active || 'default';
  renderProfileSelect();

  const data = await window.electronAPI.getConfig();
  config = data;
  activeProfile = data.activeProfile || 'default';
  currentApps = { ...config.apps };

  // 初始化录制开关
  const chkRecording = $('chkRecording');
  if (chkRecording) chkRecording.checked = config.recordingEnabled !== false;

  renderFolders();
  renderAppList();
  updateCounts();
  initTheme();
}

// ==================== 主题切换 ====================
function initTheme() {
  const saved = localStorage.getItem('ql-theme');
  if (saved === 'dark') {
    document.body.classList.add('dark');
    document.getElementById('btnTheme').innerHTML = '&#9790;';
  }
}

function toggleTheme() {
  const isDark = document.body.classList.toggle('dark');
  localStorage.setItem('ql-theme', isDark ? 'dark' : 'light');
  document.getElementById('btnTheme').innerHTML = isDark ? '&#9790;' : '&#9788;';
}

// ==================== Profile 管理 ====================
function renderProfileSelect() {
  profileSelect.innerHTML = profileNames.map(p => `
    <option value="${escapeHtml(p.name)}" ${p.name === activeProfile ? 'selected' : ''}>
      ${escapeHtml(p.name)} (${p.appCount} apps)
    </option>
  `).join('');
}

async function switchProfile() {
  const name = profileSelect.value;
  if (name === activeProfile) return;

  const result = await window.electronAPI.switchProfile(name);
  if (!result.success) {
    setStatus(`Switch failed: ${result.error}`, 'error');
    return;
  }

  config = result.config;
  activeProfile = result.config.activeProfile;
  currentApps = { ...config.apps };
  renderFolders();
  renderAppList();
  updateCounts();
  renderProfileSelect();
  setStatus(`Switched to "${activeProfile}"`, 'info');
}

async function saveAsProfile() {
  const name = await showModal();
  if (!name) return;

  const cleanConfig = buildCleanConfig();
  const result = await window.electronAPI.createProfile(name, cleanConfig);
  if (!result.success) {
    setStatus(`Save failed: ${result.error}`, 'error');
    return;
  }

  config = result.config;
  activeProfile = result.config.activeProfile;
  currentApps = { ...config.apps };
  await refreshProfilesAndUI();
  setStatus(`Created profile: "${name}"`, 'success');
}

function buildCleanConfig() {
  const clean = { folders: [...config.folders], apps: {}, recordingEnabled: config.recordingEnabled };
  for (const [appPath, appInfo] of Object.entries(config.apps)) {
    clean.apps[appPath] = {
      name: appInfo.name,
      baseName: appInfo.baseName || '',
      path: appInfo.path,
      args: appInfo.args,
      enabled: appInfo.enabled,
      customName: appInfo.customName || '',
      delay: appInfo.delay || 0,
      order: appInfo.order ?? 0,
      runAsAdmin: appInfo.runAsAdmin !== false
    };
  }
  return clean;
}

async function refreshProfilesAndUI() {
  const data = await window.electronAPI.getProfiles();
  profileNames = data.profiles;
  activeProfile = data.active;
  renderProfileSelect();
}

// ==================== 打开 / 导出配置 ====================
async function openConfigFile() {
  const result = await window.electronAPI.openConfigFile();
  if (!result.success) {
    if (result.error !== 'Cancelled') {
      setStatus(`Open failed: ${result.error}`, 'error');
    }
    return;
  }

  const imported = result.config;
  // 验证配置结构
  if (!imported.folders || !imported.apps) {
    setStatus('Invalid config file format', 'error');
    return;
  }

  // 停止当前运行的应用
  await window.electronAPI.stopAll();
  for (const appPath of Object.keys(config.apps)) {
    config.apps[appPath].running = false;
    config.apps[appPath].pid = null;
  }

  // 替换当前配置
  config.folders = imported.folders || [];
  config.apps = imported.apps || {};
  currentApps = { ...config.apps };

  await saveAndRefresh();
  setStatus(`Opened: ${result.filePath}`, 'success');
}

async function exportConfigFile() {
  const cleanConfig = buildCleanConfig();
  const result = await window.electronAPI.exportConfigFile(cleanConfig);
  if (!result.success) {
    if (result.error !== 'Cancelled') {
      setStatus(`Export failed: ${result.error}`, 'error');
    }
    return;
  }
  setStatus(`Exported: ${result.filePath}`, 'success');
}

async function deleteActiveProfile() {
  if (!confirm(`Delete profile "${activeProfile}"? All its data will be lost.`)) return;

  const result = await window.electronAPI.deleteProfile(activeProfile);
  if (!result.success) {
    setStatus(`Delete failed: ${result.error}`, 'error');
    return;
  }

  const data = await window.electronAPI.getConfig();
  config = data;
  activeProfile = data.activeProfile;
  currentApps = { ...config.apps };
  await refreshProfilesAndUI();
  renderFolders();
  renderAppList();
  updateCounts();
  setStatus(`Deleted profile. Active: "${activeProfile}"`, 'info');
}

// ==================== 文件夹管理 ====================
async function addFolder() {
  const folderPath = folderPathInput.value.trim();
  if (!folderPath) {
    setStatus('Folder path required', 'error');
    return;
  }

  const result = await window.electronAPI.scanFolder(folderPath);
  if (!result.success) {
    setStatus(`Scan failed: ${result.error}`, 'error');
    return;
  }

  const normalized = folderPath.replace(/\\/g, '/').toLowerCase();
  const exists = config.folders.some(f => f.replace(/\\/g, '/').toLowerCase() === normalized);
  if (exists) {
    setStatus('Folder already exists', 'warn');
    return;
  }

  config.folders.push(folderPath);

  for (const file of result.files) {
    if (!config.apps[file.path]) {
      config.apps[file.path] = {
        name: file.name,
        baseName: file.baseName || file.name,
        path: file.path,
        args: '',
        enabled: true,
        customName: '',
        delay: 0,
        order: Object.keys(config.apps).length,
        runAsAdmin: true,
        running: false,
        pid: null
      };
    }
  }

  await saveAndRefresh();
  setStatus(`Added: ${folderPath} (${result.files.length} apps)`, 'success');
  folderPathInput.value = '';
}

async function removeFolder(index) {
  const folder = config.folders[index];
  const normalizedFolder = folder.replace(/\\/g, '/').toLowerCase();
  for (const appPath of Object.keys(config.apps)) {
    if (appPath.replace(/\\/g, '/').toLowerCase().startsWith(normalizedFolder)) {
      if (config.apps[appPath].running) {
        await window.electronAPI.stopApp(appPath);
      }
      delete config.apps[appPath];
    }
  }
  config.folders.splice(index, 1);
  await saveAndRefresh();
  setStatus('Folder removed', 'info');
}

async function scanAllFolders() {
  let totalNew = 0;
  for (const folder of config.folders) {
    const result = await window.electronAPI.scanFolder(folder);
    if (result.success) {
      for (const file of result.files) {
        if (!config.apps[file.path]) {
          config.apps[file.path] = {
            name: file.name,
            baseName: file.baseName || file.name,
            path: file.path,
            args: '',
            enabled: true,
            customName: '',
            delay: 0,
            order: Object.keys(config.apps).length,
            runAsAdmin: true,
            running: false,
            pid: null
          };
          totalNew++;
        }
      }
    }
  }

  const allValidPaths = new Set();
  for (const folder of config.folders) {
    const result = await window.electronAPI.scanFolder(folder);
    if (result.success) {
      result.files.forEach(f => allValidPaths.add(f.path));
    }
  }
  for (const appPath of Object.keys(config.apps)) {
    if (!allValidPaths.has(appPath)) {
      if (config.apps[appPath].running) {
        await window.electronAPI.stopApp(appPath);
      }
      delete config.apps[appPath];
    }
  }

  await saveAndRefresh();
  setStatus(`Scan complete, ${totalNew} new apps found`, 'success');
}

async function browseFolder() {
  const folderPath = await window.electronAPI.openFolderDialog();
  if (folderPath) {
    folderPathInput.value = folderPath;
  }
}

// ==================== 应用操作 ====================
async function startSingleApp(appPath) {
  const appInfo = config.apps[appPath];
  if (!appInfo) return;

  if (appInfo.running) {
    setStatus('Already running', 'warn');
    return;
  }

  const result = await window.electronAPI.startApp(appPath, appInfo.args || '', appInfo.runAsAdmin !== false);
  if (result.success) {
    config.apps[appPath].running = true;
    config.apps[appPath].pid = result.pid;
    currentApps[appPath] = { ...config.apps[appPath] };
    renderAppList();
    updateCounts();
    setStatus(`Started: ${appInfo.name} [PID ${result.pid}]`, 'success');
  } else {
    setStatus(`Start failed: ${result.error}`, 'error');
  }
}

async function stopSingleApp(appPath) {
  const appInfo = config.apps[appPath];
  if (!appInfo) return;

  if (!appInfo.running) {
    setStatus('Not running', 'warn');
    return;
  }

  const result = await window.electronAPI.stopApp(appPath);
  if (result.success) {
    config.apps[appPath].running = false;
    config.apps[appPath].pid = null;
    currentApps[appPath] = { ...config.apps[appPath] };
    renderAppList();
    updateCounts();
    setStatus(`Stopped: ${appInfo.name}`, 'success');
  }
}

async function startAllApps() {
  const appPaths = Object.keys(config.apps).filter(
    p => config.apps[p].enabled !== false && !config.apps[p].running
  );

  if (appPaths.length === 0) {
    setStatus('No apps to start', 'warn');
    return;
  }

  setStatus('Starting all apps...', 'info');
  const results = await window.electronAPI.startAll(config);

  let successCount = 0;
  let failCount = 0;
  for (const r of results) {
    if (r.success) {
      config.apps[r.appPath].running = true;
      config.apps[r.appPath].pid = r.pid;
      currentApps[r.appPath] = { ...config.apps[r.appPath] };
      successCount++;
    } else {
      failCount++;
    }
  }

  await saveConfigOnly();
  renderAppList();
  updateCounts();
  setStatus(`Start complete: ${successCount} ok, ${failCount} failed`, successCount > 0 ? 'success' : 'error');
}

async function stopAllApps() {
  const runningCount = Object.keys(config.apps).filter(p => config.apps[p].running).length;
  if (runningCount === 0) {
    setStatus('No apps running', 'warn');
    return;
  }

  await window.electronAPI.stopAll();

  for (const appPath of Object.keys(config.apps)) {
    config.apps[appPath].running = false;
    config.apps[appPath].pid = null;
    currentApps[appPath] = { ...config.apps[appPath] };
  }

  renderAppList();
  updateCounts();
  setStatus('All apps stopped', 'success');
}

// ==================== 筛选 / 删除 ====================
function toggleAppEnabled(appPath) {
  if (config.apps[appPath]) {
    config.apps[appPath].enabled = !config.apps[appPath].enabled;
    currentApps[appPath].enabled = config.apps[appPath].enabled;
    renderAppList();
    updateCounts();
    saveConfigOnly();
  }
}

function removeSingleApp(appPath) {
  if (config.apps[appPath] && config.apps[appPath].running) {
    setStatus('Stop the app before removing', 'warn');
    return;
  }
  const name = config.apps[appPath] ? config.apps[appPath].name : appPath;
  delete config.apps[appPath];
  delete currentApps[appPath];
  saveAndRefresh();
  setStatus(`Removed: ${name}`, 'info');
}

async function removeDisabledApps() {
  const toRemove = Object.keys(config.apps).filter(p => config.apps[p].enabled === false);
  if (toRemove.length === 0) {
    setStatus('No unchecked apps to remove', 'warn');
    return;
  }
  for (const appPath of toRemove) {
    if (config.apps[appPath].running) {
      await window.electronAPI.stopApp(appPath);
    }
    delete config.apps[appPath];
    delete currentApps[appPath];
  }
  saveAndRefresh();
  setStatus(`Removed ${toRemove.length} unchecked apps`, 'success');
}

// ==================== 参数更新 ====================
function updateAppArgs(appPath, args) {
  if (config.apps[appPath]) {
    config.apps[appPath].args = args;
    currentApps[appPath].args = args;
    saveConfigOnly();
  }
}

function updateCustomName(appPath, customName) {
  if (!config.apps[appPath]) return;
  const trimmed = customName.trim();
  const baseName = config.apps[appPath].baseName || config.apps[appPath].name;
  config.apps[appPath].customName = (trimmed && trimmed !== baseName) ? trimmed : '';
  currentApps[appPath].customName = config.apps[appPath].customName;
  saveConfigOnly();
  renderAppList();
}

function toggleRunAsAdmin(appPath, enabled) {
  if (!config.apps[appPath]) return;
  config.apps[appPath].runAsAdmin = enabled;
  currentApps[appPath].runAsAdmin = enabled;
  saveConfigOnly();
}

function updateAppDelay(appPath, val) {
  if (!config.apps[appPath]) return;
  const d = Math.max(0, Math.min(60000, Math.round((parseInt(val) || 0) / 500) * 500));
  config.apps[appPath].delay = d;
  currentApps[appPath].delay = d;
  saveConfigOnly();
}

// ==================== 拖拽排序 ====================
let dragSrcPath = null;

function handleDragStart(e, appPath) {
  dragSrcPath = appPath;
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', appPath);
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.target.closest('.app-card')?.classList.add('drag-over');
}

function handleDragLeave(e) {
  e.target.closest('.app-card')?.classList.remove('drag-over');
}

function handleDrop(e, targetPath) {
  e.preventDefault();
  e.target.closest('.app-card')?.classList.remove('drag-over');

  if (!dragSrcPath || dragSrcPath === targetPath) return;

  // 获取当前排序后的 app 列表
  const sortedPaths = Object.keys(currentApps).sort((a, b) => {
    const oa = config.apps[a]?.order ?? 0;
    const ob = config.apps[b]?.order ?? 0;
    if (oa !== ob) return oa - ob;
    return (config.apps[a]?.name || '').localeCompare(config.apps[b]?.name || '');
  });

  const srcIdx = sortedPaths.indexOf(dragSrcPath);
  const tgtIdx = sortedPaths.indexOf(targetPath);
  if (srcIdx < 0 || tgtIdx < 0) return;

  // 重新分配所有 order：移除 src，在 tgt 位置插入
  sortedPaths.splice(srcIdx, 1);
  sortedPaths.splice(tgtIdx, 0, dragSrcPath);

  // 将新的顺序写回 config
  sortedPaths.forEach((p, i) => {
    if (config.apps[p]) {
      config.apps[p].order = i;
      if (currentApps[p]) currentApps[p].order = i;
    }
  });

  saveConfigOnly();
  renderAppList();
}

function handleDragEnd(e) {
  e.target.classList.remove('dragging');
  document.querySelectorAll('.app-card.drag-over').forEach(el => el.classList.remove('drag-over'));
  dragSrcPath = null;
}

// ==================== 配置保存 ====================
async function saveConfigOnly() {
  const configToSave = {
    folders: config.folders,
    apps: {},
    recordingEnabled: config.recordingEnabled
  };
  for (const [appPath, appInfo] of Object.entries(config.apps)) {
    configToSave.apps[appPath] = {
      name: appInfo.name,
      baseName: appInfo.baseName || '',
      path: appInfo.path,
      args: appInfo.args,
      enabled: appInfo.enabled,
      customName: appInfo.customName || '',
      delay: appInfo.delay || 0,
      order: appInfo.order ?? 0,
      runAsAdmin: appInfo.runAsAdmin !== false
    };
  }
  await window.electronAPI.saveConfig(configToSave);
}

async function saveAndRefresh() {
  await saveConfigOnly();
  currentApps = { ...config.apps };
  renderFolders();
  renderAppList();
  updateCounts();
}

// ==================== UI 渲染 ====================
function renderFolders() {
  if (config.folders.length === 0) {
    folderListEl.innerHTML = '';
    return;
  }

  folderListEl.innerHTML = config.folders.map((folder, index) => `
    <div class="folder-tag">
      <span class="folder-path" title="${escapeHtml(folder)}">${escapeHtml(folder)}</span>
      <button class="btn-remove" onclick="removeFolder(${index})" title="Remove">x</button>
    </div>
  `).join('');
}

function renderAppList() {
  const appPaths = Object.keys(currentApps);

  if (appPaths.length === 0) {
    appListEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">NO APPS</div>
        <p>Add a folder containing .exe files to get started</p>
        <p class="empty-hint">Use Browse or paste a folder path</p>
      </div>
    `;
    return;
  }

  // 按 order 排序，order 相同时按名称排序
  const sorted = appPaths.sort((a, b) => {
    const oa = config.apps[a]?.order ?? 0;
    const ob = config.apps[b]?.order ?? 0;
    if (oa !== ob) return oa - ob;
    return (config.apps[a]?.name || '').localeCompare(config.apps[b]?.name || '');
  });

  appListEl.innerHTML = sorted.map((appPath, idx) =>
    renderAppCard(appPath, idx)
  ).join('');
}

function getFolderBadge(appPath) {
  for (const folder of config.folders) {
    if (appPath.replace(/\\/g, '/').toLowerCase().startsWith(folder.replace(/\\/g, '/').toLowerCase())) {
      return folder.length > 40 ? '...' + folder.slice(-37) : folder;
    }
  }
  return '';
}

function renderAppCard(appPath, idx) {
  const appInfo = currentApps[appPath];
  const isRunning = appInfo.running === true;
  const isEnabled = appInfo.enabled !== false;
  const displayName = appInfo.customName || appInfo.baseName || appInfo.name;
  const folderBadge = getFolderBadge(appPath);

  const cardClass = isEnabled ? '' : 'disabled';
  const runningClass = isRunning ? ' running' : '';

  return `
    <div class="app-card${cardClass ? ' ' + cardClass : ''}${runningClass}"
         data-path="${escapeHtml(appPath)}"
         draggable="${isRunning ? 'false' : 'true'}"
         ondragstart="handleDragStart(event, '${escapeJs(appPath)}')"
         ondragover="handleDragOver(event)"
         ondragleave="handleDragLeave(event)"
         ondrop="handleDrop(event, '${escapeJs(appPath)}')"
         ondragend="handleDragEnd(event)">
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <span class="order-badge">#${idx + 1}</span>
      <input
        type="checkbox"
        class="app-checkbox"
        ${isEnabled ? 'checked' : ''}
        onchange="toggleAppEnabled('${escapeJs(appPath)}')"
        title="${isEnabled ? 'Uncheck to disable' : 'Check to enable'}"
        ${isRunning ? 'disabled' : ''}
      />
      <div class="status-indicator ${isRunning ? 'running' : ''}"></div>
      <div class="app-info">
        <input
          class="name-input"
          type="text"
          value="${escapeHtml(displayName)}"
          placeholder="${escapeHtml(appInfo.baseName || appInfo.name)}"
          onchange="updateCustomName('${escapeJs(appPath)}', this.value)"
          title="Alias (default: ${escapeHtml(appInfo.baseName || appInfo.name)})"
        />
        <span class="app-path" title="${escapeHtml(appPath)}">
          ${folderBadge ? `<span class="folder-badge">${escapeHtml(folderBadge)}</span>` : ''}
          ${escapeHtml(appInfo.baseName || appInfo.name)}
        </span>
      </div>
      <div class="delay-input-wrap">
        <span class="delay-label">Delay</span>
        <input
          class="delay-input"
          type="number"
          min="0" max="60000" step="500"
          value="${appInfo.delay || 0}"
          onchange="updateAppDelay('${escapeJs(appPath)}', this.value)"
          title="Delay (ms)"
          ${isRunning ? 'disabled' : ''}
        />
        <span class="delay-unit">ms</span>
      </div>
      <label class="admin-toggle" title="Run as Administrator">
        <input
          type="checkbox"
          ${appInfo.runAsAdmin !== false ? 'checked' : ''}
          onchange="toggleRunAsAdmin('${escapeJs(appPath)}', this.checked)"
          ${isRunning ? 'disabled' : ''}
        />
        <span>Adm</span>
      </label>
      <input
        class="args-input"
        type="text"
        placeholder="Args..."
        value="${escapeHtml(appInfo.args || '')}"
        onchange="updateAppArgs('${escapeJs(appPath)}', this.value)"
        title="Launch arguments"
        ${isRunning ? 'disabled' : ''}
      />
      ${isRunning && appInfo.pid ? `<span class="pid-badge running">PID ${appInfo.pid}</span>` : ''}
      ${getStatsHtml(appInfo.pid, isRunning)}
      <div class="app-actions">
        <button class="btn btn-success btn-sm" onclick="startSingleApp('${escapeJs(appPath)}')" ${!isEnabled || isRunning ? 'disabled' : ''}>
          Start
        </button>
        <button class="btn btn-danger btn-sm" onclick="stopSingleApp('${escapeJs(appPath)}')" ${!isRunning ? 'disabled' : ''}>
          Stop
        </button>
      </div>
      <button class="btn-del" onclick="removeSingleApp('${escapeJs(appPath)}')" title="Remove" ${isRunning ? 'disabled' : ''}>x</button>
    </div>
  `;
}

function updateCounts() {
  const appPaths = Object.keys(currentApps);
  const enabledPaths = appPaths.filter(p => currentApps[p].enabled !== false);
  const runningCount = enabledPaths.filter(p => currentApps[p].running).length;
  const enabledCount = enabledPaths.length;

  countText.textContent = `${runningCount} / ${enabledCount}`;
  countDot.className = runningCount > 0 ? 'count-dot active' : 'count-dot';
  appCountEl.textContent = `${runningCount} running / ${enabledCount} enabled`;
}

// ==================== 工具函数 ====================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeJs(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function getStatsHtml(pid, isRunning) {
  if (!isRunning || !pid) return '';
  const stat = appStats[pid] || appStats[String(pid)];
  if (!stat) return '';
  return `<span class="stats-badge">CPU ${stat.CPU}%</span>
          <span class="stats-badge">MEM ${stat.MemMB} MB</span>`;
}

function handleStatsUpdate(data) {
  systemCPU = data.systemCPU || 0;
  // 归一化 appStats: 同时支持数字和字符串 PID 键
  const rawStats = data.processes || {};
  appStats = {};
  for (const [key, val] of Object.entries(rawStats)) {
    appStats[parseInt(key)] = val;
    appStats[key] = val;
  }

  const pidToPath = {};
  for (const [appPath, appInfo] of Object.entries(config.apps)) {
    if (appInfo.running && appInfo.pid) {
      pidToPath[appInfo.pid] = appPath;
    }
  }

  for (const [pid, stat] of Object.entries(appStats)) {
    const appPath = pidToPath[parseInt(pid)];
    if (appPath && currentApps[appPath]) {
      currentApps[appPath]._cpu = stat.CPU;
      currentApps[appPath]._mem = stat.MemMB;
    }
  }

  renderAppList();
  updateSystemCpu();
}


function updateSystemCpu() {
  const el = document.getElementById('systemCPU');
  if (el) {
    el.textContent = systemCPU !== null && systemCPU !== undefined ? `${systemCPU}%` : '--';
    el.className = 'sys-cpu-value ' + (systemCPU > 80 ? 'high' : systemCPU > 50 ? 'mid' : 'low');
  }
}

async function exportStatsCsv() {
  const history = await window.electronAPI.getStatsHistory();
  if (!history || history.length === 0) {
    setStatus('No stats data to export', 'warn');
    return;
  }

  // 构建 CSV: 时间, 系统CPU, App1_CPU, App1_MEM, App2_CPU, App2_MEM, ...
  const pids = new Set();
  for (const record of history) {
    for (const pid of Object.keys(record.processes || {})) {
      pids.add(pid);
    }
  }

  const pidToName = {};
  for (const [appPath, appInfo] of Object.entries(config.apps)) {
    if (appInfo.pid) pidToName[appInfo.pid] = appInfo.customName || appInfo.baseName || appInfo.name;
  }

  const header = ['Time', 'SystemCPU'];
  for (const pid of pids) {
    const name = pidToName[parseInt(pid)] || `PID_${pid}`;
    header.push(`${name}_CPU(%)`, `${name}_MEM(MB)`);
  }

  const rows = history.map(r => {
    const row = [r.timestamp, r.systemCPU !== undefined ? r.systemCPU : ''];
    for (const pid of pids) {
      const proc = r.processes[pid];
      row.push(proc ? proc.CPU : '', proc ? proc.MemMB : '');
    }
    return row;
  });

  const csvContent = [header.join(','), ...rows.map(r => r.join(','))].join('\n');
  await window.electronAPI.exportCsv(csvContent);
  setStatus('CSV exported', 'success');
}

function setStatus(msg, type) {
  statusText.textContent = msg;
  statusText.style.color = type === 'error' ? 'var(--red)' :
                           type === 'success' ? 'var(--green)' :
                           type === 'warn' ? 'var(--text-secondary)' :
                           'var(--text-muted)';
}

// ==================== 事件绑定 ====================
$('btnAddFolder').addEventListener('click', addFolder);
$('btnBrowse').addEventListener('click', browseFolder);
$('btnScanAll').addEventListener('click', scanAllFolders);
$('btnToggleSettings').addEventListener('click', () => {
  const panel = $('settingsPanel');
  const btn = $('btnToggleSettings');
  panel.classList.toggle('collapsed');
  btn.textContent = panel.classList.contains('collapsed') ? '\u2699' : '\u2715';
});
$('btnStartAll').addEventListener('click', startAllApps);
$('btnStopAll').addEventListener('click', stopAllApps);
$('btnOpenLogs').addEventListener('click', async () => {
  await window.electronAPI.openLogDir();
  setStatus('Log folder opened', 'info');
});
$('btnOpenConfig').addEventListener('click', openConfigFile);
$('btnExportConfig').addEventListener('click', exportConfigFile);
$('btnExportCsv').addEventListener('click', exportStatsCsv);
$('btnTheme').addEventListener('click', toggleTheme);
$('chkRecording').addEventListener('change', async (e) => {
  config.recordingEnabled = e.target.checked;
  await window.electronAPI.toggleRecording(e.target.checked);
  if (!e.target.checked) {
    await window.electronAPI.clearStatsHistory();
  }
  setStatus(`CSV recording ${e.target.checked ? 'ON' : 'OFF'}`, 'info');
});
profileSelect.addEventListener('change', switchProfile);

folderPathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    addFolder();
  }
});

window.electronAPI.onAppStatusChanged((data) => {
  if (config.apps[data.appPath]) {
    config.apps[data.appPath].running = data.running;
    config.apps[data.appPath].pid = data.pid;
    currentApps[data.appPath] = { ...config.apps[data.appPath] };
    renderAppList();
    updateCounts();
  }
});

window.electronAPI.onStatsUpdated((data) => {
  handleStatsUpdate(data);
});

// ==================== 全局函数暴露 ====================
window.addFolder = addFolder;
window.removeFolder = removeFolder;
window.scanAllFolders = scanAllFolders;
window.startSingleApp = startSingleApp;
window.stopSingleApp = stopSingleApp;
window.startAllApps = startAllApps;
window.stopAllApps = stopAllApps;
window.updateAppArgs = updateAppArgs;
window.updateCustomName = updateCustomName;
window.updateAppDelay = updateAppDelay;
window.toggleRunAsAdmin = toggleRunAsAdmin;
window.toggleAppEnabled = toggleAppEnabled;
window.removeSingleApp = removeSingleApp;
window.removeDisabledApps = removeDisabledApps;
window.switchProfile = switchProfile;
window.saveAsProfile = saveAsProfile;
window.deleteActiveProfile = deleteActiveProfile;
window.openConfigFile = openConfigFile;
window.exportConfigFile = exportConfigFile;
window.exportStatsCsv = exportStatsCsv;
window.handleDragStart = handleDragStart;
window.handleDragOver = handleDragOver;
window.handleDragLeave = handleDragLeave;
window.handleDrop = handleDrop;
window.handleDragEnd = handleDragEnd;

// ==================== 启动 ====================
init();
