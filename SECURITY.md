# Security policy

Webscape Wanderer handles passwords and promises not to keep your browsing data, so security reports are our top priority.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private vulnerability reporting: on this repository, open the **Security** tab and choose **Report a vulnerability**. Include the steps to reproduce and the impact.

We aim to reply within 7 days.

## In scope

- Any way browsing data (cookies, storage, history, cache) ends up persisted to disk.
- Data leaking between tabs that should be isolated.
- A web page reading saved passwords, or getting a password filled for another origin.
- Bypassing the vault's encryption or its Touch ID gate.
- Escaping the page sandbox, or reaching the sidebar's IPC from a web page.

## Out of scope

- Vulnerabilities in Chromium itself (report them to the Chromium project). An outdated bundled Chromium *is* in scope.
- Browser fingerprinting. This is a known limitation, documented in the README.
