import { describe, expect, it } from 'vitest';
import { DevServer } from '../src/devServer.js';
import { buildProject } from '../src/build.js';
import { angularCompilerFor } from '../src/angular/compiler.js';
import type { ComponentCompilers } from '../src/components.js';
import { bundler, components as sfcCompilers, project, styles, text, transformer } from './helpers.js';

/**
 * Three `ng new`-shaped projects through the dev server and the build, with
 * native esbuild. There is no browser harness here: what is asserted is the
 * served document and modules, not Angular rendering them.
 */
const BASE = '/__bfwc/ng/';
const components: ComponentCompilers = (kind, dependencies) =>
  kind === 'angular' ? Promise.resolve(angularCompilerFor(dependencies)) : sfcCompilers(kind, dependencies);

const TSCONFIG = `/* To learn more about Typescript configuration file: https://angular.dev/reference/configs/workspace-config. */
{
  "compileOnSave": false,
  "compilerOptions": {
    "strict": true,
    "experimentalDecorators": true,
    "useDefineForClassFields": false,
    "skipLibCheck": true,
    "target": "ES2022",
    "module": "preserve",
  },
  "angularCompilerOptions": { "strictTemplates": true },
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }]
}`;

const INDEX = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>App</title>
  <base href="/">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/x-icon" href="favicon.ico">
</head>
<body>
  <app-root></app-root>
</body>
</html>`;

const angularJson = (options: object) => JSON.stringify({
  $schema: './node_modules/@angular/cli/lib/config/schema.json',
  version: 1,
  newProjectRoot: 'projects',
  projects: {
    app: {
      projectType: 'application',
      root: '',
      sourceRoot: 'src',
      prefix: 'app',
      architect: {
        build: {
          builder: '@angular/build:application',
          options,
          configurations: { production: { budgets: [{ type: 'initial', maximumWarning: '500kB' }], outputHashing: 'all' }, development: { optimization: false, sourceMap: true } },
          defaultConfiguration: 'production',
        },
        serve: { builder: '@angular/build:dev-server' },
      },
    },
  },
});

const packageJson = (version: string, extra: Record<string, string> = {}) => JSON.stringify({
  name: 'app',
  scripts: { ng: 'ng', start: 'ng serve', build: 'ng build' },
  dependencies: {
    '@angular/common': version, '@angular/compiler': version, '@angular/core': version, '@angular/forms': version,
    '@angular/platform-browser': version, '@angular/router': version, rxjs: '~7.8.0', tslib: '^2.3.0', ...extra,
  },
  devDependencies: { '@angular/build': version, '@angular/cli': version, '@angular/compiler-cli': version, typescript: '~5.8.2' },
});

/** (1) The default standalone app: templateUrl + styleUrl .css, zone.js, a click handler on a signal. */
function defaultApp() {
  return project({
    'package.json': packageJson('^20.0.0', { 'zone.js': '~0.15.0' }),
    'angular.json': angularJson({
      browser: 'src/main.ts', polyfills: ['zone.js'], tsConfig: 'tsconfig.app.json',
      assets: [{ glob: '**/*', input: 'public' }], styles: ['src/styles.css'],
    }),
    'tsconfig.json': TSCONFIG,
    'tsconfig.app.json': '{ "extends": "./tsconfig.json", "compilerOptions": { "outDir": "./out-tsc/app", "types": [] }, "files": ["src/main.ts"] }',
    'public/favicon.ico': 'ico',
    'src/index.html': INDEX,
    'src/styles.css': '/* global */ body { margin: 0; }',
    'src/main.ts': [
      `import { bootstrapApplication } from '@angular/platform-browser';`,
      `import { appConfig } from './app/app.config';`,
      `import { App } from './app/app';`,
      ``,
      `bootstrapApplication(App, appConfig)`,
      `  .catch((err) => console.error(err));`,
    ].join('\n'),
    'src/app/app.config.ts': [
      `import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';`,
      `import { provideRouter } from '@angular/router';`,
      `import { routes } from './app.routes';`,
      `export const appConfig: ApplicationConfig = {`,
      `  providers: [provideBrowserGlobalErrorListeners(), provideZoneChangeDetection({ eventCoalescing: true }), provideRouter(routes)],`,
      `};`,
    ].join('\n'),
    'src/app/app.routes.ts': `import { Routes } from '@angular/router';\n\nexport const routes: Routes = [];`,
    'src/app/app.ts': [
      `import { Component, signal } from '@angular/core';`,
      `import { RouterOutlet } from '@angular/router';`,
      ``,
      `@Component({`,
      `  selector: 'app-root',`,
      `  imports: [RouterOutlet],`,
      `  templateUrl: './app.html',`,
      `  styleUrl: './app.css'`,
      `})`,
      `export class App {`,
      `  protected readonly title = signal('app');`,
      `  protected readonly count = signal(0);`,
      `  increment() { this.count.update((n) => n + 1); }`,
      `}`,
    ].join('\n'),
    'src/app/app.html': `<h1>Hello, {{ title() }}</h1>\n@if (count() > 0) { <p>Clicked {{ count() }} times</p> }\n<button (click)="increment()">+1</button>\n<router-outlet />`,
    'src/app/app.css': ':host { display: block; } h1 { color: #333; }',
  });
}

/** (2) Angular 17 shape: templateUrl + .scss styleUrls, src/assets, a constructor-injected service. */
function scssServiceApp() {
  return project({
    'package.json': packageJson('^17.3.0', { 'zone.js': '~0.14.3' }),
    'angular.json': angularJson({
      outputPath: 'dist/app', index: 'src/index.html', browser: 'src/main.ts', polyfills: ['zone.js'], inlineStyleLanguage: 'scss',
      assets: ['src/favicon.ico', 'src/assets'], styles: ['src/styles.scss'], scripts: [],
    }),
    'tsconfig.json': TSCONFIG,
    'src/index.html': INDEX,
    'src/favicon.ico': 'ico',
    'src/assets/logo.svg': '<svg/>',
    'src/styles.scss': '$bg: #fafafa;\nbody { background: $bg; }',
    'src/main.ts': `import { bootstrapApplication } from '@angular/platform-browser';\nimport { AppComponent } from './app/app.component';\n\nbootstrapApplication(AppComponent).catch((err) => console.error(err));`,
    'src/app/data.service.ts': [
      `import { Injectable } from '@angular/core';`,
      `@Injectable({ providedIn: 'root' })`,
      `export class DataService {`,
      `  async load(): Promise<string[]> { await Promise.resolve(); return ['a', 'b']; }`,
      `}`,
    ].join('\n'),
    'src/app/app.component.ts': [
      `import { Component } from '@angular/core';`,
      `import { CommonModule } from '@angular/common';`,
      `import { DataService } from './data.service';`,
      ``,
      `@Component({`,
      `  selector: 'app-root',`,
      `  standalone: true,`,
      `  imports: [CommonModule],`,
      `  templateUrl: './app.component.html',`,
      `  styleUrls: ['./app.component.scss'],`,
      `})`,
      `export class AppComponent {`,
      `  items: string[] = [];`,
      `  constructor(private readonly data: DataService) {}`,
      `  async ngOnInit() { this.items = await this.data.load(); }`,
      `}`,
    ].join('\n'),
    'src/app/app.component.html': '<ul><li *ngFor="let item of items">{{ item }}</li></ul><img src="assets/logo.svg">',
    'src/app/app.component.scss': '$accent: rebeccapurple;\nli { color: $accent; }',
  });
}

/** (3) Zoneless: no zone.js, inject(), and a child with a required signal input. */
function zonelessApp() {
  return project({
    'package.json': packageJson('^20.1.0'),
    'angular.json': angularJson({ browser: 'src/main.ts', tsConfig: 'tsconfig.app.json', assets: [{ glob: '**/*', input: 'public' }], styles: ['src/styles.css'] }),
    'tsconfig.json': TSCONFIG,
    'src/index.html': INDEX,
    'src/styles.css': 'body { margin: 0; }',
    'src/main.ts': [
      `import { bootstrapApplication } from '@angular/platform-browser';`,
      `import { provideZonelessChangeDetection } from '@angular/core';`,
      `import { App } from './app/app';`,
      `bootstrapApplication(App, { providers: [provideZonelessChangeDetection()] }).catch((err) => console.error(err));`,
    ].join('\n'),
    'src/app/greeting.ts': [
      `import { Component, input } from '@angular/core';`,
      `@Component({ selector: 'app-greeting', template: \`<p>Hi {{ name() }} \\\`{{ '{' }}\\\`</p>\` })`,
      `export class Greeting { readonly name = input.required<string>(); }`,
    ].join('\n'),
    'src/app/clock.ts': `import { Injectable, signal } from '@angular/core';\n@Injectable({ providedIn: 'root' })\nexport class Clock { readonly now = signal(Date.now()); }`,
    'src/app/app.ts': [
      `import { Component, inject } from '@angular/core';`,
      `import { Greeting } from './greeting';`,
      `import { Clock } from './clock';`,
      `@Component({ selector: 'app-root', imports: [Greeting], template: '<app-greeting [name]="\\'world\\'" />{{ clock.now() }}' })`,
      `export class App { protected readonly clock = inject(Clock); async refresh() { await Promise.resolve(); } }`,
    ].join('\n'),
  });
}

const serve = (fs: ReturnType<typeof project>) => new DevServer({ fs, transformer, base: BASE, components, styles });
const body = async (server: DevServer, url: string) => {
  const [path, search = ''] = url.split('?');
  return text((await server.handle(path!, search)).body);
};

/** The specifiers of the entry's leading imports, in order. */
function leadingImports(js: string): string[] {
  return [...js.matchAll(/import\s*(?:[^'"]*?from\s*)?["']([^"']+)["']/g)].map((m) => m[1]!);
}

describe('Angular through the dev server', () => {
  it('(1) serves the default standalone app', async () => {
    const server = serve(defaultApp());
    const html = await body(server, '/');
    expect(html).toContain('<app-root></app-root>');
    expect(html).toContain(`<base href="${BASE}">`);
    expect(html).toContain(`<script type="module" src="${BASE}src/main.ts"></script>`);

    const main = await body(server, '/src/main.ts');
    expect(main).not.toMatch(/^throw /);
    const imports = leadingImports(main);
    expect(imports.slice(0, 3)).toEqual([
      'https://esm.sh/zone.js@~0.15.0?dev',
      `${BASE}src/styles.css?import`,
      'https://esm.sh/@angular/compiler@^20.0.0?dev',
    ]);
    expect(imports).toContain('https://esm.sh/@angular/platform-browser@^20.0.0?dev');
    expect(imports).toContain(`${BASE}src/app/app.ts`);

    const app = await body(server, '/src/app/app.ts');
    expect(app).not.toContain('templateUrl');
    expect(app).not.toContain('styleUrl');
    expect(app).toContain('Hello, {{ title() }}');
    expect(app).toContain('<button (click)="increment()">+1</button>');
    expect(app).toContain(':host { display: block; }');
    expect(app).toMatch(/__decorateClass/);
    expect(app).toContain('https://esm.sh/@angular/core@^20.0.0?dev');

    // Static assets from angular.json, global styles as a style module.
    expect(text((await server.handle('/favicon.ico')).body)).toBe('ico');
    expect(await body(server, '/src/styles.css?import')).toContain('margin: 0');
  });

  it('(1) rebuilds a component when its template or stylesheet changes', async () => {
    const fs = defaultApp();
    const server = serve(fs);
    await server.handle('/src/main.ts');
    await server.handle('/src/app/app.ts');
    fs.writeFile('/src/app/app.css', 'h1 { color: red; }');
    expect(server.planUpdate([{ type: 'write', path: '/src/app/app.css' }])).toEqual({ type: 'reload' });
    expect(await body(server, '/src/app/app.ts')).toContain('h1 { color: red; }');
    fs.writeFile('/src/app/app.html', '<h2>changed</h2>');
    expect(await body(server, '/src/app/app.ts')).toContain('<h2>changed</h2>');
  });

  it('(2) inlines .scss styleUrls, records the injected service, lowers async for zone.js', async () => {
    const server = serve(scssServiceApp());
    const main = await body(server, '/src/main.ts');
    expect(leadingImports(main).slice(0, 3)).toEqual([
      'https://esm.sh/zone.js@~0.14.3?dev',
      `${BASE}src/styles.scss?import`,
      'https://esm.sh/@angular/compiler@^17.3.0?dev',
    ]);
    expect(await body(server, '/src/styles.scss?import')).toContain('background: #fafafa');

    const app = await body(server, '/src/app/app.component.ts');
    expect(app).not.toContain('templateUrl');
    expect(app).not.toContain('styleUrls');
    expect(app).toContain('*ngFor=\\"let item of items\\"');
    expect(app).toMatch(/li \{\\n\s*color: rebeccapurple;\\n\}/);
    expect(app).toMatch(/ctorParameters = \(\) => \[\{\s*type: DataService\s*\}\]/);
    expect(app).toContain(`${BASE}src/app/data.service.ts`);
    expect(app).not.toMatch(/\basync ngOnInit/);

    const service = await body(server, '/src/app/data.service.ts');
    expect(service).not.toMatch(/\basync\b|\bawait\b/);

    expect(text((await server.handle('/favicon.ico')).body)).toBe('ico');
    expect(text((await server.handle('/assets/logo.svg')).body)).toBe('<svg/>');
  });

  it('(3) runs zoneless: no zone.js prelude, signal input decorated, async kept native', async () => {
    const server = serve(zonelessApp());
    const main = await body(server, '/src/main.ts');
    const imports = leadingImports(main);
    expect(imports.slice(0, 2)).toEqual([`${BASE}src/styles.css?import`, 'https://esm.sh/@angular/compiler@^20.1.0?dev']);
    expect(imports.some((url) => url.includes('zone.js'))).toBe(false);

    const greeting = await body(server, '/src/app/greeting.ts');
    expect(greeting).toMatch(/ɵɵngJitInput|\\u0275\\u0275ngJitInput/);
    expect(greeting).toContain('isSignal: true, alias: "name", required: true');
    expect(greeting).toContain("{{ '{' }}");

    const app = await body(server, '/src/app/app.ts');
    expect(app).not.toContain('ctorParameters');
    expect(app).toMatch(/async refresh\(\)/);
  });
});

describe('Angular through buildProject', () => {
  for (const [name, files] of [['default', defaultApp], ['scss + service', scssServiceApp], ['zoneless', zonelessApp]] as const) {
    it(`builds the ${name} app`, async () => {
      const result = await buildProject({ files: files(), bundler, components, styles, minify: false });
      const out = new Map(result.files.map((file) => [file.path, text(file.data)]));
      const html = out.get('index.html')!;
      expect(html).toContain('<app-root></app-root>');
      const [, js] = [...out].find(([path]) => /^assets\/main-.*\.js$/.test(path))!;
      expect(js).toContain('https://esm.sh/@angular/compiler@');
      expect(js).toContain('bootstrapApplication');
      expect(js).not.toContain('templateUrl');
      expect(js).toMatch(/__decorateClass/);
      expect([...out.keys()].some((path) => /^assets\/main-.*\.css$/.test(path))).toBe(true);
      if (name === 'default') expect(out.get('favicon.ico')).toBe('ico');
      if (name === 'scss + service') {
        expect(out.get('assets/logo.svg')).toBe('<svg/>');
        expect(js).toMatch(/ctorParameters = \(\) => \[\{ type: DataService \}\]/);
        expect(js).not.toMatch(/\basync load\b/);
        expect(js.indexOf('zone.js')).toBeLessThan(js.indexOf('@angular/compiler'));
      }
      if (name === 'zoneless') expect(js).toMatch(/async refresh\(\)/);
    });
  }
});
