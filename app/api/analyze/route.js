import { NextResponse } from "next/server";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const MAX_VIDEO_FRAMES = 10;
const GEMINI_RETRY_COUNT = 3;
const GEMINI_RETRY_DELAY_MS = 1000;
const GEMINI_TIMEOUT_MS = 10000;
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
const SCREENSHOT_INDICATOR_TERMS = [
  "screenshot",
  "screen capture",
  "digital interface",
  "user interface",
  "ui elements",
  "browser bar",
  "browser window",
  "address bar",
  "toolbar",
  "app layout",
  "application interface",
  "web page",
  "website layout",
  "buttons",
  "menus",
  "text blocks",
  "sharp text",
  "readable text",
  "rectangular layout",
];
const AI_FACE_CUE_TERMS = [
  "overly smooth skin",
  "smooth skin texture",
  "waxy skin",
  "plastic skin",
  "lack of pores",
  "lacks pores",
  "lack of natural imperfections",
  "lacks natural imperfections",
  "lack of micro-imperfections",
  "no natural noise",
  "too perfect",
  "perfect lighting",
  "uniform lighting",
  "lighting is uniformly",
  "unusually symmetrical",
  "perfect symmetry",
  "symmetrical facial features",
  "hair strand blending",
  "hair blends",
  "background blur inconsistencies",
  "inconsistent background blur",
  "facial realism",
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
    "Carefully distinguish between:",
    "1. AI-generated images",
    "2. Screenshots of applications or web pages",
    "Do NOT assume a clean, high-quality, or rectangular image is a screenshot.",
    "Only classify an image as a screenshot if visible UI elements are clearly present, such as buttons, readable interface text, browser chrome, app controls, menus, or a clear interface layout.",
    "If there are no clear UI elements, do not call it a screenshot.",
    "If it is clearly a screenshot, classify it as Real and explain the visible interface cues that support that decision.",
    "Carefully inspect for obvious visual manipulations such as glowing eyes or laser effects, unnatural lighting, added visual effects, overlays, or edits.",
    "You MUST explicitly mention these if present.",
    "Even if the image looks realistic, evaluate whether it may be AI-generated based on subtle inconsistencies in texture, lighting, and facial realism.",
    "",
    "Check for:",
    "* unnatural skin texture or overly smooth areas",
    "* overly smooth skin texture",
    "* unnaturally perfect or uniformly distributed lighting",
    "* symmetrical facial features that look unusually perfect",
    "* unnatural hair strand blending",
    "* background blur inconsistencies",
    "* lack of micro-imperfections such as pores, skin texture, camera noise, or tiny blemishes",
    "* inconsistent lighting or shadows",
    "* asymmetry in facial features",
    "* unnatural eye reflections or mismatched pupils",
    "* artifacts around hair edges or background blending",
    "* distorted ears, teeth, or fine details",
    "* overly perfect symmetry",
    "* edited effects, overlays, or obvious visual manipulation",
    "* whether visible UI elements prove the image is actually a screenshot of a digital interface rather than a photo or generated scene",
    "",
    "Classification rule:",
    "* If a human face looks too perfect, lighting is too uniform, and natural noise or skin micro-detail is missing, classify it as AI Generated or at least strongly suspicious.",
    "* Do not use a screenshot label unless visible UI, buttons, readable interface text, browser chrome, or a clear app/web layout is present.",
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
    "Even if the face looks realistic, evaluate whether it may be AI-generated based on subtle inconsistencies in texture, lighting, and facial realism.",
    frameLabel ? `Frame context: ${frameLabel}` : "",
    "",
    "Check for:",
    "* unnatural skin texture or overly smooth areas",
    "* overly smooth skin texture",
    "* unnaturally perfect or uniformly distributed lighting",
    "* symmetrical facial features that look unusually perfect",
    "* unnatural hair strand blending",
    "* background blur inconsistencies",
    "* lack of micro-imperfections such as pores, skin texture, camera noise, or tiny blemishes",
    "* inconsistent lighting or shadows",
    "* asymmetry in facial features",
    "* unnatural eye reflections or mismatched pupils",
    "* artifacts around hair edges or background blending",
    "* distorted ears, teeth, or fine details",
    "* overly perfect symmetry",
    "* edited effects, overlays, or obvious visual manipulation",
    "",
    "Classification rule:",
    "* If the face looks too perfect, lighting is too uniform, and natural noise or skin micro-detail is missing, classify it as AI Generated or at least strongly suspicious.",
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

  if (
    combined.includes("no signs of ai-generated") ||
    combined.includes("no evidence of ai-generated") ||
    combined.includes("not ai-generated") ||
    combined.includes("does not appear ai-generated") ||
    combined.includes("doesn't appear ai-generated") ||
    combined.includes("no signs of synthetic") ||
    combined.includes("no evidence of synthetic") ||
    combined.includes("not synthetic") ||
    combined.includes("no signs of generated") ||
    combined.includes("no evidence of generated")
  ) {
    return false;
  }

  return FAKE_OVERRIDE_TERMS.some((term) => combined.includes(term));
}

function sanitizeDisplayText(value = "") {
  return String(value || "")
    .replace(/Screenshots should NOT be classified as AI-generated content\./gi, "")
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

function detectAiFaceCues(reasoning = "") {
  const normalized = String(reasoning || "").toLowerCase();
  const cueCount = AI_FACE_CUE_TERMS.filter((term) => normalized.includes(term)).length;
  const hasFaceOrPortraitContext =
    normalized.includes("face") ||
    normalized.includes("facial") ||
    normalized.includes("portrait") ||
    normalized.includes("skin") ||
    normalized.includes("hair");
  const hasTextureLightingPair =
    (normalized.includes("smooth") ||
      normalized.includes("pores") ||
      normalized.includes("imperfections") ||
      normalized.includes("noise")) &&
    (normalized.includes("lighting") || normalized.includes("symmetry") || normalized.includes("blur"));

  return {
    cueCount,
    suspicious: hasFaceOrPortraitContext && (cueCount >= 2 || hasTextureLightingPair),
  };
}

function detectScreenshot(reasoning = "", ...extraValues) {
  const combined = [reasoning, ...extraValues]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const hitCount = SCREENSHOT_INDICATOR_TERMS.filter((term) => combined.includes(term)).length;
  const hasScreenshotLabel = combined.includes("screenshot") || combined.includes("screen capture");
  const deniesScreenshot =
    combined.includes("not a screenshot") ||
    combined.includes("not screenshot") ||
    combined.includes("do not call it a screenshot") ||
    combined.includes("no clear ui") ||
    combined.includes("no ui elements") ||
    combined.includes("without ui elements");
  const hasUiChrome =
    combined.includes("browser bar") ||
    combined.includes("browser window") ||
    combined.includes("address bar") ||
    combined.includes("toolbar") ||
    combined.includes("app controls") ||
    combined.includes("application interface");
  const hasInterfaceStructure =
    (combined.includes("button") || combined.includes("buttons")) &&
    (combined.includes("text") || combined.includes("menu") || combined.includes("layout"));
  const hasUiPattern =
    (combined.includes("browser") || combined.includes("app") || combined.includes("interface")) &&
    (combined.includes("sharp text") || combined.includes("readable text") || combined.includes("rectangular"));
  const hasReadableInterfaceText =
    (combined.includes("readable text") || combined.includes("sharp text")) &&
    (combined.includes("interface") || combined.includes("ui") || combined.includes("web page"));

  if (deniesScreenshot) {
    return false;
  }

  return (
    (hasScreenshotLabel && (hasUiChrome || hasInterfaceStructure || hasUiPattern || hasReadableInterfaceText)) ||
    hasUiChrome ||
    hasInterfaceStructure ||
    hasUiPattern ||
    (hitCount >= 3 && hasReadableInterfaceText)
  );
}

function screenshotReasonBullets() {
  return [
    "• This appears to be a screenshot of a digital interface",
    "• Presence of structured UI elements and readable text",
    "• No signs of generative image artifacts",
  ].join("\n");
}

function toReasonBullets(reasoning = "", fallbackVerdict = "Fake") {
  const cleaned = sanitizeDisplayText(reasoning);
  const anomalies = detectVisualAnomalies(reasoning);
  const aiFaceCues = detectAiFaceCues(reasoning);

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

  if (aiFaceCues.suspicious) {
    prioritized.push("Skin appears overly smooth or lacks natural micro-imperfections");
    prioritized.push("Lighting or facial realism shows unusually perfect synthetic traits");
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFallbackResult(extra = {}) {
  return normalizeResult({
    status: "Suspicious",
    trustScore: 50,
    reason:
      "• Analysis could not be completed due to high load\n• Showing safe fallback result",
    context: "AI is taking longer than expected. Showing best estimate.",
    isEstimated: true,
    ...extra,
  });
}

function toUiResult(frameResult, extra = {}) {
  const screenshotDetected = detectScreenshot(
    frameResult.reasoning,
    extra?.context,
    extra?.analysisMode,
    extra?.verdict
  );
  const aiFaceCues = detectAiFaceCues(frameResult.reasoning);
  const forceFake = shouldForceFake(frameResult.verdict, frameResult.reasoning, extra?.context);
  const baseScore =
    frameResult.verdict === "Real" ? frameResult.confidence : Math.max(0, 100 - frameResult.confidence);
  const rawTrustScore = Math.max(0, Math.min(100, baseScore));
  const status = screenshotDetected
    ? "Real"
    : forceFake
      ? "Fake"
      : aiFaceCues.suspicious && rawTrustScore > 70
        ? "Suspicious"
        : rawTrustScore <= 45
        ? "Fake"
        : rawTrustScore <= 85
          ? "Suspicious"
          : "Real";
  const trustScore = screenshotDetected
    ? Math.max(90, coerceTrustScoreByStatus("Real", rawTrustScore))
    : coerceTrustScoreByStatus(status, rawTrustScore);

  return normalizeResult({
    status,
    trustScore,
    reason: screenshotDetected
      ? screenshotReasonBullets()
      : toReasonBullets(frameResult.reasoning, status),
    context: screenshotDetected
      ? "The content appears to be a screenshot of a structured digital interface."
      : toShortContext(frameResult.reasoning, status),
    screenshotDetected,
    ...extra,
  });
}

async function callGemini(apiKey, parts) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const geminiResponse = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: ANALYSIS_SCHEMA,
        },
      }),
    });

    const geminiJson = await geminiResponse.json().catch(() => ({}));

    if (!geminiResponse.ok) {
      throw new Error(geminiJson?.error?.message || "Gemini request failed. Please try again.");
    }

    const modelText = getModelText(geminiJson);
    const parsed = parseGeminiJson(modelText);

    if (!parsed) {
      throw new Error("Empty response");
    }

    return normalizeFrameResult(parsed);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requestGemini(apiKey, parts) {
  let result = null;
  let lastError = null;

  for (let attempt = 0; attempt < GEMINI_RETRY_COUNT; attempt += 1) {
    try {
      result = await callGemini(apiKey, parts);

      if (result) {
        break;
      }

      throw new Error("Empty response");
    } catch (err) {
      lastError = err;
      console.log("API ERROR:", err);

      if (attempt < GEMINI_RETRY_COUNT - 1) {
        await delay(GEMINI_RETRY_DELAY_MS);
      }
    }
  }

  if (!result) {
    throw lastError || new Error("Empty response");
  }

  return result;
}

async function analyzeImage(apiKey, image) {
  try {
    return await requestGemini(apiKey, [
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
  } catch (err) {
    console.log("API ERROR:", err);
    return null;
  }
}

async function analyzeVideoFrames(apiKey, frames = []) {
  const sampledFrames = frames.slice(0, MAX_VIDEO_FRAMES);
  const frameResults = [];

  for (const [index, frame] of sampledFrames.entries()) {
    const frameLabel = `Frame ${index + 1}${
      frame.timestamp !== undefined ? ` at ${frame.timestamp}s` : ""
    }`;

    try {
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
    } catch (err) {
      console.log("API ERROR:", err);
    }
  }

  if (frameResults.length === 0) {
    return createFallbackResult({
      frameSummaries: [],
      frameCount: sampledFrames.length,
      analysisMode: "video",
      verdict: "Suspicious",
    });
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
    const body = await request.json();
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.log("API ERROR:", new Error("Missing GEMINI_API_KEY in your environment variables."));
      return NextResponse.json(
        createFallbackResult({
          analysisMode: body?.kind || "image",
          verdict: "Suspicious",
        })
      );
    }

    if (body.kind === "image" && body.image?.data) {
      const imageResult = await analyzeImage(apiKey, body.image);

      if (!imageResult) {
        return NextResponse.json(
          createFallbackResult({
            analysisMode: "image",
            verdict: "Suspicious",
          })
        );
      }

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

    return NextResponse.json(
      createFallbackResult({
        analysisMode: body?.kind || "image",
        verdict: "Suspicious",
      })
    );
  } catch (error) {
    console.log("API ERROR:", error);
    return NextResponse.json(
      createFallbackResult({
        analysisMode: "image",
        verdict: "Suspicious",
      })
    );
  }
}
