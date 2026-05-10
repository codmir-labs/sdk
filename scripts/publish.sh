#!/usr/bin/env bash
set -euo pipefail

# Publish script for @codmir/sdk
# Usage: ./scripts/publish.sh [--dry-run] [--beta] [--bump patch|minor|major]
#
# Set NPM_TOKEN in .env or environment to use automation token (bypasses 2FA)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$PKG_DIR")")"

# Load .env if exists
if [ -f "$ROOT_DIR/.env" ]; then
  export $(grep -E '^NPM_TOKEN=' "$ROOT_DIR/.env" | xargs)
fi

DRY_RUN=false
TAG="latest"
BUMP=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --beta)
      TAG="beta"
      shift
      ;;
    --alpha)
      TAG="alpha"
      shift
      ;;
    --bump)
      BUMP="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: ./scripts/publish.sh [--dry-run] [--beta|--alpha] [--bump patch|minor|major]"
      exit 1
      ;;
  esac
done

cd "$PKG_DIR"

echo "📦 @codmir/sdk Publish Script"
echo "=============================="
echo ""

# Get current version
VERSION=$(jq -r '.version' package.json)
echo "Current version: $VERSION"
echo "Publish tag: $TAG"
echo ""

# Check if logged in to npm
echo "🔍 Checking npm auth..."
if ! npm whoami &>/dev/null; then
  echo "❌ Not logged in to npm. Run: npm login"
  exit 1
fi
NPM_USER=$(npm whoami)
echo "✅ Logged in as: $NPM_USER"
echo ""

# Bump version if requested
if [ -n "$BUMP" ]; then
  echo "🔼 Bumping version ($BUMP)..."
  npm version "$BUMP" --no-git-tag-version
  VERSION=$(jq -r '.version' package.json)
  echo "✅ New version: $VERSION"
  echo ""
fi

# Check if version already exists
echo "🔍 Checking if version exists on npm..."
if npm view "@codmir/sdk@$VERSION" version &>/dev/null; then
  echo "⚠️  Version $VERSION already published!"
  echo "   Use --bump patch|minor|major to bump version"
  exit 1
fi
echo "✅ Version $VERSION is available"
echo ""

# Build package
echo "🔨 Building @codmir/sdk..."
cd "$ROOT_DIR"
pnpm --filter @codmir/sdk build
cd "$PKG_DIR"
echo "✅ Build complete"
echo ""

# Show what will be published
echo "📋 Package contents:"
npm pack --dry-run 2>&1 | grep -E "^npm notice" | head -25 || true
echo ""

if [ "$DRY_RUN" = true ]; then
  echo "🧪 DRY RUN - not actually publishing"
  npm publish --dry-run --access public --tag "$TAG"
  echo ""
  echo "✅ Dry run complete. To publish for real, run without --dry-run"
else
  echo "🚀 Publishing to npm..."
  echo ""
  echo "Package: @codmir/sdk"
  echo "Version: $VERSION"
  echo "Tag: $TAG"
  
  # Check for NPM_TOKEN (automation token bypasses 2FA)
  if [ -n "${NPM_TOKEN:-}" ]; then
    echo "Auth: Using NPM_TOKEN"
  else
    echo "Auth: Interactive (2FA may be required)"
  fi
  echo ""
  
  read -p "Continue with publish? (y/N) " -n 1 -r
  echo ""
  
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    # Use NPM_TOKEN if available (set as NODE_AUTH_TOKEN for npm)
    if [ -n "${NPM_TOKEN:-}" ]; then
      NODE_AUTH_TOKEN="$NPM_TOKEN" npm publish --access public --tag "$TAG"
    else
      npm publish --access public --tag "$TAG"
    fi
    echo ""
    echo "✅ Published @codmir/sdk@$VERSION to npm!"
    echo "   https://www.npmjs.com/package/@codmir/sdk"
    echo ""
    
    # Git tag
    read -p "Create git tag? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      git add package.json
      git commit -m "chore(sdk): release v$VERSION" || true
      git tag "sdk-v$VERSION"
      git push && git push --tags
      echo "✅ Git tag sdk-v$VERSION created and pushed"
    fi
    
    echo ""
    echo "📝 Post-publish checklist:"
    echo "   - [ ] Verify at https://www.npmjs.com/package/@codmir/sdk"
    echo "   - [ ] Test: npm install @codmir/sdk@$VERSION"
    echo "   - [ ] Update docs if needed"
  else
    echo "❌ Publish cancelled"
    exit 1
  fi
fi
