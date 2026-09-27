import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "model-rigging-calibration.json");
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
          "status": "调整中",
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
const taskStages = ["待检查","调整中","待复核","已通过"];
const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
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
function nowAt() { return new Date().toISOString(); }
function findItem(db, key) {
  return db.items.find(x => x.id === key || x.code === key);
}
function lastReview(task) {
  const reviews = task.reviews || [];
  return reviews.length ? reviews[reviews.length - 1] : null;
}
function taskHandler(item, task) {
  return task.handler || item.owner || "未指派";
}
// 交付前置检查：返回未完成明细；空数组表示可以交付。不会修改模型任何数据。
function deliveryBlockers(item) {
  const tasks = item.tasks || [];
  if (!tasks.length) {
    return [{ taskId: null, position: "（整体）", status: "无帆索任务", handler: item.owner || "", reason: "尚未登记帆索任务，无法交付" }];
  }
  return tasks.filter(t => t.status !== "已通过").map(t => {
    const last = lastReview(t);
    let reason;
    if (t.status === "调整中") {
      reason = last && last.conclusion === "不通过" ? "复核未通过，退回调整：" + last.reason : "待调整后重新提交复核";
    } else if (t.status === "待复核") {
      reason = "已提交复核，等待复核结论";
    } else {
      reason = "尚未提交复核";
    }
    return { taskId: t.id, position: t.position, status: t.status, handler: taskHandler(item, t), reason };
  });
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const tasks = (item.tasks || []).map(t => ({
    ...t,
    reviews: t.reviews || [],
    handler: taskHandler(item, t)
  }));
  const logCount = (item.logs || []).length + tasks.reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, tasks, logCount };
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
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .task { border-top:1px dashed var(--line); padding-top:8px; display:grid; gap:6px; }
    .taskform { display:flex; flex-wrap:wrap; gap:6px; } .taskform input,.taskform select { flex:1 1 140px; width:auto; } .taskform textarea { flex-basis:100%; min-height:48px; } .taskform button { padding:7px 10px; }
    .reviews { margin:2px 0 0; padding-left:18px; font-size:12px; color:var(--muted); display:grid; gap:2px; } .reviews .fail { color:var(--warn); } .reviews .ok { color:var(--accent); font-weight:700; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索校准</h1><div class="meta">帆索任务逐项复核，全部通过后方可交付</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存模型</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>新增帆索任务</h2><label>选择模型</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索模型或任务（编号 / 位置 / 复核人）"></div>
      <div class="panel"><h2>每项帆索任务可逐项提交复核，登记复核人、结论和下一次复查日期；复核不通过退回调整，全部任务通过后模型才能交付。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const stages = ["待检查","校准中","待复核","已交付"];
    const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) { const error = new Error(data.error || '请求失败'); error.data = data; throw error; }
      return data;
    }
    function reportError(error) {
      const unfinished = error.data && error.data.unfinished;
      if (unfinished && unfinished.length) {
        alert('交付未完成，仍有任务未通过复核：\\n' + unfinished.map(t => '· ' + t.position + '（' + t.status + '，处理人：' + t.handler + '）' + (t.reason ? '：' + t.reason : '')).join('\\n'));
      } else if (error.data && error.data.message) {
        alert(error.data.message);
      } else {
        alert(error.message || '请求失败');
      }
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function itemMatches(item, q, status) {
      if (status && item.status !== status && !(item.tasks || []).some(t => t.status === status)) return false;
      if (!q) return true;
      const modelText = fields.map(([key]) => item[key]).join(' ') + ' ' + (item.status || '');
      const taskText = (item.tasks || []).map(t => [
        t.position, t.tension, t.status, t.handler,
        ...(t.reviews || []).map(r => [r.reviewer, r.conclusion, r.reason, r.nextReviewDate].join(' ')),
        ...(t.logs || []).map(l => l.note)
      ].join(' ')).join(' ');
      return (modelText + ' ' + taskText).includes(q);
    }
    function stepHint(item, t) {
      const reviews = t.reviews || [];
      const last = reviews.length ? reviews[reviews.length - 1] : null;
      if (t.status === '待检查') return '卡在待检查，等待提交复核';
      if (t.status === '调整中') return last && last.conclusion === '不通过' ? '卡在调整，上次复核未通过：' + last.reason : '卡在调整，调整后重新提交复核';
      if (t.status === '待复核') return '卡在待复核，等待复核结论' + (t.handler && t.handler !== item.owner ? '（指派复核人：' + t.handler + '）' : '');
      return '复核已通过，下一次复查 ' + ((last && last.nextReviewDate) || '—');
    }
    function taskHtml(item, t) {
      const iid = item.id || item.code;
      const handler = t.handler || item.owner || '未指派';
      const reviews = t.reviews || [];
      const reviewHtml = reviews.length
        ? '<ul class="reviews">' + reviews.map(r => '<li class="' + (r.conclusion === '通过' ? 'ok' : 'fail') + '">' + r.at.slice(0, 10) + ' · 复核人 ' + r.reviewer + ' · ' + r.conclusion + (r.nextReviewDate ? ' · 下次复查 ' + r.nextReviewDate : '') + (r.reason ? ' · 原因：' + r.reason : '') + '</li>').join('') + '</ul>'
        : '<div class="meta">暂无复核记录</div>';
      let actions = '';
      if (t.status === '待检查' || t.status === '调整中') {
        actions = '<form class="taskform" data-item="' + iid + '" data-task="' + t.id + '">'
          + (t.status === '调整中' ? '<input name="note" placeholder="调整说明（可选）">' : '')
          + '<input name="reviewer" placeholder="指派复核人（可选）">'
          + '<button type="button" data-task-action="submit">提交复核</button>'
          + (t.status === '调整中' ? '<button type="button" class="secondary" data-task-action="adjust">记录调整</button>' : '')
          + '</form>';
      } else if (t.status === '待复核') {
        actions = '<form class="taskform" data-item="' + iid + '" data-task="' + t.id + '">'
          + '<input name="reviewer" placeholder="复核人" required>'
          + '<select name="conclusion"><option value="通过">复核通过</option><option value="不通过">复核不通过</option></select>'
          + '<input name="nextReviewDate" type="date" title="下一次复查日期（通过时必填）">'
          + '<textarea name="reason" placeholder="不通过时必须填写原因"></textarea>'
          + '<button type="button" data-task-action="review">提交复核结论</button></form>';
      }
      return '<div class="task"><div><b>' + t.position + '</b> <span class="pill">' + t.status + '</span> <span class="meta">松紧：' + (t.tension || '—') + '</span></div>'
        + '<div class="meta">当前处理人：' + handler + ' · ' + stepHint(item, t) + '</div>'
        + reviewHtml + actions + '</div>';
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => itemMatches(item, q, status));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => {
        try { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); }
        catch (error) { reportError(error); await load(); }
      });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
    }
    function cardHtml(item) {
      const iid = item.id || item.code;
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => taskHtml(item, t)).join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main
        + (tasks || '<div class="meta">暂无帆索任务</div>')
        + '<button data-deliver="'+iid+'">全部复核通过，交付模型</button>'
        + '<label>模型状态</label><select data-status="'+iid+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+iid+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    cards.addEventListener('click', async event => {
      const btn = event.target.closest('button');
      if (!btn || !cards.contains(btn)) return;
      try {
        if (btn.dataset.deliver) {
          await api('/api/items/' + btn.dataset.deliver + '/deliver', { method: 'POST' });
          await load();
          return;
        }
        const action = btn.dataset.taskAction;
        if (action) {
          const form = btn.closest('form');
          const payload = Object.fromEntries(new FormData(form).entries());
          await api('/api/items/' + form.dataset.item + '/tasks/' + form.dataset.task + '/' + action, { method: 'POST', body: JSON.stringify(payload) });
          await load();
        }
      } catch (error) { reportError(error); await load(); }
    });
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
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
      const item = { id: newId(), ...input, logs: [{ at: nowAt(), step: "建档", note: "创建模型" }] };
      item.tasks = [];
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = findItem(db, patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      // 直接改为已交付同样要走全任务复核校验，校验失败不改动状态和日志
      if (input.status === "已交付" && item.status !== "已交付") {
        const blockers = deliveryBlockers(item);
        if (blockers.length) return send(res, 409, { error: "delivery_unfinished", unfinished: blockers });
      }
      if (input.status) {
        item.status = input.status;
        item.logs ||= [];
        item.logs.push({ at: nowAt(), step: "状态", note: "更新为" + item.status });
      }
      await saveDb(db);
      return send(res, 200, item);
    }
    const deliver = url.pathname.match(/^\/api\/items\/([^/]+)\/deliver$/);
    if (deliver && req.method === "POST") {
      const item = findItem(db, deliver[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      if (item.status === "已交付") return send(res, 200, summarize(item));
      const blockers = deliveryBlockers(item);
      if (blockers.length) {
        // 未完成：仅返回明细，模型状态与已有日志保持不变（不落盘）
        return send(res, 409, { error: "delivery_unfinished", unfinished: blockers });
      }
      item.status = "已交付";
      item.logs ||= [];
      item.logs.push({ at: nowAt(), step: "交付", note: "全部帆索任务复核通过，模型交付完成" });
      await saveDb(db);
      return send(res, 200, summarize(item));
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = findItem(db, log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: nowAt(), step: input.step || "记录", note: input.note || "" });
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
      item.tasks.push({
        id: "T-" + Date.now(),
        position: input.position,
        tension: input.tension,
        status: "待检查",
        handler: item.owner || "",
        logs: [{ at: nowAt(), note: input.note || "新增帆索任务" }],
        reviews: []
      });
      item.status = "校准中";
      item.logs.push({ at: nowAt(), step: "帆索", note: input.position + " · " + input.tension });
      await saveDb(db);
      return send(res, 201, item);
    }
    const taskRoute = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks\/([^/]+)\/(submit|review|adjust)$/);
    if (taskRoute && req.method === "POST") {
      const item = findItem(db, taskRoute[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const task = (item.tasks || []).find(t => t.id === taskRoute[2]);
      if (!task) return send(res, 404, { error: "task_not_found" });
      const actionName = taskRoute[3];
      const input = await body(req);
      item.logs ||= [];
      task.logs ||= [];
      task.reviews ||= [];
      if (actionName === "submit") {
        // 待检查 / 调整中 → 待复核；历史复核记录原样保留
        if (!["待检查", "调整中"].includes(task.status)) {
          return send(res, 400, { error: "invalid_task_status", message: "只有待检查或调整中的任务可以提交复核" });
        }
        task.status = "待复核";
        if (input.reviewer && input.reviewer.trim()) task.handler = input.reviewer.trim();
        if (input.note && input.note.trim()) task.logs.push({ at: nowAt(), note: "调整说明：" + input.note.trim() });
        task.logs.push({ at: nowAt(), note: "提交复核" + (task.handler ? "，指派复核人：" + task.handler : "") });
        item.logs.push({ at: nowAt(), step: "复核", note: task.position + " 提交复核" });
      } else if (actionName === "review") {
        if (task.status !== "待复核") {
          return send(res, 400, { error: "invalid_task_status", message: "只有待复核的任务可以登记复核结论" });
        }
        const reviewer = (input.reviewer || "").trim();
        if (!reviewer) return send(res, 400, { error: "field_required", field: "reviewer", message: "请填写复核人" });
        const conclusion = input.conclusion === "通过" || input.conclusion === "不通过" ? input.conclusion : "";
        if (!conclusion) return send(res, 400, { error: "field_required", field: "conclusion", message: "请选择复核结论" });
        const reason = (input.reason || "").trim();
        const nextReviewDate = input.nextReviewDate || "";
        if (conclusion === "通过" && !nextReviewDate) {
          return send(res, 400, { error: "field_required", field: "nextReviewDate", message: "复核通过时请填写下一次复查日期" });
        }
        if (conclusion === "不通过" && !reason) {
          return send(res, 400, { error: "field_required", field: "reason", message: "复核不通过时请填写退回原因" });
        }
        task.reviews.push({ at: nowAt(), reviewer, conclusion, nextReviewDate, reason });
        if (conclusion === "通过") {
          task.status = "已通过";
          task.handler = reviewer;
          task.logs.push({ at: nowAt(), note: "复核通过（复核人：" + reviewer + "），下一次复查 " + nextReviewDate });
          item.logs.push({ at: nowAt(), step: "复核", note: task.position + " 复核通过" });
        } else {
          // 不通过：退回调整中，任务交回负责人处理，原因进入复核记录
          task.status = "调整中";
          task.handler = item.owner || task.handler;
          task.logs.push({ at: nowAt(), note: "复核不通过，退回调整：" + reason });
          item.logs.push({ at: nowAt(), step: "复核", note: task.position + " 复核不通过，退回调整：" + reason });
        }
      } else {
        if (task.status !== "调整中") {
          return send(res, 400, { error: "invalid_task_status", message: "只有调整中的任务可以记录调整" });
        }
        const note = (input.note || "").trim();
        if (input.handler && input.handler.trim()) task.handler = input.handler.trim();
        task.logs.push({ at: nowAt(), note: note || "补充调整记录" });
        item.logs.push({ at: nowAt(), step: "调整", note: task.position + " 调整记录" + (note ? "：" + note : "") });
      }
      await saveDb(db);
      return send(res, 200, summarize(item));
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + port));
