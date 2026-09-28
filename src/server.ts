import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { App, Actor } from './app.ts';

async function readBody(request: IncomingMessage) {
  let result = '';
  for await (const chunk of request) { result += chunk; if (Buffer.byteLength(result) > 2_000_000) throw new Error('Request too large'); }
  return JSON.parse(result || '{}');
}
function equal(a: string,b: string) { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length&&timingSafeEqual(x,y); }
export function serveHttp(app: App, port = 4317, dashboard = false) {
  const tokens = app.tokens();
  const instanceId=randomUUID();
  const server = createServer(async (request,response) => {
    response.setHeader('Content-Type','application/json'); response.setHeader('Cache-Control','no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','no-referrer');response.setHeader('X-Frame-Options','DENY');
    const reply=(status:number,value:any)=>{response.writeHead(status);response.end(JSON.stringify(value));};
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host ?? '')) return reply(403,{error:'Invalid host'});
    if (request.headers.origin&&request.headers.origin!==`http://${request.headers.host}`) return reply(403,{error:'Cross-origin requests disabled; use CLI or MCP'});
    if (request.method==='GET'&&request.url==='/health') return reply(200,{name:'wimzo',version:'0.1.0',dashboard,instanceId,watermark:app.store.watermark()});
    if (request.method==='GET'&&request.url==='/'&&dashboard) {
      response.setHeader('Content-Type','text/html; charset=utf-8');
      response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
      response.writeHead(200);response.end(readFileSync(new URL('./dashboard.html',import.meta.url),'utf8'));return;
    }
    if (request.method==='GET' && dashboard && ['/assets/markdown.js','/assets/marked.js'].includes(request.url ?? '')) {
      const file = request.url === '/assets/markdown.js' ? new URL('./markdown.js', import.meta.url) : new URL(import.meta.resolve('marked'));
      response.setHeader('Content-Type','text/javascript; charset=utf-8');
      response.writeHead(200); response.end(readFileSync(file,'utf8')); return;
    }
    const credential=(request.headers.authorization??'').replace(/^Bearer /,'');
    const token=Object.keys(tokens).find(token=>equal(token,credential));
    if (!token) return reply(401,{error:'Local client token required'});
    const actor: Actor=tokens[token];
    try {
      if(request.method==='POST'&&request.url==='/shutdown') {
        const body=await readBody(request);
        if(actor.role!=='owner'||body.instanceId!==instanceId)return reply(403,{error:'Owner and exact service instance required'});
        reply(200,{acknowledged:true,instanceId});server.close();return;
      }
      if (request.method==='GET'&&request.url==='/tools') return reply(200,app.actions(actor));
      if (request.method==='POST'&&request.url==='/call') {
        const body=await readBody(request);
        return reply(200,{result:await app.call(body.action,body.input??{},actor,body.requestId)});
      }
      return reply(404,{error:'No route. Chat tools and CLI are the complete interface.'});
    } catch(error) { return reply(400,{error:(error as Error).message}); }
  });
  server.requestTimeout=30_000;
  server.listen(port,'127.0.0.1');
  let tickInFlight:Promise<void>|undefined;
  const timer=setInterval(()=>{
    if(tickInFlight) return;
    tickInFlight=(async()=>{
      try {await app.execution.tick();} catch(error) {app.store.event('service.tick_error',null,{error:(error as Error).message});}
    })().finally(()=>{tickInFlight=undefined;});
  },1000);
  const closeNow=server.close.bind(server);
  let closing=false;
  const closeCallbacks:Array<(error?:Error)=>void>=[];
  server.close=((callback?:(error?:Error)=>void)=>{
    if(callback) closeCallbacks.push(callback);
    if(closing) return server;
    closing=true;
    clearInterval(timer);
    void Promise.resolve(tickInFlight).then(()=>closeNow(error=>{
      for(const complete of closeCallbacks.splice(0)) complete(error);
    }));
    return server;
  }) as typeof server.close;
  server.on('close',()=>clearInterval(timer));
  server.on('error',()=>clearInterval(timer));
  return server;
}
