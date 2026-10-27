'use strict';
/**
 * Photo upload / gallery / evidence UI test (jsdom + fake fetch).
 *
 * Loads the real public/index.html and public/js/*.js. Every network call is a fake: no server, database,
 * storage, secret, account or real image. It verifies DOM and request contracts, not server image decoding,
 * private-storage authorization, browser layout or actual device behavior.
 *
 *   node test/ui/media-upload-ui.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (_) { console.error('Missing jsdom (devDependency).'); process.exit(2); }

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const ORIGIN = 'http://localhost:3999';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; console.log('PASS ' + message); };
const json = (status, body) => ({ status, body });
const HANG = Symbol('hang');
const SELLER = { id: 'u-seller', username: 'ban', displayName: 'Người Bán', role: 'SELLER', accountStatus: 'ACTIVE' };
const BUYER = { id: 'u-buyer', username: 'mua', displayName: 'Người Mua', role: 'BUYER', accountStatus: 'ACTIVE' };
const WEBP = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
const uid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const appSource = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');

async function until(fn, timeout = 2500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return true; await sleep(15); }
  return !!fn();
}

async function openPage({ user, hash, routes = {} }) {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/g, '');
  const calls = [], created = [], revoked = [];
  const table = { ...routes };
  let startup = true, blobCounter = 0;
  const dom = new JSDOM(html, {
    url: ORIGIN + '/', runScripts: 'outside-only', pretendToBeVisual: true,
    beforeParse(w) {
      w.ENCLAVE_API_TIMEOUT_MS = 1500;
      w.ENCLAVE_MEDIA_POLL_MS = 10;
      w.scrollTo = () => {};
      w.URL.createObjectURL = () => { const u = 'blob:' + ORIGIN + '/' + (++blobCounter); created.push(u); return u; };
      w.URL.revokeObjectURL = (u) => { revoked.push(u); };
      w.location.hash = hash;
      w.fetch = (url, opts = {}) => new Promise((resolve, reject) => {
        const u = new URL(url, ORIGIN);
        const key = `${opts.method || 'GET'} ${u.pathname}`;
        const boot = startup && key === 'POST /api/passkeys/session/refresh';
        if (boot) startup = false;
        const rec = { key, href: u.href, search: u.searchParams, headers: opts.headers || {}, body: opts.body, signal: opts.signal, aborted: false };
        if (!boot) calls.push(rec);
        if (opts.signal) {
          const abort = () => { rec.aborted = true; reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })); };
          if (opts.signal.aborted) return abort();
          opts.signal.addEventListener('abort', abort);
        }
        const wild = Object.keys(table).find((k) => k.endsWith('*') && key.startsWith(k.slice(0, -1)));
        const handler = table[key] || (wild && table[wild]);
        const r = boot
          ? json(200, { token: 'tok-' + user.id, user: { ...user, authMethod: 'passkey', emailVerified: true, recoveryAcknowledged: true } })
          : handler ? handler(rec) : json(404, { error: 'NOT_FOUND', message: 'Không tìm thấy tài nguyên' });
        if (r === HANG) return;
        Promise.resolve(r).then((x) => {
          if (x === HANG) return;
          if (x.bytes) return resolve(new Response(x.bytes, { status: x.status || 200, headers: { 'Content-Type': x.type || 'image/webp' } }));
          resolve(new Response(JSON.stringify(x.body), { status: x.status, headers: { 'Content-Type': 'application/json' } }));
        }, reject);
      });
      w.eval(['config.js', 'icons.js', 'simplewebauthn-browser.js', 'shipping-motion.js', 'app.js']
        .map((f) => fs.readFileSync(path.join(PUBLIC, 'js', f), 'utf8')).join('\n;\n'));
    },
  });
  await sleep(700);
  const w = dom.window, d = w.document;
  return {
    w, d, calls, created, revoked, routes: table,
    count: (key) => calls.filter((c) => c.key === key).length,
    all: (key) => calls.filter((c) => c.key === key),
    click: (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    modal: () => d.getElementById('modalRoot'),
    toasts: () => [...d.querySelectorAll('#toasts .toast')].map((t) => t.textContent.trim()),
    escape: () => d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    pick(files) {
      const input = d.getElementById('mediaFiles');
      Object.defineProperty(input, 'files', { configurable: true, value: files });
      input.dispatchEvent(new w.Event('change', { bubbles: true }));
    },
    file: (name, type = 'image/jpeg') => new w.File([new Uint8Array([1, 2, 3, 4])], name, { type }),
    close: () => w.close(),
  };
}

const baseRoutes = (user) => ({
  'GET /api/users/me': () => json(200, { user, wallet: { availableBalance: 0, lockedBalance: 0, pendingTopupTotal: 0 } }),
  'GET /api/users/me/seller-request': () => json(200, { request: null }),
  'GET /api/listings/meta': () => json(200, { categories: [{ key: 'dien-thoai', label: 'Điện thoại' }], conditions: [{ key: 'GOOD', label: 'Tốt' }], locations: ['Hà Nội'] }),
  'GET /api/wallets/me': () => json(200, { availableBalance: 0, lockedBalance: 0, pendingTopupTotal: 0 }),
  'GET /api/notifications': () => json(200, { notifications: [], unreadCount: 0 }),
  'GET /api/notifications/todo': () => json(200, { items: [] }),
  'GET /api/transactions': () => json(200, { transactions: [] }),
  'GET /api/listings': () => json(200, { listings: [] }),
});

/** Fake upload endpoint: ids are assigned per original file name, so the order of ids is checkable. */
function uploadRoute(page, user, { fail = {}, ids = {} } = {}) {
  const seen = {};
  return (rec) => {
    const name = rec.body && rec.body.name;
    seen[name] = (seen[name] || 0) + 1;
    if (fail[name]) { const r = fail[name](seen[name], rec); if (r) return r; }
    const id = ids[name] || uid(Object.keys(ids).length + 1);
    ids[name] = id;
    return json(201, { id, url: '/api/media/images/' + id, width: 10, height: 10, bytes: 4, purpose: rec.search.get('purpose'), createdAt: '2026-10-20T03:04:05.000Z', uploadedBy: user.id });
  };
}

async function sellerForm(extra = {}) {
  const page = await openPage({
    user: SELLER, hash: '#/shop',
    routes: { ...baseRoutes(SELLER), ...extra },
  });
  page.click(page.d.querySelector('[data-act="new-listing"]'));
  await until(() => page.d.getElementById('mediaFiles'));
  page.d.getElementById('lsTitle').value = 'iPhone thật chụp ảnh';
  page.d.getElementById('lsPrice').value = '2000000';
  return page;
}
const save = async (p, ms = 200) => { p.click(p.modal().querySelector('[data-act="save-listing"]')); await sleep(ms); };
const names = (p) => [...p.d.querySelectorAll('.media-selected figcaption b')].map((b) => b.textContent);

async function main() {
  // ---------- static contract ----------
  const vercel = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'vercel.json'), 'utf8'));
  const csp = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  const img = /img-src ([^;]+)/.exec(csp)[1].split(/\s+/);
  ok(img.includes('blob:') && !img.includes('*') && !img.includes('https:') && !img.includes('http:') && !img.some((s) => /^https?:\/\//.test(s)), 'CSP allows only narrow blob: for images, no wildcard or external image origin');
  ok(!/FormData/.test(appSource), 'front end never builds multipart FormData');
  ok(!/[?&]token=|access_token/.test(appSource) && !/(?:^|[^\w])l\??\.image\b/.test(appSource), 'front end has no JWT query parameter and does not read the legacy l.image field');

  // ---------- A: select, validate, max 6, preview, remove ----------
  let p = await sellerForm({ 'POST /api/media/uploads': uploadRoute(null, SELLER), 'POST /api/listings': () => json(201, { id: 'l-new' }) });
  try {
    const seven = Array.from({ length: 7 }, (_, i) => p.file(`f${i}.jpg`));
    p.pick(seven);
    ok(names(p).length === 7 && p.created.length === 6, 'seven files are listed but only six get object-URL previews');
    ok(/Hãy xóa ảnh dư/.test(p.modal().textContent), 'the seventh file shows a recoverable per-file max-6 error');
    await save(p);
    ok(p.count('POST /api/media/uploads') === 0 && p.count('POST /api/listings') === 0, 'invalid selection blocks every upload and the listing save');
    p.click(p.d.querySelectorAll('.media-selected')[6].querySelector('[data-act="media-remove"]'));
    ok(names(p).length === 6 && !/Hãy xóa ảnh dư/.test(p.modal().textContent), 'removing the extra file clears the error');
    const before = p.revoked.length;
    p.click(p.d.querySelectorAll('.media-selected')[5].querySelector('[data-act="media-remove"]'));
    ok(p.revoked.length === before + 1 && names(p).length === 5 && !names(p).includes('f5.jpg'), 'removing a selected file revokes its preview URL and really removes it');
    p.pick([p.file('anim.gif', 'image/gif')]);
    ok(/Định dạng không hỗ trợ/.test(p.modal().textContent) && p.created.length === 6, 'GIF is rejected client-side without a preview');
    p.click([...p.d.querySelectorAll('.media-selected')].pop().querySelector('[data-act="media-remove"]'));
    ok(names(p).length === 5 && !/Định dạng không hỗ trợ/.test(p.modal().textContent), 'removing the GIF clears its error');
  } finally { p.close(); }

  // ---------- B/C: cover, reorder, raw binary upload, listing imageIds in the chosen order ----------
  const ids = {};
  p = await sellerForm({ 'POST /api/media/uploads': uploadRoute(null, SELLER, { ids }), 'POST /api/listings': () => json(201, { id: 'l-new' }) });
  try {
    p.pick([p.file('a.jpg'), p.file('b.png', 'image/png'), p.file('c.webp', 'image/webp')]);
    ok(names(p).join() === 'a.jpg,b.png,c.webp' && p.d.querySelector('.media-selected .tag').textContent === 'Ảnh bìa', 'first selected photo is marked as cover');
    p.click(p.d.querySelectorAll('.media-selected')[2].querySelector('[data-act="media-cover"]'));
    ok(names(p).join() === 'c.webp,a.jpg,b.png', 'cover action moves a photo to the front');
    p.click(p.d.querySelectorAll('.media-selected')[0].querySelector('[data-act="media-move"][data-dir="1"]'));
    ok(names(p).join() === 'a.jpg,c.webp,b.png', 'move-down reorders the selection');
    await save(p, 400);
    await until(() => p.count('POST /api/listings') === 1);
    const ups = p.all('POST /api/media/uploads');
    ok(ups.length === 3, 'each photo is uploaded exactly once');
    ok(ups.every((c) => c.search.get('purpose') === 'LISTING' && /^[0-9a-f-]{36}$/.test(c.search.get('requestId')) && !c.search.get('transactionId')), 'upload query has purpose=LISTING and a UUID requestId');
    ok(ups.every((c) => c.body instanceof p.w.File && !(c.body instanceof p.w.FormData) && typeof c.body !== 'string'), 'upload body is the raw File, not multipart or JSON');
    ok(ups[0].headers.Authorization === 'Bearer tok-' + SELLER.id && ups.map((c) => c.headers['Content-Type']).join() === 'image/jpeg,image/webp,image/png', 'Bearer token and exact per-file Content-Type are sent');
    ok(ups.every((c) => !/token|jwt|tok-/i.test(c.href)), 'no token appears in any upload URL');
    ok(new Set(ups.map((c) => c.search.get('requestId'))).size === 3, 'each photo has its own requestId');
    const body = p.all('POST /api/listings')[0].body;
    ok(JSON.parse(body).imageIds.join() === [ids['a.jpg'], ids['c.webp'], ids['b.png']].join(), 'listing POST carries imageIds in cover-first order');
  } finally { p.close(); }

  // ---------- D: failure keeps files, requestIds and stagedIds; no duplicate uploads ----------
  const ids2 = {};
  let listingTries = 0;
  p = await sellerForm({
    'POST /api/media/uploads': uploadRoute(null, SELLER, { ids: ids2, fail: { 'b.png': (n) => (n === 1 ? json(503, { error: 'MEDIA_STORAGE_UNAVAILABLE', message: 'x' }) : null) } }),
    'POST /api/listings': () => (++listingTries === 1 ? json(500, { error: 'INTERNAL_ERROR', message: 'x' }) : json(201, { id: 'l-new' })),
  });
  try {
    p.pick([p.file('a.jpg'), p.file('b.png', 'image/png')]);
    await save(p, 350);
    ok(!!p.d.getElementById('mediaFiles') && p.d.getElementById('lsTitle').value === 'iPhone thật chụp ảnh' && names(p).length === 2, 'storage failure keeps the modal, typed content and selected files');
    ok(/Lưu trữ ảnh chưa sẵn sàng/.test(p.modal().textContent) && p.count('POST /api/listings') === 0, 'per-file recoverable error is shown and the listing is not created');
    const firstB = p.all('POST /api/media/uploads').filter((c) => c.body.name === 'b.png')[0].search.get('requestId');
    await save(p, 400);
    await until(() => p.count('POST /api/listings') === 1);
    const ups = p.all('POST /api/media/uploads');
    ok(ups.filter((c) => c.body.name === 'a.jpg').length === 1, 'already-staged photo is not uploaded again on retry');
    ok(ups.filter((c) => c.body.name === 'b.png').map((c) => c.search.get('requestId')).every((r) => r === firstB), 'retry reuses the same requestId for the failed file');
    ok(/Đã tải lên lúc|Đã tải lên/.test(p.modal().textContent), 'stored photos show an uploaded state with upload time');
    await save(p, 400);
    await until(() => p.count('POST /api/listings') === 2);
    ok(p.count('POST /api/media/uploads') === 3, 'a failed listing save does not re-upload staged photos');
    const [first, second] = p.all('POST /api/listings').map((c) => JSON.parse(c.body).imageIds);
    ok(first.join() === second.join() && first.length === 2, 'the same stagedIds are resent after a failed listing save');
  } finally { p.close(); }

  // ---------- E: unknown outcome is reconciled by requestId, never re-posted blindly ----------
  let lookups = 0;
  const stagedId = uid(77);
  p = await sellerForm({
    'POST /api/media/uploads': () => Promise.reject(new Error('Failed to fetch')),
    'GET /api/media/uploads/*': () => {
      lookups++;
      const asset = { id: stagedId, url: '/api/media/images/' + stagedId, width: 10, height: 10, bytes: 4, purpose: 'LISTING', createdAt: '2026-10-20T03:04:05.000Z', uploadedBy: SELLER.id };
      return lookups === 1 ? json(202, { ...asset, status: 'UPLOADING' }) : json(200, { ...asset, status: 'STAGED' });
    },
    'POST /api/listings': () => json(201, { id: 'l-new' }),
  });
  try {
    p.pick([p.file('a.jpg')]);
    await save(p, 500);
    await until(() => p.count('POST /api/listings') === 1);
    const lookupCalls = p.calls.filter((c) => c.key.startsWith('GET /api/media/uploads/'));
    ok(lookupCalls.every((c) => c.href.endsWith(p.all('POST /api/media/uploads')[0].search.get('requestId'))), 'reconciliation uses the same requestId as the POST');
    ok(p.count('POST /api/media/uploads') === 1 && lookups === 2, 'lost POST response is reconciled via GET /media/uploads/:requestId (202 pending then 200) without a second POST');
    ok(JSON.parse(p.all('POST /api/listings')[0].body).imageIds.join() === stagedId, 'reconciled asset id is attached to the listing');
  } finally { p.close(); }

  // lookup 404: keep requestId, retry POST with the same requestId
  let posts404 = 0;
  p = await sellerForm({ 'POST /api/listings': () => json(201, { id: 'l-new' }) });
  try {
    p.routes['POST /api/media/uploads'] = (rec) => {
      posts404++;
      if (posts404 === 1) return Promise.reject(new Error('Failed to fetch'));
      return json(201, { id: uid(88), url: '/api/media/images/' + uid(88), width: 1, height: 1, bytes: 4, purpose: 'LISTING', createdAt: '2026-10-20T03:04:05.000Z', uploadedBy: SELLER.id });
    };
    p.pick([p.file('a.jpg')]);
    await save(p, 350);
    ok(/chưa rõ/i.test(p.modal().textContent) && p.count('POST /api/listings') === 0, 'unresolved upload outcome is reported honestly and nothing is saved');
    const rid = p.all('POST /api/media/uploads')[0].search.get('requestId');
    await save(p, 400);
    await until(() => p.count('POST /api/listings') === 1);
    ok(p.all('POST /api/media/uploads').map((c) => c.search.get('requestId')).every((r) => r === rid), 'after a 404 lookup the retry reuses the same requestId');
  } finally { p.close(); }

  // ---------- F: pipeline guard, abort, revoke on navigation ----------
  p = await sellerForm({ 'POST /api/media/uploads': () => HANG, 'POST /api/listings': () => json(201, { id: 'x' }) });
  try {
    p.pick([p.file('a.jpg'), p.file('b.jpg')]);
    p.click(p.modal().querySelector('[data-act="save-listing"]'));
    await until(() => p.count('POST /api/media/uploads') === 1);
    ok(p.d.getElementById('mediaFiles').disabled && [...p.d.querySelectorAll('.media-selected button')].every((b) => b.disabled), 'file input and every per-photo control are disabled while uploading');
    p.escape();
    ok(!!p.d.getElementById('mediaFiles'), 'Escape cannot close the modal during the upload pipeline');
    ok([...p.modal().querySelectorAll('[data-act="modal-close"]')].every((b) => b.disabled), 'cancel and close buttons are disabled while uploading');
    p.click(p.modal().querySelector('[data-act="modal-backdrop"]'));
    p.click(p.modal().querySelector('[data-act="save-listing"]'));
    await sleep(60);
    ok(p.count('POST /api/media/uploads') === 1, 'repeated save clicks do not start a duplicate upload');
    const post = p.all('POST /api/media/uploads')[0];
    p.w.location.hash = '#/';
    await until(() => post.aborted);
    ok(post.aborted, 'navigation aborts the in-flight upload request');
    ok(p.modal().innerHTML === '' && p.revoked.length >= p.created.length && p.created.length === 2, 'navigation closes the modal and revokes every preview URL');
    await sleep(100);
    ok(p.count('POST /api/listings') === 0 && p.toasts().length === 0, 'a stale aborted upload neither saves the listing nor toasts into the new view');
  } finally { p.close(); }

  // dirty modal asks before discarding; confirm discards and revokes
  p = await sellerForm({ 'POST /api/media/uploads': uploadRoute(null, SELLER) });
  try {
    p.pick([p.file('a.jpg')]);
    p.escape();
    ok(!!p.d.querySelector('.media-discard') && !!p.d.getElementById('mediaFiles'), 'closing a modal with unsaved photos asks for confirmation instead of losing them');
    p.escape();
    ok(!p.d.querySelector('.media-discard') && !!p.d.getElementById('mediaFiles'), 'Escape on the confirmation keeps editing');
    p.click(p.modal().querySelector('[data-act="modal-close"]'));
    p.click(p.d.querySelector('[data-act="media-discard-confirm"]'));
    ok(p.modal().innerHTML === '' && p.revoked.length === p.created.length, 'confirmed discard closes the modal and revokes previews');
  } finally { p.close(); }

  // ---------- Final JSON is part of the same submission lock, including replaced DOM buttons ----------
  const finalSave=deferred();
  p=await sellerForm({'POST /api/media/uploads':uploadRoute(null,SELLER),'POST /api/listings':()=>finalSave.promise});
  try {
    p.pick([p.file('locked-a.jpg'),p.file('locked-b.jpg')]);
    p.click(p.modal().querySelector('[data-act="save-listing"]'));
    ok(await until(()=>p.count('POST /api/listings')===1),'final listing request is reached after both uploads');
    ok(p.d.getElementById('mediaFiles').disabled && [...p.modal().querySelectorAll('button,input,select,textarea')].every(el=>el.disabled),'all modal controls, including recreated photo buttons, stay disabled during final JSON');
    const sentIds=JSON.parse(p.all('POST /api/listings')[0].body).imageIds;
    const remove=p.d.querySelector('[data-act="media-remove"]'); remove.disabled=false;p.click(remove);remove.disabled=true;
    const cover=p.d.querySelector('[data-act="media-cover"]');cover.disabled=false;p.click(cover);cover.disabled=true;
    const input=p.d.getElementById('mediaFiles');input.disabled=false;p.pick([p.file('injected.jpg')]);input.disabled=true;
    ok(names(p).join()==='locked-a.jpg,locked-b.jpg','mutation handlers also reject remove, reorder and file change while final JSON is pending');
    p.escape();
    ok(!!p.d.getElementById('mediaFiles')&&!p.d.querySelector('.media-discard'),'Escape cannot discard the draft during the final JSON request');
    const saveBtn=p.modal().querySelector('[data-act="save-listing"]');saveBtn.disabled=false;p.click(saveBtn);saveBtn.disabled=true;
    await sleep(30);
    ok(p.count('POST /api/listings')===1 && p.count('POST /api/media/uploads')===2,'forced repeated save cannot attach or upload twice while submitting');
    finalSave.resolve(json(500,{error:'INTERNAL_ERROR'}));
    ok(await until(()=>!saveBtn.disabled),'failed final JSON restores the save button');
    ok([...p.d.querySelectorAll('.media-selected button')].every(el=>!el.disabled)&&!input.disabled&&names(p).length===2,'failure unlocks newly rendered photo controls and preserves the selected files');
    p.routes['POST /api/listings']=()=>json(201,{id:'locked-retry'});
    await save(p);
    ok(p.count('POST /api/media/uploads')===2 && JSON.parse(p.all('POST /api/listings')[1].body).imageIds.join()===sentIds.join(),'retrying a final save reuses staged ids without uploading again');
  } finally {p.close();}

  // FAILED lookup is terminal for the previous attempt, not a permanent lookup-only state.
  let failedPosts=0,failedLookups=0;
  p=await sellerForm({
    'POST /api/media/uploads':rec=>++failedPosts===1?Promise.reject(new Error('Failed to fetch')):json(201,{id:uid(101),purpose:'LISTING',createdAt:'2026-10-20T03:04:05.000Z',uploadedBy:SELLER.id}),
    'GET /api/media/uploads/*':()=>++failedLookups===1?json(202,{status:'UPLOADING'}):json(410,{error:'MEDIA_UPLOAD_FAILED',message:'Lượt tải trước thất bại, thử lại cùng mã và tệp.'}),
    'POST /api/listings':()=>json(201,{id:'failed-retry'}),
  });
  try {
    const file=p.file('failed.jpg');p.pick([file]);await save(p,250);
    ok(failedPosts===1&&failedLookups===2&&p.count('POST /api/listings')===0,'pending lookup followed by FAILED does not attach an absent image');
    ok(!!p.d.getElementById('mediaFiles')&&!p.modal().querySelector('[data-act="save-listing"]').disabled,'FAILED lookup leaves the same draft retryable');
    await save(p,250);
    const posts=p.all('POST /api/media/uploads');
    ok(posts.length===2&&posts[0].body===file&&posts[1].body===file&&posts[0].search.get('requestId')===posts[1].search.get('requestId'),'retry after 410 MEDIA_UPLOAD_FAILED posts the identical File with the identical requestId');
    ok(p.count('POST /api/listings')===1&&JSON.parse(p.all('POST /api/listings')[0].body).imageIds[0]===uid(101),'successful retry attaches only the confirmed image id');
  } finally {p.close();}

  // An idempotency conflict requires an explicit new selection, never an automatic new UUID.
  p=await sellerForm({'POST /api/media/uploads':()=>json(409,{error:'MEDIA_REQUEST_REUSED',message:'Mã tải không khớp nội dung.'}),'POST /api/listings':()=>json(201,{id:'explicit-new-selection'})});
  try {
    const file=p.file('conflict.jpg');p.pick([file]);await save(p);
    const oldId=p.all('POST /api/media/uploads')[0].search.get('requestId');
    ok(/xóa tệp này.*chọn lại/i.test(p.modal().textContent),'mismatched requestId tells the user to explicitly remove and reselect');
    await save(p);
    ok(p.count('POST /api/media/uploads')===1&&p.count('POST /api/listings')===0,'save retry cannot silently bypass a 409 MEDIA_REQUEST_REUSED by rotating its UUID');
    p.click(p.d.querySelector('[data-act="media-remove"]'));p.pick([file]);
    p.routes['POST /api/media/uploads']=uploadRoute(null,SELLER);
    await save(p);
    ok(p.all('POST /api/media/uploads')[1].search.get('requestId')!==oldId&&p.count('POST /api/listings')===1,'explicit remove and reselect creates a new upload intent and can succeed');
  } finally {p.close();}

  // ---------- G: gallery / detail / cards use authenticated blob fetch ----------
  const listing = {
    id: 'L1', sellerId: 's1', title: 'Máy ảnh cũ', category: 'dien-thoai', condition: 'GOOD', price: 900000, location: 'Hà Nội',
    status: 'AVAILABLE', visibility: 'PUBLIC', isSold: false, createdAt: '2026-10-20T03:04:05.000Z', description: 'x',
    image: 'https://evil.example/legacy.png',
    images: [
      { id: uid(1), url: '/api/media/images/' + uid(1), width: 10, height: 10, bytes: 4, purpose: 'LISTING', createdAt: '2026-10-20T03:04:05.000Z', uploadedBy: 's1' },
      { id: uid(2), url: '/api/media/images/' + uid(2), width: 10, height: 10, bytes: 4, purpose: 'LISTING', createdAt: '2026-10-21T03:04:05.000Z', uploadedBy: 's1' },
    ],
  };
  const imageRoutes = Object.fromEntries([uid(1), uid(2)].map((id) => ['GET /api/media/images/' + id, () => ({ status: 200, bytes: WEBP, type: 'image/webp' })]));
  for(const isSold of [false,true]) {
    const editListing={...listing,sellerId:SELLER.id,isSold,status:isSold?'SOLD':'AVAILABLE'};
    p=await openPage({user:SELLER,hash:'#/shop',routes:{...baseRoutes(SELLER),...imageRoutes,'GET /api/listings':()=>json(200,{listings:[editListing]}),'GET /api/listings/L1':()=>json(200,editListing),'PATCH /api/listings/L1':()=>json(200,editListing)}});
    try {
      p.click(p.d.querySelector('[data-act="edit-listing"]'));
      ok(await until(()=>p.d.getElementById('lsPrice')),'edit form loads for '+(isSold?'paid':'available')+' listing');
      const btn=p.modal().querySelector('[data-act="save-listing"]');
      ok(btn.dataset.busy===(isSold?'1':'0'),'edit form exposes explicit paid flag '+(isSold?'1':'0'));
      p.d.getElementById('lsPrice').value='1234000';await save(p);
      const body=JSON.parse(p.all('PATCH /api/listings/L1')[0].body);
      ok(isSold?!Object.hasOwn(body,'price'):body.price===1234000,'price is '+(isSold?'omitted for a paid listing':'sent for an AVAILABLE listing despite data-busy="0"'));
      ok(!Object.hasOwn(body,'imageIds')&&p.count('POST /api/media/uploads')===0,'unchanged saved photos are preserved without upload or replacement for '+(isSold?'paid':'available')+' listing');
    } finally {p.close();}
  }

  // A committed write may finish after leaving its screen; it cannot close or navigate a new dialog.
  for(const reopen of [false,true]) {
    const late=deferred();
    p=await sellerForm({'POST /api/media/uploads':uploadRoute(null,SELLER),'POST /api/listings':()=>late.promise});
    try {
      p.pick([p.file('late.jpg')]);p.click(p.modal().querySelector('[data-act="save-listing"]'));
      ok(await until(()=>p.count('POST /api/listings')===1),'late-response fixture has an actual in-flight final JSON request');
      p.w.location.hash=reopen?'#/':'#/orders';await sleep(60);
      if(reopen) {
        p.w.location.hash='#/shop';
        ok(await until(()=>p.d.querySelector('[data-act="new-listing"]')),'seller returns to the shop while previous final save is pending');
        p.click(p.d.querySelector('[data-act="new-listing"]'));p.d.getElementById('lsTitle').value='Nội dung mới cần giữ';
      }
      late.resolve(json(201,{id:'late-result'}));await sleep(150);
      ok(reopen?p.d.getElementById('lsTitle')?.value==='Nội dung mới cần giữ':p.w.location.hash==='#/orders'&&p.modal().innerHTML==='','old final response '+(reopen?'preserves a new modal even when hash returns to the original route':'cannot navigate away from the new route'));
      ok(!p.toasts().some(text=>text.includes('Đã đăng tin')),'stale final save does not announce success into the new screen');
    } finally {p.close();}
  }

  p = await openPage({ user: BUYER, hash: '#/listing/L1', routes: { ...baseRoutes(BUYER), ...imageRoutes, 'GET /api/listings/L1': () => json(200, listing) } });
  try {
    await until(() => p.d.querySelectorAll('img[data-media-id][src^="blob:"]').length >= 2);
    const imgs = [...p.d.querySelectorAll('img[data-media-id]')];
    ok(imgs.length >= 2 && imgs.every((i) => i.getAttribute('src') && i.getAttribute('src').startsWith('blob:')), 'detail gallery images are Blob URLs');
    const reads = p.calls.filter((c) => c.key.startsWith('GET /api/media/images/'));
    ok(reads.length >= 2 && reads.every((c) => c.headers.Authorization === 'Bearer tok-' + BUYER.id && !c.href.includes('?') && !/token|jwt/i.test(c.href)), 'image reads send Bearer auth and never put a token in the URL');
    ok(!p.d.documentElement.innerHTML.includes('evil.example'), 'legacy arbitrary l.image URL is never rendered');
    const text = p.d.querySelector('.pd-gallery').textContent;
    ok(/Tải lên lúc/.test(text) && /không chứng minh danh tính/.test(text) && /thời điểm chụp/.test(text), 'gallery shows upload time and the no-proof-of-identity/capture-time note');
    p.click(p.d.querySelectorAll('.media-thumb')[1]);
    ok(/21/.test(p.d.getElementById('listingPhotoTime').textContent), 'selecting a thumbnail updates the upload time');
    p.click(p.d.querySelector('[data-act="media-view"]'));
    ok(!!p.d.querySelector('.media-viewer'), 'main photo opens a viewer');
    p.escape();
    ok(!p.d.querySelector('.media-viewer'), 'Escape closes the viewer');
  } finally { p.close(); }

  p = await openPage({ user: BUYER, hash: '#/listing/L1', routes: { ...baseRoutes(BUYER), 'GET /api/listings/L1': () => json(200, { ...listing, images: [] }) } });
  try {
    await sleep(100);
    ok(!p.d.querySelector('img[data-media-id]') && /Chưa có ảnh/.test(p.d.querySelector('.pd-gallery').textContent) && !p.d.documentElement.innerHTML.includes('evil.example'), 'listing without photos shows an honest placeholder, not the legacy image');
  } finally { p.close(); }

  p = await openPage({ user: BUYER, hash: '#/', routes: { ...baseRoutes(BUYER), ...imageRoutes, 'GET /api/listings': () => json(200, { listings: [listing, { ...listing, id: 'L2', images: [] }] }) } });
  try {
    await until(() => p.d.querySelectorAll('.pcard img[data-media-id][src^="blob:"]').length === 1);
    ok(p.d.querySelectorAll('.pcard img[data-media-id][src^="blob:"]').length === 1 && /Chưa có ảnh/.test(p.d.querySelector('#listingGrid').textContent), 'cards load the cover through authenticated Blob fetch; photo-less cards show a placeholder');
    p.w.location.hash = '#/orders';
    await sleep(150);
    ok(p.revoked.length === p.created.length && p.created.length > 0,'card blob URLs are revoked when the cards leave the page');
  } finally { p.close(); }

  // ---------- H: logout aborts the draft ----------
  p = await sellerForm({ 'POST /api/media/uploads': () => HANG, 'POST /api/passkeys/session/logout': () => json(200, { ok: true }) });
  try {
    p.pick([p.file('a.jpg')]);
    p.click(p.modal().querySelector('[data-act="save-listing"]'));
    await until(() => p.count('POST /api/media/uploads') === 1);
    const post = p.all('POST /api/media/uploads')[0];
    p.click(p.d.querySelector('[data-act="logout"]'));
    await until(() => post.aborted);
    ok(post.aborted && p.revoked.length === p.created.length && p.modal().innerHTML === '', 'logout aborts the upload, revokes previews and closes the modal');
    await sleep(80);
    ok(p.count('POST /api/listings') === 0, 'no listing is saved after logout');
  } finally { p.close(); }

  // ---------- I: dispute evidence: optional imageIds, transactionId, imageEvidence display ----------
  const tx = {
    id: 'tx1', buyerId: BUYER.id, sellerId: 's1', sellerName: 'Người bán', itemName: 'Máy ảnh cũ', amount: 900000, status: 'DISPUTED', escrowStatus: 'FROZEN', version: 3, createdAt: '2026-10-20T03:04:05.000Z',
    dispute: {
      id: 'd1', status: 'OPEN', openedBy: 'BUYER', type: 'DEFECT', reason: 'Hàng bị lỗi nặng', createdAt: '2026-10-21T03:04:05.000Z',
      imageEvidence: [{ id: uid(5), url: '/api/media/images/' + uid(5), width: 10, height: 10, bytes: 4, purpose: 'EVIDENCE', createdAt: '2026-10-21T03:00:00.000Z', uploadedBy: BUYER.id, actorId: BUYER.id, attachedAt: '2026-10-21T03:04:05.000Z' }],
    },
    disputeMessages: [],
  };
  // Backend (src/routes/transactions.js) returns imageEvidence at the top level of the transaction detail.
  tx.imageEvidence = tx.dispute.imageEvidence; delete tx.dispute.imageEvidence;
  const evId = uid(9);
  p = await openPage({
    user: BUYER, hash: '#/tx/tx1',
    routes: {
      ...baseRoutes(BUYER),
      ['GET /api/media/images/' + uid(5)]: () => ({ status: 200, bytes: WEBP, type: 'image/webp' }),
      'GET /api/transactions/tx1': () => json(200, tx),
      'GET /api/transactions/tx1/logs': () => json(200, { logs: [] }),
      'POST /api/media/uploads': (rec) => json(201, { id: evId, url: '/api/media/images/' + evId, width: 1, height: 1, bytes: 4, purpose: 'EVIDENCE', createdAt: '2026-10-22T03:04:05.000Z', uploadedBy: BUYER.id }),
      'POST /api/transactions/tx1/dispute/messages': () => json(200, { dispute: tx.dispute, transaction: tx }),
    },
  });
  try {
    await until(() => p.d.querySelector('.image-evidence'));
    const ev = p.d.querySelector('.image-evidence');
    ok(!!ev && /Người mua/.test(ev.textContent) && /Tải lên lúc/.test(ev.textContent) && /Gắn vào hồ sơ lúc/.test(ev.textContent) && /không chứng minh/.test(ev.textContent), 'imageEvidence[] shows actor, upload time, attach time and the authenticity note');
    await until(() => ev.querySelector('img[src^="blob:"]'));
    ok(!!ev.querySelector('img[src^="blob:"]'), 'evidence image is shown through an authenticated Blob URL');
    p.click(p.d.querySelector('[data-act="open-dispute-message"]'));
    await until(() => p.d.getElementById('mediaFiles'));
    p.d.getElementById('disputeMessage').value = 'Bổ sung ảnh chụp lỗi';
    p.pick([p.file('lỗi.png', 'image/png')]);
    p.click(p.modal().querySelector('[data-act="send-dispute-message"]'));
    await until(() => p.count('POST /api/transactions/tx1/dispute/messages') === 1);
    const up = p.all('POST /api/media/uploads')[0];
    ok(up.search.get('purpose') === 'EVIDENCE' && up.search.get('transactionId') === 'tx1' && up.headers['Content-Type'] === 'image/png', 'evidence upload targets EVIDENCE with the transactionId and exact MIME');
    const sent = JSON.parse(p.all('POST /api/transactions/tx1/dispute/messages')[0].body);
    ok(sent.message === 'Bổ sung ảnh chụp lỗi' && sent.imageIds.join() === evId, 'dispute message carries optional imageIds');
  } finally { p.close(); }

  // Evidence final JSON is also scoped by session and modal, not only the binary upload.
  const lateMessage=deferred();
  p=await openPage({user:BUYER,hash:'#/tx/tx1',routes:{...baseRoutes(BUYER),'GET /api/transactions/tx1':()=>json(200,tx),'GET /api/transactions/tx1/logs':()=>json(200,{logs:[]}),'POST /api/transactions/tx1/dispute/messages':()=>lateMessage.promise,'POST /api/passkeys/session/logout':()=>json(200,{ok:true})}});
  try {
    p.click(p.d.querySelector('[data-act="open-dispute-message"]'));p.d.getElementById('disputeMessage').value='Thông tin đang gửi trước khi đăng xuất';
    p.click(p.modal().querySelector('[data-act="send-dispute-message"]'));
    ok(await until(()=>p.count('POST /api/transactions/tx1/dispute/messages')===1),'message fixture reaches a final JSON write without requiring optional photos');
    p.click(p.d.querySelector('[data-act="logout"]'));
    ok(await until(()=>p.d.querySelector('[data-act="open-auth"]')),'logout exposes the public sign-in action');
    p.click(p.d.querySelector('[data-act="open-auth"]'));
    ok(!!p.d.getElementById('loginUsername'),'a new login dialog is open before the old message response');
    lateMessage.resolve(json(201,{dispute:tx.dispute,transaction:tx}));await sleep(120);
    ok(!!p.d.getElementById('loginUsername')&&!/Đã lưu nội dung bổ sung/.test(p.modal().textContent),'old message response cannot replace a new session dialog with its result popup');
  } finally {p.close();}

  console.log(`MEDIA UPLOAD UI: ${checks} checks passed (JSDOM + fake fetch only)`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
