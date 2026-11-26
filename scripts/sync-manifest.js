#!/usr/bin/env node
'use strict';

/**
 * LuthierLabs Beta manifest sync.
 *
 * Inspects the published Suite .apk files, extracts android:versionCode,
 * the bundled sw.js CACHE_NAME build number, size and SHA-256, and appends
 * a new releaseHistory entry (with short "What's New" notes) for every app
 * whose APK changed. Also refreshes the static size / SHA fallbacks in index.html.
 *
 * Usage:
 *   node scripts/sync-manifest.js --apk-dir <dir> [--notes notes.json] [--dry-run]
 *
 * notes.json: { "ALL": ["..."], "GUITARFORGE": ["..."], ... }
 *   App-specific notes come first, followed by the shared "ALL" notes.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const INDEX_PATH = path.join(ROOT, 'index.html');
const HISTORY_CAP = 50;
const MAX_NOTES = 4;
const MAX_NOTE_LEN = 120;

const APP_CARD_IDS = {
  GUITARFORGE: 'guitarforge',
  TONEFORGE: 'toneforge',
  FRETFORGE: 'fretforge',
  PRECISION_STROBE: 'strobe',
  EARFORGE: 'earforge'
};

function readZipEntry(buf, entryName) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const cdCount = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOff = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    if (name === entryName) {
      const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      const comp = buf.slice(dataStart, dataStart + compSize);
      return method === 8 ? zlib.inflateRawSync(comp) : comp;
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// Binary AXML: android:versionCode is resource id 0x0101021b.
function parseAxmlVersionCode(axml) {
  if (!axml || axml.length < 16) return null;
  let vcAttrIdx = -1;
  let pos = 8;
  while (pos + 8 <= axml.length) {
    const type = axml.readUInt16LE(pos);
    const headerSize = axml.readUInt16LE(pos + 2);
    const chunkSize = axml.readUInt32LE(pos + 4);
    if (chunkSize <= 0) break;
    if (type === 0x0180) {
      const count = (chunkSize - headerSize) / 4;
      for (let i = 0; i < count; i++) {
        if (axml.readUInt32LE(pos + headerSize + i * 4) === 0x0101021b) { vcAttrIdx = i; break; }
      }
    } else if (type === 0x0102 && vcAttrIdx >= 0) {
      const ext = pos + headerSize;
      const attrStart = axml.readUInt16LE(ext + 8);
      const attrSize = axml.readUInt16LE(ext + 10);
      const attrCount = axml.readUInt16LE(ext + 12);
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const dataType = axml.readUInt8(a + 15);
        if (axml.readInt32LE(a + 4) === vcAttrIdx && (dataType === 0x10 || dataType === 0x11)) {
          return axml.readInt32LE(a + 16);
        }
      }
    }
    pos += chunkSize;
  }
  return null;
}

function parseSwBuild(swSrc) {
  const m = String(swSrc || '').match(/CACHE_NAME\s*=\s*['"][^'"]*?-v(\d+)['"]/);
  return m ? parseInt(m[1], 10) : null;
}

function inspectApk(apkPath) {
  const buf = fs.readFileSync(apkPath);
  const sw = readZipEntry(buf, 'assets/public/sw.js');
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12),
    sizeMb: (buf.length / 1048576).toFixed(2),
    androidVersionCode: parseAxmlVersionCode(readZipEntry(buf, 'AndroidManifest.xml')),
    swBuild: sw ? parseSwBuild(sw.toString('utf8')) : null
  };
}

function cleanNotes(list) {
  return (Array.isArray(list) ? list : [])
    .map((n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_LEN))
    .filter(Boolean)
    .slice(0, MAX_NOTES);
}

function notesForApp(notesMap, appId) {
  const own = (notesMap && notesMap[appId]) || [];
  const shared = (notesMap && notesMap.ALL) || [];
  const merged = cleanNotes(own.concat(shared));
  return merged.length ? merged : ['Stability & maintenance update'];
}

const DEFAULT_WIN_EXE_NAME = 'LuthierLabs-Studio-Setup-v1.1.0-x64.exe';
const DEFAULT_WIN_EXE_URL = 'https://github.com/luthierlabsllc/luthierlabs-beta/releases/download/v1.1.0/' + DEFAULT_WIN_EXE_NAME;

function inspectDesktopExe(exePath) {
  const buf = fs.readFileSync(exePath);
  const verMatch = path.basename(exePath).match(/-v(\d+\.\d+\.\d+)/);
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12),
    sizeMb: (buf.length / 1048576).toFixed(2),
    version: verMatch ? verMatch[1] : '1.1.0'
  };
}

function applyDesktopExeInfo(manifest, info, notes, stampIso, exeUrl) {
  if (!manifest.desktop || typeof manifest.desktop !== 'object') manifest.desktop = {};
  const win = (manifest.desktop.win && typeof manifest.desktop.win === 'object') ? manifest.desktop.win : {};
  const history = Array.isArray(win.releaseHistory) ? win.releaseHistory.slice() : [];
  const last = history[history.length - 1];
  if (last && last.sha256 === info.sha256) return false;
  const seq = (last && Number.isFinite(+last.seq)) ? (+last.seq + 1) : (Number.isFinite(+win.seq) ? (+win.seq + 1) : 1);
  history.push({
    seq,
    version: info.version,
    sha256: info.sha256,
    sizeMb: info.sizeMb,
    updatedAt: stampIso,
    notes
  });
  win.seq = seq;
  win.version = info.version;
  win.exeUrl = exeUrl || win.exeUrl || DEFAULT_WIN_EXE_URL;
  win.sha256 = info.sha256;
  win.sizeMb = info.sizeMb;
  win.updatedAt = stampIso;
  win.notes = notes;
  win.releaseHistory = history.slice(-HISTORY_CAP);
  manifest.desktop.win = win;
  return true;
}

function applyApkInfoToApp(app, info, notes, stampIso) {
  const history = Array.isArray(app.releaseHistory) ? app.releaseHistory.slice() : [];
  const last = history[history.length - 1];
  if (last && last.sha256 === info.sha256) return false;
  const seq = (last && Number.isFinite(+last.seq)) ? (+last.seq + 1) : 1;
  history.push({
    seq,
    androidVersionCode: info.androidVersionCode,
    swBuild: info.swBuild,
    sha256: info.sha256,
    sizeMb: info.sizeMb,
    updatedAt: stampIso,
    notes
  });
  app.releaseHistory = history.slice(-HISTORY_CAP);
  app.sha256 = info.sha256;
  app.sizeMb = info.sizeMb;
  app.androidVersionCode = info.androidVersionCode;
  app.swBuild = info.swBuild;
  app.releaseSeq = seq;
  app.updatedAt = stampIso;
  app.whatsNew = notes;
  return true;
}

function refreshIndexHtml(html, manifest) {
  let out = html;
  for (const [appId, cardId] of Object.entries(APP_CARD_IDS)) {
    const app = manifest.apps[appId];
    if (!app) continue;
    const re = new RegExp('(<article class="card" id="' + cardId + '"[\\s\\S]*?</article>)');
    out = out.replace(re, (block) => block
      .replace(/<span>[\d.]+ MB<\/span>/, '<span>' + app.sizeMb + ' MB</span>')
      .replace(/SHA256: [0-9a-f]{6,64}/, 'SHA256: ' + app.sha256));
  }
  const win = manifest.desktop && manifest.desktop.win;
  if (win && win.sizeMb && win.sha256) {
    const winRe = /(<article class="card[^"]*" id="desktop-win"[\s\S]*?<\/article>)/;
    out = out.replace(winRe, (block) => block
      .replace(/<span>(?:[\d.]+ MB|Pending CI)<\/span>/, '<span>' + win.sizeMb + ' MB</span>')
      .replace(/SHA256: (?:[0-9a-f]{6,64}|pending)/, 'SHA256: ' + win.sha256)
      .replace(/Shell Seq: (?:\d+|pending)/, 'Shell Seq: ' + win.seq));
  }
  return out;
}

function parseArgs(argv) {
  const args = { apkDir: '', notes: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apk-dir') args.apkDir = argv[++i];
    else if (argv[i] === '--notes') args.notes = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.apkDir) {
    console.error('Usage: node scripts/sync-manifest.js --apk-dir <dir> [--notes notes.json] [--dry-run]');
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const notesMap = args.notes ? JSON.parse(fs.readFileSync(args.notes, 'utf8')) : {};
  const stampIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const changed = [];

  for (const [appId, app] of Object.entries(manifest.apps)) {
    const fileName = path.basename(String(app.apkUrl || ''));
    const apkPath = path.join(args.apkDir, fileName);
    if (!fileName || !fs.existsSync(apkPath)) {
      console.log(`- ${appId}: ${fileName || '(no apkUrl)'} not found, skipped`);
      continue;
    }
    const info = inspectApk(apkPath);
    if (applyApkInfoToApp(app, info, notesForApp(notesMap, appId), stampIso)) {
      changed.push(appId);
      console.log(`+ ${appId}: seq ${app.releaseSeq} · versionCode ${info.androidVersionCode} · sw v${info.swBuild} · ${info.sizeMb} MB · ${info.sha256}`);
    } else {
      console.log(`= ${appId}: unchanged (${info.sha256})`);
    }
  }

  const existingWinUrl = manifest.desktop && manifest.desktop.win && manifest.desktop.win.exeUrl;
  const winFileName = path.basename(String(existingWinUrl || DEFAULT_WIN_EXE_NAME));
  const winExePath = path.join(args.apkDir, winFileName);
  if (fs.existsSync(winExePath)) {
    const winInfo = inspectDesktopExe(winExePath);
    if (applyDesktopExeInfo(manifest, winInfo, notesForApp(notesMap, 'DESKTOP_WIN'), stampIso, existingWinUrl || DEFAULT_WIN_EXE_URL)) {
      const winObj = manifest.desktop.win;
      changed.push('DESKTOP_WIN');
      console.log(`+ DESKTOP_WIN: seq ${winObj.seq} · v${winObj.version} · ${winInfo.sizeMb} MB · ${winInfo.sha256}`);
    } else {
      console.log(`= DESKTOP_WIN: unchanged (${winInfo.sha256})`);
    }
  } else {
    console.log(`- DESKTOP_WIN: ${winFileName} not found, skipped`);
  }

  if (!changed.length) {
    console.log('No APK or Desktop installer changes detected — manifest.json left untouched.');
    return;
  }
  manifest.updatedAt = stampIso;
  manifest.historyCap = HISTORY_CAP;
  if (args.dryRun) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  if (fs.existsSync(INDEX_PATH)) {
    fs.writeFileSync(INDEX_PATH, refreshIndexHtml(fs.readFileSync(INDEX_PATH, 'utf8'), manifest));
  }
  console.log(`Updated manifest.json (${changed.join(', ')}) at ${stampIso}`);
}

module.exports = {
  HISTORY_CAP,
  readZipEntry,
  parseAxmlVersionCode,
  parseSwBuild,
  inspectApk,
  inspectDesktopExe,
  applyDesktopExeInfo,
  cleanNotes,
  notesForApp,
  applyApkInfoToApp,
  refreshIndexHtml
};

if (require.main === module) main();
