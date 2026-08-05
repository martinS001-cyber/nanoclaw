#!/bin/sh
# Reads mailbox credentials from a mounted JSON file and execs the IMAP/SMTP
# MCP server with them as env vars. email-smtp-imap-mcp has no file-based
# config mode, only env vars — this indirection keeps the real password out
# of container_configs (the mcpServers.env map is materialized to
# groups/<folder>/container.json in plaintext on every spawn); only the file
# path travels through the DB, the password stays in the mounted file.
set -eu

CREDS_FILE="${EMAIL_MCP_CREDENTIALS_FILE:?EMAIL_MCP_CREDENTIALS_FILE not set}"

eval "$(node -e '
  const fs = require("fs");
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const emit = (prefix, section) => {
    for (const [k, v] of Object.entries(section)) {
      console.log(`export ${prefix}_${k.toUpperCase()}=${JSON.stringify(String(v))}`);
    }
  };
  emit("IMAP", c.imap);
  emit("SMTP", c.smtp);
' "$CREDS_FILE")"

exec email-smtp-imap-mcp
