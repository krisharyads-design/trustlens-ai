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
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [user, setUser] = useState(null);
  const [history, setHistory] = useState([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState("");

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
        throw new Error(data.error || "Analysis failed.");
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
    }
  }

  function showHistoryItem(item) {
    setSelectedHistoryId(item.id);
    setResult(item);
  }

  return (
    <>
      <main className="page">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">TL</div>
            <div>
              <p className="kicker">TrustLens AI</p>
              <h2>Media Verifier</h2>
            </div>
          </div>

          {!user ? (
            <button className="primary-sidebar-button" onClick={handleGoogleLogin}>
              Login with Google
            </button>
          ) : (
            <div className="profile-card">
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
          )}

          <div className="history-panel">
            <div className="panel-head">
              <p className="kicker">History</p>
              <span>{history.length}</span>
            </div>

            {user ? (
              history.length > 0 ? (
                <div className="history-list">
                  {history.map((item) => (
                    <button
                      key={item.id}
                      className={`history-item ${
                        selectedHistoryId === item.id ? "active" : ""
                      }`}
                      onClick={() => showHistoryItem(item)}
                    >
                      <span className="history-title">{formatHistoryTitle(item)}</span>
                      <div className="history-meta">
                        <small>{item.status}</small>
                        <small>{item.trustScore}%</small>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="muted">No history yet. Analyze a file to save results.</p>
              )
            ) : (
              <p className="muted">Login to save results and see your history.</p>
            )}
          </div>
        </aside>

        <section className="main">
          <div className="hero-card fade-in">
            <p className="kicker">AI-powered trust checking</p>
            <h1>Analyze images and videos with a polished, simple workflow.</h1>
            <p className="hero-copy">
              Upload media, run your analysis, and browse your saved results in
              the sidebar like a real product dashboard.
            </p>
          </div>

          <div className="content-grid">
            <div className="upload-card fade-in">
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
                  <img className="preview-image" src={previewUrl} alt="Preview" />
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
                disabled={loading}
              >
                {loading ? (
                  <span className="loading-inline">
                    <span className="spinner" />
                    Analyzing...
                  </span>
                ) : (
                  "Analyze Media"
                )}
              </button>

              {error ? <p className="error">{error}</p> : null}
            </div>

            <div className="result-card fade-in">
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
              ) : result ? (
                <>
                  <div className="result-top">
                    <div>
                      <p className="result-label">Latest Result</p>
                      <h3>{result.fileName || "Selected Result"}</h3>
                    </div>
                    <span className={`status-badge ${result.status?.toLowerCase()}`}>
                      {result.status}
                    </span>
                  </div>

                  <TrustMeter score={result.trustScore} />

                  <div className="result-section">
                    <p className="result-label">Reason</p>
                    <p>{result.reason}</p>
                  </div>

                  <div className="result-section">
                    <p className="result-label">Context</p>
                    <p>{result.context}</p>
                  </div>
                </>
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
          display: flex;
          background:
            radial-gradient(circle at top, rgba(88, 101, 242, 0.22), transparent 28%),
            radial-gradient(circle at bottom right, rgba(15, 185, 255, 0.12), transparent 24%),
            linear-gradient(180deg, #08101f 0%, #04070d 100%);
          color: #f5f7ff;
          font-family: "Segoe UI", Arial, sans-serif;
        }

        .sidebar {
          width: 310px;
          padding: 24px 18px;
          position: sticky;
          top: 0;
          height: 100vh;
          backdrop-filter: blur(18px);
          background: rgba(10, 14, 24, 0.72);
          border-right: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .brand {
          display: flex;
          align-items: center;
          gap: 14px;
        }

        .brand-mark {
          width: 44px;
          height: 44px;
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
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 22px;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
          backdrop-filter: blur(18px);
        }

        .profile-card {
          padding: 16px;
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
          padding: 16px;
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
            transform 0.2s ease,
            background 0.2s ease,
            border-color 0.2s ease;
        }

        .history-item:hover {
          transform: translateY(-2px) scale(1.01);
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(124, 77, 255, 0.4);
        }

        .history-item.active {
          background: linear-gradient(
            135deg,
            rgba(68, 147, 255, 0.16),
            rgba(124, 77, 255, 0.16)
          );
          border-color: rgba(124, 77, 255, 0.55);
          box-shadow: 0 0 0 1px rgba(124, 77, 255, 0.12);
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
          flex: 1;
          padding: 28px;
          display: flex;
          flex-direction: column;
          gap: 24px;
        }

        .hero-card,
        .upload-card,
        .result-card {
          padding: 24px;
        }

        .hero-card {
          max-width: 920px;
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

        .upload-box {
          min-height: 360px;
          padding: 18px;
          border-radius: 22px;
          border: 1.5px dashed rgba(124, 77, 255, 0.35);
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.02)),
            rgba(7, 10, 18, 0.7);
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          transition:
            transform 0.25s ease,
            border-color 0.25s ease,
            background 0.25s ease;
        }

        .upload-box:hover,
        .upload-box.dragging {
          transform: translateY(-2px);
          border-color: rgba(88, 101, 242, 0.9);
          background:
            linear-gradient(180deg, rgba(88, 101, 242, 0.08), rgba(124, 77, 255, 0.06)),
            rgba(7, 10, 18, 0.84);
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
          background: linear-gradient(135deg, rgba(68, 147, 255, 0.18), rgba(124, 77, 255, 0.18));
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .upload-title {
          font-size: 1.1rem;
          font-weight: 600;
        }

        .preview-image {
          width: 100%;
          height: 240px;
          object-fit: cover;
          border-radius: 18px;
          border: 1px solid rgba(255, 255, 255, 0.08);
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
            opacity 0.2s ease;
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
          opacity: 0.7;
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
          position: relative;
          overflow: hidden;
        }

        .result-card::before {
          content: "";
          position: absolute;
          inset: -80px auto auto -80px;
          width: 180px;
          height: 180px;
          background: rgba(124, 77, 255, 0.14);
          filter: blur(50px);
          pointer-events: none;
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
        }

        .status-badge.real {
          background: rgba(34, 197, 94, 0.12);
          color: #86efac;
        }

        .status-badge.suspicious {
          background: rgba(245, 158, 11, 0.12);
          color: #fcd34d;
        }

        .status-badge.fake {
          background: rgba(239, 68, 68, 0.12);
          color: #fca5a5;
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
          background: linear-gradient(90deg, #32d583, #4493ff, #7c4dff);
          box-shadow: 0 0 20px rgba(68, 147, 255, 0.45);
          transition: width 0.8s ease;
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
          animation: fadeIn 0.5s ease;
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

        @media (max-width: 1080px) {
          .content-grid {
            grid-template-columns: 1fr;
          }

          .result-card {
            min-height: 0;
          }
        }

        @media (max-width: 900px) {
          .page {
            flex-direction: column;
          }

          .sidebar {
            position: static;
            width: 100%;
            height: auto;
            border-right: 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          }

          .main {
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
