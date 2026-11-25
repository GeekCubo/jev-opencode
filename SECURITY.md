# Security

## Reporting a vulnerability

Report privately through GitHub's **"Report a vulnerability"** (private security advisory) on this repository. A dedicated contact address has not been set up yet. Don't open public issues for vulnerabilities.

## Supported versions

Only the latest commit on `main` (currently 0.1.0) is supported, on OpenCode 2.2.7.

## Credentials

- API keys are read from environment variables or owner-only files. They are never read from plugin options, written to logs, or included in statistics.
- Never commit keys. `.gitignore` excludes common key files, but it doesn't remove anything already committed.
- If a key may have been exposed, rotate it with the provider.

## External evaluation and privacy

When Jev is active or in dry-run, evaluation requests send conversation text, tool names and shortened tool inputs to TypeSafe or OpenCode Zen. Tool outputs are not sent. Secret redaction is regex-based and best effort; it can't detect every secret format. Review your organization's data-handling requirements first, and use `/jev-disable` for sensitive work.

Local data: the mode and counters live in OpenCode plugin storage, and a counters-only snapshot is written to `~/.local/state/opencode-jev/stats.json` (mode 600). No transcripts are stored.
