// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 workstonedai-collab
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";

export class TaskError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  throw new TaskError(
    "INVALID_DATA",
    "Inputs and results must be JSON values (finite numbers, no undefined)",
  );
}
export const contentHash = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const aborted = (signal) => {
  if (signal?.aborted)
    throw new TaskError("ABORTED", "Task cancelled at a cooperative boundary");
};
async function save(file, state) {
  canonical(state);
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, JSON.stringify(state, null, 2) + "\n", {
      mode: 0o600,
    });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
const delay = (ms, signal) =>
  new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const timer = setTimeout(done, ms),
      cancel = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        reject(new TaskError("ABORTED", "Cancelled while waiting to retry"));
      };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
const validId = (id) =>
  typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id);
/** Local, sequential task runner. Side effects must use the provided idempotency key. */
export async function runTask({
  id,
  input,
  steps,
  workflowVersion = "1",
  stateDir = ".demo-state",
  signal,
  maxAttempts = 3,
  baseDelayMs = 100,
  maxDelayMs = 5000,
  retryFailed = false,
  onEvent = () => {},
  shouldRetry = () => true,
} = {}) {
  if (
    !validId(id) ||
    !Array.isArray(steps) ||
    !steps.length ||
    steps.some((s) => !validId(s.id) || typeof s.run !== "function") ||
    new Set(steps.map((s) => s.id)).size !== steps.length ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 100 ||
    typeof workflowVersion !== "string" ||
    !workflowVersion ||
    !Number.isFinite(baseDelayMs) ||
    baseDelayMs < 0 ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < baseDelayMs
  )
    throw new TaskError(
      "INVALID_CONFIG",
      "Invalid task ID, unique steps, version or retry limits",
    );
  const fingerprint = contentHash({
    input,
    workflowVersion,
    steps: steps.map((s) => s.id),
  });
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const root = await fs.realpath(stateDir),
    file = path.join(root, id + ".json"),
    lock = path.join(root, id + ".lock");
  try {
    await fs.mkdir(lock);
  } catch (e) {
    if (e.code === "EEXIST")
      throw new TaskError(
        "LOCKED",
        "Another run or a stale lock exists; stop the worker and inspect the lock owner before manual recovery",
      );
    throw e;
  }
  let state,
    validated = false;
  try {
    await fs.writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        created_at: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    try {
      state = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT")
        throw new TaskError(
          "INVALID_CHECKPOINT",
          "Cannot parse checkpoint; preserve the file and inspect it",
        );
    }
    if (state) {
      if (
        state.schema_version !== 1 ||
        state.fingerprint !== fingerprint ||
        !state.steps ||
        Object.keys(state.steps).length !== steps.length
      )
        throw new TaskError(
          "CHECKPOINT_MISMATCH",
          "Input, step IDs or workflow version changed; use a new task ID",
        );
      for (const step of steps) {
        const record = state.steps[step.id];
        if (
          !record ||
          !["pending", "running", "completed", "failed"].includes(
            record.status,
          ) ||
          !Number.isInteger(record.attempts) ||
          record.attempts < 0
        )
          throw new TaskError("INVALID_CHECKPOINT", "Invalid step state");
        if (
          record.status === "completed" &&
          record.result_hash !== contentHash(record.result)
        )
          throw new TaskError(
            "INVALID_CHECKPOINT",
            "Saved step result was modified",
          );
      }
    } else
      state = {
        schema_version: 1,
        id,
        fingerprint,
        workflowVersion,
        status: "pending",
        created_at: new Date().toISOString(),
        steps: Object.fromEntries(
          steps.map((s) => [s.id, { status: "pending", attempts: 0 }]),
        ),
      };
    validated = true;
    const persist = async () => {
      state.updated_at = new Date().toISOString();
      await save(file, state);
    };
    const emit = async (event, step) => {
      try {
        await onEvent({
          task_id: id,
          event,
          step_id: step,
          status: state.status,
        });
      } catch {
        /* Observability must not repeat a successful step. */
      }
    };
    const results = {};
    state.status = "running";
    await persist();
    for (const step of steps) {
      const record = state.steps[step.id];
      if (record.status === "completed") {
        results[step.id] = record.result;
        await emit("cached", step.id);
        continue;
      }
      if (retryFailed && record.status === "failed") {
        record.attempts = 0;
        record.status = "pending";
        delete record.last_error;
        await persist();
      }
      const key = contentHash({ fingerprint, step: step.id });
      let complete = false;
      while (record.attempts < maxAttempts) {
        aborted(signal);
        record.status = "running";
        record.attempts++;
        state.status = "running";
        await persist();
        await emit("started", step.id);
        let result;
        try {
          result = await step.run({
            input: structuredClone(input),
            results: structuredClone(results),
            idempotencyKey: key,
            attempt: record.attempts,
            signal,
          });
          contentHash(result);
        } catch (error) {
          record.status = "failed";
          record.last_error = {
            code: typeof error.code === "string" ? error.code : "STEP_FAILED",
          };
          await persist();
          await emit("failed", step.id);
          if (signal?.aborted) throw new TaskError("ABORTED", "Task cancelled");
          if (error instanceof TaskError && error.code === "INVALID_DATA")
            break;
          if (
            !(await shouldRetry(error, {
              step_id: step.id,
              attempt: record.attempts,
            })) ||
            record.attempts >= maxAttempts
          )
            break;
          await delay(
            Math.min(maxDelayMs, baseDelayMs * 2 ** (record.attempts - 1)),
            signal,
          );
          continue;
        }
        // Persist success outside the retry catch: a storage failure must not rerun a side effect.
        record.result_hash = contentHash(result);
        record.result = result;
        record.status = "completed";
        delete record.last_error;
        results[step.id] = result;
        await persist();
        complete = true;
        await emit("completed", step.id);
        break;
      }
      if (!complete) {
        state.status = "failed";
        await persist();
        throw new TaskError(
          "STEP_EXHAUSTED",
          "Step " + step.id + " did not complete within its retry budget",
        );
      }
    }
    state.status = "completed";
    await persist();
    await emit("finished");
    return { id, status: "completed", results, checkpoint: file };
  } catch (error) {
    if (state && validated) {
      state.status = error.code === "ABORTED" ? "cancelled" : "failed";
      state.updated_at = new Date().toISOString();
      await save(file, state);
    }
    throw error;
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}
export async function inspectTask(stateDir, id) {
  if (!validId(id)) throw new TaskError("INVALID_CONFIG", "Invalid ID");
  return JSON.parse(
    await fs.readFile(path.join(stateDir, id + ".json"), "utf8"),
  );
}
