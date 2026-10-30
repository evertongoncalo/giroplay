'use strict';
// Player sem corte.
//
// Dois <video> empilhados. Enquanto o da frente toca, o de trás já carregou o PRÓXIMO vídeo e
// espera parado no primeiro quadro. Perto do fim do atual, o de trás começa a tocar e, assim que
// o primeiro quadro dele aparece de verdade na tela, ele sobe para a frente. O vídeo que acabou
// fica congelado no último quadro até lá, então nunca aparece tela preta entre dois vídeos.

const api = window.giro;
const stageEl = document.getElementById('stage');
const standbyEl = document.getElementById('standby');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const log = (level, message) => { try { api.log(level, message); } catch { /* ignora */ } };

// Medições de cada troca (lidas pelos testes de medição)
const stats = (window.__giroStats = []);
const MAX_STATS = 400;

// Com quanta antecedência (s) o próximo começa a tocar. Se adapta ao tempo real que o
// vídeo leva para aparecer na tela depois do play().
let lead = 0.1;
let latencyMs = 100;

function makeLayer() {
  const el = document.createElement('video');
  el.className = 'layer';
  el.muted = true;
  el.defaultMuted = true;
  el.playsInline = true;
  el.disablePictureInPicture = true;
  el.controls = false;
  el.preload = 'auto';
  stageEl.appendChild(el);
  const layer = { el, item: null, endedAt: null };
  el.addEventListener('ended', () => { layer.endedAt = performance.now(); });
  return layer;
}
const layers = [makeLayer(), makeLayer()];

let current = null; // { item, layerIdx, startedAt }
let prepared = null; // item já carregado na camada de trás
let swapping = false;
let refreshHook = null; // pede para reavaliar qual é o próximo vídeo
let wakeUp = null;

function setStandby(on) {
  standbyEl.hidden = !on;
}

// ---------- Menu de saída (tecla Esc) ----------
// Esc abre o menu; Esc de novo sai do GiroPlay. O menu vive dentro desta página, então nenhuma
// janela do Windows consegue ficar na frente dele, e o painel segue passando por trás.
const menuEl = document.getElementById('menu');
let menuTimer = null;
let menuOpenedAt = 0;

function showMenu() {
  if (menuEl.hidden) log('info', 'menu de saída aberto');
  menuEl.hidden = false;
  document.body.classList.add('menu-open');
  menuOpenedAt = Date.now();
  clearTimeout(menuTimer);
  menuTimer = setTimeout(hideMenu, 15000);
}

function hideMenu() {
  menuEl.hidden = true;
  document.body.classList.remove('menu-open');
  clearTimeout(menuTimer);
}

function menuAction(name) {
  if (name === 'quit') api.quit();
  else if (name === 'settings') { hideMenu(); api.openSettings(); }
  else if (name === 'stop') api.stop();
  else hideMenu();
}

window.addEventListener('keydown', (event) => {
  if (event.repeat) return; // segurar a tecla não pode contar como "Esc de novo"
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === 'Escape') {
    event.preventDefault();
    if (menuEl.hidden) showMenu();
    else if (Date.now() - menuOpenedAt > 150) menuAction('quit');
    return;
  }
  if (menuEl.hidden) return;
  if (key === 'Enter' || key === ' ') menuAction('back');
  else if (key === 'c') menuAction('settings');
  else if (key === 'p') menuAction('stop');
});

menuEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-menu]');
  if (button) menuAction(button.dataset.menu);
});

function mediaErrorText(el) {
  return el.error ? `erro de mídia ${el.error.code}${el.error.message ? `: ${el.error.message}` : ''}` : 'erro de mídia';
}

function waitForEvent(el, okEvent, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener(okEvent, onOk);
      el.removeEventListener('error', onError);
    };
    const onOk = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error(mediaErrorText(el))); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('tempo esgotado ao carregar')); }, timeoutMs);
    el.addEventListener(okEvent, onOk);
    el.addEventListener('error', onError);
  });
}

// Resolve quando um quadro novo é de fato apresentado (ou null se passar do tempo)
function firstFrame(el, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    el.requestVideoFrameCallback((now, meta) => finish({ now, meta }));
    setTimeout(() => finish(null), timeoutMs);
  });
}

function release(layer) {
  const el = layer.el;
  el.pause();
  el.removeAttribute('src');
  el.load();
  layer.item = null;
  layer.endedAt = null;
}

// A camada que vai receber o próximo vídeo fica por cima de todas, quase transparente.
let zTop = 1;
function markBack(layer) {
  layer.el.style.zIndex = String(++zTop);
  layer.el.classList.add('back');
}

async function load(layer, item) {
  const el = layer.el;
  markBack(layer);
  el.pause();
  layer.item = item;
  layer.endedAt = null;
  el.src = item.url;
  el.load();
  await waitForEvent(el, 'loadeddata', 20000);
}

// Carrega na camada o vídeo que vem depois de afterId. Se algum não abrir, avisa o main (que o
// tira do ciclo) e tenta o seguinte.
async function prepare(afterId, layer) {
  let after = afterId;
  for (let attempt = 0; attempt < 20; attempt++) {
    const item = await api.next(after);
    if (!item) return null;
    try {
      await load(layer, item);
      return item;
    } catch (err) {
      log('error', `não consegui carregar ${item.name}: ${err.message}`);
      api.error(item.id, err.message);
      release(layer);
      after = item.id;
      await sleep(200);
    }
  }
  return null;
}

async function refreshPrepared(cur, back) {
  const wanted = await api.next(cur.item.id);
  if (!wanted) {
    prepared = null;
    release(back);
    return;
  }
  if (prepared && prepared.id === wanted.id && back.item && back.item.id === wanted.id) return;
  prepared = null;
  prepared = await prepare(cur.item.id, back);
  api.inUse(prepared ? [cur.item.id, prepared.id] : [cur.item.id]);
}

// Resolve perto do fim do vídeo atual ('near-end'), quando ele terminar ('ended') ou se travar ('stalled').
function waitEnd(cur) {
  const el = layers[cur.layerIdx].el;
  return new Promise((resolve) => {
    let finished = false;
    let raf = 0;
    let lastTime = el.currentTime;
    let lastMove = performance.now();
    const done = (why) => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      clearInterval(watchdog);
      el.removeEventListener('ended', onEnded);
      resolve(why);
    };
    const onEnded = () => done('ended');
    el.addEventListener('ended', onEnded);
    const tick = () => {
      if (finished) return;
      const remaining = el.duration - el.currentTime;
      if (Number.isFinite(remaining) && remaining <= lead) return done('near-end');
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Vigia: se a imagem parar de andar por 6 s, pula para o próximo em vez de congelar o painel.
    const watchdog = setInterval(() => {
      if (el.currentTime !== lastTime) {
        lastTime = el.currentTime;
        lastMove = performance.now();
        return;
      }
      if (el.paused && !el.ended) el.play().catch(() => {});
      if (!el.ended && performance.now() - lastMove > 6000) {
        log('error', `vídeo travado, pulando: ${cur.item.name}`);
        done('stalled');
      }
    }, 1000);
  });
}

function reportPlayed(cur, completed, reason) {
  api.played({ id: cur.item.id, name: cur.item.name, startedAt: cur.startedAt, endedAt: Date.now(), completed, reason });
}

async function startFirst(item) {
  const layer = layers[0];
  const frame = firstFrame(layer.el);
  try {
    await layer.el.play();
  } catch (err) {
    api.error(item.id, err.message);
    throw err;
  }
  await frame;
  layer.el.classList.remove('back');
  current = { item, layerIdx: 0, startedAt: Date.now() };
  api.started({ id: item.id, name: item.name, at: current.startedAt });
}

async function swapTo(next, cur, why) {
  const back = layers[1 - cur.layerIdx];
  const old = layers[cur.layerIdx];
  const t0 = performance.now();
  const frame = firstFrame(back.el);
  try {
    await back.el.play();
  } catch (err) {
    api.error(next.id, err.message);
    throw err;
  }
  const shown = await frame;
  const tSwap = performance.now();
  back.el.classList.remove('back'); // o próximo já estava por cima: só sobe a opacidade

  const startLatency = shown ? shown.now - t0 : tSwap - t0;
  // earlyMs: quanto do fim do vídeo anterior foi sobreposto (cortado). frozenMs: quanto ele ficou
  // congelado no último quadro esperando o próximo aparecer.
  const earlyMs = old.el.ended ? 0 : Math.max(0, (old.el.duration - old.el.currentTime) * 1000);
  const frozenMs = old.endedAt ? Math.max(0, tSwap - old.endedAt) : 0;
  stats.push({
    t: Date.now(), from: cur.item.name, to: next.name, why,
    latencyMs: Math.round(startLatency), earlyMs: Math.round(earlyMs), frozenMs: Math.round(frozenMs), noFrame: !shown,
  });
  if (stats.length > MAX_STATS) stats.shift();
  if (shown) {
    latencyMs = latencyMs * 0.7 + startLatency * 0.3;
    lead = Math.min(0.3, Math.max(0.02, latencyMs / 1000));
  }

  reportPlayed(cur, true, why);
  current = { item: next, layerIdx: 1 - cur.layerIdx, startedAt: Date.now() };
  api.started({ id: next.id, name: next.name, at: current.startedAt });
  await nextPaint();
  release(old);
}

async function finishCurrent(cur) {
  const el = layers[cur.layerIdx].el;
  if (!el.ended) {
    const ended = new Promise((resolve) => el.addEventListener('ended', resolve, { once: true }));
    await Promise.race([ended, sleep(Math.max(0, el.duration - el.currentTime) * 1000 + 2000)]);
  }
  reportPlayed(cur, true, 'fim do ciclo vazio');
}

async function playUntilEmpty() {
  for (;;) {
    const cur = current;
    const back = layers[1 - cur.layerIdx];
    api.inUse([cur.item.id]);
    prepared = null;
    swapping = false;

    const chain = { p: Promise.resolve() };
    refreshHook = () => {
      chain.p = chain.p.then(() => refreshPrepared(cur, back)).catch((err) => log('error', `preparar próximo: ${err.message}`));
      return chain.p;
    };
    refreshHook();

    const why = await waitEnd(cur);
    swapping = true; // daqui em diante a escolha do próximo está travada
    await chain.p;
    refreshHook = null;

    if (!prepared) {
      await finishCurrent(cur);
      current = null;
      return;
    }
    const next = prepared;
    try {
      await swapTo(next, cur, why);
    } catch (err) {
      log('error', `falha ao trocar para ${next.name}: ${err.message}`);
      release(back);
      prepared = null;
      await sleep(200);
    }
  }
}

function playlistWait(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { wakeUp = null; resolve(); }, ms);
    wakeUp = () => { clearTimeout(timer); wakeUp = null; resolve(); };
  });
}

function applyConfig(cfg) {
  document.body.dataset.fit = cfg.fit || 'contain';
  for (const layer of layers) layer.el.muted = !cfg.audio;
}

async function main() {
  api.onPlaylistChanged(() => {
    if (wakeUp) wakeUp();
    if (refreshHook && !swapping) refreshHook();
  });
  api.onConfigChanged(applyConfig);
  api.onMenu(showMenu);
  applyConfig(await api.config());
  log('info', 'player iniciado');

  for (;;) {
    try {
      current = null;
      prepared = null;
      for (const layer of layers) {
        markBack(layer);
        release(layer);
      }
      const first = await prepare(null, layers[0]);
      if (!first) {
        setStandby(true);
        await playlistWait(3000);
        continue;
      }
      await startFirst(first);
      setStandby(false);
      await playUntilEmpty();
      setStandby(true);
    } catch (err) {
      log('error', `laço do player: ${err.stack || err.message}`);
      await sleep(1000);
    }
  }
}

window.addEventListener('error', (e) => log('error', `erro na página: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => log('error', `promessa rejeitada: ${e.reason && e.reason.message}`));
main();
