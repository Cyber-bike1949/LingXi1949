import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBinaryAssetUrls } from './binaryDownloadUrls.ts';

test('resolveBinaryAssetUrls builds GitHub Release URLs for Unix binaries', () => {
  const urls = resolveBinaryAssetUrls({
    version: '1.3.0',
    platform: 'linux',
    arch: 'x64',
    source: 'github-release',
  });

  assert.equal(
    urls.url,
    'https://github.com/Cyber-bike1949/LingXi1949/releases/download/1.3.0/termy-server-linux-x64'
  );
  assert.equal(
    urls.checksumUrl,
    'https://github.com/Cyber-bike1949/LingXi1949/releases/download/1.3.0/termy-server-linux-x64.sha256'
  );
});

test('resolveBinaryAssetUrls builds GitHub latest fallback URLs', () => {
  const urls = resolveBinaryAssetUrls({
    version: '1.3.0',
    platform: 'darwin',
    arch: 'arm64',
    source: 'github-release',
    releaseChannel: 'latest',
  });

  assert.equal(
    urls.url,
    'https://github.com/Cyber-bike1949/LingXi1949/releases/latest/download/termy-server-darwin-arm64'
  );
  assert.equal(
    urls.checksumUrl,
    'https://github.com/Cyber-bike1949/LingXi1949/releases/latest/download/termy-server-darwin-arm64.sha256'
  );
});
