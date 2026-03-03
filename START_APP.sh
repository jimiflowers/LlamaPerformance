#!/bin/bash
# START_APP.sh - LlamaPerformance Application Startup Script
#
# Default:   builds the frontend, serves everything from Express on port 3001.
# --dev:     skips the build, starts Vite dev server (port 3000) + Express (port 3001).

echo ""
echo "==================================================="
echo "     LlamaPerformance Application Startup"
echo "==================================================="
echo ""

cd "$(dirname "$0")"
PROJECT_DIR=$(pwd)
echo "Project Directory: $PROJECT_DIR"

if [ ! -d "node_modules" ]; then
    echo ""
    echo "Dependencies not installed! Run:"
    echo "  npm run setup"
    exit 1
fi

if [ "$1" = "--dev" ]; then
    echo ""
    echo "Dev mode: starting Vite (port 3000) + Express (port 3001)..."
    echo "Open http://localhost:3000 once both servers are ready."
    echo ""
    npm run dev
else
    echo ""
    echo "Building frontend..."
    npm run build || { echo "Build failed. Aborting."; exit 1; }

    echo ""
    echo "Starting server on port 3001..."
    echo "Open http://localhost:3001 once the server is ready."
    echo ""
    npm run server
fi
