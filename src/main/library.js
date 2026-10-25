'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { readJson, atomicWriteJson } = require('./util');

// A biblioteca é a cópia LOCAL (já conferida) dos vídeos. O player só toca daqui, nunca direto
// da pasta do Drive. O manifest guarda a ordem do ciclo: cada vídeo ganha um número de
// sequência quando fica pronto, então vídeo novo sempre entra no fim.
//
// Status de uma entrada:
//   ready   - toca no ciclo
//   retired - saiu do ciclo (apagado/substituído); o arquivo some assim que ninguém o usa
//   bad     - o player não conseguiu tocar; fica fora do ciclo
class Library extends EventEmitter {
  constructor(dir, logger) {
    super();
    this.dir = dir;
    this.log = logger;
    this.file = path.join(dir, 'manifest.json');
    this.inUse = new Set();
    fs.mkdirSync(dir, { recursive: true });
    const saved = readJson(this.file, null);
    this.data = saved && saved.version === 1 ? saved : { version: 1, seq: 0, entries: {}, rejected: {} };
  }

  save() {
    atomicWriteJson(this.file, this.data);
  }

  all() {
    return Object.values(this.data.entries);
  }

  ready() {
    return this.all().filter((e) => e.status === 'ready').sort((a, b) => a.seq - b.seq);
  }

  readyBySource(key) {
    return this.ready().find((e) => e.key === key) || null;
  }

  // Já foi tratado? (pronto, recusado em definitivo ou quarentenado, sempre com a mesma assinatura)
  isHandled(key, sig) {
    const rejected = this.data.rejected[key];
    if (rejected && rejected.sig === sig) return true;
    return this.all().some((e) => e.key === key && e.sig === sig && (e.status === 'ready' || e.status === 'bad'));
  }

  addReady(rec) {
    const old = this.readyBySource(rec.key);
    // Versão nova de um arquivo com o mesmo nome herda a posição do antigo; o resto entra no fim.
    const seq = old ? old.seq : ++this.data.seq;
    if (old) {
      old.status = 'retired';
      old.retiredAt = Date.now();
    }
    this.data.entries[rec.id] = { ...rec, seq, status: 'ready', addedAt: Date.now(), missingSince: null };
    delete this.data.rejected[rec.key];
    this.save();
    this.emit('changed');
    return this.data.entries[rec.id];
  }

  reject(key, rel, sig, reason) {
    this.data.rejected[key] = { name: rel, sig, reason, at: Date.now() };
    this.save();
    this.emit('rejected', this.data.rejected[key]);
  }

  rejectedList() {
    return Object.values(this.data.rejected).sort((a, b) => b.at - a.at);
  }

  setMissing(id, when) {
    const entry = this.data.entries[id];
    if (!entry) return;
    entry.missingSince = when;
    this.save();
  }

  retire(id, why) {
    const entry = this.data.entries[id];
    if (!entry || entry.status !== 'ready') return;
    entry.status = 'retired';
    entry.retiredAt = Date.now();
    entry.reason = why;
    this.save();
    this.emit('changed');
  }

  // O player não conseguiu carregar/tocar este vídeo: tira do ciclo sem apagar o registro,
  // para o mesmo arquivo não ser reprocessado em loop.
  quarantine(id, reason) {
    const entry = this.data.entries[id];
    if (!entry || entry.status === 'bad') return;
    entry.status = 'bad';
    entry.reason = reason;
    this.save();
    this.log?.warn(`vídeo fora do ciclo: ${entry.sourceRel} (${reason})`);
    this.emit('changed');
  }

  // Próximo do ciclo depois de currentId. Usa a sequência, então funciona mesmo que o atual
  // já tenha saído da lista. Depois do último volta ao primeiro.
  next(currentId) {
    const list = this.ready();
    if (!list.length) return null;
    const current = currentId ? this.data.entries[currentId] : null;
    if (!current) return list[0];
    return list.find((e) => e.seq > current.seq) || list[0];
  }

  setInUse(ids) {
    this.inUse = new Set(ids);
  }

  filePath(entry) {
    return path.join(this.dir, entry.file);
  }

  totalSeconds() {
    return this.ready().reduce((sum, e) => sum + (e.duration || 0), 0);
  }

  // Apaga arquivos de entradas fora do ciclo que ninguém usa mais, e sobras de cópias interrompidas.
  cleanup() {
    let changed = false;
    for (const entry of this.all()) {
      if (entry.status === 'ready' || this.inUse.has(entry.id)) continue;
      if (entry.file) {
        try {
          fs.rmSync(this.filePath(entry), { force: true });
          entry.file = null;
          changed = true;
        } catch (err) {
          this.log?.warn(`não consegui apagar ${entry.file}: ${err.code || err.message}`);
          continue;
        }
      }
      if (entry.status === 'retired') {
        delete this.data.entries[entry.id];
        changed = true;
      }
    }
    if (changed) this.save();

    const keep = new Set(this.all().map((e) => e.file).filter(Boolean));
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === 'manifest.json' || name === 'manifest.json.tmp' || keep.has(name)) continue;
      const file = path.join(this.dir, name);
      try {
        const age = Date.now() - fs.statSync(file).mtimeMs;
        const limit = name.endsWith('.part.mp4') ? 6 * 3600e3 : 10 * 60e3;
        if (age > limit && (name.endsWith('.mp4') || name.endsWith('.part'))) fs.rmSync(file, { force: true });
      } catch {
        /* outro processo mexendo: tenta na próxima */
      }
    }
  }
}

module.exports = { Library };
