#!/bin/bash
set -e

pnpm install --frozen-lockfile
rm -rf packages/web/.next
pnpm build
