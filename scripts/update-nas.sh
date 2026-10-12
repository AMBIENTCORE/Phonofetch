#!/bin/sh
set -eu
umask 077

deploy_dir=${PHONOFETCH_DEPLOY_DIR:-/volume2/docker/Phonofetch}
data_dir=${PHONOFETCH_DATA_DIR:-/volume2/docker/phonofetch}
compose_file="$deploy_dir/compose.yaml"
env_file="$deploy_dir/.env"
lock_dir="$deploy_dir/.phonofetch-update.lock"

fail() {
  printf 'Phonofetch update: %s\n' "$*" >&2
  exit 1
}

case "${1:-}" in
  ''|--check) ;;
  *) fail "Usage: sh update.sh [--check]" ;;
esac

for command in docker curl tar mktemp cp date mkdir rmdir sleep; do
  command -v "$command" >/dev/null 2>&1 || fail "Missing command: $command"
done

[ -f "$compose_file" ] || fail "Existing Compose file not found: $compose_file"
[ -f "$env_file" ] || fail "NAS-only environment file not found: $env_file"
[ -s "$data_dir/phonofetch.sqlite" ] || fail "Existing SQLite database not found: $data_dir/phonofetch.sqlite"

project=$(docker inspect phonofetch --format '{{index .Config.Labels "com.docker.compose.project"}}') ||
  fail "Existing phonofetch container not found"
[ "$project" = phonofetch ] || fail "Unexpected Compose project: $project"

working_dir=$(docker inspect phonofetch --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}') ||
  fail "Could not inspect the existing Compose working directory"
[ "$working_dir" = "$deploy_dir" ] || fail "Unexpected Compose working directory: $working_dir"

config_file=$(docker inspect phonofetch --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}') ||
  fail "Could not inspect the existing Compose file"
[ "$config_file" = "$compose_file" ] || fail "Unexpected Compose file: $config_file"

mount=$(docker inspect phonofetch --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}') ||
  fail "Could not inspect the existing data mount"
[ "$mount" = "$data_dir" ] || fail "Unexpected /data mount: $mount"

services=$(docker compose --env-file "$env_file" -f "$compose_file" -p phonofetch config --services) ||
  fail "Could not validate the existing Compose project"
[ "$services" = phonofetch ] || fail "Refusing to update a stack with other services: $services"

configured_image=$(docker compose --env-file "$env_file" -f "$compose_file" -p phonofetch config --images) ||
  fail "Could not resolve the configured image"
[ "$configured_image" = phonofetch:local ] || fail "Expected phonofetch:local, found $configured_image"

running_image=$(docker inspect phonofetch --format '{{.Image}}') ||
  fail "Could not inspect the running image"
[ -n "$running_image" ] || fail "Running image ID is empty"

if [ "${1:-}" = --check ]; then
  printf 'Ready: existing phonofetch Compose project, local image, NAS environment and SQLite data verified.\n'
  exit 0
fi

mkdir "$lock_dir" 2>/dev/null ||
  fail "Another update may be running. Inspect the existing lock before removing it: $lock_dir"
trap 'rmdir "$lock_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

stamp=$(date -u +%Y%m%d%H%M%S)
source_dir=$(mktemp -d "$deploy_dir/source-update-XXXXXXXX") ||
  fail "Could not create a fresh source directory"
backup_dir="$deploy_dir/phonofetch-data-backup-$stamp"
rollback_tag="phonofetch:rollback-$stamp"
[ ! -e "$backup_dir" ] || fail "Backup directory already exists: $backup_dir"

printf 'Downloading current main branch to %s\n' "$source_dir"
curl --fail --location --show-error --silent --retry 3 \
  https://github.com/AMBIENTCORE/Phonofetch/archive/refs/heads/main.tar.gz \
  --output "$source_dir/source.tar.gz" || fail "GitHub source download failed; running container unchanged"
tar -tzf "$source_dir/source.tar.gz" >/dev/null ||
  fail "Downloaded source archive is invalid; running container unchanged"
tar -xzf "$source_dir/source.tar.gz" -C "$source_dir" --strip-components=1 ||
  fail "Could not extract source archive; running container unchanged"
[ -f "$source_dir/Dockerfile" ] && [ -f "$source_dir/package-lock.json" ] ||
  fail "Downloaded source does not contain the Docker build inputs"

docker tag "$running_image" "$rollback_tag" ||
  fail "Could not preserve the running image; running container unchanged"
printf 'Building phonofetch:local; current container remains running.\n'
docker build -t phonofetch:local "$source_dir" ||
  fail "Image build failed; current container remains running ($rollback_tag)"

printf 'Checking that the non-root runtime can read its package and server entry point.\n'
docker run --rm --network none --entrypoint node phonofetch:local -e \
  'const fs = require("node:fs"); JSON.parse(fs.readFileSync("/app/package.json", "utf8")); fs.accessSync("/app/dist/server/main.js", fs.constants.R_OK)' ||
  fail "Built image failed its non-root startup check; current container remains running ($rollback_tag)"

new_image=$(docker image inspect phonofetch:local --format '{{.Id}}') ||
  fail "Could not inspect the built image"
if [ "$new_image" = "$running_image" ]; then
  printf 'Built image is identical to the running image; no redeployment needed.\n'
  exit 0
fi

printf 'Stopping only phonofetch for a consistent SQLite backup.\n'
docker stop phonofetch || fail "Could not stop phonofetch; no deployment attempted"
if ! cp -a "$data_dir" "$backup_dir"; then
  printf 'Backup failed; attempting to restart the existing container.\n' >&2
  docker start phonofetch || fail "Backup failed and existing container could not be restarted"
  fail "Backup failed; existing container restarted, no deployment attempted"
fi
if [ ! -s "$backup_dir/phonofetch.sqlite" ]; then
  docker start phonofetch || fail "Backup incomplete and existing container could not be restarted"
  fail "Backup incomplete; existing container restarted, no deployment attempted"
fi

printf 'Backup: %s\n' "$backup_dir"
printf 'Recreating only the existing phonofetch service.\n'
docker compose --env-file "$env_file" -f "$compose_file" -p phonofetch \
  up -d --no-deps --force-recreate phonofetch ||
  fail "Recreation failed. Inspect the container before using the backup; image: $rollback_tag, backup: $backup_dir"

attempt=0
while [ "$attempt" -lt 30 ]; do
  deployed_image=$(docker inspect phonofetch --format '{{.Image}}') ||
    fail "Container missing after deployment. Image: $rollback_tag, backup: $backup_dir"
  [ "$deployed_image" = "$new_image" ] ||
    fail "Container did not use the new image. Image: $rollback_tag, backup: $backup_dir"
  health=$(docker inspect phonofetch --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}') ||
    fail "Could not inspect container health"
  if [ "$health" = healthy ]; then
    if curl --fail --silent --show-error --max-time 5 \
      http://127.0.0.1:7289/api/health >/dev/null; then
      printf 'Update successful: %s is healthy. Backup: %s\n' "$new_image" "$backup_dir"
      exit 0
    fi
    fail "Container reports healthy, but host port 7289 is unavailable. Backup: $backup_dir"
  fi
  [ "$health" != unhealthy ] ||
    fail "Container is unhealthy. Inspect docker logs phonofetch. Backup: $backup_dir"
  attempt=$((attempt + 1))
  sleep 3
done

fail "Timed out waiting for container health. Inspect docker logs phonofetch. Backup: $backup_dir"
