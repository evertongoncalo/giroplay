'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, screen, powerSaveBlocker, Tray, Menu, dialog, shell, globalShortcut, nativeImage } = require('electron');

const { Logger } = require('./logger');
const { Config } = require('./config');
const { Library } = require('./library');
const { Media } = require('./media');
const { Ingest } = require('./ingest');
const { PlayLog, StatusReporter } = require('./status');

// ---------- linha de comando (a maior parte só serve para teste/medição) ----------
const flag = (name) => process.argv.includes(`--${name}`);
const opt = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
function cliOverrides() {
  const out = {};
  if (opt('watch')) out.watchFolder = opt('watch');
  for (const arg of process.argv.filter((a) => a.startsWith('--cfg='))) {
    const [key, ...rest] = arg.slice(6).split('=');
    const raw = rest.join('=');
    try { out[key] = JSON.parse(raw); } catch { out[key] = raw; }
  }
  return out;
}
function parseWindowed(text) {
  const m = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(text || '');
  return m ? { width: +m[1], height: +m[2], x: +m[3], y: +m[4] } : null;
}

// ---------- pastas e chaves do Chromium (antes do app ficar pronto) ----------
const dataDir = opt('giro-data') || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'GiroPlay');
app.setPath('userData', dataDir);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// O painel fica atrás de outras janelas ou sem foco: não pode haver economia de energia no vídeo.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const windowed = parseWindowed(opt('windowed'));
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

let logger; let config; let library; let media; let ingest; let playLog; let status;
let playerWin = null; let settingsWin = null; let tray = null;
let quitting = false;
let nowPlaying = null;
let placeTimer = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!argv.includes('--watchdog')) openSettings();
  });
  app.whenReady().then(boot).catch((err) => {
    console.error(err);
    app.exit(1);
  });
  // O painel continua rodando mesmo sem janelas visíveis.
  app.on('window-all-closed', () => {});
}

// ---------- inicialização ----------
async function boot() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.rmSync(path.join(dataDir, 'quit.flag'), { force: true });
  logger = new Logger(path.join(dataDir, 'logs'), { echo: flag('echo') });
  config = new Config(path.join(dataDir, 'config.json'), cliOverrides());
  const cfg = config.get();
  const libraryDir = cfg.libraryFolder || path.join(dataDir, 'biblioteca');

  library = new Library(libraryDir, logger);
  media = new Media(() => config.get());
  ingest = new Ingest({ getConfig: () => config.get(), library, media, logger });
  playLog = new PlayLog(path.join(dataDir, 'exibicoes'));
  status = new StatusReporter({
    dataDir, getConfig: () => config.get(), library, ingest, playLog, logger, version: app.getVersion(), getMetrics,
  });

  logger.info(`GiroPlay ${app.getVersion()} iniciando (pasta de dados: ${dataDir})`);
  process.on('uncaughtException', (err) => logger.error(`erro não tratado: ${err.stack || err.message}`));
  process.on('unhandledRejection', (err) => logger.error(`promessa rejeitada: ${err && err.stack ? err.stack : err}`));
  app.on('child-process-gone', (_e, details) => logger.error('processo do Chromium caiu', details));

  registerIpc(libraryDir);
  library.on('changed', () => sendToPlayer('playlist:changed'));
  config.on('changed', () => sendToPlayer('config:changed', playerConfig()));
  setInterval(() => library.cleanup(), 60e3);
  library.cleanup();

  powerSaveBlocker.start('prevent-display-sleep');
  createPlayer();
  createTray();
  globalShortcut.register('CommandOrControl+Alt+G', openSettings);
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, schedulePlace);
  applyLoginItem();

  ingest.start();
  status.start();
  startHeartbeat();
  startGuardian(cfg);
  testHooks();

  app.on('before-quit', () => {
    quitting = true;
    try { fs.writeFileSync(path.join(dataDir, 'quit.flag'), String(Date.now())); } catch { /* ignora */ }
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());

  if (!config.existed && !windowed) openSettings();
}

function getMetrics() {
  try {
    const kb = app.getAppMetrics().reduce((sum, m) => sum + (m.memory ? m.memory.workingSetSize : 0), 0);
    return Math.round(kb / 1024);
  } catch {
    return null;
  }
}

// ---------- janela do painel ----------
function chooseDisplay(cfg) {
  const all = screen.getAllDisplays();
  if (cfg.displayId !== null) {
    const wanted = all.find((d) => d.id === cfg.displayId);
    if (wanted) return wanted;
  }
  const primary = screen.getPrimaryDisplay();
  return all.find((d) => d.id !== primary.id) || primary; // com segunda tela, ela é o painel
}

function createPlayer() {
  const bounds = windowed || chooseDisplay(config.get()).bounds;
  playerWin = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    show: false, frame: false, backgroundColor: '#000000', title: 'GiroPlay',
    resizable: Boolean(windowed), movable: Boolean(windowed), minimizable: false, maximizable: false,
    fullscreenable: !windowed, focusable: !windowed,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'player-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
    },
  });
  playerWin.setMenuBarVisibility(false);
  playerWin.once('ready-to-show', () => {
    if (windowed) {
      playerWin.showInactive();
      playerWin.setAlwaysOnTop(true); // para a medição enxergar a janela mesmo com outras abertas
    } else {
      playerWin.show();
      playerWin.setAlwaysOnTop(true, 'screen-saver');
      playerWin.setFullScreen(true);
    }
  });
  // Alt+F4 não derruba o painel; só o menu "Sair" fecha de verdade.
  playerWin.on('close', (event) => { if (!quitting) event.preventDefault(); });
  playerWin.on('unresponsive', () => {
    logger.warn('janela do player não responde; recarregando em 10 s se continuar assim');
    setTimeout(() => { if (playerWin && !playerWin.isDestroyed()) playerWin.webContents.reload(); }, 10000);
  });
  playerWin.webContents.on('render-process-gone', (_e, details) => {
    logger.error('processo da tela do player caiu; recarregando', details);
    setTimeout(() => { if (playerWin && !playerWin.isDestroyed()) playerWin.webContents.reload(); }, 1000);
  });
  playerWin.loadFile(path.join(__dirname, '..', 'renderer', 'player.html'));
}

function schedulePlace() {
  clearTimeout(placeTimer);
  placeTimer = setTimeout(placePlayer, 800);
}

function placePlayer() {
  if (windowed || !playerWin || playerWin.isDestroyed()) return;
  const display = chooseDisplay(config.get());
  playerWin.setFullScreen(false);
  playerWin.setBounds(display.bounds);
  playerWin.setFullScreen(true);
  logger.info(`painel posicionado em ${display.bounds.width}x${display.bounds.height} (tela ${display.id})`);
}

function sendToPlayer(channel, payload) {
  if (playerWin && !playerWin.isDestroyed()) playerWin.webContents.send(channel, payload);
}

const playerConfig = () => ({ fit: config.get().fit, audio: config.get().audio });

// ---------- configurações e bandeja ----------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 680, height: 800, minWidth: 560, minHeight: 600, title: 'GiroPlay · configurações',
    backgroundColor: '#0f1117', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  // O painel fica por cima de tudo; enquanto as configurações estão abertas, ele cede o topo.
  if (playerWin && !playerWin.isDestroyed()) playerWin.setAlwaysOnTop(false);
  settingsWin.on('closed', () => {
    if (playerWin && !playerWin.isDestroyed() && !windowed) playerWin.setAlwaysOnTop(true, 'screen-saver');
  });
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  if (!fs.existsSync(iconPath)) return;
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.setToolTip('GiroPlay');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Configurações (Ctrl+Alt+G)', click: openSettings },
    { label: 'Abrir pasta de vídeos', click: () => { const f = config.get().watchFolder; if (f) shell.openPath(f); } },
    { type: 'separator' },
    { label: 'Sair do GiroPlay', click: confirmQuit },
  ]));
  tray.on('double-click', openSettings);
}

async function confirmQuit() {
  const answer = await dialog.showMessageBox(settingsWin && !settingsWin.isDestroyed() ? settingsWin : undefined, {
    type: 'warning', buttons: ['Sair', 'Continuar rodando'], defaultId: 1, cancelId: 1,
    title: 'GiroPlay', message: 'Sair do GiroPlay?', detail: 'O painel vai ficar sem exibir os vídeos até o app ser aberto de novo.',
  });
  if (answer.response === 0) {
    await status.stop();
    quitting = true;
    app.quit();
  }
}

function applyLoginItem() {
  if (!app.isPackaged) return; // só o app instalado mexe na inicialização do Windows
  app.setLoginItemSettings({ openAtLogin: config.get().launchAtLogin, path: process.execPath });
}

// ---------- guardião e sinal de vida ----------
function startHeartbeat() {
  const file = path.join(dataDir, 'heartbeat');
  const beat = () => { try { fs.writeFileSync(file, String(Date.now())); } catch { /* ignora */ } };
  beat();
  setInterval(beat, 5000);
}

function startGuardian(cfg) {
  if (!cfg.guardian || flag('no-guardian')) return;
  const script = unpacked(path.join(__dirname, 'guardian.js'));
  const child = spawn(process.execPath, [script, String(process.pid), dataDir, process.execPath, ...process.argv.slice(1)], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
  logger.info(`guardião ativo (pid ${child.pid})`);
}

// ---------- IPC ----------
function registerIpc(libraryDir) {
  ipcMain.handle('player:next', (_e, afterId) => {
    const entry = library.next(afterId || null);
    return entry
      ? { id: entry.id, name: entry.sourceRel, url: pathToFileURL(library.filePath(entry)).href, duration: entry.duration }
      : null;
  });
  ipcMain.handle('player:config', () => playerConfig());
  ipcMain.on('player:inuse', (_e, ids) => library.setInUse(Array.isArray(ids) ? ids : []));
  ipcMain.on('player:started', (_e, info) => {
    nowPlaying = info;
    status.setCurrent(info);
    logger.info(`tocando: ${info.name}`);
  });
  ipcMain.on('player:played', (_e, record) => playLog.record(record));
  ipcMain.on('player:error', (_e, id, message) => library.quarantine(id, String(message || 'erro ao tocar')));
  ipcMain.on('player:log', (_e, level, message) => (logger[level] || logger.info).call(logger, `[player] ${message}`));

  ipcMain.handle('settings:get', () => ({
    version: app.getVersion(),
    firstRun: !config.existed,
    packaged: app.isPackaged,
    config: pick(config.get(), ['watchFolder', 'displayId', 'fit', 'launchAtLogin', 'audio', 'statusToDrive']),
    displays: screen.getAllDisplays().map((d) => ({
      id: d.id, width: d.bounds.width, height: d.bounds.height, primary: d.id === screen.getPrimaryDisplay().id,
    })),
    nowPlaying,
    playlist: library.ready().map((e) => ({ name: e.sourceRel, duration: e.duration, via: e.via, width: e.width, height: e.height })),
    totalSeconds: library.totalSeconds(),
    ingest: ingest.getState(),
    memoryMB: getMetrics(),
    paths: { library: libraryDir, logs: path.join(dataDir, 'logs'), data: dataDir, plays: path.join(dataDir, 'exibicoes') },
  }));
  ipcMain.handle('settings:save', (_e, patch) => {
    const before = config.get();
    const after = config.update(pick(patch || {}, ['watchFolder', 'displayId', 'fit', 'launchAtLogin', 'audio', 'statusToDrive']));
    if (after.watchFolder !== before.watchFolder) {
      logger.info(`pasta de vídeos: ${after.watchFolder}`);
      ingest.rescan();
    }
    if (after.displayId !== before.displayId) placePlayer();
    if (after.launchAtLogin !== before.launchAtLogin) applyLoginItem();
    return true;
  });
  ipcMain.handle('settings:pick-folder', async () => {
    const result = await dialog.showOpenDialog(settingsWin, {
      title: 'Escolha a pasta sincronizada com o Google Drive', properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('settings:action', async (_e, name) => {
    const cfg = config.get();
    switch (name) {
      case 'open-watch': if (cfg.watchFolder) await shell.openPath(cfg.watchFolder); break;
      case 'open-library': await shell.openPath(libraryDir); break;
      case 'open-logs': await shell.openPath(path.join(dataDir, 'logs')); break;
      case 'open-plays': await shell.openPath(path.join(dataDir, 'exibicoes')); break;
      case 'rescan': ingest.rescan(); break;
      case 'restart-player': if (playerWin && !playerWin.isDestroyed()) playerWin.webContents.reload(); break;
      case 'quit': await confirmQuit(); break;
      default: break;
    }
  });
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) if (key in obj) out[key] = obj[key];
  return out;
}

// ---------- ganchos de teste/medição (só ativos com flags explícitas) ----------
function testHooks() {
  const memOut = opt('mem-out');
  if (memOut) {
    const sample = () => {
      const by = {};
      for (const m of app.getAppMetrics()) by[m.type] = (by[m.type] || 0) + Math.round((m.memory?.workingSetSize || 0) / 1024);
      fs.appendFileSync(memOut, `${JSON.stringify({ t: Date.now(), ...by, total: getMetrics() })}\n`);
    };
    sample();
    setInterval(sample, 15000);
  }
  const settingsShot = opt('settings-shot');
  if (settingsShot) {
    openSettings();
    setTimeout(async () => {
      try {
        const image = await settingsWin.webContents.capturePage();
        fs.writeFileSync(settingsShot, image.toPNG());
      } catch (err) {
        logger.error(`settings-shot: ${err.message}`);
      }
      fs.writeFileSync(path.join(dataDir, 'quit.flag'), String(Date.now()));
      app.exit(0);
    }, 12000);
  }
  const exitAfter = Number(opt('exit-after'));
  if (exitAfter > 0) {
    setTimeout(async () => {
      try {
        const statsOut = opt('stats-out');
        if (statsOut && playerWin && !playerWin.isDestroyed()) {
          const stats = await playerWin.webContents.executeJavaScript('JSON.stringify(window.__giroStats || [])');
          fs.writeFileSync(statsOut, stats);
        }
      } catch (err) {
        logger.error(`stats-out: ${err.message}`);
      }
      fs.writeFileSync(path.join(dataDir, 'quit.flag'), String(Date.now()));
      app.exit(0);
    }, exitAfter * 1000);
  }
}
