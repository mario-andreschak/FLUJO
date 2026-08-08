# Agent tickets

Agents can call the internal create_ticket_for_human MCP tool to leave a plain-text dashboard card for an operator. Messages are capped at 4,000 characters; labels are normalized, restricted to safe display characters, and capped at 12.

Optional conversation and flow ids create internal deep links. Ticket content is untrusted data: it is rendered as plain text and the Ask FLUJO action stores a clearly delimited context draft for a normal chat rather than executing ticket content.
