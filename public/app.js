const $ = id => document.getElementById(id);
let current = localStorage.getItem('task-demo.current'), timer;
async function api(url, body) {
  const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Task-Demo': '1' }, body: JSON.stringify(body) } : {});
  const value = await response.json(); if (!response.ok) throw Error(value.error); return value;
}
async function refresh() {
  clearTimeout(timer); if (!current || document.hidden) return;
  try {
    const progress = await api('/tasks/' + current);
    $('status').textContent = progress.status + ' · ' + progress.progress + '%';
    $('retry').disabled = !['failed', 'queued', 'running'].includes(progress.status);
    if (progress.status === 'completed') $('result').textContent = JSON.stringify(await api('/tasks/' + current + '/result'), null, 2);
    else if (progress.status !== 'failed') timer = setTimeout(refresh, 1000);
  } catch (error) { $('status').textContent = error.message + ' · 点击创建或继续以主动重试'; }
}
$('create').onclick = async () => {
  $('create').disabled = true;
  try {
    // Persist intent before sending: a lost HTTP response can reuse its request key.
    const topic = $('topic').value, old = JSON.parse(localStorage.getItem('task-demo.intent') || 'null');
    const intent = old?.topic === topic ? old : { key: crypto.randomUUID(), topic, failSaveOnce: true };
    localStorage.setItem('task-demo.intent', JSON.stringify(intent));
    const result = await api('/tasks', intent); current = result.id;
    localStorage.setItem('task-demo.current', current); $('result').textContent = ''; await refresh();
  } catch (error) { $('status').textContent = error.message; }
  finally { $('create').disabled = false; }
};
$('retry').onclick = async () => { try { await api('/tasks/' + current + '/retry', {}); await refresh(); } catch (error) { $('status').textContent = error.message; } };
document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) refresh(); });
refresh();
