import { NextResponse } from "next/server";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const MAX_VIDEO_FRAMES = 10;

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
    "",
    "Check for:",
    "* unnatural skin texture or overly smooth areas",
    "* inconsistent lighting or shadows",
    "* asymmetry in facial features",
    "* unnatural eye reflections or mismatched pupils",
    "* artifacts around hair edges or background blending",
    "* distorted ears, teeth, or fine details",
    "* overly perfect symmetry",
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
  const allowedStatuses = ["Real", "Fake", "Suspicious"];
  const status = allowedStatuses.includes(result?.status) ? result.status : "Suspicious";
  const trustScore = Math.max(0, Math.min(100, Number(result?.trustScore) || 50));
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
  const trustScore =
    frameResult.verdict === "Real" ? frameResult.confidence : 100 - frameResult.confidence;

  return normalizeResult({
    status:
      frameResult.verdict === "Real"
        ? trustScore >= 85
          ? "Real"
          : "Suspicious"
        : trustScore < 50
          ? "Fake"
          : "Suspicious",
    trustScore,
    reason: `${frameResult.verdict} (${frameResult.confidence}% confidence)`,
    context: frameResult.reasoning,
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
          item.verdict
        } at ${item.confidence}%`
    )
    .join("; ");

  if (majorityVerdict === "Suspicious") {
    return normalizeResult({
      status: "Suspicious",
      trustScore: 50,
      reason: "Mixed frame results across the video",
      context: `The sampled frames were split between Real and AI Generated. ${frameSummary}`,
      frameSummaries: frameResults,
      frameCount: frameResults.length,
      analysisMode: "video",
      verdict: "Mixed",
    });
  }

  const reasoningSummary = majorityFrames
    .slice(0, 3)
    .map((item) => item.reasoning)
    .join(" ");

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
        verdict: majorityVerdict,
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
