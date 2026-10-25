'use strict';
// Tira uma foto da janela de configurações (com um ciclo de vídeos de verdade) para conferir o visual.
//   node tools/shot-settings.js [saida.png]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run, Media } = require('../src/main/media');
const { DEFAULTS } = require('../src/main/config');

const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'giroplay-configuracoes.png'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'giroplay-foto-'));
const drive = path.join(work, 'drive');
const ffmpeg = new Media(() => DEFAULTS).ffmpeg;

(async () => {
  fs.mkdirSync(drive, { recursive: true });
  const clips = [['01_promocao.mp4', 'testsrc2=size=1280x720:rate=30:duration=20'], ['02_oferta.mp4', 'testsrc2=size=1920x1080:rate=30:duration=34'], ['03_marca.webm', 'testsrc2=size=1280x720:rate=30:duration=12']];
  for (const [name, src] of clips) {
    const codec = name.endsWith('.webm') ? ['-c:v', 'libvpx-vp9', '-b:v', '400k'] : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
    await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', src, ...codec, path.join(drive, name)], { timeoutMs: 120000 });
  }
  const child = spawn(require('electron'), [path.join(__dirname, '..'), `--giro-data=${path.join(work, 'dados')}`, `--watch=${drive}`,
    '--windowed=480x270+700+40', '--no-guardian', `--settings-shot=${out}`, '--cfg=stableSeconds=1', '--cfg=scanIntervalSec=0.5', '--cfg=statusToDrive=false'], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  console.log(fs.existsSync(out) ? `foto: ${out} (${fs.statSync(out).size} B)` : 'a foto não foi gerada');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
