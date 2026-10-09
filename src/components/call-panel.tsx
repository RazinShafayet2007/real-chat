"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";

type CallKind = "audio" | "video";
type CallState =
  | { phase: "idle" }
  | { phase: "calling"; peerSid: string; peerName: string; kind: CallKind }
  | {
      phase: "incoming";
      peerSid: string;
      peerName: string;
      kind: CallKind;
    }
  | {
      phase: "in-call";
      peerSid: string;
      peerName: string;
      kind: CallKind;
    };

interface IceResponse {
  iceServers: RTCIceServer[];
  turnConfigured: boolean;
}

/**
 * 1:1 voice/video calls over WebRTC P2P.
 * The server only relays signaling (invite/accept/SDP/ICE) —
 * media flows directly between browsers. Without TURN creds in
 * .env, calls work on open networks; restrictive NATs need TURN.
 */
export default function CallPanel({
  socket,
  selfSid,
}: {
  socket: Socket | null;
  selfSid: string | null;
}) {
  const [call, setCall] = useState<CallState>({ phase: "idle" });
  const [turnConfigured, setTurnConfigured] = useState(true);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const callRef = useRef(call);
  callRef.current = call;

  const icePromise = useRef<Promise<IceResponse> | null>(null);
  function getIce(): Promise<IceResponse> {
    if (!icePromise.current) {
      icePromise.current = fetch("/api/rtc-config")
        .then((r) => r.json())
        .catch(() => ({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          turnConfigured: false,
        }));
    }
    return icePromise.current;
  }

  const cleanup = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setMuted(false);
    setCameraOff(false);
  }, []);

  const endCall = useCallback(
    (peerSid?: string) => {
      const c = callRef.current;
      const target =
        peerSid ?? (c.phase !== "idle" ? c.peerSid : undefined);
      if (target && socket) socket.emit("call:end", { toSid: target });
      cleanup();
      setCall({ phase: "idle" });
    },
    [socket, cleanup]
  );

  async function makePeer(peerSid: string): Promise<RTCPeerConnection> {
    const { iceServers, turnConfigured } = await getIce();
    setTurnConfigured(turnConfigured);
    const pc = new RTCPeerConnection({ iceServers });
    pcRef.current = pc;
    const remoteStream = new MediaStream();
    pc.ontrack = (e) => {
      e.streams[0]?.getTracks().forEach((t) => remoteStream.addTrack(t));
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = remoteStream;
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && socket) {
        socket.emit("webrtc:signal", {
          toSid: peerSid,
          data: { candidate: e.candidate },
        });
      }
    };
    return pc;
  }

  async function startOffer(peerSid: string, kind: CallKind) {
    try {
      const pc = await makePeer(peerSid);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: kind === "video",
      });
      localStreamRef.current = stream;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket?.emit("webrtc:signal", {
        toSid: peerSid,
        data: { sdp: pc.localDescription },
      });
    } catch {
      setError("Could not access microphone/camera.");
      endCall(peerSid);
    }
  }

  async function handleSignal(from: string, data: unknown) {
    const c = callRef.current;
    if (c.phase === "idle" || from !== c.peerSid) return;
    const d = data as {
      sdp?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    };
    try {
      if (d.sdp) {
        if (d.sdp.type === "offer") {
          // We are the answerer (accepted an invite).
          const pc = await makePeer(from);
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: c.kind === "video",
          });
          localStreamRef.current = stream;
          stream.getTracks().forEach((t) => pc.addTrack(t, stream));
          if (localVideoRef.current) localVideoRef.current.srcObject = stream;
          await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket?.emit("webrtc:signal", {
            toSid: from,
            data: { sdp: pc.localDescription },
          });
          setCall({ phase: "in-call", peerSid: from, peerName: c.peerName, kind: c.kind });
        } else if (d.sdp.type === "answer" && pcRef.current) {
          await pcRef.current.setRemoteDescription(
            new RTCSessionDescription(d.sdp)
          );
          setCall({
            phase: "in-call",
            peerSid: from,
            peerName: c.peerName,
            kind: c.kind,
          });
        }
      } else if (d.candidate && pcRef.current) {
        await pcRef.current.addIceCandidate(new RTCIceCandidate(d.candidate));
      }
    } catch {
      setError("Connection failed.");
      endCall(from);
    }
  }

  // Outgoing invites triggered from the online list via window event.
  useEffect(() => {
    function onInvite(e: Event) {
      const { sid, name, kind } = (e as CustomEvent).detail as {
        sid: string;
        name: string;
        kind: CallKind;
      };
      if (!socket || sid === selfSid) return;
      setError(null);
      setCall({ phase: "calling", peerSid: sid, peerName: name, kind });
      socket.emit("call:invite", { toSid: sid, kind });
    }
    window.addEventListener("rc:call-invite", onInvite);
    return () => window.removeEventListener("rc:call-invite", onInvite);
  }, [socket, selfSid]);

  useEffect(() => {
    if (!socket) return;
    const onInvite = (p: { from: string; fromName: string; kind: CallKind }) => {
      if (callRef.current.phase !== "idle") {
        socket.emit("call:reject", { toSid: p.from });
        return;
      }
      setError(null);
      setCall({
        phase: "incoming",
        peerSid: p.from,
        peerName: p.fromName,
        kind: p.kind,
      });
    };
    const onAccept = (p: { from: string }) => {
      const c = callRef.current;
      if (c.phase !== "calling" || p.from !== c.peerSid) return;
      void startOffer(p.from, c.kind);
    };
    const onReject = (p: { from: string }) => {
      if (callRef.current.phase === "calling") {
        cleanup();
        setError("Call declined.");
        setCall({ phase: "idle" });
      }
    };
    const onEnd = (p: { from: string }) => {
      const c = callRef.current;
      if (c.phase !== "idle" && p.from === c.peerSid) {
        cleanup();
        setCall({ phase: "idle" });
      }
    };
    const onSignal = (p: { from: string; data: unknown }) =>
      void handleSignal(p.from, p.data);
    const onCallError = (msg: string) => {
      setError(typeof msg === "string" ? msg : "Call failed.");
      if (callRef.current.phase === "calling") {
        cleanup();
        setCall({ phase: "idle" });
      }
    };
    socket.on("call:invite", onInvite);
    socket.on("call:accept", onAccept);
    socket.on("call:reject", onReject);
    socket.on("call:end", onEnd);
    socket.on("webrtc:signal", onSignal);
    socket.on("call:error", onCallError);
    return () => {
      socket.off("call:invite", onInvite);
      socket.off("call:accept", onAccept);
      socket.off("call:reject", onReject);
      socket.off("call:end", onEnd);
      socket.off("webrtc:signal", onSignal);
      socket.off("call:error", onCallError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  useEffect(() => () => cleanup(), [cleanup]);

  function accept() {
    const c = callRef.current;
    if (c.phase !== "incoming" || !socket) return;
    socket.emit("call:accept", { toSid: c.peerSid });
    // Wait for the inviter's offer; show in-call UI meanwhile.
    setCall({ phase: "in-call", peerSid: c.peerSid, peerName: c.peerName, kind: c.kind });
  }

  function reject() {
    const c = callRef.current;
    if (c.phase !== "incoming" || !socket) return;
    socket.emit("call:reject", { toSid: c.peerSid });
    setCall({ phase: "idle" });
  }

  function toggleMute() {
    const reenable = muted;
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = reenable;
    });
    setMuted((m) => !m);
  }

  function toggleCamera() {
    localStreamRef.current?.getVideoTracks().forEach((t) => {
      t.enabled = cameraOff;
    });
    setCameraOff((c) => !c);
  }

  if (call.phase === "idle") {
    return error ? (
      <div className="px-4 pb-1 text-xs text-red-500">{error}</div>
    ) : null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 dark:bg-zinc-900">
        {call.phase === "incoming" ? (
          <>
            <h2 className="text-lg font-bold">
              Incoming {call.kind} call
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              {call.peerName} is calling you…
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={accept}
                className="flex-1 rounded-lg bg-green-600 px-3 py-2 font-medium text-white"
              >
                Accept
              </button>
              <button
                onClick={reject}
                className="flex-1 rounded-lg bg-red-600 px-3 py-2 font-medium text-white"
              >
                Decline
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-lg font-bold">
              {call.phase === "calling" ? "Calling" : "On call"} — {call.peerName}
              <span className="ml-2 text-xs font-normal text-zinc-400">
                {call.kind}
              </span>
            </h2>
            {!turnConfigured && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                Direct P2P only — no TURN server configured (see .env).
              </p>
            )}
            {call.phase === "calling" && (
              <p className="mt-1 text-sm text-zinc-500">Ringing…</p>
            )}
            {call.kind === "video" ? (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="h-32 w-full rounded-lg bg-black object-cover"
                />
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="h-32 w-full rounded-lg bg-black object-cover"
                />
              </div>
            ) : (
              <>
                <video ref={localVideoRef} autoPlay muted playsInline className="hidden" />
                <video ref={remoteVideoRef} autoPlay playsInline className="hidden" />
              </>
            )}
            <audio ref={remoteAudioRef} autoPlay />
            {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
            <div className="mt-4 flex gap-2">
              <button
                onClick={toggleMute}
                className="flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/15"
              >
                {muted ? "Unmute" : "Mute"}
              </button>
              {call.kind === "video" && (
                <button
                  onClick={toggleCamera}
                  className="flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/15"
                >
                  {cameraOff ? "Camera on" : "Camera off"}
                </button>
              )}
              <button
                onClick={() => endCall()}
                className="flex-1 rounded-lg bg-red-600 px-3 py-2 font-medium text-white"
              >
                End
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
