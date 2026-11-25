# Changelog

Release history for `@seanhogg/builderforce-webcontainers` and
`@seanhogg/builderforce-webcontainers-core`. Both packages share one version.
Upgrade steps that change your code are in the README's
[Upgrade notes](README.md#upgrade-notes).

## What's new in 2026.11.27

- **Agents' models reach the services that use them.** A backend service that
  declares an `ai` resource now gets `AI_BASE_URL` (or `<ID>_AI_BASE_URL` when
  it uses several) pointing at an OpenAI-compatible port inside the
  environment. `startApplicationRuntime` serves it from a `hostRelay` you pass;
  the relay attaches the signed-in session on the host side, so no key or
  token ever enters a process's environment. The port belongs to its service
  alone: a dependent service, a preview origin and the platform cannot reach
  it, and it closes on `dispose()`. A model outside the manifest's allowlist
  is refused before the relay is called, and a relay that fails answers 502.
  `PreviewRuntime.listenHttp` and `PortRegistry.listenExclusive` are the new
  seams.
- **The local launcher can relay models.** `createLocalLauncher({ forwardAi })`
  serves a token-gated `POST /__bf/ai` on the page origin only (never on a
  preview origin) and `launch.json` reports `aiRelay`. The launcher page builds
  the `HostRelay` for you.
- **Launcher options.** `frameAncestors` lets a VS Code webview or embedding
  site frame previews (exact https or `vscode-webview` origins; a wildcard or
  http origin throws). `ignoredDirs` leaves named directories out of the file
  API and live sync, beside the built-in ones.

## What's new in 2026.11.26

- **Launch a single HTML page.** `createLocalLauncher({ page })` takes a
  project-relative, top-level `.html`/`.htm` page. It is served at `/`, and its
  relative CSS, script and image links resolve against the project directory.
  The page is validated at start: it must be contained in the project (symlinks
  are resolved), top level, HTML and present. A bad page throws
  `LaunchPageError` with a `code` (`not-relative`, `not-top-level`,
  `not-html`, `missing`, `directory`, `outside`).
  `detectProject(fs, { page })` serves that document and never falls back to
  `index.html`.
- **Bare dev-server commands start the instant preview.** A service whose
  command is `vite`, `react-scripts`, `craco` or `ng`, with nothing installed,
  now hands off to the in-browser DevServer. Before, it failed with
  "command not found". An installed binary in `node_modules/.bin` still runs as
  itself, with the terminal's size, raw keystrokes and resize. With neither a
  preview nor a binary, the command exits 127.
- **Fix: `once('data')` on stdin now reads input.** `EventEmitter.once` now
  goes through `on`, as in Node. A program that reads stdin with a one-shot
  listener (`process.stdin.once('data', …)`, as prompt libraries and dev-server
  shortcuts do) starts the stream and gets its input. Before, it exited at
  once with nothing read.

## What's new in 2026.11.25

- **Stable application identity from the manifest name (W10).**
  `toApplicationSpec` passes the manifest's optional `name` to `ApplicationSpec`.
  The runtime derives `applicationId` from the project ID and application name,
  so two named applications in the same project get distinct IDs even with
  identical services. Each ID persists across launches and service changes.
- **Compatibility.** Unnamed applications retain their existing service-based
  IDs. Existing lease and recovery storage keeps its keys. Previously launched
  named applications get a new preview origin on upgrade. Browser data tied to
  the previous origin stays there. See the [upgrade notes](README.md#upgrading-to-20261125).

## What's new in 2026.11.24

Autonomous agents now run inside the environment. See
[New in 2026.11.24](README.md#new-in-20261124-autonomous-agents-inside-the-environment).

- **Manifest v1 `capabilities` and `agents`.** Agents are declared by role or
  workload, never by model id (`agent-model-id`). `capabilities.agents` sets the
  ceilings, and a declaration above one is a `policy-widening` error. Triggers
  are `{ manual }`, `{ cron, timezone? }` and `{ service, event }`. The JSON
  Schema covers both fields.
- **`@seanhogg/builderforce-webcontainers/agents`.** It has
  `createEnvironmentToolPort`: the `env.*` tools, with allowlist,
  idempotency-key, path and service checks, and typed refusals reported to the
  Shield. It also has the `AgentHostPort` contract, `createRuntimeAgents`
  (`runtime.agents.list|start|steer|cancel|status`), `createAgentsCapability` and
  `createChildRuntimes`.
- **`/recovery`.** `createEnvironmentRecovery` restores the file system, the
  database and services after a crash, under one runtime lease.
- **`/app`.** `createJobScheduler` fires `jobs` and agent cron triggers under
  the runtime lease.

## What's new in 2026.11.11

- **The manifest location is checked.** The launcher page now shows a notice
  when it reads a root `builderforce.json` or `bfwc.app.json` from an older
  version: move it to `.builderforce/builderforce.json` (`/manifest move`). A
  manifest whose real path leaves the project, such as a `.builderforce` linked
  elsewhere, is refused and never read, and the launch stops with that reason
  (not "run /manifest init", which would write through the same link). Reads
  go through the same contained reader as the project file API, capped at
  1 MiB. A `.builderforce` that is a file, or a
  manifest path that is a directory, counts as missing instead of failing the
  launch. A manifest that is there but cannot be read (no permission, over
  1 MiB) stops the launch with the reason; a stale root file is never read in
  its place. Three new overridable labels: `legacyManifestLocation`,
  `manifestOutsideProject` and `manifestUnreadable`.
- **`paths` are validated.** An empty or absolute `paths.logs`,
  `paths.diagnostics` or `paths.methodology`, a `..` segment, or an unknown key
  is an `invalid-path` (or `invalid-value`) warning. `parseManifest` leaves it
  out, so the default under `.builderforce/` applies.
- **The launcher names the project after its directory.** With the manifest in
  `.builderforce/` and no `name`, the header showed ".builderforce".
  `LaunchInfo.projectDir` now carries the project directory.
- **Links from outside the browser open a preview root only.** A link in mail
  or chat (`Sec-Fetch-Site: none`) opens `/__bfwc/<id>/` or
  `/__bfwc/<id>/__port/<n>/` through `/preview`. A deeper path, a query or a
  fragment gets a 404 or a 403, so a link cannot drive a request into the
  running app.
  The launcher's own "Open in new tab" is unchanged.
- **Eval-free export names.** String-literal export names
  (`export { x as "a-b" }`) are decoded without `eval`, like import specifiers
  in 2026.11.10.

## What's new in 2026.11.10

- **Launcher previews render.** A React app run by `bfwc-launch` showed an
  empty frame with only the badge: the dev server sent its modules with bare
  imports (`react`, `react/jsx-runtime`) left in, and the browser refused them.
  es-module-lexer decodes each import specifier with `eval`, which the launcher
  page's CSP forbids, so every specifier came back empty and none was rewritten.
  Specifiers are now decoded without `eval`, so imports
  are rewritten to the package CDN under any CSP. The CSP itself is unchanged.
- **"Open in new tab" works.** A preview opened in its own tab (the launcher's
  link, or the `Local:` URL Vite prints) answered "Not found.". Preview origins
  are a different site from the launcher page, so the relay's service worker
  lives in the launcher page's storage partition, and a top-level tab on a
  preview origin has none. The preview origin now redirects such a tab to the
  launcher page's new `/preview?src=<url>`, which frames the preview full size
  under the same partition, served by the running launcher tab. The page runs
  no script, holds no token, and frames only this launcher's preview origins.
  Only the user can open it, never another site: the redirect happens only for
  a tab the user opened (`Sec-Fetch-Site: none`) and carries a 60-second ticket
  signed for that one URL, and `/preview` otherwise answers only the launcher
  page's own link.
  A framed preview that loads before its service worker is active gets a small
  bootstrap page (one hash-pinned script) that reloads once the worker is
  active, or says the preview is not running. Three new overridable labels:
  `previewStarting`, `previewNotRunning` and `previewInvalid`.
- **The manifest lives in `.builderforce/`.** `.builderforce/builderforce.json`
  is the canonical manifest (`./manifest` exports `locateManifest` and
  `manifestWritePath`; `bfwc-launch` reads it there). A root `builderforce.json`
  or `bfwc.app.json` is a deprecated fallback: still read, never written. The
  manifest gains `paths` (`logs`, `diagnostics`, `methodology`), each
  project-relative inside the project, defaulting under `.builderforce/`.

## What's new in 2026.11.9

- **A manifest `command` is a command line.** `npm install`, `npm run dev` and
  `uvicorn main:app --host 0.0.0.0` are split into the program and its
  arguments, ahead of any `args`. Before, the whole line was taken as one
  program name and the service exited 127 ("command not found"). Quotes group
  words (`"/path with space/node" server.js`). A job's `run.command` is read
  the same way.
- **Shell lines.** A line that needs a shell (`&&`, `|`, redirects,
  `FOO=1 cmd`, `$VAR`) runs as `bfsh -c <line>` for a node service on the
  browser target. Anywhere else it is a typed issue, not a mangled command.
- **New manifest issue codes.** `shell-command-unsupported` (the line needs a
  shell its runtime or target does not have), `shell-command-with-args` (a
  shell line cannot also take `args`; put the whole line in `command`) and
  `command-backslash` (a warning: an unquoted `\` the shell drops, so use
  forward slashes in paths). An unterminated quote is an `invalid-value`.
- **The node decline list sees inside shell lines.** `cd infra && docker compose up`,
  `sh -c '…'`, `bash -e -c '…'` and command substitutions are unwrapped, so a
  declined program (Docker, `wrangler dev`) is declined wherever it appears.
- **"Copy diagnostics" on the launcher page.** One button copies a report of
  the launch: header, status, services, problems and every buffered log line,
  with credentials redacted. Its text comes from three new overridable labels:
  `copyDiagnostics`, `copyDiagnosticsDone` and `copyDiagnosticsFailed`.
- **Broader credential redaction.** The shield's `scrubCredentials`, which
  scrubs security event evidence (`scrubString`) and the copied diagnostics
  report, now catches any key ending in a secret word (`GITHUB_TOKEN=`,
  `DB_PASSWORD=`, `OPENAI_API_KEY:`), quoted JSON keys
  (`"token":"…"`), and `Authorization` headers of any scheme.
- **Diagnostics.** `runtime.diagnostics()` returns one load report: phase
  timings (runtime start, service worker ready, compiler load, preview first
  paint), package CDN request count, total time and errors, requests per
  origin, the slowest requests (origin only, never a URL), recent CSP
  violations, a cold or warm cache, and `unavailable` for what could not be
  measured. See [Diagnostics](packages/browser/README.md#diagnostics).
- **CSP violations on the host page.** `runtime.onCspViolation(listener)`
  reports which origin the preview's policy blocked and under which directive.
  Paths are never forwarded; reports are deduplicated and capped. See
  [Preview origin headers](packages/browser/README.md#preview-origin-headers).
- **Report-only previews for migrations.** `previewCspMode: 'report-only'`
  reports violations without blocking. It turns the protection off, so your
  `sw.js` gate must allow it deliberately (Builderforce never does).
- **A custom package CDN joins the preview CSP.** A `cdn` factory declares
  `origins` and the runtime adds them to the preview egress;
  `createEsmShCdnFactory({ origin })` does this for an esm.sh mirror. A custom
  CDN with no `origins` logs one warning instead of producing a blank page.
  See [Since 2026.11.9](README.md#since-2026119).
- **Laravel's `php artisan serve` runs.** A Vite frontend, a Laravel API and
  Postgres start end to end as one application, and a setup step's output
  (`composer install`, `npm install`) ends with its last line before a service
  changes state. See
  [Example: a Vite front end, a Laravel API and Postgres](packages/browser/README.md#example-a-vite-front-end-a-laravel-api-and-postgres).
- **Hosting.** The .NET runtime bundle installs from npm as
  `@seanhogg/builderforce-webcontainers-dotnet` ([.NET](packages/browser/README.md#net)),
  and [Assets fetched at runtime](README.md#assets-fetched-at-runtime) lists every
  origin the runtime downloads from, for strict-CSP and offline hosts.
