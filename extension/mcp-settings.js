import {DEFAULT_MCP_ENDPOINT, normalizeMCPEndpoint, mcpPermissionOrigin} from './mcp-config.mjs';

const $ = id => document.getElementById(id);
const form = $('mcp-settings-form');
let config = {enabled:false,endpoint:DEFAULT_MCP_ENDPOINT,rememberToken:false,hasToken:false};
let busy = false;
let connection = null;

async function request(type, data = {}) {
  const response = await chrome.runtime.sendMessage({namespace:'diffuse',target:'worker',type,...data});
  if (!response?.ok) throw new Error(response?.error || 'The design server did not respond. Try connecting again.');
  return response;
}
function feedback(message, type = 'status') {
  $('mcp-feedback').textContent = message;
  $('mcp-feedback').dataset.type = type;
  $('mcp-feedback').hidden = !message;
}
function lock(value) {
  busy = value; form.setAttribute('aria-busy',String(value));
  for (const control of form.elements) control.disabled = value;
  $('mcp-disconnect').disabled = value || !(config.enabled || config.hasToken);
  $('mcp-connect').textContent = value ? 'Connecting…' : connection ? 'Test connection' : 'Save & connect';
}
function mode(desktop) {
  $('mcp-desktop').checked = desktop; $('mcp-custom').checked = !desktop;
  $('mcp-endpoint').readOnly = desktop;
  if (desktop) $('mcp-endpoint').value = DEFAULT_MCP_ENDPOINT;
}
function showConfig(next) {
  config = next || config;
  $('mcp-endpoint').value = config.endpoint || DEFAULT_MCP_ENDPOINT;
  mode($('mcp-endpoint').value === DEFAULT_MCP_ENDPOINT);
  $('mcp-remember-token').checked = Boolean(config.rememberToken);
  $('mcp-token').value = '';
  $('mcp-token').type = 'password';
  $('mcp-toggle-token').textContent = 'Show';
  $('mcp-toggle-token').setAttribute('aria-label','Show entered server token');
  $('mcp-toggle-token').setAttribute('aria-pressed','false');
  $('mcp-status').textContent = config.enabled ? 'Configured' : 'Not connected';
  $('mcp-status').dataset.ready = 'false';
  $('mcp-token-help').textContent = config.hasToken
    ? `A token is saved ${config.rememberToken ? 'on this device' : 'until Chrome closes'}. Leave this blank to keep it. Disconnect removes it.`
    : 'The desktop server usually needs no token. Only enter one if your server requires it.';
}
function showConnection(value) {
  connection = value || null;
  $('mcp-tools').hidden = !connection;
  const list = $('mcp-tool-list'); list.replaceChildren();
  if (!connection) {$('mcp-status').textContent = config.enabled ? 'Configured' : 'Not connected'; $('mcp-status').dataset.ready = 'false'; return;}
  const names = [...new Set((Array.isArray(connection.tools) ? connection.tools : []).map(tool => typeof tool === 'string' ? tool : tool?.name).filter(name => typeof name === 'string' && name.trim()))];
  $('mcp-status').textContent = 'Connected'; $('mcp-status').dataset.ready = 'true';
  $('mcp-tools-summary').textContent = `${connection.serverName || 'Design server'} · ${names.length} ${names.length === 1 ? 'tool' : 'tools'}`;
  for (const name of names) {const item = document.createElement('li'); item.textContent = name.slice(0,160); list.append(item);}
}

$('mcp-desktop').addEventListener('change',() => {if ($('mcp-desktop').checked) {mode(true); showConnection(null);}});
$('mcp-custom').addEventListener('change',() => {if ($('mcp-custom').checked) {mode(false); $('mcp-endpoint').focus();}});
$('mcp-endpoint').addEventListener('input',() => showConnection(null));
$('mcp-toggle-token').addEventListener('click',() => {
  const show = $('mcp-token').type === 'password'; $('mcp-token').type = show ? 'text' : 'password';
  $('mcp-toggle-token').textContent = show ? 'Hide' : 'Show';
  $('mcp-toggle-token').setAttribute('aria-label',`${show ? 'Hide' : 'Show'} entered server token`);
  $('mcp-toggle-token').setAttribute('aria-pressed',String(show));
});
form.addEventListener('submit',async event => {
  event.preventDefault(); if (busy || !form.reportValidity()) return;
  feedback('');
  let endpoint, permission;
  try {
    endpoint = normalizeMCPEndpoint($('mcp-endpoint').value);
    // Start the browser permission request in this original user gesture.
    permission = chrome.permissions.request({origins:[mcpPermissionOrigin(endpoint)]});
  } catch (error) {feedback(error.message,'error'); return;}
  lock(true); showConnection(null);
  try {
    if (!await permission) throw new Error('Allow access to this server to connect. Your connection settings were not changed.');
    const token = $('mcp-token').value.trim();
    const saved = await request('SAVE_MCP_CONFIG',{enabled:true,endpoint,...(token ? {token} : {}),rememberToken:$('mcp-remember-token').checked});
    showConfig(saved.config);
    const tested = await request('TEST_MCP_CONNECTION');
    showConnection(tested.connection);
    feedback(`Connected to ${tested.connection?.serverName || 'your design server'}. Add a frame link in AI review to use it.`);
  } catch (error) {
    $('mcp-status').textContent = config.enabled ? 'Connection needs attention' : 'Not connected';
    $('mcp-status').dataset.ready = 'false'; feedback(error.message,'error');
  } finally {lock(false);}
});
$('mcp-disconnect').addEventListener('click',async () => {
  if (busy) return; lock(true); feedback('');
  try {const result = await request('CLEAR_MCP_CONFIG'); showConnection(null); showConfig(result.config); feedback('Disconnected. The server token was removed.');}
  catch (error) {feedback(error.message,'error');}
  finally {lock(false);}
});
(async () => {
  lock(true);
  try {const result = await request('GET_MCP_CONFIG'); showConfig(result.config);}
  catch (error) {$('mcp-status').textContent = 'Unavailable'; feedback(error.message,'error');}
  finally {lock(false);}
})();
