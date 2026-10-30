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
const { readJson, atomicWriteJson } = require('./util');

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

const windowed = parseWindowed(opt('windowed')); // janela de teste em vez de tela cheia
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const SETTINGS_KEYS = ['watchFolder', 'displayId', 'fit', 'autoStart', 'launchAtLogin', 'audio', 'statusToDrive'];

let logger; let config; let library; let media; let ingest; let playLog; let status;
let playerWin = null; let settingsWin = null; let tray = null;
let playing = false; // a exibição em tela cheia está ligada
let quitting = false;
let guardianStarted = false;
let sleepBlocker = null;
let nowPlaying = null;
let placeTimer = null;
let libraryDirPath = '';

const stateFile = () => path.join(dataDir, 'estado.json');
const saveState = () => { try { atomicWriteJson(stateFile(), { playing }); } catch { /* ignora */ } };

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Abrir o GiroPlay de novo (atalho, instalador) com ele já rodando traz as configurações para a frente.
  app.on('second-instance', () => openSettings());
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
  libraryDirPath = cfg.libraryFolder || path.join(dataDir, 'biblioteca');

  library = new Library(libraryDirPath, logger);
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

  registerIpc();
  library.on('changed', () => sendToPlayer('playlist:changed'));
  config.on('changed', () => sendToPlayer('config:changed', playerConfig()));
  setInterval(() => library.cleanup(), 60e3);
  library.cleanup();

  createTray();
  registerShortcuts();
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, schedulePlace);
  applyLoginItem();

  app.on('before-quit', () => {
    quitting = true;
    playing = false;
    saveState();
    try { fs.writeFileSync(path.join(dataDir, 'quit.flag'), String(Date.now())); } catch { /* ignora */ }
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());

  ingest.start(); // a pasta já vai sendo conferida enquanto você configura
  status.start();
  startHeartbeat();
  testHooks();

  // Por padrão o app abre SÓ nas configurações e espera o ▶ Iniciar. Começa a exibir direto quando:
  //  - "iniciar sozinho" está ligado; ou o guardião o reabriu depois de uma queda durante a exibição (--retomar);
  //  - foi aberto com --play (atalho do painel) ou em janela de teste (--windowed).
  const resumed = flag('retomar') && readJson(stateFile(), {}).playing === true;
  const startNow = Boolean(cfg.watchFolder) && (cfg.autoStart || resumed || flag('play') || Boolean(windowed));
  if (startNow) startPlayback();
  else openSettings();
}

function getMetrics() {
  try {
    const kb = app.getAppMetrics().reduce((sum, m) => sum + (m.memory ? m.memory.workingSetSize : 0), 0);
    return Math.round(kb / 1024);
  } catch {
    return null;
  }
}

// ---------- iniciar / parar a exibição ----------
function startPlayback() {
  if (playing) return;
  if (!config.get().watchFolder) {
    openSettings();
    return;
  }
  playing = true;
  saveState();
  sleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
  hideSettings(); // quem apertou ▶ Iniciar quer ver o painel, não as configurações
  createPlayer();
  startGuardian(config.get());
  refreshTray();
  logger.info('exibição iniciada');
}

function stopPlayback() {
  if (!playing) return;
  playing = false;
  saveState();
  if (sleepBlocker !== null) {
    powerSaveBlocker.stop(sleepBlocker);
    sleepBlocker = null;
  }
  if (playerWin && !playerWin.isDestroyed()) playerWin.destroy();
  playerWin = null;
  nowPlaying = null;
  status.setCurrent(null);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setAlwaysOnTop(false);
  refreshTray();
  logger.info('exibição parada');
}

async function quitApp() {
  if (quitting) return;
  logger.info('saindo do GiroPlay (pedido do usuário)');
  try { await status.stop(); } catch { /* sai mesmo assim */ }
  quitting = true;
  app.quit();
}

async function confirmQuit() {
  const answer = await dialog.showMessageBox(settingsWin && !settingsWin.isDestroyed() ? settingsWin : undefined, {
    type: 'warning', buttons: ['Sair', 'Continuar rodando'], defaultId: 1, cancelId: 1,
    title: 'GiroPlay', message: 'Sair do GiroPlay?', detail: 'O painel vai ficar sem exibir os vídeos até o app ser aberto de novo.',
  });
  if (answer.response === 0) await quitApp();
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

const settingsVisible = () => Boolean(settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible());

// Pede "sempre por cima" e CONFERE. Medido neste projeto: logo depois de o painel em tela cheia ceder o
// topo, o Windows às vezes ignora o primeiro pedido da outra janela (isAlwaysOnTop() volta false).
// Por isso o pedido é reafirmado nos instantes seguintes enquanto ainda for desejado.
function keepOnTop(win, level, stillWanted) {
  const apply = () => {
    if (win.isDestroyed() || !stillWanted()) return;
    win.setAlwaysOnTop(false);
    win.setAlwaysOnTop(true, level);
    win.moveTop();
  };
  apply();
  for (const ms of [200, 600, 1500]) {
    setTimeout(() => {
      if (!win.isDestroyed() && stillWanted() && !win.isAlwaysOnTop()) {
        logger.warn(`o Windows ignorou o pedido de "sempre por cima" (${level}); reafirmando`);
        apply();
      }
    }, ms);
  }
}

// Põe o painel por cima de tudo, com o teclado, mas só se as configurações não estiverem abertas.
const playerWantsTop = () => playing && !windowed && playerWin && !playerWin.isDestroyed() && !settingsVisible();
function raisePlayer() {
  if (!playerWantsTop()) return;
  keepOnTop(playerWin, 'screen-saver', playerWantsTop);
  playerWin.focus();
  playerWin.webContents.focus();
}

// O painel tem que cobrir a tela INTEIRA, inclusive a barra de tarefas. Confere o tamanho real da
// janela depois de entrar em tela cheia e corrige se o Windows a deixou menor (já aconteceu).
function coverScreen(win) {
  const check = () => {
    if (win.isDestroyed() || windowed) return;
    const want = chooseDisplay(config.get()).bounds;
    const have = win.getBounds();
    if (have.x !== want.x || have.y !== want.y || have.width !== want.width || have.height !== want.height) {
      logger.warn(`o painel não cobriu a tela inteira (${have.width}x${have.height} em ${have.x},${have.y}; esperado ${want.width}x${want.height}); ajustando`);
      win.setBounds(want);
    }
  };
  for (const ms of [400, 1200, 3000]) setTimeout(check, ms);
}

function createPlayer() {
  const bounds = windowed || chooseDisplay(config.get()).bounds;
  const win = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    show: false, frame: false, backgroundColor: '#000000', title: 'GiroPlay',
    // resizable PRECISA ser true: medido neste projeto, com resizable:false o Windows deixa a tela cheia do
    // tamanho da área útil (1934x1039 numa tela 1920x1080) e a barra de tarefas continua aparecendo.
    resizable: true, movable: Boolean(windowed), minimizable: false, maximizable: false,
    fullscreenable: !windowed, focusable: !windowed,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'player-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
    },
  });
  playerWin = win;
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    if (windowed) {
      win.showInactive();
      win.setAlwaysOnTop(true); // para a medição enxergar a janela mesmo com outras abertas
      return;
    }
    win.show();
    win.setFullScreen(true);
    raisePlayer();
    coverScreen(win);
  });
  // Alt+F4 não derruba o painel de repente: abre o menu de saída (Esc de novo sai de verdade).
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    showExitMenu();
  });
  win.on('unresponsive', () => {
    logger.warn('janela do player não responde; recarregando em 10 s se continuar assim');
    setTimeout(() => { if (!win.isDestroyed()) win.webContents.reload(); }, 10000);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error('processo da tela do player caiu; recarregando', details);
    setTimeout(() => { if (!win.isDestroyed()) win.webContents.reload(); }, 1000);
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'player.html'));
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

// Menu de saída dentro do painel (o mesmo da tecla Esc). Serve para atalhos, Alt+F4 e a bandeja.
function showExitMenu() {
  if (!playerWin || playerWin.isDestroyed()) {
    openSettings();
    return;
  }
  if (settingsVisible()) {
    settingsWin.focus();
    return;
  }
  raisePlayer();
  if (windowed) playerWin.show();
  playerWin.webContents.send('menu:show');
}

const openMenu = () => (playing ? showExitMenu() : openSettings());

// ---------- configurações, bandeja e atalhos ----------
function openSettings() {
  if (!settingsWin || settingsWin.isDestroyed()) {
    const win = new BrowserWindow({
      width: 680, height: 820, minWidth: 560, minHeight: 600, title: 'GiroPlay · configurações',
      backgroundColor: '#0f1117', autoHideMenuBar: true, show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'settings-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    settingsWin = win;
    win.setMenuBarVisibility(false);
    win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
    win.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      // Exibindo: só esconde as configurações. Parado: fechar a janela encerra o app (não sobra nada rodando).
      if (playing) hideSettings();
      else quitApp();
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  } else {
    settingsWin.show();
    settingsWin.focus();
  }
  // O painel cede o topo: as configurações ficam SEMPRE na frente dele.
  if (playing && playerWin && !playerWin.isDestroyed() && !windowed) {
    playerWin.setAlwaysOnTop(false);
    keepOnTop(settingsWin, 'floating', () => playing && settingsVisible());
  }
  settingsWin.moveTop();
}

function hideSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.setAlwaysOnTop(false);
    settingsWin.hide();
  }
  raisePlayer();
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Configurações (Ctrl+Alt+G)', click: openSettings },
    playing
      ? { label: '■ Parar exibição', click: () => { stopPlayback(); openSettings(); } }
      : { label: '▶ Iniciar painel', click: startPlayback },
    { label: 'Abrir pasta de vídeos', click: () => { const f = config.get().watchFolder; if (f) shell.openPath(f); } },
    { type: 'separator' },
    { label: 'Sair do GiroPlay', click: confirmQuit },
  ]));
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  if (!fs.existsSync(iconPath)) return;
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.setToolTip('GiroPlay');
  tray.on('double-click', openMenu);
  refreshTray();
}

// Atalhos que funcionam com qualquer janela em foco. Dois, porque Ctrl+Alt é "AltGr" em alguns teclados.
function registerShortcuts() {
  for (const accelerator of ['CommandOrControl+Alt+G', 'CommandOrControl+Shift+G']) {
    if (!globalShortcut.register(accelerator, openMenu)) logger.warn(`o atalho ${accelerator} não pôde ser registrado (outro programa usa?)`);
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

// O guardião só sobe quando a exibição começa: sem exibir, não há nada para vigiar.
function startGuardian(cfg) {
  if (guardianStarted || !cfg.guardian || flag('no-guardian')) return;
  guardianStarted = true;
  const script = unpacked(path.join(__dirname, 'guardian.js'));
  const child = spawn(process.execPath, [script, String(process.pid), dataDir, process.execPath, ...process.argv.slice(1)], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
  logger.info(`guardião ativo (pid ${child.pid})`);
}

// ---------- IPC ----------
function applySettings(patch) {
  const before = config.get();
  const after = config.update(pick(patch || {}, SETTINGS_KEYS));
  if (after.watchFolder !== before.watchFolder) {
    logger.info(`pasta de vídeos: ${after.watchFolder}`);
    ingest.rescan();
  }
  if (after.displayId !== before.displayId) placePlayer();
  if (after.launchAtLogin !== before.launchAtLogin) applyLoginItem();
}

function registerIpc() {
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
  ipcMain.on('player:quit', () => { logger.info('saída pelo menu do painel (Esc)'); quitApp(); });
  ipcMain.on('player:open-settings', () => openSettings());
  ipcMain.on('player:stop', () => { stopPlayback(); openSettings(); });

  ipcMain.handle('settings:get', () => ({
    version: app.getVersion(),
    firstRun: !config.existed,
    packaged: app.isPackaged,
    playing,
    config: pick(config.get(), SETTINGS_KEYS),
    displays: screen.getAllDisplays().map((d) => ({
      id: d.id, width: d.bounds.width, height: d.bounds.height, primary: d.id === screen.getPrimaryDisplay().id,
    })),
    nowPlaying,
    playlist: library.ready().map((e) => ({ name: e.sourceRel, duration: e.duration, via: e.via, width: e.width, height: e.height })),
    totalSeconds: library.totalSeconds(),
    ingest: ingest.getState(),
    memoryMB: getMetrics(),
    paths: { library: libraryDirPath, logs: path.join(dataDir, 'logs'), data: dataDir, plays: path.join(dataDir, 'exibicoes') },
  }));
  ipcMain.handle('settings:save', (_e, patch) => {
    applySettings(patch);
    return true;
  });
  ipcMain.handle('settings:play', (_e, patch) => {
    applySettings(patch);
    if (!config.get().watchFolder) return { ok: false, error: 'Escolha primeiro a pasta de vídeos.' };
    startPlayback();
    return { ok: true };
  });
  ipcMain.handle('settings:stop', () => {
    stopPlayback();
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
      case 'open-library': await shell.openPath(libraryDirPath); break;
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

  // --test-script=SEGUNDOS:ação,...  Simula o que o usuário faria, para os testes de ponta a ponta.
  const script = opt('test-script');
  if (script) {
    for (const step of script.split(',')) {
      const [seconds, action] = step.split(':');
      setTimeout(() => testAction(action, seconds), Number(seconds) * 1000);
    }
  }

  const settingsShot = opt('settings-shot');
  if (settingsShot) {
    setTimeout(async () => {
      try {
        openSettings();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const image = await settingsWin.webContents.capturePage();
        fs.writeFileSync(settingsShot, image.toPNG());
      } catch (err) {
        logger.error(`settings-shot: ${err.message}`);
      }
      fs.writeFileSync(path.join(dataDir, 'quit.flag'), String(Date.now()));
      app.exit(0);
    }, 10000);
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

async function testAction(action, seconds) {
  logger.info(`[teste] ação: ${action}`);
  const key = (keyCode) => {
    if (!playerWin || playerWin.isDestroyed()) return logger.warn('[teste] sem janela do painel para enviar tecla');
    playerWin.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    playerWin.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    return undefined;
  };
  const shot = async (win, name) => {
    try {
      const dir = path.join(dataDir, 'fotos');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}-${seconds}.png`), (await win.webContents.capturePage()).toPNG());
    } catch (err) {
      logger.warn(`[teste] foto: ${err.message}`);
    }
  };
  switch (action) {
    case 'play': startPlayback(); break;
    case 'stop': stopPlayback(); break;
    case 'settings': openSettings(); break;
    case 'shortcut': openMenu(); break;
    case 'esc': key('Escape'); break;
    case 'c': key('c'); break;
    case 'p': key('p'); break;
    case 'enter': key('Enter'); break;
    case 'altf4': if (playerWin && !playerWin.isDestroyed()) playerWin.close(); break;
    case 'shot-player': if (playerWin && !playerWin.isDestroyed()) await shot(playerWin, 'painel'); break;
    case 'shot-settings': if (settingsWin && !settingsWin.isDestroyed()) await shot(settingsWin, 'configuracoes'); break;
    case 'dump': {
      const p = playerWin && !playerWin.isDestroyed() ? playerWin : null;
      const s = settingsWin && !settingsWin.isDestroyed() ? settingsWin : null;
      logger.info(`[teste] estado: playing=${playing} | painel=${p ? `sim tela-cheia=${p.isFullScreen()} no-topo=${p.isAlwaysOnTop()} visivel=${p.isVisible()}` : 'nao'} | config=${s ? `sim visivel=${s.isVisible()} no-topo=${s.isAlwaysOnTop()}` : 'nao'}`);
      break;
    }
    default: break;
  }
}
