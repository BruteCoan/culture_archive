/* Plain browser app. Supabase RLS and bucket policies, not this UI, enforce access. */
(() => {
  'use strict';
  const config = window.ARCHIVE_CONFIG || {};
  const $ = id => document.getElementById(id);
  const labels = { image: 'Image', audio: 'Audio', video: 'Video', writing: 'Writing', poetry: 'Poetry', lyrics: 'Lyrics', pdf: 'PDF Book' };
  const textTypes = ['writing', 'poetry', 'lyrics'];
  const accepts = { image: '.jpg,.jpeg,.png,.gif,.webp,.avif', audio: '.mp3,.wav,.ogg,.m4a,.flac', video: '.mp4,.webm,.mov', writing: '.txt,.md,.pdf', poetry: '.txt,.md,.pdf', lyrics: '.txt,.md,.pdf', pdf: '.pdf' };
  const maxBytes = Number.isFinite(config.maxFileBytes) && config.maxFileBytes > 0 ? config.maxFileBytes : 50 * 1024 * 1024;
  const recoveryKey = `culture-archive-pending-v2:${config.supabaseUrl}:media:${config.ownerUserId}`;
  let client, items = [], filter = 'all', busy = false, pending = null, canUpload = false, request = 0, loadState = 'loading', recoveryBlocked = false;
  const status = (id, message, error = false) => { $(id).textContent = message; $(id).classList.toggle('error', error); };
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
  function publicUrl(path) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').some(x => x === '..' || x === '.')) return null;
    try {
      const url = new URL(client.storage.from('media').getPublicUrl(path).data.publicUrl);
      const base = new URL(config.supabaseUrl);
      return url.protocol === 'https:' && url.origin === base.origin && url.pathname.startsWith('/storage/v1/object/public/media/') ? url.href : null;
    } catch { return null; }
  }
  function render() {
    if (loadState !== 'ready') return;
    const query = $('search').value.trim().toLocaleLowerCase();
    const visible = items.filter(item => (filter === 'all' || item.content_type === filter) && `${item.title || ''}\n${item.description || ''}`.toLocaleLowerCase().includes(query));
    $('library-items').replaceChildren();
    for (const item of visible) {
      const card = node('article', undefined, 'card');
      card.append(node('h3', item.title || 'Untitled'), node('p', labels[item.content_type] || 'File', 'kind'));
      if (item.description) card.append(node('p', item.description, 'description'));
      const url = publicUrl(item.file_path);
      if (url) {
        let media;
        if (item.content_type === 'image') { media = node('img'); media.alt = item.title || 'Archive image'; media.loading = 'lazy'; }
        if (item.content_type === 'audio' || item.content_type === 'video') { media = node(item.content_type); media.controls = true; media.preload = 'none'; if (item.content_type === 'video') media.playsInline = true; media.setAttribute('aria-label', item.title || labels[item.content_type]); }
        if (media) {
          media.src = url;
          media.addEventListener('error', () => { media.hidden = true; card.append(node('p', 'Preview unavailable. Try the file link below.')); }, { once: true });
          card.append(media);
        }
        const link = node('a', item.content_type === 'pdf' ? 'Open PDF ↗' : 'Open file ↗');
        link.setAttribute('aria-label', `${item.title || 'Archive item'}: open file (opens in a new tab)`);
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; const linkRow = node('p'); linkRow.append(link); card.append(linkRow);
      } else if (item.file_path) card.append(node('p', 'File link unavailable.'));
      $('library-items').append(card);
    }
    status('library-status', visible.length ? `${visible.length} ${visible.length === 1 ? 'item' : 'items'}` : (items.length ? 'No matching items. Try another type or search.' : 'The archive is empty.'));
  }
  async function load() {
    const token = ++request; loadState = 'loading';
    $('library-items').setAttribute('aria-busy', 'true'); $('refresh-button').disabled = true;
    status('library-status', 'Loading archive…');
    try {
      // Explicit paging avoids silently truncating libraries at Supabase's row limit.
      let all = [], start = 0;
      while (true) {
        const { data, error } = await client.from('media_items').select('id,title,description,content_type,file_path,created_at').order('created_at', { ascending: false }).order('id', { ascending: false }).range(start, start + 499);
        if (error) throw error;
        if (token !== request) return;
        all.push(...(data || []));
        if (!data || data.length < 500) break;
        start += 500;
      }
      items = all; loadState = 'ready'; render();
    } catch {
      if (token === request) { loadState = 'error'; items = []; $('library-items').replaceChildren(); status('library-status', 'Could not load the archive. Check your connection and try Refresh.', true); }
    } finally { if (token === request) { $('library-items').setAttribute('aria-busy', 'false'); $('refresh-button').disabled = false; } }
  }
  async function ownerAllowed() {
    if (recoveryBlocked || config.uploadsEnabled !== true || !config.ownerUserId || !client) return false;
    try { const { data, error } = await client.auth.getUser(); return !error && data?.user?.id === config.ownerUserId; } catch { return false; }
  }
  async function checkAccess() {
    canUpload = await ownerAllowed();
    $('show-form-button').disabled = !canUpload;
    status('upload-availability', recoveryBlocked ? 'Uploads paused: browser recovery data needs owner review before another save.' : canUpload ? 'Owner uploads enabled. Only upload files you have permission to share publicly.' : 'Uploads are paused pending owner access and storage-policy review.');
    if (!canUpload && !busy) { $('upload-form').hidden = true; $('show-form-button').setAttribute('aria-expanded', 'false'); }
  }
  function fileHelp() {
    const type = $('item-type').value;
    $('item-file').accept = accepts[type] || '';
    status('file-help', `${accepts[type] || ''}. Up to ${Math.floor(maxBytes / 1024 / 1024)} MB. ${textTypes.includes(type) ? 'Paste text above, attach a file, or both.' : 'A file is required.'}`);
  }
  function remember() {
    // Persist BEFORE writes. If storage is blocked, do not risk an untracked retry.
    sessionStorage.setItem(recoveryKey, JSON.stringify(pending));
  }
  function syncForm() {
    $('recovery-details').hidden = !pending;
    $('recovery-path').textContent = pending ? `Stage: ${pending.stage}\nFile: ${pending.row.file_path}\nTitle: ${pending.row.title}` : '';
    $('item-fields').disabled = busy || !!pending;
    $('save-item-button').disabled = busy || pending?.stage === 'uploading';
    $('cancel-button').disabled = busy;
    $('save-item-button').textContent = busy ? 'Saving…' : pending ? 'Check and finish save' : 'Add to Archive';
  }
  function close() {
    if (busy) return;
    $('upload-form').hidden = true; $('show-form-button').setAttribute('aria-expanded', 'false');
    if (!pending) { $('upload-form').reset(); status('save-status', ''); fileHelp(); }
    $('show-form-button').focus();
  }
  function validate() {
    const invalid = (message, field) => { const error = new Error(message); error.field = field; throw error; };
    const title = $('item-title').value.trim(), type = $('item-type').value, description = $('item-description').value.trim(), file = $('item-file').files[0];
    if (!title || title.length > 200) invalid('Enter a title of 1–200 characters.', 'item-title');
    if (!Object.hasOwn(labels, type)) invalid('Choose a valid type.', 'item-type');
    if (description.length > 20000) invalid('Keep the text under 20,000 characters.', 'item-description');
    if (!file && (!textTypes.includes(type) || !description)) invalid('Choose a file, or paste text for writing, poetry, or lyrics.', 'item-file');
    if (file) {
      const ext = '.' + file.name.split('.').pop().toLowerCase();
      if (!accepts[type].split(',').includes(ext)) invalid('That file format does not match the selected type.', 'item-file');
      if (!file.size || file.size > maxBytes) invalid(`Choose a nonempty file up to ${Math.floor(maxBytes / 1024 / 1024)} MB.`, 'item-file');
    }
    return { title, content_type: type, description, file };
  }
  async function save(event) {
    event.preventDefault();
    if (busy || recoveryBlocked || pending?.stage === 'uploading') return;
    let invalidField;
    ['item-title','item-type','item-description','item-file'].forEach(id => $(id).removeAttribute('aria-invalid'));
    busy = true; syncForm(); status('save-status', 'Checking owner access…');
    try {
      if (!(await ownerAllowed())) throw new Error('Owner access is unavailable. Your item has not been submitted.');
      if (!pending) {
        const value = validate(), file = value.file;
        const path = `archive/${crypto.randomUUID()}${file ? '_' + file.name.replace(/[^a-zA-Z0-9._-]/g, '_') : '.text'}`;
        // Text-only entries also store a UTF-8 text file, preserving the existing non-null file_path schema.
        const body = file || new Blob([value.description], { type: 'text/plain;charset=utf-8' });
        pending = { stage: 'uploading', row: { title: value.title, content_type: value.content_type, description: value.description, file_path: path } };
        try { remember(); } catch { pending = null; throw new Error('Browser recovery storage is unavailable. Allow session storage before uploading.'); }
        status('save-status', 'Uploading file…');
        const { error } = await client.storage.from('media').upload(path, body, { upsert: false });
        if (error) throw new Error('Upload could not be confirmed. Do not upload again; have the owner check the pending file path shown under Recovery details below.');
        pending.stage = 'catalog'; remember();
      }
      status('save-status', 'Checking saved item…');
      // Read-back before retry handles a successful insert whose response was lost.
      const { data, error } = await client.from('media_items').select('id').eq('file_path', pending.row.file_path).limit(1);
      if (error) throw new Error('The file is uploaded, but its archive entry could not be checked. Use Check and finish save when the connection returns.');
      if (!data?.length) {
        const { error: insertError } = await client.from('media_items').insert(pending.row);
        if (insertError) throw new Error('The file is uploaded, but its archive entry was not confirmed. Use Check and finish save; the file will not upload again.');
      }
      sessionStorage.removeItem(recoveryKey); pending = null;
      $('upload-form').reset(); filter = 'all'; $('search').value = '';
      document.querySelectorAll('[data-type]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.type === filter)));
      status('save-status', 'Item added to the archive.');
      await load();
      // Keep success separate from a possible refresh failure.
      status('upload-availability', loadState === 'ready' ? 'Item saved to the archive.' : 'Item saved. It will appear when the library refresh succeeds.');
      busy = false; close();
    } catch (error) { invalidField = error.field; if (invalidField) $(invalidField).setAttribute('aria-invalid', 'true'); status('save-status', error.message || 'Save interrupted. Keep this tab open and check the pending item before trying again.', true); }
    finally { busy = false; syncForm(); if (invalidField) $(invalidField).focus(); }
  }
  document.querySelectorAll('[data-type]').forEach(button => button.addEventListener('click', () => {
    filter = button.dataset.type;
    document.querySelectorAll('[data-type]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    render();
  }));
  $('search').addEventListener('input', render);
  $('refresh-button').addEventListener('click', load);
  $('item-type').addEventListener('change', fileHelp);
  $('cancel-button').addEventListener('click', close);
  $('upload-form').addEventListener('submit', save);
  $('show-form-button').addEventListener('click', () => {
    if (!canUpload) return;
    $('upload-form').hidden = false; $('show-form-button').setAttribute('aria-expanded', 'true');
    syncForm(); (pending ? $('cancel-button') : $('item-title')).focus();
  });
  fileHelp();
  try {
    const raw = sessionStorage.getItem(recoveryKey);
    if (raw) {
      const record = JSON.parse(raw);
      const row = record.row;
      if (!['uploading', 'catalog'].includes(record.stage) || typeof row?.title !== 'string' || !row.title.trim() || row.title.length > 200 || typeof row.description !== 'string' || row.description.length > 20000 || typeof row.file_path !== 'string' || !/^archive\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:_[a-zA-Z0-9._-]+|\.text)$/.test(row.file_path) || typeof row.content_type !== 'string' || !Object.hasOwn(labels, row.content_type)) throw new Error('Invalid recovery record');
      pending = { stage: record.stage, row: { title: row.title, description: row.description, content_type: row.content_type, file_path: row.file_path } };
      $('item-title').value = pending.row.title; $('item-type').value = pending.row.content_type; $('item-description').value = pending.row.description; fileHelp();
      status('save-status', pending.stage === 'catalog' ? 'An unfinished save was recovered. Check and finish it without uploading again.' : 'An upload was interrupted. Ask the owner to reconcile the file shown under Recovery details before adding another item.', true);
    }
  } catch { recoveryBlocked = true; status('upload-availability', 'Recovery storage is unavailable or invalid. Owner review is required before uploading.'); }
  try {
    if (!window.supabase || !config.supabaseUrl || !config.supabaseKey) throw new Error('Missing configuration');
    client = window.supabase.createClient(config.supabaseUrl, config.supabaseKey);
    load(); checkAccess();
    client.auth.onAuthStateChange(() => { setTimeout(checkAccess, 0); });
  } catch {
    loadState = 'error';
    status('library-status', 'The archive connection could not start. Check configuration or your internet connection, then reload.', true);
    $('refresh-button').disabled = true;
  }
})();
