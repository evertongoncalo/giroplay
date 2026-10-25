'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stamp, monthKey, atomicWriteJson, fmtDuration } = require('./util');

const REMOTE_EVERY_MS = 60e3;
const LOCAL_EVERY_MS = 5e3;
const CSV_COPY_EVERY_MS = 5 * 60e3;

// Comprovante de veiculação: uma linha por exibição, em CSV que o Excel abre direto.
class PlayLog {
  constructor(dir) {
    this.dir = dir;
    this.dirty = false;
    fs.mkdirSync(dir, { recursive: true });
  }

  fileFor(date = new Date()) {
    return path.join(this.dir, `exibicoes-${monthKey(date)}.csv`);
  }

  record({ startedAt, endedAt, name, completed, reason }) {
    const file = this.fileFor(new Date(startedAt));
    if (!fs.existsSync(file)) fs.writeFileSync(file, '﻿inicio;fim;duracao_s;video;completo;motivo\r\n');
    const seconds = (Math.max(0, endedAt - startedAt) / 1000).toFixed(1).replace('.', ',');
    const quoted = `"${String(name).replace(/"/g, '""')}"`;
    fs.appendFileSync(file, `${stamp(new Date(startedAt))};${stamp(new Date(endedAt))};${seconds};${quoted};${completed ? 'sim' : 'nao'};${reason || ''}\r\n`);
    this.dirty = true;
  }
}

// Mostra que o painel está vivo sem precisar ir até ele: grava STATUS.txt e status.json na
// pasta _giroplay dentro da pasta do Drive. Abre direto no app do Drive do celular.
class StatusReporter {
  constructor({ dataDir, getConfig, library, ingest, playLog, logger, version, getMetrics }) {
    Object.assign(this, { dataDir, getConfig, lib: library, ingest, playLog, log: logger, version, getMetrics });
    this.startedAt = Date.now();
    this.current = null;
    this.timers = [];
    this.remoteWarned = false;
    this.lastCsvCopy = 0;
  }

  setCurrent(info) {
    this.current = info;
  }

  async snapshot() {
    const ready = this.lib.ready();
    const free = await freeGb(this.lib.dir);
    return {
      app: 'GiroPlay',
      versao: this.version,
      computador: os.hostname(),
      atualizadoEm: stamp(),
      abertoDesde: stamp(new Date(this.startedAt)),
      tocandoAgora: this.current ? { video: this.current.name, desde: stamp(new Date(this.current.at)) } : null,
      ciclo: {
        videos: ready.length,
        duracaoTotalSeg: Math.round(this.lib.totalSeconds()),
        lista: ready.map((e) => ({ nome: e.sourceRel, duracaoSeg: Math.round(e.duration), entrouEm: stamp(new Date(e.addedAt)) })),
      },
      porteiro: this.ingest.getState(),
      memoriaMB: this.getMetrics ? this.getMetrics() : null,
      discoLivreGB: free,
    };
  }

  text(s) {
    const lines = [];
    lines.push('GiroPlay · painel no ar', `Atualizado em ${s.atualizadoEm} (a cada 1 minuto)`, '');
    lines.push('TOCANDO AGORA');
    lines.push(s.tocandoAgora ? `  ${s.tocandoAgora.video} (desde ${s.tocandoAgora.desde.slice(11)})` : '  nada (aguardando vídeos)');
    lines.push('', `CICLO · ${s.ciclo.videos} vídeo(s), ${fmtDuration(s.ciclo.duracaoTotalSeg)} no total`);
    s.ciclo.lista.forEach((v, i) => lines.push(`  ${i + 1}. ${v.nome} · ${fmtDuration(v.duracaoSeg)}`));
    const p = s.porteiro;
    lines.push('', 'ENTRADA DE VÍDEOS');
    if (p.folderOk === false) lines.push('  ATENÇÃO: a pasta do Drive está inacessível neste momento');
    if (p.paused) lines.push(`  ATENÇÃO: ${p.paused}`);
    lines.push(p.processing ? `  Processando: ${p.processing.name} (${p.processing.stage}, ${Math.round(p.processing.pct * 100)}%)` : '  Nada sendo processado');
    if (p.queued.length) lines.push(`  Na fila: ${p.queued.join(', ')}`);
    if (p.waiting.length) lines.push(`  Esperando terminar de chegar: ${p.waiting.join(', ')}`);
    if (p.rejected.length) {
      lines.push(`  Recusados (${p.rejected.length}):`);
      p.rejected.forEach((r) => lines.push(`    - ${r.name}: ${r.reason}`));
    }
    lines.push('', `${s.computador} · GiroPlay ${s.versao} · aberto desde ${s.abertoDesde}`);
    if (s.discoLivreGB !== null) lines.push(`Disco livre: ${s.discoLivreGB} GB`);
    return `${lines.join('\r\n')}\r\n`;
  }

  async writeLocal() {
    try {
      atomicWriteJson(path.join(this.dataDir, 'status.json'), await this.snapshot());
    } catch (err) {
      this.log.warn(`status local: ${err.message}`);
    }
  }

  async writeRemote(force = false) {
    const cfg = this.getConfig();
    if (!cfg.statusToDrive || !cfg.watchFolder || this.ingest.getState().folderOk !== true) return;
    const dir = path.join(cfg.watchFolder, '_giroplay');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const snap = await this.snapshot();
      fs.writeFileSync(path.join(dir, 'STATUS.txt'), this.text(snap));
      fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(snap, null, 2));
      if (this.playLog.dirty && (force || Date.now() - this.lastCsvCopy > CSV_COPY_EVERY_MS)) {
        const csv = this.playLog.fileFor();
        if (fs.existsSync(csv)) fs.copyFileSync(csv, path.join(dir, path.basename(csv)));
        this.lastCsvCopy = Date.now();
        this.playLog.dirty = false;
      }
      this.remoteWarned = false;
    } catch (err) {
      if (!this.remoteWarned) this.log.warn(`não consegui escrever o status na pasta do Drive: ${err.message}`);
      this.remoteWarned = true;
    }
  }

  start() {
    this.writeLocal();
    this.timers.push(setInterval(() => this.writeLocal(), LOCAL_EVERY_MS));
    this.timers.push(setInterval(() => this.writeRemote(), REMOTE_EVERY_MS));
    setTimeout(() => this.writeRemote(), 8000);
  }

  async stop() {
    this.timers.forEach(clearInterval);
    await this.writeRemote(true);
  }
}

async function freeGb(dir) {
  try {
    const s = await fs.promises.statfs(dir);
    return Math.round((Number(s.bavail) * Number(s.bsize)) / 1e8) / 10;
  } catch {
    return null;
  }
}

module.exports = { PlayLog, StatusReporter };
