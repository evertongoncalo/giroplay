'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pipeline } = require('node:stream/promises');
const { MediaError } = require('./media');
const { naturalCompare, safeName, shortId, sleep } = require('./util');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.avi', '.webm', '.wmv', '.mpg', '.mpeg', '.mts', '.m2ts', '.flv', '.3gp']);
const IGNORED_DIRS = new Set(['_giroplay', '$recycle.bin', 'system volume information']);
// Erros de leitura/disco que costumam passar sozinhos (Drive ainda baixando, antivírus, rede)
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'EIO', 'EMFILE', 'ETIMEDOUT', 'EAGAIN', 'UNKNOWN', 'ENETUNREACH', 'ENOTCONN']);

class ChangedError extends Error {}

// O "porteiro": só deixa entrar no ciclo vídeo que chegou inteiro e abre de verdade.
//
//   pasta do Drive --varredura--> espera ficar estável --> ffprobe --> copia/converte --> confere --> biblioteca
//
// Nunca mexe nos arquivos da pasta do Drive (só lê). Falhas ficam registradas, não apagam nada.
class Ingest extends EventEmitter {
  constructor({ getConfig, library, media, logger }) {
    super();
    this.getConfig = getConfig;
    this.lib = library;
    this.media = media;
    this.log = logger;
    this.seen = new Map(); // key -> { sig, since }   desde quando o arquivo está sem mudar
    this.retry = new Map(); // key -> { sig, attempts, nextAt }
    this.queue = [];
    this.working = false;
    this.cur = null;
    this.stopped = true;
    this.wake = null;
    this.walkErrors = 0;
    this.info = { folderOk: null, lastScanAt: null, paused: null, waiting: [] };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop();
  }

  stop() {
    this.stopped = true;
    if (this.wake) this.wake();
  }

  rescan() {
    if (this.wake) this.wake();
  }

  async loop() {
    while (!this.stopped) {
      try {
        await this.scan();
      } catch (err) {
        this.log.error(`erro na varredura: ${err.stack || err.message}`);
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(200, this.getConfig().scanIntervalSec * 1000));
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
      this.wake = null;
    }
  }

  async walk(dir, root, depth, out) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0) throw err;
      this.walkErrors++;
      return out;
    }
    for (const ent of entries) {
      const name = ent.name;
      if (name.startsWith('.') || name.startsWith('~$')) continue;
      const full = path.join(dir, name);
      if (ent.isDirectory()) {
        if (depth < 4 && !IGNORED_DIRS.has(name.toLowerCase())) await this.walk(full, root, depth + 1, out);
        continue;
      }
      if (!ent.isFile() || !VIDEO_EXT.has(path.extname(name).toLowerCase())) continue;
      let st;
      try {
        st = await fs.promises.stat(full);
      } catch {
        continue;
      }
      if (st.size === 0) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      out.push({ key: rel.toLowerCase(), rel, full, size: st.size, sig: `${st.size}-${Math.floor(st.mtimeMs)}` });
    }
    return out;
  }

  async scan() {
    const cfg = this.getConfig();
    const root = cfg.watchFolder;
    if (!root) {
      this.info.folderOk = null;
      return;
    }
    this.walkErrors = 0;
    let files;
    try {
      files = await this.walk(root, root, 0, []);
    } catch (err) {
      // Pasta sumiu (Drive desconectado, disco desmontado): NÃO conclui que os vídeos foram apagados.
      if (this.info.folderOk !== false) this.log.warn(`pasta inacessível: ${root} (${err.code || err.message})`);
      this.info.folderOk = false;
      return;
    }
    if (this.info.folderOk === false) this.log.info('pasta voltou a ficar acessível');
    this.info.folderOk = true;
    const now = Date.now();
    this.info.lastScanAt = now;

    const present = new Set();
    for (const f of files) {
      present.add(f.key);
      const seen = this.seen.get(f.key);
      if (!seen || seen.sig !== f.sig) this.seen.set(f.key, { sig: f.sig, since: now });
    }
    for (const key of [...this.seen.keys()]) if (!present.has(key)) this.seen.delete(key);

    if (this.walkErrors === 0) this.handleMissing(present, now, cfg);

    const fresh = files.filter((f) => !this.lib.isHandled(f.key, f.sig));
    this.info.waiting = [];
    const ready = [];
    for (const f of fresh) {
      const stableFor = now - this.seen.get(f.key).since;
      const retry = this.retry.get(f.key);
      if (stableFor < cfg.stableSeconds * 1000) {
        this.info.waiting.push(f.rel);
      } else if (retry && retry.sig === f.sig && retry.nextAt > now) {
        this.info.waiting.push(f.rel);
      } else if (!(this.cur && this.cur.key === f.key && this.cur.sig === f.sig) && !this.queue.some((q) => q.key === f.key && q.sig === f.sig)) {
        ready.push(f);
      }
    }
    // Quem ficou estável primeiro entra primeiro; empate (primeira varredura) segue a ordem do nome.
    ready.sort((a, b) => (this.seen.get(a.key).since - this.seen.get(b.key).since) || naturalCompare(a.rel, b.rel));
    for (const f of ready) {
      this.queue = this.queue.filter((q) => q.key !== f.key);
      this.queue.push(f);
    }
    this.emit('state');
    this.pump();
  }

  handleMissing(present, now, cfg) {
    const ready = this.lib.ready();
    if (!ready.length) return;
    const missing = ready.filter((e) => !present.has(e.key));
    for (const e of ready) {
      if (present.has(e.key) && e.missingSince) this.lib.setMissing(e.id, null);
      else if (!present.has(e.key) && !e.missingSince) this.lib.setMissing(e.id, now);
    }
    // Sumiu tudo de uma vez? Provavelmente é o Drive remontando, não o dono apagando: espera mais.
    const graceMs = (missing.length === ready.length ? cfg.wipeGuardSec : cfg.missingGraceSec) * 1000;
    for (const e of missing) {
      const since = e.missingSince || now;
      if (now - since >= graceMs) {
        this.log.info(`removido da pasta, saindo do ciclo: ${e.sourceRel}`);
        this.lib.retire(e.id, 'removido da pasta');
      }
    }
  }

  async pump() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length && !this.stopped) {
        await this.processOne(this.queue.shift());
      }
    } finally {
      this.working = false;
    }
  }

  async processOne(c) {
    const cfg = this.getConfig();
    const id = shortId(`${c.key}|${c.sig}`);
    const base = `${safeName(path.basename(c.rel))}__${id}`;
    const tmp = path.join(this.lib.dir, `${base}.part.mp4`);
    const final = path.join(this.lib.dir, `${base}.mp4`);
    const started = Date.now();
    this.cur = { key: c.key, sig: c.sig, name: c.rel, stage: 'verificando', pct: 0 };
    this.emit('state');
    const progress = (stage, pct) => { this.cur = { ...this.cur, stage, pct }; };
    try {
      await this.checkDisk(c);
      await fs.promises.access(c.full, fs.constants.R_OK);
      const handle = await fs.promises.open(c.full, 'r'); // falha se o Drive ainda segura o arquivo
      await handle.close();

      const info = await this.media.probe(c.full);
      const verdict = this.media.compliance(info);
      let via = cfg.normalize === 'always' ? 'transcode' : cfg.normalize === 'never' ? 'copy' : verdict.ok ? 'copy' : 'transcode';
      if (via === 'transcode') this.log.info(`${c.rel}: precisa converter (${verdict.why.join(', ') || 'forçado'})`);

      if (via === 'copy') {
        await this.copy(c, tmp, (p) => progress('copiando', p));
        progress('conferindo', 0);
        const check = await this.media.verifyDecode(tmp, info.duration);
        if (!check.ok) {
          this.log.warn(`${c.rel}: erro ao decodificar (${check.message}); tentando converter`);
          fs.rmSync(tmp, { force: true });
          via = 'transcode';
        }
      }
      if (via === 'transcode') {
        progress('convertendo', 0);
        await this.media.transcode(c.full, tmp, info, (p) => progress('convertendo', p));
        await this.assertUnchanged(c);
      }

      const out = await this.media.probe(tmp);
      if (Math.abs(out.duration - info.duration) > Math.max(1, info.duration * 0.05)) {
        throw new MediaError(`duração não bate (${info.duration.toFixed(1)} s no original, ${out.duration.toFixed(1)} s na cópia)`);
      }
      fs.renameSync(tmp, final);
      this.lib.addReady({
        id, key: c.key, sourceRel: c.rel, sig: c.sig, name: path.basename(c.rel), file: path.basename(final),
        duration: out.duration, width: out.width, height: out.height, fps: Math.round(out.fps * 10) / 10, via,
      });
      this.retry.delete(c.key);
      this.log.info(`no ciclo: ${c.rel} (${via}, ${out.duration.toFixed(1)} s, ${out.width}x${out.height}, levou ${((Date.now() - started) / 1000).toFixed(1)} s)`);
    } catch (err) {
      this.onFailure(c, err, cfg);
    } finally {
      fs.rmSync(tmp, { force: true });
      this.cur = null;
      this.emit('state');
    }
  }

  async checkDisk(c) {
    const free = await this.media.freeBytes(this.lib.dir);
    if (free < c.size * 2 + 500e6) {
      const err = new Error('pouco espaço em disco');
      err.code = 'ENOSPC';
      throw err;
    }
    this.info.paused = null;
  }

  async copy(c, dst, onPct) {
    const rs = fs.createReadStream(c.full, { highWaterMark: 4 * 1024 * 1024 });
    let done = 0;
    rs.on('data', (chunk) => { done += chunk.length; onPct(c.size ? done / c.size : 0); });
    await pipeline(rs, fs.createWriteStream(dst));
    await this.assertUnchanged(c);
  }

  async assertUnchanged(c) {
    const st = await fs.promises.stat(c.full);
    if (`${st.size}-${Math.floor(st.mtimeMs)}` !== c.sig) throw new ChangedError();
  }

  onFailure(c, err, cfg) {
    if (err instanceof ChangedError) {
      this.log.info(`${c.rel} mudou durante o processamento; recomeço quando estabilizar`);
      return;
    }
    if (err.code === 'ENOENT') {
      this.log.info(`${c.rel} sumiu durante o processamento`);
      return;
    }
    if (err.code === 'ENOSPC') {
      this.info.paused = 'pouco espaço em disco';
      this.log.error(`sem espaço em disco para processar ${c.rel}`);
      this.retry.set(c.key, { sig: c.sig, attempts: 0, nextAt: Date.now() + 5 * 60e3 });
      return;
    }
    const previous = this.retry.get(c.key);
    const attempts = (previous && previous.sig === c.sig ? previous.attempts : 0) + 1;
    const transient = TRANSIENT.has(err.code);
    const max = transient ? cfg.ioAttempts : cfg.probeAttempts;
    const reason = err.message || String(err);
    if (attempts >= max) {
      this.log.warn(`recusado: ${c.rel} (${reason})`);
      this.lib.reject(c.key, c.rel, c.sig, reason);
      this.retry.delete(c.key);
    } else {
      const waitSec = transient ? cfg.ioRetrySec * 2 ** (attempts - 1) : cfg.probeRetrySec;
      this.log.warn(`${c.rel}: ${reason} (tentativa ${attempts}/${max}, de novo em ${waitSec} s)`);
      this.retry.set(c.key, { sig: c.sig, attempts, nextAt: Date.now() + waitSec * 1000 });
    }
  }

  // Espera a fila esvaziar (usado nos testes)
  async idle(timeoutMs = 60000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (!this.working && !this.queue.length && this.info.lastScanAt && this.info.waiting.length === 0) return true;
      await sleep(100);
    }
    return false;
  }

  getState() {
    return {
      folderOk: this.info.folderOk,
      lastScanAt: this.info.lastScanAt,
      paused: this.info.paused,
      waiting: this.info.waiting.slice(0, 20),
      queued: this.queue.map((q) => q.rel),
      processing: this.cur ? { name: this.cur.name, stage: this.cur.stage, pct: this.cur.pct } : null,
      rejected: this.lib.rejectedList().slice(0, 20),
    };
  }
}

module.exports = { Ingest };
