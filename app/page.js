"use client";

import { useEffect, useRef, useState } from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "firebase/auth";
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

function Meter({ score = 0 }) {
  const safeScore = Math.max(0, Math.min(100, Number(score) || 0));

  return (
    <div className="meter">
      <div className="meter-row">
        <span>Trust Score</span>
        <strong>{safeScore}%</strong>
      </div>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${safeScore}%` }} />
      </div>
    </div>
  );
}

function formatHistoryTitle(item) {
  return item.fileName || `${item.status} result`;
}

export default function HomePage() {
  const inputRef = useRef(null);
  const [selectedFile, setSelectedFile] = useState(null);
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
          <div>
            <h2>TrustLens AI</h2>
            {!user ? (
              <button className="button" onClick={handleGoogleLogin}>
                Login with Google
              </button>
            ) : (
              <div className="user-box">
                <p>{user.displayName}</p>
                <button className="button" onClick={handleLogout}>
                  Logout
                </button>
              </div>
            )}
          </div>

          <div className="history-box">
            <p className="section-title">History</p>
            {user ? (
              history.length > 0 ? (
                history.map((item) => (
                  <button
                    key={item.id}
                    className={`history-item ${
                      selectedHistoryId === item.id ? "active" : ""
                    }`}
                    onClick={() => showHistoryItem(item)}
                  >
                    <span>{formatHistoryTitle(item)}</span>
                    <small>{item.status}</small>
                  </button>
                ))
              ) : (
                <p className="muted">No history yet.</p>
              )
            ) : (
              <p className="muted">Login to see your history.</p>
            )}
          </div>
        </aside>

        <section className="main">
          <div className="panel">
            <h1>Analyze images and videos</h1>
            <p className="muted">
              Upload a file, run analysis, and view saved results in the sidebar.
            </p>

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

              <p>{selectedFile ? selectedFile.name : "Drag and drop a file here"}</p>
              <button className="button" onClick={() => inputRef.current?.click()}>
                Choose File
              </button>
            </div>

            <button className="button analyze" onClick={handleAnalyze} disabled={loading}>
              {loading ? "Analyzing..." : "Analyze Media"}
            </button>

            {error ? <p className="error">{error}</p> : null}

            {result ? (
              <div className="result-card">
                <div className="result-top">
                  <h2>{result.fileName || "Selected Result"}</h2>
                  <span className={`badge ${result.status?.toLowerCase()}`}>
                    {result.status}
                  </span>
                </div>

                <Meter score={result.trustScore} />

                <div className="result-section">
                  <p className="section-title">Reason</p>
                  <p>{result.reason}</p>
                </div>

                <div className="result-section">
                  <p className="section-title">Context</p>
                  <p>{result.context}</p>
                </div>
              </div>
            ) : (
              <div className="result-card">
                <p className="muted">No result selected yet.</p>
              </div>
            )}
          </div>
        </section>
      </main>

      <style jsx>{`
        .page {
          min-height: 100vh;
          display: flex;
          background: #111;
          color: #fff;
        }

        .sidebar {
          width: 280px;
          padding: 16px;
          border-right: 1px solid #2a2a2a;
          background: #181818;
          display: flex;
          flex-direction: column;
          gap: 24px;
        }

        .main {
          flex: 1;
          padding: 24px;
          display: flex;
          justify-content: center;
        }

        .panel {
          width: 100%;
          max-width: 760px;
        }

        .user-box,
        .history-box,
        .result-card,
        .upload-box {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .upload-box,
        .result-card {
          margin-top: 16px;
          padding: 16px;
          border: 1px solid #2a2a2a;
          border-radius: 10px;
          background: #1b1b1b;
        }

        .upload-box.dragging {
          border-color: #555;
        }

        .hidden-input {
          display: none;
        }

        .button {
          padding: 10px 14px;
          border: 1px solid #333;
          border-radius: 8px;
          background: #222;
          color: #fff;
          cursor: pointer;
        }

        .analyze {
          margin-top: 16px;
        }

        .history-item {
          width: 100%;
          text-align: left;
          padding: 10px;
          border: 1px solid #2f2f2f;
          border-radius: 8px;
          background: #202020;
          color: #fff;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .history-item.active {
          border-color: #666;
          background: #2a2a2a;
        }

        .result-top,
        .meter-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
        }

        .meter {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .meter-track {
          height: 10px;
          border-radius: 999px;
          background: #2a2a2a;
          overflow: hidden;
        }

        .meter-fill {
          height: 100%;
          background: #3b82f6;
        }

        .badge {
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 600;
        }

        .badge.real {
          background: #16361f;
          color: #7ee787;
        }

        .badge.suspicious {
          background: #3b2b10;
          color: #f5a524;
        }

        .badge.fake {
          background: #3a1717;
          color: #ff7b72;
        }

        .section-title {
          margin: 0;
          color: #aaa;
          font-size: 12px;
          text-transform: uppercase;
        }

        .result-section {
          border-top: 1px solid #2a2a2a;
          padding-top: 12px;
        }

        .muted {
          color: #aaa;
        }

        .error {
          color: #ff7b72;
        }

        h1,
        h2,
        p {
          margin: 0;
        }

        small {
          color: #aaa;
        }

        @media (max-width: 900px) {
          .page {
            flex-direction: column;
          }

          .sidebar {
            width: 100%;
            border-right: 0;
            border-bottom: 1px solid #2a2a2a;
          }
        }
      `}</style>
    </>
  );
}
