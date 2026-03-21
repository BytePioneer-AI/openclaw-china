# Repository Guidelines

## Project Purpose
Moltbot China is an open-source extension set that adds China-region messaging channels to Moltbot (Feishu, DingTalk, WeCom, QQ). The goal is to provide simple, reliable chat connectivity and a clean plugin surface for Moltbot users in China, with voice features implemented via Node.


## Project Structure

```
openclaw-china/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
│
├── packages/
│   ├── channels/                    # @xuanyue202/channels 统一包
│   │   ├── package.json
│   │   ├── moltbot.plugin.json
│   │   ├── clawdbot.plugin.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts
│   │
│   └── shared/                      # 共享工具库
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── logger/              # 日志工具
│           │   ├── index.ts
│           │   └── logger.ts
│           ├── policy/              # 策略引擎
│           │   ├── index.ts
│           │   ├── dm-policy.ts
│           │   └── group-policy.ts
│           ├── http/                # HTTP 工具
│           │   ├── index.ts
│           │   ├── client.ts
│           │   └── retry.ts
│           ├── file/                # 文件工具
│           │   ├── index.ts
│           │   └── file-utils.ts
│           └── types/
│               └── common.ts
│
├── extensions/
│   ├── dingtalk/                    # @xuanyue202/dingtalk
│   ├── feishu/                      # @xuanyue202/feishu-china
│   ├── wecom/                       # @xuanyue202/wecom
│   ├── wecom-app/                   # @xuanyue202/wecom-app
│   └── qqbot/                       # @xuanyue202/qqbot
│
└── doc/
    ├── architecture.md              # 架构设计文档
    ├── moltbot/                     # Moltbot 插件规范
    └── reference-projects/          # 参考实现
```

## Core Conventions
- Each plugin must include `openclaw.plugin.json` with a JSON Schema (even if empty).
- Plugins register channels via `api.registerChannel({ plugin })`.
- Channel configuration lives under `channels.<id>`; multi-account uses `channels.<id>.accounts.<accountId>`.
- Keep channels focused on message receive/send. Defer extra features unless required.
- Voice features use Node-based tooling (no Python voice stack).

## Suggested Layout (for new plugins)
- `extensions/<channel-id>/openclaw.plugin.json`
- `extensions/<channel-id>/package.json`
- `extensions/<channel-id>/index.ts`
- `extensions/<channel-id>/src/*`

## Development
- All code must be written in TypeScript.
- Use `strict: true` in tsconfig.
- Prefer `async/await` over callbacks.
- Avoid `any`; use `unknown` with type guards when needed.
- Handle errors at async boundaries; never swallow silently.
- Set timeouts on network requests.

## Release & Versioning
- Use `pnpm release:all` for full release, or `pnpm release:channel --channel <id>` for single channel release.
- Default publish tag is `latest`.
- Only publish to `next` when explicitly passing `--tag next`.
- `--version` accepts:
  - `x.y.z` (stable semver, publishes as-is)
  - `x.y.z.w` (legacy 4-segment input, normalized to npm semver `x.y.z-w`)
  - `x.y.z-w` (npm prerelease style)
- Auto bump rules (when `--version` is omitted):
  - Baseline is the higher one between local `package.json` version and npm published versions.
  - If baseline is `x.y.z`, next is `x.y.(z+1)`.
  - If baseline is `x.y.z.w` / `x.y.z-w`, next is `x.y.z.(w+1)` (published as `x.y.z-(w+1)`).
- Version comparison in release script uses numeric `major.minor.patch.revision` ordering (missing revision = `0`).
- Recommended commands:
  - Stable release (latest): `pnpm release:all --version 2026.3.5`
  - Pre-release to next: `pnpm release:all --version 2026.3.5.1 --tag next`

## Safety
- Treat all inbound messages as untrusted input.
- Do not commit real tokens, secrets, or IDs; use obvious placeholders.

## OpenClaw Reply Skips
- When aligning channel behavior with OpenClaw, remember the reply dispatcher can skip payloads with `onSkip` reasons: `empty`, `silent`, or `heartbeat`. Use these to avoid sending non-user-visible messages.
