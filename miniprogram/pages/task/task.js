const BASE = 'http://127.0.0.1:4198';
Page({
  data: { topic: '社区花园', jobId: '', status: '', result: '', busy: false },
  inputTopic(event) { this.setData({ topic: event.detail.value }); },
  onShow() { this.visible = true; this.failures = 0; this.setData({ jobId: wx.getStorageSync('task-example.id') || '' }); this.refresh(); },
  onHide() { this.visible = false; clearTimeout(this.timer); },
  onUnload() { this.onHide(); },
  request(path, data) {
    return new Promise((resolve, reject) => wx.request({ url: BASE + path, method: data ? 'POST' : 'GET',
      header: { 'content-type': 'application/json', 'X-Task-Demo': '1' }, data,
      timeout: 10000, success: response => response.statusCode >= 200 && response.statusCode < 300 ? resolve(response.data) : reject(Error(response.data.error || 'REQUEST_FAILED')),
      fail: () => reject(Error('CONNECTION_FAILED')) }));
  },
  async create() {
    if (this.data.busy) return; this.setData({ busy: true });
    try {
      const old = wx.getStorageSync('task-example.intent');
      const intent = old && old.topic === this.data.topic ? old : { key: 'demo_' + Date.now() + '_' + Math.random().toString(36).slice(2), topic: this.data.topic, failSaveOnce: true };
      wx.setStorageSync('task-example.intent', intent);
      const result = await this.request('/tasks', intent);
      wx.setStorageSync('task-example.id', result.id); this.setData({ jobId: result.id, result: '' });
      this.failures = 0; await this.refresh();
    } catch (error) { this.setData({ status: error.message }); }
    finally { this.setData({ busy: false }); }
  },
  async refresh() {
    clearTimeout(this.timer); if (!this.visible || !this.data.jobId) return;
    const id = this.data.jobId;
    try {
      const progress = await this.request('/tasks/' + id);
      if (!this.visible || id !== this.data.jobId) return;
      this.failures = 0; this.setData({ status: progress.status + ' · ' + progress.progress + '%' });
      if (progress.status === 'completed') {
        const result = await this.request('/tasks/' + id + '/result');
        if (this.visible && id === this.data.jobId) this.setData({ result: JSON.stringify(result) });
      } else if (progress.status !== 'failed') this.timer = setTimeout(() => this.refresh(), 1000);
    } catch (error) {
      if (!this.visible || id !== this.data.jobId) return;
      this.failures = (this.failures || 0) + 1; this.setData({ status: error.message });
      if (this.failures < 3) this.timer = setTimeout(() => this.refresh(), 1000 * this.failures);
    }
  },
  async retry() {
    if (this.data.busy || !this.data.jobId) return; this.setData({ busy: true });
    try { await this.request('/tasks/' + this.data.jobId + '/retry', {}); this.failures = 0; await this.refresh(); }
    catch (error) { this.setData({ status: error.message }); }
    finally { this.setData({ busy: false }); }
  },
});
