import type { App } from '../src/app.ts';

/** The public demo exposes inspection and synthetic idea capture only. */
export function restrictDemo(app: App) {
  const allowed=new Set(['project.list','project.get','spec.list','task.list','task.get','inbox.list','evidence.list','watch.list','review.diff','review.tree','review.history','review.compare','review.map','review.provenance','board.list','board.idea','worker.status','models.list','model.describe','project.workerPolicy.get','workflow.list']);
  const actions=app.actions.bind(app), call=app.call.bind(app);
  app.actions=actor=>actions(actor).filter(action=>allowed.has(action.name));
  app.call=async(name,...args)=>{
    if(!allowed.has(name)) throw new Error('Demo mode: execution, external recommendations and approvals are disabled.');
    return call(name,...args);
  };
  app.execution.tick=async()=>{};
}
