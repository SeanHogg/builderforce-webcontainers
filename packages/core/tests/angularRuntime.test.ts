import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevServer } from '../src/devServer.js';
import { angularCompilerFor } from '../src/angular/compiler.js';
import type { ComponentCompilers } from '../src/components.js';
import { errorBridgeScript, ERROR_MESSAGE_TYPE } from '../src/html.js';
import { previewErrorText } from '../src/previewErrorText.js';
import { project, styles, text, transformer } from './helpers.js';

/**
 * REAL Angular (the 20.x devDependencies), run end to end in Node: every module
 * of an `ng new`-shaped project is served by the DevServer — so it takes the
 * real path, componentKindFor → the Angular compiler (resources inlined through
 * componentResources, signal members, ctorParameters) → the esbuild transform
 * with the compiler's TypeScript options — and native esbuild then bundles those
 * served modules with the Angular packages from node_modules (bare imports stay
 * bare: the test CDN maps a package to its own name). The bundle runs in a jsdom
 * window, and each app must render and react to a click.
 *
 * jsdom setup: `runScripts: 'outside-only'` (the bundle is evaluated with
 * `window.eval`, so zone.js patches the jsdom window's own globals, as it would a
 * browser's) and `pretendToBeVisual` (requestAnimationFrame, which zoneless
 * change detection schedules with). DOM updates are awaited by polling: zone.js
 * and the zoneless scheduler both run change detection on their own task after
 * the click, which a test cannot hook without changing the app.
 */
const BASE = '/__bfwc/rt/';
const CORE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const components: ComponentCompilers = (kind, dependencies) =>
  kind === 'angular' ? Promise.resolve(angularCompilerFor(dependencies)) : Promise.reject(new Error(`no ${kind} compiler`));

const TSCONFIG = '{ "compilerOptions": { "strict": true, "experimentalDecorators": true, "useDefineForClassFields": false, "target": "ES2022", "module": "preserve" } }';
const INDEX = '<!doctype html><html lang="en"><head><meta charset="utf-8"><base href="/"></head><body><app-root></app-root></body></html>';

const packageJson = (zone: boolean) => JSON.stringify({
  name: 'app',
  dependencies: {
    '@angular/common': '^20.3.0', '@angular/compiler': '^20.3.0', '@angular/core': '^20.3.0', '@angular/platform-browser': '^20.3.0',
    rxjs: '~7.8.0', tslib: '^2.3.0', ...(zone ? { 'zone.js': '~0.15.0' } : {}),
  },
});

/** The project bundled from what the dev server serves for it. */
async function bundle(files: Record<string, string>): Promise<string> {
  const server = new DevServer({ fs: project(files), transformer, base: BASE, components, styles, cdn: () => ({ urlFor: (name, subpath) => name + subpath }) });
  const result = await esbuild.build({
    entryPoints: [`${BASE}src/main.ts`],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
    plugins: [{
      name: 'bfwc-dev-server',
      setup(build) {
        build.onResolve({ filter: /^\/__bfwc\/rt\// }, (args) => {
          const [path, query] = args.path.split('?');
          return { path: path!.slice(BASE.length - 1), namespace: 'bfwc-dev', ...(query ? { suffix: `?${query}` } : {}) };
        });
        build.onLoad({ filter: /.*/, namespace: 'bfwc-dev' }, async (args) => {
          const served = await server.handle(args.path, args.suffix ?? '');
          const body = text(served.body);
          if (served.status !== 200 || body.startsWith('throw new Error(')) throw new Error(`${args.path}: ${body}`);
          return { contents: body, loader: 'js', resolveDir: CORE_DIR };
        });
      },
    }],
  });
  return result.outputFiles[0]!.text;
}

interface Running {
  document: Document;
  window: JSDOM['window'];
  /** What the error bridge posted to the (stub) parent. */
  posted: Array<Record<string, unknown>>;
  /** Errors jsdom itself reported (uncaught exceptions in the page). */
  pageErrors: unknown[];
}

/** Runs the bundle in a fresh jsdom page, behind the Angular error bridge (console.error forwarding on). */
function run(code: string): Running {
  const pageErrors: unknown[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => pageErrors.push(error));
  const dom = new JSDOM(INDEX, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/', virtualConsole });
  const posted: Array<Record<string, unknown>> = [];
  (dom.window as unknown as { __parent: unknown }).__parent = { postMessage: (message: Record<string, unknown>) => posted.push(message) };
  const bridge = errorBridgeScript('n0nce', { forwardConsoleErrors: true }).replace(/^<script>/, '').replace(/<\/script>$/, '');
  dom.window.eval(`(function (parent) {\n${bridge}\n})(window.__parent);`);
  dom.window.eval(code);
  return { document: dom.window.document, window: dom.window, posted, pageErrors };
}

async function until<T>(read: () => T | undefined, what: string, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const textOf = (page: Running, selector: string) => page.document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
const click = (page: Running, selector: string) => page.document.querySelector(selector)!.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
const errorsOf = (page: Running) => page.posted.filter((message) => message.type === ERROR_MESSAGE_TYPE);

describe('real Angular 20 in jsdom', () => {
  it('(a) default ng new app: zone.js, templateUrl + styleUrl, title signal, click increments a signal', async () => {
    const page = run(await bundle({
      'package.json': packageJson(true),
      'tsconfig.json': TSCONFIG,
      'src/index.html': INDEX,
      'angular.json': JSON.stringify({ projects: { app: { projectType: 'application', sourceRoot: 'src', architect: { build: { builder: '@angular/build:application', options: { browser: 'src/main.ts', polyfills: ['zone.js'], styles: ['src/styles.css'] } } } } } }),
      'src/styles.css': 'body { color: rgb(7, 8, 9); }',
      'src/main.ts': [
        `import { bootstrapApplication } from '@angular/platform-browser';`,
        `import { appConfig } from './app/app.config';`,
        `import { App } from './app/app';`,
        `bootstrapApplication(App, appConfig).catch((err) => console.error(err));`,
      ].join('\n'),
      'src/app/app.config.ts': [
        `import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';`,
        `export const appConfig: ApplicationConfig = { providers: [provideBrowserGlobalErrorListeners(), provideZoneChangeDetection({ eventCoalescing: true })] };`,
      ].join('\n'),
      'src/app/app.ts': [
        `import { Component, signal } from '@angular/core';`,
        `@Component({ selector: 'app-root', templateUrl: './app.html', styleUrl: './app.css' })`,
        `export class App {`,
        `  protected readonly title = signal('app');`,
        `  protected readonly count = signal(0);`,
        `  increment() { this.count.update((n) => n + 1); }`,
        `}`,
      ].join('\n'),
      'src/app/app.html': `<h1>Hello, {{ title() }}</h1>\n<p class="count">Clicked {{ count() }} times</p>\n<button (click)="increment()">+1</button>`,
      'src/app/app.css': 'h1 { color: rgb(1, 2, 3); }',
    }));
    expect(await until(() => textOf(page, 'h1'), 'the app to render')).toBe('Hello, app');
    expect(page.window.getComputedStyle(page.document.querySelector('h1')!).color).toBe('rgb(1, 2, 3)');
    expect(page.window.getComputedStyle(page.document.body).color).toBe('rgb(7, 8, 9)');
    click(page, 'button');
    click(page, 'button');
    await until(() => textOf(page, '.count') === 'Clicked 2 times', 'the click to update the count');
    expect(errorsOf(page)).toEqual([]);
    expect(page.pageErrors).toEqual([]);
  });

  it('(b) templateUrl + .scss, a constructor-injected service, @Optional() T | null and @Inject(TOKEN)', async () => {
    const page = run(await bundle({
      'package.json': packageJson(true),
      'tsconfig.json': TSCONFIG,
      'src/index.html': INDEX,
      'src/main.ts': [
        `import { bootstrapApplication } from '@angular/platform-browser';`,
        `import { AppComponent, GREETING } from './app/app.component';`,
        `bootstrapApplication(AppComponent, { providers: [{ provide: GREETING, useValue: 'Welcome' }] }).catch((err) => console.error(err));`,
      ].join('\n'),
      'src/app/counter.service.ts': [
        `import { Injectable } from '@angular/core';`,
        `@Injectable({ providedIn: 'root' })`,
        `export class CounterService { count = 0; async increment(): Promise<void> { await Promise.resolve(); this.count++; } }`,
      ].join('\n'),
      'src/app/logger.ts': `import { Injectable } from '@angular/core';\n@Injectable()\nexport class Logger { log(_: string) {} }`,
      'src/app/app.component.ts': [
        `import { Component, Inject, InjectionToken, Optional } from '@angular/core';`,
        `import { CounterService } from './counter.service';`,
        `import { Logger } from './logger';`,
        `export const GREETING = new InjectionToken<string>('greeting');`,
        `@Component({`,
        `  selector: 'app-root',`,
        `  standalone: true,`,
        `  templateUrl: './app.component.html',`,
        `  styleUrls: ['./app.component.scss'],`,
        `})`,
        `export class AppComponent {`,
        `  constructor(public readonly counter: CounterService, @Optional() private log: Logger | null, @Inject(GREETING) public greeting: string) {}`,
        `  get logged(): string { return this.log ? 'logger' : 'no logger'; }`,
        `}`,
      ].join('\n'),
      'src/app/app.component.html': `<p class="greeting">{{ greeting }} ({{ logged }})</p><p class="count">{{ counter.count }}</p><button (click)="counter.increment()">add</button>`,
      'src/app/app.component.scss': '$accent: rgb(4, 5, 6);\n.greeting { color: $accent; }',
    }));
    expect(await until(() => textOf(page, '.greeting'), 'the app to render')).toBe('Welcome (no logger)');
    expect(page.window.getComputedStyle(page.document.querySelector('.greeting')!).color).toBe('rgb(4, 5, 6)');
    expect(textOf(page, '.count')).toBe('0');
    click(page, 'button');
    // The async increment is lowered to a generator, so zone.js sees its await and re-renders after it.
    await until(() => textOf(page, '.count') === '1', 'the click to update the count');
    expect(errorsOf(page)).toEqual([]);
  });

  it('(c) zoneless: inject(), a signal input.required() bound from the parent, an output() the parent handles', async () => {
    const page = run(await bundle({
      'package.json': packageJson(false),
      'tsconfig.json': TSCONFIG,
      'src/index.html': INDEX,
      'src/main.ts': [
        `import { bootstrapApplication } from '@angular/platform-browser';`,
        `import { provideZonelessChangeDetection } from '@angular/core';`,
        `import { App } from './app/app';`,
        `bootstrapApplication(App, { providers: [provideZonelessChangeDetection()] }).catch((err) => console.error(err));`,
      ].join('\n'),
      'src/app/totals.ts': `import { Injectable, signal } from '@angular/core';\n@Injectable({ providedIn: 'root' })\nexport class Totals { readonly sum = signal(0); }`,
      'src/app/stepper.ts': [
        `import { Component, input, output } from '@angular/core'`,
        `@Component({ selector: 'app-stepper', template: '<button (click)="stepped.emit(step())">step {{ label() }}</button>' })`,
        `export class Stepper {`,
        `  readonly label = input.required<string>()`,
        `  readonly step = input(1)`,
        `  readonly stepped = output<number>()`,
        `}`,
      ].join('\n'),
      'src/app/app.ts': [
        `import { Component, inject } from '@angular/core';`,
        `import { Stepper } from './stepper';`,
        `import { Totals } from './totals';`,
        `@Component({ selector: 'app-root', imports: [Stepper], template: '<app-stepper [label]="name" [step]="5" (stepped)="add($event)" /><p class="sum">sum {{ totals.sum() }}</p>' })`,
        `export class App {`,
        `  protected readonly totals = inject(Totals);`,
        `  protected readonly name = 'by five';`,
        `  add(step: number) { this.totals.sum.update((n) => n + step); }`,
        `}`,
      ].join('\n'),
    }));
    expect(await until(() => textOf(page, 'button'), 'the app to render')).toBe('step by five');
    expect(textOf(page, '.sum')).toBe('sum 0');
    expect((page.window as unknown as { Zone?: unknown }).Zone).toBeUndefined();
    click(page, 'button');
    click(page, 'button');
    await until(() => textOf(page, '.sum') === 'sum 10', 'the output to update the parent');
    expect(errorsOf(page)).toEqual([]);
  });

  it('(d) a constructor injecting an unprovided service reaches the error bridge with its NG code', async () => {
    const page = run(await bundle({
      'package.json': packageJson(true),
      'tsconfig.json': TSCONFIG,
      'src/index.html': INDEX,
      'src/main.ts': [
        `import { bootstrapApplication } from '@angular/platform-browser';`,
        `import { App } from './app/app';`,
        `bootstrapApplication(App).catch((err) => console.error(err));`,
      ].join('\n'),
      'src/app/missing.ts': `import { Injectable } from '@angular/core';\n@Injectable()\nexport class Missing {}`,
      'src/app/app.ts': [
        `import { Component } from '@angular/core';`,
        `import { Missing } from './missing';`,
        `@Component({ selector: 'app-root', template: '<p>never</p>' })`,
        `export class App { constructor(private missing: Missing) {} }`,
      ].join('\n'),
    }));
    const [error] = await until(() => (errorsOf(page).length ? errorsOf(page) : undefined), 'the bootstrap failure');
    expect(error).toMatchObject({ type: ERROR_MESSAGE_TYPE, source: 'console', nonce: 'n0nce', href: 'http://localhost/' });
    // What the host's listenToPreview → onError makes of it (browser/src/previewMessages.ts runs exactly this).
    const reported = previewErrorText(String(error!.message), error!.stack as string | undefined);
    expect(reported.code).toBe('NG0201');
    expect(reported.message).toMatch(/^NG0201: No provider found for `_?Missing`/);
    expect(textOf(page, 'p')).toBeUndefined();
  });

  it("(e) Angular's string-form template error (NG0303) reaches the error bridge", async () => {
    const page = run(await bundle({
      'package.json': packageJson(true),
      'tsconfig.json': TSCONFIG,
      'src/index.html': INDEX,
      'src/main.ts': `import { bootstrapApplication } from '@angular/platform-browser';\nimport { App } from './app/app';\nbootstrapApplication(App).catch((err) => console.error(err));`,
      'src/app/app.ts': `import { Component } from '@angular/core';\n@Component({ selector: 'app-root', template: '<div class="x" [foo]="1">rendered</div>' })\nexport class App {}`,
    }));
    await until(() => textOf(page, '.x'), 'the app to render');
    const [error] = await until(() => (errorsOf(page).length ? errorsOf(page) : undefined), 'the NG0303 report');
    expect(error).toMatchObject({ source: 'console' });
    expect(previewErrorText(String(error!.message)).code).toBe('NG0303');
  });
});
