/**
 * The .NET runtime's exit criterion (PRD 31 §W9 phase 6c) on the real bundle:
 * an ASP.NET Core minimal-API service is built in the runtime by Roslyn
 * (`dotnet run`), served by the in-memory server on a virtual port, and does
 * CRUD — with a rolled-back transaction — against the PGlite database the
 * application runtime starts, through the patched Npgsql dialling the
 * Postgres gateway over virtual TCP. Offline: the bundle is read from disk.
 *
 * Skipped until the bundle exists (scripts/build-dotnet-runtime.mjs needs the
 * .NET 10 SDK; CI's dotnet job builds it, or set BFWC_DOTNET_BUNDLE).
 */
import { describe, expect, it } from 'vitest';
import { createPgliteProvider, startApplicationRuntime, type ApplicationSpec, type NodeServiceHost } from '../src/app.js';
import { createDotnetProcessKind, createDotnetProvider } from '../src/runtimes/dotnet/index.js';
import type { ProcessHost } from '../src/node/processHost.js';
import { appHost, fakeLocks } from './databaseHelpers.js';
import { DOTNET_BUNDLE_DIR, DOTNET_BUNDLE_URL, dotnetWorkers, loadBundledDotnet } from './dotnet-helpers.js';
import { request } from './php-helpers.js';

function runtimeOf(processes: ProcessHost): NodeServiceHost {
  return {
    run: (command, args, options) => processes.run(command, args, options),
    onServerListening: (listener) => processes.servers.onListening(listener),
    onPortChange: (listener) => processes.servers.onPortChange(listener),
    listProcesses: () => processes.list(),
  };
}

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Npgsql" Version="9.0.3" />
  </ItemGroup>
</Project>
`;

const PROGRAM = String.raw`using Npgsql;

var url = new Uri(Environment.GetEnvironmentVariable("DATABASE_URL") ?? throw new InvalidOperationException("DATABASE_URL is not set."));
// The service's own credentials, from DATABASE_URL's userinfo: a missing password is an error, never an empty one.
var userInfo = url.UserInfo.Split(':', 2);
if (userInfo.Length < 2 || userInfo[1].Length == 0) throw new InvalidOperationException("DATABASE_URL has no password: the database gateway needs the service's credentials.");
var connection = new NpgsqlConnectionStringBuilder
{
    Host = url.Host,
    Port = url.Port,
    Username = Uri.UnescapeDataString(userInfo[0]),
    Password = Uri.UnescapeDataString(userInfo[1]),
    Database = url.AbsolutePath.TrimStart('/'),
    SslMode = SslMode.Disable,
}.ConnectionString;
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(NpgsqlDataSource.Create(connection));
var app = builder.Build();

app.MapGet("/health", async (NpgsqlDataSource db) => new { ok = (int)(await db.CreateCommand("SELECT 1").ExecuteScalarAsync())! == 1 });
app.MapGet("/greeting", (IConfiguration config, ILogger<Item> log) =>
{
    log.LogInformation("greeting asked");
    return Results.Text(config["Greeting"]);
});
app.MapPost("/migrate", async (NpgsqlDataSource db) =>
{
    await db.CreateCommand("CREATE TABLE IF NOT EXISTS items (id serial PRIMARY KEY, name text NOT NULL UNIQUE, qty int NOT NULL DEFAULT 0)").ExecuteNonQueryAsync();
    return new { migrated = true };
});
app.MapGet("/items", async (NpgsqlDataSource db) =>
{
    var items = new List<Item>();
    await using var reader = await db.CreateCommand("SELECT id, name, qty FROM items ORDER BY id").ExecuteReaderAsync();
    while (await reader.ReadAsync()) items.Add(new Item(reader.GetInt32(0), reader.GetString(1), reader.GetInt32(2)));
    return items;
});
app.MapPost("/items", async (NpgsqlDataSource db, NewItem item) =>
{
    await using var insert = db.CreateCommand("INSERT INTO items (name, qty) VALUES ($1, $2) RETURNING id");
    insert.Parameters.AddWithValue(item.Name);
    insert.Parameters.AddWithValue(item.Qty);
    var id = (int)(await insert.ExecuteScalarAsync())!;
    return Results.Created($"/items/{id}", new { id });
});
app.MapPatch("/items/{id:int}", async (NpgsqlDataSource db, int id, NewItem item) =>
{
    await using var update = db.CreateCommand("UPDATE items SET qty = $1 WHERE id = $2");
    update.Parameters.AddWithValue(item.Qty);
    update.Parameters.AddWithValue(id);
    return new { updated = await update.ExecuteNonQueryAsync() };
});
app.MapDelete("/items/{id:int}", async (NpgsqlDataSource db, int id) =>
{
    await using var delete = db.CreateCommand("DELETE FROM items WHERE id = $1");
    delete.Parameters.AddWithValue(id);
    return new { deleted = await delete.ExecuteNonQueryAsync() };
});
// The default SSL Mode (Prefer): Npgsql asks for TLS, the gateway answers N, and the connection goes on in plain text.
app.MapGet("/prefer", async () =>
{
    var prefer = new NpgsqlConnectionStringBuilder(connection) { SslMode = SslMode.Prefer };
    await using var conn = new NpgsqlConnection(prefer.ConnectionString);
    await conn.OpenAsync();
    return new { ok = (int)(await new NpgsqlCommand("SELECT 1", conn).ExecuteScalarAsync())! == 1 };
});
// The path as the pipeline sees it (Kestrel's decoding: %2F kept, dot segments removed after decoding).
app.MapGet("/echo/{**rest}", (HttpContext context) => context.Request.Path.Value);
app.MapPost("/transfer", async (NpgsqlDataSource db) =>
{
    await using var conn = await db.OpenConnectionAsync();
    await using var tx = await conn.BeginTransactionAsync();
    try
    {
        await new NpgsqlCommand("INSERT INTO items (name) VALUES ('in-transaction')", conn, tx).ExecuteNonQueryAsync();
        await new NpgsqlCommand("INSERT INTO items (name) VALUES ('in-transaction')", conn, tx).ExecuteNonQueryAsync();
        await tx.CommitAsync();
        return Results.Ok(new { committed = true });
    }
    catch (PostgresException e)
    {
        await tx.RollbackAsync();
        return Results.Json(new { rolledBack = true, sqlstate = e.SqlState }, statusCode: 409);
    }
});

app.Run();

record Item(int Id, string Name, int Qty);
record NewItem(string Name, int Qty);
`;

describe.skipIf(!DOTNET_BUNDLE_DIR)('.NET minimal API against the PGlite gateway (real bundle, offline)', () => {
  it('builds in the runtime with Roslyn, serves through the in-memory server, and does CRUD with Npgsql', { timeout: 600_000 }, async () => {
    const { processes, databases } = appHost({ 'api/api.csproj': CSPROJ, 'api/Program.cs': PROGRAM, 'api/appsettings.json': '{ "Greeting": "hello from appsettings" }' }, dotnetWorkers(loadBundledDotnet), createDotnetProcessKind({ bundleUrl: DOTNET_BUNDLE_URL }));
    const spec: ApplicationSpec = {
      projectId: `dotnet-db-${Date.now()}`,
      services: [
        { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' }, database: { engine: 'postgres', provider: 'pglite', persistent: false } },
        { id: 'api', type: 'application', runtime: 'dotnet', root: '/api', command: 'dotnet', args: ['run', '--urls', 'http://localhost:8080'], port: 8080, dependsOn: ['db'], readiness: { kind: 'http', path: '/health' } },
      ],
    };
    const app = startApplicationRuntime(spec, { runtime: processes, providers: [createDotnetProvider(runtimeOf(processes), { probeIntervalMs: 100 }), createPgliteProvider(databases, { locks: fakeLocks() })], readinessTimeoutMs: 240_000 });
    const logs: string[] = [];
    void (async () => {
      for await (const entry of app.logs('api')) logs.push(entry.text);
    })();
    try {
      await app.start();
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${logs.join('')}`);
    }
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await request(processes.ports, 8080, method, url, body === undefined ? undefined : JSON.stringify(body), { 'content-type': 'application/json' });
      return { status: response.status, body: response.text ? JSON.parse(response.text) : undefined };
    };
    try {
      expect(await call('GET', '/health')).toEqual({ status: 200, body: { ok: true } });
      expect(await call('POST', '/migrate')).toEqual({ status: 200, body: { migrated: true } });
      expect(await call('POST', '/items', { name: 'widget', qty: 3 })).toEqual({ status: 201, body: { id: 1 } });
      expect(await call('POST', '/items', { name: 'gadget', qty: 1 })).toEqual({ status: 201, body: { id: 2 } });
      expect(await call('PATCH', '/items/2', { name: 'gadget', qty: 7 })).toEqual({ status: 200, body: { updated: 1 } });
      expect(await call('POST', '/transfer')).toEqual({ status: 409, body: { rolledBack: true, sqlstate: '23505' } });
      expect(await call('DELETE', '/items/1')).toEqual({ status: 200, body: { deleted: 1 } });
      expect(await call('GET', '/items')).toEqual({ status: 200, body: [{ id: 2, name: 'gadget', qty: 7 }] });
      expect((await call('GET', '/missing')).status).toBe(404);
      expect(await call('GET', '/prefer')).toEqual({ status: 200, body: { ok: true } });
      const path = async (url: string) => {
        const response = await request(processes.ports, 8080, 'GET', url);
        return { status: response.status, text: response.text };
      };
      expect(await path('/echo/a%2Fb')).toEqual({ status: 200, text: '/echo/a%2Fb' });
      expect(await path('/echo/caf%C3%A9')).toEqual({ status: 200, text: '/echo/café' });
      expect(await path('/echo/x/%2e%2e/y')).toEqual({ status: 200, text: '/echo/y' });
      expect((await path('/echo/%2e%2e/%2E%2E/items')).status).toBe(200); // climbs to /items, never above /
      const greeting = await request(processes.ports, 8080, 'GET', '/greeting');
      expect(greeting.text).toBe('hello from appsettings');
      expect(logs.join('')).toContain('greeting asked');
      expect(logs.join('')).toContain('Now listening on: http://localhost:8080');
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${logs.join('')}`);
    } finally {
      await app.dispose();
      processes.dispose();
    }
  });
});
