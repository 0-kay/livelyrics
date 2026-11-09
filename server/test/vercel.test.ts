import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import handler, { originalUrl, resetApp } from '../src/vercel.js';
// Root-level Vercel middleware is plain JS with no build step.
import middleware, { passwordOk } from '../../middleware.js';

describe('Vercel function', () => {
  let server: Server | null = null;
  const env = { ...process.env };
  afterEach(() => {
    server?.close();
    server = null;
    process.env = { ...env };
    resetApp();
  });

  it('restores the original API path from the rewrite', () => {
    expect(originalUrl('/api?__path=identify')).toBe('/api/identify');
    expect(originalUrl('/api?__path=health&x=1')).toBe('/api/health?x=1');
    expect(originalUrl('/api/identify')).toBe('/api/identify');
    expect(originalUrl('/api/identify?__path=identify')).toBe('/api/identify');
  });

  it('serves the Fastify API through the handler', async () => {
    process.env.PROVIDER_MODE = 'mock';
    delete process.env.ACCESS_PASSWORD;
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api?__path=health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'mock', concertMode: false });
  });
});

describe('Vercel middleware password', () => {
  const req = (auth?: string) => new Request('https://x.test/', { headers: auth ? { authorization: auth } : {} });
  const basic = (u: string, p: string) => 'Basic ' + btoa(`${u}:${p}`);
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('checks the password and ignores the user name', () => {
    expect(passwordOk(basic('anyone', 'sing'), 'sing')).toBe(true);
    expect(passwordOk(basic('anyone', 'sang'), 'sing')).toBe(false);
    expect(passwordOk(undefined, 'sing')).toBe(false);
    expect(passwordOk('Bearer x', 'sing')).toBe(false);
  });

  it('asks the browser to sign in, and lets the right password through', () => {
    process.env.ACCESS_PASSWORD = 'sing';
    const denied = middleware(req()) as Response;
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain('Basic');
    expect(middleware(req(basic('me', 'sing')))).toBeUndefined();
  });

  it('is open when no password is set', () => {
    delete process.env.ACCESS_PASSWORD;
    expect(middleware(req())).toBeUndefined();
  });
});
