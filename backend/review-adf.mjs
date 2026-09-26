// Narrow ADF subset used by Diffuse descriptions and Jira textarea fields.
// Media remains a separate attachment upload; arbitrary HTML, embeds, mentions,
// tables and extension nodes are deliberately not accepted.
const record = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = () => { throw new TypeError('Invalid Jira description.'); };
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function keys(value, allowed) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function boundedText(value, max = 32768) {
  if (typeof value !== 'string' || !value.length || value.length > max || controls.test(value)) invalid();
  return value;
}
function link(value) {
  boundedText(value, 4096);
  if (/[\u0000-\u0020\u007f]/.test(value)) invalid();
  let url;try { url = new URL(value); } catch { invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid();
  return url.href;
}

/** Clone a bounded document, retaining only supported ADF nodes and attributes. */
export function cloneReviewAdf(value, {maxBytes = 256 * 1024} = {}) {
  let nodes = 0;
  const count = () => { if (++nodes > 5000) invalid(); };
  function mark(value) {
    count();
    if (value?.type === 'link') {
      keys(value, ['type', 'attrs']);keys(value.attrs, ['href']);
      return {type: 'link', attrs: {href: link(value.attrs.href)}};
    }
    keys(value, ['type']);
    if (!['strong', 'em', 'code'].includes(value.type)) invalid();
    return {type: value.type};
  }
  function inline(value) {
    count();
    if (value?.type === 'hardBreak') { keys(value, ['type']);return {type: 'hardBreak'}; }
    keys(value, ['type', 'text', 'marks']);
    if (value.type !== 'text') invalid();
    const result = {type: 'text', text: boundedText(value.text)};
    if (value.marks !== undefined) {
      if (!Array.isArray(value.marks) || value.marks.length > 4) invalid();
      result.marks = value.marks.map(mark);
      if (new Set(result.marks.map(item => item.type)).size !== result.marks.length) invalid();
    }
    return result;
  }
  function block(value, allowed, depth = 0) {
    count();
    if (depth > 6) invalid();
    keys(value, ['type', 'attrs', 'content']);
    if (!allowed.includes(value.type) || !Array.isArray(value.content) || value.content.length > 1000) invalid();
    const result = {type: value.type};
    if (value.type === 'codeBlock') {
      if (!value.content.length) invalid();
      if (value.attrs !== undefined) {
        keys(value.attrs, ['language', 'wrap', 'hideLineNumbers']);
        if (value.attrs.language !== undefined && value.attrs.language !== 'text') invalid();
        if (value.attrs.wrap !== undefined && typeof value.attrs.wrap !== 'boolean') invalid();
        if (value.attrs.hideLineNumbers !== undefined && typeof value.attrs.hideLineNumbers !== 'boolean') invalid();
        result.attrs = {...value.attrs};
      }
      result.content = value.content.map(node => {
        count();keys(node, ['type', 'text']);
        if (node.type !== 'text') invalid();
        return {type: 'text', text: boundedText(node.text)};
      });
      return result;
    }
    if (value.type === 'paragraph' || value.type === 'heading') {
      if (value.type === 'heading') {
        keys(value.attrs, ['level']);
        if (!Number.isInteger(value.attrs.level) || value.attrs.level < 1 || value.attrs.level > 6) invalid();
        result.attrs = {level: value.attrs.level};
      } else if (value.attrs !== undefined) invalid();
      result.content = value.content.map(inline);
      return result;
    }
    if (!value.content.length) invalid();
    let children;
    if (value.type === 'panel') {
      keys(value.attrs, ['panelType']);
      if (!['info', 'note', 'warning', 'success', 'error'].includes(value.attrs.panelType)) invalid();
      result.attrs = {panelType: value.attrs.panelType};
      children = ['paragraph', 'heading', 'orderedList', 'bulletList'];
    } else if (value.type === 'orderedList') {
      if (value.attrs !== undefined) {
        keys(value.attrs, ['order']);
        if (!Number.isSafeInteger(value.attrs.order) || value.attrs.order < 0 || value.attrs.order > 1000000) invalid();
        result.attrs = {order: value.attrs.order};
      }
      children = ['listItem'];
    } else {
      if (value.attrs !== undefined) invalid();
      children = value.type === 'bulletList' ? ['listItem'] : ['paragraph'];
    }
    result.content = value.content.map(child => block(child, children, depth + 1));
    return result;
  }
  keys(value, ['type', 'version', 'content']);
  if (value.type !== 'doc' || value.version !== 1 || !Array.isArray(value.content) || !value.content.length || value.content.length > 500) invalid();
  const result = {type: 'doc', version: 1, content: value.content.map(item => block(item, ['paragraph', 'heading', 'panel', 'orderedList', 'bulletList', 'codeBlock']))};
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) invalid();
  return result;
}
