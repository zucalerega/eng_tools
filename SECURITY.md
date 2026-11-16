# Security

YJSP keeps a team's flight hardware's designs and test data, so a hole in it matters. If you find one, please tell us
privately, and not in an issue, a pull request, or anywhere public.

## Reporting a vulnerability

Report it through GitHub's private vulnerability reporting: the repository's **Security** tab, then **Report a
vulnerability**. Say what's affected (the server, the web app, the `vault` command, or the SolidWorks add-in, and which
version), how to reproduce it, and what it lets someone do. We'll answer as soon as we can, keep you told as it's
fixed, and credit you in the release that fixes it unless you'd rather we didn't.

## What's supported

The latest release, and `main`. A fix goes into a new release; there are no updates to older ones.

## What's in scope

Anything that lets someone see or change what they shouldn't: signing in as someone else, reading a file in a folder
they can't see, changing the vault without the right role, getting around the add-in's check of its installer's
signature, reaching anything without signing in that should need it, or running code on the server. Things that need the
server's own settings or files (its `.env`) to begin with are out of scope, as is anything that floods the server with
requests.
