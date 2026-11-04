# Signing policy shared by the iOS scripts (sourced, not executed).
# The two GEWISS teams must never sign, provision or be passed to Xcode, in any mode.
NT_IOS_PROHIBITED_TEAMS="UQBV6LD494 DM6V8H4Q6Q"

nt_ios_reject_prohibited() {
  local value="$1" what="$2" team
  for team in $NT_IOS_PROHIBITED_TEAMS; do
    if [[ "$value" == *"$team"* ]]; then
      echo "ios: $what names $team; GEWISS signing teams are prohibited" >&2
      exit 1
    fi
  done
}

# nt_ios_check_team <mode>: refuse prohibited teams everywhere; require a well-formed own team
# for any signed device mode.
nt_ios_check_team() {
  local mode="$1" var
  for var in NT_IOS_TEAM DEVELOPMENT_TEAM; do nt_ios_reject_prohibited "${!var:-}" "$var"; done
  case "$mode" in
    device|device-build|device-accept)
      [[ -n "${NT_IOS_TEAM:-}" ]] || { echo 'ios: set NT_IOS_TEAM to your own Apple developer team id' >&2; exit 1; }
      [[ "$NT_IOS_TEAM" =~ ^[A-Z0-9]{10}$ ]] || { echo 'ios: invalid Apple developer team id' >&2; exit 1; } ;;
  esac
}

# nt_ios_verify_signature <app>: the signed bundle must carry exactly NT_IOS_TEAM.
nt_ios_verify_signature() {
  local app="$1" team
  team="$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  nt_ios_reject_prohibited "$team" "signed bundle"
  [[ "$team" == "$NT_IOS_TEAM" ]] || { echo "ios: bundle signed by '$team', expected $NT_IOS_TEAM" >&2; exit 1; }
  echo "ios: signature team $team"
}
