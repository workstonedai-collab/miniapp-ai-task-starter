# Miniapp AI Task Starter

![Fictional local recovery demo at phone width](docs/demo.png)

[简体中文](README.zh-CN.md) · Apache-2.0 · Node.js 22.12+

A small, runnable example for tasks that outlive a page: create once, poll small
progress responses, checkpoint generated output, recover from a later save failure,
and reopen the saved result. The default generator is an explicitly fictional local
fixture. No model, account, API key or cloud service is called.

```sh
npm test
npm run demo
npm start
```

Open `http://127.0.0.1:4198`. Create a task: generation succeeds and the first save
deliberately fails. Click Continue to save the checkpointed output, then refresh
the page. The same topic keeps the persisted request key so a lost response does
not create duplicate work. Change the topic to create another task. No dependencies
need installation; the sequential runner is vendored with attribution.

## Native miniapp

Import `miniprogram/` into WeChat Developer Tools with your own separate test AppID
(the included AppID is blank). Run the backend on this computer. `127.0.0.1` is a
local development address: it is not a hosted endpoint and cannot be used by a
physical phone to reach this computer. Follow the platform's normal development
configuration and permissions; no other project's identity is borrowed. For a
device deployment, provide authenticated HTTPS APIs and real authorization first.

The page saves the request intent before sending, restores its last task on show,
stops polling on hide/unload, caps transient polling retries, and fetches full output
only after completion. Offline lifecycle tests use a simulated SDK; they do not
prove Developer Tools or real-device acceptance. No upload/deployment is included.

## Contract and boundaries

- POST `/tasks`: `{key, topic, failSaveOnce}` with `X-Task-Demo: 1`; same key/input
  replays its identity, changed input conflicts. Repeated creation never resets a
  retry budget. POST `/tasks/<id>/retry` explicitly continues a failed/interrupted task.
- GET `/tasks/<id>` returns status/steps/progress without generated bodies.
  GET `/tasks/<id>/result` requires completed state and reads the saved version.
- Generation and saving are separate persisted stages. The included failure occurs
  **after** generation was checkpointed. A crash during the generator itself may
  repeat it; external model/payment/write operations still need provider-side
  idempotency. Atomic rename is not a power-loss durability guarantee.
- `.state/` contains supplied topics and output, is ignored and private to the
  local demo. Only fictional data belongs in examples. Never publish it or put
  credentials in input/results. The local server is not an authenticated production
  backend and must remain bound to loopback.
- `TaskService(directory, {generate})` is the injection point for your own async
  generator. No provider integration, production database, public deployment,
  distributed workers, automatic stale-lock stealing or unattended retries are supplied.
  Inspect a stale lock and confirm its owner has stopped before manual recovery.

`vendor/recovery.js` comes from [Agent Task Recovery Kit](https://github.com/workstonedai-collab/agent-task-recovery-kit)
under Apache-2.0; original copyright and license remain. This repository uses a new
history and fictional fixtures; it contains no private product schema or prompts.

Validation: Node service/HTTP recovery tests and simulated miniapp lifecycle tests;
the browser example is a convenience client. Live model and real-device results
must be validated separately before making deployment claims.
