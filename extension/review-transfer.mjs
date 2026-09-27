/** Portable review data only. Settings, credentials and live browser/session handles never cross profiles. */
export const REVIEW_TRANSFER_FORMAT = 'diffuse-review';
export const REVIEW_TRANSFER_VERSION = 1;
export const REVIEW_TRANSFER_MAX_BYTES = 256 * 1024 * 1024;
const MAX_COMMENTS = 2000;
const fail = message => { throw new Error(`Cannot import this review: ${message}`); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (limit = 8000) => value => typeof value === 'string' && value.length <= limit ? value : fail('a text field is invalid or too long.');
const number = value => Number.isFinite(value) && Math.abs(value) <= 100000000 ? value : fail('a recorded measurement is invalid.');
const boolean = value => typeof value === 'boolean' ? value : fail('a recorded option is invalid.');
const nullable = parser => value => value === null ? null : parser(value);
const enumOf = values => value => values.includes(value) ? value : fail('a recorded option is unsupported.');
const date = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : fail('a recorded date is invalid.');
const array = (parser, limit = 1000) => value => Array.isArray(value) && value.length <= limit ? value.map(parser) : fail('a list is invalid or too large.');
const shape = schema => value => {
  if (!object(value)) fail('a data section is invalid.');
  const result = {};
  // Copy only declared fields; never recursively merge untrusted objects.
  for (const [key, parser] of Object.entries(schema)) if (Object.hasOwn(value, key) && value[key] !== undefined) result[key] = parser(value[key]);
  return result;
};
const strings = (keys, limit = 8000) => Object.fromEntries(keys.split(' ').map(key => [key, text(limit)]));
const numbers = keys => Object.fromEntries(keys.split(' ').map(key => [key, number]));
const booleans = keys => Object.fromEntries(keys.split(' ').map(key => [key, boolean]));

export function portablePageUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\u0000-\u0020\u007f]/.test(value)) fail('a page URL is invalid.');
  let url;
  try { url = new URL(value); } catch { fail('a page URL is invalid.'); }
  if (!['http:', 'https:', 'file:'].includes(url.protocol) || url.username || url.password || (url.protocol === 'file:' && url.hostname)) fail('only web pages and local file URLs are supported.');
  // A captured route can contain authentication parameters. Do not share them.
  const secret = /^(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|authorization|password|session[_-]?id|jwt|auth[_-]?token)$/i;
  const keys = [...url.searchParams.keys()];
  const oauthCallback = url.searchParams.has('state') || /(?:^|\/)(?:oauth2?|callback|authorize|authorization)(?:\/|$)/i.test(url.pathname) || keys.some(key => /^(?:access[_-]?token|id[_-]?token|client[_-]?id|redirect[_-]?uri)$/i.test(key));
  for (const key of keys) if (secret.test(key) || (oauthCallback && /^(?:code|session)$/i.test(key))) url.searchParams.delete(key);
  if (url.hash && /(?:^#|[?&])(?:access_token|refresh_token|id_token|api_key|client_secret|password|session_id|auth_token)=/i.test(url.hash)) url.hash = '';
  return url.href;
}
const webUrl = value => { const url = portablePageUrl(value); if (url.startsWith('file:')) fail('a Jira link must use HTTP or HTTPS.'); return url; };
const rect = shape(numbers('x y width height top right bottom left'));
const scroll = shape(numbers('x y'));
const pinOffset = value => {
  if (!object(value) || !['x', 'y'].every(key => Object.hasOwn(value, key) && Number.isFinite(value[key]) && Math.abs(value[key]) <= 100000)) fail('a comment position is invalid.');
  return {x: value.x, y: value.y};
};
const pinPoint = value => {
  if (!object(value) || !['x', 'y'].every(key => Object.hasOwn(value, key) && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1)) fail('a comment drop point is invalid.');
  return {x: value.x, y: value.y};
};
const scrollContainer = shape({...strings('selector overflowX overflowY', 4096), ...numbers('scrollLeft scrollTop clientWidth clientHeight scrollWidth scrollHeight x y')});
const browser = shape(strings('userAgent platform language', 2048));
const pageContext = shape({url: portablePageUrl, title: text(2000), capturedAt: date, viewport: shape(numbers('width height dpr visualScale')), scroll,
  nestedScroll: array(scrollContainer), viewportProfile: shape({key:enumOf(['desktop','laptop','tablet','phone','unknown']),mode:enumOf(['window','preset','emulated'])}),
  theme:shape({declared:nullable(text(300)),colorScheme:text(300),...booleans('prefersDark reducedMotion')}), language:text(100), browser,
  device:shape({...numbers('screenWidth screenHeight maxTouchPoints'),orientation:nullable(text(100))})});
const styles = 'display position boxSizing width height minWidth maxWidth minHeight maxHeight fontFamily fontSize fontWeight fontStyle lineHeight letterSpacing textAlign textTransform color backgroundColor opacity visibility paddingTop paddingRight paddingBottom paddingLeft marginTop marginRight marginBottom marginLeft borderTopWidth borderRightWidth borderBottomWidth borderLeftWidth borderTopColor borderRightColor borderBottomColor borderLeftColor borderTopStyle borderRadius boxShadow gap rowGap columnGap alignItems justifyContent flexDirection flexWrap flexGrow flexShrink gridTemplateColumns gridTemplateRows overflowX overflowY transform';
const stateValue = value => value === null || typeof value === 'boolean' ? value : text(300)(value);
const selection = shape({schemaVersion:enumOf([1]),kind:enumOf(['element','region']),selector:text(4096),selectorFormat:enumOf(['css','shadow-piercing']),tagName:text(100),role:nullable(text(300)),
  component:shape(strings('name source selector',4096)),rect:shape({viewport:rect,document:rect}),styles:shape(strings(styles,4096)),
  states:shape(Object.fromEntries('disabled checked ariaChecked indeterminate selected expanded pressed busy invalid required readOnly focused focusVisible hovered current open inputType'.split(' ').map(key=>[key,stateValue]))),
  breadcrumb:array(shape(strings('tag id role testId component',4096)),100),scrollContainers:array(scrollContainer),context:pageContext,
  anchor:shape({version:enumOf([1]),kind:enumOf(['element','region']),selector:text(4096),identity:shape({tag:text(100),text:text(1000),attributes:shape(strings('id data-testid data-component data-diffuse-scroll role aria-label',1000))}),space:enumOf(['scroll-content','relative']),offset:rect,relative:rect})});

// Remapping changes the live attachment only. Its captured context stays with
// the new anchor so reloads and shared reviews can restore nested scroll state.
export function sanitizePinSelection(value) {
  const result = selection(value);
  const positiveRect = rect => rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0;
  const element = result.kind === 'element';
  const validAnchor = !result.anchor ? !element : result.anchor.version === 1 && result.anchor.kind === result.kind &&
    Boolean(result.anchor.selector?.trim()) && Boolean(result.anchor.identity?.tag) &&
    (element ? result.anchor.selector === result.selector && result.anchor.identity.tag === result.tagName :
      (result.anchor.space === 'scroll-content' && positiveRect(result.anchor.offset)) || (result.anchor.space === 'relative' && positiveRect(result.anchor.relative)));
  if (result.schemaVersion !== 1 || !['element', 'region'].includes(result.kind) || !validAnchor ||
      (element && (!result.selector?.trim() || !result.tagName || ['html', 'diffuse-live-overlay'].includes(result.tagName))) ||
      !positiveRect(result.rect?.viewport) || !positiveRect(result.rect?.document) ||
      !result.context?.url || !(result.context.viewport?.width > 0) || !(result.context.viewport?.height > 0) ||
      !Number.isFinite(result.context.scroll?.x) || !Number.isFinite(result.context.scroll?.y)) {
    fail('a remapped comment attachment is invalid.');
  }
  return result;
}

function media(value, kind) {
  if (typeof value !== 'string' || value.length > REVIEW_TRANSFER_MAX_BYTES) fail('an attachment is too large.');
  const comma = value.indexOf(',');
  const header = value.slice(0, comma);
  const pattern = kind === 'image' ? /^data:image\/(?:png|jpeg|webp);base64$/ : /^data:video\/(?:webm|mp4)(?:;codecs=[a-zA-Z0-9., _-]+)?;base64$/;
  if (comma < 0 || !pattern.test(header)) fail('attachments must be embedded PNG, JPEG, WebP, WebM or MP4 data.');
  const payload = value.slice(comma + 1);
  if (!payload || payload.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) fail('an attachment contains invalid base64 data.');
  return value;
}
const image = shape({dataUrl:value=>media(value,'image'),annotatedDataUrl:value=>media(value,'image'),cropDataUrl:value=>media(value,'image'),...numbers('width height'),capturedAt:date,crop:rect});
const video = shape({dataUrl:value=>media(value,'video'),mimeType: value=>/^video\/(webm|mp4)(;codecs=[a-zA-Z0-9., _-]+)?$/.test(value)?value:fail('a recording format is invalid.'), ...numbers('durationMs bytes width height'),filename:text(255),kind:text(100),startedAt:date,stoppedAt:date,stopReason:text(100)});
const fields = shape({...strings('title',180),...strings('comment expected steps',8000),...strings('component state',240),severity:enumOf(['minor','major','critical']),category:enumOf(['design-mismatch','ux-issue','copy-change'])});
const issue = shape({url:webUrl,key:text(128),status:text(100),createdAt:date});
const comment = shape({createdAt:date,updatedAt:date,mode:enumOf(['audit','comparison']),fields,selection:nullable(selection),pinOffset,pinPoint,pinSelection:sanitizePinSelection,
  context:shape({production:pageContext,prototype:pageContext,alignment:shape({...numbers('opacity reveal offsetX offsetY'),...booleans('linked hidden')}),browser}),
  evidence:shape({production:image,prototype:image,video,...numbers('captureSkewMs')}),
  ai:shape({provider:enumOf(['anthropic']),model:text(200),...numbers('mismatchScore confidence'),reason:text(8000),acceptedAt:date,mode:enumOf(['audit','comparison'])}),jiraIssues:array(issue,100)});
const review = shape({title:text(2000),createdAt:date,updatedAt:date,mode:enumOf(['audit','comparison']),productionUrl:portablePageUrl,prototypeUrl:portablePageUrl,comments:array(comment,MAX_COMMENTS)});

function validateReview(value) {
  const result = review(value);
  if (!result.productionUrl || !result.title || !result.createdAt || !Array.isArray(result.comments)) fail('the review is missing its title, URL, capture date or comments.');
  for (const item of result.comments) {
    if (!item.createdAt || !item.fields?.comment?.trim() || !item.fields?.state?.trim()) fail('an observation is missing its text, state or capture date.');
    if (!item.evidence?.production?.dataUrl) fail('an observation is missing its captured screenshot.');
    if (!item.context?.production?.url) fail('an observation is missing its original page URL.');
    if (item.pinPoint && item.pinSelection?.kind !== 'element') fail('a comment drop point is missing its element attachment.');
    if (item.pinSelection && item.pinSelection.context.url !== item.context.production.url) fail('a remapped comment must stay on its recorded page.');
  }
  result.count = result.comments.length;
  return result;
}

export function createReviewBundle(value, {now = new Date().toISOString()} = {}) {
  const clean = validateReview(value);
  return {format:REVIEW_TRANSFER_FORMAT,version:REVIEW_TRANSFER_VERSION,exportedAt:date(now),review:clean};
}

export function parseReviewBundle(input) {
  let value = input;
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).byteLength > REVIEW_TRANSFER_MAX_BYTES) fail('the file exceeds the 256 MB limit.');
    try { value = JSON.parse(value); } catch { fail('choose a valid .diffuse-review.json file.'); }
  }
  if (!object(value) || value.format !== REVIEW_TRANSFER_FORMAT) fail('this is not a Diffuse review file.');
  if (value.version !== REVIEW_TRANSFER_VERSION) fail('this file uses an unsupported version. Update Diffuse and try again.');
  return {format:REVIEW_TRANSFER_FORMAT,version:REVIEW_TRANSFER_VERSION,exportedAt:date(value.exportedAt),review:validateReview(value.review)};
}

export function prepareImportedReview(input, {uuid = () => crypto.randomUUID(), now = new Date().toISOString()} = {}) {
  const bundle = parseReviewBundle(input);
  const id = uuid();
  const {comments: original, ...metadata} = bundle.review;
  const review = {...metadata,id,updatedAt:date(now),importedAt:date(now)};
  const ids = new Set([id]);
  const comments = original.map((item, importOrder)=>{
    const commentId = uuid();
    if (typeof commentId !== 'string' || !commentId || ids.has(commentId)) fail('unique review identifiers could not be created.');
    ids.add(commentId);
    return {...item,id:commentId,reviewId:id,importOrder};
  });
  return {review,comments};
}

/** Readable issue links only; delivery resumptions and account identities stay in the sender's profile. */
export function withPortableJiraLinks(value, saved = {}) {
  return {...value,comments:value.comments.map(item=>{
    const links = [...(item.jiraIssues || [])];
    for (const [key, delivery] of Object.entries(saved)) {
      if (!key.startsWith('diffuseJiraDeliveryV1:') || !key.includes(`:${item.id}:`)) continue;
      const receipt = delivery?.receipt;
      if (!receipt?.issue?.url) continue;
      try { links.push(issue({url:receipt.issue.url,key:receipt.issue.key || '',status:receipt.status || ''})); } catch { /* A malformed local receipt is not portable. */ }
    }
    const unique = [...new Map(links.map(link=>[link.url,link])).values()];
    return {...item,...(unique.length?{jiraIssues:unique}:{})};
  })};
}
