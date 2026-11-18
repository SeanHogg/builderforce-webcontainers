import { describe, expect, it } from 'vitest';
import { inlineResources } from '../../src/angular/resources.js';
import { componentResources } from '../../src/componentResources.js';
import { createStyleImportHost } from '../../src/styles/imports.js';
import { project, styles } from '../helpers.js';

const PATH = '/src/app/app.component.ts';

function request(files: Record<string, string>, withStyles = true) {
  const fs = project(files);
  const tracked: string[] = [];
  const stylesheet = withStyles ? { fs, dependencies: {}, styles, imports: createStyleImportHost({ fs, dependencies: {} }) } : undefined;
  return { tracked, request: { path: PATH, ...componentResources({ fs, path: PATH, styles: stylesheet, track: (p) => tracked.push(p) }) } };
}

describe('inlineResources', () => {
  it('inlines templateUrl and styleUrl, and tracks the files read', async () => {
    const { request: req, tracked } = request({ 'src/app/app.component.html': '<h1>{{ title }}</h1>', 'src/app/app.component.css': 'h1 { color: red; }' });
    const out = await inlineResources(
      `@Component({\n  selector: 'app-root',\n  templateUrl: './app.component.html',\n  styleUrl: './app.component.css'\n})\nexport class AppComponent {}`,
      req,
    );
    expect(out).toContain('template: "<h1>{{ title }}</h1>"');
    expect(out).toContain('styles: ["h1 { color: red; }"]');
    expect(out).not.toContain('templateUrl');
    expect(out).not.toContain('styleUrl');
    expect(out.split('\n')).toHaveLength(6); // line numbers kept
    expect(tracked).toEqual(expect.arrayContaining(['/src/app/app.component.html', '/src/app/app.component.css']));
  });

  it('compiles styleUrls (.scss through the project compiler) and merges them after inline styles', async () => {
    const { request: req } = request({ 'src/app/a.scss': '$c: blue; p { color: $c; }', 'src/app/b.css': 'i { x: 1 }' });
    const out = await inlineResources(
      `@Component({ selector: 'x', styles: ['b { y: 2 }'], styleUrls: ['./a.scss', "./b.css"], template: '' }) class X {}`,
      req,
    );
    expect(out).toMatch(/styles: \['b \{ y: 2 \}', "p \{\\n  color: blue;\\n\}", "i \{ x: 1 \}"\]/);
    expect(out.match(/styles:/g)).toHaveLength(1);
    expect(out).toContain("template: ''");
  });

  it('accepts a single inline styles string beside styleUrl, and a trailing property removal', async () => {
    const { request: req } = request({ 'src/app/a.css': 'a{}' });
    const out = await inlineResources(`@Component({ template: '', styleUrl: './a.css', styles: \`p{}\` }) class X {}`, req);
    expect(out).toContain('styles: [`p{}`, "a{}"]');
    expect(() => new Function(out.replace('@Component', 'void ').replace('class X {}', ''))).not.toThrow();
  });

  it('names the component and the missing file', async () => {
    const { request: req } = request({});
    await expect(inlineResources(`@Component({ templateUrl: './x.html' }) class X {}`, req)).rejects.toThrow(
      "/src/app/app.component.ts: templateUrl './x.html' not found",
    );
  });

  it('leaves backticks and braces in inline templates untouched', async () => {
    const { request: req } = request({ 'src/app/a.css': 'a{}' });
    const source = [
      '// templateUrl in a comment: @Component({ templateUrl: "nope" })',
      '@Component({',
      '  template: `<p>{{ items.length }} @if (x) { <b>${"{"}</b> } \\` templateUrl: "no"</p>`,',
      "  styleUrl: './a.css',",
      '})',
      'class X { s = "templateUrl: \'./nope\'"; }',
    ].join('\n');
    const out = await inlineResources(source, req);
    expect(out).toContain('template: `<p>{{ items.length }} @if (x) { <b>${"{"}</b> } \\` templateUrl: "no"</p>`');
    expect(out).toContain('// templateUrl in a comment: @Component({ templateUrl: "nope" })');
    expect(out).toContain('s = "templateUrl: \'./nope\'"');
    expect(out).toContain('styles: ["a{}"]');
  });

  it('refuses a preprocessed stylesheet when no stylesheet compilers are configured', async () => {
    const { request: req } = request({ 'src/app/a.scss': 'a{}' }, false);
    await expect(inlineResources(`@Component({ styleUrl: './a.scss' }) class X {}`, req)).rejects.toThrow(/needs a CSS preprocessor/);
  });
});
