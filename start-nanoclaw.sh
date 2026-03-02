#!/bin/bash
cd /Users/sovereign/sovereign-stack/nanoclaw
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/sovereign/.local/bin"
export HOME="/Users/sovereign"
export NODE_OPTIONS="--max-old-space-size=4096"
mkdir -p logs
nohup /opt/homebrew/bin/node dist/index.js >> logs/nanoclaw.log 2>> logs/nanoclaw.error.log &
echo $! > logs/nanoclaw.pid
echo "NanoClaw started (PID: $!)"
