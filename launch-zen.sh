#!/bin/bash
# Launch Zen Browser with remote debugging enabled
# This allows the zen-mcp server to connect and automate the browser

PORT="${ZEN_DEBUG_PORT:-9222}"

# Kill existing Zen instance gracefully
if pgrep -x "zen" > /dev/null 2>&1; then
    echo "Closing existing Zen instance..."
    osascript -e 'tell application "Zen" to quit' 2>/dev/null
    sleep 2
    # Force kill if still running
    if pgrep -x "zen" > /dev/null 2>&1; then
        killall zen 2>/dev/null
        sleep 1
    fi
fi

echo "Launching Zen with remote debugging on port ${PORT}..."
open /Applications/Zen.app --args --remote-debugging-port "${PORT}"
echo "Zen launched. Waiting for it to be ready..."

# Wait for the debugging port to be available
for i in $(seq 1 30); do
    if curl -s "http://127.0.0.1:${PORT}/json/version" > /dev/null 2>&1; then
        echo "Zen is ready on port ${PORT}!"
        curl -s "http://127.0.0.1:${PORT}/json/version" | python3 -m json.tool 2>/dev/null
        exit 0
    fi
    sleep 1
done

echo "Warning: Zen may not have remote debugging enabled. Check if port ${PORT} is accessible."
exit 1
