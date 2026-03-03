#!/bin/bash
# START_APP.sh - LlamaPerformance Application Startup Script

echo ""
echo "==================================================="
echo "     LlamaPerformance Application Startup"
echo "==================================================="
echo ""

# Change to project directory
cd "$(dirname "$0")"
PROJECT_DIR=$(pwd)

echo "Project Directory: $PROJECT_DIR"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo ""
    echo "Dependencies not installed! Run:"
    echo "  npm run setup"
    exit 1
fi

# Start both servers via concurrently
echo ""
echo "Starting backend (port 3001) and frontend (port 3000)..."
echo "Open http://localhost:3000 once both servers are ready."
echo ""
npm run dev
