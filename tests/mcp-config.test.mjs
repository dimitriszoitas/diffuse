import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_MCP_ENDPOINT,normalizeMCPEndpoint,mcpPermissionOrigin,readMCPSettings,saveMCPSettings,clearMCPSettings} from '../extension/mcp-config.mjs';

test('MCP endpoint accepts only credential-free HTTPS or exact loopback HTTP, with host-scoped Chrome permission',()=>{
  assert.equal(normalizeMCPEndpoint(),DEFAULT_MCP_ENDPOINT);
  assert.equal(normalizeMCPEndpoint(' http://localhost:3845/mcp '),'http://localhost:3845/mcp');
  assert.equal(normalizeMCPEndpoint('http://[::1]:3845/mcp'),'http://[::1]:3845/mcp');
  assert.equal(mcpPermissionOrigin('http://127.0.0.1:3845/mcp'),'http://127.0.0.1/*');
  assert.equal(mcpPermissionOrigin('https://design.example.test:8443/mcp'),'https://design.example.test/*');
  for(const url of ['http://example.test/mcp','http://127.0.0.1.evil.test/mcp','http://192.168.1.10/mcp','file:///tmp/mcp','javascript:alert(1)','https://name:secret@example.test/mcp','https://example.test/mcp?token=secret','https://example.test/mcp#x','https://example.test/with space',''])assert.throws(()=>normalizeMCPEndpoint(url));
});

test('MCP token is trusted-context/session-only by default, redacted publicly, removable, and never carried to another endpoint',async()=>{
  function storage(){const data={};return {data,access:null,async setAccessLevel({accessLevel}){this.access=accessLevel;},async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(key=>key in data).map(key=>[key,data[key]]));},async set(values){Object.assign(data,values);},async remove(keys){for(const key of Array.isArray(keys)?keys:[keys])delete data[key];}};}
  globalThis.chrome={storage:{local:storage(),session:storage()}};
  try{
    assert.deepEqual(await readMCPSettings(),{enabled:false,endpoint:DEFAULT_MCP_ENDPOINT,rememberToken:false,hasToken:false});
    const token='mcp-test-secret';let result=await saveMCPSettings({enabled:true,endpoint:'https://example.test/mcp',token});
    assert.equal(result.hasToken,true);assert.equal(result.token,undefined);assert.equal(chrome.storage.local.data.figmaMCPToken,undefined);assert.equal(chrome.storage.session.data.figmaMCPToken,token);
    assert.equal(chrome.storage.local.access,'TRUSTED_CONTEXTS');assert.equal(chrome.storage.session.access,'TRUSTED_CONTEXTS');
    result=await saveMCPSettings({token:'',rememberToken:true});assert.equal(result.hasToken,true);assert.equal(chrome.storage.local.data.figmaMCPToken,token);assert.equal(chrome.storage.session.data.figmaMCPToken,undefined);
    assert.equal((await readMCPSettings({includeToken:true})).token,token);
    await saveMCPSettings({endpoint:'https://example.test/another-path'});assert.equal((await readMCPSettings()).hasToken,false);
    await saveMCPSettings({token:'new-token',rememberToken:false});assert.equal(chrome.storage.local.data.figmaMCPToken,undefined);assert.equal(chrome.storage.session.data.figmaMCPToken,'new-token');
    const before=structuredClone(chrome.storage.local.data);
    for(const token of ['bad\nheader','x'.repeat(4097),{token:'object'}])await assert.rejects(saveMCPSettings({token}),/valid MCP bearer token/);
    await assert.rejects(saveMCPSettings({endpoint:'http://remote.test/mcp',token:'do-not-save'}),/HTTPS/);assert.deepEqual(chrome.storage.local.data,before);
    result=await clearMCPSettings();assert.deepEqual(result,{enabled:false,endpoint:DEFAULT_MCP_ENDPOINT,rememberToken:false,hasToken:false});assert.equal(chrome.storage.session.data.figmaMCPToken,undefined);assert.deepEqual(chrome.storage.local.data,{});
  }finally{delete globalThis.chrome;}
});
