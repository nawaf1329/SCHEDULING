# Schedule Grid Parser

## Structure
- `public/index.html` = frontend
- `api/parse.js` = Vercel serverless parser

## Deploy
Use Vercel connected to GitHub. GitHub Pages will not run `/api/parse`.

## Optional environment variables
- `OPENAI_API_KEY` only if you want AI classification for unknown status codes.
- `AI_VERIFY=true` only if you want extra AI structural audit.

The parser works locally for known schedule formats without requiring OpenAI.
