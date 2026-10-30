// Imported review files and model responses are untrusted. Source URLs are
// displayed as links only after validating their scheme and exact public host.
export function safeReviewSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f<>"'`\\]/.test(value)) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['nngroup.com', 'www.nngroup.com', 'w3.org', 'www.w3.org'].includes(url.hostname)
      && !url.username && !url.password && !url.port ? url.href : '';
  } catch { return ''; }
}

export function reviewAssessmentLabel(value) {
  const labels = {observed: 'Visible observation', heuristic: 'UX recommendation', 'needs-verification': 'Needs verification'};
  return typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : '';
}

export function reviewSources(value) {
  if (!Array.isArray(value)) return [];
  const sources = [], seen = new Set();
  for (const source of value.slice(0, 32)) {
    const url = safeReviewSourceUrl(source?.url);
    if (!url || seen.has(url)) continue;
    const title = typeof source.title === 'string' ? source.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240) : '';
    sources.push({url, title: title || (new URL(url).hostname.includes('nngroup.com') ? 'NN/g reference' : 'W3C reference')});
    seen.add(url);
    if (sources.length === 8) break;
  }
  return sources;
}
