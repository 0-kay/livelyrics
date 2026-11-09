#!/usr/bin/env bash
# Deploy LiveLyrics (real mode, concert mode off) to Google Cloud Run.
#
#   ./scripts/deploy-cloudrun.sh [PROJECT_ID] [REGION]
#
# Reads ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY, ACRCLOUD_ACCESS_SECRET,
# LRCLIB_USER_AGENT and ACCESS_PASSWORD from .env (asks for the password if
# it is missing). Keys go to Secret Manager, never into the image. The image is
# built by Cloud Build, so Docker is not needed locally. Safe to run again:
# every step creates or updates.
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="${1:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${2:-us-central1}"
SERVICE="livelyrics"
REPO="livelyrics"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

command -v gcloud >/dev/null || die "gcloud is not installed: https://cloud.google.com/sdk/docs/install"
[ -n "$PROJECT" ] || die "no project. Pass one: ./scripts/deploy-cloudrun.sh my-project-id"
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . || die "not logged in. Run: gcloud auth login"
[ -f .env ] || die ".env not found. Copy .env.example to .env and fill in the ACRCloud keys."

# Read only the keys we need from .env (comments after values are stripped).
envval() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'; }
ACRCLOUD_HOST="$(envval ACRCLOUD_HOST)"
ACRCLOUD_ACCESS_KEY="$(envval ACRCLOUD_ACCESS_KEY)"
ACRCLOUD_ACCESS_SECRET="$(envval ACRCLOUD_ACCESS_SECRET)"
LRCLIB_USER_AGENT="$(envval LRCLIB_USER_AGENT)"
ACCESS_PASSWORD="$(envval ACCESS_PASSWORD)"
[ -n "$ACRCLOUD_HOST" ] && [ -n "$ACRCLOUD_ACCESS_KEY" ] && [ -n "$ACRCLOUD_ACCESS_SECRET" ] || die "ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY and ACRCLOUD_ACCESS_SECRET must be set in .env"
LRCLIB_USER_AGENT="${LRCLIB_USER_AGENT:-livelyrics/0.1 (https://github.com/0-kay/livelyrics)}"
if [ -z "$ACCESS_PASSWORD" ]; then
  read -r -s -p "Choose a password for the app (the browser asks for it once): " ACCESS_PASSWORD; echo
  [ -n "$ACCESS_PASSWORD" ] || die "a password is required for a deployed copy"
fi

say "Project $PROJECT, region $REGION"
gcloud config set project "$PROJECT" >/dev/null

say "Enabling services (first run takes a minute)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com >/dev/null

say "Container registry"
gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" --repository-format=docker --location "$REGION" >/dev/null

IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO/app:$(git rev-parse --short HEAD 2>/dev/null || date +%s)"
say "Building $IMAGE with Cloud Build (about 3 to 5 minutes)"
gcloud builds submit --tag "$IMAGE" .

say "Storing keys in Secret Manager"
put_secret() {
  if gcloud secrets describe "$1" >/dev/null 2>&1; then
    printf %s "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null
  else
    printf %s "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic >/dev/null
  fi
}
put_secret livelyrics-acrcloud-key "$ACRCLOUD_ACCESS_KEY"
put_secret livelyrics-acrcloud-secret "$ACRCLOUD_ACCESS_SECRET"
put_secret livelyrics-access-password "$ACCESS_PASSWORD"

# Cloud Run runs as the default compute service account; let it read the secrets.
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="$NUMBER-compute@developer.gserviceaccount.com"
for s in livelyrics-acrcloud-key livelyrics-acrcloud-secret livelyrics-access-password; do
  gcloud secrets add-iam-policy-binding "$s" --member "serviceAccount:$RUNTIME_SA" --role roles/secretmanager.secretAccessor >/dev/null
done

say "Deploying to Cloud Run"
# The app is reachable by link (so a phone can open it), and the password gate keeps it personal.
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --allow-unauthenticated \
  --memory 512Mi --cpu 1 --concurrency 40 --min-instances 0 --max-instances 2 --timeout 30 \
  --set-env-vars "^@^PROVIDER_MODE=real@CONCERT_MODE=off@ACRCLOUD_HOST=$ACRCLOUD_HOST@LRCLIB_USER_AGENT=$LRCLIB_USER_AGENT" \
  --set-secrets ACRCLOUD_ACCESS_KEY=livelyrics-acrcloud-key:latest,ACRCLOUD_ACCESS_SECRET=livelyrics-acrcloud-secret:latest,ACCESS_PASSWORD=livelyrics-access-password:latest

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
say "Checking $URL/api/health"
curl -fsS "$URL/api/health" && echo
say "Done. Open $URL on your phone, sign in with any name and your password, then tap Listen."
