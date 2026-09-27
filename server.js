import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data", "model-rigging-calibration.json");
const port = Number(process.env.PORT || 3038);
const seed = {
  "items": [
    {
      "code": "MR-001",
      "shipType": "福船",
      "scale": "1:48",
      "mastCount": 3,
      "riggingMaterial": "蜡线",
      "owner": "周宁",
      "dueDate": "2026-06-28",
      "status": "校准中",
      "tasks": [
        {
          "id": "T-1",
          "position": "前桅侧支索",
          "tension": "偏松",
          "handler": "周宁",
          "status": "调整中",
          "reviews": [],
          "logs": [
            {
              "at": "2026-06-12",
              "note": "已缩短2mm"
            }
          ]
        }
      ],
      "logs": []
    }
  ]
};
const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
const stages = ["待检查","校准中","待复核","已交付"];
const statLabels = ["待检查","校准中","待复核","已交付"];
const taskStages = ["待检查","调整中","待复核","复核通过"];
const extraFields = [["position","索具位置"],["tension","松紧状态"],["handler","处理人"],["note","调整备注"]];
const now = () => new Date().toISOString();

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  for (const item of db.items || []) {
    for (const task of item.tasks || []) {
      task.reviews ||= [];
      task.handler ||= item.owner || "";
    }
  }
  return db;
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "MR-" + Date.now(); }
function findItem(db, key) { return db.items.find(x => x.id === key || x.code === key); }
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const tasks = item.tasks || [];
  const logCount = (item.logs || []).length + tasks.reduce((n, t) => n + (t.logs || []).length, 0);
  const reviewCount = tasks.reduce((n, t) => n + (t.reviews || []).length, 0);
  const pendingTasks = tasks.filter(t => t.status !== "复核通过").length;
  return { ...item, logCount, reviewCount, pendingTasks };
}
function syncItemStatus(item) {
  if (item.status === "已交付") return;
  const tasks = item.tasks || [];
  if (!tasks.length) return;
  const next = tasks.every(t => t.status === "待复核" || t.status === "复核通过") ? "待复核" : "校准中";
  if (["待检查","校准中","待复核"].includes(item.status) && item.status !== next) {
    item.status = next;
    item.logs.push({ at: now(), step: "状态", note: "随任务进度更新为" + next });
  }
}
function deliveryBlockers(item) {
  return (item.tasks || [])
    .filter(t => t.status !== "复核通过")
    .map(t => ({ id: t.id, position: t.position, status: t.status, handler: t.handler || item.owner || "" }));
}
function deliverItem(item) {
  if (item.status === "已交付") return { ok: false, error: "already_delivered", message: "模型已交付", pending: [] };
  if (!(item.tasks || []).length) return { ok: false, error: "delivery_incomplete", message: "尚未拆分帆索任务，不能交付", pending: [] };
  const pending = deliveryBlockers(item);
  if (pending.length) return { ok: false, error: "delivery_incomplete", message: "还有 " + pending.length + " 项任务未复核通过", pending };
  item.status = "已交付";
  item.logs.push({ at: now(), step: "交付", note: "全部任务复核通过，模型交付完成" });
  return { ok: true };
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .tasks { display:grid; gap:8px; } .task { border:1px solid var(--line); border-radius:6px; padding:8px; display:grid; gap:4px; }
    .task-actions { display:flex; gap:6px; flex-wrap:wrap; } .task-actions button { padding:6px 9px; font-size:12px; }
    .notice { margin-bottom:14px; padding:10px 12px; border:1px solid var(--line); border-radius:6px; background:#fff; }
    .notice.warn-box { border-color:var(--warn); color:var(--warn); font-weight:700; } .notice.ok-box { border-color:var(--accent); color:var(--accent); font-weight:700; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索校准</h1><div class="meta">模型、帆索任务、复核结论和交付记录串联</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存模型</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>新增帆索任务</h2><label>选择模型</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
      <form id="reviewForm" style="margin-top:14px"><h2>复核帆索任务</h2><label>选择模型</label><select name="id" id="reviewItemSelect"></select><label>选择任务</label><select name="taskId" id="reviewTaskSelect"></select><label>复核人</label><input name="reviewer" required><label>结论</label><select name="result"><option>通过</option><option>不通过</option></select><label>原因（不通过时必填）</label><input name="reason"><label>下一次复查日期</label><input name="nextReviewDate" type="date"><button>保存复核结论</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态（模型/任务）</option>${[...new Set([...stages, ...taskStages])].map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号、任务或复核人"></div>
      <div class="notice" id="notice" hidden></div>
      <div class="panel"><h2>任务提交复核后记录复核人、结论和复查日期，全部任务复核通过后模型才能交付。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const stages = ["待检查","校准中","待复核","已交付"];
    const extraFields = [["position","索具位置"],["tension","松紧状态"],["handler","处理人"],["note","调整备注"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const reviewForm = document.querySelector('#reviewForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const reviewItemSelect = document.querySelector('#reviewItemSelect');
    const reviewTaskSelect = document.querySelector('#reviewTaskSelect');
    const statusFilter = document.querySelector('#statusFilter');
    const search = document.querySelector('#search');
    const notice = document.querySelector('#notice');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.message || data.error || '请求失败'); err.data = data; throw err; }
      return data;
    }
    function showNotice(msg, isError) {
      notice.textContent = msg;
      notice.className = 'notice ' + (isError ? 'warn-box' : 'ok-box');
      notice.hidden = false;
    }
    function showPending(e) {
      if (e.data && e.data.error === 'delivery_incomplete') {
        const pending = e.data.pending || [];
        showNotice((e.data.message || '交付未完成') + (pending.length ? '：' + pending.map(p => p.position + '（' + p.status + ' · 处理人 ' + (p.handler || '未指派') + '）').join('；') : ''), true);
      } else showNotice(e.message, true);
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function renderTaskOptions(keep) {
      const item = items.find(i => (i.id || i.code) === reviewItemSelect.value);
      const tasks = (item && item.tasks) || [];
      reviewTaskSelect.innerHTML = tasks.length
        ? tasks.map(t => '<option value="'+t.id+'">'+t.position+' · '+t.status+'</option>').join('')
        : '<option value="">暂无任务</option>';
      if (keep && tasks.some(t => t.id === keep)) reviewTaskSelect.value = keep;
      else { const pending = tasks.find(t => t.status === '待复核'); if (pending) reviewTaskSelect.value = pending.id; }
    }
    function render() {
      const prevAction = itemSelect.value, prevReviewItem = reviewItemSelect.value, prevReviewTask = reviewTaskSelect.value;
      const options = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.shipType || '')+'</option>').join('');
      itemSelect.innerHTML = options;
      reviewItemSelect.innerHTML = options;
      if (items.some(i => (i.id || i.code) === prevAction)) itemSelect.value = prevAction;
      if (items.some(i => (i.id || i.code) === prevReviewItem)) reviewItemSelect.value = prevReviewItem;
      renderTaskOptions(prevReviewTask);
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      const allTasks = items.flatMap(i => i.tasks || []);
      stats['待复核任务'] = allTasks.filter(t => t.status === '待复核').length;
      stats['待处理任务'] = allTasks.filter(t => t.status === '待检查' || t.status === '调整中').length;
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = statusFilter.value;
      const q = search.value.trim();
      const visible = items.filter(item => (!status || item.status === status || (item.tasks || []).some(t => t.status === status)) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('') || '<div class="meta">暂无模型</div>';
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => {
        try { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); showNotice('状态已更新。', false); }
        catch (e) { showPending(e); }
        await load();
      });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
      document.querySelectorAll('[data-deliver]').forEach(btn => btn.onclick = async () => {
        try { await api('/api/items/'+btn.dataset.deliver+'/deliver', { method:'POST', body: '{}' }); showNotice('全部任务复核通过，模型交付完成。', false); }
        catch (e) { showPending(e); }
        await load();
      });
      document.querySelectorAll('[data-start]').forEach(btn => btn.onclick = async () => {
        try { await api('/api/items/'+btn.dataset.item+'/tasks/'+btn.dataset.start, { method:'PATCH', body: JSON.stringify({ status: '调整中' }) }); }
        catch (e) { showNotice(e.message, true); }
        await load();
      });
      document.querySelectorAll('[data-submit]').forEach(btn => btn.onclick = async () => {
        try { await api('/api/items/'+btn.dataset.item+'/tasks/'+btn.dataset.submit+'/submit', { method:'POST', body: '{}' }); showNotice('任务已提交复核。', false); }
        catch (e) { showNotice(e.message, true); }
        await load();
      });
      document.querySelectorAll('[data-assign]').forEach(btn => btn.onclick = async () => {
        const handler = prompt('指派处理人');
        if (handler) {
          try { await api('/api/items/'+btn.dataset.item+'/tasks/'+btn.dataset.assign, { method:'PATCH', body: JSON.stringify({ handler }) }); }
          catch (e) { showNotice(e.message, true); }
          await load();
        }
      });
      document.querySelectorAll('[data-review]').forEach(btn => btn.onclick = () => {
        reviewItemSelect.value = btn.dataset.item;
        renderTaskOptions(btn.dataset.review);
        reviewForm.scrollIntoView({ behavior: 'smooth' });
        reviewForm.querySelector('[name=reviewer]').focus();
      });
    }
    function taskHtml(item, t) {
      const itemId = item.id || item.code;
      const reviews = t.reviews || [];
      const last = reviews[reviews.length - 1];
      const reviewLine = last
        ? '复核 ' + reviews.length + ' 次 · 最近 ' + String(last.at || '').slice(0, 10) + ' · ' + last.reviewer + ' ' + last.result + (last.reason ? ' · 原因：' + last.reason : '') + (last.nextReviewDate ? ' · 复查 ' + last.nextReviewDate : '')
        : '暂无复核记录';
      const buttons = [];
      if (t.status === '待检查') buttons.push('<button data-start="'+t.id+'" data-item="'+itemId+'">开始调整</button>');
      if (t.status === '待检查' || t.status === '调整中') buttons.push('<button data-submit="'+t.id+'" data-item="'+itemId+'">提交复核</button>');
      if (t.status === '待复核') buttons.push('<button data-review="'+t.id+'" data-item="'+itemId+'">填写复核结论</button>');
      buttons.push('<button class="secondary" data-assign="'+t.id+'" data-item="'+itemId+'">指派</button>');
      return '<div class="task"><div><b>'+(t.position || '')+'</b> <span class="pill">'+t.status+'</span></div>'
        + '<div class="meta">松紧：'+(t.tension || '未记录')+' · 处理人：'+(t.handler || item.owner || '未指派')+' · 当前步骤：'+t.status+'</div>'
        + '<div class="meta">'+reviewLine+'</div>'
        + '<div class="task-actions">'+buttons.join('')+'</div></div>';
    }
    function cardHtml(item) {
      const itemId = item.id || item.code;
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => taskHtml(item, t)).join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+(l.step || '记录')+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main
        + '<div class="tasks">'+(tasks || '<div class="meta">暂无帆索任务</div>')+'</div>'
        + '<label>状态</label><select data-status="'+itemId+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select>'
        + '<div class="task-actions"><button class="secondary" data-note="'+itemId+'">追加备注</button><button data-deliver="'+itemId+'">交付保存</button></div>'
        + '<div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    reviewForm.onsubmit = async event => {
      event.preventDefault();
      const input = Object.fromEntries(new FormData(reviewForm).entries());
      try {
        await api('/api/items/'+input.id+'/tasks/'+input.taskId+'/review', { method:'POST', body: JSON.stringify(input) });
        reviewForm.reset();
        showNotice('复核结论已保存。', false);
        await load();
      } catch (e) { showNotice(e.message, true); }
    };
    reviewItemSelect.onchange = () => renderTaskOptions();
    statusFilter.onchange = render; search.oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: newId(), ...input, logs: [{ at: now(), step: "建档", note: "创建模型" }] };
      item.tasks = [];
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    const deliver = url.pathname.match(/^\/api\/items\/([^/]+)\/deliver$/);
    if (deliver && req.method === "POST") {
      const item = findItem(db, deliver[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      item.logs ||= [];
      const result = deliverItem(item);
      if (!result.ok) {
        const { ok, ...payload } = result;
        return send(res, 409, payload);
      }
      await saveDb(db);
      return send(res, 200, item);
    }
    const taskAction = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks\/([^/]+)\/(submit|review)$/);
    if (taskAction && req.method === "POST") {
      const item = findItem(db, taskAction[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const task = (item.tasks || []).find(t => t.id === taskAction[2]);
      if (!task) return send(res, 404, { error: "task_not_found" });
      const input = await body(req);
      task.logs ||= [];
      task.reviews ||= [];
      item.logs ||= [];
      if (taskAction[3] === "submit") {
        if (task.status === "待复核") return send(res, 409, { error: "task_already_submitted", message: "任务已提交，等待复核结论" });
        if (task.status === "复核通过") return send(res, 409, { error: "task_already_passed", message: "任务已复核通过" });
        if (input.handler) task.handler = String(input.handler).trim();
        task.handler ||= item.owner || "";
        task.status = "待复核";
        task.logs.push({ at: now(), note: "提交复核 · 处理人 " + (task.handler || "未指派") });
        item.logs.push({ at: now(), step: "帆索", note: task.position + " 提交复核" });
        syncItemStatus(item);
        await saveDb(db);
        return send(res, 200, item);
      }
      const reviewer = String(input.reviewer || "").trim();
      if (!reviewer) return send(res, 400, { error: "reviewer_required", message: "请填写复核人" });
      if (!["通过", "不通过"].includes(input.result)) return send(res, 400, { error: "result_required", message: "结论只能是通过或不通过" });
      if (task.status !== "待复核") return send(res, 409, { error: "task_not_pending_review", message: "任务不在待复核状态，请先提交复核" });
      const reason = String(input.reason || "").trim();
      if (input.result === "不通过" && !reason) return send(res, 400, { error: "reason_required", message: "复核不通过必须填写原因" });
      const review = { at: now(), reviewer, result: input.result, reason, nextReviewDate: input.nextReviewDate || "" };
      task.reviews.push(review);
      task.status = input.result === "通过" ? "复核通过" : "调整中";
      task.logs.push({ at: now(), note: "复核" + input.result + " · 复核人 " + reviewer + (reason ? " · 原因：" + reason : "") + (review.nextReviewDate ? " · 复查 " + review.nextReviewDate : "") });
      item.logs.push({ at: now(), step: "复核", note: task.position + " " + input.result + (reason ? " · " + reason : "") });
      syncItemStatus(item);
      await saveDb(db);
      return send(res, 200, item);
    }
    const taskPatch = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks\/([^/]+)$/);
    if (taskPatch && req.method === "PATCH") {
      const item = findItem(db, taskPatch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const task = (item.tasks || []).find(t => t.id === taskPatch[2]);
      if (!task) return send(res, 404, { error: "task_not_found" });
      const input = await body(req);
      task.logs ||= [];
      item.logs ||= [];
      const notes = [];
      if (input.handler !== undefined && input.handler !== task.handler) { task.handler = String(input.handler).trim(); notes.push("处理人改为 " + (task.handler || "未指派")); }
      if (input.tension !== undefined && input.tension !== task.tension) { task.tension = input.tension; notes.push("松紧状态改为 " + input.tension); }
      if (input.position !== undefined && input.position !== task.position) { task.position = input.position; notes.push("位置改为 " + input.position); }
      if (input.status !== undefined && input.status !== task.status) {
        if (!["待检查", "调整中"].includes(input.status)) return send(res, 400, { error: "invalid_task_status", message: "任务状态只能改为待检查或调整中，复核请走复核流程" });
        if (["待复核", "复核通过"].includes(task.status)) return send(res, 409, { error: "task_in_review", message: "任务已在复核流程中，不能直接改状态" });
        task.status = input.status;
        notes.push("状态改为 " + input.status);
      }
      if (input.note) notes.push(String(input.note));
      if (notes.length) {
        task.logs.push({ at: now(), note: notes.join(" · ") });
        item.logs.push({ at: now(), step: "帆索", note: task.position + " · " + notes.join(" · ") });
        syncItemStatus(item);
        await saveDb(db);
      }
      return send(res, 200, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = findItem(db, patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      delete input.id; delete input.tasks; delete input.logs; delete input.reviews;
      if (input.status === "已交付" && item.status !== "已交付") {
        item.logs ||= [];
        const result = deliverItem(item);
        if (!result.ok) {
          const { ok, ...payload } = result;
          return send(res, 409, payload);
        }
        delete input.status;
        Object.assign(item, input);
        await saveDb(db);
        return send(res, 200, item);
      }
      Object.assign(item, input);
      item.logs ||= [];
      item.logs.push({ at: now(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = findItem(db, log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: now(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = findItem(db, action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.tasks ||= [];
      item.tasks.push({ id: "T-" + Date.now(), position: input.position, tension: input.tension, handler: input.handler || item.owner || "", status: "待检查", reviews: [], logs: [{ at: now(), note: input.note || "新增帆索任务" }] });
      item.status = "校准中";
      item.logs.push({ at: now(), step: "帆索", note: input.position + " · " + input.tension });
      await saveDb(db);
      return send(res, 201, item);
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + port));
