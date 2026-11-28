# Owner sign in

Routes: `/owner/login`, `/owner/login?returnTo=<path>`

A plain sign-in page for installations where the operator has set up owner sign-in (for example when FLUJO is reached from other machines), or where sign-in for several people is turned on in Settings → "Users and sign-in". In that multi-user mode the page shows "Sign in to FLUJO" with a name and password instead of the owner credential. The owner pastes an owner credential to sign this browser in, or signs the browser out again. The same page can pair the very first owner, using a one-time local pairing code that the operator prepared on the machine running FLUJO; the new owner credential is then shown once. On a normal local desktop install nobody needs this page.

## Sub-features

- `owner-login-sign-in`: "Owner credential" field and "Sign in" button. On success the browser goes to the `returnTo` page, or to `/`.
- `owner-login-sign-out`: "Sign out" button; shows "Signed out." when it worked.
- `owner-login-errors`: status messages such as "The credential is invalid, expired or revoked.", "This credential or browser origin is not authorized." and "Could not reach owner authentication."
- `owner-login-pair-first-owner`: "Pair the first owner" section with "Local pairing capability", a confirmation checkbox and "Pair owner"; afterwards "New owner credential" and a "I saved the credential…" button.
- `owner-login-account-sign-in`: when sign-in for several people is on: heading "Sign in to FLUJO", "Name" and "Password" fields, "Sign in" and "Sign out" buttons, and the server's plain message when sign-in fails (for example "The name or password is not right."). On success the browser goes to the `returnTo` page, or to `/`.
- `owner-login-account-gate`: when sign-in for several people is on and the browser is signed out, every other page shows "Sign in to open FLUJO." with a "Sign in" link to this page. A signed-in person with no workspace sees "You do not have a workspace yet. Ask an admin to give you one."
- `owner-login-gate`: when owner sign-in is required and missing, every other page shows "Sign in as the owner to open this workspace." with an "Owner sign in" link to this page.

## How to get to it (user POV)

- Choose the "Owner sign in" link on the "Sign in as the owner to open this workspace." screen; it returns you to the page you came from after signing in.
- With sign-in for several people turned on, choose the "Sign in" link on the "Sign in to open FLUJO." screen, or "Sign out" in Settings → "Users and sign-in".
- Open `http://127.0.0.1:<port>/owner/login` directly. There is no entry in the navigation.

## Driving it with flujo-drive

Preconditions: a throwaway instance from the verify-flujo skill. A real sign-in needs an instance started with owner sign-in configured and an owner credential; a default throwaway instance has neither, so only the page itself and its refusal can be checked.

- **Open the page**: `node scripts/flujo-drive.mjs open /owner/login` → heading "Owner sign in", the credential field, "Sign in", "Sign out" and the "Pair the first owner" section.
- **Check the refusal**: use `steps /owner/login --file <steps.json>`: fill "Owner credential" with a made-up value, click button "Sign in", `expect-text` "not authorized", then `aria` → a status message explains why sign-in was refused.
- **Two people, each in a private workspace** (needs sign-in for several people turned on with two members; `npm run journey:multi-user` sets this up): `node scripts/check-multi-user.mjs --url <throwaway FLUJO> --browser-steps <folder>` checks over HTTP that each person sees only their own workspace and that every kind of request to the other's answers like a workspace that does not exist, then signs Ben in on this page ("Sign in to FLUJO" → his own workspace) and opens Anna's workspace link as Ben → "Unknown workspace: <Anna's workspace>". It turns sign-in off again at the end.
- **Proof**: an ARIA snapshot and a screenshot of the page with the status message.

## Gotchas

- Multi-user sign-in is on only after someone turns it on in Settings → "Users and sign-in". Then the owner credential form is not shown, and every page needs a signed-in person. Turn it off again there before ending a throwaway run, or throw the instance away.
- Owner sign-in is enforced only when the operator configured it before starting FLUJO. A default install that listens only on this computer ("Localhost" in Settings → Network access) never asks for it.
- If the instance is set to "Local Network" or "Public" without owner sign-in configured, the app's data requests are refused as "Owner authentication is unavailable"; this page cannot fix that.
- The page is English only, looks plain and has no top navigation, by design: it loads before the rest of the app so it can work before sign-in.
- "Pair owner" stays disabled until a correctly shaped pairing code is pasted and the checkbox is ticked. Pairing works only on a local address and only while no owner exists yet.
- Never paste a real owner credential into a run; the field is cleared after each request, but test values must stay test values.
- After pairing, the new owner credential is shown once and not stored in the browser. If pairing fails after it was saved on the server, the page points to offline recovery instead of trying again.
- On a default throwaway instance any "Sign in" attempt ends with "This credential or browser origin is not authorized." That is the expected refusal, not a bug.
