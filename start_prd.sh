#!/bin/bash

PORT="${1:-3000}"

# Stop an existing listener on the requested port.
pids=$(lsof -t -i :"$PORT" -sTCP:LISTEN 2>/dev/null)
if [ -n "$pids" ]; then
  echo "Stopping existing process on port $PORT (PID: $pids)"
  echo "$pids" | xargs kill -9
  sleep 1
fi

# Remove stale build output before creating a production build.
rm -rf .next

echo "Building production bundle..."
NODE_ENV=production npm run build
if [ $? -ne 0 ]; then
  echo "Build failed. Fix the error and try again."
  exit 1
fi

echo "Starting production server on port $PORT..."
PORT="$PORT" npm start
