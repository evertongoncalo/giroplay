'use strict';
// Medição de ponta a ponta do player. Abre o GiroPlay numa janela pequena, grava a tela com o
// ffmpeg (Desktop Duplication) e procura quadros pretos e congelamentos nas trocas de vídeo.
//
//   node tools/measure.js [--seconds=60] [--clips=4] [--clip-seconds=4] [--size=1920x1080] [--no-capture]
//   node tools/measure.js --soak --seconds=600      (sem gravação; acompanha memória durante a exibição)
//
// Os resultados saem no terminal e em <pasta de trabalho>/relatorio.json.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run, Media } = require('../src/main/media');
const { DEFAULTS } = require('../src/main/config');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const SOAK = Boolean(args.soak);
const SECONDS = Number(args.seconds || (SOAK ? 600 : 60));
const CLIPS = Number(args.clips || (SOAK ? 3 : 4));
const CLIP_SECONDS = Number(args['clip-seconds'] || (SOAK ? 2 : 4));
const SIZE = args.size || '1920x1080';
const CAPTURE = !SOAK && !args['no-capture'];
// --fullscreen: abre o player em tela cheia de verdade (como no painel) e grava o monitor inteiro.
// Cobre a tela por ~2 minutos; o app encerra sozinho no fim.
const FULL = Boolean(args.fullscreen);
const SCREEN = String(args.screen || '1920x1080').split('x').map(Number);
const WIN = FULL ? { w: SCREEN[0], h: SCREEN[1], x: 0, y: 0 } : { w: 640, h: 360, x: 40, y: 40 };

const ffmpeg = new Media(() => DEFAULTS).ffmpeg;
const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeClips(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < CLIPS; i++) {
    const file = path.join(dir, `clipe-${i + 1}.mp4`);
    const r = await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi',
      '-i', `testsrc2=size=${SIZE}:rate=30:duration=${CLIP_SECONDS},hue=h=${i * 75}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', file], { timeoutMs: 180000 });
    if (r.code !== 0) throw new Error(`falha ao gerar ${file}: ${r.stderr}`);
  }
}

function launchApp(work, exitAfter) {
  const electronExe = require('electron');
  const argv = [root, `--giro-data=${path.join(work, 'dados')}`, `--watch=${path.join(work, 'drive')}`,
    ...(FULL ? [] : [`--windowed=${WIN.w}x${WIN.h}+${WIN.x}+${WIN.y}`]), '--no-guardian', `--exit-after=${exitAfter}`,
    `--stats-out=${path.join(work, 'trocas.json')}`, `--mem-out=${path.join(work, 'memoria.jsonl')}`,
    '--cfg=stableSeconds=1', '--cfg=scanIntervalSec=0.5', '--cfg=statusToDrive=false'];
  const child = spawn(electronExe, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(path.join(work, 'app.out'));
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited };
}

function readLog(work) {
  const dir = path.join(work, 'dados', 'logs');
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith('giroplay-')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  } catch {
    return '';
  }
}

async function waitForPlaying(work, minPlays, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const plays = (readLog(work).match(/tocando:/g) || []).length;
    if (plays >= minPlays) return true;
    await sleep(500);
  }
  return false;
}

async function capture(seconds, work) {
  const input = `ddagrab=framerate=60:video_size=${WIN.w}x${WIN.h}:offset_x=${WIN.x}:offset_y=${WIN.y}:draw_mouse=0`;
  // A tela é gravada quase sem perda num arquivo; a análise roda depois, sem competir por CPU com o player.
  const file = path.join(work, 'captura.mkv');
  const startedAt = Date.now();
  const rec = await run(ffmpeg, ['-hide_banner', '-y', '-v', 'info', '-f', 'lavfi', '-i', input, '-t', String(seconds),
    '-vf', FULL ? 'hwdownload,format=bgra,scale=640:360:flags=fast_bilinear,format=yuv420p' : 'hwdownload,format=bgra,format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-an', file], { timeoutMs: (seconds + 60) * 1000 });
  const framesLine = [...rec.stderr.matchAll(/frame=\s*(\d+)/g)].pop();

  const an = await run(ffmpeg, ['-hide_banner', '-v', 'info', '-i', file, '-vf',
    'blackdetect=d=0.01:pix_th=0.12:pic_th=0.95,freezedetect=n=0.0008:d=0.25', '-an', '-f', 'null', '-'], { timeoutMs: 300000 });
  const black = [...an.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)].map((m) => ({ at: +m[1], seconds: +m[3] }));
  const freezeStarts = [...an.stderr.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => +m[1]);
  const freezeDur = [...an.stderr.matchAll(/freeze_duration: ([\d.]+)/g)].map((m) => +m[1]);

  // Para cada preto achado, salva os quadros de antes, durante e depois (para conferir a olho).
  for (const [i, b] of black.entries()) {
    b.quadros = [];
    for (const dt of [-0.1, -0.02, 0, 0.05, 0.12]) {
      const out = path.join(work, `preto${i + 1}_${dt >= 0 ? '+' : ''}${dt}.png`);
      const t = Math.max(0, b.at + dt);
      await run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', out]);
      b.quadros.push(out);
    }
  }
  return {
    exit: rec.code, startedAt, frames: framesLine ? +framesLine[1] : null, arquivo: file, black,
    freezes: freezeStarts.map((at, i) => ({ at, seconds: freezeDur[i] ?? null })), tail: rec.code === 0 ? '' : rec.stderr.slice(-600),
  };
}

const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);

function summarizeSwitches(file) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const lat = list.map((s) => s.latencyMs);
  const early = list.map((s) => s.earlyMs);
  const frozen = list.map((s) => s.frozenMs);
  return {
    trocas: list.length,
    semQuadro: list.filter((s) => s.noFrame).length,
    congeladoMsMax: Math.max(0, ...frozen),
    trocasComCongelamento: frozen.filter((f) => f > 0).length,
    sobreposicaoMs: { p50: pct(early, 0.5), p95: pct(early, 0.95), max: Math.max(0, ...early) },
    latenciaPlayAteImagemMs: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: Math.max(0, ...lat) },
    porMotivo: list.reduce((acc, s) => ({ ...acc, [s.why]: (acc[s.why] || 0) + 1 }), {}),
  };
}

function summarizeMemory(file) {
  let rows = [];
  try { rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return null; }
  if (rows.length < 2) return { amostras: rows.length };
  const hours = (rows.at(-1).t - rows[0].t) / 3.6e6;
  const pickMax = (key) => Math.max(...rows.map((r) => r[key] || 0));
  const settle = rows.slice(Math.floor(rows.length / 4)); // ignora o aquecimento inicial
  const slope = settle.length > 1 ? (settle.at(-1).total - settle[0].total) / Math.max(1e-9, (settle.at(-1).t - settle[0].t) / 3.6e6) : null;
  return {
    amostras: rows.length,
    minutos: Math.round(hours * 60),
    inicioMB: rows[0].total,
    fimMB: rows.at(-1).total,
    maxMB: pickMax('total'),
    maxPorTipoMB: { navegador: pickMax('Browser'), tela: pickMax('Tab'), gpu: pickMax('GPU') },
    crescimentoMBporHoraDepoisDoAquecimento: slope === null ? null : Math.round(slope * 10) / 10,
  };
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'giroplay-medir-'));
  console.log(`pasta de trabalho: ${work}`);
  console.log(`gerando ${CLIPS} clipes de ${CLIP_SECONDS} s (${SIZE})...`);
  await makeClips(path.join(work, 'drive'));

  const warmup = 25;
  const exitAfter = warmup + SECONDS + 15;
  console.log(`abrindo o GiroPlay (${SOAK ? 'modo soak' : 'modo medição'}, ${SECONDS} s)...`);
  const app = launchApp(work, exitAfter);
  const report = { config: { SECONDS, CLIPS, CLIP_SECONDS, SIZE, soak: SOAK, telaCheia: FULL } };
  // Rede de segurança: se algo travar, o app nunca fica cobrindo a tela além do limite.
  const safety = setTimeout(() => { try { app.child.kill(); } catch { /* já saiu */ } }, (exitAfter + 30) * 1000);
  app.exited.then(() => clearTimeout(safety));

  if (!(await waitForPlaying(work, 2, 90000))) {
    console.error('o player não começou a tocar em 90 s; veja', path.join(work, 'app.out'));
    app.child.kill();
    process.exit(2);
  }
  console.log('tocando; medindo...');

  if (CAPTURE) {
    await sleep(2000);
    try {
      report.captura = await capture(SECONDS, work);
    } catch (err) {
      app.child.kill();
      throw err;
    }
  } else {
    await sleep(SECONDS * 1000);
  }
  report.codigoSaidaApp = await app.exited;
  report.trocas = summarizeSwitches(path.join(work, 'trocas.json'));
  if (report.captura) {
    // Quando cada troca aconteceu em relação ao começo da gravação (precisão de ~0,5 s)
    const list = JSON.parse(fs.readFileSync(path.join(work, 'trocas.json'), 'utf8'));
    report.captura.trocasNaGravacao = list.map((s) => Math.round(((s.t - report.captura.startedAt) / 1000) * 10) / 10).filter((s) => s >= 0 && s <= SECONDS);
  }
  report.memoria = summarizeMemory(path.join(work, 'memoria.jsonl'));
  const log = readLog(work);
  report.erros = (log.match(/ERROR/g) || []).length;
  report.avisos = (log.match(/WARN/g) || []).length;

  fs.writeFileSync(path.join(work, 'relatorio.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`relatório: ${path.join(work, 'relatorio.json')}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
