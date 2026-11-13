import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {startSource} from '../src/source.mjs';
test('真实浏览器呈现及操作保留源端特殊情形',{timeout:20000},async()=>{
 const source=await startSource();const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
 const action=async action=>{const response=await fetch(source.url+'/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});assert.equal(response.status,200);return response.json();};
 try{await page.goto(source.url);await page.waitForFunction(()=>window.portalReady);assert.equal(await page.locator('mfrac').count(),1);assert.equal(await page.locator('msup').count(),1);
await page.click('#conflict');assert.equal(await page.locator('annotation').textContent(),'x/t');assert.equal(await page.locator('mfrac mi').first().textContent(),'x');
await page.click('#replace');await page.waitForFunction(()=>document.querySelector('mfrac').textContent==='qt2');assert.equal(await page.locator('[data-card=pressure] .symbols').textContent(),'x 为压强');}
 finally{await browser.close();await source.close();}
});
