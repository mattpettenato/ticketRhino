export function env() {
  const { DATABASE_URL, TM_API_KEY, SG_CLIENT_ID } = process.env;
  if (!DATABASE_URL || !TM_API_KEY) throw new Error("Missing required env");
  return { DATABASE_URL, TM_API_KEY, SG_CLIENT_ID: SG_CLIENT_ID ?? "" };
}
