# JEV 通用战术指挥框架

[English](README.md) | **简体中文**

由 JEV 制定整场战斗的计划，并根据新情况动态调整。框架可接入不同游戏与战斗系统；JEV 可控制指挥层级、选择指挥风格与能力，并根据任务目标、总计划和战场态势自行安排战术。

## 启动

需要 Node.js 22.12 或更高版本。

```bash
npm ci
npm run build
npm start
```

浏览器打开 `http://127.0.0.1:4317`。在调试面板新建战斗后，可以自动运行，也可以暂停、单步、修改目标和风格。两种内置场景为方格战场和区域连接图。

无界面演示：

```bash
npm run demo
```

宿主调用 `POST /api/sessions` 创建示例会话时默认立即自动运行。面板为了便于观察初始布置，主动使用 `auto:false` 创建演示会话；这是调试行为。

## 已实现

- 由 JEV 控制的指挥层级、五类战术目录与具体战法选择。
- 五档能力、十四维风格、33 个战术模板、10 种可组合辅助战法与开放参数。
- 可注册的 HTN 方法、操作与执行器：任务依赖、前置条件、预测、回溯、集结、掩护和局部修复。
- JEV 通过战前总计划、任务目标、当前形势等信息自动调整策略。
- 通用[上下文选择接口](docs/context-selection.md)：使用现有 JEV 连接，一次批量选择宿主定义的配置。
- 可选正文提取模型：可选择将上下文一并发送给 JEV。
- 本机 HTTP 服务、中文 SVG 调试面板、配置 Schema、测试与 CI。

## 接入 JEV

复制 `.env.example` 为 `.env`：

```dotenv
TYPESAFE_API_KEY=你的密钥
JEV_MODEL=jev-latest
```

重启服务即可。默认单次请求 10 秒，决策预算 30 秒，每次调度最多 2 次模型请求，可配置到硬上限 10 次（正文提取共用预算）。双方分别在首次激活时建立计划。默认普通动作在本地执行，JEV 用于战法选择；战术树不会逐层调用模型。SDK 内部重试关闭，预算与降级由运行器统一管理。没有密钥时不会向 JEV 发出请求。

正文模型单独配置 `TEXT_API_URL`（完整的兼容 chat-completions 地址）、`TEXT_API_KEY`、`TEXT_MODEL`。宿主通过 `NarrativeSource` 提供消息；演示服务也提供 `/narrative` 接口。该模型只提取任务，不执行动作。正文与战场可见信息会发送到配置的模型服务，请按实际使用选择提供方。

参考：[Jev JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)、[问题的批量与分阶段组合](https://docs.typesafe.ai/primitives)

## 修改配置

编辑 `configs/core.defaults.json`，或用 `JEV_CONFIG_FILE` 指向另一份配置。支持能力配置、风格、目标、运行预算及流程阶段。无须修改核心调度器。

```bash
npm run validate -- configs/core.defaults.json
```

新增算法、地图、战法和评价步骤的方式见 [扩展教程](docs/extensions.md)。复杂算法注册 TypeScript 函数；配置文件不执行代码。

## 保存与恢复

默认保存在项目 `.data/` 内，目录可用 `JEV_DATA_DIR` 更改。重启服务后，同一会话 ID 自动加载计划和示例战场快照。面板记住最近的会话 ID。

示例适配器恢复整个演示战场；真实宿主适配器应读取真实战场，并以宿主事实为准。恢复历史计划只生成新修订，不回滚已经发生的行动。详见 [运行与恢复契约](docs/runtime.md)。

## 开发与验证

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

详细资料：

- [架构和目录](docs/architecture.md)
- [0.2.1 核心边界审查](docs/core-boundaries.md)
- [动态目标、搜索与有限行动记忆](docs/adaptive-planning.md)
- [运行、保存与服务接口](docs/runtime.md)
- [能力、风格和战法](docs/behavior.md)
- [模块化任务规划与缺失机制适配](docs/modular-tactics.md)
- [扩展教程](docs/extensions.md)
- [酒馆接入契约](docs/tavern-contract.md)
- [验收对应与限制](docs/acceptance.md)
- [版本记录](CHANGELOG.md)

非商业使用、修改与分发免费；商业使用须事先获得作者书面授权并付费，见 [商业授权](COMMERCIAL-LICENSE.md)。第三方依赖保留各自许可证。
