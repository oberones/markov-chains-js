#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

test_image="${1:?Usage: bash scripts/container-smoke.sh IMAGE}"
export MARKOV_PORT="${MARKOV_PORT:-18091}"
project="markov-smoke-$$"
compose_override=$(mktemp)
compose=(docker compose --file deploy/compose.production.yml --file "$compose_override" --project-name "$project")
network_created=false
proxy_created=false
proxy_config=$(mktemp)
cleanup() {
  if [[ "$proxy_created" == true ]]; then docker rm -f "$project-proxy" >/dev/null || true; fi
  "${compose[@]}" logs || true
  "${compose[@]}" down --timeout 10 || true
  if [[ "$network_created" == true ]]; then docker network rm "$project" >/dev/null || true; fi
  rm -f "$proxy_config" "$compose_override"
}
trap cleanup EXIT
# Production values are fixed. Only this temporary test override isolates CI.
node --input-type=module - "$test_image" "$project" > "$compose_override" <<'JS'
const [image, project] = process.argv.slice(2);
console.log(JSON.stringify({
  services: { 'markov-playground-js': { image, container_name: `${project}-app` } },
  networks: { 'web-backend': { name: project } }
}));
JS
"${compose[@]}" config --quiet
docker network create "$project" >/dev/null
network_created=true
"${compose[@]}" up --detach --no-build --pull never --wait --wait-timeout 120
"${compose[@]}" exec -T markov-playground-js nginx -t
test "$("${compose[@]}" exec -T markov-playground-js id -u)" = 101
node scripts/container-http.mjs "http://127.0.0.1:$MARKOV_PORT/"

# Exercise the documented prefix against a real proxy on the isolated network.
cat > "$proxy_config" <<'NGINX'
worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events { worker_connections 128; }
http {
    access_log /dev/stdout;
    client_body_temp_path /tmp/client_temp;
    proxy_temp_path /tmp/proxy_temp;
    fastcgi_temp_path /tmp/fastcgi_temp;
    uwsgi_temp_path /tmp/uwsgi_temp;
    scgi_temp_path /tmp/scgi_temp;
    server {
        listen 8080;
        absolute_redirect off;
NGINX
cat deploy/nginx-location.conf.example >> "$proxy_config"
printf '\n    }\n}\n' >> "$proxy_config"
chmod 644 "$proxy_config"
docker run --detach --name "$project-proxy" --platform linux/amd64 \
  --network "$project" --user 101:101 --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
  --mount "type=bind,src=$proxy_config,dst=/etc/nginx/nginx.conf,readonly" \
  --publish 127.0.0.1::8080 --no-healthcheck "$test_image" >/dev/null
proxy_created=true
proxy_port=$(docker port "$project-proxy" 8080/tcp)
proxy_url="http://$proxy_port/apps/markov-playground-js/"
for attempt in {1..30}; do
  if curl --silent --fail "$proxy_url" >/dev/null; then break; fi
  if [[ "$attempt" == 30 ]]; then docker logs "$project-proxy"; exit 1; fi
  sleep 1
done
node scripts/container-http.mjs "$proxy_url"
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "${proxy_url%/}")" = 308
test "$(curl --silent --output /dev/null --write-out '%{redirect_url}' "${proxy_url%/}")" = "$proxy_url"
