'use strict';
const { posix } = require('node:path');

// These collection tools must never be served by the application, even if an
// archived fixture is accidentally copied back into public/ later.
function blockPublicExperiments(req, res, next) {
  let pathname = String(req.originalUrl || req.url || '').split('?')[0];
  try { pathname = decodeURIComponent(pathname); } catch { /* Keep the raw path. */ }
  pathname = posix.normalize(pathname.replace(/\\/g, '/')).toLowerCase();

  if (pathname !== '/experiments' && !pathname.startsWith('/experiments/')) return next();

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  return res.status(404).json({ error: 'NOT_FOUND', message: 'Không tìm thấy tài nguyên' });
}

module.exports = { blockPublicExperiments };
