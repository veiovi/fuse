import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CookieJar, parseSetCookie } from '../src/cookie-jar.js';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

describe('parseSetCookie', () => {
  test('name, value and attributes', () => {
    const c = parseSetCookie('fuse_ab12cd34=s3ss10n; Path=/; HttpOnly; SameSite=Lax; Max-Age=60', 'http://localhost:4710/me', NOW);
    assert.deepEqual(c, {
      origin: 'http://localhost:4710',
      name: 'fuse_ab12cd34',
      value: 's3ss10n',
      path: '/',
      secure: false,
      expires: NOW + 60_000,
      created: NOW,
    });
  });

  test('default path is the request directory', () => {
    assert.equal(parseSetCookie('a=1', 'http://h/docs/page', NOW).path, '/docs');
    assert.equal(parseSetCookie('a=1', 'http://h/page', NOW).path, '/');
    assert.equal(parseSetCookie('a=1; Path=relative', 'http://h/x/y', NOW).path, '/x');
  });

  test('Max-Age wins over Expires; sessions have no expiry', () => {
    const c = parseSetCookie('a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=10', 'http://h/', NOW);
    assert.equal(c.expires, NOW + 10_000);
    assert.equal(parseSetCookie('a=1; Expires=Fri, 23 Oct 2026 00:00:00 GMT', 'http://h/', NOW).expires, Date.UTC(2026, 9, 23));
    assert.equal(parseSetCookie('a=1; Max-Age=soon', 'http://h/', NOW).expires, null);
  });

  test('values a user agent must ignore', () => {
    assert.equal(parseSetCookie('novalue', 'http://h/', NOW), null);
    assert.equal(parseSetCookie('=1', 'http://h/', NOW), null);
  });
});

describe('CookieJar', () => {
  test('cookies stay with their origin: never shared across ports, schemes or hosts', () => {
    // Stricter than browsers on purpose: one site must not receive another
    // site's session cookie just because both run on the same host.
    const jar = new CookieJar();
    jar.setCookie('http://localhost:4710/me', 'fuse_forum=1; Path=/', NOW);
    jar.setCookie('http://localhost:4720/v1/search', 'fuse_api=2; Path=/', NOW);
    assert.equal(jar.cookieHeader('http://localhost:4720/v1/x', NOW), 'fuse_api=2');
    assert.equal(jar.cookieHeader('http://localhost:4710/me', NOW), 'fuse_forum=1');
    assert.equal(jar.cookieHeader('https://localhost:4710/me', NOW), '');
    assert.equal(jar.cookieHeader('http://127.0.0.1:4710/', NOW), '');
    jar.setCookie('http://forum.localhost:4710/me', 'f=1', NOW);
    assert.equal(jar.cookieHeader('http://api.localhost:4710/', NOW), '');
    assert.equal(jar.cookieHeader('http://forum.localhost:4710/', NOW), 'f=1');
  });

  test('path matching and ordering', () => {
    const jar = new CookieJar();
    jar.setCookie('http://h/', 'root=1; Path=/', NOW);
    jar.setCookie('http://h/', 'api=2; Path=/v1', NOW + 1);
    assert.equal(jar.cookieHeader('http://h/v1/search', NOW), 'api=2; root=1');
    assert.equal(jar.cookieHeader('http://h/v1', NOW), 'api=2; root=1');
    assert.equal(jar.cookieHeader('http://h/v10', NOW), 'root=1');
  });

  test('replacing, expiring and deleting', () => {
    const jar = new CookieJar();
    assert.equal(jar.setCookie('http://h/', 'a=1; Max-Age=10', NOW), true);
    jar.setCookie('http://h/', 'a=2; Max-Age=10', NOW);
    assert.equal(jar.cookieHeader('http://h/', NOW), 'a=2');
    assert.equal(jar.cookieHeader('http://h/', NOW + 10_001), '');
    assert.equal(jar.size, 0, 'expired cookies are dropped on read');

    jar.setCookie('http://h/', 'b=1', NOW);
    assert.equal(jar.setCookie('http://h/', 'b=; Max-Age=0', NOW), true);
    assert.equal(jar.cookieHeader('http://h/', NOW), '');
    jar.setCookie('http://h/', 'c=1', NOW);
    jar.setCookie('http://h/', 'c=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT', NOW);
    assert.equal(jar.cookieHeader('http://h/', NOW), '');
  });

  test('Secure cookies only travel over https or to loopback hosts', () => {
    const jar = new CookieJar();
    jar.setCookie('https://site.example/', 's=1; Secure', NOW);
    jar.setCookie('http://forum.localhost:4710/', 'l=1; Secure', NOW);
    assert.equal(jar.cookieHeader('http://site.example/', NOW), '');
    assert.equal(jar.cookieHeader('https://site.example/', NOW), 's=1');
    assert.equal(jar.cookieHeader('http://forum.localhost:4710/', NOW), 'l=1');
  });

  test('setFromResponse reads every Set-Cookie header', () => {
    const jar = new CookieJar();
    const headers = new Headers();
    headers.append('set-cookie', 'a=1; Path=/');
    headers.append('set-cookie', 'b=2; Path=/');
    assert.equal(jar.setFromResponse('http://h/x', new Response(null, { headers }), NOW), true);
    assert.equal(jar.cookieHeader('http://h/', NOW), 'a=1; b=2');
    assert.equal(jar.setFromResponse('http://h/x', new Response(null), NOW), false);
  });

  test('clear and JSON round trip', () => {
    const jar = new CookieJar();
    jar.setCookie('http://a.example/', 'a=1', NOW);
    jar.setCookie('http://b.example/', 'b=1; Max-Age=60', NOW);
    const copy = new CookieJar(JSON.parse(JSON.stringify(jar)));
    assert.equal(copy.cookieHeader('http://b.example/', NOW), 'b=1');
    copy.clear('http://b.example/any/path');
    assert.equal(copy.cookieHeader('http://b.example/', NOW), '');
    assert.equal(copy.cookieHeader('http://a.example/', NOW), 'a=1');
    copy.clear();
    assert.equal(copy.size, 0);
  });

  test('host-keyed cookies from an older wallet are dropped', () => {
    const jar = new CookieJar([{ host: 'localhost', name: 'a', value: '1', path: '/', expires: null, created: NOW }]);
    assert.equal(jar.size, 0);
  });
});
