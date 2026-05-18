# Contributing

## Local setup

```bash
npm ci
cp .env.example .env.local
npm run dev
```

## Validation

```bash
npm run test:integration
npm run lint
npm run build
npm run smoke
```

## Provider integration guidelines

- Do not add new providers in beta release-readiness PRs unless explicitly requested
- Prefer official APIs or fixture-backed demo flows
- Keep provider credentials encrypted and out of committed files
- Preserve local/test vs hosted safety boundaries

## Extension capture guidelines

- Keep manual capture explicit and user-triggered
- Keep optional host permissions narrow
- Do not add background scraping
- Do not collect browsing history or unrelated page data

## Safety boundaries

- Do not weaken local vs hosted runtime protections
- Do not add hosted auth or multi-user SaaS behavior in local-beta-focused changes
- Keep destructive flows gated to local/test only
