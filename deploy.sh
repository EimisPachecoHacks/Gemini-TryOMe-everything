#!/bin/bash
# deploy.sh — Automated deployment of Gemini TryOnMe Everything backend to Google Cloud Run
#
# Usage: ./deploy.sh [--project PROJECT_ID] [--region REGION]
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - Docker or Cloud Build enabled on the GCP project
#   - Service account with roles/aiplatform.user IAM role (for Vertex AI)

set -euo pipefail

# Defaults
PROJECT_ID="${GCP_PROJECT_ID:-project-4213188d-5b34-47c7-84e}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="geminitryonme-backend"
MEMORY="4Gi"
CPU="2"
TIMEOUT="600"
MIN_INSTANCES="0"
MAX_INSTANCES="4"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --project) PROJECT_ID="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "============================================"
echo "  Gemini TryOnMe Everything — Cloud Deploy"
echo "============================================"
echo ""
echo "  Project:  $PROJECT_ID"
echo "  Region:   $REGION"
echo "  Service:  $SERVICE_NAME"
echo "  Memory:   $MEMORY"
echo "  CPU:      $CPU"
echo "  Timeout:  ${TIMEOUT}s"
echo "  Scaling:  $MIN_INSTANCES — $MAX_INSTANCES instances"
echo ""

# Validate gcloud is installed
if ! command -v gcloud &> /dev/null; then
  echo "ERROR: gcloud CLI is not installed. Install it from https://cloud.google.com/sdk/docs/install"
  exit 1
fi

# Validate gcloud is authenticated
if ! gcloud auth print-access-token &> /dev/null 2>&1; then
  echo "ERROR: gcloud is not authenticated. Run: gcloud auth login"
  exit 1
fi

# Validate project exists
if ! gcloud projects describe "$PROJECT_ID" &> /dev/null 2>&1; then
  echo "ERROR: Project '$PROJECT_ID' not found or you don't have access."
  exit 1
fi

# Check that backend directory exists
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"

if [ ! -f "$BACKEND_DIR/package.json" ]; then
  echo "ERROR: backend/package.json not found. Run this script from the project root."
  exit 1
fi

if [ ! -f "$BACKEND_DIR/Dockerfile" ]; then
  echo "ERROR: backend/Dockerfile not found."
  exit 1
fi

echo "Deploying to Cloud Run..."
echo ""

cd "$BACKEND_DIR"

gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --allow-unauthenticated \
  --timeout="$TIMEOUT" \
  --memory="$MEMORY" \
  --cpu="$CPU" \
  --min-instances="$MIN_INSTANCES" \
  --max-instances="$MAX_INSTANCES"

echo ""
echo "============================================"
echo "  Deploy complete!"
echo "============================================"
echo ""

# Get the service URL
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --format="value(status.url)" 2>/dev/null || echo "")

if [ -n "$SERVICE_URL" ]; then
  echo "  Service URL: $SERVICE_URL"
  echo "  Health check: $SERVICE_URL/"
  echo "  Voice agent: $SERVICE_URL/ws/voice-live (WebSocket)"
  echo ""
fi
