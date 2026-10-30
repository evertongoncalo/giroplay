'use strict';
const api = window.giroSettings;
const $ = (id) => document.getElementById(id);

let formReady = false;
let playing = false;

function fmt(sec) {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return m ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
}

function setPill(text, kind) {
  $('pill').textContent = text;
  $('pill').className = `pill ${kind}`;
}

function fillForm(state) {
  const c = state.config;
  $('folder').value = c.watchFolder || '';
  $('fit').value = c.fit;
  $('autoStart').checked = c.autoStart;
  $('login').checked = c.launchAtLogin;
  $('login').disabled = !state.packaged;
  $('loginNote').textContent = state.packaged ? '' : '(só no app instalado)';
  $('statusDrive').checked = c.statusToDrive;

  const select = $('display');
  select.replaceChildren();
  select.add(new Option('Automático (usa a segunda tela, se houver)', ''));
  state.displays.forEach((d, i) => {
    select.add(new Option(`Tela ${i + 1} · ${d.width}×${d.height}${d.primary ? ' (principal)' : ''}`, String(d.id)));
  });
  select.value = c.displayId === null ? '' : String(c.displayId);
  formReady = true;
}

function collect() {
  return {
    watchFolder: $('folder').value,
    displayId: $('display').value === '' ? null : Number($('display').value),
    fit: $('fit').value,
    autoStart: $('autoStart').checked,
    launchAtLogin: $('login').checked,
    statusToDrive: $('statusDrive').checked,
  };
}

function render(state) {
  playing = state.playing;
  $('welcome').hidden = !state.firstRun;
  const ing = state.ingest;
  const hasFolder = Boolean($('folder').value);

  if (!hasFolder) setPill('Sem pasta', 'warn');
  else if (ing.folderOk === false) setPill('Pasta inacessível', 'bad');
  else if (!playing) setPill('Parado', 'idle');
  else if (state.nowPlaying) setPill('No ar', 'ok');
  else setPill('Aguardando vídeos', 'warn');

  $('play').hidden = playing;
  $('stop').hidden = !playing;
  $('play').disabled = !hasFolder;
  $('playHint').textContent = playing
    ? 'O painel está no ar em tela cheia. Para sair dele: tecla Esc (aperte duas vezes).'
    : hasFolder
      ? 'O painel abre em tela cheia. Para sair dele: tecla Esc (aperte duas vezes).'
      : 'Escolha primeiro a pasta de vídeos para poder iniciar.';

  $('now').textContent = state.nowPlaying ? state.nowPlaying.name : playing ? 'Nada tocando' : 'Painel parado';
  $('cycle').textContent = state.playlist.length
    ? `${state.playlist.length} vídeo(s) no ciclo · ${fmt(state.totalSeconds)} para dar uma volta completa`
    : 'Nenhum vídeo pronto ainda';

  const list = $('playlist');
  list.replaceChildren();
  for (const v of state.playlist) {
    const li = document.createElement('li');
    li.textContent = v.name;
    const small = document.createElement('small');
    small.textContent = ` · ${fmt(v.duration)} · ${v.width}×${v.height}${v.via === 'transcode' ? ' · convertido' : ''}`;
    li.append(small);
    if (state.nowPlaying && state.nowPlaying.name === v.name) li.className = 'now';
    list.append(li);
  }

  const p = ing.processing;
  let text = 'Nada sendo processado';
  if (ing.folderOk === false) text = 'A pasta do Drive não está acessível agora. O painel segue tocando o que já tem.';
  else if (ing.paused) text = `Pausado: ${ing.paused}`;
  else if (p) text = `${p.name}: ${p.stage}${p.stage === 'verificando' ? '' : ` ${Math.round(p.pct * 100)}%`}`;
  $('ingest').textContent = text;
  $('barWrap').hidden = !p || p.stage === 'verificando';
  $('bar').style.width = p ? `${Math.round(p.pct * 100)}%` : '0';

  const waiting = [...ing.queued.map((n) => `${n} (na fila)`), ...ing.waiting.map((n) => `${n} (esperando terminar de chegar)`)];
  $('waiting').textContent = waiting.join(' · ');

  const rejected = $('rejected');
  rejected.replaceChildren();
  for (const r of ing.rejected) {
    const li = document.createElement('li');
    li.textContent = `Recusado: ${r.name}`;
    const small = document.createElement('small');
    small.textContent = r.reason;
    li.append(small);
    rejected.append(li);
  }

  $('footer').textContent = `GiroPlay ${state.version} · memória ${state.memoryMB ?? '?'} MB · cópia local: ${state.paths.library}`;
}

async function refresh() {
  try {
    const state = await api.get();
    if (!formReady) fillForm(state);
    render(state);
  } catch (err) {
    setPill('Erro', 'bad');
  }
}

function flash(text) {
  $('saved').textContent = text;
  setTimeout(() => { $('saved').textContent = ''; }, 3000);
}

$('pick').addEventListener('click', async () => {
  const folder = await api.pickFolder();
  if (folder) {
    $('folder').value = folder;
    refresh();
  }
});

$('save').addEventListener('click', async () => {
  await api.save(collect());
  flash('Salvo ✓');
  refresh();
});

$('play').addEventListener('click', async () => {
  $('play').disabled = true;
  const result = await api.play(collect());
  if (!result.ok) flash(result.error);
  refresh();
});

$('stop').addEventListener('click', async () => {
  await api.stop();
  refresh();
});

for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => api.action(button.dataset.action));
}

refresh();
setInterval(refresh, 1500);
