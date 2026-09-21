import { readConfiguration } from '../apps/server/src/config.js';
const path = process.argv[2] ?? 'configs/core.defaults.json';
const config = await readConfiguration(path, 'schemas/config.schema.json');
console.log(`配置有效：${path}，${config.commanders.length} 位指挥官。`);
