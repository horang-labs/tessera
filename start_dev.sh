#!/bin/bash
PORT=${1:?Usage: ./start_dev.sh <port>}

PID=$(lsof -t -i :"$PORT" -sTCP:LISTEN 2>/dev/null)
if [ -n "$PID" ]; then
  echo "Killing existing process on port $PORT (PID: $PID)"
  kill -9 "$PID"
  sleep 1
fi

echo "Starting dev server on port $PORT..."
NODE_ENV=development PORT="$PORT" npx tsx server.ts
