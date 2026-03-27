#!/usr/bin/env bash
set -euo pipefail

# Engram plug-and-play installer for OpenClaw
# Usage: curl -fsSL <url>/install.sh | bash
#    or: bash install.sh

ENGRAM_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/engram"
PLUGIN_JS_URL="${ENGRAM_PLUGIN_URL:-}"  # set externally or build locally

echo "🧠 Installing Engram cognitive memory engine for OpenClaw"
echo ""

# 1. Create plugin directory
mkdir -p "$ENGRAM_DIR/dist"
echo "  ✓ Created $ENGRAM_DIR"

# 2. Write package.json
cat > "$ENGRAM_DIR/package.json" << 'EOF'
{
  "name": "engram",
  "version": "0.2.0",
  "type": "module",
  "description": "Engram cognitive memory plugin for OpenClaw",
  "openclaw": {
    "extensions": ["./dist/openclaw-plugin.js"]
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "openclaw": "*"
  }
}
EOF
echo "  ✓ Created package.json"

# 3. Write plugin manifest
cat > "$ENGRAM_DIR/openclaw.plugin.json" << 'EOF'
{
  "id": "engram",
  "name": "Engram Cognitive Memory",
  "description": "Brain-inspired cognitive memory engine with 5 memory systems",
  "version": "0.2.0",
  "kind": "context-engine",
  "configSchema": {
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "storagePath": { "type": "string", "default": "~/.openclaw/engram.db" }
    }
  }
}
EOF
echo "  ✓ Created openclaw.plugin.json"

# 4. Copy or download the built plugin
if [ -f "./dist/openclaw-plugin.js" ]; then
  cp ./dist/openclaw-plugin.js "$ENGRAM_DIR/dist/"
  echo "  ✓ Copied plugin from local build"
elif [ -n "$PLUGIN_JS_URL" ]; then
  curl -fsSL "$PLUGIN_JS_URL" -o "$ENGRAM_DIR/dist/openclaw-plugin.js"
  echo "  ✓ Downloaded plugin"
else
  echo "  ✗ No plugin found. Build first: cd packages/openclaw && npx tsup"
  echo "    Then re-run this script from the packages/openclaw directory."
  exit 1
fi

# 5. Install dependencies
echo "  → Installing dependencies..."
cd "$ENGRAM_DIR" && npm install --no-audit --no-fund 2>&1 | tail -1
echo "  ✓ Dependencies installed"

# 6. Update openclaw.json
OPENCLAW_CONFIG="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/openclaw.json"
if [ -f "$OPENCLAW_CONFIG" ]; then
  # Backup
  cp "$OPENCLAW_CONFIG" "${OPENCLAW_CONFIG}.bak.pre-engram"

  python3 -c "
import json, sys

with open('$OPENCLAW_CONFIG') as f:
    config = json.load(f)

# Add plugin load path
paths = config.setdefault('plugins', {}).setdefault('load', {}).setdefault('paths', [])
if '$ENGRAM_DIR' not in paths:
    paths.append('$ENGRAM_DIR')

# Set context engine slot
config['plugins'].setdefault('slots', {})['contextEngine'] = 'engram'

# Add plugin entry
config['plugins'].setdefault('entries', {})['engram'] = {
    'enabled': True,
    'config': {
        'storagePath': '$ENGRAM_DIR/engram.db'
    }
}

with open('$OPENCLAW_CONFIG', 'w') as f:
    json.dump(config, f, indent=2)
" 2>/dev/null || {
    echo "  ⚠ Could not auto-configure openclaw.json. Add manually:"
    echo "    plugins.load.paths: [\"$ENGRAM_DIR\"]"
    echo "    plugins.slots.contextEngine: \"engram\""
    echo "    plugins.entries.engram: { enabled: true, config: { storagePath: \"$ENGRAM_DIR/engram.db\" } }"
  }
  echo "  ✓ Updated openclaw.json"
else
  echo "  ⚠ No openclaw.json found at $OPENCLAW_CONFIG — configure manually"
fi

echo ""
echo "🧠 Engram installed! Restart OpenClaw to activate:"
echo "   openclaw gateway restart"
echo ""
echo "   Verify: openclaw plugins inspect engram"
echo "   DB location: $ENGRAM_DIR/engram.db"
