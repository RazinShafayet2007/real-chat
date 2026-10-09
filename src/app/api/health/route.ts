import { NextResponse } from "next/server";
import { isDatabaseConfigured, isDatabaseLive } from "@/server/database";

/** DB wiring status — handy after setting DATABASE_URL on Vercel. */
export async function GET() {
  const live = isDatabaseLive();
  return NextResponse.json({
    status: "ok",
    db: live ? "postgres" : "memory",
    databaseConfigured: isDatabaseConfigured(),
  });
}
