#!/bin/bash
# LlamaPerformance Installation Script

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo "======================================"
echo " LlamaPerformance Installation"
echo "======================================"
echo ""

# Check Node.js
echo -e "${GREEN}Checking Node.js...${NC}"
if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node --version)
    MAJOR=$(echo $NODE_VERSION | sed 's/v//' | cut -d. -f1)
    echo -e "${GREEN}Node.js $NODE_VERSION${NC}"
    if [ "$MAJOR" -lt 18 ]; then
        echo -e "${YELLOW}Warning: Node.js 18+ is required (you have $NODE_VERSION)${NC}"
        exit 1
    fi
else
    echo -e "${RED}Node.js is not installed. Install from https://nodejs.org/${NC}"
    exit 1
fi

# Install backend dependencies
echo ""
echo -e "${GREEN}Installing backend dependencies...${NC}"
npm install
echo -e "${GREEN}Backend dependencies installed.${NC}"

# Install frontend dependencies
echo ""
echo -e "${GREEN}Installing frontend dependencies...${NC}"
cd src/client && npm install && cd ../..
echo -e "${GREEN}Frontend dependencies installed.${NC}"

# Create results directory
mkdir -p results

echo ""
echo "======================================"
echo -e "${GREEN}Installation complete!${NC}"
echo "======================================"
echo ""
echo "Next steps:"
echo "  1. Configure your llama.cpp server URL in the Settings tab"
echo "  2. Start the app:"
echo -e "     ${CYAN}npm run dev${NC}   # development mode"
echo -e "     ${CYAN}npm start${NC}     # production mode"
echo ""
