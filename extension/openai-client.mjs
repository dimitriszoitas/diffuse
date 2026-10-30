// Worker-only Responses adapter. It accepts already bounded review evidence,
// never follows provider URLs, and never falls back to another provider.
export const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
export const DEFAULT_OPENAI_MODEL = 'gpt-6.1-sol';
export class OpenAIResponseError extends Error {
  constructor(code, message) { super(message); this.name = 'OpenAIResponseError'; this.code = code; }
}
const fail = (code, message) => { throw new OpenAIResponseError(code, message); };

// Responses strict JSON requires every declared property. Preserve the shared
// validators' optional fields by making them nullable on the wire only.
export function openAIStrictSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(openAIStrictSchema);
  const result = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, openAIStrictSchema(value)]));
  if (schema.type === 'object' && schema.properties) {
    const required = new Set(schema.required || []);
    result.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key,
      required.has(key) ? openAIStrictSchema(value) : {anyOf: [openAIStrictSchema(value), {type: 'null'}]}]));
    result.required = Object.keys(schema.properties);
    result.additionalProperties = false;
  }
  return result;
}

function branchMatches(schema, value) {
  if (Object.hasOwn(schema, 'const') && schema.const !== value) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'array') return Array.isArray(value);
  if (schema.type === 'object') return Boolean(value && typeof value === 'object' && !Array.isArray(value)) &&
    Object.entries(schema.properties || {}).every(([key, property]) => !Object.hasOwn(property, 'const') || value[key] === property.const);
  if (schema.type === 'integer') return Number.isInteger(value);
  return !schema.type || typeof value === schema.type;
}

export function normalizeOpenAIJSON(value, schema) {
  if (!schema || typeof schema !== 'object') return value;
  if (schema.anyOf) return normalizeOpenAIJSON(value, schema.anyOf.find(branch => branchMatches(branch, value)));
  if (Array.isArray(value) && schema.items) return value.map(item => normalizeOpenAIJSON(item, schema.items));
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    const required = new Set(schema.required || []);
    return Object.fromEntries(Object.entries(value).filter(([key, item]) => item !== null || required.has(key) || !Object.hasOwn(schema.properties, key))
      .map(([key, item]) => [key, normalizeOpenAIJSON(item, schema.properties[key])]));
  }
  return value;
}

export function openAIInputContent(content) {
  return content.map(block => {
    if (block.type === 'text' && typeof block.text === 'string') return {type: 'input_text', text: block.text};
    if (block.type === 'image' && block.source?.type === 'base64' && ['image/png', 'image/jpeg', 'image/webp'].includes(block.source.media_type) && typeof block.source.data === 'string') {
      return {type: 'input_image', image_url: `data:${block.source.media_type};base64,${block.source.data}`, detail: 'high'};
    }
    fail('AI_INPUT', 'This evidence format cannot be sent to OpenAI. Capture it again.');
  });
}

async function boundedJSON(response, limit) {
  if (!response.body?.getReader) fail('AI_OUTPUT', 'OpenAI returned an unreadable response.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) fail('AI_OUTPUT', 'OpenAI returned an oversized response. No result was saved.');
      text += decoder.decode(value, {stream: true});
    }
    try { return JSON.parse(text + decoder.decode()); } catch { fail('AI_OUTPUT', 'OpenAI returned an unreadable response.'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function errorFor(status, code) {
  if (status === 401) return new OpenAIResponseError('AI_AUTH', 'OpenAI rejected this API key. Replace it in AI settings.');
  if (status === 402 || code === 'insufficient_quota' || code === 'billing_hard_limit_reached') return new OpenAIResponseError('AI_BILLING', 'OpenAI reports a billing or API credit limit. Check the project that owns this API key.');
  if (status === 403) return new OpenAIResponseError('AI_PERMISSION', 'This OpenAI project or key does not allow this request. Check its model access.');
  if (status === 404) return new OpenAIResponseError('AI_MODEL', 'The selected OpenAI model is unavailable to this project. Check its model ID in AI settings.');
  if (status === 429) return new OpenAIResponseError('AI_RATE_LIMIT', 'OpenAI’s request limit was reached. Wait and try again.');
  if (status === 400 || status === 422) return new OpenAIResponseError('AI_REQUEST', 'OpenAI rejected the request format or model settings. No result was saved.');
  return new OpenAIResponseError('AI_SERVICE', 'OpenAI could not complete the request. Try again later.');
}

export async function requestOpenAIJSON({apiKey, model = DEFAULT_OPENAI_MODEL, system, content, schema, schemaName = 'diffuse_result', maxOutputTokens = 16000, signal, fetchImpl = globalThis.fetch}) {
  if (signal?.aborted) fail('AI_CANCELLED', 'The AI request was cancelled.');
  if (typeof apiKey !== 'string' || apiKey.length < 20 || apiKey.length > 512 || /[^\x21-\x7e]/.test(apiKey)) fail('AI_KEY', 'Add a valid OpenAI API key in AI settings.');
  const input = openAIInputContent(content);
  if (JSON.stringify(input).includes(apiKey)) fail('AI_INPUT', 'Remove API credentials from the review evidence.');
  try {
    const response = await fetchImpl(OPENAI_RESPONSES_ENDPOINT, {
      method: 'POST', signal, credentials: 'omit', redirect: 'error',
      headers: {'content-type': 'application/json', authorization: `Bearer ${apiKey}`},
      body: JSON.stringify({model, instructions: system, input: [{role: 'user', content: input}], store: false,
        max_output_tokens: maxOutputTokens, text: {format: {type: 'json_schema', name: schemaName, strict: true, schema: openAIStrictSchema(schema)}}}),
    });
    if (!response.ok) {
      // Only a known machine code is used; arbitrary provider text can echo data.
      const error = await boundedJSON(response, 16384).catch(() => null);
      const failure = errorFor(response.status, error?.error?.code);
      failure.status = response.status;
      throw failure;
    }
    const envelope = await boundedJSON(response, 1024 * 1024);
    if (envelope.status !== 'completed' || !Array.isArray(envelope.output)) fail('AI_OUTPUT', 'OpenAI did not complete the result. No result was saved.');
    const messages = envelope.output.filter(item => item.type === 'message');
    const blocks = messages.flatMap(item => Array.isArray(item.content) ? item.content : []);
    if (blocks.some(item => item.type === 'refusal')) fail('AI_REFUSAL', 'OpenAI could not complete this request. Try different review instructions.');
    const texts = blocks.filter(item => item.type === 'output_text');
    if (texts.length !== 1 || typeof texts[0].text !== 'string' || texts[0].text.length > 256000 || texts[0].text.includes(apiKey)) fail('AI_OUTPUT', 'OpenAI returned invalid or credential-like content. No result was saved.');
    try { return normalizeOpenAIJSON(JSON.parse(texts[0].text), schema); } catch { fail('AI_OUTPUT', 'OpenAI returned unreadable structured content. No result was saved.'); }
  } catch (error) {
    if (signal?.aborted) fail('AI_CANCELLED', 'The AI request was cancelled.');
    if (error instanceof OpenAIResponseError) throw error;
    fail('AI_NETWORK', 'Could not reach OpenAI. Check your connection and the OpenAI connection in Settings.');
  }
}
