/**
 * Whether a branch has an upstream, read the way Git defines it.
 *
 * Two facts get conflated constantly and they are not the same one:
 *
 * - A branch *has* an upstream when `branch.<name>.remote` and
 *   `branch.<name>.merge` are both set. That is the whole definition; it is what
 *   bare `git push` and bare `git pull` obey.
 * - A *remote-tracking ref* (`refs/remotes/<remote>/<branch>`) exists only when
 *   the clone's fetch refspec maps that branch into `refs/remotes`. A clone
 *   narrowed to `+refs/heads/dev:refs/remotes/origin/dev` never creates one for
 *   anything else.
 *
 * `@{upstream}` answers the second question, not the first: Git resolves it
 * through the refspec and refuses — "not stored as a remote-tracking branch" —
 * for a branch the refspec does not map, even when the ref happens to exist.
 * Reading it as "this branch has no upstream" is what made the panel offer
 * Publish Branch forever on a branch that was already published.
 *
 * So the config pair is the fallback, and it is read from
 * `git config --get-regexp` output rather than one key at a time because the
 * Git panel already batches its reads and pays per process.
 */

export interface ConfiguredUpstream {
  /** As `git rev-parse --abbrev-ref @{upstream}` would have printed it. */
  name: string;
  /** The remote this branch tracks. `.` is Git's spelling of "this repository". */
  remote: string;
  /** The branch on that remote, without `refs/heads/`. */
  branch: string;
  /**
   * Where the remote-tracking ref would live. Fully qualified on purpose: it is
   * the only name that still resolves once `@{upstream}` will not, so it is what
   * an ahead/behind count has left to compare against.
   */
  trackingRef: string;
}

/**
 * `configRaw` is the output of
 * `git config --get-regexp '^branch\..*\.(remote|merge)$'` — every branch, not
 * just this one, because the Git panel builds its command batch before it knows
 * which branch is checked out.
 *
 * Null when the pair is incomplete, which is Git's own rule: a branch with only
 * one of the two keys tracks nothing.
 */
export function resolveConfiguredUpstream(
  configRaw: string | null,
  branch: string | null,
): ConfiguredUpstream | null {
  if (!configRaw || !branch) return null;

  const remote = readConfigValue(configRaw, `branch.${branch}.remote`);
  const merge = readConfigValue(configRaw, `branch.${branch}.merge`);
  if (!remote || !merge) return null;
  // A URL in `branch.<name>.remote` is legal and names nothing this can use:
  // there is no remote to ask for a URL later and no `refs/remotes/<url>/…` to
  // count against. Git gives up on such a branch too.
  if (isRemoteUrl(remote)) return null;

  const upstreamBranch = merge.replace(/^refs\/heads\//, "");
  if (!upstreamBranch) return null;

  // A branch tracking another local branch prints as the bare branch name, with
  // no remote in front — the same string `@{upstream}` gives for that case.
  if (remote === ".") {
    return {
      name: upstreamBranch,
      remote,
      branch: upstreamBranch,
      trackingRef: `refs/heads/${upstreamBranch}`,
    };
  }

  return {
    name: `${remote}/${upstreamBranch}`,
    remote,
    branch: upstreamBranch,
    trackingRef: `refs/remotes/${remote}/${upstreamBranch}`,
  };
}

/**
 * `--get-regexp` prints `<key> <value>`, and the key is matched whole rather
 * than split on dots — `feature/0803-kq` is one branch name carrying a dot in
 * the middle of it, and splitting would hand back `0803-kq` as the key's tail.
 */
function readConfigValue(raw: string, key: string): string | null {
  const prefix = `${key} `;
  for (const line of raw.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length).trim();
    if (value) return value;
  }
  return null;
}

/**
 * A remote *name* carries neither of these; every URL form Git accepts carries
 * one — `https://…` and `/srv/repo.git` have a slash, `git@host:repo` a colon.
 */
function isRemoteUrl(remote: string): boolean {
  if (remote === ".") return false;
  return remote.includes("/") || remote.includes(":");
}
