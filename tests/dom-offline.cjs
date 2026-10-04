'use strict';

// Dependency-free behavior tests. Run: node --test tests/dom-offline.cjs
// All DOM, auth, storage and database operations are local mocks. No config.js,
// real credentials, network requests, remote writes or browser are used.
// These tests do not establish visual layout or real-browser accessibility.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const types = ['image', 'audio', 'video', 'writing', 'poetry', 'lyrics', 'pdf'];
const project = 'https://example.invalid';
const owner = 'test-owner';
const pendingPath = 'archive/00000000-0000-4000-8000-000000000001.text';
const recoveryKey = (url = project, id = owner) => `culture-archive-pending-v2:${url}:media:${id}`;
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let n = 0; n < 4; n++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const recovered = (stage = 'catalog', overrides = {}) => ({ stage, row: { title: 'Recovered poem', description: 'one\ntwo', content_type: 'poetry', file_path: pendingPath, ...overrides } });

function harness(options = {}) {
  const config = { supabaseUrl: project, supabaseKey: 'MOCK-NOT-A-CREDENTIAL', ownerUserId: owner, uploadsEnabled: true, maxFileBytes: 1024, ...options.config };
  const state = { rows: [], failLoad: false, failLookup: false, failUpload: false, failInsert: false, ambiguousInsert: false, userId: owner, ...options.state };
  const calls = { pages: [], lookups: [], inserts: [], uploads: [], storageWrites: [], removals: [], publicUrls: [], auth: 0 };
  const records = new Map(Object.entries(options.records || {}));
  if (Object.hasOwn(options, 'recovery')) records.set(recoveryKey(config.supabaseUrl, config.ownerUserId), typeof options.recovery === 'string' ? options.recovery : JSON.stringify(options.recovery));
  let activeElement = null;

  class Element {
    constructor(tag = 'div', id = '') {
      this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.attributes = {}; this.listeners = new Map();
      this.value = ''; this.files = []; this.hidden = false; this.disabled = false; this.dataset = {}; this._text = '';
      const classes = new Set();
      this.classList = { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } };
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(_) { throw new Error('Unsafe innerHTML write: test DOM permits text-only rendering.'); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this._text = ''; this.children = children; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, listener, settings = {}) { const list = this.listeners.get(name) || []; list.push({ listener, once: settings.once }); this.listeners.set(name, list); }
    emit(name) {
      const listeners = [...(this.listeners.get(name) || [])];
      this.listeners.set(name, (this.listeners.get(name) || []).filter(item => !item.once));
      const event = { type: name, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      return Promise.all(listeners.map(({ listener }) => listener(event)));
    }
    focus() { activeElement = this; }
  }

  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const element = new Element(match[1], match[3]);
    for (const attribute of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attribute[1], attribute[2]);
    element.hidden = /(?:^|\s)hidden(?:\s|$)/.test(match[2]);
    element.disabled = /(?:^|\s)disabled(?:\s|$)/.test(match[2]);
    elements.set(element.id, element);
  }
  const $ = id => { assert.ok(elements.has(id), `Missing HTML element #${id}`); return elements.get(id); };
  const filters = ['all', ...types].map(type => { const button = new Element('button'); button.dataset.type = type; button.setAttribute('aria-pressed', String(type === 'all')); return button; });
  $('item-type').value = 'image';
  $('upload-form').reset = () => { for (const id of ['item-title', 'item-description', 'item-file']) $(id).value = ''; $('item-file').files = []; $('item-type').value = 'image'; };
  const sessionStorage = {
    getItem(key) { if (state.storageReadError) throw new Error('Storage read unavailable'); return records.get(key) ?? null; },
    setItem(key, value) { if (state.storageWriteError) throw new Error('Storage write unavailable'); calls.storageWrites.push({ key, value }); records.set(key, value); },
    removeItem(key) { if (state.storageRemoveError) throw new Error('Storage cleanup unavailable'); calls.removals.push(key); records.delete(key); }
  };
  const client = {
    auth: {
      async getUser() { calls.auth++; if (state.authGate) await state.authGate.promise; if (state.authThrow) throw new Error('Auth unavailable'); return { data: { user: state.userId ? { id: state.userId } : null }, error: state.authError ? { message: 'Auth rejected' } : null }; },
      onAuthStateChange(callback) { state.authCallback = callback; }
    },
    storage: { from(bucket) {
      assert.equal(bucket, 'media');
      return {
        getPublicUrl(filePath) { calls.publicUrls.push(filePath); return { data: { publicUrl: state.urlOverride || `${config.supabaseUrl}/storage/v1/object/public/media/${filePath}` } }; },
        async upload(filePath, body, settings) {
          calls.uploads.push({ filePath, body, settings: plain(settings), recoveryAtUpload: records.get(recoveryKey(config.supabaseUrl, config.ownerUserId)) });
          if (state.uploadGate) await state.uploadGate.promise;
          if (state.uploadThrow) throw new Error('Connection interrupted');
          return { error: state.failUpload ? { message: 'Upload failed' } : null };
        }
      };
    } },
    from(table) {
      assert.equal(table, 'media_items'); let filterPath;
      const query = {
        select() { return query; }, order() { return query; },
        async range(start, end) { calls.pages.push([start, end]); if (state.loadGate) await state.loadGate.promise; if (state.loadThrow) throw new Error('Load failed'); return state.failLoad ? { error: { message: 'Load failed' } } : { data: state.rows.slice(start, end + 1), error: null }; },
        eq(column, value) { assert.equal(column, 'file_path'); filterPath = value; return query; },
        async limit(count) { calls.lookups.push(filterPath); if (state.lookupGate) await state.lookupGate.promise; return state.failLookup ? { error: { message: 'Lookup failed' } } : { data: state.rows.filter(row => row.file_path === filterPath).slice(0, count).map(row => ({ id: row.id })), error: null }; },
        async insert(row) { calls.inserts.push(plain(row)); if (!state.failInsert || state.ambiguousInsert) state.rows.unshift({ ...plain(row), id: calls.inserts.length }); if (state.insertThrow) throw new Error('Insert response lost'); return { error: state.failInsert ? { message: 'Insert failed' } : null }; }
      }; return query;
    }
  };
  const window = { ARCHIVE_CONFIG: config };
  if (!options.missingSDK) window.supabase = { createClient() { if (state.clientThrow) throw new Error('Bad configuration'); return client; } };
  vm.runInNewContext(source, { window, document: { getElementById: $, createElement: tag => new Element(tag), querySelectorAll: selector => { assert.equal(selector, '[data-type]'); return filters; } }, sessionStorage, URL, Blob, crypto: { randomUUID }, setTimeout }, { filename: 'app.js' });
  const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
  return {
    $, config, state, calls, records, filters, ready: flush,
    activeElement: () => activeElement,
    cards: () => $('library-items').children,
    nodes: tag => descendants($('library-items')).filter(element => element.tagName === tag.toUpperCase()),
    click: id => $(id).disabled ? Promise.resolve() : $(id).emit('click'),
    category: type => filters.find(button => button.dataset.type === type).emit('click'),
    search: value => { $('search').value = value; return $('search').emit('input'); },
    submit: () => $('upload-form').emit('submit'),
    fill(values = {}) { const defaults = { title: 'Test poem', type: 'poetry', description: 'one\ntwo', files: [] }; const v = { ...defaults, ...values }; $('item-title').value = v.title; $('item-type').value = v.type; $('item-description').value = v.description; $('item-file').files = v.files; return $('item-type').emit('change'); }
  };
}

test('HTML has labels, live status, expanded-state and initially gated upload controls', () => {
  const h = harness();
  for (const id of ['search', 'item-title', 'item-type', 'item-description', 'item-file']) assert.match(html, new RegExp(`for="${id}"`));
  assert.equal(h.$('upload-form').hidden, true);
  assert.equal(h.$('show-form-button').disabled, true);
  assert.equal(h.$('show-form-button').getAttribute('aria-controls'), 'upload-form');
  for (const id of ['library-status', 'save-status', 'upload-availability']) assert.equal(h.$(id).getAttribute('aria-live'), 'polite');
});

test('paused uploads and non-owner/auth errors reject even direct submit without writes', async () => {
  for (const options of [{ config: { uploadsEnabled: false } }, { state: { userId: 'another-user' } }, { state: { userId: null } }, { state: { authError: true } }, { state: { authThrow: true } }]) {
    const h = harness(options); await h.ready(); await h.fill(); await h.submit();
    assert.equal(h.$('show-form-button').disabled, true); assert.equal(h.calls.uploads.length, 0); assert.equal(h.calls.inserts.length, 0);
    assert.match(h.$('save-status').textContent, /Owner access/);
  }
});

test('empty state, all seven categories, case-insensitive title/description search and media controls', async () => {
  const h = harness(); await h.ready(); assert.match(h.$('library-status').textContent, /empty/);
  h.state.rows = types.map((type, id) => ({ id, title: type, content_type: type, description: `needle-${type}`, file_path: `archive/${type}.file` }));
  await h.click('refresh-button'); assert.equal(h.cards().length, 7);
  for (const type of types) { await h.category(type); assert.equal(h.cards().length, 1); assert.equal(h.cards()[0].children[0].textContent, type); assert.equal(h.filters.find(b => b.dataset.type === type).getAttribute('aria-pressed'), 'true'); }
  await h.category('all'); await h.search('NEEDLE-POETRY'); assert.equal(h.cards().length, 1);
  await h.search('no match'); assert.match(h.$('library-status').textContent, /No matching/);
  await h.search('');
  assert.equal(h.nodes('img').length, 1); assert.equal(h.nodes('audio')[0].controls, true); assert.equal(h.nodes('video')[0].controls, true);
  assert.equal(h.nodes('video')[0].playsInline, true); assert.equal(h.nodes('audio')[0].preload, 'none');
  for (const link of h.nodes('a')) { assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer'); assert.match(link.getAttribute('aria-label'), /opens in a new tab/); }
});

test('rendering retains injection strings as text and rejects traversal, foreign and insecure URLs', async () => {
  const h = harness({ state: { rows: [{ title: '<img src=x onerror=attack()>', description: '<script>attack()</script>\nsecond line', content_type: 'writing', file_path: '../evil' }] } });
  await h.ready(); assert.equal(h.nodes('img').length, 0); assert.equal(h.nodes('script').length, 0); assert.equal(h.nodes('a').length, 0);
  assert.match(h.cards()[0].textContent, /<script>attack\(\)<\/script>/);
  for (const filePath of ['/absolute', 'archive/../private', 'archive/./file', 'archive/%2e%2e/%2e%2e/private']) { h.state.rows[0].file_path = filePath; await h.click('refresh-button'); assert.equal(h.nodes('a').length, 0); }
  h.state.rows[0].file_path = 'archive/safe.txt';
  for (const url of ['https://attacker.invalid/storage/v1/object/public/media/file', 'http://example.invalid/storage/v1/object/public/media/file', `${project}/storage/v1/object/public/private/file`]) { h.state.urlOverride = url; await h.click('refresh-button'); assert.equal(h.nodes('a').length, 0); }
});

test('media failure hides preview and appends a single fallback while keeping the file link', async () => {
  const h = harness({ state: { rows: [{ title: 'Photo', content_type: 'image', file_path: 'archive/photo.png' }] } }); await h.ready();
  const image = h.nodes('img')[0]; await image.emit('error'); await image.emit('error');
  assert.equal(image.hidden, true); assert.equal(h.cards()[0].textContent.match(/Preview unavailable/g).length, 1); assert.equal(h.nodes('a').length, 1);
});

test('loading and load/init errors survive filter/search; refresh recovers and busy clears', async () => {
  const gate = deferred(); const h = harness({ state: { loadGate: gate } });
  await h.search('query'); await h.category('poetry'); assert.equal(h.$('library-status').textContent, 'Loading archive…'); assert.equal(h.$('library-items').getAttribute('aria-busy'), 'true');
  h.state.failLoad = true; gate.resolve(); await h.ready();
  const error = h.$('library-status').textContent; assert.match(error, /Could not load/);
  await h.search(''); await h.category('all'); assert.equal(h.$('library-status').textContent, error); assert.equal(h.$('refresh-button').disabled, false); assert.equal(h.$('library-items').getAttribute('aria-busy'), 'false');
  h.state.failLoad = false; await h.click('refresh-button'); assert.match(h.$('library-status').textContent, /empty/);
  for (const options of [{ missingSDK: true }, { config: { supabaseUrl: '' } }, { state: { clientThrow: true } }]) {
    const broken = harness(options); await broken.ready(); await broken.search('anything'); await broken.category('audio'); assert.match(broken.$('library-status').textContent, /could not start/); assert.equal(broken.$('refresh-button').disabled, true);
  }
});

test('pagination fetches subsequent pages without truncating at 500 items', async () => {
  const h = harness({ state: { rows: Array.from({ length: 1001 }, (_, id) => ({ id, title: `Item ${id}`, content_type: 'writing', description: '', file_path: null })) } }); await h.ready();
  assert.equal(h.cards().length, 1001); assert.deepEqual(h.calls.pages, [[0, 499], [500, 999], [1000, 1499]]);
});

test('validation rejects missing/long title, unsupported type, long text, missing file and bad/empty/oversize file', async () => {
  const cases = [
    [{ title: ' ' }, /title/], [{ title: 'a'.repeat(201) }, /title/], [{ type: '__proto__' }, /valid type/],
    [{ description: 'a'.repeat(20001) }, /20,000/], [{ description: '' }, /Choose a file/], [{ type: 'image', description: '' }, /Choose a file/],
    [{ type: 'image', files: [{ name: 'bad.html', size: 1 }] }, /format/], [{ type: 'image', files: [{ name: 'empty.png', size: 0 }] }, /nonempty/], [{ type: 'image', files: [{ name: 'large.png', size: 1025 }] }, /nonempty/]
  ];
  for (const [values, message] of cases) {
    const h = harness(); await h.ready(); await h.click('show-form-button'); await h.fill(values); await h.submit();
    assert.match(h.$('save-status').textContent, message); assert.equal(h.calls.uploads.length, 0); assert.equal(h.calls.inserts.length, 0); assert.equal(h.$('item-fields').disabled, false); assert.equal(h.$('save-item-button').disabled, false);
    assert.equal(h.activeElement().getAttribute('aria-invalid'), 'true');
    assert.match(h.activeElement().getAttribute('aria-describedby') || '', /save-status/);
  }
});

test('cancel/reopen resets an unsaved form and restores sensible focus/expanded state', async () => {
  const h = harness(); await h.ready(); await h.click('show-form-button');
  assert.equal(h.$('upload-form').hidden, false); assert.equal(h.activeElement().id, 'item-title'); assert.equal(h.$('show-form-button').getAttribute('aria-expanded'), 'true');
  await h.fill(); await h.click('cancel-button');
  assert.equal(h.$('upload-form').hidden, true); assert.equal(h.activeElement().id, 'show-form-button'); assert.equal(h.$('show-form-button').getAttribute('aria-expanded'), 'false');
  await h.click('show-form-button'); assert.equal(h.$('item-title').value, ''); assert.equal(h.$('item-description').value, ''); assert.equal(h.$('item-type').value, 'image');
});

test('text-only save persists recovery before upload and ignores duplicate submits/cancel while busy', async () => {
  const gate = deferred(); const h = harness({ state: { uploadGate: gate } }); await h.ready(); await h.click('show-form-button'); await h.fill();
  const first = h.submit(); const second = h.submit(); await h.ready();
  assert.equal(h.calls.uploads.length, 1); assert.equal(h.$('item-fields').disabled, true); assert.equal(h.$('save-item-button').disabled, true); assert.equal(h.$('cancel-button').disabled, true);
  await h.$('cancel-button').emit('click'); assert.equal(h.$('upload-form').hidden, false);
  const upload = h.calls.uploads[0]; assert.equal(JSON.parse(upload.recoveryAtUpload).stage, 'uploading'); assert.deepEqual(upload.settings, { upsert: false }); assert.equal(await upload.body.text(), 'one\ntwo'); assert.match(upload.filePath, /^archive\/[0-9a-f-]+\.text$/);
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(h.calls.inserts.length, 1); assert.equal(h.cards().length, 1); assert.equal(h.records.has(recoveryKey()), false); assert.equal(h.$('upload-form').hidden, true); assert.match(h.$('upload-availability').textContent, /Item saved/);
});

test('file save keeps binary body, sanitizes filename and accepts case-insensitive extensions at exact limit', async () => {
  const h = harness(); await h.ready(); const file = { name: '../strange name.PNG', size: 1024, type: 'image/png' }; await h.fill({ type: 'image', description: '', files: [file] }); await h.submit();
  assert.equal(h.calls.uploads[0].body, file); assert.match(h.calls.uploads[0].filePath, /^archive\/[0-9a-f-]+_\.\._strange_name\.PNG$/); assert.equal(h.calls.inserts.length, 1);
});

test('lookup failure retains catalog recovery; cancel/reopen and retry never upload twice', async () => {
  const h = harness({ state: { failLookup: true } }); await h.ready(); await h.click('show-form-button'); await h.fill(); await h.submit();
  assert.match(h.$('save-status').textContent, /could not be checked/); assert.equal(h.calls.uploads.length, 1); assert.equal(h.calls.inserts.length, 0); assert.equal(JSON.parse(h.records.get(recoveryKey())).stage, 'catalog');
  await h.click('cancel-button'); await h.click('show-form-button'); assert.equal(h.$('item-title').value, 'Test poem'); assert.equal(h.$('item-fields').disabled, true); assert.equal(h.$('save-item-button').disabled, false);
  h.state.failLookup = false; await h.submit(); assert.equal(h.calls.uploads.length, 1); assert.equal(h.calls.inserts.length, 1); assert.equal(h.records.has(recoveryKey()), false);
});

test('definite insert error can retry catalog save without reupload', async () => {
  const h = harness({ state: { failInsert: true } }); await h.ready(); await h.fill(); await h.submit(); assert.match(h.$('save-status').textContent, /not confirmed/); assert.equal(h.state.rows.length, 0);
  h.state.failInsert = false; await h.submit(); assert.equal(h.calls.uploads.length, 1); assert.equal(h.calls.inserts.length, 2); assert.equal(h.state.rows.length, 1);
});

test('uncertain insert response reads back successful row instead of inserting twice', async () => {
  for (const throwResponse of [false, true]) {
    const h = harness({ state: { failInsert: true, ambiguousInsert: true, insertThrow: throwResponse } }); await h.ready(); await h.fill(); await h.submit();
    assert.equal(h.state.rows.length, 1); assert.equal(h.records.has(recoveryKey()), true);
    h.state.insertThrow = false; await h.submit(); assert.equal(h.calls.uploads.length, 1); assert.equal(h.calls.inserts.length, 1); assert.equal(h.state.rows.length, 1); assert.equal(h.records.has(recoveryKey()), false);
  }
});

test('uncertain upload blocks retries and survives cancel/reopen without another write', async () => {
  for (const state of [{ failUpload: true }, { uploadThrow: true }]) {
    const h = harness({ state }); await h.ready(); await h.click('show-form-button'); await h.fill(); await h.submit();
    assert.equal(JSON.parse(h.records.get(recoveryKey())).stage, 'uploading'); assert.equal(h.$('save-item-button').disabled, true);
    await h.click('cancel-button'); await h.click('show-form-button'); await h.submit(); assert.equal(h.calls.uploads.length, 1); assert.equal(h.calls.inserts.length, 0); assert.equal(h.$('item-fields').disabled, true);
  }
});

test('recovered catalog strips extra fields and finishes without uploading; recovered uploading stays blocked', async () => {
  const h = harness({ recovery: recovered('catalog', { unexpected_column: 'do not insert', owner_id: 'do not insert' }) }); await h.ready(); await h.click('show-form-button');
  assert.equal(h.$('item-title').value, 'Recovered poem'); assert.equal(h.$('item-fields').disabled, true);
  assert.equal(h.$('recovery-details').hidden, false); assert.match(h.$('recovery-path').textContent, /Stage: catalog/); assert.ok(h.$('recovery-path').textContent.includes(pendingPath));
  await h.submit(); assert.equal(h.$('recovery-details').hidden, true);
  assert.equal(h.calls.uploads.length, 0); assert.deepEqual(Object.keys(h.calls.inserts[0]).sort(), ['content_type', 'description', 'file_path', 'title']);
  const blocked = harness({ recovery: recovered('uploading') }); await blocked.ready(); await blocked.click('show-form-button'); await blocked.submit();
  assert.equal(blocked.$('save-item-button').disabled, true); assert.equal(blocked.calls.uploads.length, 0); assert.equal(blocked.calls.inserts.length, 0);
});

test('malformed or invalid recovery fails closed without erasing unresolved data', async () => {
  const records = ['{invalid', 'null', {}, recovered('bad'), recovered('catalog', { title: '' }), recovered('catalog', { title: 'a'.repeat(201) }), recovered('catalog', { description: null }), recovered('catalog', { description: 'a'.repeat(20001) }), recovered('catalog', { content_type: '__proto__' }), recovered('catalog', { file_path: 'archive/../bad' }), recovered('catalog', { file_path: 'archive/no-uuid.txt' })];
  for (const recovery of records) {
    const h = harness({ recovery }); await h.ready(); const before = h.records.get(recoveryKey()); await h.fill(); await h.submit();
    assert.equal(h.$('show-form-button').disabled, true); assert.match(h.$('upload-availability').textContent, /owner review/i); assert.equal(h.calls.uploads.length, 0); assert.equal(h.calls.inserts.length, 0); assert.equal(h.records.get(recoveryKey()), before);
  }
});

test('recovery keys isolate project and owner, leaving unrelated records untouched', async () => {
  const otherProject = recoveryKey('https://other.invalid', owner); const otherOwner = recoveryKey(project, 'other-owner'); const raw = JSON.stringify(recovered());
  const h = harness({ records: { [otherProject]: raw, [otherOwner]: raw } }); await h.ready(); await h.fill(); await h.submit();
  assert.equal(h.calls.uploads.length, 1); assert.equal(h.calls.inserts[0].title, 'Test poem'); assert.equal(h.records.get(otherProject), raw); assert.equal(h.records.get(otherOwner), raw);
  assert.ok(h.calls.storageWrites.every(entry => entry.key === recoveryKey()));
});

test('unavailable recovery reads or writes prevent any upload', async () => {
  for (const state of [{ storageReadError: true }, { storageWriteError: true }]) { const h = harness({ state }); await h.ready(); await h.fill(); await h.submit(); assert.equal(h.calls.uploads.length, 0); assert.equal(h.calls.inserts.length, 0); }
});

test('cleanup failure retains retryable recovery without causing duplicate insert', async () => {
  const h = harness({ state: { storageRemoveError: true } }); await h.ready(); await h.fill(); await h.submit();
  assert.equal(h.state.rows.length, 1); assert.equal(h.records.has(recoveryKey()), true); h.state.storageRemoveError = false; await h.submit();
  assert.equal(h.calls.uploads.length, 1); assert.equal(h.calls.inserts.length, 1); assert.equal(h.records.has(recoveryKey()), false);
});

test('save success stays distinct from a later refresh failure and allows subsequent recovery', async () => {
  const h = harness(); await h.ready(); h.state.failLoad = true; await h.fill(); await h.submit();
  assert.equal(h.calls.inserts.length, 1); assert.equal(h.$('upload-form').hidden, true); assert.match(h.$('upload-availability').textContent, /Item saved/); assert.match(h.$('library-status').textContent, /Could not load/); assert.equal(h.records.has(recoveryKey()), false);
  h.state.failLoad = false; await h.click('refresh-button'); assert.equal(h.cards().length, 1);
});
