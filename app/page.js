"use client";

import { useRef, useState } from "react";

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
    <div className="trust-meter">
      <div className="trust-meter-header">
        <p className="section-label">Trust Score</p>
        <strong>{safeScore}%</strong>
      </div>
      <div className="meter-bar">
        <div className="meter-fill" style={{ width: `${safeScore}%` }} />
      </div>
      <p className="meter-text">Higher scores suggest the media looks more reliable.</p>
    </div>
  );
}

export default function HomePage() {
  const inputRef = useRef(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  function handleFileSelect(file) {
    setSelectedFile(file);
    setError("");
    setResult(null);
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

      setResult(data);
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <section className="shell">
        <div className="hero">
          <p className="eyebrow">TrustLens AI</p>
          <h1>Analyze images and videos with a simple trust check.</h1>
          <p className="subtitle">
            Upload a photo or short video, send it to Gemini Vision, and view a
            clean summary with status, score, reason, and context.
          </p>
        </div>

        <div className="card">
          <div
            className={`upload-box ${isDragging ? "upload-box-active" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              const file = event.dataTransfer.files?.[0] || null;
              if (file) handleFileSelect(file);
            }}
          >
            <input
              ref={inputRef}
              className="file-input"
              type="file"
              accept={ACCEPTED_TYPES}
              onChange={(event) => {
                const file = event.target.files?.[0] || null;
                handleFileSelect(file);
              }}
            />

            <div className="upload-content">
              <div className="upload-icon">+</div>
              <h2>Drag and drop your file here</h2>
              <p className="upload-text">
                Supports images and videos. Videos will be split into 3 frames
                before analysis.
              </p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => inputRef.current?.click()}
              >
                Choose File
              </button>
              <p className="file-name">
                {selectedFile ? selectedFile.name : "No file selected yet"}
              </p>
            </div>
          </div>

          <button className="analyze-button" onClick={handleAnalyze} disabled={loading}>
            {loading ? (
              <span className="button-loading">
                <span className="spinner" />
                Analyzing...
              </span>
            ) : (
              "Analyze Media"
            )}
          </button>

          {error ? <p className="error-text">{error}</p> : null}

          {loading ? (
            <div className="loading-card">
              <div className="spinner spinner-large" />
              <div>
                <p className="section-label">Processing</p>
                <p className="loading-text">
                  Preparing your media, extracting frames if needed, and sending
                  everything to Gemini Vision.
                </p>
              </div>
            </div>
          ) : null}

          {result ? (
            <div className="result-card">
              <div className="result-header">
                <div>
                  <p className="section-label">Analysis Result</p>
                  <h2 className="result-title">Trust assessment summary</h2>
                </div>
                <span className={`status-pill status-${result.status?.toLowerCase()}`}>
                  {result.status}
                </span>
              </div>

              <Meter score={result.trustScore} />

              <div className="result-grid">
                <div className="info-card">
                  <p className="section-label">Reason</p>
                  <p>{result.reason}</p>
                </div>
                <div className="info-card">
                  <p className="section-label">Context</p>
                  <p>{result.context}</p>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
