import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function releaseMetadata({ event, refType, tag, repository, sha, packageVersion }) {
  if (event !== 'push' || refType !== 'tag') return null;
  const version = tag.replace(/^v/, '');
  // Docker tags cannot contain SemVer build metadata (+...).
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
  const match = semver.exec(version);
  if (!match || version.length > 128 || match[4]?.split('.').some(id => /^0\d+$/.test(id))) {
    throw new Error('Release tags must be [v]MAJOR.MINOR.PATCH with an optional SemVer prerelease, without build metadata.');
  }
  if (version !== packageVersion) throw new Error(`Tag ${tag} does not match package.json version ${packageVersion}.`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('Invalid GitHub repository or commit SHA.');
  }
  const owner = repository.split('/')[0].toLowerCase();
  const image = `ghcr.io/${owner}/markov-playground-js`;
  const tags = [`${image}:${version}`, `${image}:sha-${sha}`];
  if (!match[4]) tags.push(`${image}:latest`);
  return { version, image, tags };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version: packageVersion } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const metadata = releaseMetadata({
    event: process.env.GITHUB_EVENT_NAME,
    refType: process.env.GITHUB_REF_TYPE,
    tag: process.env.GITHUB_REF_NAME,
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    packageVersion
  });
  if (metadata) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `version=${metadata.version}\nimage=${metadata.image}\ntags<<RELEASE_TAGS\n${metadata.tags.join('\n')}\nRELEASE_TAGS\n`);
  }
}
