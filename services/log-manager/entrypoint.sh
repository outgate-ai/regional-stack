#!/bin/sh

set -e

echo "[$(date +'%Y-%m-%d %H:%M:%S')] Starting Log Manager service..."
exec node dist/services/log-manager/src/index.js