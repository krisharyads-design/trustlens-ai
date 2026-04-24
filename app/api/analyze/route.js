import { NextResponse } from "next/server";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const MAX_VIDEO_FRAMES = 10;
const FAKE_OVERRIDE_TERMS = [
  "ai-generated",
  "synthetic",
  "generated",
  "artificial",
  "edited",
  "effect",
  "laser",
  "overlay",
  "manipulated",
];

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["Real", "AI Generated"],
    },
    confidence: {
      type: "integer",
    },
    reasoning: {
      type: "string",
    },
  },
  required: ["verdict", "confidence", "reasoning"],
};

function buildImagePrompt() {
  return [
    "Analyze the given image and determine if it is AI-generated or real.",
    "Carefully inspect for obvious visual manipulations such as glowing eyes or laser effects, unnatural lighting, added visual effects, overlays, or edits.",
    "You MUST explicitly mention these if present.",
    "",
    "Check for:",
    "* unnatural skin texture or overly smooth areas",
    "* inconsistent lighting or shadows",
    "* asymmetry in facial features",
    "* unnatural eye reflections or mismatched pupils",
    "* artifacts around hair edges or background blending",
    "* distorted ears, teeth, or fine details",
    "* overly perfect symmetry",
    "* edited effects, overlays, or obvious visual manipulation",
    "",
    "Provide:",
    "1. Final verdict (Real / AI Generated)",
    "2. Confidence level (%)",
    "3. Detailed reasoning",
    "",
    "Return only JSON with this exact shape:",
    '{"verdict":"Real|AI Generated","confidence":82,"reasoning":"detailed reasoning"}',
  ].join("\n");
}

function buildVideoPrompt(frameLabel = "") {
  return [
    "Analyze this video frame and determine if the human face shown looks AI-generated or real.",
    "Carefully inspect for obvious visual manipulations such as glowing eyes or laser effects, unnatural lighting, added visual effects, overlays, or edits.",
    "You MUST explicitly mention these if present.",
    frameLabel ? `Frame context: ${frameLabel}` : "",
    "",
    "Check for:",
    "* unnatural skin texture or overly smooth areas",
    "* inconsistent lighting or shadows",
    "* asymmetry in facial features",
    "* unnatural eye reflections or mismatched pupils",
    "* artifacts around hair edges or background blending",
    "* distorted ears, teeth, or fine details",
    "* overly perfect symmetry",
    "* edited effects, overlays, or obvious visual manipulation",
    "",
    "Provide:",
    "1. Final verdict (Real / AI Generated)",
    "2. Confidence level (%)",
    "3. Detailed reasoning",
    "",
    "Return only JSON with this exact shape:",
    '{"verdict":"Real|AI Generated","confidence":82,"reasoning":"detailed reasoning"}',
  ]
    .filter(Boolean)
    .join("\n");
}

function getModelText(responseJson) {
  return (
    responseJson?.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text || ""
  );
}

function parseGeminiJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeResult(result) {
  const allowedStatuses = ["Fake", "Suspicious", "Real"];
  const status = allowedStatuses.includes(result?.status) ? result.status : "Suspicious";
  const trustScore = coerceTrustScoreByStatus(status, result?.trustScore);
  const extra = { ...result };

  delete extra.status;
  delete extra.trustScore;
  delete extra.reason;
  delete extra.context;

  return {
    status,
    trustScore,
    reason: result?.reason || "The model returned a limited explanation.",
    context: result?.context || "This result is an AI estimate and should be verified.",
    ...extra,
  };
}

function coerceTrustScoreByStatus(status, score) {
  const safeScore = Math.max(0, Math.min(100, Number(score) || 50));

  if (status === "Fake") {
    return Math.max(0, Math.min(40, safeScore));
  }

  if (status === "Suspicious") {
    return Math.max(40, Math.min(70, safeScore));
  }

  return Math.max(70, Math.min(100, safeScore));
}

function shouldForceFake(...values) {
  const combined = values
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return FAKE_OVERRIDE_TERMS.some((term) => combined.includes(term));
}

function sanitizeDisplayText(value = "") {
  return String(value || "")
    .replace(/ai-generated/gi, "fake")
    .replace(/artificial/gi, "fake")
    .replace(/synthetic/gi, "fake")
    .replace(/generated/gi, "fake")
    .replace(/manipulated/gi, "fake")
    .replace(/edited/gi, "fake")
    .replace(/\s+/g, " ")
    .trim();
}

function detectVisualAnomalies(reasoning = "") {
  const normalized = String(reasoning || "").toLowerCase();

  return {
    laserEyes:
      normalized.includes("laser") ||
      normalized.includes("glowing eyes") ||
      normalized.includes("glow eye"),
    overlay:
      normalized.includes("overlay") ||
      normalized.includes("effect") ||
      normalized.includes("visual effect"),
    manipulated:
      normalized.includes("manipulated") ||
      normalized.includes("edited") ||
      normalized.includes("unnatural lighting"),
  };
}

function toReasonBullets(reasoning = "", fallbackVerdict = "Fake") {
  const cleaned = sanitizeDisplayText(reasoning);
  const anomalies = detectVisualAnomalies(reasoning);

  const parts = cleaned
    .split(/[\.\;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const prioritized = [];

  if (anomalies.laserEyes) {
    prioritized.push("Artificial laser eye effect detected (non-natural light source)");
  } else if (anomalies.overlay) {
    prioritized.push("Artificial visual effect or overlay detected");
  } else if (anomalies.manipulated) {
    prioritized.push("Edited or manipulated visual content detected");
  }

  const mergedParts = [...prioritized];

  for (const part of parts) {
    if (!mergedParts.some((existing) => existing.toLowerCase() === part.toLowerCase())) {
      mergedParts.push(part);
    }
  }

  if (mergedParts.length > 0) {
    return mergedParts.slice(0, 4).map((part) => `• ${part}`).join("\n");
  }

  return fallbackVerdict === "Real"
    ? "• Natural lighting and detail consistency\n• No strong signs of digital manipulation"
    : "• Synthetic or edited visual cues detected\n• Output appears manipulated or artificially generated";
}

function toShortContext(reasoning = "", status = "Fake") {
  const cleaned = sanitizeDisplayText(reasoning);

  if (cleaned) {
    return cleaned.slice(0, 220);
  }

  return status === "Real"
    ? "The content appears natural and visually consistent."
    : "The content shows signs of artificial generation or visible manipulation.";
}

function normalizeFrameResult(result) {
  const verdict = result?.verdict === "Real" ? "Real" : "AI Generated";
  const confidence = Math.max(0, Math.min(100, Number(result?.confidence) || 50));
  const reasoning = result?.reasoning || "The model returned a limited explanation.";

  return {
    verdict,
    confidence,
    reasoning,
  };
}

function toUiResult(frameResult, extra = {}) {
  const forceFake = shouldForceFake(frameResult.verdict, frameResult.reasoning, extra?.context);
  const baseScore =
    frameResult.verdict === "Real" ? frameResult.confidence : Math.max(0, 100 - frameResult.confidence);
  const rawTrustScore = Math.max(0, Math.min(100, baseScore));
  const status = forceFake
    ? "Fake"
    : rawTrustScore <= 45
      ? "Fake"
      : rawTrustScore <= 85
        ? "Suspicious"
        : "Real";
  const trustScore = coerceTrustScoreByStatus(status, rawTrustScore);

  return normalizeResult({
    status,
    trustScore,
    reason: toReasonBullets(frameResult.reasoning, status),
    context: toShortContext(frameResult.reasoning, status),
    ...extra,
  });
}

async function requestGemini(apiKey, parts) {
  const geminiResponse = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: ANALYSIS_SCHEMA,
      },
    }),
  });

  const geminiJson = await geminiResponse.json();

  if (!geminiResponse.ok) {
    throw new Error(geminiJson?.error?.message || "Gemini request failed. Please try again.");
  }

  const modelText = getModelText(geminiJson);
  const parsed = parseGeminiJson(modelText);

  if (!parsed) {
    throw new Error("Gemini returned an unexpected response format.");
  }

  return normalizeFrameResult(parsed);
}

async function analyzeImage(apiKey, image) {
  return requestGemini(apiKey, [
    {
      text: buildImagePrompt(),
    },
    {
      inlineData: {
        mimeType: image.mimeType || "image/jpeg",
        data: image.data,
      },
    },
  ]);
}

async function analyzeVideoFrames(apiKey, frames = []) {
  const sampledFrames = frames.slice(0, MAX_VIDEO_FRAMES);
  const frameResults = [];

  for (const [index, frame] of sampledFrames.entries()) {
    const frameLabel = `Frame ${index + 1}${
      frame.timestamp !== undefined ? ` at ${frame.timestamp}s` : ""
    }`;

    const result = await requestGemini(apiKey, [
      {
        text: buildVideoPrompt(frameLabel),
      },
      {
        inlineData: {
          mimeType: frame.mimeType || "image/jpeg",
          data: frame.data,
        },
      },
    ]);

    frameResults.push({
      ...result,
      timestamp: frame.timestamp,
    });
  }

  if (frameResults.length === 0) {
    throw new Error("No video frames were available for analysis.");
  }

  const realFrames = frameResults.filter((item) => item.verdict === "Real");
  const aiFrames = frameResults.filter((item) => item.verdict === "AI Generated");
  const majorityFrames =
    realFrames.length === aiFrames.length
      ? frameResults
      : realFrames.length > aiFrames.length
        ? realFrames
        : aiFrames;
  const majorityVerdict =
    realFrames.length === aiFrames.length
      ? "Suspicious"
      : realFrames.length > aiFrames.length
        ? "Real"
        : "AI Generated";
  const averageConfidence = Math.round(
    majorityFrames.reduce((sum, item) => sum + item.confidence, 0) / majorityFrames.length
  );
  const frameSummary = frameResults
    .map(
      (item, index) =>
        `Frame ${index + 1}${item.timestamp !== undefined ? ` (${item.timestamp}s)` : ""}: ${
          item.verdict === "Real" ? "Real" : "Fake"
        } at ${item.confidence}%`
    )
    .join("; ");

  const reasoningSummary = majorityFrames
    .slice(0, 3)
    .map((item) => item.reasoning)
    .join(" ");

  if (majorityVerdict === "Suspicious") {
    return normalizeResult({
      status: "Suspicious",
      trustScore: 50,
      reason: toReasonBullets("Mixed frame results across the video. Some frames appear natural while others show possible manipulation.", "Suspicious"),
      context: toShortContext(`The sampled frames were mixed. ${frameSummary}`, "Suspicious"),
      frameSummaries: frameResults,
      frameCount: frameResults.length,
      analysisMode: "video",
      verdict: "Suspicious",
    });
  }

  return {
    ...toUiResult(
      {
        verdict: majorityVerdict,
        confidence: averageConfidence,
        reasoning: `${reasoningSummary} ${frameSummary}`.trim(),
      },
      {
        frameSummaries: frameResults,
        frameCount: frameResults.length,
        analysisMode: "video",
        verdict: majorityVerdict === "Real" ? "Real" : "Suspicious",
      }
    ),
  };
}

export async function POST(request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing GEMINI_API_KEY in your environment variables." },
        { status: 500 }
      );
    }

    const body = await request.json();
    if (body.kind === "image" && body.image?.data) {
      const imageResult = await analyzeImage(apiKey, body.image);

      return NextResponse.json(
        toUiResult(imageResult, {
          analysisMode: "image",
          verdict: imageResult.verdict,
        })
      );
    }

    if (body.kind === "video" && Array.isArray(body.frames)) {
      return NextResponse.json(await analyzeVideoFrames(apiKey, body.frames));
    }

    return NextResponse.json({ error: "Unsupported media payload." }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      {
        error: error.message || "Server error while analyzing media.",
      },
      { status: 500 }
    );
  }
}
