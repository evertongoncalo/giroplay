'use strict';
// Testa o app EMPACOTADO (dist/win-unpacked), sem instalar nada no Windows: confirma que o ffmpeg/ffprobe
// embutidos funcionam, que um vídeo é copiado e outro convertido, que toca, e que o guardião sobe e
// encerra direito a partir de dentro do pacote.
//
//   npm run dist && node tools/test-packaged.js [caminho/GiroPlay.exe]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { run, Media } = require('../src/main/media');
const { DEFAULTS } = require('../src/main/config');

const exe = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'win-unpacked', 'GiroPlay.exe'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'giroplay-pacote-'));
const dados = path.join(work, 'dados');
const drive = path.join(work, 'drive');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ffmpeg = new Media(() => DEFAULTS).ffmpeg; // só para gerar os vídeos de teste
let failed = 0;

const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${name}${detail ? ` - ${detail}` : ''}`);
};

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
const appLog = () => { const d = path.join(dados, 'logs'); try { return fs.readdirSync(d).filter((f) => f.startsWith('giroplay-')).map((f) => read(path.join(d, f))).join('\n'); } catch { return ''; } };

function guardianCommandLine() {
  const k = dados.replace(/'/g, "''");
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$k='${k}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -ne 'powershell.exe' -and $_.CommandLine -and $_.CommandLine.Contains($k) -and $_.CommandLine.Contains('guardian.js') } | Select-Object -ExpandProperty CommandLine`],
  { encoding: 'utf8', windowsHide: true });
  return out.trim();
}

(async () => {
  if (!fs.existsSync(exe)) throw new Error(`não achei ${exe}; rode "npm run dist" antes`);
  fs.mkdirSync(drive, { recursive: true });
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(drive, 'direto.mp4')]);
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3', '-c:v', 'libvpx-vp9', '-b:v', '300k', path.join(drive, 'converter.webm')]);

  const child = spawn(exe, [`--giro-data=${dados}`, `--watch=${drive}`, '--windowed=480x270+700+40', '--exit-after=30',
    '--cfg=stableSeconds=1', '--cfg=scanIntervalSec=0.5', '--cfg=statusToDrive=false'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', resolve));

  const end = Date.now() + 25000;
  let guardianCmd = '';
  while (Date.now() < end) {
    if (!guardianCmd) guardianCmd = guardianCommandLine();
    const log = appLog();
    if ((log.match(/no ciclo:/g) || []).length >= 2 && (log.match(/tocando:/g) || []).length >= 3) break;
    await sleep(1000);
  }
  const log = appLog();
  check('os dois vídeos entraram no ciclo', (log.match(/no ciclo:/g) || []).length === 2);
  check('um copiado e outro convertido (ffmpeg/ffprobe embutidos funcionam)', /direto\.mp4 \(copy/.test(log) && /converter\.webm \(transcode/.test(log));
  check('o player tocou e trocou de vídeo', (log.match(/tocando:/g) || []).length >= 3, `${(log.match(/tocando:/g) || []).length} exibições`);
  check('guardião subiu a partir do pacote', /guardião ativo/.test(log) && guardianCmd.includes('guardian.js'), guardianCmd.includes('app.asar.unpacked') ? 'script lido de app.asar.unpacked' : 'caminho: ' + guardianCmd.slice(0, 160));
  check('sem erros no log', !/ERROR/.test(log), (log.match(/ERROR.*/g) || []).slice(0, 3).join(' | '));

  // O app encerra sozinho aos 30 s (como o menu "Sair": deixa quit.flag). Espera isso de verdade,
  // sem derrubar o processo à força, senão o guardião (corretamente) o reabre.
  await Promise.race([exited, sleep(60000)]);
  await sleep(6000);
  check('ao fechar de propósito o guardião encerra e não reabre',
    /fechado de propósito/.test(read(path.join(dados, 'logs', 'guardiao.log'))) && (appLog().match(/iniciando/g) || []).length === 1);

  console.log(failed ? `\n${failed} verificação(ões) falharam. Pasta: ${work}` : '\nApp empacotado: tudo certo.');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
