'use strict';
const { EventEmitter } = require('node:events');
const { readJson, atomicWriteJson } = require('./util');

const DEFAULTS = Object.freeze({
  watchFolder: '', // pasta sincronizada com o Google Drive
  libraryFolder: '', // vazio = <dados do app>/biblioteca
  displayId: null, // null = segunda tela se existir, senão a principal
  fit: 'contain', // contain (sem cortar), cover (preenche cortando), fill (estica)
  audio: false,

  // Limites para decidir se o vídeo toca como está ou é convertido (normalize = auto)
  maxWidth: 1920,
  maxHeight: 1080,
  maxFps: 60,
  maxBitrateMbps: 40,
  normalize: 'auto', // auto | always | never

  // Porteiro
  scanIntervalSec: 5,
  stableSeconds: 10, // arquivo precisa ficar sem mudar por este tempo antes de ser processado
  missingGraceSec: 30, // apagou da pasta: espera isto antes de tirar do ciclo
  wipeGuardSec: 600, // se TODOS sumirem de uma vez (Drive desmontou?), espera isto
  probeAttempts: 3,
  probeRetrySec: 20,
  ioAttempts: 6,
  ioRetrySec: 15,

  launchAtLogin: false,
  guardian: true, // reabre o app sozinho se o processo morrer ou travar
  statusToDrive: true, // grava STATUS.txt dentro da pasta do Drive
  ffmpegPath: '',
  ffprobePath: '',
});

const ENUMS = { fit: ['contain', 'cover', 'fill'], normalize: ['auto', 'always', 'never'] };
const MIN = {
  maxWidth: 160, maxHeight: 90, maxFps: 10, maxBitrateMbps: 1, scanIntervalSec: 0.2, stableSeconds: 0,
  missingGraceSec: 0, wipeGuardSec: 0, probeAttempts: 1, probeRetrySec: 0, ioAttempts: 1, ioRetrySec: 0,
};

function sanitize(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULTS)) continue;
    const def = DEFAULTS[key];
    if (ENUMS[key]) {
      if (ENUMS[key].includes(value)) out[key] = value;
    } else if (typeof def === 'boolean') {
      out[key] = Boolean(value);
    } else if (typeof def === 'number') {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = Math.max(MIN[key] ?? 0, n);
    } else if (key === 'displayId') {
      out[key] = value === null || value === '' ? null : Number(value);
    } else if (typeof def === 'string') {
      out[key] = String(value ?? '').trim();
    }
  }
  return out;
}

class Config extends EventEmitter {
  // overrides: valores só desta execução (linha de comando); nunca vão para o arquivo
  constructor(file, overrides = {}) {
    super();
    this.file = file;
    this.overrides = sanitize(overrides);
    const saved = readJson(file, null);
    this.existed = saved !== null;
    this.saved = sanitize(saved || {});
  }

  get() {
    return { ...DEFAULTS, ...this.saved, ...this.overrides };
  }

  update(patch) {
    const clean = sanitize(patch);
    this.saved = { ...this.saved, ...clean };
    atomicWriteJson(this.file, this.saved);
    this.existed = true;
    this.emit('changed', this.get(), Object.keys(clean));
    return this.get();
  }
}

module.exports = { Config, DEFAULTS, sanitize };
