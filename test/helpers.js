'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, Media } = require('../src/main/media');
const { Library } = require('../src/main/library');
const { Ingest } = require('../src/main/ingest');
const { DEFAULTS } = require('../src/main/config');
const { sleep } = require('../src/main/util');

const media = new Media(() => DEFAULTS);

const silentLog = { info() {}, warn() {}, error() {} };

function tmpDir(prefix = 'giroplay-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Gera um vídeo de teste com o ffmpeg do projeto.
async function makeClip(file, { seconds = 2, size = '320x240', rate = 30, codec = 'libx264', pixFmt = 'yuv420p', extra = [] } = {}) {
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`,
    '-c:v', codec, '-pix_fmt', pixFmt, ...extra, file];
  const r = await run(media.ffmpeg, args, { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error(`ffmpeg falhou ao gerar ${file}: ${r.stderr}`);
  return file;
}

// Ambiente completo (pasta "do Drive", biblioteca, porteiro) com tempos curtos para o teste não demorar.
function makeEnv(overrides = {}) {
  const root = tmpDir();
  const watch = path.join(root, 'drive');
  const libDir = path.join(root, 'biblioteca');
  fs.mkdirSync(watch, { recursive: true });
  const cfg = {
    ...DEFAULTS, watchFolder: watch, scanIntervalSec: 0.2, stableSeconds: 1, missingGraceSec: 1, wipeGuardSec: 3600,
    probeAttempts: 2, probeRetrySec: 0.3, ioAttempts: 2, ioRetrySec: 0.3, ...overrides,
  };
  const getConfig = () => cfg;
  const library = new Library(libDir, silentLog);
  const ingest = new Ingest({ getConfig, library, media: new Media(getConfig), logger: silentLog });
  return {
    root, watch, libDir, cfg, library, ingest,
    cleanup() {
      ingest.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function waitFor(cond, timeoutMs = 30000, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(stepMs);
  }
  return false;
}

module.exports = { media, tmpDir, makeClip, makeEnv, waitFor, silentLog };
