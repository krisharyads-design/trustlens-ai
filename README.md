# TrustLens AI

A very simple Next.js App Router project that uploads an image or video, extracts 3 frames from a video on the frontend, sends the media to `/api/analyze`, and uses the Google Gemini Vision API to return:

- Status
- Trust Score
- Reason
- Context

## 1. Install

```bash
npm install
```

## 2. Add your API key

Create a `.env.local` file:

```bash
GEMINI_API_KEY=your_gemini_api_key_here
```

## 3. Run the app

```bash
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000)

## Notes

- Images are sent directly to the backend as base64.
- Videos are converted into 3 image frames in the browser, then those frames are sent to the backend.
- The backend route is: `app/api/analyze/route.js`
- Gemini is called with `fetch` and `GEMINI_API_KEY`
- This is a simple AI assessment tool, not a guaranteed fake-image detector.
