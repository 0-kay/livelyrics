// Vercel serverless function: every /api/* request is rewritten here (see vercel.json)
// and handled by the same Fastify app the Docker image runs.
export { default } from '../server/dist/vercel.js';
