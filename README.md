# BXO CV Analyzer

An internal CV analysis workspace for OGT AIESEC Alexandria. Users sign in, upload PDF resumes, receive an AI-generated BXO score, and sync results with Google Drive and Sheets. Administrators can create, edit, disable, reactivate, and archive internal accounts.

## Authentication

- PostgreSQL-backed accounts with case-insensitive usernames
- `LCVP`, `Middle Manager`, and `Member` positions
- LCVPs manage accounts and assign every Member to one Middle Manager
- Middle Managers can view their assigned Members
- Passwords hashed with Node.js `scrypt`
- HTTP-only signed session cookies
- Standard sessions last 24 hours; “Remember me” lasts 90 days
- Disabled accounts lose access on their next request
- The analyzer and `/api/analyze` require authentication
- Account management is restricted to administrators

## Local setup

1. Install Node.js 20 or newer and PostgreSQL.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and configure the required values.
4. Run `npm run dev`.
5. Open the app and enter `INITIAL_SETUP_TOKEN` to create the first admin.

The application automatically creates its `app_users` table. After the first admin exists, the setup endpoint permanently rejects additional setup attempts.

## Required environment variables

- `DATABASE_URL`: PostgreSQL connection string
- `SESSION_SECRET`: random secret containing at least 32 characters
- `INITIAL_SETUP_TOKEN`: private one-time setup token
- `OPENROUTER_API_KEY`: AI analysis API key

Google Drive and Sheets variables are documented in `.env.example` and remain optional.

## Commands

- `npm run dev`: start the Express and Vite development server
- `npm run build`: build the production frontend
- `npm start`: run the production server
- `npm run lint`: run TypeScript validation

## Vercel

Use the `Other` framework preset with the repository root. The included `vercel.json` builds the Vite frontend and rewrites `/api/*` requests to `api/index.ts`, which runs the Express API. Configure all variables from `.env.example` in both Production and Preview environments.
