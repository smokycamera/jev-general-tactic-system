# Third-party notices

JEV project code is licensed under the Tavern Battle Noncommercial License 1.0. This does not relicense third-party packages or model services.

- `@typesafe-ai/sdk` (MIT) implements the external TypeSafe/JEV API transport. It is only used by `packages/providers`; the command core does not import it.
- Ajv (MIT) validates service configuration and test schemas.
- TypeScript (Apache-2.0), Vite (MIT), Vitest (MIT), Playwright (Apache-2.0), tsx (MIT), and Prettier (MIT) are development/build tools. Their distributed packages retain their own licenses and notices.
- `packages/core` has no third-party runtime dependencies. Its source and bundled copies carry the project license.

The dependency versions and transitive packages are recorded in `package-lock.json`. API credentials, private chat data and local checkpoints are not part of the source distribution.
