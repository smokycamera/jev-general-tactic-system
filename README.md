# JEV 通用指挥决策框架

让指挥官记住整场战斗的计划，根据新情况调整，并把决定交给宿主执行。

**默认 `silent-auto`：不弹出审批、不要求每回合确认。** 没有模型密钥时，使用本地规则完整运行。调试面板只供主动查看和干预。

仓库：`smokycamera/jev-general-tactic-system`。当前版本 `0.2.1`。通用核心独立于宿主；`smokycamera/tavern-battle` 已增加可选 JEV 适配，见 [酒馆接入说明](docs/tavern-contract.md)。

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

- 独立的 TypeScript 核心，可在 Node 与浏览器使用。核心不包含密钥，也不自行修改宿主的战斗规则。
- 指挥官上下级关系、单位唯一归属，五类战术目录与具体战法选择。
- 五档能力、十四维风格、32 个战术模板、10 种可组合辅助战法与开放参数。
- 可注册的 HTN 方法、操作与执行器：任务依赖、前置条件、预测、回溯、集结、掩护和局部修复。
- 宿主能力声明与动作映射；缺少烟幕、压制、迷雾、弹药等机制时保留可行方案。即时与异步宿主动作均可接入。
- 总计划、执行进度、修订记录分别保存；局部修复保留其他分队任务，已经执行的结果保留。
- 动作提交前保存意图，绑定会话／状态／计划版本，宿主按唯一键去重。暂停、手动命令、改案使旧决策失效。
- Jev 官方 SDK，批量收益／风险判断，超时、错误、无效结果的本地降级，连续失败冷却与恢复探测。
- 可选正文提取模型：默认最近六条完成消息，信息校验通过后自动补齐任务，不能修改宿主位置、伤亡与资源。
- 模型决策录制与严格回放，固定种子的示例战斗，带校验和、版本校验与原子替换的检查点。
- 本机 HTTP 服务、中文 SVG 调试面板、配置 Schema、测试与 CI。

**本地 AI 是可运行的规则基线。** 高档能力增加评价因素、候选数量、分解预算、协作与预案，不增加单位数值或可见信息。当前敌方反应使用可见火力、包围与资源风险的规则近似，没有实现完整敌军搜索树。战术目录使用可扩展规则模板，不能据此认定真实酒馆战斗已经平衡。

## 接入 Jev

复制 `.env.example` 为 `.env`，只在本机填写：

```dotenv
TYPESAFE_API_KEY=你的密钥
JEV_MODEL=jev-latest
```

重启服务即可。默认单次请求 10 秒，决策预算 30 秒，每次调度最多 2 次模型请求，可配置到硬上限 10 次（正文提取共用预算）。双方分别在首次激活时建立计划。默认普通动作在本地执行，Jev 用于战法选择；战术树不会逐层调用模型。SDK 内部重试关闭，预算与降级由运行器统一管理。没有密钥时不会向 Jev 发出请求。

正文模型单独配置 `TEXT_API_URL`（完整的兼容 chat-completions 地址）、`TEXT_API_KEY`、`TEXT_MODEL`。宿主通过 `NarrativeSource` 提供消息；演示服务也提供 `/narrative` 接口。该模型只提取任务，不执行动作。正文与战场可见信息会发送到配置的模型服务，请按实际使用选择提供方。

参考：[Jev JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)、[问题的批量与分阶段组合](https://docs.typesafe.ai/primitives)。SDK 协议回归使用模拟响应。2026-09-22 的独立在线冒烟返回 `jev-1.13.0`，两个游戏候选请求约 1.8 秒；这只证明联通，不代表普遍延迟或战术质量。可用 `node --env-file=.env --import tsx scripts/live-smoke.ts` 显式复测，CI 不消费真实密钥。

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

CI 在 Linux / Node 22 上执行类型检查、单元与集成测试、构建和 Chromium 桌面／手机宽度流程测试。全部通过后，发布工作流才会为该版本创建私有仓库内的标签和 Release。

详细资料：

- [架构和目录](docs/architecture.md)
- [0.2.1 核心边界审查](docs/core-boundaries.md)
- [运行、保存与服务接口](docs/runtime.md)
- [能力、风格和战法](docs/behavior.md)
- [模块化任务规划与缺失机制适配](docs/modular-tactics.md)
- [扩展教程](docs/extensions.md)
- [酒馆接入契约](docs/tavern-contract.md)
- [验收对应与限制](docs/acceptance.md)
- [版本记录](CHANGELOG.md)

本项目沿用酒馆插件的 [战阵非商业使用许可证 1.0](LICENSE)。非商业使用、修改与分发免费，商业使用须事先获得作者书面授权并付费，见 [商业授权](COMMERCIAL-LICENSE.md)。第三方依赖保留各自许可证；这不是 OSI 意义的开源许可证。
