# SLR AI Coach

Smarter Training. Tailored for You.

A personal fitness + nutrition app combining gym programming, calorie tracking,
PT oversight, and analytics. Built React + Vite + Tailwind.

## Status: Phase 1 — local + Netlify deploy

This is the first deployable build. Storage is still in-memory (resets on reload).
Auth and persistence land in Phase 2 (Supabase).

## Running locally

```bash
npm install
npm run dev
```

Opens at http://localhost:5173

## Building for production

```bash
npm run build
npm run preview   # to test the production bundle locally
```

Build output goes to `dist/`.

## Deploying

This repo is Netlify-ready. Connect it to Netlify via GitHub and Netlify will
auto-deploy on every push to main. The build settings are in `netlify.toml`.

## Repo layout

```
src/
  App.jsx              — top-level entry, just renders SincApp
  main.jsx             — React root
  index.css            — Tailwind + mobile fixes
  pages/
    SincApp.jsx        — THE app (Home, Plan, Food, Train, Insights, More)
    SincTraining.jsx   — standalone training experience (not wired to the live app)
    SincAnalytics.jsx  — standalone analytics experience (not wired to the live app)
  components/          — (reserved for Phase 2+ refactor)
  lib/                 — (reserved for Phase 2: supabase client, etc.)
  data/                — (reserved for shared exercise catalog if we extract it)
public/
  manifest.json        — PWA manifest
  icon.svg             — brand monogram
  robots.txt           — keeps search engines out during private testing
```

## What's where in SincApp.jsx

It's one ~8900-line file because it was built monolithic in artifacts. Major sections:

- **Constants** (~lines 1-100): brand colors, hero photo base64
- **Storage abstraction** (~100-340): in-memory storage. This is what gets swapped to Supabase in Phase 2.
- **UI primitives** (~340-700): Modal, NumInput, BrandIcon, etc.
- **Domain logic** (~700-1500): calorie/macro math, exercise muscle map
- **Auth/Onboarding** (~1500-2100): demo accounts, login, signup, profile setup
- **UserApp** (~2100-2200): top-level user app with bottom tab nav
- **Tab components** (~2200-7100): HomeTab, PlanTab, FoodTab, TrainingPreview, AnalyticsTab, MoreTab
- **PT views** (~7100-end): PTApp, PTList, PTClient with all the new editing

## Phase plan

- ✅ Phase 1: Project scaffold + first Netlify deploy with in-memory storage
- ⏳ Phase 2: Supabase backend (schema, RLS, auth, storage adapter swap)
- ⏳ Phase 3: Polish — body highlighter, hero photos to Storage, PWA service worker
- ⏳ Phase 4: Real testing with friend group

## Honest caveats

- The in-memory storage WILL wipe on every reload. That's expected in Phase 1 —
  you can test the UI but you can't actually use it as a fitness tracker yet.
- Hero photos are base64-embedded in the JS bundle (~5MB total). This works but
  bloats the bundle. Moving to Supabase Storage in Phase 3 cuts this.
- Demo accounts (coach_dave, james, sarah, mike, password "demo") still work as
  in-memory seeds. They reset on every reload.
- No automated tests. Manual testing only.

## Costs

Free until you outgrow free tiers:

- **Netlify free**: 100GB bandwidth/month, 300 build minutes/month, commercial use OK
- **Supabase free** (Phase 2): 500MB Postgres, 50K MAUs, 1GB file storage

Pro plans land at ~$45/month total ($25 Supabase + $20 Netlify) if you outgrow.
