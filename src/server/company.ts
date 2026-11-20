import { createHash } from 'node:crypto';
import type { OpportunityStore } from './autonomy.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { CompanyIndex, CompanyNote } from '../company-types.ts';
import type { ProductStageId } from '../product-stages.ts';
import { ApiError } from './logic.ts';
import { submitAuth } from './workflow/http.ts';
import { journalRoot, listJournalDays, readJournalDay } from './company-journal.ts';
import { zoomFolder } from './zoom-folder.ts';

export function initCompany(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS company_notes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, reference TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS company_idea_sources(idea TEXT NOT NULL REFERENCES company_notes(id), source TEXT NOT NULL REFERENCES company_notes(id), PRIMARY KEY(idea,source));
    CREATE TABLE IF NOT EXISTS company_idea_products(idea TEXT NOT NULL REFERENCES company_notes(id), product TEXT NOT NULL REFERENCES projects(name), PRIMARY KEY(idea,product));
    CREATE TABLE IF NOT EXISTS company_projects(product TEXT NOT NULL REFERENCES projects(name), name TEXT NOT NULL, PRIMARY KEY(product,name));
    CREATE TABLE IF NOT EXISTS company_project_repos(product TEXT NOT NULL, name TEXT NOT NULL, repo TEXT NOT NULL COLLATE NOCASE REFERENCES project_repositories(full_name), PRIMARY KEY(product,name,repo), FOREIGN KEY(product,name) REFERENCES company_projects(product,name));
    CREATE TABLE IF NOT EXISTS company_idea_referrals(idea TEXT NOT NULL, product TEXT NOT NULL, name TEXT NOT NULL, opportunity_id TEXT NOT NULL REFERENCES opc_opportunities(id), PRIMARY KEY(idea,product,name), FOREIGN KEY(idea,product) REFERENCES company_idea_products(idea,product), FOREIGN KEY(product,name) REFERENCES company_projects(product,name));`);
  const missing = db.prepare('SELECT project,full_name FROM project_repositories r WHERE NOT EXISTS(SELECT 1 FROM company_project_repos p WHERE p.repo=r.full_name)').all();
  for (const row of missing) linkImportedRepo(db, String(row.project), String(row.full_name));
}

export function linkImportedRepo(db: DatabaseSync, product: string, repo: string) {
  // Keep same-slug repositories owned by different accounts in distinct projects.
  const slug = repo.split('/')[1];
  const collision = db.prepare('SELECT 1 FROM company_project_repos WHERE product=? AND name=? AND repo<>?').get(product,slug,repo);
  const name = collision ? repo.replace('/', ' · ') : slug;
  db.prepare('INSERT OR IGNORE INTO company_projects(product,name) VALUES(?,?)').run(product,name);
  db.prepare('INSERT OR IGNORE INTO company_project_repos(product,name,repo) VALUES(?,?,?)').run(product,name,repo);
}
const segment = zoomFolder.refine(s => !s.includes('/') && s.length<=160, '请使用单一名称');
const noteSchema = z.strictObject({ id:z.uuid(), title:z.string().trim().min(1).max(180).optional(), body:z.string().trim().max(5000).default(''), reference:z.string().trim().max(1500).default(''), sources:z.array(z.uuid()).max(64).default([]), products:z.array(segment).max(64).default([]) });
const ideaTarget = z.strictObject({product:segment, name:segment});
const projectSchema = z.strictObject({product:segment,name:segment,repos:z.array(z.string().max(255)).max(50).default([])});
function parse<T>(schema:z.ZodType<T>, input:unknown) { const r=schema.safeParse(input); if (!r.success) throw new ApiError(400,'company_input',r.error.issues.map(x=>x.path.join('.')+' '+x.message).join(' / ')); return r.data; }
function demand(ok:unknown,message:string) { if (!ok) throw new ApiError(409,'company_scope',message); }
function atom<T>(db:DatabaseSync, fn:()=>T) { if (db.isTransaction) return fn(); db.exec('BEGIN IMMEDIATE'); try {const result=fn(); db.exec('COMMIT');return result;} catch(e){db.exec('ROLLBACK');throw e;} }
export function validateStageScope(db:DatabaseSync, scope:{stage:ProductStageId;product:string;project?:string;companyItemId?:string}) {
  if(scope.stage==='research'||scope.stage==='idea') {
    demand(!scope.product&&!scope.project,'信息与想法归属公司');
    if(scope.companyItemId) demand(db.prepare('SELECT 1 FROM company_notes WHERE id=? AND kind=?').get(scope.companyItemId,scope.stage),'这条记录不属于当前公司阶段');
    return;
  }
  demand(!scope.companyItemId&&scope.product&&scope.project&&db.prepare('SELECT 1 FROM company_projects WHERE product=? AND name=?').get(scope.product,scope.project),'请先选择该产品下已登记的项目');
}
export class CompanyStore {
  constructor(private db:DatabaseSync) {}
  refer(ideaId: string, input: unknown, opportunities: OpportunityStore) {
    const target = parse(ideaTarget, input);
    return atom(this.db, () => {
      const index = this.index();
      const idea = index.ideas.find(candidate => candidate.id === ideaId);
      const project = index.projects.find(p => p.product === target.product && p.name === target.name);
      if (!project || !idea?.products.includes(target.product)) throw new ApiError(409, 'idea_project', '请先将想法关联到这个项目所属的产品。');
      const existing = index.referrals.find(link => link.idea === ideaId && link.product === target.product && link.name === target.name);
      if (existing) return {opportunityId:existing.opportunityId};
      const path = target.product + '/' + target.name;
      const digest = createHash('sha256').update(JSON.stringify([target.product,target.name])).digest('hex');
      const bound = (key:string) => Boolean(opportunities.projectInfo(key).workspace);
      const singleRepo = project.repos.length === 1 ? project.repos[0] : '';
      const key = path.length <= 256 && (bound(path) || !singleRepo || !bound(singleRepo)) ? path : singleRepo || 'opc-project/' + digest;
      const notes = index.information.filter(note => idea.sources.includes(note.id));
      const result = opportunities.addFromRecord({
        kind:'feature', project:key, sourceId:'company-idea/' + ideaId + '/' + digest, title:idea.title,
        rationale:(idea.body || idea.title).slice(0,1000),
        evidence:['#ideas?idea=' + ideaId, ('关联项目 ' + path).slice(0,360),
          ...notes.slice(0,3).flatMap(note => [note.reference.slice(0,360),note.body.slice(0,360)]).filter(Boolean)],
        impact:3, confidence:2, effort:3,
      });
      this.db.prepare('INSERT INTO company_idea_referrals VALUES(?,?,?,?)').run(ideaId,target.product,target.name,result.id);
      return {opportunityId:result.id};
    });
  }
  dispatch(ideaId: string, input: unknown, opportunities: OpportunityStore) {
    const target = parse(ideaTarget, input);
    const {opportunityId} = atom(this.db, () => {
      this.linkProduct(ideaId,target.product);
      const referred = this.refer(ideaId,target,opportunities);
      opportunities.requestDispatch(referred.opportunityId);
      return referred;
    });
    return {opportunityId, ...opportunities.advanceDispatch(opportunityId)};
  }
  index():CompanyIndex {
    const notes=this.db.prepare('SELECT id,kind,title,body,reference FROM company_notes ORDER BY rowid DESC').all() as (CompanyNote & {kind:string})[];
    const links=this.db.prepare('SELECT idea,source FROM company_idea_sources ORDER BY rowid').all();
    const products=this.db.prepare('SELECT idea,product FROM company_idea_products ORDER BY rowid').all();
    const repos=this.db.prepare('SELECT product,name,repo FROM company_project_repos ORDER BY repo').all();
    return {referrals:this.db.prepare('SELECT idea,product,name,opportunity_id AS opportunityId FROM company_idea_referrals ORDER BY rowid').all() as CompanyIndex["referrals"],information:notes.filter(n=>n.kind==='research'), ideas:notes.filter(n=>n.kind==='idea').map(n=>({...n,sources:links.filter(l=>l.idea===n.id).map(l=>String(l.source)),products:products.filter(l=>l.idea===n.id).map(l=>String(l.product))})),products:this.db.prepare('SELECT name FROM projects ORDER BY name').all().map(r=>String(r.name)),projects:this.db.prepare('SELECT product,name FROM company_projects ORDER BY product,name').all().map(r=>({product:String(r.product),name:String(r.name),repos:repos.filter(l=>l.product===r.product&&l.name===r.name).map(l=>String(l.repo))}))};
  }
  addNote(kind:'research'|'idea',input:unknown) {
    const n=parse(noteSchema,input);
    const title=n.title ?? (kind==='idea' ? n.body.split('\n').find(line=>line.trim())?.trim().slice(0,180) : undefined);
    if (!title) throw new ApiError(400,'company_input',kind==='idea' ? '请写下想验证什么。' : '请填写资料名称。');
    return atom(this.db,()=>{
      demand(kind==='idea'||(!n.sources.length&&!n.products.length),'信息记录无需关联上游产品');
      const old=this.db.prepare('SELECT * FROM company_notes WHERE id=?').get(n.id);
      if(old) demand(old.kind===kind&&old.title===title&&old.body===n.body&&old.reference===n.reference,'这条记录的 ID 已绑定其他内容');
      this.db.prepare('INSERT OR IGNORE INTO company_notes(id,kind,title,body,reference) VALUES (?,?,?,?,?)').run(n.id,kind,title,n.body,n.reference);
      for(const id of n.sources){demand(this.db.prepare("SELECT 1 FROM company_notes WHERE id=? AND kind='research'").get(id),'来源信息不存在');this.db.prepare('INSERT OR IGNORE INTO company_idea_sources VALUES(?,?)').run(n.id,id);}
      for(const product of n.products)this.linkProduct(n.id,product);
      return {id:n.id};
    });
  }
  linkProduct(idea:string,product:string){parse(segment,product);demand(this.db.prepare("SELECT 1 FROM company_notes WHERE id=? AND kind='idea'").get(idea),'找不到想法');demand(this.db.prepare('SELECT 1 FROM projects WHERE name=?').get(product),'找不到产品');this.db.prepare('INSERT OR IGNORE INTO company_idea_products VALUES(?,?)').run(idea,product);return {idea,product};}
  createProject(input:unknown) {
    const p=parse(projectSchema,input);return atom(this.db,()=>{demand(this.db.prepare('SELECT 1 FROM projects WHERE name=?').get(p.product),'请先创建产品');
      this.db.prepare('INSERT OR IGNORE INTO company_projects(product,name) VALUES(?,?)').run(p.product,p.name);
      for(const repo of p.repos){demand(this.db.prepare('SELECT 1 FROM project_repositories WHERE project=? AND full_name=?').get(p.product,repo),'仓库不属于此产品');this.db.prepare('INSERT OR IGNORE INTO company_project_repos VALUES(?,?,?)').run(p.product,p.name,repo);}
      return {product:p.product,name:p.name};
    });
  }
}
export function addCompanyRoutes(app:Hono,db:DatabaseSync,token:string|undefined,user:(c:Context)=>unknown,opportunities:OpportunityStore){
  const {permits}=submitAuth(token);const company=new CompanyStore(db);
  app.use('/api/zoom/company/*',async(c,next)=>{if(!permits(c))user(c);await next();});
  app.get('/api/zoom/company/journal',async c=>{user(c);return c.json(await listJournalDays(journalRoot()));});
  app.get('/api/zoom/company/journal/:day',async c=>{user(c);return c.json(await readJournalDay(journalRoot(),c.req.param('day')));});
  app.get('/api/zoom/company',c=>{if(!permits(c))user(c);return c.json(company.index());});
  app.post('/api/zoom/company/information',async c=>c.json(company.addNote('research',await c.req.json())));
  app.post('/api/zoom/company/ideas',async c=>c.json(company.addNote('idea',await c.req.json())));
  app.post('/api/zoom/company/ideas/:id/products',async c=>{const {product}=parse(z.strictObject({product:segment}),await c.req.json());return c.json(company.linkProduct(c.req.param('id'),product));});
  app.post('/api/zoom/company/ideas/:id/candidates',async c=>c.json(company.refer(c.req.param('id'),await c.req.json(),opportunities)));
  app.post('/api/zoom/company/ideas/:id/dispatch',async c=>{user(c);return c.json(company.dispatch(c.req.param('id'),await c.req.json(),opportunities));});
  app.post('/api/zoom/company/projects',async c=>c.json(company.createProject(await c.req.json())));
}
