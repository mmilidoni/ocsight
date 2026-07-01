# ocsight

OpenCode cost/usage observability CLI + docs website. Bun monorepo, turbo-orchestrated.

## Layout

- `packages/cli/` — the product. TypeScript CLI built with Commander. Source of truth.
  - `src/index.ts` — entry, registers commands, gates `parse()` on `NODE_ENV !== "test"`.
  - `src/commands/` — one file per subcommand (`summary`, `sessions`, `costs`, `export`, `config`, `live`, `models`, `budget`).
  - `src/lib/` — helpers + `constants.ts` + `pricing.json` (model cost data) + `runtime-compat.ts` (Bun/Node shim, must stay first import in `index.ts`).
  - `src/services/` — data/cost/format services.
  - `test/` — bun tests, mix of `.test.ts` and `.test.js`. Some import from `../dist/index.js`, so a build must run first.
- `packages/web/` — Astro + Starlight docs site. Has its own `AGENTS.md` with web-specific rules. Deploys to Cloudflare Pages (project `ocsight-website`, see `packages/web/wrangler.toml`).
- `packages/distribution/go/` — tiny Go launcher; wraps the Node CLI behind a single binary. Built by `build.sh` per OS/arch.
- `packages/distribution/homebrew/` — Homebrew formula source (`homebrew-tap-files/Formula/ocsight.rb`); written by `scripts/publish.ts` during release.
- `scripts/` — `bundle-cli.ts` (real bundler), `publish.ts` (release), `bump-version.cjs` (manual npm publish), `update-homebrew.cjs`.
- `index.js` (root) is a 5-line shim: `require("./lib/bundle.cjs")`. The real CLI is the bundled CJS in `lib/`.
- `ocsight.config.json` (root) is a **sample/template** with hard-coded personal paths — ignore its `paths` block; do not treat as defaults.

## Build & test

```bash
bun install                  # one-time
bun run build                # turbo → tsc on packages/cli → packages/cli/dist/
bun run bundle-cli           # scripts/bundle-cli.ts → packages/cli/dist/index.cjs + lib/bundle.cjs
bun run packages/cli/src/index.ts summary   # run unbundled dev CLI
bun test --concurrent --coverage            # from packages/cli; root `bun test` works too
```

Order matters: `test` (turbo task) `dependsOn: ["build"]`. Tests that import from `dist/` will fail without a build first. The bundler (`bundle-cli`) is separate from `build` — both must run for `node index.js` to work.

To smoke-test the bundled binary: `chmod +x index.js && node index.js --version`.

## Repo gotchas

- **Two bundlers in the tree, only one is real.** `scripts/bundle-cli.ts` (Bun.build → CJS with `__PACKAGE_VERSION__` injected via `define`) is the active one. `esbuild.config.cjs` is orphaned — it points at `src/index.ts` which doesn't exist. Don't try to "fix" it; it's dead.
- **Runtime polyfill is load-bearing.** `import "./lib/runtime-compat.js"` must be the first executable line in `packages/cli/src/index.ts`. It provides Bun-API fallbacks (zstd, ANSI strip, `Bun.file`, keychain) so the bundle runs under both Bun and Node 18/20. Removing or reordering it breaks Node builds.
- **Version injection.** `__PACKAGE_VERSION__` is set at bundle time from root `package.json`. Unbundled/dev runs fall back to `"0.7.4"` — don't rely on that value.
- **Test guard.** `index.ts` only calls `program.parse()` when `NODE_ENV !== "test"`. Don't remove this; the test suite imports `initializeProgram` directly and re-parses itself.
- **Bun config split.** Root `bunfig.toml` has `coverageThreshold = 0` (disabled). `packages/cli/bunfig.toml` sets it to `0.8` (enforced) — the package-level config wins inside `packages/cli/`.
- **Lockfile.** `bun.lock` is the text format; ignore the older `bun.lockb` references.
- **Two release paths.**
  - Manual dispatch via `release.yml` → `./build.sh` → `scripts/publish.ts` → npm + zips in `dist/`.
  - Tag push `v*` via `build-executables.yml` → standalone Bun-compiled binaries (`bun build --compile`) → GitHub release with 5 platform artifacts. macOS builds sign with `MACOS_CERTIFICATE`/`MACOS_CERTIFICATE_PWD` secrets if present.
  - Don't mix them. `build.sh` produces Node-wrapped zips; the tag workflow produces self-contained binaries.
- **Deploys.** `deploy-cloudflare.yml` builds `packages/web` and ships via wrangler (needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). `deploy-dev.yml` runs on `develop` and includes a `semantic-release --dry-run`.
- **Bot trigger.** `.github/workflows/opencode.yml` runs `sst/opencode/github` on issue/PR comments containing `/oc` or `/opencode` (model `opencode/grok-code`, needs `xai_api_key` secret).
- **No Docker, no `.opencode/` plugin dir in this repo.** Skip those parts of generic Bun/OpenCode advice.
- **Pricing data** lives at `packages/cli/src/lib/pricing.json`. Cost engine is `lib/cost.ts`. Don't hardcode model prices elsewhere.
- **Add deps to the right package.** Root `devDependencies` are build tooling only (turbo, esbuild, typescript, bun-types, @types/node). Runtime deps go in `packages/cli/package.json` or `packages/web/package.json`.

## Conventions (project rule)

- Tools are designed for **agents, not humans**: few high-impact commands, high-signal output, token-efficient defaults. More tools ≠ better.
- CLI style: short single-word variable names where possible, no unnecessary destructuring, no `else` unless needed, no `try`/`catch` unless a boundary requires it, no `any`, prefer `const` over `let`, one function unless composable/reusable.
- UI: clean brutalist — opencode.ai / shadcn influence, geometric simplicity, no decoration. CLI tables use `cli-table3`; colors via `chalk`; avoid gratuitous styling.
- Use Bun APIs (`Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.build`, `bun:test`) when available; the runtime-compat layer covers Node fallbacks.

## Sub-AGENTS

- `packages/web/AGENTS.md` — Astro/Starlight-specific rules (content collections, frontmatter, MDX vs Markdoc, sidebar). Read it before touching the website.

## Things to not do

- Don't commit secrets. The Homebrew `MACOS_CERTIFICATE` etc. live in GitHub secrets only.
- Don't bump versions by hand — `scripts/publish.ts` rewrites `package.json` during release.
- Don't delete `dist/`, `lib/bundle.cjs`, or `.turbo/` casually — they're gitignored build outputs but breaking the bundle breaks `index.js`.
- Don't change `runtime-compat.ts` import order or remove the `NODE_ENV !== "test"` guard.
- Don't read defaults from root `ocsight.config.json` `paths` — those are sample values, not real config.
