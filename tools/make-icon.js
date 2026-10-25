'use strict';
// Gera o ícone do app (círculo degradê com a letra G) em src/assets/icon.png e build/icon.ico.
// Uso: node tools/make-icon.js
const fs = require('node:fs');
const path = require('node:path');
const { run, Media } = require('../src/main/media');
const { DEFAULTS } = require('../src/main/config');

const root = path.join(__dirname, '..');
const png = path.join(root, 'src', 'assets', 'icon.png');
const ico = path.join(root, 'build', 'icon.ico');
const font = 'C\\:/Windows/Fonts/arialbd.ttf';

(async () => {
  fs.mkdirSync(path.dirname(png), { recursive: true });
  fs.mkdirSync(path.dirname(ico), { recursive: true });
  const ffmpeg = new Media(() => DEFAULTS).ffmpeg;
  const filter = [
    `drawtext=fontfile='${font}':text='G':fontsize=190:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-10`,
    'format=rgba',
    "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-128,Y-128),124),255,0)'",
  ].join(',');
  let r = await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'gradients=s=256x256:c0=0x7c5cff:c1=0x22d3ee:x0=0:y0=0:x1=256:y1=256:duration=1:rate=1',
    '-vf', filter, '-frames:v', '1', png]);
  if (r.code !== 0) throw new Error(r.stderr);
  r = await run(ffmpeg, ['-y', '-v', 'error', '-i', png, '-vf', 'scale=256:256', ico]);
  if (r.code !== 0) throw new Error(r.stderr);
  console.log(`ok: ${png} (${fs.statSync(png).size} B), ${ico} (${fs.statSync(ico).size} B)`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
