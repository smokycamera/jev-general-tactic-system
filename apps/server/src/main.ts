import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JevProvider, ChatTextExtractor } from '@jev/providers';
import { readConfiguration } from './config.js';
import { createService } from './app.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const provider = process.env.TYPESAFE_API_KEY?.trim()
  ? new JevProvider({
      apiKey: process.env.TYPESAFE_API_KEY,
      defaultModel: process.env.JEV_MODEL ?? 'jev-latest',
    })
  : undefined;
const extractor =
  process.env.TEXT_API_URL && process.env.TEXT_API_KEY && process.env.TEXT_MODEL
    ? new ChatTextExtractor({
        url: process.env.TEXT_API_URL,
        apiKey: process.env.TEXT_API_KEY,
        model: process.env.TEXT_MODEL,
      })
    : undefined;
const configuration = await readConfiguration(
  resolve(root, process.env.JEV_CONFIG_FILE ?? 'configs/core.defaults.json'),
  resolve(root, 'schemas/config.schema.json'),
);
const service = createService({
  configuration,
  dataDirectory: resolve(root, process.env.JEV_DATA_DIR ?? '.data'),
  uiDirectory: resolve(root, 'apps/debug/dist'),
  ...(provider ? { provider } : {}),
  ...(extractor ? { extractor } : {}),
  ...(process.env.JEV_SERVICE_TOKEN ? { token: process.env.JEV_SERVICE_TOKEN } : {}),
  allowedOrigins: (process.env.JEV_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
});
const port = Number(process.env.PORT ?? 4317);
service.server.listen(port, '127.0.0.1', () =>
  console.log(
    `JEV 指挥室 http://127.0.0.1:${port} · ${provider ? 'Jev' : '本地规则'} · silent-auto`,
  ),
);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void service.close().finally(() => process.exit(0));
  });
