# ADR 0002: Validate and pin monitor destinations

- Status: Accepted
- Date: 2026-11-12

## Context

Customers can submit URLs for background HTTP checks. Those destinations are untrusted and could resolve to the local network, cloud metadata services, or a different address between validation and connection.

## Decision

The worker accepts only credential-free HTTP and HTTPS URLs on their standard ports. Before a check, it resolves the hostname and rejects any non-public address. The HTTP agent performs the same validation at connection time and connects to a validated address. Redirects are not followed, requests have a fixed timeout, response headers are bounded, and response bodies are closed without buffering.

## Consequences

- A redirect is reported as a failed check; users must monitor the final destination directly.
- Hosts with mixed public and private DNS answers are rejected.
- The check runner does not download or retain target response bodies.
- Network-level egress restrictions remain a useful additional control in production.
