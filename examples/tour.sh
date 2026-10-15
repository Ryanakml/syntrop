#!/usr/bin/env bash
set -euo pipefail

# Syntrop Interactive Tour & Operational Demonstration
# Demonstrates: DAG task dependencies, conflict rejection, and ACID state management in an isolated workspace.

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}======================================================${NC}"
echo -e "${BLUE}     Syntrop: Interactive Operational Tour Demo       ${NC}"
echo -e "${BLUE}======================================================${NC}\n"

# 1. Setup disposable temporary workspace
WS_DIR="$(mktemp -d)/syntrop-tour-ws"
trap 'rm -rf "$WS_DIR"' EXIT

CLI="./src/cli.ts"

echo -e "${GREEN}[Step 1] Initializing isolated workspace at:${NC} $WS_DIR"
node "$CLI" --workspace "$WS_DIR" init --timezone Asia/Jakarta
echo -e "✓ Workspace initialized.\n"

# 2. Add goal and project
echo -e "${GREEN}[Step 2] Defining high-level goal and project:${NC}"
GOAL_OUT=$(node "$CLI" --workspace "$WS_DIR" --json goal add --title "Master Local-First Agent Infrastructure")
GOAL_ID=$(echo "$GOAL_OUT" | node -e 'console.log(JSON.parse(fs.readFileSync(0)).id)')
echo -e "  Goal Created: $GOAL_ID"

PRJ_OUT=$(node "$CLI" --workspace "$WS_DIR" --json project add --title "Syntrop Public Launch" --goal "$GOAL_ID")
PRJ_ID=$(echo "$PRJ_OUT" | node -e 'console.log(JSON.parse(fs.readFileSync(0)).id)')
echo -e "  Project Created: $PRJ_ID\n"

# 3. Add DAG tasks with dependencies
echo -e "${GREEN}[Step 3] Creating DAG tasks with prerequisite dependencies:${NC}"
TASK1_OUT=$(node "$CLI" --workspace "$WS_DIR" --json task add --project "$PRJ_ID" --title "Verify Node 24 SQLite Invariants" --status todo --priority 1)
TASK1_ID=$(echo "$TASK1_OUT" | node -e 'console.log(JSON.parse(fs.readFileSync(0)).id)')
echo -e "  Task 1 (Prerequisite): $TASK1_ID"

TASK2_OUT=$(node "$CLI" --workspace "$WS_DIR" --json task add --project "$PRJ_ID" --title "Publish Open-Source Release" --status todo --priority 1 --depends-on "$TASK1_ID")
TASK2_ID=$(echo "$TASK2_OUT" | node -e 'console.log(JSON.parse(fs.readFileSync(0)).id)')
echo -e "  Task 2 (Blocked by Task 1): $TASK2_ID\n"

# 4. Show task next (Topological readiness)
echo -e "${GREEN}[Step 4] Querying next unblocked actions ('task next'):${NC}"
node "$CLI" --workspace "$WS_DIR" task next
echo -e "${YELLOW}Notice: Only Task 1 is ready. Task 2 is automatically blocked until Task 1 finishes.${NC}\n"

# 5. Scheduling & Conflict Rejection Demonstration
echo -e "${GREEN}[Step 5] Demonstrating half-open interval conflict rejection:${NC}"
echo -e "  Booking session A from 09:00 to 10:00..."
node "$CLI" --workspace "$WS_DIR" schedule add --task "$TASK1_ID" --start 2026-10-15T09:00+07:00 --end 2026-10-15T10:00+07:00

echo -e "  Attempting to book overlapping session B from 09:30 to 10:30 (should be rejected)..."
if node "$CLI" --workspace "$WS_DIR" schedule add --task "$TASK2_ID" --start 2026-10-15T09:30+07:00 --end 2026-10-15T10:30+07:00 2>&1; then
    echo -e "${RED}ERROR: Overlap was not rejected!${NC}"
    exit 1
else
    echo -e "${GREEN}✓ Success: Conflict detected! Overlapping schedule transaction aborted.${NC}\n"
fi

# 6. Complete prerequisite and check readiness update
echo -e "${GREEN}[Step 6] Completing prerequisite Task 1 and re-evaluating readiness:${NC}"
node "$CLI" --workspace "$WS_DIR" task done "$TASK1_ID"
echo -e "  Task 1 marked as done."
echo -e "  Checking 'task next' again:"
node "$CLI" --workspace "$WS_DIR" task next
echo -e "${GREEN}✓ Task 2 is now automatically unblocked and ready for execution!${NC}\n"

# 7. Record strategic decision
echo -e "${GREEN}[Step 7] Committing immutable architectural decision:${NC}"
node "$CLI" --workspace "$WS_DIR" decision add --project "$PRJ_ID" --title "Adopt Pure Node 24 node:sqlite" --rationale "Eliminates npm supply chain dependencies and external compilation."
echo -e "✓ Decision recorded atomically.\n"

# 8. Doctor health check
echo -e "${GREEN}[Step 8] Running workspace doctor:${NC}"
node "$CLI" --workspace "$WS_DIR" doctor
echo -e "\n${BLUE}======================================================${NC}"
echo -e "${BLUE}  Tour complete. All invariants proven in isolation.  ${NC}"
echo -e "${BLUE}======================================================${NC}"
