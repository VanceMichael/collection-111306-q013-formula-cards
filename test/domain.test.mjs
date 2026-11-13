import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as domain from '../src/domain.mjs';
const data=JSON.parse(await readFile(new URL('../fixtures/source.json',import.meta.url))).data;
const {formulaIdentity,preview}=domain;
test('资料对象的领域边界和原始预览',async()=>{assert.notEqual(formulaIdentity('flow','x'),formulaIdentity('pressure','x'));assert.throws(()=>formulaIdentity('','x'));assert.equal(preview(data).mode,'text-preview');});
