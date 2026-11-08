# Deploying to Google Cloud Run (notes only)

These are notes for a future deploy. Nothing here has been deployed. Do not commit keys; pass them as Cloud Run secrets or env vars.

## What the container does

The `Dockerfile` builds all three workspaces and produces one image that runs the Fastify server on `$PORT` (Cloud Run sets this, default 8080). The server serves the API under `/api/*` and the built client from `STATIC_DIR` (`/app/client/dist` in the image), with an SPA fallback to `index.html`. The default `PROVIDER_MODE` in the image is `mock`, so it starts with zero keys.

## Build and run locally

```bash
docker build -t livelyrics .
docker run --rm -p 8080:8080 livelyrics                          # mock mode
docker run --rm -p 8080:8080 -e MOCK_PLAYBACK_RATE=1.25 livelyrics   # mock song at 1.25x
docker run --rm -p 8080:8080 --env-file .env livelyrics          # real mode, keys from your local .env
```

Open http://localhost:8080. Mic access works on `localhost`; anywhere else it needs HTTPS (Cloud Run URLs are HTTPS).

## Deploy outline

```bash
PROJECT=your-project
REGION=us-central1
gcloud artifacts repositories create livelyrics --repository-format=docker --location=$REGION
gcloud builds submit --tag $REGION-docker.pkg.dev/$PROJECT/livelyrics/app:latest
# Store secrets once
printf %s "$ACRCLOUD_ACCESS_KEY"    | gcloud secrets create acrcloud-key --data-file=-
printf %s "$ACRCLOUD_ACCESS_SECRET" | gcloud secrets create acrcloud-secret --data-file=-
printf %s "$OPENAI_API_KEY"         | gcloud secrets create openai-key --data-file=-
gcloud run deploy livelyrics \
  --image $REGION-docker.pkg.dev/$PROJECT/livelyrics/app:latest \
  --region $REGION --allow-unauthenticated \
  --memory 512Mi --cpu 1 --concurrency 40 --max-instances 3 --timeout 30 \
  --set-env-vars PROVIDER_MODE=real,ACRCLOUD_HOST=identify-us-west-2.acrcloud.com,LRCLIB_USER_AGENT="livelyrics/0.1 (you@example.com)" \
  --set-secrets ACRCLOUD_ACCESS_KEY=acrcloud-key:latest,ACRCLOUD_ACCESS_SECRET=acrcloud-secret:latest,OPENAI_API_KEY=openai-key:latest
```

## Things to know

- The lyrics cache is in memory per instance. It is lost on scale-down and not shared between instances. A Redis (Memorystore) or Firestore backend can go behind the existing `Cache` interface later.
- Each client re-recognizes every 2s until locked, then every 20-30s. Budget ACRCloud requests accordingly; `--max-instances` caps cost from abuse.
- Uploads are capped at 5 MB per clip. A 9s 16 kHz mono WAV is about 290 KB.
- `--allow-unauthenticated` makes the app public. LRCLIB is for personal use only, so keep the service private (drop that flag and use IAM or IAP) unless you switch to a licensed lyrics provider.
- Health check: `GET /api/health`.
