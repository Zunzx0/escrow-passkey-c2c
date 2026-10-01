// Đóng băng phiên bản thực nghiệm.
//
// Quy trình đã chốt: không vừa chạy thí nghiệm vừa sửa logic. Không có git trong thư mục dự án,
// nên "tag" được thay bằng một manifest băm SHA-256 của từng file mã nguồn, bộ test, giao diện và
// cấu hình phụ thuộc. Manifest cho phép kiểm lại bất cứ lúc nào rằng mã đang chạy đúng là bản đã
// được kiểm thử và đóng băng.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'EXPERIMENT_FREEZE.json');

// Những gì quyết định hành vi của hệ thống hoặc của bộ kiểm thử.
const TRACKED_DIRS = ['src', 'scripts', 'public', 'test'];
const TRACKED_FILES = ['package.json', 'package-lock.json', '.env.example'];

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function trackedFiles() {
  const files = [];
  for (const d of TRACKED_DIRS) files.push(...walk(path.join(ROOT, d)));
  for (const f of TRACKED_FILES) {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) files.push(full);
  }
  return files
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .sort();
}

function sha256File(rel) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
}

function fileHashes() {
  const map = {};
  for (const rel of trackedFiles()) map[rel] = sha256File(rel);
  return map;
}

function codeHash(hashes) {
  const lines = Object.keys(hashes).sort().map((k) => `${k}:${hashes[k]}`).join('\n');
  return crypto.createHash('sha256').update(lines).digest('hex');
}

function latestModifiedAt() {
  let latest = 0;
  let file = null;
  for (const rel of trackedFiles()) {
    const m = fs.statSync(path.join(ROOT, rel)).mtimeMs;
    if (m > latest) { latest = m; file = rel; }
  }
  return { at: latest, file };
}

function readManifest() {
  if (!fs.existsSync(MANIFEST)) return null;
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

/** So mã hiện tại với manifest đã đóng băng. */
function verifyFreeze() {
  const manifest = readManifest();
  if (!manifest) return { frozen: false, ok: false, reason: 'Chưa có EXPERIMENT_FREEZE.json' };
  const now = fileHashes();
  const was = manifest.files || {};
  const changed = Object.keys(now).filter((k) => k in was && was[k] !== now[k]);
  const added = Object.keys(now).filter((k) => !(k in was));
  const removed = Object.keys(was).filter((k) => !(k in now));
  return {
    frozen: true,
    ok: changed.length === 0 && added.length === 0 && removed.length === 0,
    label: manifest.label,
    frozenAt: manifest.frozenAt,
    changed,
    added,
    removed,
  };
}

module.exports = { ROOT, MANIFEST, fileHashes, codeHash, latestModifiedAt, readManifest, verifyFreeze };
