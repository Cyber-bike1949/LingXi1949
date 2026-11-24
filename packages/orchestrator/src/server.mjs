import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`${JSON.stringify(body)}\n`);
}

function html(response, body) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

const dashboard = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LingXi 编排器</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#111827;color:#e5e7eb}body{margin:0;max-width:1180px;padding:24px;margin:auto}h1{margin:0 0 6px}.muted{color:#9ca3af}button{border:0;border-radius:6px;background:#2563eb;color:white;padding:8px 12px;cursor:pointer}button:disabled{opacity:.5;cursor:wait}input,textarea{box-sizing:border-box;width:100%;margin:5px 0 14px;padding:10px;border:1px solid #4b5563;border-radius:6px;background:#030712;color:#e5e7eb}textarea{min-height:130px;font:inherit}label{display:block;font-weight:600}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{text-align:left;padding:10px;border-bottom:1px solid #374151}tr[data-id]{cursor:pointer}tr[data-id]:hover{background:#1f2937}.state{font-weight:700}.ok{color:#34d399}.bad{color:#f87171}.pending{color:#fbbf24}#detail,.panel{margin-top:24px;padding:18px;background:#1f2937;border-radius:8px;white-space:pre-wrap;overflow:auto}#auth{max-width:500px;margin:40px auto}#create{display:none}.row{display:flex;gap:10px;align-items:center}.row>*{width:auto}.notice{color:#fbbf24;white-space:pre-wrap}pre{overflow:auto}</style></head>
<body><h1>LingXi 研发编排器</h1><p class="muted">提交经你确认的需求与用例，创建任务后由已配置的设备、AI CLI 和 GitHub 工作流执行。发布仍需要单独审批。</p>
<section id="auth" class="panel"><h2>登录体验环境</h2><label for="token">临时访问令牌</label><input id="token" type="password" autocomplete="current-password"><div class="row"><button id="login">登录</button><span id="authStatus" class="muted"></span></div></section>
<main id="app" hidden><section id="create" class="panel"><h2>创建研发任务</h2><p id="projectInfo" class="muted"></p><form id="taskForm"><label>任务标题</label><input name="title" required maxlength="120" placeholder="例如：事项列表增加优先级筛选"><label>审批人</label><input name="approvedBy" required maxlength="80" placeholder="你的姓名"><label>需求文档</label><textarea name="requirement" required maxlength="100000" placeholder="写清用户目标、范围和验收标准"></textarea><label>测试用例</label><textarea name="testCases" required maxlength="100000" placeholder="写清测试步骤与预期结果"></textarea><label><input name="confirmed" type="checkbox" required style="width:auto"> 我已评审并批准以上需求和用例；创建后验收条件将冻结。</label><button id="createButton" type="submit">创建并执行任务</button><p class="notice">任务会在已配置的目标仓库和设备上运行 AI CLI，并可能创建分支、提交代码及触发 GitHub Actions。</p></form></section>
<div class="row"><button id="refresh">刷新任务</button><button id="logout" style="background:#4b5563">退出</button><span id="status" class="muted"></span></div><table><thead><tr><th>任务</th><th>状态</th><th>分支</th><th>更新时间</th></tr></thead><tbody id="tasks"></tbody></table><section id="detail" hidden></section></main>
<script>
const auth=document.querySelector('#auth'),app=document.querySelector('#app'),tasks=document.querySelector('#tasks'),detail=document.querySelector('#detail'),status=document.querySelector('#status'),authStatus=document.querySelector('#authStatus');
let token='';const text=v=>v==null?'':String(v);const stateClass=s=>s==='RC_READY'||s==='RELEASED'?'ok':s.includes('BLOCKED')||s==='FIXING'||s==='CANCELLED'?'bad':'pending';
async function api(path,options={}){return fetch(path,{...options,headers:{...(options.headers||{}),...(token?{authorization:'Bearer '+token}:{})}})}
function cell(value){const td=document.createElement('td');td.textContent=text(value);return td}
async function show(id){const r=await api('/tasks/'+encodeURIComponent(id));if(!r.ok)throw Error('读取任务失败');const d=await r.json();detail.hidden=false;detail.replaceChildren();const title=document.createElement('h2');title.textContent=d.task.id+'：'+d.task.title;detail.append(title);const meta=document.createElement('p');meta.textContent='状态：'+d.task.state+'　交付分支：'+d.task.branch;detail.append(meta);for(const [name,values] of Object.entries({执行节点:d.nodes,GitHub工作流:d.workflows,制品:d.artifacts,最近事件:d.events.slice(-12)})){const h=document.createElement('h3');h.textContent=name;detail.append(h);const pre=document.createElement('pre');pre.textContent=JSON.stringify(values,null,2);detail.append(pre)}}
async function load(){status.textContent=' 正在加载…';try{const r=await api('/tasks');if(r.status===401){logout();return}if(!r.ok)throw Error('HTTP '+r.status);const data=await r.json();tasks.replaceChildren();for(const item of data){const tr=document.createElement('tr');tr.dataset.id=item.id;tr.append(cell(item.id+'：'+item.title));const state=cell(item.state);state.className='state '+stateClass(item.state);tr.append(state,cell(item.branch),cell(item.updatedAt));tr.onclick=()=>show(item.id).catch(e=>status.textContent=' '+e.message);tasks.append(tr)}status.textContent=' '+new Date().toLocaleTimeString()}catch(error){status.textContent=' 加载失败：'+error.message}}
function logout(){token='';sessionStorage.removeItem('lingxi-token');auth.hidden=false;app.hidden=true;document.querySelector('#token').value=''}
async function login(){authStatus.textContent='验证中…';token=document.querySelector('#token').value;try{const r=await api('/tasks');if(!r.ok)throw Error(r.status===401?'令牌不正确':'HTTP '+r.status);sessionStorage.setItem('lingxi-token',token);auth.hidden=true;app.hidden=false;const meta=await api('/meta').then(x=>x.json());document.querySelector('#create').style.display=meta.writable?'block':'none';document.querySelector('#projectInfo').textContent=meta.repository?'目标仓库：'+meta.repository+'（默认分支 '+meta.defaultBranch+'）'+(meta.writeDisabledReason?'；当前只读：'+meta.writeDisabledReason:''):'当前为只读模式';await load()}catch(error){token='';authStatus.textContent=error.message}}
document.querySelector('#login').onclick=login;document.querySelector('#token').addEventListener('keydown',e=>{if(e.key==='Enter')login()});document.querySelector('#refresh').onclick=load;document.querySelector('#logout').onclick=logout;
document.querySelector('#taskForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,button=document.querySelector('#createButton'),data=Object.fromEntries(new FormData(form));data.confirmed=form.elements.confirmed.checked;button.disabled=true;status.textContent=' 正在创建任务…';try{const created=await api('/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const result=await created.json();if(!created.ok)throw Error(result.error||'创建失败');const started=await api('/tasks/'+encodeURIComponent(result.id)+'/run',{method:'POST'});const run=await started.json();if(!started.ok)throw Error(run.error||'启动失败');form.reset();status.textContent=' 已启动 '+result.id;await load();await show(result.id)}catch(error){status.textContent=' '+error.message}finally{button.disabled=false}});
const saved=sessionStorage.getItem('lingxi-token');if(saved){document.querySelector('#token').value=saved;login()}else document.querySelector('#token').focus();setInterval(()=>{if(!app.hidden)load()},10000);
</script></body></html>`;

function publicEventData(value) {
  if (Array.isArray(value)) return value.map(publicEventData);
  if (!value || typeof value !== 'object') return value;
  const hidden = /stdout|stderr|output|prompt|content|token|secret|credential|authorization|webhook|error|message/i;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !hidden.test(key))
    .map(([key, child]) => [key, publicEventData(child)]));
}

function publicEvents(events) {
  return events.map(event => ({ type: event.type, createdAt: event.createdAt, data: publicEventData(event.data) }));
}

function matchesToken(request, expected) {
  const supplied = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
  const actual = Buffer.from(supplied);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function readJson(request, maxBytes = 220_000) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('INVALID_JSON'); }
}

export function serve(store, portOrOptions = 43194) {
  const options = typeof portOrOptions === 'number' ? { port: portOrOptions } : portOrOptions;
  const { port = 43194, host = '127.0.0.1', authToken, createTask, runTask, writeDisabledReason, projectInfo } = options;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const isWrite = request.method !== 'GET' && request.method !== 'HEAD';
    if (request.method === 'GET' && url.pathname === '/') return html(response, dashboard);
    if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true });
    if (authToken && !matchesToken(request, authToken)) return json(response, 401, { error: 'UNAUTHORIZED' });
    if (isWrite && !authToken) return json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (isWrite && request.headers.origin) {
      let originHost = '';
      try { originHost = new URL(request.headers.origin).host; } catch {}
      if (!originHost || originHost !== request.headers.host) return json(response, 403, { error: 'CROSS_ORIGIN_WRITE_REJECTED' });
    }
    if (request.method === 'GET' && url.pathname === '/meta') return json(response, 200, { writable: Boolean(createTask && runTask), repository: projectInfo?.repository ?? null, defaultBranch: projectInfo?.defaultBranch ?? null, writeDisabledReason: writeDisabledReason ?? null });
    if (request.method === 'GET' && url.pathname === '/tasks') return json(response, 200, store.list());
    if (request.method === 'POST' && url.pathname === '/tasks') {
      if (!createTask) return json(response, 503, { error: 'TASK_CREATION_NOT_CONFIGURED' });
      try {
        const input = await readJson(request);
        for (const key of ['title', 'approvedBy', 'requirement', 'testCases']) if (typeof input[key] !== 'string' || !input[key].trim()) return json(response, 400, { error: `INVALID_${key.toUpperCase()}` });
        if (input.confirmed !== true) return json(response, 400, { error: 'REQUIREMENT_APPROVAL_REQUIRED' });
        if (input.title.length > 120 || input.approvedBy.length > 80 || input.requirement.length > 100_000 || input.testCases.length > 100_000) return json(response, 413, { error: 'FIELD_TOO_LARGE' });
        return json(response, 201, await createTask({ title: input.title.trim(), approvedBy: input.approvedBy.trim(), requirementContent: input.requirement, testCaseContent: input.testCases }));
      } catch (error) { return json(response, 400, { error: error.message }); }
    }
    const runMatch = /^\/tasks\/([^/]+)\/run$/.exec(url.pathname);
    if (request.method === 'POST' && runMatch) {
      if (!runTask) return json(response, 503, { error: 'TASK_RUNNER_NOT_CONFIGURED' });
      try { return json(response, 202, await runTask(decodeURIComponent(runMatch[1]))); }
      catch (error) { return json(response, 409, { error: error.message }); }
    }
    const match = /^\/tasks\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && match) {
      try {
        const id = decodeURIComponent(match[1]);
        return json(response, 200, { task: store.get(id), nodes: store.nodes(id), workflows: store.workflows(id), artifacts: store.artifacts(id), events: publicEvents(store.events(id)) });
      } catch (error) { return json(response, 404, { error: error.message }); }
    }
    if (request.method !== 'GET' && request.method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    return json(response, 404, { error: 'NOT_FOUND' });
  });
  return new Promise(resolve => server.listen(port, host, () => resolve(server)));
}

export function approvedTaskInput(input) {
  return {
    ...input,
    requirementHash: createHash('sha256').update(input.requirementContent).digest('hex'),
    testCaseHash: createHash('sha256').update(input.testCaseContent).digest('hex')
  };
}
