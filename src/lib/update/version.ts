interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(value: string): ParsedVersion | null {
  const match = value.trim().match(VERSION_PATTERN);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  if (left === right) return 0;

  const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : null;

  if (leftNumber !== null && rightNumber !== null) {
    return Math.sign(leftNumber - rightNumber);
  }

  if (leftNumber !== null) return -1;
  if (rightNumber !== null) return 1;

  return left < right ? -1 : 1;
}

export function compareVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);

  if (!parsedLeft || !parsedRight) {
    throw new Error(`Cannot compare invalid versions: ${left}, ${right}`);
  }

  for (const key of ['major', 'minor', 'patch'] as const) {
    const diff = parsedLeft[key] - parsedRight[key];
    if (diff !== 0) return Math.sign(diff);
  }

  const leftIsPrerelease = parsedLeft.prerelease.length > 0;
  const rightIsPrerelease = parsedRight.prerelease.length > 0;

  if (!leftIsPrerelease && !rightIsPrerelease) return 0;
  if (!leftIsPrerelease) return 1;
  if (!rightIsPrerelease) return -1;

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];

    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;

    const diff = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (diff !== 0) return diff;
  }

  return 0;
}

export function pickLatestVersion(versions: Iterable<string>): string | null {
  let latest: string | null = null;

  for (const version of versions) {
    if (!parseVersion(version)) continue;
    if (!latest || compareVersions(version, latest) > 0) {
      latest = version;
    }
  }

  return latest;
}

export function isNewerVersion(candidate: string | null, current: string): boolean {
  if (!candidate) return false;
  const parsedCandidate = parseVersion(candidate);
  const parsedCurrent = parseVersion(current);
  if (!parsedCandidate || !parsedCurrent) return false;

  // Hotfix builds are opt-in replacements for their base release. Semver ranks
  // that release higher, but prompting to install it would undo the hotfix.
  if (
    parsedCurrent.prerelease[0] === 'hotfix'
    && parsedCandidate.prerelease.length === 0
    && parsedCandidate.major === parsedCurrent.major
    && parsedCandidate.minor === parsedCurrent.minor
    && parsedCandidate.patch === parsedCurrent.patch
  ) return false;

  return compareVersions(candidate, current) > 0;
}
