import { describe, expect, it } from 'vitest';
import { parse, ShellSyntaxError } from '../../src/shell/parse.js';
import { translate } from '../../src/shell/packageManagers.js';
import { exec, kernelWith } from '../node/helpers.js';
import type { CommandContext } from '../../src/shell/context.js';
import type { Kernel } from '../../src/system/kernel.js';

const sh = (kernel: Kernel, script: string, input?: string) => exec(kernel, 'bfsh', ['-c', script], { input });

describe('shell control flow', () => {
  it('runs if / elif / else with test and [', async () => {
    const kernel = kernelWith({ 'a.txt': 'x' });
    const { output } = await sh(kernel, `
      if [ -f a.txt ]; then echo file; fi
      if test -d a.txt; then echo dir; elif [ "$HOME" = /home/user ]; then echo home; else echo other; fi
      if [ 3 -gt 5 ]; then echo big; else echo small; fi
      [ -z "" ] && echo empty
    `);
    expect(output).toBe('file\nhome\nsmall\nempty\n');
  });

  it('loops with for, while and until, honouring break and continue', async () => {
    const { output } = await sh(kernelWith(), `
      for x in a b c; do if [ $x = b ]; then continue; fi; echo $x; done
      i=; while true; do i="\${i}x"; echo w$i; if [ "$i" = xx ]; then break; fi; done
      n=; until [ "$n" = xxx ]; do n="\${n}x"; done; echo $n
      for outer in 1 2; do for inner in 1 2; do echo $outer$inner; break 2; done; done
    `);
    expect(output.split('\n').filter(Boolean)).toEqual(['a', 'c', 'wx', 'wxx', 'xxx', '11']);
  });

  it('matches case patterns', async () => {
    const { output } = await sh(kernelWith(), `
      for f in app.ts style.css README; do
        case $f in
          *.ts|*.tsx) echo "$f: code";;
          *.css) echo "$f: style";;
          *) echo "$f: other";;
        esac
      done
    `);
    expect(output).toBe('app.ts: code\nstyle.css: style\nREADME: other\n');
  });

  it('defines functions with arguments, local variables and return', async () => {
    const { output, code } = await sh(kernelWith(), `
      greet() { local who=$1; echo "hi $who ($#)"; return 3; }
      who=outer
      greet world extra; echo "status $? who=$who"
      function twice { greet "$@"; greet "$@"; }
      twice x
    `);
    expect(output).toBe('hi world (2)\nstatus 3 who=outer\nhi x (1)\nhi x (1)\n');
    expect(code).toBe(3);
  });

  it('runs groups, subshells and here-documents', async () => {
    const kernel = kernelWith();
    const { output } = await sh(kernel, `
      x=1; ( x=2; echo sub $x ); echo main $x
      { echo one; echo two; } > out.txt; cat out.txt
      name=World
      cat <<EOF
Hello $name
EOF
      cat <<'RAW'
keep $name
RAW
      while read line; do echo "[$line]"; done <<END
a
b
END
    `);
    expect(output).toBe('sub 2\nmain 1\none\ntwo\nHello World\nkeep $name\n[a]\n[b]\n');
  });

  it('reads stdin line by line and waits for background jobs', async () => {
    const { output } = await sh(kernelWith(), 'read first rest; echo "$first|$rest"; read again; echo "$again"; (echo bg) & wait; echo after', 'one two three\nsecond\n');
    expect(output).toBe('one|two three\nsecond\nbg\nafter\n');
  });

  it('asks for more input on an unfinished block or here-document', () => {
    for (const source of ['if true; then', 'for x in a; do echo', 'f() {', 'case x in', 'cat <<EOF\nline']) {
      expect(() => parse(source)).toThrow(ShellSyntaxError);
      try {
        parse(source);
      } catch (error) {
        expect((error as ShellSyntaxError).incomplete).toBe(true);
      }
    }
    expect(() => parse('fi')).toThrow(/unexpected token/);
  });

  it('keeps reserved words as plain arguments outside command position', async () => {
    expect((await sh(kernelWith(), 'echo if then done fi')).output).toBe('if then done fi\n');
  });
});

describe('pnpm and yarn', () => {
  const ctx = (scripts: Record<string, string> = {}) => {
    const kernel = kernelWith({ 'package.json': JSON.stringify({ scripts }) });
    return { fs: kernel.fs, cwd: '/', env: {} } as unknown as CommandContext;
  };

  it('translates to npm and npx', () => {
    const c = ctx({ dev: 'vite' });
    expect(translate('pnpm', [], c)).toEqual({ tool: 'npm', args: ['install'] });
    expect(translate('pnpm', ['add', '-D', 'zod'], c)).toEqual({ tool: 'npm', args: ['install', '--save-dev', 'zod'] });
    expect(translate('yarn', ['add', 'react', '--dev'], c)).toEqual({ tool: 'npm', args: ['install', 'react', '--save-dev'] });
    expect(translate('yarn', ['install', '--frozen-lockfile'], c)).toEqual({ tool: 'npm', args: ['install'] });
    expect(translate('pnpm', ['remove', 'zod'], c)).toEqual({ tool: 'npm', args: ['uninstall', 'zod'] });
    expect(translate('yarn', ['dev', '--host'], c)).toEqual({ tool: 'npm', args: ['run', 'dev', '--', '--host'] });
    expect(translate('pnpm', ['dlx', 'create-vite'], c)).toEqual({ tool: 'npx', args: ['create-vite'] });
    expect(translate('yarn', ['--version'], c)).toEqual({ version: '1.22.22' });
    expect(translate('pnpm', ['nope'], c)).toEqual({ error: 'pnpm: no script or command named "nope"' });
  });

  it('runs a package.json script through yarn', async () => {
    const kernel = kernelWith({ 'package.json': JSON.stringify({ name: 'app', scripts: { hello: 'echo hello from script' } }) });
    const { output, code } = await exec(kernel, 'yarn', ['hello']);
    expect(code).toBe(0);
    expect(output).toContain('hello from script');
  });
});
