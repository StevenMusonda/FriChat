You are extending FriChat, a Node/Express/Socket.IO chat app with MySQL or PostgreSQL and a vanilla JS frontend (backend/, frontend/, database/). Follow these rules for every task:

1. Inspect first. Before changing anything, read the relevant existing code (controllers, routes, middleware, frontend/js, database/*.sql) and reuse its patterns. If part of the requested feature already exists, say so and only build what is missing.
2. Database: every schema change must ship as a new migration file for BOTH engines, following the existing naming (for example database/<name>.sql and database/<name>_postgresql.sql). Also update schema.sql and schema_postgresql.sql so a fresh install works. Never edit sample data in a way that breaks existing installs.
3. Security: use parameterized queries, express-validator rules for all new inputs, authorization checks on every new REST endpoint AND every new Socket.IO event (the user must be a member of the chat), escape all user content rendered in the UI (no innerHTML with raw user text), and keep rate limiting on new endpoints.
4. Frontend is vanilla JS. Do not introduce a framework or a build step. Keep the light/dark theme and the responsive layout working on mobile widths.
5. Keep changes focused on the current phase. Do not refactor unrelated code.
6. Documentation: add a short section to FEATURES_SETUP.md describing the feature, the migration to run, new env variables (also add them to .env.example if it exists), new endpoints and socket events, and a manual test checklist.
7. Verify: run the server, run any existing tests, and add automated tests for new backend logic where a test setup exists (if none exists, add a minimal one with Jest and Supertest). Fix what fails. Say clearly what you could not test.
8. Do NOT run git commit, git push, or any destructive git command. I commit myself.

WRAP-UP (do this at the end of every task, in this exact order):
A. Summary of what you built, in plain language, 5-10 bullets.
B. Files created and files changed (list).
C. Database migrations I must run, with the exact commands for MySQL and PostgreSQL.
D. New env variables or npm packages (and the install command).
E. How to test it manually: numbered steps with expected results.
F. Known limitations, anything skipped, and anything you were unsure about.
G. Output `git status --short` and a suggested commit message in the form `feat: <short description>`.
Then stop and wait for me to commit and start the next phase.