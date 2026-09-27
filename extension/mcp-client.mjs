import {normalizeMCPEndpoint} from './mcp-config.mjs';

const PROTOCOL = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set(['2025-03-26','2025-06-18','2025-11-25']);
const READ_TOOLS = new Set(['get_design_context','get_screenshot','get_variable_defs','get_metadata']);
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BASE64 = 12 * 1024 * 1024;
const MAX_TEXT = 35000;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function safeOutput(value, token) {
  if (token && JSON.stringify(value).includes(token)) throw new Error('The MCP response contained credential material and was discarded.');
  return value;
}
const abortError = () => Object.assign(new Error('The Figma reference request was cancelled.'), {name:'AbortError'});

export function parseFigmaReference(input) {
  if (typeof input !== 'string' || input.length > 8192 || /[\u0000-\u0020\u007f]/.test(input.trim())) throw new Error('Paste a link to a Figma frame or layer.');
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('Paste a link to a Figma frame or layer.'); }
  if (url.protocol !== 'https:' || !['figma.com','www.figma.com'].includes(url.hostname) || url.port || url.username || url.password) throw new Error('Use a frame link from figma.com.');
  const path = url.pathname.match(/^\/(?:design|file|proto)\/([a-zA-Z0-9_-]{1,200})(?:\/|$)/);
  if (!path) throw new Error('Use a Figma Design frame or layer link.');
  const node = url.searchParams.get('node-id');
  if (!node) throw new Error('This Figma link has no node-id. Select a frame or layer in Figma and copy its link.');
  if (!/^\d{1,20}[:-]\d{1,20}$/.test(node)) throw new Error('The Figma frame link has an invalid node-id. Copy the frame link again.');
  const nodeId = node.replace('-', ':');
  // Keep only the file identity and node; tracking/authentication fields never
  // travel to the MCP server or into exported reference provenance.
  return {url:`https://www.figma.com/design/${path[1]}?node-id=${nodeId.replace(':','-')}`, fileKey:path[1], nodeId};
}

export function extractFigmaReference(input) {
  if (typeof input !== 'string') return null;
  const match = input.match(/https:\/\/(?:www\.)?figma\.com\/[^\s<>"']+/i);
  return match ? parseFigmaReference(match[0].replace(/[),.;\]}]+$/g,'')) : null;
}

async function deadline(signal, milliseconds, action) {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  let expired = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, {once:true});
  const timer = setTimeout(() => { expired = true; controller.abort(); }, milliseconds);
  let rejectAbort;
  const cancelled = new Promise((_, reject) => { rejectAbort = () => reject(expired ? new Error('The MCP server took too long to respond. Try a smaller Figma frame.') : abortError()); controller.signal.addEventListener('abort', rejectAbort, {once:true}); });
  try { return await Promise.race([action(controller.signal), cancelled]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort',cancel); controller.signal.removeEventListener('abort',rejectAbort); }
}

function rpcResult(message, id) {
  if (!object(message) || message.jsonrpc !== '2.0' || message.id !== id || typeof message.method === 'string') return {matched:false};
  if (message.error) throw new Error(`The MCP server could not complete the request${Number.isInteger(message.error.code) ? ` (${message.error.code})` : ''}.`);
  if (!Object.hasOwn(message,'result') || !object(message.result)) throw new Error('The MCP server returned an invalid result.');
  return {matched:true, result:message.result};
}

async function readResponse(response, id, signal) {
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_RESPONSE_BYTES) { await response.body?.cancel().catch(()=>{}); throw new Error('The MCP response is too large. Choose a smaller Figma frame.'); }
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['application/json','text/event-stream'].includes(contentType)) { await response.body?.cancel().catch(()=>{}); throw new Error('The MCP server must return JSON or a Streamable HTTP event stream.'); }
  if (!response.body?.getReader) throw new Error('The MCP server returned an empty response.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', bytes = 0;
  const cancel = () => { reader.cancel().catch(()=>{}); };
  signal.addEventListener('abort',cancel,{once:true});
  function parse(data) {
    let message;
    try { message = JSON.parse(data); } catch { throw new Error('The MCP server returned invalid JSON.'); }
    return rpcResult(message,id);
  }
  function events(final = false) {
    let boundary;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0 || (final && buffer)) {
      const event = boundary >= 0 ? buffer.slice(0,boundary) : buffer;
      buffer = boundary >= 0 ? buffer.slice(boundary + (buffer.slice(boundary).startsWith('\r\n\r\n') ? 4 : 2)) : '';
      const data = event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
      if (!data) continue;
      const result = parse(data);
      if (result.matched) return result;
    }
    return {matched:false};
  }
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const {done,value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('The MCP response is too large. Choose a smaller Figma frame.');
      buffer += decoder.decode(value,{stream:true});
      if (contentType === 'text/event-stream') { const result = events(); if (result.matched) return result.result; }
    }
    buffer += decoder.decode();
    const result = contentType === 'text/event-stream' ? events(true) : parse(buffer);
    if (!result.matched) throw new Error('The MCP server did not return the requested result.');
    return result.result;
  } finally { signal.removeEventListener('abort',cancel); await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}

class MCPClient {
  constructor({endpoint,token='',signal},{fetchImpl=globalThis.fetch,timeoutMs=25000}={}) {
    this.endpoint = normalizeMCPEndpoint(endpoint);
    if (typeof token !== 'string' || token.length > 4096 || /[^\x21-\x7e]/.test(token)) throw new Error('The MCP bearer token is invalid.');
    this.token=token;this.signal=signal;this.fetch=fetchImpl;this.timeout=Math.max(1,Math.min(45000,timeoutMs));this.nextId=1;this.sessionId=null;this.protocol=null;this.serverName='Figma MCP';this.tools=[];
  }
  async post(method,params,notification=false) {
    const id=notification?null:this.nextId++;
    return deadline(this.signal,this.timeout,async signal=>{
      const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
      if(this.token)headers.Authorization=`Bearer ${this.token}`;
      if(this.sessionId)headers['Mcp-Session-Id']=this.sessionId;
      if(this.protocol)headers['MCP-Protocol-Version']=this.protocol;
      let response;
      try { response=await this.fetch(this.endpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,...(params===undefined?{}:{params})}),signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'}); }
      catch { if(signal.aborted)throw abortError();throw new Error('Could not reach the MCP server. Check its address and that Figma Desktop MCP is enabled. Redirects are not supported.'); }
      if(response.redirected || (response.url && response.url!==this.endpoint) || (response.status>=300&&response.status<400)) {await response.body?.cancel().catch(()=>{});throw new Error('MCP redirects are not allowed. Enter the final server address in Settings.');}
      if(!response.ok){await response.body?.cancel().catch(()=>{});if(response.status===404&&this.sessionId)throw Object.assign(new Error('The MCP session expired. Reconnect and try again.'),{code:'MCP_SESSION_EXPIRED'});if([401,403].includes(response.status))throw new Error('The MCP server requires authorization. Use Figma Desktop or configure a custom server bearer token; remote Figma OAuth is not supported.');throw new Error(`The MCP server returned HTTP ${response.status}.`);}
      if(notification){await response.body?.cancel().catch(()=>{});return null;}
      const result=await readResponse(response,id,signal);
      if(method==='initialize'){
        const session=response.headers.get('mcp-session-id');
        if(session && (!/^[\x21-\x7e]{1,512}$/.test(session)))throw new Error('The MCP server returned an invalid session identifier.');
        this.sessionId=session||null;
      }
      return result;
    });
  }
  async initialize() {
    const result=await this.post('initialize',{protocolVersion:PROTOCOL,capabilities:{},clientInfo:{name:'diffuse',version:'1.0'}});
    if(!SUPPORTED_PROTOCOLS.has(result.protocolVersion))throw new Error('This MCP protocol version is not supported. Update the server.');
    this.protocol=result.protocolVersion;
    this.serverName=typeof result.serverInfo?.name==='string'?(this.token?result.serverInfo.name.split(this.token).join('[redacted]'):result.serverInfo.name).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,120):'Figma MCP';
    await this.post('notifications/initialized',undefined,true);
    let cursor, pages=0;const cursors=new Set(), names=new Set();
    do{
      const page=await this.post('tools/list',cursor?{cursor}:{});
      if(!Array.isArray(page.tools)||page.tools.length>500)throw new Error('The MCP server returned an invalid tool list.');
      for(const tool of page.tools)if(object(tool)&&READ_TOOLS.has(tool.name)&&!names.has(tool.name)){this.tools.push(tool);names.add(tool.name);}
      cursor=page.nextCursor;
      if(cursor!==undefined&&(typeof cursor!=='string'||cursor.length>2048||cursors.has(cursor)))throw new Error('The MCP server returned an invalid tool cursor.');
      if(cursor&&this.token&&cursor.includes(this.token))throw new Error('The MCP tool cursor contained credential material and was discarded.');
      if(cursor)cursors.add(cursor);
      if(++pages>=5&&cursor)throw new Error('The MCP tool list has too many pages.');
    }while(cursor);
    if(!this.tools.length)throw new Error('This server exposes no supported Figma read tools. Enable the Figma Desktop MCP server.');
  }
  async call(tool,reference) {
    if(!READ_TOOLS.has(tool?.name)||!this.tools.includes(tool))throw new Error('This MCP tool is not allowed.');
    const schema=tool.inputSchema;
    if(!object(schema)||schema.type!=='object'||!object(schema.properties))throw new Error(`The ${tool.name} input schema is not supported.`);
    const values={fileKey:reference.fileKey,nodeId:reference.nodeId,clientLanguages:'html,css',clientFrameworks:'none',enableBase64Response:true,forceCode:false};
    const args={};
    for(const [name,value]of Object.entries(values))if(Object.hasOwn(schema.properties,name)){
      const type=typeof value;if(schema.properties[name]?.type && schema.properties[name].type!==type)throw new Error(`The ${tool.name} input schema is not supported.`);args[name]=value;
    }
    if(!Object.hasOwn(args,'nodeId'))throw new Error(`The ${tool.name} tool cannot select a specific Figma frame.`);
    if(schema.required!==undefined&&(!Array.isArray(schema.required)||schema.required.some(key=>typeof key!=='string'||!Object.hasOwn(args,key))))throw new Error(`The ${tool.name} tool requires unsupported arguments.`);
    if(this.token&&JSON.stringify(args).includes(this.token))throw new Error('The Figma reference overlaps with credential material. Check the server token and frame link.');
    const result=await this.post('tools/call',{name:tool.name,arguments:args});
    if(result.isError)throw new Error(`Figma could not read the frame with ${tool.name}. Check that the file is open and accessible.`);
    return result;
  }
}

async function connected(options,dependencies,action) {
  return deadline(options.signal,110000,async signal=>{
    for(let attempt=0;attempt<2;attempt++){
      try{const client=new MCPClient({...options,signal},dependencies);await client.initialize();return await action(client);}
      catch(error){if(error.code!=='MCP_SESSION_EXPIRED'||attempt)throw error;}
    }
  });
}

export async function testMCPConnection(options,dependencies={}) {
  return connected(options,dependencies,client=>safeOutput({serverName:client.serverName,tools:client.tools.map(tool=>tool.name)},client.token));
}

export async function readFigmaReference(options,dependencies={}) {
  const reference=parseFigmaReference(options.url);
  return connected(options,dependencies,async client=>{
    const text=[],images=[],used=[],warnings=[];let textLength=0,imageLength=0;
    const addText=value=>{if(typeof value!=='string'||!value)return;if(client.token)value=value.split(client.token).join('[redacted]');const available=MAX_TEXT-textLength;if(available<=0)return;const clipped=value.slice(0,available);text.push(clipped);textLength+=clipped.length;};
    const addImage=(mimeType,data)=>{
      if(!['image/png','image/jpeg','image/webp'].includes(mimeType)||typeof data!=='string'||!data||data.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(data)){warnings.push('The MCP server returned an unsupported image; it was omitted.');return;}
      if(images.length>=2||imageLength+data.length>MAX_IMAGE_BASE64){warnings.push('Additional or oversized reference images were omitted.');return;}
      imageLength+=data.length;images.push({mimeType,data});
    };
    const contextTool=client.tools.find(tool=>tool.name==='get_design_context')||client.tools.find(tool=>tool.name==='get_metadata');
    const planned=[contextTool,client.tools.find(tool=>tool.name==='get_variable_defs'),client.tools.find(tool=>tool.name==='get_screenshot')].filter(Boolean);
    for(const tool of planned){
      try{
        const result=await client.call(tool,reference);used.push(tool.name);
        if(Array.isArray(result.content))for(const block of result.content){
          if(block?.type==='text')addText(block.text);
          else if(block?.type==='image')addImage(block.mimeType,block.data);
          else if(block?.type==='resource'&&object(block.resource)){addText(block.resource.text);if(block.resource.blob)addImage(block.resource.mimeType,block.resource.blob);}
        }
        if(object(result.structuredContent))addText(JSON.stringify(result.structuredContent));
      }catch(error){if(error.name==='AbortError'||error.code==='MCP_SESSION_EXPIRED'||options.signal?.aborted)throw error;warnings.push(error.message);}
    }
    if(!text.length&&!images.length)throw new Error('The MCP server returned no usable Figma reference. Check the frame link and desktop file.');
    if(textLength>=MAX_TEXT)warnings.push('Design context was shortened to fit the review.');
    if(!images.length)warnings.push('No inline screenshot was returned. Linked assets were not downloaded.');
    // MCP content remains untrusted reference data. No returned prompts, tool
    // instructions, links or resources are followed by this connector.
    return safeOutput({...reference,text:text.join('\n\n').slice(0,MAX_TEXT),images,tools:used,serverName:client.serverName,warnings:[...new Set(warnings)]},client.token);
  });
}
