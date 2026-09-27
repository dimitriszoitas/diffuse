export const DEFAULT_MCP_ENDPOINT = 'http://127.0.0.1:3845/mcp';
const CONFIG = 'figmaMCPConfig';
const TOKEN = 'figmaMCPToken';
let protection;

export function normalizeMCPEndpoint(input = DEFAULT_MCP_ENDPOINT) {
  if (typeof input !== 'string' || input.length > 2048 || /[\u0000-\u0020\u007f]/.test(input.trim())) throw new Error('Enter a valid MCP server URL.');
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('Enter a valid MCP server URL.'); }
  if (url.username || url.password || url.search || url.hash || !url.hostname) throw new Error('The MCP URL cannot contain credentials, query parameters or a fragment.');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Use HTTPS for a remote MCP server, or HTTP on localhost for Figma Desktop.');
  return url.href;
}

export function mcpPermissionOrigin(endpoint) {
  const url = new URL(normalizeMCPEndpoint(endpoint));
  return `${url.protocol}//${url.hostname}/*`;
}

function protectStorage() {
  if (!protection) protection = Promise.all([
    chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}),
    chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}),
  ]).catch(error => { protection = null; throw error; });
  return protection;
}

function cleanToken(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[^\x21-\x7e]/.test(value)) throw new Error('Enter a valid MCP bearer token without spaces.');
  return value;
}

export async function readMCPSettings({includeToken = false} = {}) {
  await protectStorage();
  const [local, temporary] = await Promise.all([chrome.storage.local.get([CONFIG, TOKEN]), chrome.storage.session.get(TOKEN)]);
  const saved = local[CONFIG] || {};
  const endpoint = normalizeMCPEndpoint(saved.endpoint || DEFAULT_MCP_ENDPOINT);
  const token = cleanToken(temporary[TOKEN] || local[TOKEN] || '');
  const config = {enabled:saved.enabled === true, endpoint, rememberToken:saved.rememberToken === true, hasToken:Boolean(token)};
  return includeToken ? {...config, token} : config;
}

export async function saveMCPSettings(input = {}) {
  const current = await readMCPSettings({includeToken:true});
  const endpoint = normalizeMCPEndpoint(input.endpoint === undefined ? current.endpoint : input.endpoint);
  const supplied = typeof input.token === 'string' ? input.token.trim() : input.token;
  if (supplied !== undefined && typeof supplied !== 'string') throw new Error('Enter a valid MCP bearer token.');
  // A remembered credential belongs to exactly one endpoint. Never carry it to
  // a newly configured server, including a different path on the same host.
  const token = cleanToken(supplied || (endpoint === current.endpoint ? current.token : ''));
  const config = {enabled:input.enabled === undefined ? current.enabled : input.enabled === true, endpoint, rememberToken:input.rememberToken === undefined ? current.rememberToken : input.rememberToken === true};
  if (config.rememberToken) {
    await chrome.storage.local.set({[CONFIG]:config, [TOKEN]:token});
    await chrome.storage.session.remove(TOKEN);
  } else {
    await chrome.storage.session.set({[TOKEN]:token});
    await chrome.storage.local.set({[CONFIG]:config});
    await chrome.storage.local.remove(TOKEN);
  }
  return readMCPSettings();
}

export async function clearMCPSettings() {
  await protectStorage();
  await Promise.all([chrome.storage.local.remove([CONFIG,TOKEN]), chrome.storage.session.remove(TOKEN)]);
  return readMCPSettings();
}
