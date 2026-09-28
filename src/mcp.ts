import { createInterface } from 'node:readline';
import type { App, Actor } from './app.ts';

export function toolName(action: string) { return action.replaceAll('.', '_'); }
export function serveMcp(app: App, actor: Actor, input = process.stdin, output = process.stdout) {
  const send = (message: any) => output.write(JSON.stringify(message) + '\n');
  const lines = createInterface({ input, crlfDelay: Infinity });
  let queue = Promise.resolve();
  const handle = async (line: string) => {
    let request: any;
    try { request = JSON.parse(line); } catch { send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}}); return; }
    if (request.id === undefined) return;
    try {
      let result: any;
      switch (request.method) {
        case 'initialize': result = {
          protocolVersion: ['2024-11-05','2025-03-26','2025-06-18'].includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-06-18',
          capabilities: {tools:{listChanged:false}}, serverInfo:{name:'wimzo',version:'0.1.0'},
          instructions: 'Wimzo is a local project harness. Retrieve project context and pending inbox on connection and before decisions. Canonical PRDs govern intent. Drafts and passing tests are never owner acceptance. Present exact before/after revisions, scope and evidence to the owner before recording their approval, with the actual user decision as provenance. Approved tasks wait for capacity. Never claim GUI dispatch or hardware verification from script execution. Reconnect retrieves durable pending events; delivery is explicit.'
        }; break;
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: app.actions(actor).map(action => ({name:toolName(action.name),description:action.description,inputSchema:action.inputSchema,
          annotations:{readOnlyHint:/\.(list|get|inspect|queue|status|receipt|diff|tree|history|compare)$/.test(action.name),destructiveHint:false,openWorldHint:false}}))}; break;
        case 'tools/call': {
          const action = app.actions(actor).find(action => toolName(action.name) === request.params?.name);
          if (!action) throw new Error('Tool unavailable for this role');
          try {
            const value = await app.call(action.name,request.params.arguments ?? {},actor,request.params._meta?.requestId);
            result = { content:[{type:'text',text:JSON.stringify(value)}],isError:false };
          } catch (error) { result = {content:[{type:'text',text:String((error as Error).message)}],isError:true}; }
          break;
        }
        default: send({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}}); return;
      }
      send({jsonrpc:'2.0',id:request.id,result});
    } catch (error) { send({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:String((error as Error).message)}}); }
  };
  lines.on('line', line => { if (line.length > 2_000_000) {send({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Message too large'}}); return;} queue = queue.then(() => handle(line)); });
  return new Promise<void>(resolve => lines.on('close', () => { queue.finally(resolve); }));
}
