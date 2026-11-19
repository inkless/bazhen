#!/usr/bin/env bash
# A disposable libvirt VM for the long holder soak: docs/standards/testing.md, "Runbook: a long run
# on a VM". Run it as `moon run :soak-vm -- <command>`; `moon run :soak-vm -- help` lists the commands.
#
# The disposable marker, the soak and its holders exist only inside the VM. Each ssh session that
# provisions the VM, marks it or starts the soak first proves, in that same session, that the far
# end is the VM this script created: its hostname, a machine-id that isn't this host's, and the
# instance token `create` gave it through cloud-init. This script signals no process; the only
# power-off is `destroy`'s, of the VM, after a typed confirmation.
set -euo pipefail
shopt -s inherit_errexit
export LC_ALL=C
# Under pipefail, `cmd | grep -q` fails when grep exits before cmd has written everything, so
# output is captured first and matched after, never piped into an early-exiting reader.

VM=bazhen-soak
VM_USER=soak
REPO_URL=https://github.com/inkless/bazhen.git
VCPUS=4
MEM_MIB=8192
DISK=30G
POOL=default
NET=default
IMG_BASE_URL=https://cloud-images.ubuntu.com/noble/current
IMG_NAME=noble-server-cloudimg-amd64.img
CLOUD_KEYRING=/usr/share/keyrings/ubuntu-cloudimage-keyring.gpg
INSTANCE_FILE=/etc/bazhen-soak-instance
SETUP_PACKAGES=(qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients virtinst
  cloud-image-utils gpgv)
# Ships the keyring file the cloud image's checksums are signed against.
KEYRING_PACKAGE=ubuntu-keyring

STATE="${XDG_DATA_HOME:-$HOME/.local/share}/bazhen-soak"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/bazhen-soak"
KEY="$HOME/.ssh/bazhen-soak"
KNOWN_HOSTS="$STATE/known_hosts"
TOKEN_FILE="$STATE/instance"
VIRSH=(virsh -c qemu:///system)

log() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[33mwarning: %s\033[0m\n' "$*" >&2; }
die() {
  printf '\033[31merror: %s\033[0m\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
usage: moon run :soak-vm -- <command> [options]

  setup                     install KVM and libvirt on this host (sudo, asks first; once)
  create [--commit SHA]     make the VM, then provision it at SHA (default: main on GitHub)
  provision [--commit SHA]  re-run the in-VM provisioning of a VM no soak has started on
  start [--profile P] [--hours N]
                            mark the VM disposable and start an N-hour soak in it: P is gate
                            (default) or long-life, the gate's without daemon restarts; N is 24
                            by default
  status                    whether the soak is alive, when it ends, and its log's tail
  collect [--to DIR]        copy the run's directory and log to this host
  destroy                   power off and delete the VM and its disks (asks first)
  ssh [CMD...]              a shell, or one command, in the VM
EOF
}

# --- host side ------------------------------------------------------------------------------

need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found; run: moon run :soak-vm -- setup"; }

confirm() {
  local answer=""
  read -r -p "$1 [y/N] " answer
  [[ $answer == [yY] || $answer == [yY][eE][sS] ]]
}

in_libvirt_group() {
  local groups
  groups=" $(id -nG "$@") "
  [[ $groups == *" libvirt "* ]]
}

# Group membership from `setup` reaches only new logins; until then, re-run under `sg libvirt`.
ensure_libvirt_group() {
  if in_libvirt_group; then return; fi
  if [[ -z ${BAZHEN_SOAK_SG:-} ]] && in_libvirt_group "$USER"; then
    log "Not in group libvirt in this login yet; re-running under 'sg libvirt'"
    export BAZHEN_SOAK_SG=1
    exec sg libvirt -c "$(printf '%q ' "$0" "${ORIG_ARGS[@]}")"
  fi
  die "user $USER is not in group libvirt; run: moon run :soak-vm -- setup"
}

host_prereqs() {
  [[ $(uname -m) == x86_64 ]] || die "the VM boots an amd64 image with KVM, so the host must be x86_64"
  ensure_libvirt_group
  need virsh
}

cmd_setup() {
  [[ $EUID -ne 0 ]] || die "run as your own user; the script calls sudo itself"
  local packages=("${SETUP_PACKAGES[@]}")
  [[ -f $CLOUD_KEYRING ]] || packages+=("$KEYRING_PACKAGE")
  cat >&2 <<EOF
This changes the host, with sudo:
  - apt-get install ${packages[*]}
  - usermod -aG libvirt,kvm $USER
  - systemctl enable --now libvirtd
EOF
  confirm "Proceed?" || die "not confirmed; nothing changed"
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"
  sudo usermod -aG libvirt,kvm "$USER"
  sudo systemctl enable --now libvirtd
  log "Setup done."
  if ! in_libvirt_group; then
    cat >&2 <<EOF
This login doesn't carry the libvirt group yet. The script re-runs itself under 'sg libvirt', so
it works now; plain 'virsh' in this shell needs a new login or 'newgrp libvirt'.
EOF
  fi
}

ensure_key() {
  [[ -f $KEY ]] && return
  log "Generating a dedicated ssh key at $KEY (no passphrase: it opens only the throwaway VM)"
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  ssh-keygen -q -t ed25519 -N '' -C "bazhen-soak@$(hostname)" -f "$KEY"
}

ensure_network() {
  if ! "${VIRSH[@]}" net-info "$NET" >/dev/null 2>&1; then
    [[ -f /usr/share/libvirt/networks/default.xml ]] || die "libvirt network '$NET' is missing"
    "${VIRSH[@]}" net-define /usr/share/libvirt/networks/default.xml >/dev/null
  fi
  local info
  info=$("${VIRSH[@]}" net-info "$NET")
  if ! [[ $info =~ (^|$'\n')Active:[[:space:]]+yes ]]; then
    "${VIRSH[@]}" net-start "$NET" >/dev/null
  fi
  "${VIRSH[@]}" net-autostart "$NET" >/dev/null
}

ensure_pool() {
  if ! "${VIRSH[@]}" pool-info "$POOL" >/dev/null 2>&1; then
    "${VIRSH[@]}" pool-define-as "$POOL" dir --target /var/lib/libvirt/images >/dev/null
    "${VIRSH[@]}" pool-build "$POOL" >/dev/null || true
  fi
  local info
  info=$("${VIRSH[@]}" pool-info "$POOL")
  if ! [[ $info =~ (^|$'\n')State:[[:space:]]+running ]]; then
    "${VIRSH[@]}" pool-start "$POOL" >/dev/null
  fi
  "${VIRSH[@]}" pool-autostart "$POOL" >/dev/null
  "${VIRSH[@]}" pool-refresh "$POOL" >/dev/null
}

vol_exists() { "${VIRSH[@]}" vol-info --pool "$POOL" "$1" >/dev/null 2>&1; }
vm_exists() { "${VIRSH[@]}" dominfo "$VM" >/dev/null 2>&1; }
vm_running() { [[ $("${VIRSH[@]}" domstate "$VM" 2>/dev/null) == running ]]; }
vm_volumes() {
  local v
  for v in "$VM.qcow2" "$VM-seed.iso"; do
    if vol_exists "$v"; then printf '%s\n' "$v"; fi
  done
}

# The token `create` minted for the VM it made, or nothing: a VM without one isn't this script's.
host_token() { [[ -s $TOKEN_FILE ]] && tr -d '[:space:]' <"$TOKEN_FILE"; }
require_token() {
  local t
  t=$(host_token) || true
  [[ $t =~ ^[0-9a-f-]{36}$ ]] || die "VM $VM has no instance token in $TOKEN_FILE, so this script \
didn't create it; refusing to touch it. Once whoever made it is done with it, destroy it and run: \
moon run :soak-vm -- create"
  printf '%s\n' "$t"
}

# The token, once the domain named $VM shows it carries it too: create puts it in the description.
require_ours() {
  local t desc
  t=$(require_token)
  desc=$("${VIRSH[@]}" desc "$VM" 2>/dev/null) || desc=""
  [[ $desc == *"$t"* ]] || die "VM $VM does not carry this script's instance token, so something \
else created it; refusing to touch it. Remove it with whatever made it, or by hand with virsh."
  printf '%s\n' "$t"
}

# The SHA-256 of a pool volume's bytes, read back through libvirt.
vol_sha256() {
  local tmp="$CACHE/readback.part"
  "${VIRSH[@]}" vol-download --pool "$POOL" "$1" "$tmp" >&2
  local sum
  sum=$(sha256sum "$tmp")
  rm -f "$tmp"
  printf '%s\n' "${sum%% *}"
}

# Downloads the current noble cloud image, checks SHA256SUMS's signature and the image against
# it, and uploads it into the pool once as noble-<sha12>.qcow2. A volume of that name is reused
# only if its bytes still hash to the image's: an upload cut short leaves one that doesn't.
# Prints the volume's name.
ensure_base_volume() {
  [[ -f $CLOUD_KEYRING ]] || die "no $CLOUD_KEYRING to check the cloud image's signature with; \
it comes with $KEYRING_PACKAGE: run 'moon run :soak-vm -- setup', or sudo apt-get install $KEYRING_PACKAGE"
  need gpgv
  mkdir -p "$CACHE"
  log "Fetching $IMG_BASE_URL/SHA256SUMS and its signature"
  curl -fsSL -o "$CACHE/SHA256SUMS" "$IMG_BASE_URL/SHA256SUMS"
  curl -fsSL -o "$CACHE/SHA256SUMS.gpg" "$IMG_BASE_URL/SHA256SUMS.gpg"
  gpgv --keyring "$CLOUD_KEYRING" "$CACHE/SHA256SUMS.gpg" "$CACHE/SHA256SUMS" 2>/dev/null \
    || die "SHA256SUMS signature does not verify against $CLOUD_KEYRING"
  local want
  want=$(awk -v f="$IMG_NAME" '$2 == f || $2 == "*" f { print $1 }' "$CACHE/SHA256SUMS")
  [[ $want =~ ^[0-9a-f]{64}$ ]] || die "no checksum for $IMG_NAME in SHA256SUMS"
  local vol="noble-${want:0:12}.qcow2"
  if vol_exists "$vol"; then
    log "Checking the base image $vol already in pool '$POOL'"
    [[ $(vol_sha256 "$vol") == "$want" ]] || die "volume $vol in pool '$POOL' doesn't match \
$IMG_NAME's checksum (an upload cut short?). Once no VM uses it as a backing file, delete it with: \
virsh -c qemu:///system vol-delete --pool $POOL $vol"
    printf '%s\n' "$vol"
    return
  fi
  local img="$CACHE/$IMG_NAME" have
  have=$(sha256sum "$img" 2>/dev/null) || have=""
  if [[ ${have%% *} != "$want" ]]; then
    log "Downloading $IMG_NAME"
    curl -fL --retry 3 -o "$img.part" "$IMG_BASE_URL/$IMG_NAME"
    mv "$img.part" "$img"
    have=$(sha256sum "$img")
    [[ ${have%% *} == "$want" ]] || die "$IMG_NAME fails its SHA256 check"
  fi
  log "Image checksum OK; uploading to pool '$POOL' as $vol"
  local size
  size=$(stat -c %s "$img")
  "${VIRSH[@]}" vol-create-as "$POOL" "$vol" "$size" --format qcow2 >/dev/null
  "${VIRSH[@]}" vol-upload --pool "$POOL" "$vol" "$img" >&2
  "${VIRSH[@]}" pool-refresh "$POOL" >/dev/null
  [[ $(vol_sha256 "$vol") == "$want" ]] || die "volume $vol doesn't match $IMG_NAME after upload"
  printf '%s\n' "$vol"
}

make_seed() {
  local token="$1" dir="$STATE/seed"
  mkdir -p "$dir"
  local pub
  pub=$(<"$KEY.pub")
  cat >"$dir/user-data" <<EOF
#cloud-config
hostname: $VM
manage_etc_hosts: true
ssh_pwauth: false
users:
  - name: $VM_USER
    shell: /bin/bash
    groups: [sudo]
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    lock_passwd: true
    ssh_authorized_keys:
      - $pub
write_files:
  - path: $INSTANCE_FILE
    owner: root:root
    permissions: "0644"
    content: |
      $token
EOF
  cat >"$dir/meta-data" <<EOF
instance-id: $VM-$token
local-hostname: $VM
EOF
  cloud-localds "$dir/seed.iso" "$dir/user-data" "$dir/meta-data" >&2
  printf '%s\n' "$dir/seed.iso"
}

os_variant() {
  local list
  list=$(virt-install --osinfo list 2>/dev/null) || true
  if [[ $list =~ (^|[[:space:],])ubuntu24\.04([[:space:],]|$) ]]; then
    echo ubuntu24.04
  else
    echo linux2022
  fi
}

vm_ip() {
  local leases ip
  leases=$("${VIRSH[@]}" domifaddr "$VM" --source lease 2>/dev/null) || return 0
  ip=$(awk '$3 == "ipv4" && !found { sub(/\/.*/, "", $4); print $4; found = 1 }' <<<"$leases")
  [[ -z $ip || $ip =~ ^([0-9]{1,3}[.]){3}[0-9]{1,3}$ ]] || die "libvirt leased $VM '$ip', not an IPv4 address"
  printf '%s\n' "$ip"
}

wait_ip() {
  local ip i
  for ((i = 0; i < 90; i++)); do
    ip=$(vm_ip) || exit 1
    if [[ -n $ip ]]; then
      printf '%s\n' "$ip"
      return
    fi
    sleep 2
  done
  die "VM got no IPv4 lease on network '$NET' within 3 minutes"
}

SSH_OPTS=()
TARGET=""
TOKEN=""
HOST_ID_SHA=""
init_ssh() {
  TOKEN=$(require_ours)
  vm_running || die "VM $VM is not running; start it with: virsh -c qemu:///system start $VM"
  [[ -f $KEY ]] || die "no ssh key at $KEY; run: moon run :soak-vm -- create"
  need ssh
  [[ $(hostname) != "$VM" ]] || die "this host itself is named '$VM'; refusing"
  HOST_ID_SHA=$(sha256sum </etc/machine-id)
  HOST_ID_SHA=${HOST_ID_SHA%% *}
  local ip
  ip=$(wait_ip)
  # No ~/.ssh/config: a Host * rule there could forward the host's agent or X into the VM.
  SSH_OPTS=(-F /dev/null -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10
    -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$KNOWN_HOSTS"
    -o ForwardAgent=no -o ForwardX11=no -o ControlMaster=no -o ControlPath=none
    -o ServerAliveInterval=30)
  TARGET="$VM_USER@$ip"
}

# Each argument reaches the VM's shell as one word. Nothing from this host's stdin goes with it.
vm_ssh() {
  local cmd
  cmd=$(printf '%q ' "$@")
  ssh "${SSH_OPTS[@]}" -- "$TARGET" "$cmd" </dev/null
}

wait_ssh() {
  local i
  for ((i = 0; i < 60; i++)); do
    if vm_ssh true 2>/dev/null; then return; fi
    sleep 5
  done
  die "ssh to $TARGET did not come up within 5 minutes"
}

# Prefixed to every script run in the VM, so the identity check and the action share one session.
# Its arguments are the VM's expected hostname, the SHA-256 of this host's machine-id (which is
# meant to stay on the machine, and arguments are readable to every process in the VM), the
# instance token and the file the VM keeps its token in.
VM_GUARD=$(cat <<'REMOTE'
set -euo pipefail
want_host="$1"; host_id_sha="$2"; token="$3"; instance_file="$4"; shift 4
refuse() { echo "refusing: $*" >&2; exit 97; }
[[ "$(hostname)" == "$want_host" ]] || refuse "the VM says hostname $(hostname), not $want_host"
id_sha=$(sha256sum < /etc/machine-id)
[[ "${id_sha%% *}" != "$host_id_sha" ]] || refuse "the VM has the host's machine-id"
[[ -r "$instance_file" && "$(tr -d "[:space:]" < "$instance_file")" == "$token" ]] \
  || refuse "the VM's instance token is not the one create gave it"
REMOTE
)

# Runs a script in the VM after the guard above: vm_run SCRIPT [ARG...]. The script goes as an
# argument, not on stdin, where any command in it that reads stdin would eat the rest of it.
vm_run() {
  local body="$1"
  shift
  vm_ssh bash -c "$VM_GUARD"$'\n'"$body" bash "$VM" "$HOST_ID_SHA" "$TOKEN" "$INSTANCE_FILE" "$@"
}

# The identity check alone, for commands that only read from the VM.
assert_vm() { vm_run 'true' || die "the ssh target at $TARGET is not $VM; refusing"; }

resolve_commit() {
  local c="$1"
  if [[ -z $c ]]; then
    c=$(git ls-remote "$REPO_URL" refs/heads/main)
    c=${c%%[[:space:]]*}
    [[ $c =~ ^[0-9a-f]{40}$ ]] || die "could not resolve main on $REPO_URL with git ls-remote"
    log "Commit under test: main = $c"
  fi
  printf '%s\n' "$c"
}

cmd_create() {
  local commit="$1"
  host_prereqs
  need virt-install
  need cloud-localds
  need curl
  need ssh-keygen
  if vm_exists; then
    require_ours >/dev/null
    log "VM $VM already exists; resuming its provisioning"
    if ! vm_running; then "${VIRSH[@]}" start "$VM" >/dev/null; fi
  else
    local left
    left=$(vm_volumes)
    [[ -z $left ]] || die "pool '$POOL' still holds $(echo "$left" | paste -sd' ') from an \
earlier VM; remove them with: moon run :soak-vm -- destroy"
    commit=$(resolve_commit "$commit")
    ensure_key
    mkdir -p "$STATE"
    ensure_network
    ensure_pool
    local base base_path token seed seed_size variant
    base=$(ensure_base_volume)
    base_path=$("${VIRSH[@]}" vol-path --pool "$POOL" "$base")
    token=$(</proc/sys/kernel/random/uuid)
    # Before any volume exists, so volumes left by a create that fails are ones destroy can tell
    # this script made.
    printf '%s\n' "$token" >"$TOKEN_FILE"
    log "Creating a $DISK qcow2 overlay on $base"
    "${VIRSH[@]}" vol-create-as "$POOL" "$VM.qcow2" "$DISK" --format qcow2 \
      --backing-vol "$base_path" --backing-vol-format qcow2 >/dev/null
    seed=$(make_seed "$token")
    seed_size=$(stat -c %s "$seed")
    "${VIRSH[@]}" vol-create-as "$POOL" "$VM-seed.iso" "$seed_size" --format raw >/dev/null
    "${VIRSH[@]}" vol-upload --pool "$POOL" "$VM-seed.iso" "$seed"
    rm -f "$KNOWN_HOSTS"
    variant=$(os_variant)
    log "Defining and booting $VM ($VCPUS vCPU, $MEM_MIB MiB, network '$NET')"
    virt-install --connect qemu:///system --name "$VM" \
      --metadata "description=bazhen-soak instance $token" \
      --memory "$MEM_MIB" --vcpus "$VCPUS" --cpu host-passthrough \
      --os-variant "$variant" --import \
      --disk "vol=$POOL/$VM.qcow2,bus=virtio" \
      --disk "vol=$POOL/$VM-seed.iso,device=cdrom" \
      --network "network=$NET,model=virtio" \
      --graphics none --noautoconsole
    "${VIRSH[@]}" autostart --disable "$VM" >/dev/null 2>&1 || true
  fi
  commit=$(resolve_commit "$commit")
  provision "$commit"
}

cmd_provision() {
  local commit="$1"
  host_prereqs
  vm_exists || die "no VM $VM; run: moon run :soak-vm -- create"
  commit=$(resolve_commit "$commit")
  provision "$commit"
}

provision() {
  local commit="$1"
  [[ $commit =~ ^[0-9a-f]{7,40}$ ]] || die "no commit to provision at, got '$commit'"
  init_ssh
  log "Waiting for ssh on $TARGET"
  wait_ssh
  log "Waiting for cloud-init to finish"
  local rc=0
  vm_ssh cloud-init status --wait >/dev/null || rc=$?
  case $rc in
    0) ;;
    2) warn "cloud-init finished with recoverable errors; continuing" ;;
    *) die "cloud-init failed in the VM (exit $rc); see: moon run :soak-vm -- ssh sudo cloud-init status --long" ;;
  esac
  log "Provisioning the VM at $commit (apt, rustup, clone, Node, pnpm, moon, install, build)"
  vm_run "$PROVISION" "$commit" "$REPO_URL"
}

PROVISION=$(cat <<'REMOTE'
commit="$1"; repo_url="$2"
export DEBIAN_FRONTEND=noninteractive
say() { printf "  [vm] %s\n" "$*"; }

if [[ -e /etc/bazhen-disposable-host || -e "$HOME/soak-run" ]]; then
  refuse "a soak was already started on this VM; collect, destroy and create a fresh one"
fi

say "checking outbound network"
curl -fsSI --max-time 15 https://nodejs.org/ >/dev/null || {
  echo "The VM cannot reach the internet. Docker on the host can set a FORWARD DROP policy that" >&2
  echo "blocks libvirt NAT; restart libvirtd (sudo systemctl restart libvirtd) and retry." >&2
  exit 1
}

say "apt packages"
sudo apt-get update -q
sudo apt-get install -y -q git build-essential tmux curl ca-certificates xz-utils >/dev/null

# The run lives in the soak user's sessions; keep its user manager up after the ssh logs out.
sudo loginctl enable-linger "$USER"

if [[ ! -x "$HOME/.cargo/bin/rustup" ]]; then
  say "rustup"
  curl --proto "=https" --tlsv1.2 -fsSL https://sh.rustup.rs \
    | sh -s -- -y -q --profile minimal --default-toolchain none --no-modify-path
fi
. "$HOME/.cargo/env"

if [[ ! -d "$HOME/bazhen/.git" ]]; then
  say "cloning $repo_url"
  git clone -q "$repo_url" "$HOME/bazhen"
fi
cd "$HOME/bazhen"
git fetch -q origin
git cat-file -e "$commit^{commit}" 2>/dev/null || git fetch -q origin "$commit"
full=$(git rev-parse --verify "$commit^{commit}")
git -c advice.detachedHead=false checkout -q --detach "$full"
say "checked out $full"

say "the Rust toolchain rust-toolchain.toml pins"
rustup toolchain install
rustc --version

case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64) node_arch=arm64 ;;
  *) echo "no Node build for $(uname -m)" >&2; exit 1 ;;
esac
node_version=$(tr -d " \r\nv" < .nvmrc)
if [[ "$(node --version 2>/dev/null || true)" != "v$node_version" ]]; then
  say "Node $node_version from nodejs.org"
  tmp=$(mktemp -d)
  tarball="node-v$node_version-linux-$node_arch.tar.xz"
  curl -fsSL -o "$tmp/$tarball" "https://nodejs.org/dist/v$node_version/$tarball"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$node_version/SHASUMS256.txt"
  (cd "$tmp" && grep "  $tarball\$" SHASUMS256.txt | sha256sum -c --quiet -) \
    || { echo "the Node tarball fails its SHASUMS256 check" >&2; exit 1; }
  sudo tar -C /usr/local --strip-components=1 --no-same-owner -xJf "$tmp/$tarball"
  rm -rf "$tmp"
fi
[[ "$(node --version)" == "v$node_version" ]] || { echo "node is $(node --version)" >&2; exit 1; }

pnpm_version=$(sed -n "s/^ *\"packageManager\": *\"pnpm@\([0-9][0-9.]*\)\".*/\1/p" package.json)
[[ -n "$pnpm_version" ]] || { echo "no pnpm version in package.json packageManager" >&2; exit 1; }
if [[ "$(pnpm --version 2>/dev/null || true)" != "$pnpm_version" ]]; then
  say "pnpm $pnpm_version"
  sudo npm install -g --silent "pnpm@$pnpm_version"
fi

say "pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile
# moon is the lockfile's native binary, at the version .prototools pins, linked onto PATH.
moon_version=$(sed -n 's/^moon = "\([0-9][0-9.]*\)"$/\1/p' .prototools)
[[ -n "$moon_version" ]] || { echo "no exact moon version in .prototools" >&2; exit 1; }
sudo ln -sf "$(node -p 'require("@moonrepo/cli/utils").findMoonExe()')" /usr/local/bin/moon
[[ "$(moon --version)" == "moon $moon_version" ]] \
  || { echo "moon is $(moon --version), not $moon_version" >&2; exit 1; }
# moon run :soak builds these too; building now fails provisioning, not the run, on a broken build.
say "building the hook, the CLI and the release holder"
moon run :build-hook
moon run :build-cli
moon run :build-holder-release

printf "%s\n" "$full" > "$HOME/soak-commit"
say "provisioned; commit under test (in ~/soak-commit): $full"
REMOTE
)

cmd_start() {
  local profile="$1" hours="$2"
  host_prereqs
  vm_exists || die "no VM $VM; run: moon run :soak-vm -- create"
  init_ssh
  wait_ssh
  log "Marking the VM disposable and starting a $hours h $profile soak (after an hour's warm-up)"
  vm_run "$START" "$profile" "$hours"
  awake_reminder "$hours"
}

START=$(cat <<'REMOTE'
profile="$1"; hours="$2"
[[ -s "$HOME/soak-commit" ]] || refuse "the VM is not provisioned; run: moon run :soak-vm -- provision"
if [[ -f "$HOME/soak-run" ]]; then
  pid=$(sed -n "s/^pid=//p" "$HOME/soak-run")
  if [[ -n "$pid" && -d "/proc/$pid" ]]; then
    echo "A soak is already running (pid $pid):"; cat "$HOME/soak-run"; exit 0
  fi
  refuse "a soak was already started on this VM and is not running now. A stopped run leaves its
daemon, holders and tmux behind, so collect, then destroy and create a fresh VM"
fi
sudo touch /etc/bazhen-disposable-host
. "$HOME/.cargo/env"
cd "$HOME/bazhen"
name="soak-${profile}-${hours}h"
setsid nohup moon run :soak -- --profile "$profile" --hours "$hours" --out "$HOME/$name" \
  > "$HOME/$name.log" 2>&1 < /dev/null &
pid=$!
cat > "$HOME/soak-run" <<EOF
pid=$pid
profile=$profile
hours=$hours
out=$name
log=$name.log
started=$(date +%s)
commit=$(cat "$HOME/soak-commit")
EOF
sleep 5
if [[ ! -d "/proc/$pid" ]]; then
  echo "The soak exited at once; its log:" >&2; tail -n 40 "$HOME/$name.log" >&2; exit 1
fi
echo "Started pid $pid: moon run :soak -- --profile $profile --hours $hours --out ~/$name (log ~/$name.log)"
echo "Commit under test: $(cat "$HOME/soak-commit")"
REMOTE
)

awake_reminder() {
  local secs
  secs=$(awk -v h="$1" 'BEGIN { printf "%d", (h + 1) * 3600 + 600 }')
  cat >&2 <<EOF

Keep this host awake until the run ends, around $(date -d "@$(($(date +%s) + secs))"): a suspended
host pauses the VM mid-run. One way, in a terminal you leave open:
  systemd-inhibit --what=sleep:idle --why="bazhen soak" sleep $secs
EOF
}

cmd_status() {
  host_prereqs
  vm_exists || die "no VM $VM"
  local state
  state=$("${VIRSH[@]}" domstate "$VM")
  echo "VM state: $state"
  init_ssh
  vm_run "$STATUS"
}

STATUS=$(cat <<'REMOTE'
if [[ ! -f "$HOME/soak-run" ]]; then echo "No soak started yet."; exit 0; fi
get() { sed -n "s/^$1=//p" "$HOME/soak-run"; }
pid=$(get pid); hours=$(get hours); out=$(get out); logf=$(get log); started=$(get started)
now=$(date +%s)
end=$(awk -v s="$started" -v h="$hours" "BEGIN { printf \"%d\", s + (h + 1) * 3600 }")
echo "Commit:   $(get commit)"
profile=$(get profile)
echo "Profile:  ${profile:-gate}"
echo "Started:  $(date -d "@$started")   ($(( (now - started) / 60 )) min ago)"
echo "Expected: $(date -d "@$end")   (warm-up hour + $hours h; keep the host awake until then)"
if [[ -d "/proc/$pid" ]]; then echo "Soak:     ALIVE (pid $pid)"; else echo "Soak:     not running"; fi
if [[ -f "$HOME/$out/verdict.txt" ]]; then
  echo "--- $out/verdict.txt (head) ---"; head -n 40 "$HOME/$out/verdict.txt"
fi
echo "--- load / memory ---"; uptime; free -h | sed -n 1,2p
echo "--- tail ~/$logf ---"; tail -n 30 "$HOME/$logf"
REMOTE
)

cmd_collect() {
  local to="$1"
  host_prereqs
  vm_exists || die "no VM $VM"
  init_ssh
  assert_vm
  local run
  run=$(vm_ssh cat soak-run 2>/dev/null || true)
  [[ -n $run ]] || die "no soak was started in the VM"
  local out logf pid commit
  out=$(sed -n 's/^out=//p' <<<"$run")
  logf=$(sed -n 's/^log=//p' <<<"$run")
  pid=$(sed -n 's/^pid=//p' <<<"$run")
  commit=$(sed -n 's/^commit=//p' <<<"$run")
  [[ $out =~ ^soak-((gate|long-life)-)?[0-9.]+h$ && $logf == "$out.log" ]] ||
    die "unexpected run names '$out', '$logf'"
  [[ $pid =~ ^[0-9]+$ && $commit =~ ^[0-9a-f]{40}$ ]] || die "unexpected soak record: $run"
  if vm_ssh test -d "/proc/$pid"; then
    warn "the soak is still running; this copies a partial snapshot"
  fi
  [[ -n $to ]] || to="$HOME/bazhen-soak-results/${commit:0:12}-$(date +%Y%m%d-%H%M)"
  mkdir -p "$to"
  log "Copying ~/$out, ~/$logf and the run's record into $to"
  scp "${SSH_OPTS[@]}" -r -q "$TARGET:$out" "$to/"
  scp "${SSH_OPTS[@]}" -q "$TARGET:$logf" "$TARGET:soak-commit" "$TARGET:soak-run" "$to/"
  log "Collected into $to"
  if [[ -f "$to/$out/verdict.txt" ]]; then
    echo "--- verdict.txt (head) ---"
    head -n 40 "$to/$out/verdict.txt"
  else
    echo "No verdict.txt yet (the run is still going, or was cut short); judge it with moon run :soak -- --judge."
  fi
}

cmd_destroy() {
  host_prereqs
  local left
  left=$(vm_volumes)
  if ! vm_exists && [[ -z $left ]]; then
    log "No VM $VM and no volumes of one; nothing to destroy"
    rm -f "$KNOWN_HOSTS" "$TOKEN_FILE"
    return
  fi
  if vm_exists; then
    require_ours >/dev/null
    echo "This powers off $VM and deletes it with its disks (the cached base image stays)."
    echo "Collect first if you haven't: moon run :soak-vm -- collect"
  else
    local list
    list=$(paste -sd' ' <<<"$left")
    # With no domain there is no description to prove them this script's; a token on the host
    # says only that this script's last create here never finished.
    [[ -n $(host_token) ]] || die "pool '$POOL' holds $list but there is no VM $VM and no \
instance token on this host, so nothing shows this script made them; refusing. If they are \
yours to remove: virsh -c qemu:///system vol-delete --pool $POOL <volume>"
    echo "There is no VM $VM, but pool '$POOL' holds $list, left by a create of this script's"
    echo "that didn't finish (its instance token is on this host). This deletes exactly those."
  fi
  local typed=""
  read -r -p "Type the VM name ($VM) to confirm: " typed
  [[ $typed == "$VM" ]] || die "not confirmed; nothing changed"
  if vm_exists; then
    if [[ $("${VIRSH[@]}" domstate "$VM") != "shut off" ]]; then "${VIRSH[@]}" destroy "$VM"; fi
    "${VIRSH[@]}" undefine "$VM" --remove-all-storage
  fi
  local v
  for v in $(vm_volumes); do "${VIRSH[@]}" vol-delete --pool "$POOL" "$v" >/dev/null; done
  rm -f "$KNOWN_HOSTS" "$TOKEN_FILE"
  rm -rf "$STATE/seed"
  log "Destroyed $VM"
}

cmd_ssh() {
  host_prereqs
  vm_exists || die "no VM $VM"
  init_ssh
  assert_vm
  if [[ $# -eq 0 ]]; then
    ssh "${SSH_OPTS[@]/BatchMode=yes/BatchMode=no}" -t -- "$TARGET"
  else
    vm_ssh "$@"
  fi
}

main() {
  ORIG_ARGS=("$@")
  [[ $# -gt 0 ]] || {
    usage >&2
    exit 1
  }
  local cmd="$1"
  shift
  case "$cmd" in
    setup | create | provision | start | status | collect | destroy | ssh) ;;
    -h | --help | help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown command '$cmd'"
      ;;
  esac
  if [[ $cmd == ssh ]]; then
    cmd_ssh "$@"
    return
  fi
  local commit="" profile=gate hours=24 to=""
  while [[ $# -gt 0 ]]; do
    case "$cmd:$1" in
      create:--commit | provision:--commit)
        commit="${2:?--commit needs a sha}"
        shift 2
        ;;
      start:--profile)
        profile="${2:?--profile needs a name}"
        shift 2
        ;;
      start:--hours)
        hours="${2:?--hours needs a number}"
        shift 2
        ;;
      collect:--to)
        to="${2:?--to needs a directory}"
        shift 2
        ;;
      *) die "$cmd takes no option '$1'" ;;
    esac
  done
  [[ -z $commit || $commit =~ ^[0-9a-f]{7,40}$ ]] || die "--commit takes a hex sha, not '$commit'"
  [[ $profile == gate || $profile == long-life ]] ||
    die "--profile takes gate or long-life, not '$profile' (smoke runs in moon run :test-real -- soak)"
  if ! [[ $hours =~ ^[0-9]+([.][0-9]+)?$ ]] || ! awk -v h="$hours" 'BEGIN { exit !(h > 0) }'; then
    die "--hours takes a positive number, not '$hours'"
  fi
  case "$cmd" in
    setup) cmd_setup ;;
    create) cmd_create "$commit" ;;
    provision) cmd_provision "$commit" ;;
    start) cmd_start "$profile" "$hours" ;;
    status) cmd_status ;;
    collect) cmd_collect "$to" ;;
    destroy) cmd_destroy ;;
  esac
}

main "$@"
