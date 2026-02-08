#!/bin/bash

# Lucid Memory - Installer Lint & Validation
#
# Validates installer/uninstaller scripts without running them.
# Checks syntax, URLs, stale references, and download safety patterns.
#
# Usage: bash scripts/lint-installers.sh
#   --offline   Skip URL reachability checks

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

ERRORS=0
WARNINGS=0
OFFLINE=false

if [[ "${1:-}" == "--offline" ]]; then
    OFFLINE=true
fi

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; ERRORS=$((ERRORS + 1)); }
warn() { echo -e "  ${YELLOW}⚠${NC}  $1"; WARNINGS=$((WARNINGS + 1)); }

echo ""
echo -e "${BOLD}Installer Lint & Validation${NC}"
echo ""

# ─── Syntax Checks ───────────────────────────────────────────────────────────

echo -e "${BOLD}Syntax checks${NC}"

for f in install.sh uninstall.sh; do
    if bash -n "$ROOT/$f" 2>/dev/null; then
        pass "$f — valid bash"
    else
        fail "$f — bash syntax error"
    fi
done

if command -v pwsh &>/dev/null; then
    for f in install.ps1 uninstall.ps1; do
        if pwsh -NoProfile -Command "try { \$null = [System.Management.Automation.Language.Parser]::ParseFile('$ROOT/$f', [ref]\$null, [ref]\$null); exit 0 } catch { exit 1 }" 2>/dev/null; then
            pass "$f — valid PowerShell"
        else
            fail "$f — PowerShell syntax error"
        fi
    done
else
    warn "pwsh not found — skipping PowerShell syntax checks"
fi

echo ""

# ─── Stale Reference Checks ──────────────────────────────────────────────────

echo -e "${BOLD}Stale reference checks${NC}"

INSTALLER_FILES=(install.sh install.ps1 uninstall.sh uninstall.ps1)

for f in "${INSTALLER_FILES[@]}"; do
    if grep -qi 'ollama' "$ROOT/$f" 2>/dev/null; then
        fail "$f — contains stale Ollama reference"
    else
        pass "$f — no Ollama references"
    fi
done

echo ""

# ─── Download Safety Patterns ────────────────────────────────────────────────

echo -e "${BOLD}Download safety (temp-file-then-rename)${NC}"

# install.sh: every actual curl download (not help text) should target a .tmp file
SH_CURLS=$(grep -c 'curl.*-o.*\.tmp' "$ROOT/install.sh" 2>/dev/null || echo 0)
SH_CURLS_TOTAL=$(grep -v 'echo\|manual' "$ROOT/install.sh" | grep -c 'curl.*-o.*\$LUCID_MODELS' 2>/dev/null || echo 0)
if [ "$SH_CURLS" -eq "$SH_CURLS_TOTAL" ] && [ "$SH_CURLS" -gt 0 ]; then
    pass "install.sh — all $SH_CURLS model downloads use .tmp pattern"
else
    fail "install.sh — $SH_CURLS/$SH_CURLS_TOTAL downloads use .tmp pattern"
fi

# install.sh: every .tmp download should have a corresponding mv
SH_MVS=$(grep -c 'mv.*\.tmp.*\$LUCID_MODELS' "$ROOT/install.sh" 2>/dev/null || echo 0)
if [ "$SH_MVS" -eq "$SH_CURLS" ]; then
    pass "install.sh — all .tmp files are renamed on success"
else
    fail "install.sh — $SH_MVS mv commands for $SH_CURLS .tmp downloads"
fi

# install.ps1: every actual Invoke-WebRequest (not help text) should target .tmp
PS_IWRS=$(grep -c 'OutFile.*\.tmp' "$ROOT/install.ps1" 2>/dev/null || echo 0)
PS_IWRS_TOTAL=$(grep -v 'Write-Host\|manual' "$ROOT/install.ps1" | grep -c 'OutFile.*\$.*Model\|OutFile.*\$.*Tokenizer\|OutFile.*\$Whisper' 2>/dev/null || echo 0)
if [ "$PS_IWRS" -eq "$PS_IWRS_TOTAL" ] && [ "$PS_IWRS" -gt 0 ]; then
    pass "install.ps1 — all $PS_IWRS model downloads use .tmp pattern"
else
    fail "install.ps1 — $PS_IWRS/$PS_IWRS_TOTAL downloads use .tmp pattern"
fi

# install.ps1: ProgressPreference set before large downloads
PS_PROGRESS=$(grep -c 'ProgressPreference.*SilentlyContinue' "$ROOT/install.ps1" 2>/dev/null || echo 0)
if [ "$PS_PROGRESS" -ge 3 ]; then
    pass "install.ps1 — \$ProgressPreference set for downloads ($PS_PROGRESS occurrences)"
else
    fail "install.ps1 — \$ProgressPreference only set $PS_PROGRESS times (expected ≥3)"
fi

echo ""

# ─── URL Consistency ─────────────────────────────────────────────────────────

echo -e "${BOLD}URL consistency${NC}"

# Extract BGE model URL from install.sh
SH_BGE_URL=$(grep 'BGE_MODEL_URL=' "$ROOT/install.sh" | head -1 | sed 's/.*="\(.*\)"/\1/')
# Extract BGE model URL from CI workflow
CI_BGE_URL=$(grep 'model_fp16.onnx' "$ROOT/.github/workflows/build-native.yml" | grep -o 'https://[^"]*' | head -1)

if [ -n "$SH_BGE_URL" ] && [ "$SH_BGE_URL" = "$CI_BGE_URL" ]; then
    pass "BGE model URL matches between install.sh and build-native.yml"
else
    fail "BGE model URL mismatch: install.sh='$SH_BGE_URL' vs CI='$CI_BGE_URL'"
fi

# Check that install.sh and install.ps1 use the same URLs
SH_TOKENIZER_URL=$(grep 'BGE_TOKENIZER_URL=' "$ROOT/install.sh" | head -1 | sed 's/.*="\(.*\)"/\1/')
PS_BGE_URL=$(grep 'BgeModelUrl' "$ROOT/install.ps1" | head -1 | sed 's/.*= "\(.*\)"/\1/')
PS_TOKENIZER_URL=$(grep 'BgeTokenizerUrl' "$ROOT/install.ps1" | head -1 | sed 's/.*= "\(.*\)"/\1/')

if [ "$SH_BGE_URL" = "$PS_BGE_URL" ]; then
    pass "BGE model URL matches between install.sh and install.ps1"
else
    fail "BGE model URL mismatch between install.sh and install.ps1"
fi

if [ "$SH_TOKENIZER_URL" = "$PS_TOKENIZER_URL" ]; then
    pass "BGE tokenizer URL matches between install.sh and install.ps1"
else
    fail "BGE tokenizer URL mismatch between install.sh and install.ps1"
fi

# No GitHub release download URLs (unreliable — assets must be uploaded manually)
for f in install.sh install.ps1; do
    if grep -q 'github.com.*releases/download' "$ROOT/$f" 2>/dev/null; then
        fail "$f — contains GitHub release download URL (use HuggingFace CDN instead)"
    else
        pass "$f — no GitHub release download URLs"
    fi
done

echo ""

# ─── URL Reachability ────────────────────────────────────────────────────────

if [ "$OFFLINE" = true ]; then
    echo -e "${BOLD}URL reachability${NC} ${YELLOW}(skipped — offline mode)${NC}"
else
    echo -e "${BOLD}URL reachability${NC}"

    check_url() {
        local url="$1"
        local label="$2"
        local status
        status=$(curl -sfI -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
        # HuggingFace returns 302/307 redirects for CDN-backed files
        if [[ "$status" =~ ^(200|301|302|307)$ ]]; then
            pass "$label — HTTP $status"
        else
            fail "$label — HTTP $status (expected 2xx/3xx)"
        fi
    }

    check_url "$SH_BGE_URL" "BGE model (FP16 ONNX)"
    check_url "$SH_TOKENIZER_URL" "BGE tokenizer"
    check_url "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" "Whisper model"
fi

echo ""

# ─── CI Workflow Checks ──────────────────────────────────────────────────────

echo -e "${BOLD}CI workflow checks${NC}"

CI_FILE="$ROOT/.github/workflows/build-native.yml"

# No || true on model downloads (should fail loudly)
if grep -A1 'model_fp16.onnx\|tokenizer.json' "$CI_FILE" | grep -q '|| true'; then
    fail "build-native.yml — model download has '|| true' (should fail on error)"
else
    pass "build-native.yml — model downloads fail loudly on error"
fi

# Has validation step
if grep -q 'Validate model files' "$CI_FILE"; then
    pass "build-native.yml — has model validation step"
else
    fail "build-native.yml — missing model validation step"
fi

echo ""

# ─── Summary ─────────────────────────────────────────────────────────────────

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$ERRORS" -eq 0 ]; then
    echo -e "${GREEN}${BOLD}All checks passed${NC} ($WARNINGS warning(s))"
else
    echo -e "${RED}${BOLD}$ERRORS check(s) failed${NC} ($WARNINGS warning(s))"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

exit "$ERRORS"
