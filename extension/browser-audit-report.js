import {getBrowserAudit} from './browser-audit-store.mjs';
import {formatBrowserAuditHtml, formatBrowserAuditStandaloneHtml, BROWSER_AUDIT_REPORT_STYLES, browserAuditNeedsRefresh} from './browser-audit-report.mjs';

const content = document.querySelector('#audit-report');
const notice = document.querySelector('#audit-notice');
const refresh = document.querySelector('#refresh-audit');
const download = document.querySelector('#download-audit');
const styles = document.createElement('style');
styles.textContent = BROWSER_AUDIT_REPORT_STYLES;
document.head.append(styles);
const id = new URL(location.href).searchParams.get('audit');
let audit, revision = '', timer, loading = false, syncFailures = 0;

async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({namespace: 'diffuse', target: 'worker', type, ...payload});
  if (!response?.ok) throw new Error(response?.error || 'Diffuse could not complete this action.');
  return response;
}

function addFindingActions(saved) {
  if (!saved.analysis?.findings?.length || !saved.evidence?.screenshots?.some(item => /^data:image\/(?:png|jpe?g|webp);base64,/i.test(item.dataUrl || ''))) return;
  const cards = content.querySelectorAll('[aria-label="AI interpretation"] .audit-finding');
  cards.forEach((card, findingIndex) => {
    const actions = document.createElement('div'); actions.className = 'audit-finding-actions';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Add to review';
    const hint = document.createElement('p'); hint.className = 'audit-muted'; hint.textContent = 'Attaches the captured page screenshot; it is not an exact issue pin.';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await request('BROWSER_AUDIT_ACCEPT', {id: saved.id, findingIndex});
        button.textContent = 'Added to review';
        hint.replaceChildren();
        const link = document.createElement('a'); link.href = `report.html?review=${encodeURIComponent(saved.reviewId)}`; link.textContent = 'Open the saved observation ↗'; hint.append(link);
      } catch (error) { button.disabled = false; hint.textContent = error.message; }
    });
    actions.append(button, hint); card.append(actions);
  });
}

async function load(force = false) {
  if (loading) return;
  loading = true;
  refresh.disabled = true;
  clearTimeout(timer);
  try {
    if (!id) throw new Error('Choose an interactive audit from Review Reports.');
    // Refresh the local worker's companion job when available. An offline
    // helper must never hide the evidence already saved on this device.
    let syncFailed = false;
    try { await request('BROWSER_AUDIT_STATE', {id}); } catch { syncFailed = true; /* Saved report remains available. */ }
    const saved = await getBrowserAudit(id);
    if (!saved) throw new Error('This audit is no longer available on this device. Its review may have been deleted.');
    syncFailures = syncFailed || saved.syncError ? syncFailures + 1 : 0;
    audit = saved;
    const nextRevision = `${saved.updatedAt}:${saved.status}:${saved.steps?.length}:${saved.analysisStatus}:${Boolean(saved.analysis)}`;
    if (force || nextRevision !== revision) {
      const open = new Set([...content.querySelectorAll('details[open][id]')].map(element => element.id));
      content.innerHTML = formatBrowserAuditHtml(saved);
      addFindingActions(saved);
      for (const element of content.querySelectorAll('details[id]')) element.open = open.has(element.id);
      revision = nextRevision;
      document.title = `${saved.page?.title || 'Interactive audit'} — Diffuse`;
      document.querySelector('#back-to-reviews').href = `report.html?review=${encodeURIComponent(saved.reviewId)}`;
    }
    notice.hidden = true;
    download.disabled = false;
    if (browserAuditNeedsRefresh(saved) && !document.hidden) timer = setTimeout(() => load(), Math.min(30_000, 2500 * 2 ** Math.min(syncFailures, 4)));
  } catch (error) {
    notice.textContent = error.message;
    notice.hidden = false;
    if (!audit) {
      content.replaceChildren();
      const heading = document.createElement('h1'); heading.textContent = 'Audit unavailable';
      const paragraph = document.createElement('p'); paragraph.textContent = 'Return to Review Reports to find your saved audits.';
      content.append(heading, paragraph);
    }
  } finally {
    loading = false;
    refresh.disabled = false;
    content.setAttribute('aria-busy', 'false');
  }
}

refresh.addEventListener('click', () => load(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else load(); });
download.addEventListener('click', () => {
  if (!audit) return;
  const blob = new Blob([formatBrowserAuditStandaloneHtml(audit)], {type: 'text/html;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `diffuse-interactive-audit-${String(audit.id).replace(/[^a-z0-9_-]/gi, '').slice(0, 70) || 'report'}.html`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});

load();
