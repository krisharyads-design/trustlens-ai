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
    <div className="meter">
      <div className="meter-head">
        <span>Trust Score</span>
        <strong>{safeScore}%</strong>
      </div>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${safeScore}%` }} />
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
        <div className="page-glow page-glow-left" />
        <div className="page-glow page-glow-right" />

        <aside className={`sidebar-shell ${sidebarOpen ? "open" : "closed"}`}>
          <div className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarOpen((value) => !value)}
              aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            >
              {sidebarOpen ? "<" : ">"}
            </button>

            <div className="sidebar-inner">
              <div className="brand">
                <div className="brand-mark">TL</div>
                {sidebarOpen ? (
                  <div>
                    <p className="kicker">TrustLens AI</p>
                    <h2>Media Verifier</h2>
                  </div>
                ) : null}
              </div>

              {sidebarOpen ? (
                !user ? (
                  <button className="primary-sidebar-button" onClick={handleGoogleLogin}>
                    Login with Google
                  </button>
                ) : (
                  <div className="profile-card glass-card">
                    <img
                      className="avatar"
                      src={user.photoURL || "https://placehold.co/80x80/png"}
                      alt={user.displayName || "User avatar"}
                    />
                    <div>
                      <p className="kicker">Signed in as</p>
                      <p className="profile-name">{user.displayName}</p>
                    </div>
                    <button className="ghost-button" onClick={handleLogout}>
                      Logout
                    </button>
                  </div>
                )
              ) : null}

              {sidebarOpen ? (
                <div className="history-panel glass-card">
                  <div className="panel-head">
                    <p className="kicker">History</p>
                    <span>{history.length}</span>
                  </div>

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
                              <div className="history-meta">
                                <small>{itemStatus}</small>
                                <small>{item.trustScore}%</small>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="muted">No history yet. Analyze a file to save results.</p>
                    )
                  ) : (
                    <p className="muted">Login to save results and see your history.</p>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </aside>

        <section className={`main ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}>
          <div className="hero-card glass-card fade-in">
            <p className="kicker">AI-powered trust checking</p>
            <h1>Analyze images and videos with a polished, simple workflow.</h1>
            <p className="hero-copy">
              Upload media, run your analysis, and browse your saved results in
              the sidebar like a real product dashboard.
            </p>
          </div>

          <div className="content-grid">
            <div className="upload-card glass-card fade-in">
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
                    <div className="upload-icon">↑</div>
                    <p className="upload-title">Drag and drop your file here</p>
                    <p className="muted">
                      Upload an image or video. Images show a preview before you
                      analyze them.
                    </p>
                  </div>
                )}

                <div className="upload-footer">
                  <div>
                    <p className="kicker">Selected file</p>
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
                className="analyze-button"
                onClick={handleAnalyze}
                disabled={analyzeDisabled}
              >
                {loading ? (
                  <span className="loading-inline">
                    <span className="spinner" />
                    <span className="loading-text">{analyzeLabel}</span>
                  </span>
                ) : (
                  analyzeLabel
                )}
              </button>

              {error ? <p className="error">{error}</p> : null}
            </div>

            <div className="result-card glass-card fade-in">
              <div className="card-glow" />

              {loading ? (
                <div className="loading-state">
                  <span className="spinner large" />
                  <div>
                    <p className="result-label">Processing</p>
                    <h3>Analyzing your media...</h3>
                    <p className="muted">
                      We are preparing the file and sending it to the analysis
                      API.
                    </p>
                  </div>
                </div>
              ) : activeResult ? (
                <div className="result-body fade-in">
                  <div className="result-top">
                    <div>
                      <p className="result-label">Latest Result</p>
                      <h3>{activeResult.fileName || "Selected Result"}</h3>
                    </div>
                    <span className={`status-badge ${activeResult.status.toLowerCase()}`}>
                      {activeResult.status}
                    </span>
                  </div>

                  <TrustMeter score={activeResult.trustScore} />

                  <div className="result-section">
                    <p className="result-label">Reason</p>
                    <p>{activeResult.reason}</p>
                  </div>

                  <div className="result-section">
                    <p className="result-label">Context</p>
                    <p>{activeResult.context}</p>
                  </div>
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-orb" />
                  <p className="result-label">No Result Yet</p>
                  <h3>Your analysis summary will appear here.</h3>
                  <p className="muted">
                    Upload a file, click analyze, or open an older result from
                    the sidebar.
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
          position: relative;
          overflow: hidden;
          background:
            radial-gradient(circle at top left, rgba(38, 87, 255, 0.16), transparent 28%),
            linear-gradient(135deg, #07111f 0%, #10142a 42%, #1a1030 100%);
          color: #f5f7ff;
          font-family: "Segoe UI", Arial, sans-serif;
        }

        .page-glow {
          position: absolute;
          border-radius: 999px;
          filter: blur(90px);
          pointer-events: none;
          opacity: 0.45;
        }

        .page-glow-left {
          top: 120px;
          left: 260px;
          width: 260px;
          height: 260px;
          background: rgba(68, 147, 255, 0.24);
        }

        .page-glow-right {
          right: 120px;
          bottom: 100px;
          width: 320px;
          height: 320px;
          background: rgba(143, 76, 255, 0.18);
        }

        .glass-card {
          backdrop-filter: blur(18px);
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
          transition:
            transform 0.25s ease,
            box-shadow 0.25s ease,
            border-color 0.25s ease,
            background 0.25s ease;
        }

        .glass-card:hover {
          border-color: rgba(255, 255, 255, 0.16);
          box-shadow: 0 22px 70px rgba(0, 0, 0, 0.32);
        }

        .sidebar-shell {
          position: fixed;
          top: 18px;
          left: 18px;
          bottom: 18px;
          z-index: 20;
          transition: width 0.32s ease, transform 0.32s ease;
        }

        .sidebar-shell.open {
          width: 278px;
        }

        .sidebar-shell.closed {
          width: 28px;
        }

        .sidebar {
          position: relative;
          height: 100%;
          border-radius: 26px;
          backdrop-filter: blur(20px);
          background: rgba(8, 12, 22, 0.72);
          border: 1px solid rgba(255, 255, 255, 0.08);
          box-shadow: 0 18px 55px rgba(0, 0, 0, 0.28);
          overflow: hidden;
          transition:
            width 0.32s ease,
            transform 0.32s ease,
            box-shadow 0.32s ease;
        }

        .sidebar.open {
          width: 260px;
          transform: translateX(0);
        }

        .sidebar.closed {
          width: 20px;
          transform: translateX(0);
        }

        .sidebar-inner {
          height: 100%;
          padding: 24px 18px;
          display: flex;
          flex-direction: column;
          gap: 20px;
          opacity: 1;
          transition: opacity 0.18s ease;
        }

        .sidebar.closed .sidebar-inner {
          opacity: 0;
          pointer-events: none;
        }

        .sidebar-toggle {
          position: absolute;
          top: 16px;
          right: 8px;
          width: 28px;
          height: 28px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(18, 24, 40, 0.95);
          color: #fff;
          cursor: pointer;
          z-index: 4;
          display: grid;
          place-items: center;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.28);
          transition: transform 0.2s ease, background 0.2s ease, right 0.32s ease;
        }

        .sidebar.open .sidebar-toggle {
          right: 10px;
        }

        .sidebar.closed .sidebar-toggle {
          right: -4px;
        }

        .sidebar-toggle:hover {
          transform: scale(1.06);
          background: rgba(30, 38, 64, 0.95);
        }

        .brand {
          display: flex;
          align-items: center;
          gap: 14px;
          width: 100%;
        }

        .brand-mark {
          width: 44px;
          height: 44px;
          min-width: 44px;
          border-radius: 14px;
          display: grid;
          place-items: center;
          font-weight: 700;
          background: linear-gradient(135deg, #4493ff, #7c4dff);
          box-shadow: 0 12px 30px rgba(68, 147, 255, 0.28);
        }

        .profile-card,
        .history-panel,
        .hero-card,
        .upload-card,
        .result-card {
          border-radius: 22px;
        }

        .profile-card {
          padding: 18px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        .avatar {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          object-fit: cover;
          border: 2px solid rgba(255, 255, 255, 0.16);
        }

        .profile-name {
          font-size: 1rem;
          font-weight: 600;
        }

        .history-panel {
          flex: 1;
          padding: 18px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        .panel-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .history-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
          overflow-y: auto;
          padding-right: 4px;
        }

        .history-item {
          width: 100%;
          text-align: left;
          padding: 14px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.04);
          color: #fff;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          gap: 8px;
          transition:
            transform 0.22s ease,
            background 0.22s ease,
            border-color 0.22s ease,
            box-shadow 0.22s ease;
        }

        .history-item:hover {
          transform: translateY(-2px) scale(1.02);
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(124, 77, 255, 0.4);
          box-shadow: 0 12px 28px rgba(124, 77, 255, 0.12);
        }

        .history-item.active {
          background: linear-gradient(
            135deg,
            rgba(68, 147, 255, 0.18),
            rgba(124, 77, 255, 0.16)
          );
          border-color: rgba(124, 77, 255, 0.6);
          box-shadow:
            0 0 0 1px rgba(124, 77, 255, 0.14),
            0 0 22px rgba(124, 77, 255, 0.22);
        }

        .history-title {
          font-weight: 600;
        }

        .history-meta {
          display: flex;
          justify-content: space-between;
          color: #aeb8d1;
        }

        .main {
          min-height: 100vh;
          z-index: 1;
          display: flex;
          flex-direction: column;
          gap: 24px;
          transition: margin-left 0.32s ease, padding 0.32s ease;
        }

        .main.sidebar-open {
          margin-left: 296px;
          padding: 28px 28px 28px 12px;
        }

        .main.sidebar-closed {
          margin-left: 46px;
          padding: 28px 28px 28px 18px;
        }

        .hero-card,
        .upload-card,
        .result-card {
          padding: 24px;
          position: relative;
        }

        .hero-card {
          max-width: 920px;
        }

        .hero-card:hover {
          transform: translateY(-2px);
        }

        .hero-copy {
          max-width: 650px;
          color: #b9c3dd;
          line-height: 1.7;
        }

        .content-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(320px, 430px);
          gap: 24px;
          align-items: start;
        }

        .upload-card:hover,
        .result-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 24px 75px rgba(0, 0, 0, 0.34);
        }

        .upload-box {
          min-height: 360px;
          padding: 18px;
          border-radius: 22px;
          border: 1.5px dashed rgba(124, 77, 255, 0.35);
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.02)),
            rgba(7, 10, 18, 0.58);
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          transition:
            transform 0.25s ease,
            border-color 0.25s ease,
            background 0.25s ease,
            box-shadow 0.25s ease;
        }

        .upload-box:hover,
        .upload-box.dragging {
          transform: translateY(-2px);
          border-color: rgba(88, 101, 242, 0.95);
          background:
            linear-gradient(180deg, rgba(88, 101, 242, 0.08), rgba(124, 77, 255, 0.06)),
            rgba(7, 10, 18, 0.8);
          box-shadow: 0 0 30px rgba(88, 101, 242, 0.12);
        }

        .hidden-input {
          display: none;
        }

        .upload-placeholder {
          flex: 1;
          display: grid;
          place-items: center;
          text-align: center;
          gap: 12px;
          padding: 22px;
        }

        .upload-icon {
          width: 62px;
          height: 62px;
          border-radius: 20px;
          display: grid;
          place-items: center;
          font-size: 1.8rem;
          background: linear-gradient(
            135deg,
            rgba(68, 147, 255, 0.18),
            rgba(124, 77, 255, 0.18)
          );
          border: 1px solid rgba(255, 255, 255, 0.1);
          box-shadow: 0 12px 30px rgba(68, 147, 255, 0.12);
        }

        .upload-title {
          font-size: 1.1rem;
          font-weight: 600;
        }

        .preview-shell {
          overflow: hidden;
          border-radius: 18px;
          box-shadow: 0 18px 45px rgba(0, 0, 0, 0.28);
        }

        .preview-frame {
          width: 100%;
          height: 240px;
          padding: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          border-radius: 18px;
          background: rgba(3, 7, 16, 0.7);
        }

        .preview-image {
          width: 100%;
          height: 100%;
          object-fit: contain;
          object-position: center;
          display: block;
          border-radius: 14px;
          transition: transform 0.35s ease, filter 0.35s ease;
        }

        .preview-image:hover {
          transform: scale(1.04);
          filter: saturate(1.05);
        }

        .upload-footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 14px;
          margin-top: 18px;
        }

        .file-name {
          font-weight: 600;
          color: #eef2ff;
          word-break: break-word;
        }

        .primary-sidebar-button,
        .analyze-button {
          border: 0;
          color: white;
          cursor: pointer;
          font-weight: 700;
          transition:
            transform 0.2s ease,
            box-shadow 0.2s ease,
            opacity 0.2s ease,
            filter 0.2s ease;
        }

        .primary-sidebar-button,
        .ghost-button,
        .analyze-button {
          border-radius: 16px;
          padding: 12px 16px;
        }

        .primary-sidebar-button,
        .analyze-button {
          background: linear-gradient(135deg, #4493ff, #7c4dff);
          box-shadow: 0 18px 40px rgba(70, 105, 255, 0.28);
        }

        .primary-sidebar-button:hover,
        .analyze-button:hover {
          transform: translateY(-2px) scale(1.01);
          box-shadow: 0 22px 50px rgba(70, 105, 255, 0.35);
          filter: brightness(1.04);
        }

        .primary-sidebar-button:active,
        .analyze-button:active,
        .ghost-button:active {
          transform: scale(0.98);
        }

        .analyze-button {
          margin-top: 18px;
          width: 100%;
          min-height: 56px;
          font-size: 1rem;
        }

        .analyze-button:disabled {
          opacity: 0.72;
          cursor: not-allowed;
          transform: none;
          box-shadow: none;
        }

        .ghost-button {
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(255, 255, 255, 0.05);
          color: #fff;
          cursor: pointer;
          transition:
            transform 0.2s ease,
            background 0.2s ease,
            border-color 0.2s ease;
        }

        .ghost-button:hover {
          transform: translateY(-1px);
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(255, 255, 255, 0.18);
        }

        .loading-inline,
        .loading-state {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .loading-state {
          min-height: 260px;
          justify-content: center;
        }

        .loading-text {
          animation: pulseText 1.2s ease-in-out infinite;
        }

        .spinner {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          border: 2px solid rgba(255, 255, 255, 0.2);
          border-top-color: #fff;
          animation: spin 0.8s linear infinite;
        }

        .spinner.large {
          width: 28px;
          height: 28px;
        }

        .result-card {
          min-height: 420px;
          overflow: hidden;
        }

        .card-glow {
          position: absolute;
          top: -70px;
          left: -40px;
          width: 180px;
          height: 180px;
          background: rgba(124, 77, 255, 0.16);
          filter: blur(50px);
          pointer-events: none;
        }

        .result-body {
          position: relative;
          z-index: 1;
        }

        .result-top,
        .meter-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .status-badge {
          padding: 8px 12px;
          border-radius: 999px;
          font-size: 0.82rem;
          font-weight: 700;
          border: 1px solid rgba(255, 255, 255, 0.08);
          transition: transform 0.25s ease, box-shadow 0.25s ease;
        }

        .status-badge.real {
          background: rgba(34, 197, 94, 0.12);
          color: #86efac;
          box-shadow: 0 0 24px rgba(34, 197, 94, 0.22);
        }

        .status-badge.suspicious {
          background: rgba(245, 158, 11, 0.12);
          color: #fcd34d;
          box-shadow: 0 0 24px rgba(245, 158, 11, 0.22);
        }

        .status-badge.fake {
          background: rgba(239, 68, 68, 0.12);
          color: #fca5a5;
          box-shadow: 0 0 24px rgba(239, 68, 68, 0.22);
        }

        .meter {
          margin-top: 24px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .meter-track {
          height: 12px;
          background: rgba(255, 255, 255, 0.08);
          border-radius: 999px;
          overflow: hidden;
        }

        .meter-fill {
          height: 100%;
          border-radius: 999px;
          background: linear-gradient(90deg, #ef4444 0%, #f59e0b 50%, #22c55e 100%);
          box-shadow: 0 0 20px rgba(245, 158, 11, 0.26);
          transition: width 0.9s ease;
        }

        .result-section {
          margin-top: 24px;
          padding-top: 18px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          line-height: 1.7;
          color: #d9e1f2;
        }

        .empty-state {
          min-height: 320px;
          display: grid;
          place-items: center;
          text-align: center;
          gap: 10px;
          position: relative;
          z-index: 1;
        }

        .empty-orb {
          width: 86px;
          height: 86px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(68, 147, 255, 0.45), rgba(124, 77, 255, 0.1));
          filter: blur(2px);
          box-shadow: 0 0 50px rgba(68, 147, 255, 0.2);
        }

        .kicker,
        .result-label {
          margin: 0;
          font-size: 0.74rem;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: #98a5c6;
        }

        .muted {
          color: #b9c3dd;
          line-height: 1.6;
        }

        .error {
          margin-top: 12px;
          color: #ff9d9d;
        }

        .fade-in {
          animation: fadeIn 0.45s ease;
        }

        h1,
        h2,
        h3,
        p {
          margin: 0;
        }

        h1 {
          margin-top: 8px;
          font-size: clamp(2rem, 4vw, 3.3rem);
          line-height: 1.08;
        }

        h2 {
          font-size: 1.1rem;
        }

        h3 {
          font-size: 1.4rem;
        }

        small {
          color: #aeb8d1;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(8px);
          }

          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes pulseText {
          0%,
          100% {
            opacity: 0.65;
          }

          50% {
            opacity: 1;
          }
        }

        @media (max-width: 1080px) {
          .content-grid {
            grid-template-columns: 1fr;
          }

          .result-card {
            min-height: 0;
          }
        }

        @media (max-width: 900px) {
          .sidebar-shell {
            position: static;
            width: auto !important;
            height: auto;
            margin: 18px 18px 0;
          }

          .sidebar,
          .sidebar.open,
          .sidebar.closed {
            width: 100%;
            height: auto;
          }

          .sidebar.closed {
            width: 100%;
          }

          .sidebar.closed .sidebar-inner {
            opacity: 1;
            pointer-events: auto;
          }

          .sidebar.closed .sidebar-toggle {
            right: 10px;
          }

          .main,
          .main.sidebar-open,
          .main.sidebar-closed {
            margin-left: 0;
            padding: 20px;
          }
        }

        @media (max-width: 640px) {
          .upload-footer,
          .result-top,
          .meter-head {
            flex-direction: column;
            align-items: flex-start;
          }

          .hero-card,
          .upload-card,
          .result-card {
            padding: 18px;
          }
        }
      `}</style>
    </>
  );
}
