import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { VirtualFileSystem } from '../src/vfs.js';
import { angularDiagnostics, ANGULAR_DIAGNOSTIC } from '../src/check/angular.js';
import { formatDiagnostic } from '../src/check/diagnostics.js';
import { typecheckProject } from '../src/check/typecheck.js';
import { libBaseUrlFor } from '../src/check/typeStore.js';
import type { FetchLike } from '../src/check/acquire.js';

const PACKAGE = JSON.stringify({
  name: 'ng-app',
  dependencies: { '@angular/common': '^20.3.0', '@angular/core': '^20.3.0', '@angular/platform-browser': '^20.3.0', rxjs: '~7.8.0', tslib: '^2.3.0' },
  devDependencies: { '@angular/build': '^20.3.0', '@angular/cli': '^20.3.0', typescript: '~5.9.2' },
});

/** What `ng new ng-app` writes (trimmed), including its `ng test` and `ng extract-i18n` targets. */
const ANGULAR_JSON = JSON.stringify(
  {
    $schema: './node_modules/@angular/cli/lib/config/schema.json',
    version: 1,
    projects: {
      'ng-app': {
        projectType: 'application',
        root: '',
        sourceRoot: 'src',
        prefix: 'app',
        architect: {
          build: {
            builder: '@angular/build:application',
            options: { browser: 'src/main.ts', tsConfig: 'tsconfig.app.json', assets: [{ glob: '**/*', input: 'public' }], styles: ['src/styles.css'] },
            configurations: { production: { outputHashing: 'all' }, development: { optimization: false, extractLicenses: false, sourceMap: true } },
            defaultConfiguration: 'production',
          },
          serve: { builder: '@angular/build:dev-server', configurations: { production: { buildTarget: 'ng-app:build:production' } } },
          'extract-i18n': { builder: '@angular/build:extract-i18n' },
          test: { builder: '@angular/build:karma', options: { tsConfig: 'tsconfig.spec.json' } },
        },
      },
    },
  },
  null,
  2,
);

const NG_NEW: Record<string, string> = {
  'package.json': PACKAGE,
  'angular.json': ANGULAR_JSON,
  'src/index.html': '<!doctype html>\n<html lang="en">\n<head><base href="/"></head>\n<body><app-root></app-root></body>\n</html>\n',
  'src/main.ts': `import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
`,
  'src/app/app.config.ts': `import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideZonelessChangeDetection(), provideRouter(routes)],
};
`,
  'src/app/app.routes.ts': `import { Routes } from '@angular/router';\n\nexport const routes: Routes = [];\n`,
  'src/app/app.ts': `import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('ng-app');
  // Arrow functions in class code are fine: () => this.title()
  protected readonly upper = () => this.title().toUpperCase();
}
`,
  'src/app/app.html': `<!-- * * * The content below * * * -->
<!-- Delete the template content below. (x) => x -->
<style>
  .pill-group > * { display: flex; }
</style>
<main class="main">
  <h1>Hello, {{ title() }}</h1>
  <div class="pill-group">
    @for (item of [
      { title: 'Explore the Docs', link: 'https://angular.dev' },
      { title: 'Learn with Tutorials', link: 'https://angular.dev/tutorials' },
    ]; track item.title) {
      <a class="pill" [href]="item.link" target="_blank" rel="noopener">
        <span>{{ item.title }}</span>
      </a>
    }
  </div>
  <p>Arrows in text are just text: a => b</p>
</main>
<router-outlet />
`,
  'src/app/app.css': '',
  'src/app/app.spec.ts': `import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
  });
  it('should create the app', () => {
    expect(TestBed.createComponent(App).componentInstance).toBeTruthy();
  });
});
`,
};

function fsOf(files: Record<string, string>): VirtualFileSystem {
  const fs = new VirtualFileSystem();
  fs.writeTree(files);
  return fs;
}

const ng = (overrides: Record<string, string>) => angularDiagnostics(fsOf({ ...NG_NEW, ...overrides }));

describe('angularDiagnostics', () => {
  it('reports nothing for a clean `ng new` app', () => {
    expect(angularDiagnostics(fsOf(NG_NEW))).toEqual([]);
  });

  it('reports nothing for a project that does not depend on @angular/core', () => {
    const files = { ...NG_NEW, 'package.json': JSON.stringify({ dependencies: { react: '^18.3.1' } }), 'src/app/app.html': '{{ items.map(x => x) }}' };
    expect(angularDiagnostics(fsOf(files))).toEqual([]);
  });

  it('flags an arrow function in an inline template, at the arrow', () => {
    const app = `import { Component } from '@angular/core';

@Component({
  selector: 'app-root',
  // template: '<p>{{ items.map(x => x) }}</p>' — a commented-out template is not flagged
  template: \`
    <p>{{ total(items.map(i => i.price)) }}</p>
    <button (click)="items.forEach(i => remove(i))">Clear</button>
  \`,
})
export class App {
  items = [{ price: 1 }];
  total = (prices: number[]) => prices.reduce((a, b) => a + b, 0);
  remove(_: unknown) {}
}
`;
    const found = ng({ 'src/app/app.ts': app, 'src/app/app.html': '' });
    expect(found).toEqual([
      expect.objectContaining({ file: 'src/app/app.ts', line: 7, column: '    <p>{{ total(items.map(i '.length + 1, code: ANGULAR_DIAGNOSTIC.templateArrow, category: 'error', source: 'angular' }),
      expect.objectContaining({ file: 'src/app/app.ts', line: 8, column: '    <button (click)="items.forEach(i '.length + 1, code: ANGULAR_DIAGNOSTIC.templateArrow }),
    ]);
    expect(formatDiagnostic(found[0]!)).toMatch(/^src\/app\/app\.ts\(7,29\): error BFWC-NG001: Arrow functions are not supported/);
  });

  it('flags arrows in templateUrl bindings, structural directives and control-flow blocks, not in text or strings', () => {
    const html = [
      '<p>{{ items.filter(i => i.done).length }}</p>', // 1
      '<app-list [sort]="(a, b) => a.rank - b.rank"></app-list>', // 2
      '<input [(ngModel)]="value" (input)="onInput($event)" title="a => b">', // 3: none
      '<li *ngFor="let i of items.filter(x => x.ok)">{{ i }}</li>', // 4
      '@if (items.some(i => i.done)) { <span>done</span> }', // 5
      "<p>{{ 'quoted => arrow' }}</p>", // 6: none
    ].join('\n');
    const found = ng({ 'src/app/app.html': html });
    expect(found.map((d) => [d.file, d.line])).toEqual([
      ['src/app/app.html', 1],
      ['src/app/app.html', 2],
      ['src/app/app.html', 4],
      ['src/app/app.html', 5],
    ]);
    expect(found[0]!.column).toBe('<p>{{ items.filter(i '.length + 1);
  });

  it('flags @angular/ssr and @angular/platform-server imports from browser code, not from server entry points', () => {
    const found = ng({
      'src/app/app.config.ts': `import { provideServerRendering } from '@angular/ssr';\nimport { renderModule } from "@angular/platform-server";\n// import '@angular/ssr/node';\n`,
      'src/main.ts': `const ssr = await import('@angular/ssr/node');\n`,
      'src/server.ts': `import { AngularNodeAppEngine } from '@angular/ssr/node';\n`,
      'src/app/app.config.server.ts': `import { provideServerRendering } from '@angular/ssr';\n`,
    });
    expect(found.map((d) => [d.file, d.line, d.column, d.code, d.category])).toEqual([
      ['src/app/app.config.ts', 1, 41, ANGULAR_DIAGNOSTIC.serverImport, 'error'],
      ['src/app/app.config.ts', 2, 31, ANGULAR_DIAGNOSTIC.serverImport, 'error'],
      ['src/main.ts', 1, 27, ANGULAR_DIAGNOSTIC.serverImport, 'error'],
    ]);
    expect(found[0]!.message).toContain("'@angular/ssr'");
  });

  it('warns about angular.json builders this runtime does not replace', () => {
    const config = JSON.parse(ANGULAR_JSON);
    config.projects['ng-app'].architect.deploy = { builder: '@angular/fire:deploy' };
    config.projects['ng-app'].architect.lint = { builder: '@angular-eslint/builder:lint' };
    const found = ng({ 'angular.json': JSON.stringify(config, null, 2) });
    expect(found.map((d) => [d.file, d.code, d.category])).toEqual([
      ['angular.json', ANGULAR_DIAGNOSTIC.unsupportedBuilder, 'warning'],
      ['angular.json', ANGULAR_DIAGNOSTIC.unsupportedBuilder, 'warning'],
    ]);
    expect(found[0]!.message).toContain('`ng deploy`');
    expect(found[0]!.line).toBe(JSON.stringify(config, null, 2).split('\n').findIndex((l) => l.includes('@angular/fire:deploy')) + 1);
  });

  it('warns that SSR, prerender, app-shell and server output options are ignored', () => {
    const config = JSON.parse(ANGULAR_JSON);
    Object.assign(config.projects['ng-app'].architect.build.options, { server: 'src/main.server.ts', outputMode: 'server', ssr: { entry: 'src/server.ts' } });
    config.projects['ng-app'].architect.build.configurations.production.prerender = true;
    config.projects['ng-app'].architect.build.configurations.production.appShell = true;
    const found = ng({ 'angular.json': JSON.stringify(config, null, 2) });
    expect(found).toHaveLength(5);
    expect(found.every((d) => d.code === ANGULAR_DIAGNOSTIC.serverBuildOption && d.category === 'warning')).toBe(true);
    expect(found.map((d) => d.message.split(' ')[0]).sort()).toEqual(['`appShell`', '`outputMode:', '`prerender`', '`server`', '`ssr`']);
  });

  it('warns about localize and i18n configuration', () => {
    const config = JSON.parse(ANGULAR_JSON);
    config.projects['ng-app'].i18n = { sourceLocale: 'en-US', locales: { fr: 'src/locale/messages.fr.xlf' } };
    config.projects['ng-app'].architect.build.options.localize = true;
    const found = ng({ 'angular.json': JSON.stringify(config, null, 2) });
    expect(found.map((d) => [d.code, d.category])).toEqual([
      [ANGULAR_DIAGNOSTIC.localize, 'warning'],
      [ANGULAR_DIAGNOSTIC.localize, 'warning'],
    ]);
  });
});

describe('typecheckProject with Angular diagnostics', () => {
  // Libs from the installed typescript package; every package is untyped (checked as any).
  const LIB_DIR = dirname(createRequire(import.meta.url).resolve('typescript'));
  const LIB_BASE = libBaseUrlFor(ts.version);
  const fetchLibs: FetchLike = async (url) => {
    let body = '';
    let ok = false;
    if (url.startsWith(`${LIB_BASE}/`)) {
      try {
        body = readFileSync(join(LIB_DIR, url.slice(LIB_BASE.length + 1)), 'utf8');
        ok = true;
      } catch {
        ok = false;
      }
    }
    return { ok, url, headers: { get: () => null }, text: async () => body };
  };

  it('merges the Angular scan into the sorted diagnostics', async () => {
    const result = await typecheckProject(
      ts,
      { ...NG_NEW, 'src/app/app.html': '<p>{{ items.map(x => x) }}</p>', 'src/main.ts': "import '@angular/platform-server';\nconst n: number = 'x';\n" },
      { fetch: fetchLibs },
    );
    const summary = result.diagnostics.map((d) => [d.file, d.line, d.source === 'angular' ? `NG${d.code}` : `TS${d.code}`]);
    expect(summary).toContainEqual(['src/app/app.html', 1, `NG${ANGULAR_DIAGNOSTIC.templateArrow}`]);
    expect(summary).toContainEqual(['src/main.ts', 1, `NG${ANGULAR_DIAGNOSTIC.serverImport}`]);
    expect(summary).toContainEqual(['src/main.ts', 2, 'TS2322']);
    const files = result.diagnostics.map((d) => d.file ?? '');
    expect(files).toEqual([...files].sort((a, b) => a.localeCompare(b)));
  });
});

describe('angularDiagnostics (review fixes)', () => {
  it('reads an angular.json with comments and trailing commas', () => {
    const commented = ANGULAR_JSON.replace('"version": 1,', '// ng new wrote this\n  "version": 1,').replace(/("builder": "@angular\/build:application",)/, '$1 /* the app build */')
      .replace('"projects": {', '"projects": {\n    "lib": { "projectType": "library", "architect": { "deploy": { "builder": "@angular/fire:deploy" }, }, },');
    const found = ng({ 'angular.json': commented });
    expect(found.map((d) => [d.file, d.code])).toEqual([['angular.json', ANGULAR_DIAGNOSTIC.unsupportedBuilder]]);
  });

  it('flags arrows in @let declarations', () => {
    const found = ng({ 'src/app/app.html': "@let names = items.map(i => i.name);\n@let label = 'a => b';\n<p>{{ names }}</p>" });
    expect(found.map((d) => [d.file, d.line, d.column])).toEqual([['src/app/app.html', 1, '@let names = items.map(i '.length + 1]]);
  });

  it('reads templateUrl from the masked source: comments and regex literals do not confuse it', () => {
    const app = `import { Component } from '@angular/core';\nconst re = /templateUrl: 'nope.html'/;\n// templateUrl: './commented.html'\n@Component({ selector: 'app-root', templateUrl: './app.html' })\nexport class App {}\n`;
    const found = ng({ 'src/app/app.ts': app, 'src/app/app.html': '{{ a.map(x => x) }}', 'src/app/nope.html': '{{ b.map(y => y) }}', 'src/app/commented.html': '{{ c.map(z => z) }}' });
    expect(found.map((d) => d.file)).toEqual(['src/app/app.html']);
  });
});
