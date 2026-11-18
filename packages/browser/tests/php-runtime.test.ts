/**
 * PHP processes on a real php-wasm (the pinned `@php-wasm/node` package): a
 * script's output and exit code, the project's files both ways, PHP's sockets
 * on the runtime's virtual TCP, and `php -S` serving requests — a front
 * controller with headers, cookies, a form POST and a JSON body, static files,
 * a router's `return false`, PATH_INFO, 404s and a port conflict.
 */
import { describe, expect, it } from 'vitest';
import { collect, phpHost, readAll, request, until } from './php-helpers.js';

const SLOW = 120_000;

describe('PHP processes', () => {
  it('runs a script with its arguments, environment, output and exit code', { timeout: SLOW }, async () => {
    const { processes } = phpHost({ 'bin/app.php': '<?php\necho "hello " . json_encode(array_slice($argv, 1)) . " " . getenv("GREETING") . " " . getcwd() . "\\n";\nfwrite(STDERR, "warn\\n");\nexit(3);\n' }, { GREETING: 'hi' });
    const proc = processes.run('php', ['bin/app.php', 'x', 'y']);
    const output = await readAll(proc.combinedOutput);
    expect(await proc.wait()).toBe(3);
    expect(output).toContain('hello ["x","y"] hi /project\n');
    expect(output).toContain('warn\n');
    processes.dispose();
  });

  it('runs -r code, reports a fatal error with exit 255, and a missing script with exit 1', { timeout: SLOW }, async () => {
    const { processes } = phpHost();
    const ok = processes.run('php', ['-r', 'echo PHP_MAJOR_VERSION >= 8 ? "modern" : "old", PHP_EOL;']);
    expect(await readAll(ok.combinedOutput)).toContain('modern\n');
    expect(await ok.wait()).toBe(0);
    const fatal = processes.run('php', ['-r', 'throw new RuntimeException("boom");']);
    expect(await readAll(fatal.combinedOutput)).toContain('Uncaught RuntimeException: boom');
    expect(await fatal.wait()).toBe(255);
    const missing = processes.run('php', ['nope.php']);
    expect(await readAll(missing.combinedOutput)).toContain('Could not open input file: nope.php');
    expect(await missing.wait()).toBe(1);
    processes.dispose();
  });

  it('declines interactive PHP with a reason', { timeout: SLOW }, async () => {
    const { processes } = phpHost();
    const proc = processes.run('php', ['-a']);
    expect(await readAll(proc.combinedOutput)).toContain('needs a terminal');
    expect(await proc.wait()).toBe(1);
    processes.dispose();
  });

  it('syncs files both ways: PHP sees the project, and its writes, renames and deletes reach the page', { timeout: SLOW }, async () => {
    const { fs, processes } = phpHost({
      'data/in.txt': 'from the page',
      'old.txt': 'to delete',
      'job.php': `<?php
echo file_get_contents(__DIR__ . '/data/in.txt'), "\\n";
mkdir(__DIR__ . '/out/deep', 0777, true);
file_put_contents(__DIR__ . '/out/deep/result.json', json_encode(['ok' => true]));
file_put_contents(__DIR__ . '/tmp.txt', 'moving');
rename(__DIR__ . '/tmp.txt', __DIR__ . '/moved.txt');
unlink(__DIR__ . '/old.txt');
$log = fopen(__DIR__ . '/log.txt', 'a');
fwrite($log, "line\\n");
fclose($log);
`,
    });
    const proc = processes.run('php', ['job.php']);
    expect(await readAll(proc.combinedOutput)).toContain('from the page\n');
    expect(await proc.wait()).toBe(0);
    await until(() => fs.readText('/log.txt') === 'line\n');
    expect(JSON.parse(fs.readText('/out/deep/result.json')!)).toEqual({ ok: true });
    expect(fs.readText('/moved.txt')).toBe('moving');
    expect(fs.exists('/tmp.txt')).toBe(false);
    expect(fs.exists('/old.txt')).toBe(false);
    processes.dispose();
  });

  it("dials the runtime's virtual TCP from stream_socket_client, and is refused where nothing listens", { timeout: SLOW }, async () => {
    const { processes } = phpHost({
      'client.php': `<?php
$s = stream_socket_client('tcp://localhost:7070', $errno, $errstr, 5);
fwrite($s, "ping\\n");
echo 'got ', fgets($s);
fclose($s);
// php-wasm reports the connect as made; nothing listening ends the stream before any byte.
$refused = @stream_socket_client('tcp://localhost:7071', $errno, $errstr, 2);
echo $refused === false || fgets($refused) === false ? "refused\\n" : "connected?\\n";
`,
      'echo.js': `const net = require('net');
net.createServer((socket) => socket.on('data', (data) => socket.write(String(data).toUpperCase()))).listen(7070, () => console.log('echo ready'));
`,
    });
    const echo = processes.run('node', ['echo.js']);
    const log = collect(echo.combinedOutput);
    await log.until('echo ready');
    const proc = processes.run('php', ['client.php']);
    const output = await readAll(proc.combinedOutput);
    expect(output).toContain('got PING\n');
    expect(output).toContain('refused\n');
    expect(await proc.wait()).toBe(0);
    echo.kill();
    processes.dispose();
  });
});

const FRONT_CONTROLLER = `<?php
// A Slim-style front controller: static files fall through, everything else is routed here.
if (PHP_SAPI === 'cli-server' && is_file(__DIR__ . parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH))) {
    return false;
}
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/echo') {
    setcookie('seen', 'yes', ['path' => '/']);
    setcookie('theme', 'dark');
    header('Content-Type: application/json');
    header('X-Served-By: php');
    http_response_code(201);
    echo json_encode([
        'method' => $_SERVER['REQUEST_METHOD'],
        'query' => $_GET,
        'form' => $_POST,
        'cookies' => $_COOKIE,
        'header' => $_SERVER['HTTP_X_CUSTOM'] ?? null,
        'raw' => file_get_contents('php://input'),
        'script' => $_SERVER['SCRIPT_NAME'],
        'sapi' => PHP_SAPI,
    ]);
    return;
}
if ($path === '/json' && $_SERVER['REQUEST_METHOD'] === 'PUT') {
    header('Content-Type: application/json');
    echo json_encode(['decoded' => json_decode(file_get_contents('php://input'), true)]);
    return;
}
http_response_code(404);
echo "no route for $path";
`;

describe('php -S', () => {
  it('serves a front controller request-driven: status, headers, cookies, query, form and JSON bodies; static files fall through', { timeout: SLOW }, async () => {
    const { fs, ports, processes } = phpHost({ 'public/index.php': FRONT_CONTROLLER, 'public/app.css': 'body { color: red }' });
    const server = processes.run('php', ['-S', 'localhost:8080', '-t', 'public', 'public/index.php']);
    const log = collect(server.combinedOutput);
    await log.until('Development Server');
    await until(() => ports.has(8080));

    const echoed = await request(ports, 8080, 'POST', '/echo?page=2&tag=a', 'name=widget&qty=3', { 'content-type': 'application/x-www-form-urlencoded', cookie: 'sid=abc; lang=en', 'x-custom': 'yes' });
    expect(echoed.status).toBe(201);
    expect(echoed.headers['content-type']).toContain('application/json');
    expect(echoed.headers['x-served-by']).toBe('php');
    expect([echoed.headers['set-cookie']].flat()).toEqual(['seen=yes; path=/', 'theme=dark']);
    expect(JSON.parse(echoed.text)).toEqual({
      method: 'POST',
      query: { page: '2', tag: 'a' },
      form: { name: 'widget', qty: '3' },
      cookies: { sid: 'abc', lang: 'en' },
      header: 'yes',
      raw: 'name=widget&qty=3',
      script: '/index.php',
      sapi: 'cli-server',
    });

    const json = await request(ports, 8080, 'PUT', '/json', JSON.stringify({ a: [1, 2] }), { 'content-type': 'application/json' });
    expect(JSON.parse(json.text)).toEqual({ decoded: { a: [1, 2] } });

    const css = await request(ports, 8080, 'GET', '/app.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect(css.text).toBe('body { color: red }');

    const missing = await request(ports, 8080, 'GET', '/nowhere');
    expect(missing.status).toBe(404);
    expect(missing.text).toBe('no route for /nowhere');
    expect(log.text()).toContain('[201]: POST /echo?page=2&tag=a');

    // A file the page writes while the server runs is served at once.
    fs.writeFile('/public/late.txt', 'written later');
    await until(() => true);
    const late = await request(ports, 8080, 'GET', '/late.txt');
    expect(late.text).toBe('written later');

    server.kill();
    expect(await server.wait()).not.toBe(0);
    await until(() => !ports.has(8080));
    processes.dispose();
  });

  it('without a router: runs .php files, PATH_INFO, directory indexes, the index.php fallback and 404s for missing files', { timeout: SLOW }, async () => {
    const { ports, processes } = phpHost({
      'index.php': '<?php echo "front ", $_SERVER["PATH_INFO"] ?? "-", " ", $_SERVER["SCRIPT_NAME"];',
      'info.php': '<?php echo "info ", $_SERVER["PATH_INFO"] ?? "-";',
      'docs/index.html': '<h1>docs</h1>',
    });
    const server = processes.run('php', ['-S', '0.0.0.0:8081']);
    await until(() => ports.has(8081));
    expect((await request(ports, 8081, 'GET', '/info.php/extra/bit')).text).toBe('info /extra/bit');
    expect((await request(ports, 8081, 'GET', '/docs/')).text).toBe('<h1>docs</h1>');
    expect((await request(ports, 8081, 'GET', '/users/7')).text).toBe('front /users/7 /index.php');
    expect((await request(ports, 8081, 'GET', '/')).text).toBe('front - /index.php');
    expect((await request(ports, 8081, 'GET', '/missing.png')).status).toBe(404);
    server.kill();
    processes.dispose();
  });

  it('a port another process holds fails like PHP does', { timeout: SLOW }, async () => {
    const { ports, processes } = phpHost({ 'index.php': '<?php echo "one";' });
    const first = processes.run('php', ['-S', 'localhost:8082']);
    await until(() => ports.has(8082));
    const second = processes.run('php', ['-S', 'localhost:8082']);
    expect(await readAll(second.combinedOutput)).toContain('Address already in use');
    expect(await second.wait()).toBe(1);
    expect((await request(ports, 8082, 'GET', '/')).text).toBe('one');
    first.kill();
    processes.dispose();
  });
});
