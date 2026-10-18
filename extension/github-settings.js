import {createGitHubConnectionClient, GitHubConnectionError} from './github-connection.mjs';

const el = id => document.getElementById(id);
const client = createGitHubConnectionClient();
let busy = true;
function node(tag, text, className = '') { const item = document.createElement(tag); item.textContent = text; item.className = className; return item; }
function feedback(message, error = false) {
  const target = el('github-feedback');
  target.textContent = message; target.hidden = !message; target.dataset.error = String(error); target.setAttribute('role', error ? 'alert' : 'status');
}
function setBusy(value) { busy = value; el('github-connections').setAttribute('aria-busy', String(value)); el('github-connect').disabled = value; el('github-private-access').disabled=value; for (const button of el('github-account-list').querySelectorAll('button')) button.disabled = value; }
async function connect() { const connection=await client.connect({privateRepositoryAccess:el('github-private-access').checked});await load();feedback(`Connected as @${connection.login}. Choose a repository when publishing or loading feedback.`); }
async function run(action) { if (busy) return; setBusy(true); feedback(''); try { await action(); } catch (error) { feedback(error instanceof GitHubConnectionError ? error.message : 'The GitHub connection could not be updated. Try again.', true); } finally { setBusy(false); } }
async function load() {
  const connections = await client.listConnections();
  const cards = connections.map(connection => {
    const card = node('article', '', 'account');
    card.append(node('h3', connection.displayName), node('p', `@${connection.login}`, 'account-identity'));
    const actions = node('div', '', 'account-actions');
    const refresh = node('button', 'Refresh connection'); refresh.type = 'button';
    refresh.addEventListener('click', () => run(async () => { await client.refresh(connection.id); await load(); feedback('GitHub connection updated.'); }));
    const disconnect = node('button', 'Disconnect', 'disconnect'); disconnect.type = 'button';
    disconnect.addEventListener('click', () => run(async () => { await client.disconnect(connection.id); await load(); feedback('GitHub disconnected from this browser. Published feedback stays on the pull request.'); }));
    const reconnect=node('button','Reconnect GitHub ↗');reconnect.type='button';reconnect.addEventListener('click',()=>run(connect));
    actions.append(refresh, reconnect, disconnect); card.append(actions); return card;
  });
  el('github-account-list').replaceChildren(...cards);
  el('github-empty').hidden = connections.length > 0;
  el('github-count').textContent = `${connections.length} connected`;
  el('github-connect').textContent = connections.length ? 'Connect another account ↗' : 'Connect GitHub ↗';
}
el('github-connect').addEventListener('click', () => run(connect));
load().catch(error => { el('github-count').textContent = 'Unavailable'; feedback(error.message, true); }).finally(() => setBusy(false));
