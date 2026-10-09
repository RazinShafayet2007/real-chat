import { NextResponse } from "next/server";

/**
 * WebRTC config for voice/video calls (Future-works item).
 * Always includes free STUN so P2P works on most networks.
 * TURN is included only when TURN_* is set in .env (needed for
 * restrictive NATs). Without TURN, calls still work peer-to-peer
 * on open networks — do not expose long-lived TURN credentials
 * to the browser from anywhere else.
 */
export async function GET() {
  const iceServers: RTCIceServer[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];
  const turnConfigured = Boolean(
    process.env.TURN_SERVER_URL &&
      process.env.TURN_USERNAME &&
      process.env.TURN_CREDENTIAL
  );
  if (turnConfigured) {
    iceServers.push({
      urls: [process.env.TURN_SERVER_URL as string],
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return NextResponse.json({ iceServers, turnConfigured });
}
