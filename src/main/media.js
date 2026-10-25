'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Arquivo inválido (corrompido, incompleto, não é vídeo). Diferente de erro de leitura/disco,
// que é transitório e merece nova tentativa.
class MediaError extends Error {}

// Dentro do instalador os binários ficam em app.asar.unpacked
const unpacked = (p) => (p ? p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1') : p);

function resolveBinary(kind, override) {
  if (override && fs.existsSync(override)) return override;
  try {
    const mod = require(kind === 'ffmpeg' ? 'ffmpeg-static' : 'ffprobe-static');
    const p = unpacked(kind === 'ffmpeg' ? mod : mod.path);
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* cai para o PATH */
  }
  return kind;
}

function run(bin, args, { timeoutMs = 0, lowPriority = false, onLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, signal });
    let out = '';
    let err = '';
    let buf = '';
    let timedOut = false;
    let timer = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // Conversão e conferência rodam em segundo plano: não podem roubar CPU da reprodução.
    if (lowPriority && child.pid) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* ignora */ }
    }
    if (timeoutMs) {
      timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    }
    child.stdout.on('data', (chunk) => {
      if (onLine) {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
      } else if (out.length < 5e6) {
        out += chunk;
      }
    });
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-20000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err, timedOut }); });
  });
}

const lastLine = (text) => (text || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';

function parseRate(text) {
  const [a, b] = String(text || '').split('/').map(Number);
  if (!a || !b) return 0;
  return a / b;
}

class Media {
  constructor(getConfig) {
    this.getConfig = getConfig;
  }

  get ffmpeg() { return resolveBinary('ffmpeg', this.getConfig().ffmpegPath); }
  get ffprobe() { return resolveBinary('ffprobe', this.getConfig().ffprobePath); }

  async probe(file) {
    const r = await run(this.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60000 });
    if (r.timedOut) {
      const e = new Error('ffprobe demorou demais');
      e.code = 'ETIMEDOUT';
      throw e;
    }
    if (r.code !== 0) throw new MediaError(`não consegui ler o vídeo: ${lastLine(r.stderr) || `ffprobe código ${r.code}`}`);
    let json;
    try { json = JSON.parse(r.stdout); } catch { throw new MediaError('resposta inválida do ffprobe'); }

    const video = (json.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    if (!video) throw new MediaError('o arquivo não tem imagem de vídeo');
    const duration = parseFloat((json.format && json.format.duration) || video.duration);
    if (!Number.isFinite(duration) || duration < 0.2) throw new MediaError('duração inválida (arquivo incompleto?)');
    const width = Number(video.width);
    const height = Number(video.height);
    if (!width || !height) throw new MediaError('resolução inválida');

    const side = (video.side_data_list || []).find((d) => d.rotation !== undefined);
    const rotation = Math.abs(Number((side && side.rotation) || (video.tags && video.tags.rotate) || 0)) % 360;
    const bitRate = Number((json.format && json.format.bit_rate) || video.bit_rate || 0);
    return {
      container: (json.format && json.format.format_name) || '',
      codec: video.codec_name,
      pixFmt: video.pix_fmt || '',
      width,
      height,
      fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate),
      duration,
      bitRateMbps: bitRate / 1e6,
      rotated: rotation !== 0,
    };
  }

  // O vídeo toca como está (só copiado) ou precisa ser convertido?
  compliance(info) {
    const cfg = this.getConfig();
    const why = [];
    if (!/mp4/.test(info.container)) why.push(`contêiner ${info.container}`);
    if (info.codec !== 'h264') why.push(`codec ${info.codec}`);
    if (!['yuv420p', 'yuvj420p'].includes(info.pixFmt)) why.push(`cor ${info.pixFmt || '?'}`);
    if (info.width > cfg.maxWidth || info.height > cfg.maxHeight) why.push(`${info.width}x${info.height} acima de ${cfg.maxWidth}x${cfg.maxHeight}`);
    if (info.fps > cfg.maxFps + 0.5) why.push(`${info.fps.toFixed(0)} fps`);
    if (info.bitRateMbps > cfg.maxBitrateMbps) why.push(`${info.bitRateMbps.toFixed(0)} Mbps`);
    if (info.rotated) why.push('girado por metadado');
    return { ok: why.length === 0, why };
  }

  // Decodifica o vídeo inteiro sem mostrar nada: pega arquivo corrompido no meio.
  async verifyDecode(file, duration) {
    const timeoutMs = Math.max(120000, duration * 8000);
    const r = await run(this.ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { timeoutMs, lowPriority: true });
    if (r.timedOut) {
      const e = new Error('conferência demorou demais');
      e.code = 'ETIMEDOUT';
      throw e;
    }
    return r.code === 0 && !r.stderr.trim() ? { ok: true } : { ok: false, message: lastLine(r.stderr) || `ffmpeg código ${r.code}` };
  }

  // Converte para H.264 yuv420p dentro do limite de resolução/fps. Sem áudio, salvo se configurado.
  async transcode(src, dst, info, onProgress) {
    const cfg = this.getConfig();
    const filters = [
      `scale=w='min(iw,${cfg.maxWidth})':h='min(ih,${cfg.maxHeight})':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    ];
    if (info.fps > cfg.maxFps + 0.5) filters.push(`fps=${cfg.maxFps}`);
    filters.push('setsar=1', 'format=yuv420p');
    const audio = cfg.audio ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k'] : ['-an'];
    const args = [
      '-hide_banner', '-nostdin', '-y', '-v', 'error',
      '-i', src, '-map', '0:v:0', ...audio, '-sn', '-dn', '-map_metadata', '-1',
      '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-threads', '2',
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', dst,
    ];
    const onLine = (line) => {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m && onProgress && info.duration) onProgress(Math.min(1, Number(m[1]) / 1e6 / info.duration));
    };
    const timeoutMs = Math.max(600000, info.duration * 60000);
    const r = await run(this.ffmpeg, args, { timeoutMs, lowPriority: true, onLine });
    if (r.timedOut) {
      const e = new Error('conversão demorou demais');
      e.code = 'ETIMEDOUT';
      throw e;
    }
    if (r.code !== 0) throw new MediaError(`não consegui converter: ${lastLine(r.stderr) || `ffmpeg código ${r.code}`}`);
  }

  async freeBytes(dir) {
    try {
      const s = await fs.promises.statfs(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return Infinity;
    }
  }
}

module.exports = { Media, MediaError, run };
