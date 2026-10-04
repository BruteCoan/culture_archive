const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const mock = () => {
  window.testState = { rows: [], uploads: 0, inserts: 0, failLoad: false, failInsert: false, ambiguousInsert: false, failUpload: false, delay: 0 };
  window.supabase = { createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner' } } }), onAuthStateChange: () => {} },
    storage: { from: () => ({ getPublicUrl: p => ({ data: { publicUrl: 'https://example.supabase.co/storage/v1/object/public/media/' + p } }), upload: async () => { testState.uploads++; await new Promise(r => setTimeout(r, testState.delay)); return { error: testState.failUpload ? { message: 'offline' } : null }; } }) },
    from: () => {
      let filter, from = 0, to = 499;
      const query = { select: () => query, order: () => query, eq: (_, value) => { filter = value; return query; }, range: (a, b) => { from = a; to = b; return query; }, limit: () => query,
        then: (resolve, reject) => Promise.resolve(testState.failLoad ? { error: { message: 'offline' } } : { data: testState.rows.filter(r => !filter || r.file_path === filter).slice(from, to + 1) }).then(resolve, reject),
        insert: async row => { testState.inserts++; if (!testState.failInsert || testState.ambiguousInsert) testState.rows.unshift({ ...row, id: testState.inserts }); return { error: testState.failInsert ? { message: 'offline' } : null }; }
      }; return query;
    }
  }) };
};
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.includes('cdn.jsdelivr.net')) return route.fulfill({ contentType: 'text/javascript', body: `(${mock.toString()})();` });
    if (url.endsWith('/config.js')) return route.fulfill({ contentType: 'text/javascript', body: 'window.ARCHIVE_CONFIG={supabaseUrl:"https://example.supabase.co",supabaseKey:"mock",uploadsEnabled:true,ownerUserId:"owner",maxFileBytes:1048576};' });
    if (url.startsWith('http://archive.test/')) { const name = new URL(url).pathname.slice(1) || 'index.html'; return route.fulfill({ path: path.join(root, name) }); }
    return route.abort();
  });
  await page.goto('http://archive.test/');
  await page.waitForFunction(() => !document.querySelector('#show-form-button').disabled);
  assert.match(await page.locator('#library-status').innerText(), /empty/);
  await page.evaluate(() => { testState.rows = ['image','audio','video','writing','poetry','lyrics','pdf'].map((type,i) => ({ id:i, title:type, content_type:type, description:'sample '+type, file_path:type+'.file' })); });
  await page.click('#refresh-button'); await page.waitForFunction(() => document.querySelectorAll('.card').length === 7);
  for (const type of ['image','audio','video','writing','poetry','lyrics','pdf']) { await page.click(`[data-type="${type}"]`); assert.equal(await page.locator('.card').count(), 1); assert.equal(await page.locator('.kind').innerText(), type === 'pdf' ? 'PDF Book' : type[0].toUpperCase()+type.slice(1)); }
  await page.click('[data-type="all"]'); await page.fill('#search','POETRY'); assert.equal(await page.locator('.card').count(),1); await page.fill('#search','no match'); assert.match(await page.locator('#library-status').innerText(), /No matching/); await page.fill('#search','');
  assert.equal(await page.locator('audio[controls]').count(),1); assert.equal(await page.locator('video[controls]').count(),1); assert.equal(await page.locator('a[target="_blank"][rel="noopener noreferrer"]').count(),7);
  await page.evaluate(() => { testState.rows = [{ title:'<img src=x onerror="window.hacked=true">', description:'<script>bad()</script>\nsecond line', content_type:'writing', file_path:'../evil' }]; }); await page.click('#refresh-button'); await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
  assert.equal(await page.locator('.card img,.card script,.card a').count(),0); assert.match(await page.locator('.card').innerText(), /<script>/); assert.equal(await page.evaluate(() => window.hacked),undefined);
  await page.evaluate(() => testState.failLoad = true); await page.click('#refresh-button'); await page.waitForFunction(() => document.querySelector('#library-status').textContent.includes('Could not')); assert.equal(await page.locator('.card').count(),0); await page.evaluate(() => testState.failLoad = false);
  await page.click('#show-form-button'); await page.click('#save-item-button'); assert.match(await page.locator('#save-status').innerText(),/title/);
  await page.fill('#item-title','Test image'); await page.click('#save-item-button'); assert.match(await page.locator('#save-status').innerText(),/Choose a file/);
  await page.locator('#item-file').setInputFiles({ name:'bad.html', mimeType:'text/html', buffer:Buffer.from('bad') }); await page.click('#save-item-button'); assert.match(await page.locator('#save-status').innerText(),/format/);
  await page.locator('#item-file').setInputFiles({ name:'large.png', mimeType:'image/png', buffer:Buffer.alloc(1048577) }); await page.click('#save-item-button'); assert.match(await page.locator('#save-status').innerText(),/nonempty/);
  await page.click('#cancel-button'); assert.equal(await page.locator('#upload-form').isVisible(),false); await page.click('#show-form-button'); assert.equal(await page.inputValue('#item-title'),'');
  await page.fill('#item-title','A poem'); await page.selectOption('#item-type','poetry'); await page.fill('#item-description','one\ntwo'); await page.evaluate(() => testState.delay = 100);
  await page.locator('#upload-form').evaluate(f => { f.dispatchEvent(new Event('submit',{cancelable:true})); f.dispatchEvent(new Event('submit',{cancelable:true})); });
  await page.waitForFunction(() => document.querySelector('#upload-form').hidden); assert.equal(await page.evaluate(() => testState.uploads),1); assert.equal(await page.evaluate(() => testState.inserts),1); assert.match(await page.locator('#library-items').innerText(),/A poem/);
  await page.click('#show-form-button'); await page.fill('#item-title','Recovered poem'); await page.selectOption('#item-type','poetry'); await page.fill('#item-description','recover me'); await page.evaluate(() => testState.failInsert = true); await page.click('#save-item-button'); await page.waitForFunction(() => document.querySelector('#save-status').textContent.includes('not confirmed'));
  assert.equal(await page.locator('#item-fields').isDisabled(),true); await page.click('#cancel-button'); await page.click('#show-form-button'); assert.equal(await page.inputValue('#item-title'),'Recovered poem');
  await page.evaluate(() => testState.failInsert = false); await page.click('#save-item-button'); await page.waitForFunction(() => document.querySelector('#upload-form').hidden); assert.equal(await page.evaluate(() => testState.uploads),2); assert.equal(await page.evaluate(() => testState.inserts),3);
  await page.click('#show-form-button'); await page.fill('#item-title','Lost response'); await page.selectOption('#item-type','writing'); await page.fill('#item-description','text'); await page.evaluate(() => { testState.failInsert = true; testState.ambiguousInsert = true; }); await page.click('#save-item-button'); await page.waitForFunction(() => document.querySelector('#save-status').textContent.includes('not confirmed')); await page.click('#save-item-button'); await page.waitForFunction(() => document.querySelector('#upload-form').hidden); assert.equal(await page.evaluate(() => testState.uploads),3); assert.equal(await page.evaluate(() => testState.inserts),4);
  await page.setViewportSize({ width:375,height:812 }); await page.screenshot({ path:path.join(root,'tests/mobile-review.png'),fullPage:true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  await page.setViewportSize({ width:1280,height:900 }); await page.screenshot({ path:path.join(root,'tests/desktop-review.png'),fullPage:true });
  assert.deepEqual(errors,[]);
  await browser.close(); console.log('PASS: category filters; search; media; safe text and URL handling; empty/error states; validation; cancel/reopen; text upload; double-submit prevention; catalog retry; ambiguous insert recovery; mobile overflow; no runtime errors. All backend calls mocked.');
})().catch(e => { console.error(e); process.exitCode=1; }).finally(async () => { if (browser) await browser.close(); });
