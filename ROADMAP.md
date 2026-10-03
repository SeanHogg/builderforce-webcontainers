# Roadmap

The goal is a runtime that matches StackBlitz WebContainers where it matters and
beats it on openness, isolation requirements and extensibility. Each milestone
ships on its own.

## Shipped (2026.10.0)

- Virtual file system with versioned files and change events.
- Per-file dev server: TS/TSX/JSX via a pluggable compiler (esbuild-wasm default).
- Resolution: relative paths, extension and `index` probing, the `.js`→`.ts`
  convention, tsconfig `paths` aliases.
- Bare imports → esm.sh with version pinning and shared-dependency dedupe.
- CSS (with document-safe `url()`), JSON, `?raw`, `?url` and asset imports.
- `import.meta.env` / `.env` (`VITE_*`) and CRA `process.env.REACT_APP_*`.
- Vite, Create React App and static projects; unsupported frameworks declined with a reason.
- Service-worker transport with re-attach after worker restarts.
- Preview errors forwarded to the host page.
- 2026.10.1: documents opt into COEP (`credentialless`), so a cross-origin-isolated host can frame the preview.

## Next

1. **Hot module replacement.** Push a change event to the preview over a
   BroadcastChannel; React Fast Refresh via `react-refresh` from the CDN.
2. **Real CSS Modules.** Scoped class names (today `.module.css` exports an
   identity map).
3. **Vue and Svelte.** Load the official compilers on demand from the CDN and run
   them as transformers.
4. **Offline package cache.** Cache CDN responses in Cache Storage, keyed by
   resolved version, so a reload makes no network requests.
5. **Self-hosted package proxy.** A reference `PackageCdn` that serves npm
   tarballs, transformed to ESM, from your own infrastructure.

## Toward a full Node runtime

6. **`npm install` into the VFS.** Fetch and unpack tarballs and resolve the tree
   in a worker, so `node_modules` exists for tools that read it.
7. **Node API shims.** `fs`, `path`, `process`, `events` and `buffer` over the VFS,
   enough to run build tools (Vite itself) in a worker.
8. **HTTP servers.** Map `http.createServer` onto the service worker so
   Express-style apps can answer preview requests.
9. **Shell.** A small POSIX shell over the VFS for `npm run` scripts.

## Principles

- Ports over hard dependencies: compiler, package CDN and transport are swappable.
- Never require cross-origin isolation.
- Decline what we cannot run, with a reason; never show a half-broken preview.
