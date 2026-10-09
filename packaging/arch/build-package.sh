#!/usr/bin/env bash
# Builds and verifies the Arch Linux package inside an archlinux container. GitHub has no Arch
# runner, so the Linux release job runs this through Docker:
#
#   docker run --rm --privileged -v "$PWD:/work" -w /work \
#     -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
#     archlinux:latest bash packaging/arch/build-package.sh <version>
#
# Reads  release/Tessera-<version>-linux-amd64.deb
# Writes release/Tessera-<version>-linux-x86_64.pkg.tar.zst
#
# Besides building, it installs the package on this minimal system, checks that every shared
# library resolves, reinstalls it to exercise pacman's upgrade path, and launches the app under
# Xvfb until its server answers and a renderer is running. --privileged keeps that launch
# independent of the runner's container seccomp profile, which Chromium's sandbox depends on.
set -euo pipefail

version="${1:?usage: build-package.sh <package.json version>}"
work_dir="$(pwd)"
deb="${work_dir}/release/Tessera-${version}-linux-amd64.deb"
output="${work_dir}/release/Tessera-${version}-linux-x86_64.pkg.tar.zst"
app_port=32123

log() { printf '\n==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ -f "$deb" ]] || fail "missing $deb"

log 'Installing build and smoke-test tools'
pacman -Syu --noconfirm --needed base-devel curl xorg-server-xvfb >/dev/null

# makepkg refuses to run as root.
id builder >/dev/null 2>&1 || useradd --create-home builder
build_dir="$(mktemp -d)"
cp "${work_dir}/packaging/arch/PKGBUILD" "$deb" "$build_dir/"
# pacman versions cannot contain '-': 0.2.4-hotfix.1 becomes 0.2.4.hotfix.1.
sed -i \
  -e "s/^pkgver=.*/pkgver=${version//-/.}/" \
  -e "s/^_upstream_ver=.*/_upstream_ver='${version}'/" \
  "$build_dir/PKGBUILD"
chown -R builder:builder "$build_dir"

log 'Building package'
# --nodeps: runtime depends are resolved by the pacman -U below, which is the point of the test.
(cd "$build_dir" && runuser -u builder -- makepkg --nodeps --noconfirm)
package="$(cd "$build_dir" && runuser -u builder -- makepkg --packagelist)"
[[ -f "$package" ]] || fail "makepkg did not produce $package"

verify_install() {
  local app_dir sandbox mode owner
  app_dir="$(dirname "$(readlink -f /usr/bin/tessera)")"
  [[ -x "$app_dir/tessera" ]] || fail '/usr/bin/tessera does not resolve to the app'
  [[ "$(pacman -Qqo /usr/bin/tessera)" == tessera-bin ]] || fail 'pacman does not own /usr/bin/tessera'
  [[ -f /usr/share/applications/tessera.desktop ]] || fail 'desktop entry missing'

  sandbox="$app_dir/chrome-sandbox"
  mode="$(stat -c '%a' "$sandbox")"
  owner="$(stat -c '%U:%G' "$sandbox")"
  [[ "$mode" == 4755 && "$owner" == root:root ]] \
    || fail "chrome-sandbox is $mode $owner, expected 4755 root:root"

  local missing
  missing="$(find "$app_dir" -type f \( -name tessera -o -name '*.so*' \) -exec ldd {} + 2>/dev/null \
    | grep 'not found' | sort -u || true)"
  [[ -z "$missing" ]] || fail "unresolved libraries (add their packages to depends):
$missing"
}

log "Installing $(basename "$package")"
pacman -U --noconfirm "$package"
verify_install

# Reinstalling runs pacman's upgrade path; file modes must survive it.
log 'Reinstalling to exercise the upgrade path'
pacman -U --noconfirm "$package"
verify_install

log 'Launching the app under Xvfb'
smoke_log="$(mktemp)"
chmod 666 "$smoke_log"
runuser -u builder -- xvfb-run --auto-servernum /usr/bin/tessera >"$smoke_log" 2>&1 &
smoke_pid=$!
ready=false
for _ in $(seq 1 90); do
  # Require a renderer too, so the check covers the window and not only the forked server.
  if curl --silent --max-time 5 --output /dev/null "http://127.0.0.1:${app_port}/" \
    && pgrep -u builder -f -- '--type=renderer' >/dev/null; then
    ready=true
    break
  fi
  kill -0 "$smoke_pid" 2>/dev/null || break
  sleep 2
done
# Kill everything the launch started (xvfb-run, Xvfb, the app) so waiting on it cannot hang.
pkill -KILL -u builder || true
wait "$smoke_pid" 2>/dev/null || true
if [[ "$ready" != true ]]; then
  tail -n 80 "$smoke_log" >&2
  fail "the app did not answer on port ${app_port} with a live renderer"
fi
echo "The app answered on port ${app_port} with a live renderer"

cp "$package" "$output"
if [[ -n "${HOST_UID:-}" ]]; then
  chown "${HOST_UID}:${HOST_GID:-$HOST_UID}" "$output"
fi
log "Wrote ${output#"$work_dir"/}"
