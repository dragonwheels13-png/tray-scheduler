const { app, Tray, Menu, BrowserWindow, shell, nativeImage, ipcMain } = require('electron');
const path  = require('path');
const fs    = require('fs');
const cron  = require('node-cron');
const axios = require('axios');

// ─── Paths ────────────────────────────────────────────────────────────────────
// In dev: files sit next to package.json.
// When packaged: config + logs go to %APPDATA%\TrayScheduler (writable by user).
const IS_PACKED      = app.isPackaged;
const USER_DATA      = app.getPath('userData');

const CONFIG_PATH    = IS_PACKED
  ? path.join(USER_DATA, 'config.json')
  : path.join(__dirname, '..', 'config.json');

const LOG_PATH       = IS_PACKED
  ? path.join(USER_DATA, 'logs', 'scheduler.log')
  : path.join(__dirname, '..', 'logs', 'scheduler.log');

const ICON_PATH      = IS_PACKED
  ? path.join(process.resourcesPath, 'assets', 'tray-icon.png')
  : path.join(__dirname, '..', 'assets', 'tray-icon.png');

const BUNDLED_CONFIG = IS_PACKED
  ? path.join(process.resourcesPath, 'config.json')
  : null;

// ─── Runtime state ────────────────────────────────────────────────────────────
let tray           = null;
let settingsWin    = null;
let lightShowStats = {};   // id → { runs, lastStatus, lastRun }

// Scheduler state
let startCronTask  = null;
let endCronTask    = null;
let intervalTimer  = null;
let shuffledQueue  = [];
let isRunning      = false;

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (_) {}
}

// ─── Config ───────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    log(`ERROR loading config: ${e.message}`);
    return { lightShows: [], schedule: { startTime: '18:00', endTime: '23:00', intervalMinutes: 10 } };
  }
}

function saveScheduleConfig(scheduleObj) {
  try {
    const config = loadConfig();
    config.schedule = scheduleObj;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    log(`Schedule saved: start=${scheduleObj.startTime} end=${scheduleObj.endTime} interval=${scheduleObj.intervalMinutes}min`);
  } catch (e) {
    log(`ERROR saving schedule: ${e.message}`);
  }
}

// ─── Fisher-Yates shuffle ─────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Queue management ─────────────────────────────────────────────────────────
function buildQueue() {
  const { lightShows } = loadConfig();
  const enabled = (lightShows || []).filter(ls => ls.enabled);
  shuffledQueue = shuffle(enabled);
  log(`Queue built: [${shuffledQueue.map(ls => ls.name).join(' → ')}]`);
}

function nextInQueue() {
  if (shuffledQueue.length === 0) {
    log('Queue exhausted — reshuffling for next cycle.');
    buildQueue();
  }
  return shuffledQueue.shift() || null;
}

// ─── API caller ───────────────────────────────────────────────────────────────
async function runLightShow(lightShow) {
  const start = Date.now();
  log(`▶ Running "${lightShow.name}" [${lightShow.id}]`);

  if (!lightShowStats[lightShow.id]) {
    lightShowStats[lightShow.id] = { runs: 0, lastStatus: null, lastRun: null };
  }
  lightShowStats[lightShow.id].runs++;
  lightShowStats[lightShow.id].lastRun = new Date().toISOString();

  try {
    const { method, url, headers, body } = lightShow.request;
    const resp = await axios({
      method: method.toLowerCase(),
      url,
      headers,
      data: body || undefined,
      timeout: 15000,
    });
    const ms     = Date.now() - start;
    const status = `${resp.status} ${resp.statusText}`;
    lightShowStats[lightShow.id].lastStatus = `✅ ${status} (${ms}ms)`;
    log(`  ✅ ${lightShow.id} → ${status} in ${ms}ms`);
  } catch (err) {
    const status = err.response
      ? `${err.response.status} ${err.response.statusText}`
      : err.message;
    lightShowStats[lightShow.id].lastStatus = `❌ ${status}`;
    log(`  ❌ ${lightShow.id} → ${status}`);
  }

  updateTrayMenu();
  if (settingsWin) {
    settingsWin.webContents.send('lightshow-complete', {
      lightShow,
      status: lightShowStats[lightShow.id].lastStatus,
    });
    settingsWin.webContents.send('scheduler-state', buildSchedulerState());
  }
}

// ─── Tick: fire next show from queue ─────────────────────────────────────────
function tick() {
  const show = nextInQueue();
  if (!show) { log('No enabled light shows — skipping tick.'); return; }
  runLightShow(show);
  if (settingsWin) settingsWin.webContents.send('scheduler-state', buildSchedulerState());
}

// ─── Active window start / stop ───────────────────────────────────────────────
function startActiveWindow() {
  if (isRunning) return;
  const config      = loadConfig();
  const intervalMin = config.schedule?.intervalMinutes ?? 10;
  const intervalMs  = intervalMin * 60 * 1000;

  log(`=== Active window started (every ${intervalMin} min) ===`);
  isRunning = true;
  buildQueue();

  tick();  // fire immediately
  intervalTimer = setInterval(tick, intervalMs);

  updateTrayMenu();
  if (settingsWin) settingsWin.webContents.send('scheduler-state', buildSchedulerState());
}

function stopActiveWindow() {
  if (!isRunning && !intervalTimer) return;
  log('=== Active window ended ===');
  isRunning     = false;
  shuffledQueue = [];
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }

  updateTrayMenu();
  if (settingsWin) settingsWin.webContents.send('scheduler-state', buildSchedulerState());
}

// ─── Scheduler: arm daily start/end crons ────────────────────────────────────
function startScheduler() {
  if (startCronTask) { startCronTask.destroy(); startCronTask = null; }
  if (endCronTask)   { endCronTask.destroy();   endCronTask   = null; }
  stopActiveWindow();

  const config    = loadConfig();
  const schedule  = config.schedule || {};
  const startTime = schedule.startTime    || '18:00';
  const endTime   = schedule.endTime      || '23:00';
  const interval  = schedule.intervalMinutes ?? 10;

  const toCron = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return `${m} ${h} * * *`;
  };

  startCronTask = cron.schedule(toCron(startTime), () => {
    log(`Start time hit (${startTime})`);
    startActiveWindow();
  });

  endCronTask = cron.schedule(toCron(endTime), () => {
    log(`End time hit (${endTime})`);
    stopActiveWindow();
  });

  log(`Scheduler armed: daily ${startTime}–${endTime}, every ${interval} min`);
  updateTrayMenu();
}

// ─── State snapshot for UI ────────────────────────────────────────────────────
function buildSchedulerState() {
  const config   = loadConfig();
  const schedule = config.schedule || {};
  const enabled  = (config.lightShows || []).filter(ls => ls.enabled);
  return {
    isRunning,
    startTime:       schedule.startTime       ?? '18:00',
    endTime:         schedule.endTime         ?? '23:00',
    intervalMinutes: schedule.intervalMinutes ?? 10,
    enabledCount:    enabled.length,
    queueRemaining:  shuffledQueue.length,
    queueOrder:      shuffledQueue.map(ls => ls.name),
    stats:           lightShowStats,
  };
}

// ─── Settings window ─────────────────────────────────────────────────────────
function openSettings() {
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 800,
    height: 680,
    title: 'TrayScheduler — Settings',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ─── Tray menu ────────────────────────────────────────────────────────────────
function buildLightShowMenuItems() {
  const { lightShows } = loadConfig();
  if (!lightShows?.length) return [{ label: 'No light shows configured', enabled: false }];
  return lightShows.map(ls => {
    const stats = lightShowStats[ls.id];
    return {
      label: `${ls.enabled ? '🟢' : '⚫'} ${ls.name}`,
      submenu: [
        { label: stats ? `Runs: ${stats.runs}` : 'Runs: 0',         enabled: false },
        { label: stats?.lastStatus ?? 'Not run yet',                 enabled: false },
        { type: 'separator' },
        { label: 'Run Now', enabled: ls.enabled, click: () => runLightShow(ls) },
      ],
    };
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const config   = loadConfig();
  const schedule = config.schedule || {};
  const statusLine = isRunning
    ? `🟠 Running  •  every ${schedule.intervalMinutes ?? 10} min`
    : `⚫ Idle  •  starts ${schedule.startTime ?? '--:--'}`;

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'TrayScheduler', enabled: false },
    { label: statusLine,      enabled: false },
    { type: 'separator' },
    ...buildLightShowMenuItems(),
    { type: 'separator' },
    {
      label: isRunning ? '⏹  Stop Now' : '▶  Start Now',
      click: () => isRunning ? stopActiveWindow() : startActiveWindow(),
    },
    { type: 'separator' },
    { label: 'Open Log File',      click: () => shell.openPath(LOG_PATH) },
    { label: 'Edit Config',        click: () => shell.openPath(CONFIG_PATH) },
    { label: 'Settings / UI',      click: openSettings },
    { label: 'Reload Light Shows', click: () => { startScheduler(); updateTrayMenu(); } },
    { type: 'separator' },
    { label: 'Quit',               click: () => app.quit() },
  ]));
}

// ─── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('get-scheduler-state', (event) => {
  event.reply('scheduler-state', buildSchedulerState());
});

ipcMain.on('save-schedule', (_, scheduleObj) => {
  saveScheduleConfig(scheduleObj);
  startScheduler();
  if (settingsWin) settingsWin.webContents.send('scheduler-state', buildSchedulerState());
});

ipcMain.on('start-now',         ()    => startActiveWindow());
ipcMain.on('stop-now',          ()    => stopActiveWindow());
ipcMain.on('run-lightshow-now', (_, ls) => runLightShow(ls));
ipcMain.on('reload-config',     ()    => { startScheduler(); updateTrayMenu(); });

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  app.setLoginItemSettings({ openAtLogin: false });

  // Ensure writable dirs exist
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });

  // On first run after install, copy bundled config.json to userData
  if (IS_PACKED && BUNDLED_CONFIG && !fs.existsSync(CONFIG_PATH)) {
    try {
      fs.copyFileSync(BUNDLED_CONFIG, CONFIG_PATH);
      log('First run: copied default config.json to ' + CONFIG_PATH);
    } catch (e) {
      log('WARN: could not copy bundled config: ' + e.message);
    }
  }

  const icon = fs.existsSync(ICON_PATH)
    ? nativeImage.createFromPath(ICON_PATH)
    : nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA' +
        'BmJLR0QA/wD/AP+gvaeTAAAAOklEQVQ4jWNgGAXkAiYGBob/RAr+//9PtAEMgxoYBjAM' +
        'YAAAAP//AwBn7gX/nYRMUwAAAABJRU5ErkJggg=='
      );

  tray = new Tray(icon);
  tray.setToolTip('TrayScheduler');
  updateTrayMenu();

  log('=== TrayScheduler started ===');
  startScheduler();
});

app.on('window-all-closed', (e) => e.preventDefault());
