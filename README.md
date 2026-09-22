# JEV General Tactical Command Framework

**English** | [简体中文](README.zh-CN.md)

A JEV-driven tactical command framework for planning an entire battle and adapting the plan as conditions change. It is designed to integrate with different games and battle systems, while allowing JEV to control command hierarchy, commander style and capability, and tactical choices based on mission objectives, the overall plan, and the current battlefield situation.

## Getting Started

Requires Node.js 22.12 or later.

```bash
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:4317` in your browser. After creating a battle in the debug panel, you can run it automatically, pause it, step through decisions, or change objectives and commander style. Two built-in demo environments are included: a grid battlefield and a region-connection graph.

Headless demo:

```bash
npm run demo
```

When a host creates a sample session with `POST /api/sessions`, the session starts automatically by default. The debug panel deliberately creates demo sessions with `auto:false` so the initial deployment can be inspected before execution.

## Implemented Features

- JEV-controlled command hierarchy, five tactical categories, and concrete tactic selection.
- Five capability levels, a 14-dimension commander style model, 33 tactic templates, 10 composable supporting tactics, and open parameters.
- Extensible HTN methods, operators, and executors with task dependencies, preconditions, prediction, backtracking, regrouping, covering actions, and local repair.
- Dynamic strategy adjustment based on the pre-battle plan, mission objectives, and current battlefield situation.
- Optional narrative-extraction model, with configurable context forwarding to JEV.
- Local HTTP service, SVG debug panel, configuration schema, tests, and CI.

## Connecting JEV

Copy `.env.example` to `.env`:

```dotenv
TYPESAFE_API_KEY=your_api_key
JEV_MODEL=jev-latest
```

Restart the service after configuring the environment. The default timeout is 10 seconds per request with a 30-second decision budget. Each scheduling cycle allows up to 2 model calls by default and can be configured up to a hard limit of 10; narrative extraction shares the same budget.

Each side creates its plan when it is first activated. Ordinary actions run locally by default, while JEV is used for tactic selection. The tactical tree does not call the model once per level. SDK-level retries are disabled; budgeting and fallback behavior are handled centrally by the runtime. No JEV request is sent when no API key is configured.

The narrative model is configured separately through `TEXT_API_URL` (a complete chat-completions-compatible endpoint), `TEXT_API_KEY`, and `TEXT_MODEL`. Hosts provide messages through `NarrativeSource`; the demo service also exposes a `/narrative` endpoint. This model extracts tasks only and does not execute actions. Narrative text and battlefield-visible information are sent to the configured model provider, so choose the provider according to your deployment requirements.

References: [Jev JavaScript SDK](https://docs.typesafe.ai/sdk/javascript) and [Batching and staged composition of questions](https://docs.typesafe.ai/primitives).

## Configuration

Edit `configs/core.defaults.json`, or set `JEV_CONFIG_FILE` to another configuration file. Capability, commander style, objectives, runtime budgets, and processing stages are configurable without modifying the core scheduler.

```bash
npm run validate -- configs/core.defaults.json
```

See the [extension guide](docs/extensions.md) for adding algorithms, maps, tactics, and evaluation stages. Complex algorithms are registered as TypeScript functions; configuration files do not execute code.

## Persistence and Recovery

Runtime data is stored in the project's `.data/` directory by default. Set `JEV_DATA_DIR` to use another location. After a restart, the same session ID automatically reloads its plan and the sample battlefield snapshot. The debug panel remembers the most recent session ID.

The sample adapter restores the complete demo battlefield. Real host adapters should read the real battlefield state and treat host state as authoritative. Restoring a historical plan creates a new revision and does not roll back actions that have already occurred. See the [runtime and recovery contract](docs/runtime.md).

## Development and Validation

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Documentation:

- [Architecture and repository layout](docs/architecture.md)
- [0.2.1 core boundary review](docs/core-boundaries.md)
- [Adaptive targeting, search and bounded action history](docs/adaptive-planning.md)
- [Runtime, persistence, and service API](docs/runtime.md)
- [Capabilities, commander styles, and tactics](docs/behavior.md)
- [Modular task planning and missing-mechanic adaptation](docs/modular-tactics.md)
- [Extension guide](docs/extensions.md)
- [Tavern integration contract](docs/tavern-contract.md)
- [Acceptance mapping and limitations](docs/acceptance.md)
- [Changelog](CHANGELOG.md)

Non-commercial use, modification, and distribution are free. Commercial use requires prior written authorization from the author and a paid license; see [Commercial License](COMMERCIAL-LICENSE.md). Third-party dependencies remain under their respective licenses.
