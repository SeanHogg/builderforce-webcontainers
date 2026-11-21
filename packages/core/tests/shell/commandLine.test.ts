import { describe, expect, it } from 'vitest';
import { shellCommandWords, splitCommandLine } from '../../src/shell/commandLine.js';

const argv = (line: string) => {
  const result = splitCommandLine(line);
  return result.kind === 'argv' ? result.argv : result.kind;
};

describe('splitCommandLine', () => {
  it('regression: splits plain words, keeping option values, scoped packages and the -- separator', () => {
    expect(argv('node server.js --port=3000')).toEqual(['node', 'server.js', '--port=3000']);
    expect(argv('npx @scope/pkg serve')).toEqual(['npx', '@scope/pkg', 'serve']);
    expect(argv('npm run dev -- --host')).toEqual(['npm', 'run', 'dev', '--', '--host']);
  });

  it('regression: a quoted glob is a literal word; an unquoted one needs the shell', () => {
    expect(argv("node lint.js '*.js'")).toEqual(['node', 'lint.js', '*.js']);
    expect(argv('node lint.js "src/[ab].js"')).toEqual(['node', 'lint.js', 'src/[ab].js']);
    expect(argv('node lint.js *.js')).toBe('shell');
    expect(argv('node lint.js file?.js')).toBe('shell');
  });

  it('regression: an escaped glob character, a URL and a bracketed IPv6 host are literal', () => {
    expect(argv('node echo.js foo\\*')).toEqual(['node', 'echo.js', 'foo*']);
    expect(argv('node fetch.js http://x/?a=1&')).toBe('shell');
    expect(argv('node fetch.js http://x/?a=1')).toEqual(['node', 'fetch.js', 'http://x/?a=1']);
    expect(argv('uvicorn main:app --host [::] --port 8000')).toEqual(['uvicorn', 'main:app', '--host', '[::]', '--port', '8000']);
    expect(argv('node s.js --bind [::1]:8000')).toEqual(['node', 's.js', '--bind', '[::1]:8000']);
  });

  it('regression: a tilde expands only at the start of a word', () => {
    expect(argv('node a~b')).toEqual(['node', 'a~b']);
    expect(argv('node ~/x.js')).toBe('shell');
  });

  it('regression: a whitespace-only line is invalid, an unterminated quote too', () => {
    expect(splitCommandLine('   \t ')).toEqual({ kind: 'invalid', reason: 'empty command' });
    expect(splitCommandLine('node "x')).toMatchObject({ kind: 'invalid' });
  });

  it('regression: a # comment is dropped; a # inside a word is text', () => {
    expect(argv('node server.js # dev only')).toEqual(['node', 'server.js']);
    expect(argv('node a#b')).toEqual(['node', 'a#b']);
  });

  it('regression: operators, assignments and expansions need the shell', () => {
    for (const line of ['npm i && npm start', 'a | b', 'a; b', 'node s.js > out.log', 'FOO=1 node s.js', 'node $ENTRY', 'node $(cat entry)']) {
      expect(splitCommandLine(line)).toEqual({ kind: 'shell', line, strayBackslash: false });
    }
  });

  it('regression: flags an unquoted backslash before an ordinary character, never a quoted or meaningful one', () => {
    expect(splitCommandLine('node .\\server.js')).toMatchObject({ kind: 'argv', argv: ['node', '.server.js'], strayBackslash: true });
    expect(splitCommandLine('node C:\\app\\x.js')).toMatchObject({ strayBackslash: true });
    expect(splitCommandLine("node 'C:\\app\\x.js'")).toMatchObject({ kind: 'argv', argv: ['node', 'C:\\app\\x.js'], strayBackslash: false });
    expect(splitCommandLine('node my\\ file.js')).toMatchObject({ kind: 'argv', argv: ['node', 'my file.js'], strayBackslash: false });
  });
});

describe('shellCommandWords', () => {
  it('regression: the words of each simple command, after assignments and without redirect targets', () => {
    expect(shellCommandWords('cd infra && docker compose up')).toEqual([
      ['cd', 'infra'],
      ['docker', 'compose', 'up'],
    ]);
    expect(shellCommandWords('FOO=1 BAR=2 wrangler dev > log.txt 2>&1 | tee x')).toEqual([
      ['wrangler', 'dev'],
      ['tee', 'x'],
    ]);
    expect(shellCommandWords('node "x')).toEqual([]);
  });

  it('regression: includes the commands of $(…) and backtick substitutions', () => {
    expect(shellCommandWords('echo $(docker compose up)')).toEqual([
      ['docker', 'compose', 'up'],
      ['echo', '$(docker compose up)'],
    ]);
    expect(shellCommandWords('X=`wrangler whoami` node s.js')).toEqual([['wrangler', 'whoami'], ['node', 's.js']]);
    expect(shellCommandWords('echo "${A:-$(docker ps)}"')).toContainEqual(['docker', 'ps']);
  });
});
