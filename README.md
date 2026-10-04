# Culture Archive — review copy

A small static archive for images, audio, video, writing, poetry, lyrics and PDFs. It preserves the existing Supabase `media_items` / `media` model. No build step is required.

## What is implemented

- All seven categories, All, case-insensitive title/description search and Refresh.
- Images, audio/video players, file/PDF links and plain-text descriptions with preserved line breaks.
- Safe DOM rendering: catalog text is never interpreted as HTML; file links are constrained to the configured HTTPS public storage origin.
- Paged catalog loading and distinct loading, empty and error states.
- Responsive layout, labels, keyboard focus, live status, and disabled controls during saves.
- File/type/size/title validation. Writing, poetry and lyrics can be pasted as text; the app saves a UTF-8 file to preserve the existing file-path model.
- Save refresh, cancel/reopen, repeated-submit prevention and session-scoped unfinished-save recovery.

## Current release state

This is a local review candidate, **not a deployed or production-security-verified release**. Production writes, database migrations and storage-policy changes are outside this review. Publication is limited to an authorized draft pull request; merging and deployment require separate approval.

`config.js` retains the project's existing browser publishable configuration. It is not a service-role secret. Never place a service-role key in this app.

Uploads deliberately default to `uploadsEnabled: false`. Browsing can work with the existing public-read configuration. The upload workflow is tested with mocks, not real production assets.

## Preview

Serve this directory through an HTTP static server, for example:

    python3 -m http.server 8000

Then open `http://localhost:8000`. A production browser needs network access to the existing Supabase project and jsDelivr. The dependency URL retains the original Supabase v2 CDN channel; pin and verify a specific tested release before deployment. Previewing the production configuration reads the catalog and public media; it does not enable uploads.

## Tests

Dependency-free behavioral regression suite:

    node tests/dom-offline.cjs

Browser regression suite (requires Node, Playwright and a Chromium installation):

    node tests/offline.cjs

Set `CHROMIUM_PATH` when Chromium is not at `/usr/bin/chromium`. Both suites replace Supabase with mocks and make no production writes. The browser suite routes all network requests locally or aborts them. It creates desktop/mobile review screenshots if successfully run.

## Release blockers: verify before enabling uploads

1. Confirm the intended visibility. The existing bucket is described as public. Every uploaded file and pasted text is intended to be publicly readable in this app; private media needs a different access design.
2. Inspect the real database schema and policies. The UI expects `media_items(id, title, description, content_type, file_path, created_at)` and bucket `media`. Verify public reads are intentional, and insert/update/delete and storage upload permissions are owner-only. Public/publishable-key callers must not be able to write anonymously. **A disabled button or owner ID in JavaScript is not a security boundary.**
3. Verify a unique database constraint on `file_path` before enabling saves. The app checks by that path before retrying a catalog insert; a backend unique constraint is needed to cover concurrent tabs, copied sessions and delayed responses. No constraint was applied by this work.
4. Establish and test the owner's authentication flow. This copy recognizes a verified existing Supabase session through `auth.getUser()` and requires its ID to match `ownerUserId`. It intentionally does not create an account, login screen, credentials or persistent access. Setting an owner UUID and flipping the flag alone will not provide a usable login flow.
5. Verify server-side file size/type restrictions and permissions. Browser extension/size checks are convenience checks, not file-content validation. Uploaded files may contain harmful content. Public links can open external file viewers; upload only content intended for sharing and for which you have rights.
6. Test real schema/RLS/owner-session behavior in an authorized staging environment, including storage success + catalog failure, denied writes, and all supported media formats. Browser codec support varies; file links remain available when a preview cannot play.
7. Run the browser suite and visually inspect desktop/mobile, keyboard-only use and real media playback. Runtime mock tests do not establish visual fidelity or codec compatibility.
8. Obtain authorization before publishing this code, deploying, changing backend policies or uploading assets.

## Interrupted saves

The app writes a project/owner-scoped recovery record to browser session storage before a storage upload. Once uploaded, retry checks for an existing catalog entry and never uploads the file a second time. A failed/ambiguous upload is deliberately blocked instead of blindly repeated. Cancel closes the form but retains unfinished recovery data; reopen displays the title and recovery details.

If upload confirmation was lost, the owner must inspect the exact file path and catalog entry shown under **Recovery details** using authorized tools. Preserve the record until the outcome is reconciled. There is no automatic delete or cleanup. A malformed/unreadable recovery record blocks uploads. Session storage cannot survive every browser/tab reset and does not replace a transactional backend; do not clear it to bypass a pending save.

## Known limits

- No production policy audit, schema migration, owner login flow, pagination under concurrent catalog edits, file-content scanning, or production upload verification is included.
- The app loads the paged catalog into memory and filters locally, suitable for a small personal archive. Very large archives should use server-side search/paging.
- Desktop/mobile browser rendering was not verified in this sandbox: Chromium could not launch because process sockets are restricted. The browser suite is included for an environment that permits Chromium.
