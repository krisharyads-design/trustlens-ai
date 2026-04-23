"use client";

import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { auth, authPersistenceReady, db, provider } from "./firebase";

const ACCEPTED_TYPES = "image/*,video/*";
const ANALYZE_COOLDOWN_SECONDS = 15;
const RETRY_DELAY_MS = 2000;
const MAX_IMAGE_WIDTH = 600;
const INITIAL_IMAGE_QUALITY = 0.7;
const MIN_IMAGE_QUALITY = 0.4;
const MAX_STORED_IMAGE_BYTES = 200 * 1024;
const MAX_ANALYZE_IMAGE_WIDTH = 800;
const ANALYZE_IMAGE_QUALITY = 0.7;
const MAX_VIDEO_DURATION_SECONDS = 10;
const MAX_VIDEO_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ANALYZE_VIDEO_FRAMES = 3;
const LOCAL_VIDEO_PREFIX = "local-video://";
const FALLBACK_RESULT = {
  status: "Suspicious",
  trustScore: 60,
  reason: "High demand detected, estimated result shown",
  context: "High demand detected. Showing estimated result.",
  isEstimated: true,
};
const LOADING_PHASES = ["Analyzing...", "Detecting patterns...", "Finalizing result..."];

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result || ""));
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

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function estimateDataUrlBytes(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") {
    return 0;
  }

  const base64 = dataUrl.split(",")[1] || "";
  const padding = (base64.match(/=*$/) || [""])[0].length;
  return Math.floor((base64.length * 3) / 4) - padding;
}

async function resizeImageFile(
  file,
  { maxWidth, initialQuality, minQuality, maxBytes, minWidth, minHeight, errorMessage }
) {
  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise((resolve, reject) => {
      const nextImage = new Image();

      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error("Could not load image."));
      nextImage.src = objectUrl;
    });

    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const scale = sourceWidth > maxWidth ? maxWidth / sourceWidth : 1;

    let targetWidth = Math.max(1, Math.round(sourceWidth * scale));
    let targetHeight = Math.max(1, Math.round(sourceHeight * scale));
    let quality = initialQuality;

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error(errorMessage);
    }

    let dataUrl = "";

    while (true) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      context.clearRect(0, 0, targetWidth, targetHeight);
      context.drawImage(image, 0, 0, targetWidth, targetHeight);
      dataUrl = canvas.toDataURL("image/jpeg", quality);

      if (estimateDataUrlBytes(dataUrl) <= maxBytes || (quality <= minQuality && targetWidth <= minWidth)) {
        break;
      }

      if (quality > minQuality) {
        quality = Math.max(minQuality, quality - 0.08);
      } else {
        targetWidth = Math.max(minWidth, Math.round(targetWidth * 0.85));
        targetHeight = Math.max(minHeight, Math.round(targetHeight * 0.85));
      }
    }

    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function compressImageFile(file) {
  return resizeImageFile(file, {
    maxWidth: MAX_IMAGE_WIDTH,
    initialQuality: INITIAL_IMAGE_QUALITY,
    minQuality: MIN_IMAGE_QUALITY,
    maxBytes: MAX_STORED_IMAGE_BYTES,
    minWidth: 240,
    minHeight: 180,
    errorMessage: "Could not prepare image preview.",
  });
}

async function createAnalyzableImage(file) {
  return resizeImageFile(file, {
    maxWidth: MAX_ANALYZE_IMAGE_WIDTH,
    initialQuality: ANALYZE_IMAGE_QUALITY,
    minQuality: ANALYZE_IMAGE_QUALITY,
    maxBytes: MAX_VIDEO_FILE_BYTES,
    minWidth: 320,
    minHeight: 240,
    errorMessage: "Could not prepare image for analysis.",
  });
}

async function loadVideoMetadata(file) {
  const video = document.createElement("video");
  const videoUrl = URL.createObjectURL(file);

  try {
    video.src = videoUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";

    await waitForEvent(video, "loadedmetadata");

    return {
      duration: Number(video.duration) || 0,
      width: video.videoWidth || 640,
      height: video.videoHeight || 360,
    };
  } finally {
    URL.revokeObjectURL(videoUrl);
  }
}

async function captureVideoThumbnail(file, time = 0.5) {
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const videoUrl = URL.createObjectURL(file);

  if (!context) {
    throw new Error("Could not prepare video preview.");
  }

  try {
    video.src = videoUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.crossOrigin = "anonymous";

    await waitForEvent(video, "loadedmetadata");
    await waitForEvent(video, "loadeddata");

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 360;

    const safeTime = Math.min(Math.max(time, 0), Math.max((video.duration || 1) - 0.1, 0));

    if (safeTime > 0) {
      video.currentTime = safeTime;
      await waitForEvent(video, "seeked");
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(videoUrl);
  }
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
  await waitForEvent(video, "loadeddata");

  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 360;

  const duration = Math.min(video.duration || 1, MAX_VIDEO_DURATION_SECONDS);
  const totalFrames = Math.min(MAX_ANALYZE_VIDEO_FRAMES, Math.max(1, Math.ceil(duration)));
  const timestamps = Array.from({ length: totalFrames }, (_, index) => {
    if (totalFrames === 1) {
      return 0;
    }

    const position = (duration * index) / (totalFrames - 1);
    const nextTime = Math.min(Math.max(position, 0), Math.max(duration - 0.1, 0));
    return Number(nextTime.toFixed(2));
  });

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

function getHistoryMediaStorageKey(uid, id) {
  return `trustlens-history-media:${uid}:${id}`;
}

function getLocalHistoryMediaRef(uid, id) {
  return `${LOCAL_VIDEO_PREFIX}${getHistoryMediaStorageKey(uid, id)}`;
}

function persistLocalHistoryMedia(uid, id, mediaUrl) {
  if (!uid || !id || !mediaUrl || typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(getHistoryMediaStorageKey(uid, id), mediaUrl);
}

function readLocalHistoryMedia(mediaRef) {
  if (typeof window === "undefined" || typeof mediaRef !== "string") {
    return "";
  }

  if (!mediaRef.startsWith(LOCAL_VIDEO_PREFIX)) {
    return mediaRef;
  }

  const storageKey = mediaRef.slice(LOCAL_VIDEO_PREFIX.length);
  return window.localStorage.getItem(storageKey) || "";
}

function removeLocalHistoryMedia(mediaRef) {
  if (typeof window === "undefined" || typeof mediaRef !== "string") {
    return;
  }

  if (!mediaRef.startsWith(LOCAL_VIDEO_PREFIX)) {
    return;
  }

  const storageKey = mediaRef.slice(LOCAL_VIDEO_PREFIX.length);
  window.localStorage.removeItem(storageKey);
}

function formatHistoryTitle(item) {
  return item.fileName || `${item.status} result`;
}

function formatHistoryTimestamp(value) {
  if (!value) {
    return "";
  }

  try {
    const date =
      typeof value?.toDate === "function"
        ? value.toDate()
        : value instanceof Date
          ? value
          : null;

    if (!date || Number.isNaN(date.getTime())) {
      return "";
    }

    return new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return "";
  }
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
        <span className="trust-meter-label">Trust Score</span>
        <strong>{safeScore}%</strong>
      </div>
      <div className="trust-meter-track">
        <div className="trust-meter-fill" style={{ width: `${safeScore}%` }} />
      </div>
    </div>
  );
}

function getUserHistoryCollection(uid) {
  return collection(db, "users", uid, "history");
}

function isRetriableAnalysisError(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("quota") ||
    normalized.includes("busy") ||
    normalized.includes("high demand")
  );
}

function isInvalidStoredMedia(value, mediaType = "image") {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }

  if (mediaType === "video") {
    return !(value.startsWith("data:video") || value.startsWith(LOCAL_VIDEO_PREFIX));
  }

  if (!value.startsWith("data:image")) {
    return true;
  }

  return estimateDataUrlBytes(value) > MAX_STORED_IMAGE_BYTES;
}

async function validateVideoFile(file) {
  if (!file) {
    return null;
  }

  if (!["video/mp4", "video/webm"].includes(file.type)) {
    throw new Error("Only MP4 and WebM videos are supported.");
  }

  const metadata = await loadVideoMetadata(file).catch(() => null);

  if (!metadata) {
    throw new Error("Could not read video metadata.");
  }

  if (metadata.duration > MAX_VIDEO_DURATION_SECONDS) {
    throw new Error("Video must be under 10 seconds");
  }

  return metadata;
}

function validateSelectedFile(file) {
  if (!file) {
    return;
  }

  if (file.size > MAX_VIDEO_FILE_BYTES) {
    throw new Error("File must be under 10MB");
  }
}

function getAnalysisCacheKey(file) {
  if (!file) {
    return "";
  }

  return [file.name, file.size, file.type, file.lastModified].join(":");
}

function renderHighlightedText(text) {
  const value = String(text || "");
  const matches = value.split(/(AI Generated|Real)/g);

  return matches.map((part, index) => {
    if (part === "AI Generated") {
      return (
        <span key={`${part}-${index}`} className="keyword-ai">
          {part}
        </span>
      );
    }

    if (part === "Real") {
      return (
        <span key={`${part}-${index}`} className="keyword-real">
          {part}
        </span>
      );
    }

    return part;
  });
}

export default function HomePage() {
  const inputRef = useRef(null);
  const analyzeInFlightRef = useRef(false);
  const cleanedHistoryIdsRef = useRef(new Set());
  const lastAnalysisCacheRef = useRef({ key: "", data: null });
  const [selectedFile, setSelectedFile] = useState(null);
  const [selectedMediaUrl, setSelectedMediaUrl] = useState("");
  const [selectedMediaType, setSelectedMediaType] = useState("image");
  const [selectedThumbnailUrl, setSelectedThumbnailUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [busyMessage, setBusyMessage] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [user, setUser] = useState(null);
  const [history, setHistory] = useState([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [removingHistoryIds, setRemovingHistoryIds] = useState([]);
  const [previewReady, setPreviewReady] = useState(false);
  const [loadingPhaseIndex, setLoadingPhaseIndex] = useState(0);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);

      if (!currentUser) {
        setHistory([]);
        setSelectedHistoryId("");
        setSelectedMediaUrl("");
        setSelectedMediaType("image");
        setSelectedThumbnailUrl("");
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      return undefined;
    }

    const historyQuery = query(
      getUserHistoryCollection(user.uid),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(historyQuery, (snapshot) => {
      const invalidDocIds = [];
      const items = snapshot.docs.map((docSnapshot) => {
        const data = docSnapshot.data();
        const mediaType = data.mediaType || data.type || (data.imageUrl ? "image" : "image");
        const rawMediaUrl = data.mediaUrl || data.imageUrl || null;
        const rawThumbnailUrl =
          data.thumbnailUrl || data.thumbnail || (mediaType === "image" ? rawMediaUrl : null);
        const invalidMediaUrl = isInvalidStoredMedia(rawMediaUrl, mediaType);
        const invalidThumbnailUrl = isInvalidStoredMedia(rawThumbnailUrl, "image");

        if (
          (invalidMediaUrl || invalidThumbnailUrl) &&
          !cleanedHistoryIdsRef.current.has(docSnapshot.id)
        ) {
          invalidDocIds.push(docSnapshot.id);
          cleanedHistoryIdsRef.current.add(docSnapshot.id);
        }

        return {
          id: docSnapshot.id,
          ...data,
          mediaType,
          mediaUrl: invalidMediaUrl ? null : rawMediaUrl,
          thumbnailUrl: invalidThumbnailUrl ? null : rawThumbnailUrl,
          imageUrl: mediaType === "image" && !invalidMediaUrl ? rawMediaUrl : null,
        };
      });

      setHistory(items);

      if (invalidDocIds.length > 0) {
        invalidDocIds.forEach((id) => {
          updateDoc(doc(db, "users", user.uid, "history", id), {
            mediaUrl: null,
            imageUrl: null,
            thumbnailUrl: null,
          }).catch(() => {
            cleanedHistoryIdsRef.current.delete(id);
          });
        });
      }
    });

    return () => unsubscribe();
  }, [user, selectedHistoryId]);

  useEffect(() => {
    if (!selectedFile) {
      setSelectedMediaUrl("");
      setSelectedMediaType("image");
      setSelectedThumbnailUrl("");
      setPreviewReady(false);
      return undefined;
    }

    let isCancelled = false;
    let objectUrl = "";
    setPreviewReady(false);

    if (selectedFile.type.startsWith("video/")) {
      setSelectedMediaType("video");
      objectUrl = URL.createObjectURL(selectedFile);
      setSelectedMediaUrl(objectUrl);

      captureVideoThumbnail(selectedFile)
        .then((dataUrl) => {
          if (!isCancelled) {
            setSelectedThumbnailUrl(dataUrl);
          }
        })
        .catch(() => {
          if (!isCancelled) {
            setSelectedThumbnailUrl("");
            setError("Could not prepare video preview.");
          }
        });
    } else {
      setSelectedMediaType("image");

      compressImageFile(selectedFile)
        .then((dataUrl) => {
          if (!isCancelled) {
            setSelectedMediaUrl(dataUrl);
            setSelectedThumbnailUrl(dataUrl);
          }
        })
        .catch(() => {
          if (!isCancelled) {
            setSelectedMediaUrl("");
            setSelectedThumbnailUrl("");
            setError("Could not prepare image preview.");
          }
        });
    }

    return () => {
      isCancelled = true;

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
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

  useEffect(() => {
    if (!loading) {
      setLoadingPhaseIndex(0);
      return undefined;
    }

    const timer = window.setInterval(() => {
      setLoadingPhaseIndex((current) => (current + 1) % LOADING_PHASES.length);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [loading]);

  async function handleFileSelect(file) {
    if (!file) {
      setSelectedFile(null);
      setSelectedMediaUrl("");
      setSelectedThumbnailUrl("");
      setSelectedMediaType("image");
      setPreviewReady(false);
      return;
    }

    try {
      validateSelectedFile(file);
    } catch (err) {
      setError(err.message || "Could not prepare file.");
      return;
    }

    if (file.type.startsWith("video/")) {
      try {
        await validateVideoFile(file);
      } catch (err) {
        setError(err.message || "Could not prepare video.");
        return;
      }
    }

    setSelectedFile(file);
    setSelectedHistoryId("");
    setError("");
    setBusyMessage("");
  }

  function handleNewSession() {
    setSelectedFile(null);
    setSelectedMediaUrl("");
    setSelectedMediaType("image");
    setSelectedThumbnailUrl("");
    setPreviewReady(false);
    setResult(null);
    setBusyMessage("");
    setError("");
    setSelectedHistoryId("");

    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  async function handleGoogleLogin() {
    try {
      setError("");
      await authPersistenceReady;
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
      setBusyMessage("");
      setSelectedMediaUrl("");
      setSelectedMediaType("image");
      setSelectedThumbnailUrl("");
      setPreviewReady(false);
    } catch (err) {
      setError(err.message || "Logout failed.");
    }
  }

  async function createHistoryMedia(file, mediaType, previewUrl, thumbnailUrl) {
    if (!file) {
      return {
        mediaType,
        mediaUrl: "",
        thumbnailUrl: "",
      };
    }

    if (mediaType === "video") {
      return {
        mediaType,
        mediaUrl: await fileToDataUrl(file),
        thumbnailUrl: thumbnailUrl || (await captureVideoThumbnail(file, 0)),
      };
    }

    const imageUrl = previewUrl || (await compressImageFile(file));

    return {
      mediaType: "image",
      mediaUrl: imageUrl,
      thumbnailUrl: imageUrl,
    };
  }

  async function saveHistoryItem(savedResult, fileName, media = {}) {
    if (!user) {
      return;
    }

    const mediaType = media.mediaType || "image";
    const resultSummary = {
      status: savedResult.status,
      trustScore: savedResult.trustScore,
      reason: savedResult.reason,
      context: savedResult.context,
      isEstimated: Boolean(savedResult.isEstimated),
    };

    const docRef = await addDoc(getUserHistoryCollection(user.uid), {
      userName: user.displayName || "",
      fileName: fileName || "",
      type: mediaType,
      status: savedResult.status,
      trustScore: savedResult.trustScore,
      reason: savedResult.reason,
      context: savedResult.context,
      isEstimated: Boolean(savedResult.isEstimated),
      mediaType,
      mediaUrl:
        mediaType === "video" ? getLocalHistoryMediaRef(user.uid, "pending") : media.mediaUrl || null,
      thumbnail: media.thumbnailUrl || null,
      thumbnailUrl: media.thumbnailUrl || null,
      result: resultSummary,
      timestamp: serverTimestamp(),
      imageUrl: mediaType === "image" ? media.mediaUrl || null : null,
      createdAt: serverTimestamp(),
    });

    if (mediaType === "video" && media.mediaUrl) {
      persistLocalHistoryMedia(user.uid, docRef.id, media.mediaUrl);

      await updateDoc(doc(db, "users", user.uid, "history", docRef.id), {
        mediaUrl: getLocalHistoryMediaRef(user.uid, docRef.id),
      });
    }

    setSelectedHistoryId(docRef.id);
  }

  async function handleDeleteHistory(itemId) {
    try {
      setRemovingHistoryIds((current) =>
        current.includes(itemId) ? current : [...current, itemId]
      );

      await delay(220);
      setHistory((current) => current.filter((item) => item.id !== itemId));
      setRemovingHistoryIds((current) => current.filter((id) => id !== itemId));

      if (selectedHistoryId === itemId) {
        setSelectedHistoryId("");
        setResult(null);
        setSelectedMediaUrl("");
        setSelectedMediaType("image");
        setSelectedThumbnailUrl("");
        setPreviewReady(false);
      }

      const item = history.find((entry) => entry.id === itemId);

      if (item?.mediaType === "video") {
        removeLocalHistoryMedia(item.mediaUrl || "");
      }

      if (!user) {
        return;
      }

      await deleteDoc(doc(db, "users", user.uid, "history", itemId));
    } catch (err) {
      setRemovingHistoryIds((current) => current.filter((id) => id !== itemId));
      setError(err.message || "Could not delete history item.");
    }
  }

  async function createAnalyzePayload(file) {
    if (file.type.startsWith("video/")) {
      const frames = await extractVideoFrames(file);
      return {
        kind: "video",
        fileName: file.name,
        mimeType: file.type,
        frames,
      };
    }

    const dataUrl = await createAnalyzableImage(file);
    const data = dataUrl.split(",")[1] || "";

    return {
      kind: "image",
      fileName: file.name,
      mimeType: "image/jpeg",
      image: {
        mimeType: "image/jpeg",
        data,
      },
    };
  }

  async function requestAnalysis(payload) {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Analysis failed.");
    }

    return data;
  }

  async function analyzeWithRetry(payload, retries = 2) {
    try {
      return await requestAnalysis(payload);
    } catch (error) {
      if (retries > 0 && isRetriableAnalysisError(error?.message)) {
        setBusyMessage("High demand detected. Retrying automatically...");
        await delay(RETRY_DELAY_MS);
        return analyzeWithRetry(payload, retries - 1);
      }

      throw error;
    }
  }

  function resolveHistoryMedia(item) {
    const sourceMediaType = item.mediaType || "image";
    const mediaUrl = readLocalHistoryMedia(item.mediaUrl || "");
    const hasLocalVideo = sourceMediaType !== "video" || Boolean(mediaUrl);

    return {
      mediaType: hasLocalVideo ? sourceMediaType : "image",
      mediaUrl: mediaUrl || item.thumbnailUrl || "",
      thumbnailUrl: item.thumbnailUrl || (sourceMediaType === "image" ? mediaUrl : ""),
      isMissingLocalVideo: sourceMediaType === "video" && !mediaUrl,
    };
  }

  async function handleAnalyze() {
    if (analyzeInFlightRef.current || loading || cooldown > 0) {
      return;
    }

    if (!selectedFile) {
      setError("Please choose an image or video first.");
      return;
    }

    try {
      validateSelectedFile(selectedFile);
    } catch (err) {
      setError(err.message || "Could not prepare file.");
      return;
    }

    if (selectedFile.type.startsWith("video/")) {
      try {
        await validateVideoFile(selectedFile);
      } catch (err) {
        setError(err.message || "Could not prepare video.");
        return;
      }
    }

    analyzeInFlightRef.current = true;
    setLoading(true);
    setError("");
    setBusyMessage("Analyzing... this may take a few seconds");
    setResult(null);

    try {
      const cacheKey = getAnalysisCacheKey(selectedFile);
      let data = null;

      if (lastAnalysisCacheRef.current.key === cacheKey && lastAnalysisCacheRef.current.data) {
        data = lastAnalysisCacheRef.current.data;
      } else {
        const payload = await createAnalyzePayload(selectedFile);

        try {
          data = await analyzeWithRetry(payload);
        } catch (err) {
          if (isRetriableAnalysisError(err?.message)) {
            data = FALLBACK_RESULT;
            setBusyMessage("High demand detected. Showing estimated result.");
          } else {
            throw err;
          }
        }

        lastAnalysisCacheRef.current = { key: cacheKey, data };
      }

      const nextResult = {
        ...data,
        fileName: selectedFile.name,
        mediaType: selectedMediaType,
      };

      setSelectedHistoryId("");
      setResult(nextResult);
      setSelectedMediaType(selectedMediaType || "image");
      setSelectedMediaUrl(selectedMediaUrl || "");
      setSelectedThumbnailUrl(selectedThumbnailUrl || "");

      window.setTimeout(async () => {
        try {
          if (!user) {
            return;
          }

          const media = await createHistoryMedia(
            selectedFile,
            selectedMediaType,
            selectedMediaUrl,
            selectedThumbnailUrl
          );

          await saveHistoryItem(nextResult, selectedFile.name, media);
        } catch (err) {
          setError(err.message || "Could not save history item.");
        }
      }, 100);
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      analyzeInFlightRef.current = false;
      setLoading(false);
      setCooldown(ANALYZE_COOLDOWN_SECONDS);
    }
  }

  function showHistoryItem(item) {
    const media = resolveHistoryMedia(item);

    setSelectedFile(null);
    setSelectedHistoryId(item.id);
    setResult(item);
    setBusyMessage(item.isEstimated ? "High demand detected. Showing estimated result." : "");
    setSelectedMediaType(media.mediaType);
    setSelectedMediaUrl(media.mediaUrl);
    setSelectedThumbnailUrl(media.thumbnailUrl);
    setPreviewReady(false);
    setError("");

    if (media.isMissingLocalVideo) {
      setError("Original video preview is unavailable on this browser. Showing thumbnail instead.");
    }

    if (inputRef.current) {
      inputRef.current.value = "";
    }
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
      <main className="page app-container">
        <div className="page-glow glow-left" />
        <div className="page-glow glow-right" />

        <aside className="sidebar">
          <div className="sidebar-content">
            <div className="sidebar-top">
              <div className="brand">
                <div className="brand-mark">TL</div>
                <span className="brand-name">TrustLens AI</span>
              </div>
              <button className="new-btn" type="button" onClick={handleNewSession}>
                <span aria-hidden="true">+</span>
                <span>New</span>
              </button>

              <div className="divider add-divider" />
            </div>

            <div className="sidebar-middle">
              <p className="sidebar-label">History</p>

              <div className="history-container">
                {user ? (
                  history.length > 0 ? (
                    <div className="history-list">
                      {history.map((item) => {
                        const itemStatus = getStatusFromScore(item.trustScore);
                        const itemTimestamp = formatHistoryTimestamp(item.createdAt || item.timestamp);
                        const historyThumbnail =
                          item.thumbnailUrl || (item.mediaType === "image" ? item.mediaUrl : "");

                        return (
                          <div
                            key={item.id}
                            className={`history-item ${
                              selectedHistoryId === item.id ? "active" : ""
                            } ${removingHistoryIds.includes(item.id) ? "removing" : ""}`}
                          >
                            <button
                              className="history-item-main"
                              onClick={() => showHistoryItem(item)}
                            >
                              <span className="history-thumbnail-shell">
                                {historyThumbnail ? (
                                  <img
                                    className="history-thumbnail"
                                    src={historyThumbnail}
                                    alt={formatHistoryTitle(item)}
                                  />
                                ) : (
                                  <span className="history-thumbnail history-thumb-fallback">
                                    {item.mediaType === "video" ? "VID" : "IMG"}
                                  </span>
                                )}
                                {item.mediaType === "video" ? (
                                  <span className="history-play-badge" aria-hidden="true">
                                    ▶
                                  </span>
                                ) : null}
                              </span>
                              <span className="history-text">
                                <span className="history-title">{formatHistoryTitle(item)}</span>
                                <small className="history-meta">
                                  {item.mediaType === "video" ? "Video" : "Image"} · {itemStatus} ·{" "}
                                  {item.trustScore}%
                                  {itemTimestamp ? ` · ${itemTimestamp}` : ""}
                                </small>
                              </span>
                            </button>
                            <button
                              className="history-delete delete-btn"
                              aria-label="Delete history item"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleDeleteHistory(item.id);
                              }}
                            >
                              🗑
                            </button>
                          </div>
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
            </div>

            <div className="sidebar-bottom sidebar-footer">
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
          </div>
        </aside>

        <section className="main main-content">
          <div className="header">
            <p className="eyebrow">AI-powered trust checking</p>
            <h1>Analyze images and videos</h1>
            <p className="subtext">
              Upload media, run your analysis, and browse saved results from the sidebar.
            </p>
          </div>

          <div className="content-grid">
            <div className="panel glass-card">
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
                    void handleFileSelect(file);
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
                    void handleFileSelect(file);
                  }}
                />

                {selectedMediaUrl ? (
                  <div className="preview-shell">
                    <div className="preview-frame">
                      {selectedMediaType === "video" ? (
                        <div className="preview-video-shell">
                          <video
                            className={`preview-video ${previewReady ? "is-ready" : ""}`}
                            src={selectedMediaUrl}
                            poster={selectedThumbnailUrl || undefined}
                            controls
                            playsInline
                            onLoadedData={() => setPreviewReady(true)}
                          />
                        </div>
                      ) : (
                        <img
                          className={`preview-image ${previewReady ? "is-ready" : ""}`}
                          src={selectedMediaUrl}
                          alt="Selected media"
                          onLoad={() => setPreviewReady(true)}
                        />
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="upload-placeholder">
                    <div className="upload-icon">^</div>
                    <p className="upload-title">Drag and drop your file here</p>
                    <p className="subtext">
                      Upload an image or a video up to 10 seconds and 10 MB.
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
                className="primary-button analyze-button analyze-btn"
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

              {cooldown > 0 ? (
                <p className="cooldown-text">Next analysis available in {cooldown}s.</p>
              ) : null}

              {error ? <p className="error">{error}</p> : null}
            </div>

            <div className="panel glass-card result-panel">
              {loading ? (
                <div className="loading-state">
                  <span className="spinner large" />
                  <div>
                    <p className="eyebrow">Processing</p>
                    <h2>{LOADING_PHASES[loadingPhaseIndex]}</h2>
                    <p className="subtext">
                      {busyMessage || "Analyzing... this may take a few seconds"}
                    </p>
                  </div>
                </div>
              ) : activeResult ? (
                <div className="result-card">
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

                    {activeResult.isEstimated ? (
                      <p className="busy-message">
                        {busyMessage || "High demand detected. Showing estimated result."}
                      </p>
                    ) : null}

                    <div className="result-block">
                      <p className="eyebrow">Reason</p>
                      <p>{renderHighlightedText(activeResult.reason)}</p>
                    </div>

                    <div className="result-block">
                      <p className="eyebrow">Context</p>
                      <p>{renderHighlightedText(activeResult.context)}</p>
                    </div>
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
          display: flex;
          background:
            radial-gradient(circle at 30% 20%, rgba(79, 70, 229, 0.18), transparent 28%),
            radial-gradient(circle at 75% 35%, rgba(168, 85, 247, 0.14), transparent 24%),
            linear-gradient(135deg, #081120 0%, #151230 45%, #050608 100%);
          color: #ececf1;
        }

        .app-container {
          min-height: 100vh;
        }

        .page-glow {
          position: fixed;
          border-radius: 999px;
          filter: blur(90px);
          pointer-events: none;
          opacity: 0.45;
        }

        .glow-left {
          top: 110px;
          left: 340px;
          width: 260px;
          height: 260px;
          background: rgba(59, 130, 246, 0.18);
        }

        .glow-right {
          right: 120px;
          top: 180px;
          width: 300px;
          height: 300px;
          background: rgba(168, 85, 247, 0.14);
        }

        .sidebar {
          position: fixed;
          top: 0;
          left: 0;
          height: 100vh;
          width: 260px;
          padding: 0;
          background: rgba(15, 23, 42, 0.98);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border-right: 0;
          box-shadow: 2px 0 20px rgba(124, 58, 237, 0.15);
          z-index: 10;
          overflow: hidden;
        }

        .sidebar-content {
          height: 100%;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .sidebar-top {
          flex-shrink: 0;
          padding: 18px 16px 12px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        .brand {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .brand-mark {
          width: 28px;
          height: 28px;
          border-radius: 8px;
          background: linear-gradient(135deg, #3b82f6, #8b5cf6);
          color: white;
          display: grid;
          place-items: center;
          font-size: 12px;
          font-weight: 700;
        }

        .brand-name {
          font-size: 14px;
          font-weight: 600;
          letter-spacing: 0.01em;
        }

        .sidebar-middle {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          padding: 0 8px 0 12px;
        }

        .new-btn {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.05);
          color: #ececf1;
          cursor: pointer;
          transition:
            background 0.2s ease,
            border-color 0.2s ease,
            transform 0.2s ease;
        }

        .new-btn:hover {
          background: rgba(255, 255, 255, 0.1);
          border-color: rgba(255, 255, 255, 0.14);
          transform: translateY(-1px);
        }

        .add-divider {
          height: 1px;
          background: rgba(255, 255, 255, 0.1);
          margin: 0;
        }

        .sidebar-label {
          margin: 0;
          padding: 8px 4px 10px 0;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #8e8ea0;
        }

        .history-container {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          padding-right: 5px;
          scrollbar-width: thin;
          scrollbar-color: rgba(148, 163, 184, 0.18) transparent;
        }

        .history-list {
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: 0 4px 16px 0;
        }

        .history-item {
          border-radius: 10px;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px;
          border: 1px solid rgba(255, 255, 255, 0.05);
          transition:
            background 0.2s ease,
            border-color 0.2s ease,
            opacity 0.24s ease,
            transform 0.2s ease;
        }

        .history-item:hover {
          background: rgba(255, 255, 255, 0.05);
          transform: translateX(4px);
        }

        .history-item.active {
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(255, 255, 255, 0.08);
        }

        .history-item-main {
          flex: 1;
          border: 0;
          border-radius: 10px;
          background: transparent;
          color: #ececf1;
          text-align: left;
          padding: 0;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }

        .history-thumbnail-shell {
          position: relative;
          width: 36px;
          height: 36px;
          flex-shrink: 0;
        }

        .history-thumbnail {
          width: 100%;
          height: 100%;
          border-radius: 8px;
          object-fit: cover;
          display: block;
          background: rgba(255, 255, 255, 0.08);
        }

        .history-thumb-fallback {
          display: grid;
          place-items: center;
          font-size: 10px;
          letter-spacing: 0.08em;
          color: #cbd5f5;
          background: rgba(59, 130, 246, 0.16);
        }

        .history-play-badge {
          position: absolute;
          right: -2px;
          bottom: -2px;
          width: 14px;
          height: 14px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          font-size: 8px;
          background: rgba(8, 11, 18, 0.82);
          color: white;
          border: 1px solid rgba(255, 255, 255, 0.16);
        }

        .history-text {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
          overflow: hidden;
        }

        .history-item.removing {
          opacity: 0;
          transform: translateX(-10px);
          pointer-events: none;
        }

        .history-delete {
          margin-left: auto;
          flex-shrink: 0;
          opacity: 0;
          border: 0;
          background: transparent;
          color: #8e8ea0;
          cursor: pointer;
          font-size: 13px;
          line-height: 1;
          padding: 6px;
          border-radius: 8px;
          transform: scale(0.8);
          transition:
            opacity 0.2s ease,
            transform 0.2s ease,
            background 0.2s ease,
            color 0.2s ease;
        }

        .history-item:hover .history-delete,
        .history-item.active .history-delete {
          opacity: 1;
          transform: scale(1);
        }

        .history-delete:hover {
          background: rgba(255, 255, 255, 0.08);
          color: #ececf1;
        }

        .history-title {
          font-size: 14px;
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .history-meta {
          font-size: 12px;
          color: #94a3b8;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .history-item small,
        .sidebar-text,
        .user-subtitle,
        .subtext,
        .eyebrow {
          color: #a1a1b3;
        }

        .sidebar-text {
          padding: 0 10px 20px;
          font-size: 14px;
          line-height: 1.5;
        }

        .sidebar-bottom {
          flex-shrink: 0;
          padding: 12px 16px 18px;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(15, 23, 42, 0.98);
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
        }

        .main {
          margin-left: 260px;
          width: calc(100% - 260px);
          padding: 20px 24px 24px;
          display: flex;
          flex-direction: column;
          justify-content: flex-start;
          align-items: center;
          position: relative;
          z-index: 1;
          overflow: visible;
        }

        .header {
          width: 100%;
          max-width: 1040px;
          padding: 12px 0 18px;
          margin-inline: auto;
        }

        .content-grid {
          width: 100%;
          max-width: 1040px;
          padding: 0;
          margin-inline: auto;
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);
          gap: 24px;
          align-items: start;
        }

        .glass-card {
          background: rgba(255, 255, 255, 0.06);
          backdrop-filter: blur(18px);
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .panel {
          border-radius: 18px;
          padding: 20px;
        }

        .upload-box {
          min-height: 340px;
          border: 1px dashed rgba(255, 255, 255, 0.16);
          border-radius: 14px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          background: rgba(10, 11, 16, 0.45);
        }

        .upload-box.dragging {
          border-color: rgba(96, 165, 250, 0.7);
          background: rgba(15, 18, 28, 0.6);
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
          background: rgba(255, 255, 255, 0.08);
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
          border-radius: 18px;
          background: rgba(8, 9, 14, 0.78);
          border: 1px solid rgba(255, 255, 255, 0.08);
          box-shadow:
            0 10px 30px rgba(0, 0, 0, 0.3),
            0 0 0 1px rgba(255, 255, 255, 0.03) inset;
        }

        .preview-frame {
          width: 100%;
          min-height: 280px;
          height: clamp(280px, 42vh, 420px);
          max-height: 420px;
          padding: 14px;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }

        .preview-image {
          width: 100%;
          height: 100%;
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
          object-position: center center;
          display: block;
          border-radius: 16px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
          opacity: 0;
          transform: scale(0.985);
          transition:
            opacity 0.35s ease,
            transform 0.35s ease;
        }

        .preview-video-shell {
          width: 100%;
          height: 100%;
          max-width: 100%;
          border-radius: 16px;
          overflow: hidden;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
        }

        .preview-video {
          display: block;
          width: 100%;
          height: 100%;
          max-width: 100%;
          max-height: 100%;
          background: #050608;
          border-radius: 16px;
          object-fit: contain;
          object-position: center center;
          opacity: 0;
          transform: scale(0.985);
          transition:
            opacity 0.35s ease,
            transform 0.35s ease;
        }

        .preview-image.is-ready,
        .preview-video.is-ready {
          opacity: 1;
          transform: scale(1);
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
          transition: all 0.2s ease;
        }

        .primary-button {
          border: 0;
          background: linear-gradient(135deg, #3b82f6, #7c3aed);
          color: white;
          padding: 12px 16px;
        }

        .primary-button:hover {
          filter: brightness(1.05);
        }

        .primary-button:disabled {
          opacity: 0.65;
          cursor: not-allowed;
        }

        .ghost-button {
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: transparent;
          color: #ececf1;
          padding: 10px 14px;
        }

        .ghost-button:hover {
          background: rgba(255, 255, 255, 0.06);
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

        .analyze-btn {
          border-radius: 10px;
          transition: all 0.2s ease;
        }

        .analyze-btn:hover:not(:disabled) {
          transform: scale(1.03);
        }

        .loading-inline,
        .loading-state {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .loading-state {
          min-height: 240px;
          animation: fadeIn 0.3s ease;
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

        .result-card {
          padding: 16px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          animation: fadeIn 0.3s ease;
        }

        .main-preview {
          width: 100%;
          max-width: 500px;
          border-radius: 20px;
          overflow: hidden;
          background: rgba(7, 10, 18, 0.9);
          border: 1px solid rgba(255, 255, 255, 0.08);
          box-shadow:
            0 10px 30px rgba(0, 0, 0, 0.3),
            0 0 0 1px rgba(255, 255, 255, 0.03) inset;
        }

        .main-preview-image {
          display: block;
          width: 100%;
          max-width: 100%;
          aspect-ratio: 4 / 3;
          object-fit: cover;
          border-radius: 16px;
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

        .keyword-real {
          color: #86efac;
          font-weight: 600;
        }

        .keyword-ai {
          color: #fca5a5;
          font-weight: 600;
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

        .trust-meter-label {
          margin-right: 8px;
        }

        .trust-meter-track {
          width: 100%;
          height: 6px;
          border-radius: 999px;
          overflow: hidden;
          background: rgba(255, 255, 255, 0.08);
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
          border-top: 1px solid rgba(255, 255, 255, 0.08);
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
        }

        .subtext {
          margin: 0;
          line-height: 1.6;
        }

        .error {
          margin-top: 12px;
          color: #fca5a5;
          font-size: 14px;
        }

        .cooldown-text {
          margin-top: 12px;
          color: #a1a1b3;
          font-size: 14px;
        }

        .busy-message {
          padding: 12px 14px;
          border-radius: 12px;
          background: rgba(245, 158, 11, 0.12);
          border: 1px solid rgba(245, 158, 11, 0.24);
          color: #fcd34d;
          font-size: 14px;
          line-height: 1.5;
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

        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(5px);
          }

          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @media (max-width: 980px) {
          .content-grid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 900px) {
          .page {
            display: block;
            height: auto;
          }

          .sidebar {
            position: static;
            width: 100%;
            height: auto;
            box-shadow: none;
          }

          .sidebar-content,
          .sidebar-middle,
          .history-container {
            overflow: visible;
          }

          .sidebar-label {
            background: transparent;
          }

          .main {
            margin-left: 0;
            width: 100%;
            height: auto;
            padding: 16px;
            overflow: visible;
          }
        }

        @media (max-width: 640px) {
          .main {
            padding: 16px 14px 20px;
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
