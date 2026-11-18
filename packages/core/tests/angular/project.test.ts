import { describe, expect, it } from 'vitest';
import { readAngularWorkspace } from '../../src/angular/workspace.js';
import { angularCompilerFor } from '../../src/angular/compiler.js';
import { componentKindFor } from '../../src/components.js';
import { detectProject } from '../../src/detectProject.js';
import { readProjectConfig } from '../../src/projectConfig.js';
import { applyPinGroups } from '../../src/pinGroups.js';
import { project } from '../helpers.js';

const ANGULAR = { '@angular/core': '^20.0.0' };

describe('componentKindFor', () => {
  it('picks Vue/Svelte by extension and Angular for an Angular project\'s TypeScript', () => {
    expect(componentKindFor('/src/App.vue', {})).toBe('.vue');
    expect(componentKindFor('/src/App.svelte', {})).toBe('.svelte');
    expect(componentKindFor('/src/app/app.ts', ANGULAR)).toBe('angular');
    expect(componentKindFor('/src/app/x.mts', ANGULAR)).toBe('angular');
    expect(componentKindFor('/src/app/app.ts', {})).toBeUndefined();
    expect(componentKindFor('/src/app/x.d.ts', ANGULAR)).toBeUndefined();
    expect(componentKindFor('/node_modules/lib/index.ts', ANGULAR)).toBeUndefined();
    expect(componentKindFor('/src/app/x.tsx', ANGULAR)).toBeUndefined();
    expect(componentKindFor('/src/app/x.js', ANGULAR)).toBeUndefined();
  });
});

describe('readAngularWorkspace', () => {
  it('reads the 17 application-builder shape (string assets, index, scss styles)', () => {
    const ws = readAngularWorkspace(JSON.stringify({
      projects: {
        lib: { projectType: 'library' },
        shop: {
          projectType: 'application',
          sourceRoot: 'src',
          architect: {
            build: {
              builder: '@angular-devkit/build-angular:application',
              options: {
                outputPath: 'dist/shop', index: 'src/index.html', browser: 'src/main.ts', polyfills: ['zone.js'],
                assets: ['src/favicon.ico', 'src/assets'], styles: ['src/styles.scss'], scripts: [], aot: true,
                optimization: true, outputHashing: 'all', budgets: [], ssr: { entry: 'server.ts' }, prerender: true, localize: true,
              },
            },
          },
        },
      },
    }));
    expect(ws).toEqual({
      project: 'shop', sourceRoot: 'src', main: 'src/main.ts', index: 'src/index.html',
      styles: ['src/styles.scss'], assets: [{ input: 'src/favicon.ico' }, { input: 'src/assets' }], polyfills: ['zone.js'],
    });
  });

  it('reads the browser-builder `main`, object styles/index, glob assets, a polyfills string and defaultProject', () => {
    const ws = readAngularWorkspace(`{
      // comments are fine
      "defaultProject": "b",
      "projects": {
        "a": { "projectType": "application", "architect": { "build": { "options": { "browser": "x.ts" } } } },
        "b": { "projectType": "application", "architect": { "build": { "options": {
          "main": "src/main.ts", "polyfills": "src/polyfills.ts",
          "index": { "input": "src/index.prod.html", "output": "index.html" },
          "styles": [{ "input": "src/theme.css", "bundleName": "theme" }, { "input": "src/lazy.css", "inject": false }],
          "assets": [{ "glob": "**/*", "input": "public" }, { "glob": "**/*", "input": "src/static", "output": "/static/" }],
        } } } },
      },
    }`);
    expect(ws).toMatchObject({
      project: 'b', main: 'src/main.ts', index: 'src/index.prod.html', polyfills: ['src/polyfills.ts'], styles: ['src/theme.css'],
      assets: [{ glob: '**/*', input: 'public', output: undefined }, { glob: '**/*', input: 'src/static', output: '/static/' }],
    });
  });

  it('is undefined for invalid JSON or a workspace with no projects', () => {
    expect(readAngularWorkspace('{ nope')).toBeUndefined();
    expect(readAngularWorkspace('{"projects":{}}')).toBeUndefined();
  });
});

describe('detectProject on Angular', () => {
  const angularJson = (options: object) => JSON.stringify({ projects: { app: { projectType: 'application', sourceRoot: 'src', architect: { build: { options } } } } });

  it('builds the profile from angular.json: page, entry, static folders and preludes in order', () => {
    const fs = project({
      'package.json': JSON.stringify({ dependencies: { ...ANGULAR, 'zone.js': '~0.15.0' } }),
      'angular.json': angularJson({
        browser: 'src/main.ts', index: 'src/index.html', polyfills: ['zone.js', 'src/polyfills.ts'],
        styles: ['src/styles.scss'], assets: ['src/favicon.ico', 'src/assets', { glob: '**/*', input: 'public' }, { glob: '**/*', input: 'extra', output: 'x' }],
      }),
      'src/index.html': '<app-root></app-root>',
      'src/main.ts': '',
      'src/polyfills.ts': '',
    });
    expect(detectProject(fs)).toEqual({
      supported: true, kind: 'angular', framework: 'angular', htmlPath: '/src/index.html', entry: '/src/main.ts',
      staticDirs: [
        { from: '/src/favicon.ico', to: '/favicon.ico' },
        { from: '/src/assets', to: '/assets' },
        { from: '/public', to: '/' },
        { from: '/extra', to: '/x' },
      ],
      preludes: ['zone.js', '/src/polyfills.ts', '/src/styles.scss', '@angular/compiler'],
    });
  });

  it('defaults without angular.json: src/index.html + src/main.ts, zone.js only when declared, public/', () => {
    const files = { 'src/index.html': '', 'src/main.ts': '' };
    const zoneless = detectProject(project({ ...files, 'package.json': JSON.stringify({ dependencies: ANGULAR }) }));
    expect(zoneless).toMatchObject({ kind: 'angular', htmlPath: '/src/index.html', entry: '/src/main.ts', staticDirs: [{ from: '/public', to: '/' }], preludes: ['@angular/compiler'] });
    const zoned = detectProject(project({ ...files, 'package.json': JSON.stringify({ dependencies: { ...ANGULAR, 'zone.js': '~0.15.0' } }) }));
    expect(zoned.preludes).toEqual(['zone.js', '@angular/compiler']);
  });

  it('keeps public/ for the other project kinds', () => {
    expect(detectProject(project({ 'index.html': '', 'package.json': '{}' })).staticDirs).toEqual([{ from: '/public', to: '/' }]);
  });
});

describe('PIN_GROUPS', () => {
  it('pins lockstep @angular packages to core, adds the common ones, and defaults rxjs/tslib per major', () => {
    expect(applyPinGroups({ '@angular/core': '^19.2.0', '@angular/forms': '^19.1.0', '@angular/cdk': '^19.1.0', '@angular/cli': '^19.2.3', 'zone.js': '~0.15.0', rxjs: '~7.5.0' })).toEqual({
      '@angular/core': '^19.2.0',
      '@angular/forms': '^19.2.0',
      '@angular/cdk': '^19.1.0',
      '@angular/cli': '^19.2.3',
      '@angular/common': '^19.2.0',
      '@angular/compiler': '^19.2.0',
      '@angular/platform-browser': '^19.2.0',
      '@angular/router': '^19.2.0',
      '@angular/animations': '^19.2.0',
      'zone.js': '~0.15.0',
      rxjs: '~7.5.0',
      tslib: '^2.3.0',
    });
  });

  it('leaves other projects, and non-registry Angular ranges, alone', () => {
    expect(applyPinGroups({ react: '^18.3.1' })).toEqual({ react: '^18.3.1' });
    expect(applyPinGroups({ '@angular/core': 'workspace:*' })).toEqual({ '@angular/core': 'workspace:*' });
  });

  it('feeds ProjectConfig.dependencies, with the tsconfig options read alongside', () => {
    const config = readProjectConfig(project({
      'package.json': JSON.stringify({ dependencies: ANGULAR }),
      'tsconfig.json': '/* ng new */ { "compilerOptions": { "target": "ES2022", "experimentalDecorators": true, "useDefineForClassFields": false } }',
    }));
    expect(config.dependencies['@angular/compiler']).toBe('^20.0.0');
    expect(config.typescript).toEqual({ target: 'es2022', experimentalDecorators: true, useDefineForClassFields: false });
  });
});

describe('angularCompilerFor', () => {
  it('refuses Angular majors outside 17-20', () => {
    expect(() => angularCompilerFor({ '@angular/core': '^16.2.0' })).toThrow(/Angular 16 is not supported.*17–20/);
    expect(() => angularCompilerFor({ '@angular/core': '~17.3.0' })).not.toThrow();
    expect(() => angularCompilerFor({ '@angular/core': 'workspace:*' })).not.toThrow();
  });
});
