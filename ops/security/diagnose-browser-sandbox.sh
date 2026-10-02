#!/bin/sh
# Diagnose: hvorfor starter ikke Chromium med `chromiumSandbox:true` i browser-gateway-containeren?
# Kjører KORTLIVEDE, isolerte probe-containere (`docker run --rm`, ingen nettverkstilgang til noe, ingen volumer) fra det
# allerede bygde imaget med ulike sikkerhetsflagg. ENDRER INGENTING i den kjørende stacken eller compose-filen.
# Bruk (fra repo-roten):  sh ops/security/diagnose-browser-sandbox.sh [image]
set -u
IMG="${1:-local-browser-gateway}"
PROFILE="infra/local/browser-gateway.seccomp.json"
[ -f "$PROFILE" ] || { echo "kjør fra repo-roten ($PROFILE finnes ikke)"; exit 2; }

PROBE='import { chromium } from "playwright";
try {
  const b = await chromium.launch({ headless: true, chromiumSandbox: true, args: ["--disable-dev-shm-usage"] });
  await b.close();
  console.log("RESULT=OK");
} catch (e) {
  const lines = String(e.message).split("\n").filter((l) => !l.includes("<launching>") && l.trim() !== "");
  console.log("RESULT=FAIL " + lines.slice(0, 16).join(" | ").slice(0, 1400));
}'

probe() {
  label="$1"; shift
  echo "== $label"
  docker run --rm --network none --user pwuser -e HOME=/home/pwuser --read-only --tmpfs /tmp:rw,nosuid,size=512m \
    -w /app/apps/browser-gateway "$@" "$IMG" node --input-type=module -e "$PROBE" 2>&1 | grep -E "RESULT=" | cut -c1-1500
}

echo "--- vert"
uname -r
echo "apparmor_restrict_unprivileged_userns=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo n/a)"
echo "unprivileged_userns_clone=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo n/a)"
echo "kjørende container AppArmorProfile=$(docker inspect -f '{{.AppArmorProfile}}' local-browser-gateway-1 2>/dev/null || echo n/a)"
docker version --format 'docker={{.Server.Version}}' 2>/dev/null

echo "--- prober (A = nåværende compose-oppsett)"
probe "A: cap_drop ALL + no-new-privileges + seccomp-profil"        --cap-drop ALL --security-opt no-new-privileges:true --security-opt "seccomp=$PROFILE"
probe "B: A + apparmor=unconfined"                                  --cap-drop ALL --security-opt no-new-privileges:true --security-opt "seccomp=$PROFILE" --security-opt apparmor=unconfined
probe "C: A uten cap_drop ALL"                                      --security-opt no-new-privileges:true --security-opt "seccomp=$PROFILE"
probe "D: A uten no-new-privileges"                                 --cap-drop ALL --security-opt "seccomp=$PROFILE"
probe "E: A + --ipc=host"                                           --cap-drop ALL --security-opt no-new-privileges:true --security-opt "seccomp=$PROFILE" --ipc=host
probe "F: A + cap_add SYS_CHROOT (minste kandidat)"                 --cap-drop ALL --cap-add SYS_CHROOT --security-opt no-new-privileges:true --security-opt "seccomp=$PROFILE"
probe "G: A + cap_add SYS_CHROOT,SETUID,SETGID"                      --cap-drop ALL --cap-add SYS_CHROOT --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges:true --security-opt "seccomp=$PROFILE"
echo "--- ferdig (ingen endringer gjort)"
