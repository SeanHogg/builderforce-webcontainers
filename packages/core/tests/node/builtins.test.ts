import { describe, expect, it } from 'vitest';
import { kernelWith, readAll, runNode } from './helpers.js';

const script = (body: string) => ({ 'index.js': body });

describe('node builtins', () => {
  it('fs: sync, callback and promise forms with Node error codes', async () => {
    const { output, code } = await runNode(
      script(`
        const fs = require('fs');
        fs.mkdirSync('/data/deep', { recursive: true });
        fs.writeFileSync('/data/a.txt', 'one');
        fs.appendFileSync('/data/a.txt', '+two');
        console.log(fs.readFileSync('/data/a.txt', 'utf8'), fs.existsSync('/data/deep'), fs.statSync('/data/a.txt').size);
        console.log(fs.readdirSync('/data', { withFileTypes: true }).map((d) => d.name + (d.isDirectory() ? '/' : '')).join(','));
        try { fs.readFileSync('/nope') } catch (e) { console.log(e.code, e.syscall) }
        fs.renameSync('/data/a.txt', '/data/deep/b.txt');
        fs.readFile('/data/deep/b.txt', 'utf8', (err, text) => {
          console.log('cb', err, text);
          fs.promises.writeFile('/data/c.json', '{"x":1}').then(() => fs.promises.readFile('/data/c.json', 'utf8')).then((t) => console.log('promise', JSON.parse(t).x));
        });
      `),
    );
    expect(output).toBe('one+two true 7\na.txt,deep/\nENOENT open\ncb null one+two\npromise 1\n');
    expect(code).toBe(0);
  });

  it('fs: streams, fds and watch', async () => {
    const { output } = await runNode(
      script(`
        const fs = require('fs');
        fs.writeFileSync('/in.txt', 'x'.repeat(100000));
        const fd = fs.openSync('/fd.txt', 'w'); fs.writeSync(fd, 'abc'); fs.closeSync(fd);
        const watcher = fs.watch('/', (event, name) => { if (name === 'out.txt') { console.log('watch', event); watcher.close(); } });
        fs.createReadStream('/in.txt').pipe(fs.createWriteStream('/out.txt')).on('finish', () => {
          console.log(fs.readFileSync('/out.txt', 'utf8').length, fs.readFileSync('/fd.txt', 'utf8'));
        });
      `),
    );
    expect(output).toContain('watch rename');
    expect(output).toContain('100000 abc');
  });

  it('path, url, querystring, util, os', async () => {
    const { output } = await runNode(
      script(`
        const path = require('path'), url = require('url'), qs = require('querystring'), util = require('util'), os = require('os');
        console.log(path.join('/a', '../b', 'c.js'), path.relative('/a/b', '/a/c/d'), path.extname('x.tar.gz'), path.resolve('rel'), path.parse('/x/y.z').name);
        const u = url.parse('http://user:pw@host.com:8080/p/a?q=1#h', true);
        console.log(u.hostname, u.port, u.pathname, u.query.q, u.hash, url.fileURLToPath('file:///a/b'));
        console.log(qs.stringify({ a: [1, 2], b: 'x y' }), qs.parse('a=1&a=2&b=x%20y').a.length);
        console.log(util.format('%s=%d %j', 'n', 5, { k: 1 }), util.inspect(new Map([[1, 'a']])), util.types.isPromise(Promise.resolve()));
        console.log(os.platform(), os.EOL === '\\n', typeof os.cpus().length);
      `),
    );
    expect(output).toBe(
      '/b/c.js ../c/d .gz /rel y\n' +
        'host.com 8080 /p/a 1 #h /a/b\n' +
        'a=1&a=2&b=x%20y 2\n' +
        "n=5 {\"k\":1} Map(1) { 1 => 'a' } true\n" +
        'linux true number\n',
    );
  });

  it('Buffer and crypto digests', async () => {
    const { output } = await runNode(
      script(`
        const crypto = require('crypto');
        const b = Buffer.from('héllo');
        console.log(b.length, b.toString('base64'), Buffer.from('aGk=', 'base64').toString(), Buffer.concat([Buffer.from('a'), Buffer.from('b')]).toString('hex'));
        console.log(b.slice(0, 1).toString(), b.readUInt8(0), Buffer.alloc(3, 'ab').toString(), Buffer.isBuffer(b), b.equals(Buffer.from('héllo')));
        for (const algo of ['md5', 'sha1', 'sha256', 'sha512']) console.log(crypto.createHash(algo).update('abc').digest('hex'));
        console.log(crypto.createHmac('sha256', 'key').update('The quick brown fox jumps over the lazy dog').digest('hex'));
        console.log(crypto.randomBytes(8).length, crypto.randomUUID().length);
      `),
    );
    expect(output.split('\n')).toEqual([
      '6 aMOpbGxv hi 6162',
      'h 104 aba true true',
      '900150983cd24fb0d6963f7d28e17f72',
      'a9993e364706816aba3e25717850c26c9cd0d89d',
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
      '8 36',
      '',
    ]);
  });

  it('events, streams (pipeline, Transform, async iteration) and zlib', async () => {
    const { output } = await runNode(
      script(`
        const { EventEmitter, once } = require('events');
        const { Readable, Transform, Writable, pipeline } = require('stream');
        const zlib = require('zlib');
        function Legacy() { EventEmitter.call(this); }
        require('util').inherits(Legacy, EventEmitter);
        const legacy = new Legacy();
        legacy.once('ping', (v) => console.log('ping', v));
        legacy.emit('ping', 1); legacy.emit('ping', 2);
        const upper = new Transform({ transform(chunk, _e, cb) { cb(null, chunk.toString().toUpperCase()); } });
        let out = '';
        pipeline(Readable.from(['a', 'b', 'c']), upper, new Writable({ write(c, _e, cb) { out += c; cb(); } }), (err) => {
          console.log('pipeline', err, out);
          const packed = zlib.gzipSync('hello '.repeat(50));
          console.log('zlib', zlib.gunzipSync(packed).toString().length, packed.length < 300);
          (async () => { let s = ''; for await (const c of Readable.from(['x', 'y'])) s += c; console.log('iter', s); })();
        });
      `),
    );
    expect(output).toBe('ping 1\npipeline null ABC\nzlib 300 true\niter xy\n');
  });

  it('child_process runs node scripts in the runtime and fails clearly for others', async () => {
    const { output } = await runNode({
      'index.js': `
        const cp = require('child_process');
        cp.exec('node child.js', (err, stdout) => {
          console.log('exec', err, JSON.stringify(stdout));
          const child = cp.spawn('node', ['child.js']);
          child.stdout.on('data', (d) => console.log('spawn', String(d).trim()));
          child.on('close', (c) => {
            console.log('close', c);
            cp.spawn('definitely-not-here').on('error', (e) => console.log('error', e.code));
            try { cp.execSync('ls') } catch (e) { console.log('sync', e.code) }
          });
        });
      `,
      'child.js': 'console.log("from child")',
    });
    expect(output).toBe('exec null "from child\\n"\nspawn from child\nclose 0\nsync ERR_FEATURE_UNAVAILABLE_ON_PLATFORM\nerror ENOENT\n');
  });

  it('builtin classes can be subclassed the pre-ES2015 way (Ctor.call(this))', async () => {
    // iconv-lite (under body-parser) does exactly this with StringDecoder.
    const { output } = await runNode(
      script(`
        const util = require('util');
        const { StringDecoder } = require('string_decoder');
        const { Readable } = require('stream');
        function Decoder(enc) { StringDecoder.call(this, enc); }
        util.inherits(Decoder, StringDecoder);
        const bytes = Buffer.from('é');
        const d = new Decoder('utf8');
        console.log(d.write(bytes.subarray(0, 1)) + d.write(bytes.subarray(1)), d instanceof StringDecoder);
        function Source() { Readable.call(this, { read() {} }); }
        util.inherits(Source, Readable);
        const s = new Source(); s.on('data', (c) => console.log('data', String(c))); s.push('x'); s.push(null);
      `),
    );
    expect(output).toBe('é true\ndata x\n');
  });

  it('readline reads lines from stdin', async () => {
    const { output } = await runNode(
      script(`
        const rl = require('readline').createInterface({ input: process.stdin });
        const lines = [];
        rl.on('line', (l) => lines.push(l));
        rl.on('close', () => console.log(lines.join('|')));
      `),
      'index.js',
      [],
      { input: 'one\ntwo\r\nthree' },
    );
    expect(output).toBe('one|two|three\n');
  });
});

describe('node http', () => {
  it('serves requests on a virtual port and announces server-ready', async () => {
    const kernel = kernelWith({
      'server.js': `
        const http = require('http');
        const server = http.createServer((req, res) => {
          let body = '';
          req.on('data', (c) => body += c);
          req.on('end', () => {
            res.setHeader('x-path', req.url);
            res.writeHead(201, { 'content-type': 'text/plain' });
            res.end(req.method + ' ' + body + ' ' + req.headers['content-length']);
          });
        });
        server.listen(3000, () => console.log('listening', server.address().port));
      `,
    });
    const ready = new Promise<[number, string]>((resolve) => kernel.on('server-ready', (port, url) => resolve([port, url])));
    const proc = kernel.spawn('node', ['server.js']);
    const output = readAll(proc.output);
    expect(await ready).toEqual([3000, 'http://localhost:3000/']);
    const response = await kernel.request(3000, { method: 'POST', url: '/echo?x=1', body: new TextEncoder().encode('payload') });
    expect(response?.status).toBe(201);
    expect(response?.headers['x-path']).toBe('/echo?x=1');
    expect(new TextDecoder().decode(response?.body)).toBe('POST payload 7'); // content-length is synthesised for body parsers
    proc.kill();
    expect(await proc.exit).toBe(143);
    expect(await output).toBe('listening 3000\n');
    expect(kernel.ports.has(3000)).toBe(false);
  });

  it('reaches its own servers over loopback with http.get and fetch, then exits once closed', async () => {
    const { output, code } = await runNode(
      script(`
        const http = require('http');
        const server = http.createServer((req, res) => res.end('pong ' + req.url)).listen(0, async () => {
          const port = server.address().port;
          http.get('http://localhost:' + port + '/a', (res) => {
            let s = ''; res.on('data', (c) => s += c); res.on('end', async () => {
              console.log(res.statusCode, s);
              const r = await fetch('http://127.0.0.1:' + port + '/b');
              console.log(r.status, await r.text());
              server.close();
            });
          });
        });
      `),
    );
    expect(output).toBe('200 pong /a\n200 pong /b\n');
    expect(code).toBe(0);
  });
});
