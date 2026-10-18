import { TaskService } from './src/service.js';
const service = new TaskService('.state/offline-example');
const { id } = await service.create({ key: 'fictional-example', topic: 'A community garden', failSaveOnce: true });
await service.settle(id); console.log('First run:', await service.progress(id));
await service.retry(id); await service.settle(id);
console.log('After retry:', await new TaskService('.state/offline-example').result(id));
