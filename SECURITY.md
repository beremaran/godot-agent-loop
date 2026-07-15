# Security Policy

Godot Agent Loop lets an AI agent author, run, and inspect Godot projects on
your machine. It launches Godot processes, reads and writes project files, and
opens a loopback TCP channel into a running game. We take the security of that
surface seriously and appreciate reports that help keep it safe.

## Supported versions

Security fixes are released against the latest published `1.x` line. Older
versions are not patched; please upgrade to the newest release before
reporting.

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅        |
| < 1.0   | ❌        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through either channel:

- **GitHub Security Advisories (preferred):** open a report at
  <https://github.com/beremaran/godot-agent-loop/security/advisories/new>.
  This keeps the discussion private until a fix is ready.
- **Email:** <berke@beremaran.com>. Use a subject line beginning with
  `[SECURITY]`.

Please include, as far as you can determine them:

- The affected version and platform (OS, Node.js version, Godot version).
- A description of the vulnerability and its impact.
- Steps to reproduce, ideally a minimal proof of concept.
- Any relevant configuration (environment variables, privileged-group grants).

### What to expect

- **Acknowledgement** within 3 business days.
- **An initial assessment** within 10 business days.
- Coordinated disclosure: we will agree on a timeline with you, publish a fixed
  release and advisory, and credit you unless you prefer to remain anonymous.

## Scope and threat model

The server is designed to keep dangerous capabilities off by default:

- **Privileged runtime groups** — reflection, code execution, and networking —
  are **denied by default**. They must be explicitly opted into with
  `GODOT_MCP_PRIVILEGED_GROUPS` / `GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS`, and are
  intended only for trusted localhost development.
- **Runtime connections are authenticated** with `GODOT_MCP_RUNTIME_SECRET`. The
  server generates a fresh 256-bit secret when one is not supplied and passes it
  only to Godot processes it launches itself.
- **Transports bind to loopback** and MCP-owned editor/runtime sessions are
  installed transiently and cleaned up afterward.
- **Retained logs and payloads are bounded and redacted** so that source,
  property values, URLs, headers, and engine errors are not echoed back
  wholesale.

Reports that are in scope include, for example: authentication bypass of the
runtime channel, escaping the privileged-group gating, path traversal outside a
managed project, secret leakage, or remote access to a loopback-bound service.

The following are **expected behaviour, not vulnerabilities**: an agent
executing code or mutating files when the operator has explicitly enabled a
privileged group; effects of running the server against untrusted project
sources; and anything requiring an attacker who already has local access to the
same user account and its environment.

Thank you for helping keep Godot Agent Loop and its users safe.
