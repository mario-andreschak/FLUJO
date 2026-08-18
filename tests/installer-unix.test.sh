#!/usr/bin/env bash
# Unix installer Node.js version validation tests
# Tests the node_version_ok function from scripts/install.sh using fake node executables

set -uo pipefail

# Extract the node_version_ok function and its dependencies
NODE_VERSION_OK_FUNC=$(sed -n '/^node_version_ok()/,/^}/p' scripts/install.sh)
HAVE_FUNC=$(sed -n '/^have()/,/^}/p' scripts/install.sh)

# Test counter
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper to run a test
run_test() {
    local test_name="$1"
    local expected_result="$2"  # "pass" or "fail"
    local version_output="$3"
    local exit_code="${4:-0}"
    
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "Running test: $test_name"
    
    # Create a temporary directory for fake node
    local temp_dir=$(mktemp -d)
    local fake_node="$temp_dir/node"
    
    # Create the fake node executable that responds to -v/--version
    cat > "$fake_node" <<EOF
#!/usr/bin/env bash
# Fake node executable for testing
if [ "\$1" = "-v" ] || [ "\$1" = "--version" ]; then
    echo "\$NODE_VERSION_OUTPUT"
fi
exit \$NODE_EXIT_CODE
EOF
    chmod +x "$fake_node"
    
    # Run the test with modified PATH
    set +e
    PATH="$temp_dir:$PATH" NODE_VERSION_OUTPUT="$version_output" NODE_EXIT_CODE="$exit_code" bash -c "
        $HAVE_FUNC
        $NODE_VERSION_OK_FUNC
        MIN_NODE_MAJOR=22
        MIN_NODE_MINOR=0
        node_version_ok
    " 2>/dev/null
    local result=$?
    set -e
    
    # Cleanup
    rm -rf "$temp_dir"
    
    local actual_result="fail"
    if [ $result -eq 0 ]; then
        actual_result="pass"
    fi
    
    if [ "$actual_result" = "$expected_result" ]; then
        echo -e "${GREEN}✓ PASS${NC}: $test_name"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        echo -e "${RED}✗ FAIL${NC}: $test_name (expected $expected_result, got $actual_result)"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
}

# Test cases
echo "Running Unix installer Node.js version validation tests..."
echo

# Supported versions
run_test "Node 22.0.0 (with v prefix)" "pass" "v22.0.0" 0
run_test "Node 22.0.0 (no prefix)" "pass" "22.0.0" 0
run_test "Node 22.14.0" "pass" "22.14.0" 0
run_test "Node 23.0.0" "pass" "23.0.0" 0
run_test "Node 24.5.1" "pass" "24.5.1" 0

# Outdated versions
run_test "Node 18.20.0" "fail" "18.20.0" 0
run_test "Node 20.18.0" "fail" "20.18.0" 0
run_test "Node 21.7.3" "fail" "21.7.3" 0

# Missing command (no node in PATH)
echo "Running test: Missing node command"
TESTS_RUN=$((TESTS_RUN + 1))
temp_dir=$(mktemp -d)
# Use a completely clean PATH with only our temp dir
set +e
PATH="$temp_dir:/usr/bin:/bin" bash -c "
    $HAVE_FUNC
    $NODE_VERSION_OK_FUNC
    MIN_NODE_MAJOR=22
    MIN_NODE_MINOR=0
    node_version_ok
" 2>/dev/null
result=$?
set -e
rm -rf "$temp_dir"
if [ $result -ne 0 ]; then
    echo -e "${GREEN}✓ PASS${NC}: Missing node command"
    TESTS_PASSED=$((TESTS_PASSED + 1))
else
    echo -e "${RED}✗ FAIL${NC}: Missing node command (expected fail, got pass)"
    TESTS_FAILED=$((TESTS_FAILED + 1))
fi

# Malformed versions
run_test "Empty output" "fail" "" 0
run_test "Partial version (major only)" "fail" "22" 0
run_test "Partial version (major.minor)" "fail" "22.0" 0
run_test "Non-numeric components" "fail" "22.0.x" 0
run_test "Extra text prefix" "fail" "Node.js v22.0.0" 0
run_test "Extra text suffix" "fail" "v22.0.0-custom" 0
run_test "Two leading v's" "fail" "vv22.0.0" 0

# Probe failed (non-zero exit)
run_test "Non-zero exit with empty output" "fail" "" 1
run_test "Non-zero exit with valid-looking output" "fail" "22.0.0" 1
run_test "Non-zero exit with malformed output" "fail" "not-a-version" 1

# Summary
echo
echo "========================================"
echo "Tests run: $TESTS_RUN"
echo -e "Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Failed: ${RED}$TESTS_FAILED${NC}"
echo "========================================"

if [ $TESTS_FAILED -gt 0 ]; then
    exit 1
fi
exit 0