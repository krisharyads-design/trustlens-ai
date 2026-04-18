"use client";

import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import {
  addDoc,
  collection,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { auth, db, provider } from "./firebase";

const ACCEPTED_TYPES = "image/*,video/*";

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result || "");
      const base64 = result.split(",")[1];
      resolve(base64);
    };

    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

function waitForEvent(element, eventName) {
  return new Promise((resolve) => {
    const handler = () => {
      element.removeEventListener(eventName, handler);
      resolve();
    };

    element.addEventListener(eventName, handler);
  });
}

async function extractVideoFrames(file) {
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const videoUrl = URL.createObjectURL(file);

  video.src = videoUrl;
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";

  await waitForEvent(video, "loadedmetadata");

  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 360;

  const duration = video.duration || 1;
  const timestamps = [0.2, 0.5, 0.8].map((point) =>
    Math.min(duration * point, Math.max(duration - 0.1, 0))
  );

  const frames = [];

  for (const time of timestamps) {
    video.currentTime = time;
    await waitForEvent(video, "seeked");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);

    frames.push({
      mimeType: "image/jpeg",
      data: dataUrl.split(",")[1],
      timestamp: Number(time.toFixed(2)),
    });
  }

  URL.revokeObjectURL(videoUrl);
  return frames;
}

function formatHistoryTitle(item) {
  return item.fileName || `${item.status} result`;
}

function getStatusFromScore(score) {
  const safeScore = Math.max(0, Math.min(100, Number(score) || 0));

  if (safeScore > 85) {
    return "Real";
  }

  if (safeScore >= 50) {
    return "Suspicious";
  }

  return "Fake";
}

function TrustMeter({ score = 0 }) {
  const safeScore = Math.max(0, Math.min(100, Number(score) || 0));

  return (
    <div className="trust-meter">
      <div className="trust-meter-head">
        <span>Trust Score</span>
        <strong>{safeScore}%</strong>
      </div>
      <div className="trust-meter-track">
        <div className="trust-meter-fill" style={{ width: `${safeScore}%` }} />
      </div>
    </div>
  );
}

export default function HomePage() {
  const inputRef = useRef(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [user, setUser] = useState(null);
  const [history, setHistory] = useState([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);

      if (!currentUser) {
        setHistory([]);
        setSelectedHistoryId("");
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      return undefined;
    }

    const historyQuery = query(
      collection(db, "history"),
      where("uid", "==", user.uid),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(historyQuery, (snapshot) => {
      const items = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      setHistory(items);

      if (!selectedHistoryId && items[0]) {
        setSelectedHistoryId(items[0].id);
      }
    });

    return () => unsubscribe();
  }, [user, selectedHistoryId]);

  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl("");
      return undefined;
    }

    if (!selectedFile.type.startsWith("image/")) {
      setPreviewUrl("");
      return undefined;
    }

    const objectUrl = URL.createObjectURL(selectedFile);
    setPreviewUrl(objectUrl);

    return () => URL.revokeObjectURL(objectUrl);
  }, [selectedFile]);

  useEffect(() => {
    if (cooldown <= 0) {
      return undefined;
    }

    const timer = setInterval(() => {
      setCooldown((current) => {
        if (current <= 1) {
          clearInterval(timer);
          return 0;
        }

        return current - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [cooldown]);

  function handleFileSelect(file) {
    setSelectedFile(file);
    setError("");
  }

  async function handleGoogleLogin() {
    try {
      setError("");
      await signInWithPopup(auth, provider);
    } catch (err) {
      setError(err.message || "Login failed.");
    }
  }

  async function handleLogout() {
    try {
      setError("");
      await signOut(auth);
      setResult(null);
    } catch (err) {
      setError(err.message || "Logout failed.");
    }
  }

  async function saveHistoryItem(savedResult, fileName) {
    if (!user) {
      return;
    }

    const docRef = await addDoc(collection(db, "history"), {
      uid: user.uid,
      userName: user.displayName || "",
      fileName: fileName || "",
      status: savedResult.status,
      trustScore: savedResult.trustScore,
      reason: savedResult.reason,
      context: savedResult.context,
      createdAt: serverTimestamp(),
    });

    setSelectedHistoryId(docRef.id);
  }

  async function handleAnalyze() {
    if (loading || cooldown > 0) {
      return;
    }

    if (!selectedFile) {
      setError("Please choose an image or video first.");
      return;
    }

    setLoading(true);
    setError("");
    setResult(null);

    try {
      let payload;

      if (selectedFile.type.startsWith("video/")) {
        const frames = await extractVideoFrames(selectedFile);
        payload = {
          kind: "video",
          fileName: selectedFile.name,
          mimeType: selectedFile.type,
          frames,
        };
      } else {
        const data = await fileToBase64(selectedFile);
        payload = {
          kind: "image",
          fileName: selectedFile.name,
          mimeType: selectedFile.type,
          image: {
            mimeType: selectedFile.type,
            data,
          },
        };
      }

      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!response.ok) {
        const message = data.error || "Analysis failed.";
        const lowerMessage = message.toLowerCase();

        if (
          response.status === 429 ||
          lowerMessage.includes("quota") ||
          lowerMessage.includes("rate limit") ||
          lowerMessage.includes("resource exhausted")
        ) {
          throw new Error("Server busy, please wait a few seconds and try again");
        }

        throw new Error(message);
      }

      const nextResult = {
        ...data,
        fileName: selectedFile.name,
      };

      setResult(nextResult);
      await saveHistoryItem(nextResult, selectedFile.name);
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
      setCooldown(30);
    }
  }

  function showHistoryItem(item) {
    setSelectedHistoryId(item.id);
    setResult(item);
  }

  const activeResult = result
    ? { ...result, status: getStatusFromScore(result.trustScore) }
    : null;

  const analyzeDisabled = loading || cooldown > 0;
  const analyzeLabel = loading
    ? "Analyzing..."
    : cooldown > 0
      ? `Wait ${cooldown}s`
      : "Analyze Media";

  return (
    <>
      <main className="page">
        <aside className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
          <div className="sidebar-top">
            <div className="brand">
              <div className="brand-mark">TL</div>
              {sidebarOpen ? <span className="brand-name">TrustLens AI</span> : null}
            </div>

            <button
              className="sidebar-toggle"
              onClick={() => setSidebarOpen((value) => !value)}
              aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            >
              {sidebarOpen ? "<" : ">"}
            </button>
          </div>

          {sidebarOpen ? (
            <>
              <div className="sidebar-history">
                <p className="sidebar-label">History</p>

                {user ? (
                  history.length > 0 ? (
                    <div className="history-list">
                      {history.map((item) => {
                        const itemStatus = getStatusFromScore(item.trustScore);

                        return (
                          <button
                            key={item.id}
                            className={`history-item ${
                              selectedHistoryId === item.id ? "active" : ""
                            }`}
                            onClick={() => showHistoryItem(item)}
                          >
                            <span className="history-title">{formatHistoryTitle(item)}</span>
                            <small>
                              {itemStatus} · {item.trustScore}%
                            </small>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="sidebar-text">No history yet.</p>
                  )
                ) : (
                  <p className="sidebar-text">Login to save and view your history.</p>
                )}
              </div>

              <div className="sidebar-bottom">
                {!user ? (
                  <button className="primary-button" onClick={handleGoogleLogin}>
                    Login with Google
                  </button>
                ) : (
                  <div className="user-row">
                    <div className="user-info">
                      <img
                        className="avatar"
                        src={user.photoURL || "https://placehold.co/80x80/png"}
                        alt={user.displayName || "User avatar"}
                      />
                      <div>
                        <p className="user-name">{user.displayName}</p>
                        <p className="user-subtitle">Signed in</p>
                      </div>
                    </div>
                    <button className="ghost-button small" onClick={handleLogout}>
                      Logout
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="sidebar-collapsed-mark" />
          )}
        </aside>

        <section className={`main ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}>
          <div className="header">
            <p className="eyebrow">AI-powered trust checking</p>
            <h1>Analyze images and videos</h1>
            <p className="subtext">
              Upload media, run your analysis, and browse saved results from the sidebar.
            </p>
          </div>

          <div className="content-grid">
            <div className="panel">
              <div
                className={`upload-box ${isDragging ? "dragging" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                  const file = event.dataTransfer.files?.[0] || null;
                  if (file) {
                    handleFileSelect(file);
                  }
                }}
              >
                <input
                  ref={inputRef}
                  className="hidden-input"
                  type="file"
                  accept={ACCEPTED_TYPES}
                  onChange={(event) => {
                    const file = event.target.files?.[0] || null;
                    handleFileSelect(file);
                  }}
                />

                {previewUrl ? (
                  <div className="preview-shell">
                    <div className="preview-frame">
                      <img className="preview-image" src={previewUrl} alt="Preview" />
                    </div>
                  </div>
                ) : (
                  <div className="upload-placeholder">
                    <div className="upload-icon">^</div>
                    <p className="upload-title">Drag and drop your file here</p>
                    <p className="subtext">
                      Upload an image or video. Images show a preview before analysis.
                    </p>
                  </div>
                )}

                <div className="upload-footer">
                  <div>
                    <p className="eyebrow">Selected file</p>
                    <p className="file-name">
                      {selectedFile ? selectedFile.name : "No file selected"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => inputRef.current?.click()}
                  >
                    Choose File
                  </button>
                </div>
              </div>

              <button
                className="primary-button analyze-button"
                onClick={handleAnalyze}
                disabled={analyzeDisabled}
              >
                {loading ? (
                  <span className="loading-inline">
                    <span className="spinner" />
                    <span>{analyzeLabel}</span>
                  </span>
                ) : (
                  analyzeLabel
                )}
              </button>

              {error ? <p className="error">{error}</p> : null}
            </div>

            <div className="panel result-panel">
              {loading ? (
                <div className="loading-state">
                  <span className="spinner large" />
                  <div>
                    <p className="eyebrow">Processing</p>
                    <h2>Analyzing your media...</h2>
                    <p className="subtext">
                      We are preparing the file and sending it to the analysis API.
                    </p>
                  </div>
                </div>
              ) : activeResult ? (
                <div className="result-content">
                  <div className="result-header">
                    <div>
                      <p className="eyebrow">Latest result</p>
                      <h2>{activeResult.fileName || "Selected Result"}</h2>
                    </div>
                    <span className={`status-badge ${activeResult.status.toLowerCase()}`}>
                      {activeResult.status}
                    </span>
                  </div>

                  <TrustMeter score={activeResult.trustScore} />

                  <div className="result-block">
                    <p className="eyebrow">Reason</p>
                    <p>{activeResult.reason}</p>
                  </div>

                  <div className="result-block">
                    <p className="eyebrow">Context</p>
                    <p>{activeResult.context}</p>
                  </div>
                </div>
              ) : (
                <div className="empty-state">
                  <p className="eyebrow">No result yet</p>
                  <h2>Your analysis summary will appear here.</h2>
                  <p className="subtext">
                    Upload a file, click analyze, or open an older result from the sidebar.
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      <style jsx>{`
        .page {
          min-height: 100vh;
          background: #202123;
          color: #ececf1;
        }

        .sidebar {
          position: fixed;
          top: 0;
          left: 0;
          bottom: 0;
          background: #171717;
          border-right: 1px solid #2a2b32;
          display: flex;
          flex-direction: column;
          transition: width 0.25s ease;
          overflow: hidden;
        }

        .sidebar.open {
          width: 260px;
        }

        .sidebar.closed {
          width: 20px;
        }

        .sidebar-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 12px;
          min-height: 56px;
        }

        .brand {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }

        .brand-mark {
          width: 28px;
          height: 28px;
          border-radius: 8px;
          background: #2f6fed;
          color: white;
          display: grid;
          place-items: center;
          font-size: 12px;
          font-weight: 700;
        }

        .brand-name {
          font-size: 14px;
          font-weight: 600;
          white-space: nowrap;
        }

        .sidebar-toggle {
          width: 28px;
          height: 28px;
          border: 0;
          border-radius: 8px;
          background: transparent;
          color: #b4b7c5;
          cursor: pointer;
        }

        .sidebar-toggle:hover {
          background: #2a2b32;
          color: #ececf1;
        }

        .sidebar-history {
          flex: 1;
          padding: 8px 10px 12px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .sidebar-label {
          margin: 0 6px 10px;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #8e8ea0;
        }

        .history-list {
          display: flex;
          flex-direction: column;
          gap: 2px;
          overflow-y: auto;
        }

        .history-item {
          width: 100%;
          border: 0;
          border-radius: 10px;
          background: transparent;
          color: #ececf1;
          text-align: left;
          padding: 10px 12px;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .history-item:hover {
          background: #2a2b32;
        }

        .history-item.active {
          background: #343541;
        }

        .history-title {
          font-size: 14px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .history-item small {
          color: #8e8ea0;
        }

        .sidebar-text {
          padding: 0 6px;
          color: #8e8ea0;
          font-size: 14px;
          line-height: 1.5;
        }

        .sidebar-bottom {
          border-top: 1px solid #2a2b32;
          padding: 12px 10px;
        }

        .user-row {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .user-info {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .avatar {
          width: 32px;
          height: 32px;
          border-radius: 999px;
          object-fit: cover;
        }

        .user-name {
          margin: 0;
          font-size: 14px;
          font-weight: 500;
        }

        .user-subtitle {
          margin: 2px 0 0;
          font-size: 12px;
          color: #8e8ea0;
        }

        .sidebar-collapsed-mark {
          flex: 1;
        }

        .main {
          min-height: 100vh;
          transition: margin-left 0.25s ease;
        }

        .main.sidebar-open {
          margin-left: 260px;
        }

        .main.sidebar-closed {
          margin-left: 20px;
        }

        .header {
          max-width: 960px;
          padding: 32px 32px 20px;
        }

        .content-grid {
          max-width: 960px;
          padding: 0 32px 32px;
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);
          gap: 24px;
          align-items: start;
        }

        .panel {
          background: #202123;
          border: 1px solid #2a2b32;
          border-radius: 16px;
          padding: 20px;
        }

        .upload-box {
          min-height: 340px;
          border: 1px dashed #3a3b44;
          border-radius: 14px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          background: #171717;
        }

        .upload-box.dragging {
          border-color: #5b8cff;
          background: #1b1d22;
        }

        .hidden-input {
          display: none;
        }

        .upload-placeholder {
          flex: 1;
          display: grid;
          place-items: center;
          text-align: center;
          gap: 10px;
          padding: 20px;
        }

        .upload-icon {
          width: 44px;
          height: 44px;
          border-radius: 12px;
          background: #2a2b32;
          display: grid;
          place-items: center;
          color: #ececf1;
        }

        .upload-title {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
        }

        .preview-shell {
          overflow: hidden;
          border-radius: 12px;
          background: #111214;
        }

        .preview-frame {
          width: 100%;
          height: 240px;
          padding: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }

        .preview-image {
          width: 100%;
          height: 100%;
          object-fit: contain;
          object-position: center;
          display: block;
        }

        .upload-footer {
          margin-top: 16px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .file-name {
          margin: 4px 0 0;
          font-size: 14px;
          color: #ececf1;
          word-break: break-word;
        }

        .primary-button,
        .ghost-button {
          border-radius: 10px;
          font-size: 14px;
          cursor: pointer;
        }

        .primary-button {
          border: 0;
          background: #2f6fed;
          color: white;
          padding: 12px 16px;
        }

        .primary-button:hover {
          background: #2563eb;
        }

        .primary-button:disabled {
          opacity: 0.65;
          cursor: not-allowed;
        }

        .ghost-button {
          border: 1px solid #3a3b44;
          background: transparent;
          color: #ececf1;
          padding: 10px 14px;
        }

        .ghost-button:hover {
          background: #2a2b32;
        }

        .ghost-button.small {
          padding: 8px 12px;
          align-self: flex-start;
        }

        .analyze-button {
          margin-top: 16px;
          width: 100%;
          min-height: 46px;
        }

        .loading-inline,
        .loading-state {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .loading-state {
          min-height: 240px;
        }

        .spinner {
          width: 16px;
          height: 16px;
          border-radius: 999px;
          border: 2px solid rgba(255, 255, 255, 0.2);
          border-top-color: white;
          animation: spin 0.8s linear infinite;
        }

        .spinner.large {
          width: 24px;
          height: 24px;
        }

        .result-panel {
          min-height: 420px;
        }

        .result-content {
          display: flex;
          flex-direction: column;
          gap: 24px;
        }

        .result-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }

        .status-badge {
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 600;
          border: 1px solid transparent;
        }

        .status-badge.real {
          background: rgba(34, 197, 94, 0.12);
          color: #86efac;
          border-color: rgba(34, 197, 94, 0.24);
        }

        .status-badge.suspicious {
          background: rgba(245, 158, 11, 0.12);
          color: #fcd34d;
          border-color: rgba(245, 158, 11, 0.24);
        }

        .status-badge.fake {
          background: rgba(239, 68, 68, 0.12);
          color: #fca5a5;
          border-color: rgba(239, 68, 68, 0.24);
        }

        .trust-meter {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .trust-meter-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          font-size: 14px;
        }

        .trust-meter-track {
          width: 100%;
          height: 6px;
          border-radius: 999px;
          overflow: hidden;
          background: #2a2b32;
        }

        .trust-meter-fill {
          height: 100%;
          border-radius: 999px;
          background: linear-gradient(90deg, #ef4444 0%, #f59e0b 50%, #22c55e 100%);
          transition: width 0.6s ease;
        }

        .result-block {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding-top: 16px;
          border-top: 1px solid #2a2b32;
        }

        .empty-state {
          min-height: 240px;
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 12px;
        }

        .eyebrow {
          margin: 0;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #8e8ea0;
        }

        .subtext {
          margin: 0;
          color: #b4b7c5;
          line-height: 1.6;
        }

        .error {
          margin-top: 12px;
          color: #fca5a5;
          font-size: 14px;
        }

        h1,
        h2,
        p {
          margin: 0;
        }

        h1 {
          margin-top: 8px;
          font-size: clamp(2rem, 4vw, 2.8rem);
          line-height: 1.1;
        }

        h2 {
          font-size: 20px;
          line-height: 1.3;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        @media (max-width: 980px) {
          .content-grid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 900px) {
          .sidebar {
            position: static;
            width: 100% !important;
            border-right: 0;
            border-bottom: 1px solid #2a2b32;
          }

          .sidebar.closed .sidebar-inner {
            opacity: 1;
            pointer-events: auto;
          }

          .main,
          .main.sidebar-open,
          .main.sidebar-closed {
            margin-left: 0;
          }
        }

        @media (max-width: 640px) {
          .header,
          .content-grid {
            padding-left: 16px;
            padding-right: 16px;
          }

          .upload-footer,
          .result-header,
          .trust-meter-head {
            flex-direction: column;
            align-items: flex-start;
          }

          .panel {
            padding: 16px;
          }
        }
      `}</style>
    </>
  );
}
