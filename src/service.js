// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 workstonedai-collab
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runTask, inspectTask, contentHash, TaskError } from '../vendor/recovery.js';

const validId = id => /^job_[a-f0-9]{32}$/.test(id);
export class TaskService {
  constructor(directory, { generate = async ({ topic }) => ({ title: 'Fictional result / 虚构结果', text: `Example notes about ${topic}. This is a local fixture, not a model response.` }) } = {}) {
    this.directory = path.resolve(directory); this.generate = generate; this.running = new Map();
  }
  async create({ key, topic, failSaveOnce = true }) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key) || typeof topic !== 'string' || !topic.trim() || topic.length > 2000 || typeof failSaveOnce !== 'boolean') throw new TaskError('INVALID_INPUT', 'Invalid task input');
    const id = 'job_' + createHash('sha256').update(key).digest('hex').slice(0, 32);
    const input = { topic, failSaveOnce }, metadata = { id, input, version: 1 };
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, id + '.request.json');
    try { await fs.writeFile(file, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = JSON.parse(await fs.readFile(file, 'utf8'));
      if (contentHash(previous) !== contentHash(metadata)) throw new TaskError('CONFLICT', 'The request key already belongs to different input');
      // A repeated create is an inspection, never a fresh attempt budget.
      return { id, replayed: true };
    }
    this.enqueue(metadata, false); return { id, replayed: false };
  }
  async metadata(id) {
    if (!validId(id)) throw new TaskError('INVALID_INPUT', 'Invalid task ID');
    return JSON.parse(await fs.readFile(path.join(this.directory, id + '.request.json'), 'utf8'));
  }
  enqueue(metadata, retryFailed) {
    if (this.running.has(metadata.id)) return this.running.get(metadata.id);
    const task = runTask({ id: metadata.id, input: metadata.input, workflowVersion: 'fixture-v1',
      stateDir: path.join(this.directory, 'checkpoints'), maxAttempts: 1, retryFailed,
      steps: [
        { id: 'generate', run: async ({ input }) => this.generate(input) },
        { id: 'save', run: async ({ input, results }) => {
          if (input.failSaveOnce) {
            try {
              await fs.writeFile(path.join(this.directory, metadata.id + '.failure-seen'), '', { flag: 'wx', mode: 0o600 });
              throw new TaskError('DEMO_SAVE_FAILURE', 'Fictional save failure');
            } catch (error) { if (error.code !== 'EEXIST') throw error; }
          }
          const file = path.join(this.directory, metadata.id + '.result.json');
          const payload = { id: metadata.id, version: 1, result: results.generate };
          try {
            const saved = JSON.parse(await fs.readFile(file, 'utf8'));
            if (contentHash(saved) !== contentHash(payload)) throw new TaskError('CONFLICT', 'Saved result differs');
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const temporary = file + '.' + randomUUID() + '.tmp';
            try { await fs.writeFile(temporary, JSON.stringify(payload), { mode: 0o600 }); await fs.rename(temporary, file); }
            finally { await fs.rm(temporary, { force: true }); }
          }
          return { saved: true, version: 1 };
        } },
      ],
    }).catch(() => {}).finally(() => this.running.delete(metadata.id));
    this.running.set(metadata.id, task); return task;
  }
  async retry(id) { const metadata = await this.metadata(id); this.enqueue(metadata, true); return { id }; }
  async settle(id) { await this.running.get(id); }
  async progress(id) {
    await this.metadata(id);
    let state;
    try { state = await inspectTask(path.join(this.directory, 'checkpoints'), id); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const steps = Object.entries(state?.steps || {}).map(([id, row]) => ({ id, status: row.status, attempts: row.attempts, error: row.last_error?.code || null }));
    return { id, status: state?.status || 'queued', progress: Math.round(100 * steps.filter(s => s.status === 'completed').length / 2), steps };
  }
  async result(id) {
    const progress = await this.progress(id);
    if (progress.status !== 'completed') throw new TaskError('NOT_READY', 'Task is not completed');
    return JSON.parse(await fs.readFile(path.join(this.directory, id + '.result.json'), 'utf8'));
  }
}
