import {createJiraConnectionClient, JiraConnectionError} from './jira-connection.mjs';

const el = id => document.getElementById(id);
const client = createJiraConnectionClient();
let busy = true;

function feedback(message, error = false) {
  const target = el('feedback');
  target.textContent = message;
  target.hidden = !message;
  target.dataset.error = String(error);
  target.setAttribute('role', error ? 'alert' : 'status');
  target.setAttribute('aria-live', error ? 'assertive' : 'polite');
  if (error) target.focus();
}

function safeMessage(error) {
  return error instanceof JiraConnectionError ? error.message : 'The Jira connection could not be updated. Reload this page and try again.';
}

function setBusy(value) {
  busy = value;
  el('connections-section').setAttribute('aria-busy', String(value));
  el('connect').disabled = value;
  for (const button of el('account-list').querySelectorAll('button')) button.disabled = value;
}

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function accountCard(connection) {
  const card = node('article', 'account');
  const heading = node('h3', '', connection.displayName);
  heading.id = `account-${connection.id}`;
  card.setAttribute('aria-labelledby', heading.id);
  card.append(heading, node('p', 'account-identity', `Atlassian account · ${connection.accountId}`));
  const sites = node('ul', 'site-list');
  sites.setAttribute('aria-label', `Available Jira sites for ${connection.displayName}`);
  for (const site of connection.sites) {
    const item = node('li');
    const link = node('a', '', site.url);
    link.href = site.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `Open ${site.name} at ${site.url} in a new tab`);
    item.append(node('strong', '', site.name), link);
    sites.append(item);
  }
  card.append(sites);
  if (!connection.sites.length) card.append(node('p', 'account-notice', 'No Jira sites are currently available. Refresh the connection or reconnect to choose a site.'));
  const actions = node('div', 'account-actions');
  const refresh = node('button', '', 'Refresh sites');
  refresh.type = 'button';
  refresh.setAttribute('aria-label', `Refresh Jira sites for ${connection.displayName}`);
  refresh.addEventListener('click', () => run(async () => {
    await client.refresh(connection.id);
    await load();
    feedback(`Jira sites updated for ${connection.displayName}.`);
  }));
  const disconnect = node('button', 'disconnect', 'Disconnect');
  disconnect.type = 'button';
  disconnect.setAttribute('aria-label', `Disconnect ${connection.displayName} from Diffuse`);
  disconnect.addEventListener('click', () => run(async () => {
    await client.disconnect(connection.id);
    await load();
    feedback(`${connection.displayName} disconnected from Diffuse. Existing Jira tickets are unchanged.`);
    el('connect').focus();
  }));
  actions.append(refresh, disconnect);
  card.append(actions);
  return card;
}

async function load() {
  const connections = await client.listConnections();
  el('account-list').replaceChildren(...connections.map(accountCard));
  el('empty-state').hidden = connections.length > 0;
  el('connection-count').textContent = `${connections.length} connected`;
  el('connect').replaceChildren(document.createTextNode(connections.length ? 'Connect another account ' : 'Connect Jira '), node('span', '', '↗'));
  el('connect').lastChild.setAttribute('aria-hidden', 'true');
}

async function run(action) {
  if (busy) return;
  setBusy(true);
  feedback('');
  try { await action(); }
  catch (error) { feedback(safeMessage(error), true); }
  finally { setBusy(false); }
}

el('connect').addEventListener('click', () => run(async () => {
  // client.connect asks for host access synchronously in this click gesture.
  const connection = await client.connect();
  await load();
  feedback(`${connection.displayName} connected. ${connection.sites.length} Jira ${connection.sites.length === 1 ? 'site is' : 'sites are'} available. No review items have been sent.`);
}));

el('installation-id').value = client.installationId;
el('copy-installation').disabled = !client.installationId;
el('copy-installation').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(client.installationId);
    feedback('Installation ID copied.');
  } catch {
    el('installation-id').focus();
    el('installation-id').select();
    feedback('Select and copy the installation ID from the field below.');
  }
});

setBusy(true);
load().catch(error => {
  el('connection-count').textContent = 'Unavailable';
  feedback(safeMessage(error), true);
}).finally(() => setBusy(false));
