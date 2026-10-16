#!/usr/bin/env bash
# Install footprint per tool for a React + TS app: packages in node_modules and disk size.
# Usage: footprint.sh <lunx tarball>
set -u
TARBALL="$1"
WORK=$(mktemp -d /tmp/lunx-footprint-XXXX)
declare -A SETS=(
  [lunx]="$TARBALL"
  [vite]="vite @vitejs/plugin-react"
  [rsbuild]="@rsbuild/core @rsbuild/plugin-react"
  [farm]="@farmfe/core @farmfe/cli @farmfe/plugin-react"
  [rspack]="@rspack/core @rspack/cli @rspack/dev-server"
  [webpack]="webpack webpack-cli webpack-dev-server html-webpack-plugin swc-loader @swc/core css-loader style-loader"
  [parcel]="parcel"
  [esbuild]="esbuild"
  [bun]="bun"
)
for tool in lunx vite rsbuild farm rspack webpack parcel esbuild bun; do
  d="$WORK/$tool"; mkdir -p "$d"; echo '{"name":"fp","private":true}' > "$d/package.json"
  (cd "$d" && npm install --silent --no-fund --no-audit --ignore-scripts=false ${SETS[$tool]} >/dev/null 2>&1)
  pkgs=$(cd "$d" && npm ls --all --parseable 2>/dev/null | sort -u | grep -c node_modules)
  size=$(du -sm "$d/node_modules" | cut -f1)
  echo "$tool packages=$pkgs disk=${size}MB"
done
rm -rf "$WORK"
