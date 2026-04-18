import { NextResponse } from "next/server";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

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

  return {
    status,
    trustScore,
    reason: result?.reason || "The model returned a limited explanation.",
    context: result?.context || "This result is an AI estimate and should be verified.",
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
    const parts = [
      {
        text:
          "You are TrustLens AI. Analyze the uploaded media and decide if it looks Real, Fake, or Suspicious. Return only JSON with this exact shape: " +
          '{"status":"Real|Fake|Suspicious","trustScore":78,"reason":"short reason","context":"helpful context"}.' +
          " Use 0 to 100 for trustScore.",
      },
    ];

    if (body.kind === "image" && body.image?.data) {
      parts.push({
        inlineData: {
          mimeType: body.image.mimeType || "image/jpeg",
          data: body.image.data,
        },
      });
    }

    if (body.kind === "video" && Array.isArray(body.frames)) {
      body.frames.slice(0, 3).forEach((frame, index) => {
        parts.push({
          text: `Video frame ${index + 1}${frame.timestamp !== undefined ? ` at ${frame.timestamp}s` : ""}`,
        });
        parts.push({
          inlineData: {
            mimeType: frame.mimeType || "image/jpeg",
            data: frame.data,
          },
        });
      });
    }

    const geminiResponse = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: {
            type: "object",
            properties: {
              status: {
                type: "string",
                enum: ["Real", "Fake", "Suspicious"],
              },
              trustScore: {
                type: "integer",
              },
              reason: {
                type: "string",
              },
              context: {
                type: "string",
              },
            },
            required: ["status", "trustScore", "reason", "context"],
          },
        },
      }),
    });

    const geminiJson = await geminiResponse.json();

    if (!geminiResponse.ok) {
      const message =
        geminiJson?.error?.message || "Gemini request failed. Please try again.";

      return NextResponse.json({ error: message }, { status: geminiResponse.status });
    }

    const modelText = getModelText(geminiJson);
    const parsed = parseGeminiJson(modelText);

    if (!parsed) {
      return NextResponse.json(
        {
          error: "Gemini returned an unexpected response format.",
          raw: modelText,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(normalizeResult(parsed));
  } catch (error) {
    return NextResponse.json(
      {
        error: error.message || "Server error while analyzing media.",
      },
      { status: 500 }
    );
  }
}
