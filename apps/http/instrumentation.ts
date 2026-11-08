export function register() {
  // Raft opens a pg pool: Node runtime only.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  process.env.RAFT_APP_NAME ??= "nexus-bot";
  if (process.env.NODE_ENV === "production" && !process.env.RAFT_DATABASE_URL) {
    console.warn("[raft] RAFT_DATABASE_URL is not set - errors will not be quarantined");
  }
}
