import { App, root, type Actor } from '../src/app.ts';
const app = new App();
const owner: Actor = {role:'owner',id:'local-setup'};
try {
  if (!app.store.get('project','wimzo')) await app.call('project.register',{id:'wimzo',name:'Wimzo',root,purpose:'Local AI development workspace',canonicalPaths:['VISION.md','spec/PRD.md']},owner);
  for (const path of ['VISION.md','spec/PRD.md']) await app.call('spec.capture',{projectId:'wimzo',path},owner);
  app.tokens();
  console.log('Registered Wimzo and captured draft requirements. No work approved or workers launched.');
} finally { await app.close(); }
