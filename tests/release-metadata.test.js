import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseMetadata } from '../scripts/release-metadata.mjs';

const input = {
  event: 'push', refType: 'tag', tag: '0.2.0', packageVersion: '0.2.0',
  repository: 'Oberones/markov-playground-js', sha: 'a'.repeat(40)
};

test('only tag pushes produce publication metadata', () => {
  assert.equal(releaseMetadata({ ...input, event: 'pull_request' }), null);
  assert.equal(releaseMetadata({ ...input, refType: 'branch', tag: 'main' }), null);
});

test('stable version tags match Commitizen and optional v prefix, with lowercase GHCR path', () => {
  for (const tag of ['0.2.0', 'v0.2.0']) {
    const result = releaseMetadata({ ...input, tag });
    assert.equal(result.version, '0.2.0');
    assert.deepEqual(result.tags, [
      'ghcr.io/oberones/markov-playground-js:0.2.0',
      `ghcr.io/oberones/markov-playground-js:sha-${input.sha}`,
      'ghcr.io/oberones/markov-playground-js:latest'
    ]);
  }
});

test('prereleases never move latest', () => {
  for (const version of ['1.0.0-rc.1', '0.2.1-0', '0.2.1-alpha-1']) {
    const result = releaseMetadata({ ...input, tag: `v${version}`, packageVersion: version });
    assert.equal(result.tags.length, 2);
    assert.equal(result.version, version);
  }
});

test('reject malformed, mismatched, or Docker-incompatible release versions', () => {
  for (const tag of ['release', '01.2.0', '0.02.0', '0.2.00', '0.2', 'vv0.2.0',
    '0.2.0-01', '0.2.0-rc.01', '0.2.0-rc..1', '0.2.0+build', '0.2.0\nlatest',
    `0.2.0-${'a'.repeat(128)}`]) {
    assert.throws(() => releaseMetadata({ ...input, tag, packageVersion: tag.replace(/^v/, '') }));
  }
  assert.throws(() => releaseMetadata({ ...input, tag: '0.3.0' }), /does not match/);
});
