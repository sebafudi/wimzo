import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, type Actor } from '../src/app.ts';
import { serveHttp } from '../src/server.ts';

// Optional candidate UI. Only profile-aware board work is scheduled here.
export async function startReviewDashboard(options: {stateDir:string; clientFile?:string; port?:number; linkFile?:string}) {
  const app = new App(options.stateDir);
  if (options.clientFile) {
    const tokens = JSON.parse(readFileSync(options.clientFile, 'utf8')) as Record<string, Actor>;
    app.tokens = () => tokens;
  }
  const allowed = new Set(['project.list','project.get','spec.list','task.list','task.get','inbox.list','evidence.list','watch.list','review.diff','review.tree','review.history','review.compare','review.map','review.provenance','review.prepare','review.submit','board.list','board.idea','board.link','board.propose','board.prepare','board.approve','board.phase','worker.options','worker.recommend','worker.status','models.list','model.describe','project.workerPolicy.get','project.workerPolicy.set','workflow.list','workflow.review','workflow.requestChanges','workflow.acceptRequirements','workflow.approve','workflow.reviewResult','workflow.resumeResult']);
  const actions = app.actions.bind(app), call = app.call.bind(app);
  app.actions = actor => actions(actor).filter(action => allowed.has(action.name));
  app.call = async (name, ...args) => {
    if (!allowed.has(name)) throw new Error('This dashboard supports product review and board actions. Use the main service for other actions.');
    return call(name, ...args);
  };
  app.execution.tick = () => app.execution.tickProfiles();
  const server = serveHttp(app, options.port ?? 4318, true);
  try { await new Promise<void>((yes,no) => {server.once('listening',yes);server.once('error',no);}); }
  catch(error){await app.close();throw error;}
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  if (options.linkFile) {
    const key = Object.entries(app.tokens()).find(([,actor]) => actor.role === 'owner')?.[0];
    if (!key) {server.close();await app.close();throw new Error('An owner dashboard credential is required.');}
    writeFileSync(options.linkFile, JSON.stringify({url:`http://127.0.0.1:${port}/#preview=1&key=${key}`,pid:process.pid,mode:'live-review'}), {mode:0o600});
  }
  server.once('close', () => {void app.close();});
  return {app,server,port};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stateDir = process.argv[2];
  if (!stateDir) throw new Error('Usage: node scripts/review-dashboard.ts STATE_DIR [CLIENT_FILE] [LINK_FILE]');
  const {server} = await startReviewDashboard({stateDir,clientFile:process.argv[3],linkFile:process.argv[4]});
  process.once('SIGTERM',()=>server.close());process.once('SIGINT',()=>server.close());
  console.log('Review dashboard running on 127.0.0.1:4318 with durable local decisions.');
}
