'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { stamp, dayKey } = require('./util');

const KEEP_DAYS = 14;

class Logger {
  constructor(dir, { echo = false } = {}) {
    this.dir = dir;
    this.echo = echo;
    fs.mkdirSync(dir, { recursive: true });
    this.prune();
  }

  write(level, message, extra) {
    let line = `${stamp()} ${level.padEnd(5)} ${message}`;
    if (extra !== undefined) line += ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
    try {
      fs.appendFileSync(path.join(this.dir, `giroplay-${dayKey()}.log`), `${line}\n`);
    } catch {
      /* log nunca derruba o player */
    }
    if (this.echo) console.log(line);
  }

  info(message, extra) { this.write('INFO', message, extra); }
  warn(message, extra) { this.write('WARN', message, extra); }
  error(message, extra) { this.write('ERROR', message, extra); }

  prune() {
    const limit = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        const file = path.join(this.dir, name);
        if (name.endsWith('.log') && fs.statSync(file).mtimeMs < limit) fs.rmSync(file, { force: true });
      }
    } catch {
      /* ignora */
    }
  }
}

module.exports = { Logger };
